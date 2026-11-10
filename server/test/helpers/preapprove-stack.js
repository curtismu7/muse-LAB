// Test support for the connector's pre-approval and pass-through behaviour. Everything here is an in-process stub with invented ids (00000000-...) and invented secrets:
//   - a stub PingOne (token endpoint for the sign-in AND for the tier switch's worker credential, plus the user record the tier switch reads),
//   - a stub gateway whose book_airline_flight answer a test scripts, or `realStackGateway`, which applies the rules the real stack applies
//     (trusted caller, consent, the user's limit as Authorize reads it from PingOne, the pre-approval rule, the human hold).
// Nothing real is contacted: the app is handed this fetch, and a URL it does not know throws.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../../src/index.js';
import { liveConfig } from '../../src/discovery.js';
import { mountConnector } from '../../src/connector.js';
import { RULES, fareFor } from '../../src/fares.js';

export const GW = 'https://gw.example/muse-ig/mcp';
export const ENV_ID = '00000000-0000-0000-0000-0000000000e1';
export const P1 = `https://auth.pingone.com/${ENV_ID}/as`;
export const API = `https://api.pingone.com/v1/environments/${ENV_ID}/users`;
export const ACTOR = '00000000-0000-0000-0000-0000000000a1';
export const USER = '00000000-0000-0000-0000-0000000000b1';
export const USER2 = '00000000-0000-0000-0000-0000000000b2';
export const STRANGER = '00000000-0000-0000-0000-0000000000ff';
export const WORKER = '00000000-0000-0000-0000-0000000000c1';
export const BRIDGE_SECRET = 'bridge-test-secret-not-real-0001';
export const WORKER_SECRET = 'worker-test-secret-not-real-0002';
export const REDIRECT = 'https://chat.agent.example/oauth/callback';
export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
export const hdr = (h, name) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const BASE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: ENV_ID, MUSE_P1_CLIENT_ID: ACTOR, MUSE_P1_CLIENT_SECRET: 'idp-secret-not-real', MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1' };
// The tier switch (worker credential + allow-list) switched on, as the owner's .env would.
export const TIER_ON = { MUSE_TIER_ENABLE: '1', MUSE_TIER_WORKER_CLIENT_ID: WORKER, MUSE_TIER_WORKER_CLIENT_SECRET: WORKER_SECRET, MUSE_TIER_USER_IDS: USER };

// What the stub PingOne holds, and how it behaves. mode: ok | 429 | 500 | throw | hang | tokenfail.
export const newState = (over = {}) => ({ tier: 'Premier Silver', limit: null, mode: 'ok', sub: USER, reads: [], workerTokens: 0, ...over });

export function stubNet(seen, script, state) {
  return async (url, init) => {
    const u = String(url);
    if (u === `${P1}/token`) {
      // The tier switch's worker credential uses client secret basic; the sign-in and the delegation use the form.
      if (/^Basic /.test(hdr(init.headers, 'authorization') ?? '')) {
        seen.push({ url: u, init, method: 'worker-token' });
        state.workerTokens += 1;
        if (state.mode === 'throw') throw new Error('socket closed');
        if (state.mode === 'tokenfail') return json(401, { error: 'invalid_client' });
        return json(200, { access_token: 'worker-token-not-real', expires_in: 300 });
      }
      const f = new URLSearchParams(init.body);
      const access = f.get('grant_type') === 'authorization_code' ? jwt({ aud: 'x', sub: state.sub }) : jwt({ iss: P1, aud: 'priv-nhi-x', sub: state.sub, act: { sub: f.get('client_id') }, exp: Math.floor(Date.now() / 1000) + 1800 });
      seen.push({ url: u, init, method: 'token', access, grant: f.get('grant_type') });
      return json(200, { access_token: access });
    }
    if (u.startsWith(`${API}/`)) {
      seen.push({ url: u, init, method: 'user-read' });
      state.reads.push(u.slice(API.length + 1));
      if (state.mode === 'throw') throw new Error('socket closed');
      if (state.mode === 'hang') return new Promise(() => {});
      if (state.mode === '429') return json(429, { code: 'REQUEST_LIMITED' });
      if (state.mode === '500') return json(500, { code: 'UNEXPECTED_ERROR' });
      return json(200, { id: u.slice(API.length + 1), ...(state.tier === undefined ? {} : { airlineMemberTier: state.tier }), ...(state.limit === undefined ? {} : { agentSpendLimit: state.limit }) });
    }
    if (u !== GW) throw new Error(`unexpected ${u}`);
    const m = JSON.parse(init.body);
    seen.push({ url: u, init, method: m.method, tool: m.params?.name, args: m.params?.arguments });
    if (m.method === 'tools/call') return m.params.name === 'get_loyalty_status' ? script.other() : script.book(m.params.arguments, init.headers);
    return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
  };
}

export const OPEN_FARE = 'SH000';
export const audit = (authorize, extra = {}) => ({ 'x-gw-audit-trail': JSON.stringify({ authorize: { decision: 'DENY', tool: 'book_airline_flight', ...authorize }, ...extra }) });
export const stub = { mcp: (o = {}) => ({ result: { content: [{ type: 'text', text: JSON.stringify({ booked: true, confirmationNumber: 'CONF-STUB-1', fare: 180, ...o }) }] } }) };

// The rules the real stack applies to a book_flight call, in the order it applies them. state.limit is what Authorize reads from the PingOne user (empty means its default of 500);
// the AgentSpendLimit parameter in the audit trail is what the GATEWAY thinks (the trusted header when valid, else 500), which may differ. mcpAnswer is the airline MCP server's own reply.
export function realStackGateway({ secret = BRIDGE_SECRET, actor = ACTOR, state, mcpAnswer = (args, fare) => stub.mcp({ confirmationNumber: `CONF-STUB-${args.flight_number}`, fare, flight_number: args.flight_number, passenger: 'Stub Passenger' }), payloadLimit = false }) {
  const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
  const num = (v) => { const s = String(v ?? ''); return s.length <= 7 && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : null; };
  return (args, headers) => {
    const trusted = same(hdr(headers, 'x-internal-gateway-secret') ?? '', secret);
    // The open-fare rule: SH000 takes the STATED amount as the price, but only from the trusted caller and only when it is a positive number up to 100000 with at most 2 decimals. Anything else
    // fails closed before Authorize. Every other flight uses the catalogue fare and ignores whatever amount the caller sent.
    let fare; let fareAudit = {};
    if (args.flight_number === OPEN_FARE) {
      if (!trusted) return json(403, { error: 'open_fare_untrusted' });
      const a = args.amount;
      if (!(typeof a === 'number' && Number.isFinite(a) && a > 0 && a <= 100000 && Math.abs(a * 100 - Math.round(a * 100)) < 1e-6)) return json(403, { error: 'open_fare_bad_amount' });
      fare = a; fareAudit = { fareSource: 'stated', statedAmount: a };
    } else {
      fare = fareFor(args.flight_number);
      if (fare === null) return json(403, { error: 'unknown_flight' });
    }
    const mayActSub = trusted ? String(hdr(headers, 'X-May-Act-Sub') ?? '') : '';
    if (!mayActSub) return json(403, { error: 'access_denied' }, audit({ parameters: { Amount: String(fare) }, statements: [{ code: 'no_user_consent', payload: { message: 'no consent' } }] }, fareAudit));
    if (mayActSub !== actor) return json(403, { error: 'access_denied' }, audit({ parameters: { Amount: String(fare) }, statements: [{ code: 'may_act_mismatch', payload: { message: 'mismatch' } }] }, fareAudit));
    const gatewayLimit = trusted ? (num(hdr(headers, 'X-Agent-Spend-Limit')) ?? 500) : 500;
    const authorizeLimit = state.limit === null || state.limit === undefined || state.limit === '' ? 500 : Number(state.limit);
    const statements = [];
    if (fare > authorizeLimit) statements.push({ code: RULES.agentSpendLimit.code, payload: { message: `fare $${fare} is over the limit`, ...(payloadLimit ? { limit: authorizeLimit } : {}) } });
    if (fare > 750 && state.tier !== 'Premier Gold') statements.push({ code: RULES.premiumOnly.code, payload: { message: 'premium only' } });
    if (statements.length) return json(403, { error: 'access_denied' }, audit({ parameters: { Amount: String(fare), AgentSpendLimit: String(gatewayLimit), ...(state.tier ? { MemberTier: state.tier } : {}) }, statements }, fareAudit));
    const pre = trusted && hdr(headers, 'X-Hitl-Preapproved') === 'user-limit';
    if (pre && fare <= gatewayLimit) return json(200, mcpAnswer(args, fare));
    return json(428, { error: 'consent_pending', decision: 'PERMIT' });
  };
}

// Starts the app on a loopback port with the stubs. Listens first and attaches afterwards, so no other process can take the port in between.
// userFacts (optional) mounts the connector alone with that function in place of the tier switch's read, to prove a misbehaving read can never block a booking.
export async function startApp(extra = {}, { state = newState(), script = null, userFacts } = {}) {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; const seen = [];
  const sc = script ?? { book: () => json(200, stub.mcp()), other: () => json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ loyaltyPoints: 1200, loyaltyTier: 'Silver', name: 'Sam', passengerRef: 'P-1' }) }] } }) };
  const env = { ...BASE, MUSE_PUBLIC_URL: `http://127.0.0.1:${port}`, MUSE_CONNECTOR_REDIRECT_HOSTS: 'agent.example', ...extra };
  if (userFacts !== undefined) { const app = express(); mountConnector(app, { env, live: liveConfig(env), fetchImpl: stubNet(seen, sc, state), userFacts, factsTimeoutMs: 300 }); server.on('request', app); } else server.on('request', createApp(env, { fetchImpl: stubNet(seen, sc, state) }));
  return { base: `http://127.0.0.1:${port}`, seen, state, script: sc, close: () => new Promise((r) => server.close(r)) };
}

// The browser half of the sign-in, done by hand: register, authorize, complete the (stub) PingOne sign-in, trade the code. Returns the access token for /mcp.
export async function signIn(base, redirect = REDIRECT) {
  const post = (p, body, form = false) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  const reg = await (await post('/connector/register', { redirect_uris: [redirect] })).json();
  const verifier = 'v'.repeat(50);
  const au = await fetch(`${base}/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  const flow = new URL(au.headers.get('location')).searchParams.get('flow');
  const done = await (await post('/connector/signin/complete', { state: flow, code: 'pingone-code' })).json();
  const code = new URL(done.redirectTo).searchParams.get('code');
  const tj = await (await post('/connector/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }, true)).json();
  return tj.access_token;
}

// startApp + signIn + the small JSON-RPC helpers every test uses.
export async function boot(extra = {}, opts = {}) {
  const app = await startApp(extra, opts);
  const token = await signIn(app.base);
  let n = 10;
  const rpc = async (method, params) => (await (await fetch(`${app.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: n++, method, params }) })).json());
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const gw = () => app.seen.filter((x) => x.url === GW);
  const gwCall = () => gw().filter((x) => x.method === 'tools/call');
  return { ...app, rpc, call, gw, gwCall, token };
}
export const text = (r) => r.result.content.map((c) => c.text).join('\n');
