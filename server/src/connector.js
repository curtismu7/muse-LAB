// The Airline Connector: Muse's server as a custom connector for other agents (for example Meta's Muse at muse.ai, ChatGPT, Claude). Standard MCP over HTTP with OAuth:
//   agent -> /mcp (401 + metadata) -> /connector/authorize -> PingOne (the same DaVinci flow: login, Protect, agent-detected, consent)
//   -> /connector/callback (Muse does the on-behalf-of exchanges) -> /connector/token -> agent calls /mcp with the token.
// Muse is both the OAuth authorization server the agent talks to and the MCP server. The tools it serves are a fixed list,
// answered by calling the gateway with the delegated token. Nothing here is on unless MUSE_CONNECTOR=1 and real mode is configured.
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { callGateway, delegate, exchangeCode, startSignIn } from './liveauth.js';
import { SELF_MARK, simKeyOf } from './platforms.js';

const b64u = (b) => b.toString('base64url');
const rand = (n = 32) => b64u(randomBytes(n));
const schema = { type: 'object', properties: {}, additionalProperties: false };
// With an airline named (MUSE_CONNECTOR_AIRLINE), the tool descriptions say whose points these are, so an agent with two airline connectors can tell them apart.
export const toolsFor = (airline) => [
  { name: 'loyalty_balance', description: airline ? `The member's ${airline} points balance and tier. Use it for ${airline} points only.` : "The member's airline points balance and tier.", inputSchema: schema },
  { name: 'get_loyalty_status', description: airline ? `The member's ${airline} loyalty status: tier, points and account status. Use it for ${airline} only.` : "The member's loyalty status: tier, points and account status.", inputSchema: schema },
];
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PENDING_MS = 10 * 60 * 1000;
const CODE_MS = 60 * 1000;
const TOKEN_MAX_S = 3600;
const CAP = 500;

// Public address: https, or http on loopback for a local run. Only the origin is kept.
export function connectorConfig(env, live) {
  if (env.MUSE_CONNECTOR !== '1' || !live?.idp?.clientSecret) return null;
  let pu;
  try { pu = new URL(env.MUSE_PUBLIC_URL ?? ''); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(pu.hostname);
  if (pu.protocol !== 'https:' && !(loopback && pu.protocol === 'http:')) return null;
  const hosts = (env.MUSE_CONNECTOR_REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  // A client the owner names up front, for agents that ask you to type a client id instead of registering.
  const staticUris = (env.MUSE_CONNECTOR_REDIRECT_URIS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const staticClient = env.MUSE_CONNECTOR_CLIENT_ID && staticUris.length ? { id: env.MUSE_CONNECTOR_CLIENT_ID, redirectUris: staticUris, name: 'Pre-registered agent' } : null;
  // Agents with their own PingOne app (MUSE_CONNECTOR_AGENTS, JSON), picked by the agent's callback host, so Protect and the PingOne screens can name them.
  // Their hosts are allowed to register too. An agent with no hosts (Codex, which calls back on loopback) is only picked from the directory Connect path, never by host.
  // A bad entry is dropped, and that agent falls back to Muse's app.
  let agents = [];
  try { agents = JSON.parse(env.MUSE_CONNECTOR_AGENTS || '[]'); } catch { agents = []; }
  agents = (Array.isArray(agents) ? agents : []).filter((a) => a && typeof a.clientId === 'string' && a.clientId && typeof a.clientSecret === 'string' && a.clientSecret && (a.hosts === undefined || Array.isArray(a.hosts)))
    .map((a) => ({ name: String(a.name ?? 'Agent').slice(0, 40), clientId: a.clientId, clientSecret: a.clientSecret, hosts: (a.hosts ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean) }));
  for (const a of agents) for (const h of a.hosts) if (!hosts.includes(h)) hosts.push(h);
  return { publicUrl: pu.origin, hosts, staticClient, agents };
}

// The assistants a customer can connect from (the demo's "find the airline in your assistant, click Connect" path).
// Meta AI has no app directory, so it uses Muse's own app through the Airline Connector; ChatGPT and Claude use their own apps.
// Returns the PingOne app (idp) for each; only names and keys ever leave the server.
export function assistantsFor(env, live) {
  const cfg = connectorConfig(env, live);
  if (!cfg) return [];
  const own = cfg.agents.map((a) => ({ key: a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: a.name, idp: { ...live.idp, clientId: a.clientId, clientSecret: a.clientSecret } }));
  return [...own, { key: 'meta-ai', name: 'Meta AI', idp: live.idp }];
}

// The PingOne app a sign-in uses: the agent's own when its callback host is listed (or when it is Muse's stand-in callback for that platform), otherwise Muse's.
const idpFor = (cfg, live, redirectUri) => {
  let h = '';
  try { h = new URL(redirectUri).hostname.toLowerCase(); } catch { /* no host, Muse's app */ }
  const sim = simKeyOf(cfg.publicUrl, redirectUri);
  const a = sim ? cfg.agents.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === sim) : cfg.agents.find((x) => x.hosts.some((y) => h === y || h.endsWith(`.${y}`)));
  return a ? { ...live.idp, clientId: a.clientId, clientSecret: a.clientSecret } : live.idp;
};

const okRedirect = (uri, hosts, publicUrl) => {
  // Muse's stand-in platform callbacks (/sim/<platform>/callback on its own address) may register too.
  if (publicUrl && simKeyOf(publicUrl, uri)) return true;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && loop) return true;
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return hosts.some((x) => h === x || h.endsWith(`.${x}`));
};

function capped(map) { while (map.size >= CAP) map.delete(map.keys().next().value); }

export function mountConnector(app, { env, live, fetchImpl = fetch }) {
  const cfg = connectorConfig(env, live);
  if (!cfg) return false;
  const PUBLIC = cfg.publicUrl;
  const signoutFirst = env.MUSE_CONNECTOR_SIGNOUT_FIRST === '1';
  const airline = (env.MUSE_CONNECTOR_AIRLINE ?? '').trim().slice(0, 40).replace(/[^\p{L}\p{N} .&'-]/gu, '');
  const TOOLS = toolsFor(airline);
  const clients = new Map();   // client_id -> { redirectUris, name }
  const pending = new Map();   // our state -> { client, redirectUri, state, challenge, verifier, at }
  const codes = new Map();     // our code -> { token, client, redirectUri, challenge, at }
  const tokens = new Map();    // access token -> { delegated, exp }
  const hits = new Map();
  if (cfg.staticClient) clients.set(cfg.staticClient.id, { redirectUris: cfg.staticClient.redirectUris, name: cfg.staticClient.name });

  // Public endpoints take no cookie, so they get their own small limiter (per address, and across everyone).
  const limit = (req, res, next) => {
    // Muse's own platform runs (platforms.js) are not counted; the /api/sim/start route that starts them has its own per-visitor limit.
    if (req.get('x-muse-self') === SELF_MARK) return next();
    const now = Date.now(); const key = req.ip || 'x';
    for (const [k, v] of hits) { const f = v.filter((t) => now - t < 60000); if (f.length) hits.set(k, f); else hits.delete(k); }
    const mine = hits.get(key) ?? []; const all = [...hits.values()].reduce((n, v) => n + v.length, 0);
    if (mine.length >= 30 || all >= 300) return res.status(429).json({ error: 'slow_down' });
    hits.set(key, [...mine, now]); next();
  };
  const oauthErr = (res, status, error, description) => res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });

  // One line per request to the OAuth and MCP endpoints, so the owner can see what a real client sends. Shapes and hosts only: never codes, tokens, verifiers, assertions or secrets.
  const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return u ? '?' : null; } };
  const urlId = (v) => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : null; } catch { return null; } };
  const traceFields = (req) => {
    const b = req.body ?? {}; const q = req.query ?? {};
    if (req.path === '/connector/register') return { auth_method: b.token_endpoint_auth_method ?? null, grants: b.grant_types ?? null, redirect_hosts: Array.isArray(b.redirect_uris) ? b.redirect_uris.slice(0, 5).map(hostOf) : null, client_name: b.client_name ? String(b.client_name).slice(0, 60) : null };
    if (req.path === '/connector/authorize') return { client_id_is_url: urlId(q.client_id) !== null, client_id_url: urlId(q.client_id), redirect_host: hostOf(q.redirect_uri), pkce: q.code_challenge_method ?? null, response_type: q.response_type ?? null };
    if (req.path === '/connector/token') return { grant_type: b.grant_type ?? null, client_id_is_url: urlId(b.client_id) !== null, client_assertion: b.client_assertion_type ?? null, basic_auth: /^Basic /i.test(req.headers.authorization ?? ''), verifier: Boolean(b.code_verifier) };
    if (req.path === '/mcp') return { bearer: /^Bearer /i.test(req.headers.authorization ?? ''), rpc: [].concat(req.body ?? []).slice(0, 5).map((m) => m?.method ?? null) };
    return null;
  };
  app.use(['/connector/register', '/connector/authorize', '/connector/resume', '/connector/token', '/mcp'], (req, res, next) => {
    const path = req.baseUrl;
    res.on('finish', () => {
      const f = traceFields({ path, body: req.body, query: req.query, headers: req.headers });
      console.log(`[connector] ${req.method} ${path} -> ${res.statusCode} ${JSON.stringify({ ...f, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) })}`);
    });
    next();
  });

  // Discovery (RFC 9728, RFC 8414). Public documents, so a plain CORS header is fine.
  const open = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=60'); next(); };
  const prm = { resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: airline ? `${airline} Airline Connector` : 'Airline Connector' };
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], open, (req, res) => res.json(prm));
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], open, (req, res) => res.json({
    issuer: PUBLIC, authorization_endpoint: `${PUBLIC}/connector/authorize`, token_endpoint: `${PUBLIC}/connector/token`,
    registration_endpoint: `${PUBLIC}/connector/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  }));

  // Dynamic registration (RFC 7591) for redirect hosts the owner named, and for Muse's own stand-in platform callbacks. Public clients with PKCE; no secrets issued.
  app.post('/connector/register', limit, express.json({ limit: '8kb' }), (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    // Hostnames only, so the owner can see what an agent asked for and decide whether to allow it.
    const hostsAsked = [...new Set(uris.slice(0, 5).map((u) => { try { return new URL(u).hostname; } catch { return '?'; } }))];
    if (!uris.length || uris.length > 5 || !uris.every((u) => okRedirect(u, cfg.hosts, PUBLIC))) { console.warn(`[connector] registration refused, redirect host not allowed: ${hostsAsked.join(', ')}`); return oauthErr(res, 400, 'invalid_redirect_uri', 'Every redirect URI must be https on an allowed host.'); }
    capped(clients);
    const id = `muse-${rand(12)}`;
    clients.set(id, { redirectUris: uris, name: String(req.body?.client_name ?? 'Agent').slice(0, 60) });
    res.status(201).set('Cache-Control', 'no-store').json({ client_id: id, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], client_name: clients.get(id).name });
  });

  // The agent's browser lands here. Muse validates the request, then sends the user to PingOne.
  app.get('/connector/authorize', limit, (req, res) => {
    const q = req.query;
    const client = clients.get(String(q.client_id ?? ''));
    // An unknown client or a redirect that does not match exactly never gets redirected anywhere.
    if (!client || !client.redirectUris.includes(String(q.redirect_uri ?? ''))) {
      let h = '?'; try { h = new URL(String(q.redirect_uri)).hostname; } catch { /* keep ? */ }
      console.warn(`[connector] authorize refused: ${client ? 'redirect does not match' : 'unknown client'} (redirect host ${h})`);
      return res.status(400).type('text').send('Unknown client or redirect address.');
    }
    const back = (error) => { const u = new URL(String(q.redirect_uri)); u.searchParams.set('error', error); if (q.state) u.searchParams.set('state', String(q.state)); return res.redirect(302, u.href); };
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request');
    // '.conn' on the login hint tells the PingOne flow this sign-in came through the Airline Connector, so its screens name it.
    const learned = { authorizeEndpoint: live.idp.authorizeEndpoint, tokenEndpoint: live.idp.tokenEndpoint, scopes: ['openid'] };
    const idp = idpFor(cfg, live, String(q.redirect_uri));
    const r = startSignIn(learned, { clientId: idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }, null, { forceLogin: true, loginHint: idp.loginHint ? `${idp.loginHint}.conn` : null });
    capped(pending);
    pending.set(r.state, { client: String(q.client_id), redirectUri: String(q.redirect_uri), state: q.state ? String(q.state) : null, challenge: String(q.code_challenge), verifier: r.verifier, learned, idp, at: Date.now(), go: r.url });
    // Optional: clear any PingOne session in this browser first (demo only), so the consent step cannot hit userSessionMismatch.
    // PingOne sends the browser back to /connector/resume, which must be a registered post-logout redirect URI on the app.
    const signoff = signoutFirst ? String(learned.authorizeEndpoint ?? '').replace(/\/authorize$/, '/signoff') : '';
    if (signoff && signoff.endsWith('/signoff')) {
      const u = new URL(signoff); u.searchParams.set('client_id', idp.clientId); u.searchParams.set('post_logout_redirect_uri', `${PUBLIC}/connector/resume`);
      res.set('Set-Cookie', `muse_resume=${r.state}; Path=/connector; Max-Age=300; HttpOnly; SameSite=Lax${PUBLIC.startsWith('https:') ? '; Secure' : ''}`);
      return res.redirect(302, u.href);
    }
    res.redirect(302, r.url);
  });

  // The browser is back from PingOne's sign-out. Continue to the sign-in that /connector/authorize prepared. The address comes from our own record, never from the request.
  app.get('/connector/resume', limit, (req, res) => {
    const id = /(?:^|; )muse_resume=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const p = id ? pending.get(id) : null;
    res.set('Set-Cookie', 'muse_resume=; Path=/connector; Max-Age=0');
    if (!p || !p.go || Date.now() - p.at > PENDING_MS) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from the agent.');
    res.redirect(302, p.go);
  });

  // PingOne sent the user back. Swap the code, act for the user, and give the agent our own one-time code.
  app.get('/connector/callback', limit, async (req, res) => {
    const p = pending.get(String(req.query.state ?? ''));
    pending.delete(String(req.query.state ?? ''));
    if (!p || Date.now() - p.at > PENDING_MS) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from the agent.');
    const back = (params) => { const u = new URL(p.redirectUri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (p.state) u.searchParams.set('state', p.state); return res.redirect(302, u.href); };
    if (req.query.error) return back({ error: 'access_denied' });
    try {
      const r = await exchangeCode(live, p.learned, { code: String(req.query.code ?? ''), verifier: p.verifier, client: { clientId: p.idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }, resource: null, clientSecret: p.idp.clientSecret }, fetchImpl);
      if (!r.token) return back({ error: 'server_error' });
      const d = await delegate(live, p.idp, r.token, fetchImpl);
      if (!d.token) return back({ error: 'server_error' });
      capped(codes);
      const code = rand(24);
      codes.set(code, { token: d.token, exp: d.claims?.exp ?? null, client: p.client, redirectUri: p.redirectUri, challenge: p.challenge, at: Date.now() });
      back({ code });
    } catch { back({ error: 'server_error' }); }
  });

  // The agent trades our code for an access token. PKCE S256, one use, bound to the client and redirect.
  app.post('/connector/token', limit, express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    const b = req.body ?? {};
    if (b.grant_type !== 'authorization_code') return oauthErr(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    const c = codes.get(String(b.code ?? ''));
    codes.delete(String(b.code ?? ''));
    if (!c || Date.now() - c.at > CODE_MS) return oauthErr(res, 400, 'invalid_grant', 'The code is unknown or expired.');
    if (c.client !== String(b.client_id ?? '') || c.redirectUri !== String(b.redirect_uri ?? '')) return oauthErr(res, 400, 'invalid_grant', 'The client or redirect address does not match.');
    const verifierHash = createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url');
    if (!b.code_verifier || verifierHash !== c.challenge) return oauthErr(res, 400, 'invalid_grant', 'The code verifier does not match.');
    const ttl = Math.max(60, Math.min(TOKEN_MAX_S, c.exp ? c.exp - Math.floor(Date.now() / 1000) : TOKEN_MAX_S));
    capped(tokens);
    const access = rand(32);
    tokens.set(access, { delegated: c.token, exp: Date.now() + ttl * 1000 });
    res.set('Cache-Control', 'no-store').json({ access_token: access, token_type: 'Bearer', expires_in: ttl, scope: 'mcp' });
  });

  // MCP over streamable HTTP, JSON responses only.
  const challenge = (res) => res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`).json({ error: 'unauthorized' });
  const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(msg, session) {
    const { id, method, params } = msg ?? {};
    if (method === 'initialize') return rpc(id, { protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: airline ? `${airline.toLowerCase().replace(/ +/g, '-')}-airline-connector` : 'airline-connector', version: '0.1.0' } });
    if (method === 'ping') return rpc(id, {});
    if (method === 'tools/list') return rpc(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, 'Unknown tool');
      try {
        // Both tools read the airline passenger record (get_loyalty_status) through the gateway, so the balance and the status can never disagree.
        // The gateway sits behind a load balancer and now and then drops a connection; one retry covers it.
        const ask = () => callGateway(live, session.delegated, fetchImpl, { tool: 'get_loyalty_status' });
        const steps = await ask().catch(() => ask());
        const resp = steps.find((s) => s.n === 9)?.response;
        const content = resp?.status === 200 ? resp.body?.result?.content : null;
        if (Array.isArray(content) && content.length) {
          let d = null;
          try { d = JSON.parse(String(content[0].text ?? '')); } catch { /* fall through to the plain result */ }
          if (d && d.loyaltyPoints !== undefined) {
            const out = name === 'loyalty_balance'
              ? { points: d.loyaltyPoints, tier: d.loyaltyTier, passenger: d.name, matchedBy: d.matchedBy }
              : { passengerRef: d.passengerRef, passenger: d.name, loyaltyTier: d.loyaltyTier, loyaltyPoints: d.loyaltyPoints, matchedBy: d.matchedBy };
            return rpc(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false });
          }
          return rpc(id, { content: content.slice(0, 5).map((c) => ({ type: 'text', text: String(c.text ?? '').slice(0, 4000) })), isError: false });
        }
        return rpc(id, { content: [{ type: 'text', text: `The gateway did not allow or complete this call (${resp?.status ?? 'no answer'}).` }], isError: true });
      } catch { return rpc(id, { content: [{ type: 'text', text: 'The gateway could not be reached.' }], isError: true }); }
    }
    return id === undefined ? null : rpcErr(id, -32601, 'Method not found');
  }
  app.post('/mcp', limit, express.json({ limit: '32kb' }), async (req, res) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    const session = m ? tokens.get(m[1]) : null;
    if (!session || Date.now() > session.exp) { if (m) tokens.delete(m[1]); return challenge(res); }
    const body = req.body;
    const msgs = Array.isArray(body) ? body.slice(0, 10) : [body];
    const out = [];
    for (const msg of msgs) { const r = await handle(msg, session); if (r) out.push(r); }
    if (!out.length) return res.status(202).end();
    res.set('Cache-Control', 'no-store').json(Array.isArray(body) ? out : out[0]);
  });
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  return { name: prm.resource_name, url: `${PUBLIC}/mcp`, authorizeUrl: `${PUBLIC}/connector/authorize`, tokenUrl: `${PUBLIC}/connector/token`, scope: 'mcp', clientId: cfg.staticClient?.id ?? null, redirectUri: cfg.staticClient?.redirectUris[0] ?? null, airline: airline || null, assistants: assistantsFor(env, live).map(({ key, name }) => ({ key, name })) };
}
