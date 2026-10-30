import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspaces } from './workspaces.js';
import { decide } from './gateway.js';
import { signInTrace } from './signin.js';
import { liveConfig, liveDiscovery, mockDiscovery } from './discovery.js';
import { agentConfig, agentTools, normaliseResult, plan, reply } from './agent.js';
import { assistantsFor, mountConnector } from './connector.js';
import { createNetguard } from './netguard.js';
import { loadStories, renderStory } from './stories.js';
import { loadCustomer } from './customer.js';
import { PLATFORMS, createPlatformEngine } from './platforms.js';
import { chatgptKey, mountPfResource } from './pf-resource.js';
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

export function createApp(env = process.env, { fetchImpl: rawFetch = fetch } = {}) {
  const hosted = env.MUSE_HOSTED === '1';
  const picker = !hosted && env.IDP === 'mock' && env.ALLOW_MOCK_SIGNIN === '1' && env.NODE_ENV !== 'production';
  const allowedHosts = new Set([
    ...LOOPBACK_NAMES,
    ...(env.MUSE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  ]);
  const live = liveConfig(env);
  // Rule 1: no outbound calls in mock mode, every outbound origin counted in live mode (netguard.js). All outbound fetches below go through it.
  const guard = createNetguard({ mode: live ? 'live' : 'mock' });
  const fetchImpl = guard.wrap(rawFetch);
  // Stories and branding are data (rules 10 and 12): stories.json packs and customer.config.json.
  const stories = loadStories();
  const customer = loadCustomer(env, Object.keys(stories.verticals));
  const agent = agentConfig(env);
  const protect = createProtect(env);
  const workspaces = createWorkspaces({ max: Number(env.MUSE_MAX_WORKSPACES) || 200 });
  // Real flows touch PingOne and the gateway, so starting them is limited per visitor and across everyone.
  const hits = new Map();
  const LIMIT_PER_VISITOR = Number(env.MUSE_LIVE_PER_VISITOR_PER_MIN) || 8;
  const LIMIT_GLOBAL = Number(env.MUSE_LIVE_GLOBAL_PER_MIN) || 60;
  const tooMany = (key) => {
    const now = Date.now();
    for (const [k, v] of hits) { const fresh = v.filter((t) => now - t < 60000); if (fresh.length) hits.set(k, fresh); else hits.delete(k); }
    const mine = hits.get(key) ?? [];
    const all = [...hits.values()].reduce((n, v) => n + v.length, 0);
    if (mine.length >= LIMIT_PER_VISITOR || all >= LIMIT_GLOBAL) return true;
    hits.set(key, [...mine, now]);
    return false;
  };
  const limited = (req, res, next) => (tooMany(req.ws.id) ? res.status(429).json({ error: 'slow down', detail: 'Too many sign-in attempts. Try again in a minute.' }) : next());
  // Sign-in state to workspace. The return from the identity provider is a cross-site navigation, so the SameSite=Lax
  // cookie is not sent; the one-time state value is what ties the return to the visitor who started it.
  const pending = new Map();
  const PENDING_MS = 10 * 60 * 1000;
  const app = express();
  app.disable('x-powered-by');
  if (hosted) app.set('trust proxy', 1);

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
    if (req.method === 'POST' && req.headers.origin && !(req.path === '/mcp' || req.path.startsWith('/connector/'))) {
      let origin = null;
      try { origin = new URL(req.headers.origin).host; } catch { origin = null; }
      if (origin !== req.headers.host) return res.status(403).json({ error: 'cross-origin write refused' });
    }
    next();
  });

  // Muse as a connector for other agents (off unless MUSE_CONNECTOR=1 and real mode is configured).
  const connector = mountConnector(app, { env, live, fetchImpl }) || null;
  // What ChatGPT, Claude, Codex and Meta AI do on Connect, run by Muse against its own connector (see platforms.js).
  // The CIMD path: an MCP resource behind a real PingFederate (off unless MUSE_PF_ISSUER is set). ChatGPT's signing key is shared with the engine.
  const simKey = live && env.MUSE_PF_ISSUER ? chatgptKey() : null;
  const pf = simKey ? mountPfResource(app, { env, live, fetchImpl, key: simKey }) : null;
  const simOrigin = connector ? new URL(connector.url).origin : pf ? new URL(pf.url).origin : null;
  const platforms = simOrigin ? createPlatformEngine({ publicUrl: simOrigin, fetchImpl, signer: simKey }) : null;
  // The stand-in platform callback. The sign-in comes back here instead of chatgpt.com or the customer's loopback.
  app.get('/sim/:key/callback', async (req, res) => {
    const out = platforms ? await platforms.finish(req.query.state, { code: req.query.code ? String(req.query.code) : null, error: req.query.error }).catch(() => null) : null;
    const ws = out ? workspaces.find(out.wsId) : null;
    if (!ws) return res.status(400).type('text').send('Unknown or expired connection. Start again from Muse.');
    const { wsId, returnTo, ...view } = out;
    ws.assistant = view;
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><title>Muse</title><p>Connected. Returning to Muse.</p><script>location.replace(${JSON.stringify(returnTo)})</script>`);
  });

  app.use(express.json({ limit: '16kb' }));

  app.use('/api', (req, res, next) => {
    let ws = workspaces.find(readCookie(req, WS_COOKIE));
    if (!ws) {
      ws = workspaces.create();
      if (!ws) return res.status(503).json({ error: 'busy', detail: 'Too many visitors right now. Try again shortly.' });
      if (live) ws.gatewayMode = 'live';
      const secure = hosted ? '; Secure' : '';
      res.append('Set-Cookie', `${WS_COOKIE}=${ws.id}; Path=/; HttpOnly; SameSite=Lax${secure}`);
    }
    req.ws = ws;
    next();
  });

  // The story pack for a vertical (default: the customer config's), with its cast filled in. Public, static data.
  app.get('/api/story', (req, res) => {
    const v = req.query.vertical === undefined ? customer.vertical : String(req.query.vertical);
    const story = renderStory(stories, v);
    if (!story) return res.status(400).json({ error: 'unknown vertical' });
    res.set('Cache-Control', 'no-store').json(story);
  });

  // The netguard's counters and its self-test. Counts and a mode only: no addresses.
  app.get('/api/netguard', async (req, res) => {
    const { origins, last, ...s } = guard.stats();
    res.set('Cache-Control', 'no-store').json({ ...s, selfTest: (await guard.selfTest()).ok });
  });

  app.get('/api/session', (req, res) => {
    const ws = req.ws;
    res.json({
      customer,
      workspaceId: ws.workspaceId,
      protectMode: protect.mode,
      signedIn: Boolean(ws.user),
      persona: ws.user ? { key: ws.user, ...PERSONAS[ws.user] } : null,
      picker,
      hosted,
      connector,
      pf: pf ? { url: pf.url, issuer: pf.issuer } : null,
      mode: ws.gatewayMode === 'live' ? 'live' : 'mock',
      live: live ? { available: true, origin: live.origin, viaPingOne: Boolean(live.idp), lane: live.idp?.lane ?? null, userLogin: Boolean(live.idp?.userClientId) } : { available: false },
      agent: agent ? { enabled: true, model: agent.model } : { enabled: false },
      discovery: ws.discovery ?? null,
      liveAuth: { registered: Boolean(ws.liveClient), signedIn: Boolean(ws.liveToken), claims: ws.liveClaims ?? null, steps: ws.liveSteps ?? [], error: ws.liveError ?? null, ask: ws.liveAsk ?? null, answer: ws.liveAnswer ?? null },
      userLogin: ws.userLogin ?? null,
      assistant: ws.assistant ?? null,
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

  const clearLive = (ws) => { ws.liveClient = null; ws.liveToken = null; ws.liveClaims = null; ws.liveSteps = []; ws.liveError = null; ws.liveAsk = null; ws.liveAnswer = null; ws.userLogin = null; ws.assistant = null; };
  // The tool result comes back as MCP text content holding JSON; Muse reads the points out of it.
  const answerFrom = (steps) => {
    const r = steps.find((x) => x.n === 9)?.response;
    try { return normaliseResult(r.body.result.content[0].text); } catch { return null; }
  };
  const runAsk = async (ws) => {
    const steps = await callGateway(live, ws.liveToken, fetchImpl, { tool: ws.liveAsk?.tool ?? (live.idp?.clientSecret ? 'loyalty_balance' : null) });
    for (const st of steps) addStep(ws, st);
    const result = answerFrom(steps);
    if (!result) { ws.liveAnswer = null; return; }
    const said = await reply(agent, ws.liveAsk?.prompt, result, fetchImpl);
    if (agent) addStep(ws, { n: 10, title: 'Muse writes the reply', request: { method: 'POST', url: agent.endpoint, body: { model: agent.model, facts: 'the tool result' } }, response: { status: 200, body: { via: said.via, model: said.model ?? agent.model } }, note: said.note ?? 'The model words the answer from the tool result. Muse checks that every number in it comes from the result.' });
    ws.liveAnswer = { ...result, reply: said.text };
  };
  const liveReady = (req, res) => {
    if (req.ws.gatewayMode !== 'live' || !live) { res.status(409).json({ error: 'switch to Real (live) first' }); return false; }
    if (!req.ws.discovery?.learned) { res.status(409).json({ error: 'run the discovery steps first' }); return false; }
    return true;
  };
  const addStep = (ws, step) => { if (step) ws.liveSteps = [...(ws.liveSteps ?? []).filter((x) => x.n !== step.n), step].sort((a, b) => a.n - b.n); };
  const failed = (e) => ({ error: 'Agent Privilege could not be reached', detail: String(e?.name ?? 'error').slice(0, 40) });

  // The user asks first. With no token Muse calls the gateway, gets the 401 and shows it; PingOne comes after.
  app.post('/api/live/ask', limited, async (req, res) => {
    const ws = req.ws;
    if (!live || ws.gatewayMode !== 'live') return res.status(409).json({ error: 'switch to Real (live) first' });
    const prompt = String(req.body?.prompt ?? '').slice(0, 200);
    // Step 0: Muse's model picks the tool (or declines). Without a model, keywords decide.
    const chosen = await plan(agent, prompt, fetchImpl);
    if (agent) addStep(ws, { n: 0, title: 'Muse asks its model which tool to use', request: { method: 'POST', url: agent.endpoint, body: { model: agent.model, tools: agentTools().map((t) => t.name) } }, response: { status: 200, body: { tool: chosen.tool ?? 'none', via: chosen.via, ...(chosen.model ? { model: chosen.model } : {}) } }, note: chosen.note ?? 'The model chooses one tool from Muse\'s own list, or none. It never writes arguments and never sees a token.' });
    if (!chosen.tool) {
      if (!agent) return res.status(400).json({ error: 'In Real mode Muse can answer one thing so far: your airline points.' });
      ws.liveAsk = { prompt }; ws.liveAnswer = { reply: chosen.reply }; ws.liveError = null;
      return res.json({ state: 'declined', reply: chosen.reply });
    }
    ws.liveAsk = { prompt, tool: chosen.tool }; ws.liveAnswer = null; ws.liveError = null;
    try {
      if (ws.liveToken) { await runAsk(ws); return res.json({ state: 'done' }); }
      ws.discovery = await liveDiscovery(live, fetchImpl);
      res.json({ state: 'auth_required' });
    } catch (e) { res.status(502).json(failed(e)); }
  });

  // Step 4. A real write: one client registration at the gateway's authorization server. Only on an explicit click.
  app.post('/api/live/register', async (req, res) => {
    if (!liveReady(req, res)) return;
    const ws = req.ws;
    if (live.idp) {
      // PingOne already has Muse's app, so there is nothing to register: Muse only redirects.
      ws.liveClient = { clientId: live.idp.clientId, redirectUri: (live.publicUrl ? `${live.publicUrl}/api/callback` : `http://${req.headers.host}/api/callback`) };
      ws.liveError = null;
      addStep(ws, { n: 4, title: "Use Muse's PingOne app", request: { method: 'GET', url: live.idp.authorizeEndpoint }, note: 'No registration. Muse is a PingOne app; PingOne handles login, Protect and consent after the redirect.' });
      return res.json({ registered: true, error: null });
    }
    try {
      const r = await registerClient(live, ws.discovery.learned, (live.publicUrl ? `${live.publicUrl}/api/callback` : `http://${req.headers.host}/api/callback`), fetchImpl);
      addStep(ws, r.step);
      ws.liveClient = r.client ?? null;
      ws.liveError = r.error ?? null;
      res.json({ registered: Boolean(r.client), error: r.error ?? null });
    } catch (e) { res.status(502).json(failed(e)); }
  });

  // Connect from an assistant, the way that platform does it: discovery, registration, then the authorize URL the page navigates to.
  app.post('/api/sim/start', limited, async (req, res) => {
    const key = String(req.body?.platform ?? '');
    // Which airline server the assistant connects to: Muse's connector (PingOne behind it, no CIMD) or the PingFederate one (CIMD).
    const mcpUrl = req.body?.server === 'pf' ? pf?.url : connector?.url;
    if (!platforms || !PLATFORMS[key] || !mcpUrl) return res.status(409).json({ error: 'that assistant is not available here' });
    const returnTo = /^\/clients\.html\?client=[a-z]{1,12}$/.test(String(req.body?.returnTo ?? '')) ? String(req.body.returnTo) : '/';
    req.ws.assistant = null;
    try {
      const r = await platforms.start(key, { mcpUrl, wsId: req.ws.id, returnTo });
      if (!r.authorizeUrl) { req.ws.assistant = { key, name: PLATFORMS[key].name, method: null, realRedirect: PLATFORMS[key].realRedirect, steps: r.steps, points: null, error: r.error }; return res.status(502).json({ error: r.error }); }
      res.json({ url: r.authorizeUrl, method: r.method });
    } catch (e) { res.status(502).json(failed(e)); }
  });

  // Step 5. Returns the authorize URL; the page navigates there. Nothing is sent to the gateway yet.
  app.post('/api/live/signin', limited, (req, res) => {
    const ws = req.ws;
    if (req.body?.as === 'assistant') {
      // The customer clicked Connect in their assistant's directory. The sign-in uses that assistant's own PingOne app, so Protect and the screens name it.
      // It needs no discovery and no Real switch: the connector being on already means real PingOne is configured.
      const a = live?.idp ? assistantsFor(env, live).find((x) => x.key === String(req.body?.assistant ?? '')) : null;
      if (!a) return res.status(409).json({ error: 'that assistant is not configured' });
      const learned = { authorizeEndpoint: a.idp.authorizeEndpoint, tokenEndpoint: a.idp.tokenEndpoint, scopes: ['openid'] };
      const client = { clientId: a.idp.clientId, redirectUri: live.publicUrl ? `${live.publicUrl}/api/callback` : `http://${req.headers.host}/api/callback` };
      const r = startSignIn(learned, client, null, { forceLogin: true, loginHint: a.idp.loginHint ? `${a.idp.loginHint}.conn${req.body?.mfa === 'off' ? '.nomfa' : ''}` : null });
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
      // Where the browser lands afterwards: only the clients page, from a short fixed pattern. Anything else goes home.
      const returnTo = /^\/clients\.html\?client=[a-z]{1,12}$/.test(String(req.body?.returnTo ?? '')) ? String(req.body.returnTo) : '/';
      pending.set(r.state, { wsId: ws.id, verifier: r.verifier, learned, client, as: 'assistant', assistant: { key: a.key, name: a.name }, idp: a.idp, returnTo, at: Date.now() });
      ws.assistant = null;
      return res.json({ url: r.url });
    }
    if (!liveReady(req, res)) return;
    if (req.body?.as === 'user') {
      // Sam signs in as himself: a different PingOne app, so the flow shows no agent screen and no consent, and nothing is exchanged.
      if (!live.idp?.userClientId) return res.status(409).json({ error: 'the user sign-in is not configured' });
      const learned = { authorizeEndpoint: live.idp.authorizeEndpoint, tokenEndpoint: live.idp.tokenEndpoint, scopes: ['openid'] };
      const client = { clientId: live.idp.userClientId, redirectUri: live.publicUrl ? `${live.publicUrl}/api/callback` : `http://${req.headers.host}/api/callback` };
      const r = startSignIn(learned, client, null, { forceLogin: true, loginHint: live.idp.loginHint ? (req.body?.mfa === 'off' ? `${live.idp.loginHint}.nomfa` : live.idp.loginHint) : null });
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
      pending.set(r.state, { wsId: ws.id, verifier: r.verifier, resource: null, learned, client, as: 'user', at: Date.now() });
      ws.userLogin = null;
      return res.json({ url: r.url });
    }
    if (!ws.liveClient) return res.status(409).json({ error: 'register Muse first' });
    // With a client secret Muse acts on the user's behalf, so the token is minted for the gateway from the start.
    const resource = live.idp && (!live.idp.clientSecret || live.idp.lane === 'privilege') ? null : live.url;
    const learned = live.idp ? { authorizeEndpoint: live.idp.authorizeEndpoint, tokenEndpoint: live.idp.tokenEndpoint, scopes: ['openid'] } : ws.discovery.learned;
    const r = startSignIn(learned, ws.liveClient, resource, { forceLogin: Boolean(live.idp), loginHint: live.idp?.loginHint ? (req.body?.mfa === 'off' ? `${live.idp.loginHint}.nomfa` : live.idp.loginHint) : null, scope: live.idp?.clientSecret && live.idp.lane !== 'privilege' ? `openid ${live.idp.gatewayScope}` : null });
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
    const done = (msg) => res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><title>Muse</title><p>${msg}</p><script>location.replace(${JSON.stringify(p?.returnTo ?? '/')})</script>`);
    if (!ws) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from Muse.');
    if (req.query.error) { ws.liveError = `Sign-in was refused: ${String(req.query.error).slice(0, 60)}.`; return done('Sign-in was refused. Returning to Muse.'); }
    if (p.as === 'user') {
      try {
        const r = await exchangeCode(live, p.learned, { code: String(req.query.code ?? ''), verifier: p.verifier, client: p.client, resource: null }, fetchImpl);
        ws.userLogin = { claims: r.claims ?? null, steps: [r.step].filter(Boolean), error: r.error ?? null, denied: null };
        if (r.token) {
          // The user's own token, straight to the gateway. No act claim, no exchange: this is what a non-agent caller gets.
          const steps = await callGateway(live, r.token, fetchImpl, { tool: 'loyalty_balance' });
          const first = steps[0]?.response?.status;
          ws.userLogin.steps.push(...steps);
          ws.userLogin.denied = first == null ? null : first >= 400 || steps.some((x) => x.response?.status >= 400);
        }
      } catch (e) { ws.userLogin = { claims: null, steps: [], error: failed(e).error, denied: null }; }
      return done('Signed in. Returning to Muse.');
    }
    if (p.as === 'assistant') {
      // Same as the connector: swap the code, act for the user with that assistant's app, then ask the gateway for the points.
      ws.assistant = { ...p.assistant, claims: null, points: null, error: null };
      try {
        const r = await exchangeCode(live, p.learned, { code: String(req.query.code ?? ''), verifier: p.verifier, client: p.client, resource: null, clientSecret: p.idp.clientSecret }, fetchImpl);
        if (!r.token) { ws.assistant.error = r.error ?? 'PingOne did not issue a token.'; return done('Sign-in failed. Returning to Muse.'); }
        const d = await delegate(live, p.idp, r.token, fetchImpl);
        if (!d.token) { ws.assistant.error = d.error ?? 'The token exchange was refused.'; return done('Sign-in failed. Returning to Muse.'); }
        ws.assistant.claims = d.claims ?? null;
        const ask = () => callGateway(live, d.token, fetchImpl, { tool: 'get_loyalty_status' });
        const steps = await ask().catch(() => ask());
        const resp = steps.find((x) => x.n === 9)?.response;
        let rec = null;
        try { rec = JSON.parse(String(resp?.body?.result?.content?.[0]?.text ?? '')); } catch { /* not the airline record */ }
        if (rec && rec.loyaltyPoints !== undefined) ws.assistant.points = { points: rec.loyaltyPoints, tier: rec.loyaltyTier, passenger: rec.name };
        else ws.assistant.error = `The gateway did not answer (${resp?.status ?? 'no answer'}).`;
      } catch (e) { ws.assistant.error = failed(e).error; }
      return done('Connected. Returning to Muse.');
    }
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
      // The retry: now that Muse has a token, it finishes the request the user made before signing in.
      if (ws.liveToken && ws.liveAsk) await runAsk(ws);
    } catch (e) { ws.liveError = failed(e).error; }
    done('Signed in. Returning to Muse.');
  });

  // Steps 7 and 8. The call that was refused in step 1, now with the token.
  app.post('/api/live/call', async (req, res) => {
    if (!liveReady(req, res)) return;
    const ws = req.ws;
    if (!ws.liveToken) return res.status(409).json({ error: 'sign in first' });
    try {
      await runAsk(ws);
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

  // The connect card's own reset: clears only the last assistant result, so the card can start over.
  app.post('/api/assistant/reset', (req, res) => {
    req.ws.assistant = null;
    res.json({ reset: true });
  });
  app.post('/api/reset', (req, res) => {
    const ws = req.ws;
    ws.user = null;
    ws.gatewayMode = live ? 'live' : 'mock';
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
  // MODE=mock: mock-only. MODE=live: the owner's real build, so it needs ALLOW_LIVE=1. Anything else is refused.
  if (env.MODE && env.MODE !== 'mock' && !(env.MODE === 'live' && env.ALLOW_LIVE === '1')) {
    throw new Error('MODE must be "mock", or "live" with ALLOW_LIVE=1');
  }
  const bind = env.MUSE_BIND ?? '127.0.0.1';
  if (!LOOPBACK_BINDS.has(bind) && env.MUSE_HOSTED !== '1') {
    throw new Error('refusing to bind a non-loopback address without MUSE_HOSTED=1');
  }
  return createApp(env).listen(Number(env.PORT ?? 5100), bind);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Your own settings (see .env.example). Values already in the environment win; no .env means the mock demo.
  if (typeof process.loadEnvFile === 'function' && existsSync('.env')) process.loadEnvFile('.env');
  const server = start();
  server.on('listening', () => console.log(`Agent Connect listening on port ${server.address().port} (MODE=${process.env.MODE ?? 'mock'}, ${process.env.MUSE_HOSTED === '1' ? 'hosted' : 'local'})`));
}
