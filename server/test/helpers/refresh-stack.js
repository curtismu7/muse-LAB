// Test support for the connector's refresh tokens. Everything is an in-process stub with invented ids (00000000-...) and invented secrets: nothing real is contacted.
// The stub PingOne issues a refresh token at the code swap (when asked to), honours the refresh grant the way PingOne does (the old token dies when it rotates), and
// can be told to fail. Its delegated tokens carry the user's `sub` of the access token they were exchanged from, and an expiry relative to the (possibly mocked) clock.
import { createHash } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { createApp } from '../../src/index.js';

export const GW = 'https://gw.example/muse-ig/mcp';
export const ENV_ID = '00000000-0000-0000-0000-0000000000e1';
export const P1 = `https://auth.pingone.com/${ENV_ID}/as`;
export const ACTOR = '00000000-0000-0000-0000-0000000000a1';
export const USER = '00000000-0000-0000-0000-0000000000b1';
export const USER2 = '00000000-0000-0000-0000-0000000000b2';
export const CLIENT_SECRET = 'idp-secret-not-real-0003';
export const REDIRECT = 'https://chat.agent.example/oauth/callback';
export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());
const BASE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: ENV_ID, MUSE_P1_CLIENT_ID: ACTOR, MUSE_P1_CLIENT_SECRET: CLIENT_SECRET, MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1' };

// What the stub PingOne does. Tests change these between calls.
export const newPingOne = (over = {}) => ({
  sub: USER,                 // the user who signs in
  issueRefresh: true,        // the code swap returns a refresh token
  rotate: true,              // the refresh grant returns a new refresh token and kills the old one
  refreshMode: 'ok',         // ok | invalid_grant | network | 503 | 429 | no_token
  exchangeMode: 'ok',        // ok | refused | network | 503   (applies to the token-exchange steps)
  refreshDelayMs: 0,         // makes the refresh grant slow, so concurrent refreshes overlap
  lifetimeS: 1800,           // expiry of a delegated token
  refreshSub: null,          // the user the refreshed access token is for (default: the same user)
  valid: new Set(),          // PingOne refresh tokens that are alive
  counter: 0,
  refreshCalls: 0,
  ...over,
});

export function stubNet(seen, p1) {
  const delegated = new Set();   // delegated tokens handed out and still known to the gateway
  const net = async (url, init) => {
    const u = String(url);
    seen.push({ url: u, init });
    if (u === `${P1}/token`) {
      const f = new URLSearchParams(init.body);
      const g = f.get('grant_type');
      if (g === 'authorization_code') {
        const body = { access_token: jwt({ aud: 'x', sub: p1.sub }) };
        if (p1.issueRefresh) { const rt = `p1-rt-${++p1.counter}-not-real`; p1.valid.add(rt); body.refresh_token = rt; }
        return json(200, body);
      }
      if (g === 'refresh_token') {
        p1.refreshCalls += 1;
        if (p1.refreshDelayMs) await new Promise((r) => setTimeout(r, p1.refreshDelayMs));
        if (p1.refreshMode === 'network') throw new Error('ECONNRESET');
        if (p1.refreshMode === '503') return json(503, { error: 'unavailable' });
        if (p1.refreshMode === '429') return json(429, { error: 'rate_limited' });
        if (p1.refreshMode === 'invalid_grant') return json(400, { error: 'invalid_grant' });
        if (p1.refreshMode === 'no_token') return json(200, {});
        const old = f.get('refresh_token');
        if (!p1.valid.has(old) || f.get('client_id') !== ACTOR || f.get('client_secret') !== CLIENT_SECRET) return json(400, { error: 'invalid_grant' });
        const body = { access_token: jwt({ aud: 'x', sub: p1.refreshSub ?? p1.sub }) };
        if (p1.rotate) { p1.valid.delete(old); const rt = `p1-rt-${++p1.counter}-not-real`; p1.valid.add(rt); body.refresh_token = rt; }
        return json(200, body);
      }
      // client_credentials and the two token exchanges
      if (g !== 'client_credentials') {
        if (p1.exchangeMode === 'network') throw new Error('ECONNRESET');
        if (p1.exchangeMode === '503') return json(503, { error: 'unavailable' });
        if (p1.exchangeMode === 'refused') return json(400, { error: 'invalid_grant' });
      }
      const sub = g === 'client_credentials' ? ACTOR : claimsOf(f.get('subject_token')).sub;
      const t = jwt({ iss: P1, aud: 'priv-nhi-x', sub, act: { sub: f.get('client_id') }, exp: Math.floor(Date.now() / 1000) + p1.lifetimeS, n: ++p1.counter });
      if (g !== 'client_credentials' && f.get('subject_token_type')) delegated.add(t);
      return json(200, { access_token: t });
    }
    if (u === GW) {
      const bearer = /^Bearer (.+)$/.exec(init.headers.authorization ?? '')?.[1];
      if (!bearer || !delegated.has(bearer) || claimsOf(bearer).exp * 1000 < Date.now()) return json(401, { error: 'invalid_token' });
      const m = JSON.parse(init.body);
      if (m.method === 'tools/call') return json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ matchedBy: 'subject', loyaltyTier: 'Premier Gold', loyaltyPoints: 52000, passengerRef: 'UA-PAX-0100', name: 'Sam Demo' }) }] } });
      return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
    }
    throw new Error(`unexpected ${url}`);
  };
  net.delegated = delegated;
  return net;
}

export async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

export const pkce = () => { const verifier = 'v'.repeat(50); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };

// The app on a free loopback port, with the stub PingOne and gateway. `extra` is env (MUSE_CONNECTOR_REFRESH=1 and friends).
export async function boot(extra = {}, p1Over = {}) {
  const port = await freePort(); const seen = []; const p1 = newPingOne(p1Over);
  const env = { ...BASE, MUSE_PUBLIC_URL: `http://127.0.0.1:${port}`, MUSE_CONNECTOR_REDIRECT_HOSTS: 'agent.example', ...extra };
  const stub = stubNet(seen, p1);
  const server = createApp(env, { fetchImpl: stub }).listen(port, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${port}`;
  const get = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const post = (p, body, headers = {}, form = false) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  const grants = () => seen.filter((x) => x.url === `${P1}/token`).map((x) => new URLSearchParams(x.init.body).get('grant_type'));
  return { base, seen, p1, stub, get, post, grants, port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

const flowOf = (a, au) => new URL(au.headers.get('location')).searchParams.get('flow');

// Registers a client (or uses the given one), signs in through the pi.flow completion and trades the code. Returns what the agent holds.
export async function connect(a, { reg = null, registration = { redirect_uris: [REDIRECT] }, redirect = REDIRECT } = {}) {
  const client = reg ?? await (await a.post('/connector/register', registration)).json();
  const { verifier, challenge } = pkce();
  const au = await a.get(`/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state: 'agent-state', code_challenge: challenge, code_challenge_method: 'S256' })}`);
  const flow = flowOf(a, au);
  const done = await (await a.post('/connector/signin/complete', { state: flow, code: 'pingone-code' })).json();
  const code = new URL(done.redirectTo).searchParams.get('code');
  const tr = await a.post('/connector/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }, {}, true);
  const tokens = await tr.json();
  return { client, clientId: client.client_id, tokens, status: tr.status, flow };
}

export const refreshWith = (a, clientId, refresh_token, extra = {}) => a.post('/connector/token', { grant_type: 'refresh_token', ...(clientId === undefined ? {} : { client_id: clientId }), ...(refresh_token === undefined ? {} : { refresh_token }), ...extra }, {}, true);
export const callTool = (a, access, name = 'loyalty_balance') => a.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } }, { authorization: `Bearer ${access}` });
export const ON = { MUSE_CONNECTOR_REFRESH: '1' };
