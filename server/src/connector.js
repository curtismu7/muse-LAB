// The Airline Connector: Muse's server as a custom connector for other agents (for example Meta's Muse at muse.ai). Standard MCP over HTTP with OAuth:
//   agent -> /mcp (401 + metadata) -> /connector/authorize -> PingOne (the same DaVinci flow: login, Protect, agent-detected, consent)
//   -> /connector/callback (Muse does the on-behalf-of exchanges) -> /connector/token -> agent calls /mcp with the token.
// Muse is both the OAuth authorization server the agent talks to and the MCP server. The tools it serves are a fixed list,
// answered by calling the gateway with the delegated token. Nothing here is on unless MUSE_CONNECTOR=1 and real mode is configured.
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { callGateway, delegate, exchangeCode, startSignIn } from './liveauth.js';

const b64u = (b) => b.toString('base64url');
const rand = (n = 32) => b64u(randomBytes(n));
const TOOLS = [
  { name: 'loyalty_balance', description: "The member's airline points balance and tier.", inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_loyalty_status', description: "The member's loyalty status: tier, points and account status.", inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
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
  return { publicUrl: pu.origin, hosts, staticClient };
}

const okRedirect = (uri, hosts) => {
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
  const clients = new Map();   // client_id -> { redirectUris, name }
  const pending = new Map();   // our state -> { client, redirectUri, state, challenge, verifier, at }
  const codes = new Map();     // our code -> { token, client, redirectUri, challenge, at }
  const tokens = new Map();    // access token -> { delegated, exp }
  const hits = new Map();
  if (cfg.staticClient) clients.set(cfg.staticClient.id, { redirectUris: cfg.staticClient.redirectUris, name: cfg.staticClient.name });

  // Public endpoints take no cookie, so they get their own small limiter (per address, and across everyone).
  const limit = (req, res, next) => {
    const now = Date.now(); const key = req.ip || 'x';
    for (const [k, v] of hits) { const f = v.filter((t) => now - t < 60000); if (f.length) hits.set(k, f); else hits.delete(k); }
    const mine = hits.get(key) ?? []; const all = [...hits.values()].reduce((n, v) => n + v.length, 0);
    if (mine.length >= 30 || all >= 300) return res.status(429).json({ error: 'slow_down' });
    hits.set(key, [...mine, now]); next();
  };
  const oauthErr = (res, status, error, description) => res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });

  // Discovery (RFC 9728, RFC 8414). Public documents, so a plain CORS header is fine.
  const open = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=60'); next(); };
  const prm = { resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'Airline Connector' };
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], open, (req, res) => res.json(prm));
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], open, (req, res) => res.json({
    issuer: PUBLIC, authorization_endpoint: `${PUBLIC}/connector/authorize`, token_endpoint: `${PUBLIC}/connector/token`,
    ...(cfg.hosts.length ? { registration_endpoint: `${PUBLIC}/connector/register` } : {}),
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  }));

  // Dynamic registration (RFC 7591) only for redirect hosts the owner named. Public clients with PKCE; no secrets issued.
  app.post('/connector/register', limit, express.json({ limit: '8kb' }), (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    // Hostnames only, so the owner can see what an agent asked for and decide whether to allow it.
    const hostsAsked = [...new Set(uris.slice(0, 5).map((u) => { try { return new URL(u).hostname; } catch { return '?'; } }))];
    if (!cfg.hosts.length) { console.warn(`[connector] registration refused, no redirect hosts allowed. Agent asked for: ${hostsAsked.join(', ')}`); return oauthErr(res, 403, 'registration_not_allowed', 'This server has no redirect hosts configured.'); }
    if (!uris.length || uris.length > 5 || !uris.every((u) => okRedirect(u, cfg.hosts))) { console.warn(`[connector] registration refused, redirect host not allowed: ${hostsAsked.join(', ')}`); return oauthErr(res, 400, 'invalid_redirect_uri', 'Every redirect URI must be https on an allowed host.'); }
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
    const r = startSignIn(learned, { clientId: live.idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }, null, { forceLogin: true, loginHint: live.idp.loginHint ? `${live.idp.loginHint}.conn` : null });
    capped(pending);
    pending.set(r.state, { client: String(q.client_id), redirectUri: String(q.redirect_uri), state: q.state ? String(q.state) : null, challenge: String(q.code_challenge), verifier: r.verifier, learned, at: Date.now() });
    res.redirect(302, r.url);
  });

  // PingOne sent the user back. Swap the code, act for the user, and give the agent our own one-time code.
  app.get('/connector/callback', limit, async (req, res) => {
    const p = pending.get(String(req.query.state ?? ''));
    pending.delete(String(req.query.state ?? ''));
    if (!p || Date.now() - p.at > PENDING_MS) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from the agent.');
    const back = (params) => { const u = new URL(p.redirectUri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (p.state) u.searchParams.set('state', p.state); return res.redirect(302, u.href); };
    if (req.query.error) return back({ error: 'access_denied' });
    try {
      const r = await exchangeCode(live, p.learned, { code: String(req.query.code ?? ''), verifier: p.verifier, client: { clientId: live.idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }, resource: null, clientSecret: live.idp.clientSecret }, fetchImpl);
      if (!r.token) return back({ error: 'server_error' });
      const d = await delegate(live, live.idp, r.token, fetchImpl);
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
    if (method === 'initialize') return rpc(id, { protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'airline-connector', version: '0.1.0' } });
    if (method === 'ping') return rpc(id, {});
    if (method === 'tools/list') return rpc(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, 'Unknown tool');
      try {
        // Both tools read the same gateway record, so the balance and the status can never disagree.
        const steps = await callGateway(live, session.delegated, fetchImpl, { tool: 'loyalty_balance' });
        const resp = steps.find((s) => s.n === 9)?.response;
        const content = resp?.status === 200 ? resp.body?.result?.content : null;
        if (name === 'get_loyalty_status' && Array.isArray(content) && content.length) {
          let d = null;
          try { d = JSON.parse(String(content[0].text ?? '')).data; } catch { /* fall through to the plain result */ }
          if (d) return rpc(id, { content: [{ type: 'text', text: JSON.stringify({ memberId: d.id, loyaltyTier: d.tier, loyaltyPoints: d.points, status: d.status }) }], isError: false });
        }
        if (Array.isArray(content) && content.length) return rpc(id, { content: content.slice(0, 5).map((c) => ({ type: 'text', text: String(c.text ?? '').slice(0, 4000) })), isError: false });
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
  return true;
}
