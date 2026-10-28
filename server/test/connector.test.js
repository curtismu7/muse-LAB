import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { connectorConfig, toolsFor } from '../src/connector.js';
import { liveConfig } from '../src/discovery.js';

const GW = 'https://gw.example/muse-ig/mcp';
const P1 = 'https://auth.pingone.com/env1/as';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const DELEGATED = jwt({ iss: P1, aud: 'priv-nhi-x', sub: 'sam', act: { sub: 'c1' }, exp: Math.floor(Date.now() / 1000) + 1800 });
const BASE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'c1', MUSE_P1_CLIENT_SECRET: 'sekret', MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1' };

test('the connector is off unless asked for, needs real mode with a secret, and an https (or loopback) public address', () => {
  const live = (env) => liveConfig(env);
  const on = { ...BASE, MUSE_PUBLIC_URL: 'https://muse.example' };
  assert.equal(connectorConfig({ ...on, MUSE_CONNECTOR: '0' }, live(on)), null);
  assert.equal(connectorConfig(on, live(on)).publicUrl, 'https://muse.example');
  const noSecret = { ...on, MUSE_P1_CLIENT_SECRET: '' };
  assert.equal(connectorConfig(noSecret, live(noSecret)), null);
  assert.equal(connectorConfig({ ...on, MUSE_PUBLIC_URL: 'http://muse.example' }, live(on)), null, 'http is only allowed on loopback');
  assert.equal(connectorConfig({ ...on, MUSE_PUBLIC_URL: 'http://127.0.0.1:5102' }, live(on)).publicUrl, 'http://127.0.0.1:5102');
  assert.equal(connectorConfig({ ...on, MUSE_CONNECTOR_CLIENT_ID: 'meta', MUSE_CONNECTOR_REDIRECT_URIS: 'https://a.example/cb' }, live(on)).staticClient.id, 'meta');
});

async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

function fakeNet(seen, drops = { n: 0 }) {
  return async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url) === GW && drops.n > 0) { drops.n -= 1; throw new Error('ECONNRESET'); }
    if (String(url) === `${P1}/token`) {
      const f = new URLSearchParams(init.body);
      return json(200, { access_token: f.get('grant_type') === 'authorization_code' ? jwt({ aud: 'x', sub: 'sam' }) : DELEGATED });
    }
    if (String(url) === GW) {
      const m = JSON.parse(init.body);
      if (m.method === 'tools/call') return json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ matchedBy: 'subject', loyaltyTier: 'Premier Gold', loyaltyPoints: 52000, passengerRef: 'UA-PAX-0100', name: 'Sam Demo' }) }] } });
      return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
    }
    throw new Error(`unexpected ${url}`);
  };
}

async function boot(extra = {}) {
  const port = await freePort(); const seen = []; const drops = { n: 0 };
  const env = { ...BASE, MUSE_PUBLIC_URL: `http://127.0.0.1:${port}`, MUSE_CONNECTOR_REDIRECT_HOSTS: 'agent.example', ...extra };
  const server = createApp(env, { fetchImpl: fakeNet(seen, drops) }).listen(port, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${port}`;
  const get = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const post = (p, body, headers = {}, form = false) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  return { base, seen, drops, get, post, close: () => new Promise((r) => server.close(r)) };
}
const REDIRECT = 'https://chat.agent.example/oauth/callback';
const pkce = () => { const verifier = 'v'.repeat(50); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };

test('discovery documents point at this server, and registration only appears when redirect hosts are configured', async () => {
  const a = await boot();
  const prm = await (await a.get('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource, `${a.base}/mcp`); assert.deepEqual(prm.authorization_servers, [a.base]); assert.equal(prm.resource_name, 'Airline Connector');
  const as = await (await a.get('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.authorization_endpoint, `${a.base}/connector/authorize`);
  assert.equal(as.registration_endpoint, `${a.base}/connector/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  await a.close();
  const b = await boot({ MUSE_CONNECTOR_REDIRECT_HOSTS: '' });
  assert.equal((await (await b.get('/.well-known/oauth-authorization-server')).json()).registration_endpoint, undefined);
  assert.equal((await b.post('/connector/register', { redirect_uris: [REDIRECT] })).status, 403);
  await b.close();
});

test('/mcp without a token answers 401 with the metadata address', async () => {
  const a = await boot();
  const r = await a.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${a.base}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal((await a.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer nope' })).status, 401);
  await a.close();
});

test('registration only accepts https redirects on allowed hosts', async () => {
  const a = await boot();
  assert.equal((await a.post('/connector/register', { redirect_uris: [REDIRECT], client_name: 'Agent' })).status, 201);
  for (const bad of ['https://evil.example/cb', 'http://chat.agent.example/cb', 'https://chat.agent.example.evil.example/cb', 'javascript:alert(1)', 'https://chat.agent.example/cb#frag']) {
    assert.equal((await a.post('/connector/register', { redirect_uris: [bad] })).status, 400, bad);
  }
  assert.equal((await a.post('/connector/register', { redirect_uris: [] })).status, 400);
  await a.close();
});

test('authorize: unknown clients and unmatched redirects are never redirected; a good request goes to PingOne with a fresh login', async () => {
  const a = await boot();
  const reg = await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
  const { challenge } = pkce();
  const q = (o) => new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 'st', code_challenge: challenge, code_challenge_method: 'S256', ...o });
  assert.equal((await a.get(`/connector/authorize?${q({ client_id: 'nobody' })}`)).status, 400);
  assert.equal((await a.get(`/connector/authorize?${q({ redirect_uri: 'https://chat.agent.example/other' })}`)).status, 400);
  const noPkce = await a.get(`/connector/authorize?${q({ code_challenge_method: 'plain' })}`);
  assert.equal(noPkce.status, 302); assert.match(noPkce.headers.get('location'), /error=invalid_request/);
  const ok = await a.get(`/connector/authorize?${q({})}`);
  const u = new URL(ok.headers.get('location'));
  assert.equal(u.origin + u.pathname, `${P1}/authorize`);
  assert.equal(u.searchParams.get('prompt'), 'login');
  assert.equal(u.searchParams.get('login_hint'), 'demouser.conn', 'the sign-in is marked as coming through the connector');
  assert.equal(u.searchParams.get('redirect_uri'), `${a.base}/connector/callback`);
  assert.notEqual(u.searchParams.get('state'), 'st', 'PingOne gets Muse\'s own state, not the agent\'s');
  await a.close();
});

async function signedIn(a, clientOverride) {
  const reg = clientOverride ?? await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
  const { verifier, challenge } = pkce();
  const au = await a.get(`/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 'agent-state', code_challenge: challenge, code_challenge_method: 'S256' })}`);
  const ourState = new URL(au.headers.get('location')).searchParams.get('state');
  const cb = await a.get(`/connector/callback?code=pingone-code&state=${ourState}`);
  const back = new URL(cb.headers.get('location'));
  return { reg, verifier, back, ourState };
}

test('the full flow: sign-in at PingOne, Muse acts for the user, the agent gets its own token and calls the tools', async () => {
  const a = await boot();
  const { reg, verifier, back } = await signedIn(a);
  assert.equal(back.origin + back.pathname, REDIRECT); assert.equal(back.searchParams.get('state'), 'agent-state');
  const code = back.searchParams.get('code'); assert.ok(code);
  assert.deepEqual(a.seen.filter((x) => x.url === `${P1}/token`).map((x) => new URLSearchParams(x.init.body).get('grant_type')),
    ['authorization_code', 'client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:token-exchange']);

  const tokenBody = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier };
  const tr = await a.post('/connector/token', tokenBody, {}, true);
  const tj = await tr.json();
  assert.equal(tr.status, 200); assert.equal(tj.token_type, 'Bearer'); assert.ok(tj.expires_in > 0 && tj.expires_in <= 3600);
  assert.ok(!JSON.stringify(tj).includes(DELEGATED), 'the agent never receives the delegated token');
  assert.equal((await a.post('/connector/token', tokenBody, {}, true)).status, 400, 'a code works once');

  const auth = { authorization: `Bearer ${tj.access_token}` };
  const init = await (await a.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth)).json();
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'airline-connector');
  assert.equal((await a.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
  const list = await (await a.post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['loyalty_balance', 'get_loyalty_status']);
  const call = await (await a.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'loyalty_balance', arguments: {} } }, auth)).json();
  assert.equal(call.result.isError, false); assert.deepEqual(a.seen.filter((x) => x.url === GW && x.init.body).map((x) => JSON.parse(x.init.body)).filter((m) => m.method === 'tools/call').map((m) => m.params.name).slice(-1), ['get_loyalty_status'], 'the gateway is asked for the airline record'); assert.equal(JSON.parse(call.result.content[0].text).points, 52000);
  const st = await (await a.post('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_loyalty_status', arguments: {} } }, auth)).json();
  assert.equal(st.result.isError, false);
  const sj = JSON.parse(st.result.content[0].text); assert.equal(sj.loyaltyPoints, JSON.parse(call.result.content[0].text).points, 'status and balance agree');
  const gw = a.seen.filter((x) => x.url === GW && x.init.headers.authorization);
  assert.ok(gw.length >= 1 && gw.every((x) => x.init.headers.authorization === `Bearer ${DELEGATED}`), 'the gateway gets the delegated token, not the agent\'s');
  const bad = await (await a.post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'transfer_money', arguments: {} } }, auth)).json();
  assert.equal(bad.error.code, -32602);
  await a.close();
});

test('the token step checks the verifier, the client and the redirect', async () => {
  const a = await boot();
  for (const tweak of [{ code_verifier: 'w'.repeat(50) }, { redirect_uri: 'https://chat.agent.example/other' }, { client_id: 'someone-else' }, { code_verifier: '' }]) {
    const { reg, verifier, back } = await signedIn(a);
    const r = await a.post('/connector/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, ...tweak }, {}, true);
    assert.equal(r.status, 400, JSON.stringify(tweak)); assert.equal((await r.json()).error, 'invalid_grant');
  }
  assert.equal((await a.post('/connector/token', { grant_type: 'refresh_token' }, {}, true)).status, 400);
  await a.close();
});

test('callback: an unknown state is refused, a refused sign-in goes back to the agent as access_denied', async () => {
  const a = await boot();
  assert.equal((await a.get('/connector/callback?code=x&state=forged')).status, 400);
  const reg = await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
  const au = await a.get(`/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
  const st = new URL(au.headers.get('location')).searchParams.get('state');
  const denied = await a.get(`/connector/callback?error=access_denied&state=${st}`);
  assert.match(denied.headers.get('location'), /error=access_denied/); assert.match(denied.headers.get('location'), /state=s/);
  assert.equal((await a.get(`/connector/callback?code=x&state=${st}`)).status, 400, 'state is single use');
  await a.close();
});

test('a pre-registered client id works without registration', async () => {
  const a = await boot({ MUSE_CONNECTOR_CLIENT_ID: 'meta-muse', MUSE_CONNECTOR_REDIRECT_URIS: REDIRECT, MUSE_CONNECTOR_REDIRECT_HOSTS: '' });
  const { reg, verifier, back } = await signedIn(a, { client_id: 'meta-muse' });
  const r = await a.post('/connector/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: 'meta-muse', code_verifier: verifier }, {}, true);
  assert.equal(r.status, 200);
  await a.close();
});

test('the session tells the page how to add the connector, and says nothing when it is off', async () => {
  const a = await boot({ MUSE_CONNECTOR_CLIENT_ID: 'airline-connector', MUSE_CONNECTOR_REDIRECT_URIS: REDIRECT });
  const on = await (await a.get('/api/session')).json();
  assert.deepEqual(on.connector, { url: `${a.base}/mcp`, clientId: 'airline-connector', redirectUri: REDIRECT });
  await a.close();
  const b = await boot({ MUSE_CONNECTOR: '0' });
  assert.equal((await (await b.get('/api/session')).json()).connector, null);
  await b.close();
});

test('with an airline named, the tool descriptions and server name say which airline, and odd characters are dropped', async () => {
  const a = await boot({ MUSE_CONNECTOR_AIRLINE: 'United <b>' });
  const prm = await (await a.get('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource_name, 'United b Airline Connector');
  await a.close();
  assert.ok(toolsFor('United').every((x) => x.description.includes('United')));
  assert.ok(toolsFor('').every((x) => !x.description.includes('United')));
});

test('a dropped gateway connection is retried once, so the tool call still answers', async () => {
  const a = await boot();
  const { reg, verifier, back } = await signedIn(a);
  const tj = await (await a.post('/connector/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }, {}, true)).json();
  const auth = { authorization: `Bearer ${tj.access_token}` };
  const call = () => a.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'loyalty_balance', arguments: {} } }, auth).then((r) => r.json());
  a.drops.n = 1;
  assert.equal((await call()).result.isError, false, 'one dropped connection is retried');
  a.drops.n = 2;
  assert.equal((await call()).result.isError, true, 'two in a row is reported, not hidden');
  await a.close();
});
