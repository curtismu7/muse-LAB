import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspaces } from './workspaces.js';
import { decide } from './gateway.js';
import { signInTrace } from './signin.js';
import { CHANNELS } from './protect.js';
import { PERSONAS, TOOLS, runTool } from './tools.js';

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);
const WS_COOKIE = 'muse_ws';
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../../web/dist');

function readCookie(req, name) {
  const found = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

function record(ws, entry) {
  const i = ws.decisions.findIndex((d) => d.id === entry.id);
  if (i >= 0) ws.decisions[i] = entry;
  else ws.decisions.unshift(entry);
  if (ws.decisions.length > 50) ws.decisions.length = 50;
}

export function createApp(env = process.env) {
  const hosted = env.MUSE_HOSTED === '1';
  const picker = !hosted && env.IDP === 'mock' && env.ALLOW_MOCK_SIGNIN === '1' && env.NODE_ENV !== 'production';
  const allowedHosts = new Set([
    ...LOOPBACK_NAMES,
    ...(env.MUSE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  ]);
  const workspaces = createWorkspaces({ max: Number(env.MUSE_MAX_WORKSPACES) || 200 });
  const app = express();
  app.disable('x-powered-by');

  // Health is public and read-only. Probes call it with a pod-IP Host, so it sits before the Host check.
  app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      schema: 'demo-health/1',
      at: new Date().toISOString(),
      state: 'ready',
      runtime: 'offline',
      demo: { id: 'muse', name: 'Muse', version: '0.1.0' },
    });
  });

  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!allowedHosts.has(host)) return res.status(403).json({ error: 'host not allowed' });
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'POST' && req.headers.origin) {
      let origin = null;
      try { origin = new URL(req.headers.origin).host; } catch { origin = null; }
      if (origin !== req.headers.host) return res.status(403).json({ error: 'cross-origin write refused' });
    }
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  app.use('/api', (req, res, next) => {
    let ws = workspaces.find(readCookie(req, WS_COOKIE));
    if (!ws) {
      ws = workspaces.create();
      if (!ws) return res.status(503).json({ error: 'busy', detail: 'Too many visitors right now. Try again shortly.' });
      const secure = hosted ? '; Secure' : '';
      res.append('Set-Cookie', `${WS_COOKIE}=${ws.id}; Path=/; HttpOnly; SameSite=Strict${secure}`);
    }
    req.ws = ws;
    next();
  });

  app.get('/api/session', (req, res) => {
    const ws = req.ws;
    res.json({
      signedIn: Boolean(ws.user),
      persona: ws.user ? { key: ws.user, ...PERSONAS[ws.user] } : null,
      picker,
      hosted,
      mode: 'mock',
      personas: picker ? Object.entries(PERSONAS).map(([key, p]) => ({ key, ...p })) : [],
      tools: Object.entries(TOOLS).map(([id, t]) => ({ id, label: t.label, fields: t.fields, personas: t.personas })),
      decisions: ws.decisions,
      held: [...ws.holds.keys()],
    });
  });

  app.post('/api/signin', (req, res) => {
    const key = picker ? req.body?.persona : 'finance';
    if (!PERSONAS[key]) return res.status(400).json({ error: 'unknown persona' });
    req.ws.user = key;
    res.json({ signedIn: true, trace: signInTrace(key) });
  });

  app.post('/api/signout', (req, res) => {
    req.ws.user = null;
    res.json({ signedIn: false });
  });

  app.post('/api/request', (req, res) => {
    const ws = req.ws;
    if (!ws.user) return res.status(401).json({ error: 'sign in first' });
    const tool = req.body?.tool;
    const args = req.body?.args ?? {};
    if (!TOOLS[tool]) return res.status(400).json({ error: 'unknown tool' });
    if (typeof args !== 'object' || Array.isArray(args)) return res.status(400).json({ error: 'args must be an object' });

    const via = req.body?.via ?? 'muse';
    if (!CHANNELS.includes(via)) return res.status(400).json({ error: 'unknown channel' });

    const now = Date.now();
    const d = decide(ws, { tool, args, now, via });
    const entry = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      tool,
      persona: ws.user,
      actor: d.protect.actor,
      outcome: d.outcome,
      consent: d.outcome === 'held' && d.consent,
      signals: [...d.protect.signals, ...d.detect.signals],
      rules: [d.protect.rule, d.coarse.rule, d.fine?.rule].filter(Boolean),
    };
    if (d.outcome === 'held') ws.holds.set(entry.id, { tool, args, actor: entry.actor, consent: entry.consent });
    if (d.outcome === 'allowed') entry.result = runTool(tool, args);
    record(ws, entry);
    res.json({ ...entry, detect: d.detect.steps, protect: d.protect, coarse: d.coarse, fine: d.fine });
  });

  app.post('/api/approve/:id', (req, res) => {
    const ws = req.ws;
    const hold = ws.holds.get(req.params.id);
    if (!hold) return res.status(404).json({ error: 'nothing held with that id' });
    ws.holds.delete(req.params.id);
    const entry = {
      id: req.params.id,
      at: new Date().toISOString(),
      tool: hold.tool,
      persona: ws.user,
      actor: hold.actor,
      outcome: 'approved',
      consent: false,
      signals: [],
      rules: [hold.consent ? 'Sam consented for Muse to make this call (simulated)' : 'A person approved this call (simulated CIBA)'],
      result: runTool(hold.tool, hold.args),
    };
    record(ws, entry);
    res.json(entry);
  });

  app.post('/api/reset', (req, res) => {
    const ws = req.ws;
    ws.user = null;
    ws.calls = [];
    ws.decisions = [];
    ws.holds.clear();
    res.json({ reset: true });
  });

  if (existsSync(DIST)) {
    app.use(express.static(DIST));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(DIST, 'index.html'));
    });
  }

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed' || err.status === 400) return res.status(400).json({ error: 'bad request' });
    res.status(500).json({ error: 'server error' });
  });

  return app;
}

export function start(env = process.env) {
  if (env.MODE && env.MODE !== 'mock') throw new Error('this build is mock-only: MODE must be "mock"');
  const bind = env.MUSE_BIND ?? '127.0.0.1';
  if (!LOOPBACK_BINDS.has(bind) && env.MUSE_HOSTED !== '1') {
    throw new Error('refusing to bind a non-loopback address without MUSE_HOSTED=1');
  }
  return createApp(env).listen(Number(env.PORT ?? 5100), bind);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  start();
}
