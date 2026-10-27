import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspaces } from './workspaces.js';
import { decide } from './gateway.js';
import { signInTrace } from './signin.js';
import { liveConfig, liveDiscovery, mockDiscovery } from './discovery.js';
import { callGateway, delegate, exchangeCode, registerClient, startSignIn } from './liveauth.js';
import { CHANNELS, createProtect } from './protect.js';
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

export function createApp(env = process.env, { fetchImpl = fetch } = {}) {
  const hosted = env.MUSE_HOSTED === '1';
  const picker = !hosted && env.IDP === 'mock' && env.ALLOW_MOCK_SIGNIN === '1' && env.NODE_ENV !== 'production';
  const allowedHosts = new Set([
    ...LOOPBACK_NAMES,
    ...(env.MUSE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  ]);
  const live = liveConfig(env);
  const protect = createProtect(env);
  const workspaces = createWorkspaces({ max: Number(env.MUSE_MAX_WORKSPACES) || 200 });
  // Sign-in state to workspace. The return from the identity provider is a cross-site navigation, so the SameSite=Lax
  // cookie is not sent; the one-time state value is what ties the return to the visitor who started it.
  const pending = new Map();
  const PENDING_MS = 10 * 60 * 1000;
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
      res.append('Set-Cookie', `${WS_COOKIE}=${ws.id}; Path=/; HttpOnly; SameSite=Lax${secure}`);
    }
    req.ws = ws;
    next();
  });

  app.get('/api/session', (req, res) => {
    const ws = req.ws;
    res.json({
      protectMode: protect.mode,
      signedIn: Boolean(ws.user),
      persona: ws.user ? { key: ws.user, ...PERSONAS[ws.user] } : null,
      picker,
      hosted,
      mode: ws.gatewayMode === 'live' ? 'live' : 'mock',
      live: live ? { available: true, origin: live.origin, viaPingOne: Boolean(live.idp) } : { available: false },
      discovery: ws.discovery ?? null,
      liveAuth: { registered: Boolean(ws.liveClient), signedIn: Boolean(ws.liveToken), claims: ws.liveClaims ?? null, steps: ws.liveSteps ?? [], error: ws.liveError ?? null },
      personas: picker ? Object.entries(PERSONAS).map(([key, p]) => ({ key, ...p })) : [],
      tools: Object.entries(TOOLS).map(([id, t]) => ({ id, label: t.label, fields: t.fields, personas: t.personas })),
      decisions: ws.decisions,
      held: [...ws.holds.keys()],
    });
  });

  // Real or fake gateway. Live is refused unless the owner enabled it for this run, and never on the hosted build.
  app.post('/api/gateway-mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'mock' && mode !== 'live') return res.status(400).json({ error: 'mode must be mock or live' });
    if (mode === 'live' && !live) return res.status(403).json({ error: 'live mode is not enabled in this build' });
    req.ws.gatewayMode = mode;
    req.ws.discovery = null;
    clearLive(req.ws);
    res.json({ mode });
  });

  // Step 1 to 3: the unauthenticated call, then the two metadata reads.
  app.post('/api/discover', async (req, res) => {
    const ws = req.ws;
    if (ws.gatewayMode === 'live') {
      try { ws.discovery = await liveDiscovery(live, fetchImpl); } catch (e) {
        return res.status(502).json({ error: 'Agent Privilege could not be reached', detail: String(e?.name ?? 'error').slice(0, 40) });
      }
    } else ws.discovery = mockDiscovery();
    res.json(ws.discovery);
  });

  const clearLive = (ws) => { ws.liveClient = null; ws.liveToken = null; ws.liveClaims = null; ws.liveSteps = []; ws.liveError = null; };
  const liveReady = (req, res) => {
    if (req.ws.gatewayMode !== 'live' || !live) { res.status(409).json({ error: 'switch to Real (live) first' }); return false; }
    if (!req.ws.discovery?.learned) { res.status(409).json({ error: 'run the discovery steps first' }); return false; }
    return true;
  };
  const addStep = (ws, step) => { if (step) ws.liveSteps = [...(ws.liveSteps ?? []).filter((x) => x.n !== step.n), step].sort((a, b) => a.n - b.n); };
  const failed = (e) => ({ error: 'Agent Privilege could not be reached', detail: String(e?.name ?? 'error').slice(0, 40) });

  // Step 4. A real write: one client registration at the gateway's authorization server. Only on an explicit click.
  app.post('/api/live/register', async (req, res) => {
    if (!liveReady(req, res)) return;
    const ws = req.ws;
    if (live.idp) {
      // PingOne already has Muse's app, so there is nothing to register: Muse only redirects.
      ws.liveClient = { clientId: live.idp.clientId, redirectUri: `http://${req.headers.host}/api/callback` };
      ws.liveError = null;
      addStep(ws, { n: 4, title: "Use Muse's PingOne app", request: { method: 'GET', url: live.idp.authorizeEndpoint }, note: 'No registration. Muse is a PingOne app; PingOne handles login, Protect and consent after the redirect.' });
      return res.json({ registered: true, error: null });
    }
    try {
      const r = await registerClient(live, ws.discovery.learned, `http://${req.headers.host}/api/callback`, fetchImpl);
      addStep(ws, r.step);
      ws.liveClient = r.client ?? null;
      ws.liveError = r.error ?? null;
      res.json({ registered: Boolean(r.client), error: r.error ?? null });
    } catch (e) { res.status(502).json(failed(e)); }
  });

  // Step 5. Returns the authorize URL; the page navigates there. Nothing is sent to the gateway yet.
  app.post('/api/live/signin', (req, res) => {
    if (!liveReady(req, res)) return;
    const ws = req.ws;
    if (!ws.liveClient) return res.status(409).json({ error: 'register Muse first' });
    // With a client secret Muse acts on the user's behalf, so the token is minted for the gateway from the start.
    const resource = live.idp && !live.idp.clientSecret ? null : live.url;
    const learned = live.idp ? { authorizeEndpoint: live.idp.authorizeEndpoint, tokenEndpoint: live.idp.tokenEndpoint, scopes: ['openid'] } : ws.discovery.learned;
    const r = startSignIn(learned, ws.liveClient, resource, { forceLogin: Boolean(live.idp), scope: live.idp?.clientSecret ? `openid ${live.idp.gatewayScope}` : null });
    for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
    pending.set(r.state, { wsId: ws.id, verifier: r.verifier, resource, learned, at: Date.now() });
    addStep(ws, { n: 5, title: 'Send the user to sign in', request: { method: 'GET', url: r.url.replace(/code_challenge=[^&]+/, 'code_challenge=(sent)') }, note: live.idp ? 'The browser leaves Muse for PingOne. PKCE S256, prompt=login so PingOne always asks the user to sign in.' : 'The browser leaves Muse for the identity provider. PKCE S256, and resource = the gateway so the token is minted for it.' });
    res.json({ url: r.url });
  });

  // Step 6. The identity provider sends the browser back here with a code.
  app.get('/api/callback', async (req, res) => {
    const p = pending.get(String(req.query.state ?? ''));
    pending.delete(String(req.query.state ?? ''));
    const ws = p && Date.now() - p.at <= PENDING_MS ? workspaces.find(p.wsId) : null;
    const done = (msg) => res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><title>Muse</title><p>${msg}</p><script>location.replace('/')</script>`);
    if (!ws) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from Muse.');
    if (req.query.error) { ws.liveError = `Sign-in was refused: ${String(req.query.error).slice(0, 60)}.`; return done('Sign-in was refused. Returning to Muse.'); }
    try {
      const r = await exchangeCode(live, p.learned, { code: String(req.query.code ?? ''), verifier: p.verifier, client: ws.liveClient, resource: p.resource, clientSecret: live.idp?.clientSecret }, fetchImpl);
      addStep(ws, r.step);
      ws.liveError = r.error ?? null;
      if (r.token && live.idp?.clientSecret) {
        const d = await delegate(live, live.idp, r.token, fetchImpl);
        for (const s of d.steps) addStep(ws, s);
        ws.liveError = d.error ?? null;
        if (d.token) { ws.liveToken = d.token; ws.liveClaims = d.claims ?? { opaque: true }; }
      } else if (r.token) { ws.liveToken = r.token; ws.liveClaims = r.claims ?? { opaque: true }; }
    } catch (e) { ws.liveError = failed(e).error; }
    done('Signed in. Returning to Muse.');
  });

  // Steps 7 and 8. The call that was refused in step 1, now with the token.
  app.post('/api/live/call', async (req, res) => {
    if (!liveReady(req, res)) return;
    const ws = req.ws;
    if (!ws.liveToken) return res.status(409).json({ error: 'sign in first' });
    try {
      for (const s of await callGateway(live, ws.liveToken, fetchImpl, { tool: live.idp?.clientSecret ? 'loyalty_balance' : null })) addStep(ws, s);
      res.json({ ok: true });
    } catch (e) { res.status(502).json(failed(e)); }
  });

  app.post('/api/signin', (req, res) => {
    if (req.ws.gatewayMode === 'live') return res.status(409).json({ error: 'use the live steps below, not the persona sign-in', detail: 'In Real mode Muse registers, then you sign in at the gateway authorization server.' });
    const key = picker ? req.body?.persona : 'finance';
    if (!PERSONAS[key]) return res.status(400).json({ error: 'unknown persona' });
    req.ws.user = key;
    res.json({ signedIn: true, trace: signInTrace(key) });
  });

  app.post('/api/signout', (req, res) => {
    req.ws.user = null;
    clearLive(req.ws);
    req.ws.tokens = {};
    req.ws.pending = {};
    res.json({ signedIn: false });
  });

  app.post('/api/request', async (req, res) => {
    const ws = req.ws;
    if (!ws.user) return res.status(401).json({ error: 'sign in first' });
    const tool = req.body?.tool;
    const args = req.body?.args ?? {};
    if (!TOOLS[tool]) return res.status(400).json({ error: 'unknown tool' });
    if (typeof args !== 'object' || Array.isArray(args)) return res.status(400).json({ error: 'args must be an object' });

    const via = req.body?.via ?? 'muse';
    if (!CHANNELS.includes(via)) return res.status(400).json({ error: 'unknown channel' });

    const now = Date.now();
    const token = ws.tokens[via];
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token", resource_metadata="https://muse.example/.well-known/oauth-protected-resource"');
      return res.status(401).json({ error: 'invalid_token', detail: 'The gateway needs an access token for this caller.', client: via });
    }
    const d = decide(ws, { tool, args, now, via, protect: token.protect });
    const entry = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      tool,
      persona: ws.user,
      actor: d.protect.actor,
      outcome: d.outcome,
      signals: [...d.protect.signals, ...d.detect.signals],
      rules: [d.protect.rule, d.coarse.rule, d.fine?.rule].filter(Boolean),
    };
    if (d.outcome === 'held') ws.holds.set(entry.id, { tool, args, actor: entry.actor });
    if (d.outcome === 'allowed') entry.result = runTool(tool, args);
    record(ws, entry);
    res.json({ ...entry, detect: d.detect.steps, protect: d.protect, coarse: d.coarse, fine: d.fine });
  });

  // The caller got a 401 from the gateway, so it asks PingOne for a token. PingOne has Sam signed in, then asks Protect
  // (through DaVinci) who is calling. A person gets a token. An agent needs Sam's consent first.
  app.post('/api/authorize', async (req, res) => {
    const ws = req.ws;
    if (!ws.user) return res.status(401).json({ error: 'sign in first' });
    const client = req.body?.client;
    if (!CHANNELS.includes(client)) return res.status(400).json({ error: 'unknown channel' });
    const name = client === 'muse' ? 'Muse' : 'Sam in the browser';
    const steps = [
      `${name} sends an authorization request to PingOne`,
      'PingOne has Sam signed in (simulated)',
      'PingOne runs the DaVinci flow, which calls Protect',
    ];
    const verdict = await protect.assess(client, { userName: ws.user, sessionId: createHash('sha256').update(ws.id).digest('hex').slice(0, 16) });
    steps.push(verdict.rule);
    if (verdict.deny) return res.status(403).json({ status: 'denied', steps, signals: verdict.signals });
    if (verdict.actor === 'human') {
      ws.tokens[client] = { protect: verdict };
      steps.push('Not Muse, so PingOne assumes a person and issues the token');
      return res.json({ status: 'issued', actor: 'human', steps, signals: verdict.signals });
    }
    ws.pending[client] = verdict;
    steps.push('Muse is a bot, so PingOne asks Sam for consent');
    res.json({
      status: 'consent_required',
      actor: 'agent',
      steps,
      signals: verdict.signals,
      prompt: 'This is a bot. Do you consent to let it act on your behalf?',
    });
  });

  app.post('/api/consent', (req, res) => {
    const ws = req.ws;
    const client = req.body?.client;
    const verdict = ws.pending[client];
    if (!verdict) return res.status(404).json({ error: 'no consent is pending for that caller' });
    delete ws.pending[client];
    if (req.body?.approve !== true) return res.status(403).json({ status: 'denied', steps: ['Sam declined. No token was issued'] });
    ws.tokens[client] = { protect: verdict };
    res.json({ status: 'issued', actor: 'agent', steps: ['Sam consented (simulated)', 'PingOne issues the token to Muse'] });
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
      signals: [],
      rules: ['A person approved this call (simulated CIBA)'],
      result: runTool(hold.tool, hold.args),
    };
    record(ws, entry);
    res.json(entry);
  });

  app.post('/api/reset', (req, res) => {
    const ws = req.ws;
    ws.user = null;
    ws.gatewayMode = 'mock';
    ws.discovery = null;
    clearLive(ws);
    ws.calls = [];
    ws.decisions = [];
    ws.holds.clear();
    ws.tokens = {};
    ws.pending = {};
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
