import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';

const GW = 'https://gw.example/pft/mcp';
const ENV = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW };
const AS = { issuer: 'https://gw.example/pft', authorization_endpoint: 'https://gw.example/pft/authorize', token_endpoint: 'https://gw.example/pft/token', registration_endpoint: 'https://gw.example/pft/register', scopes_supported: ['openid'], code_challenge_methods_supported: ['S256'] };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const SECRET_TOKEN = jwt({ iss: 'https://gw.example/pft', aud: GW, sub: 'sam', exp: 9999999999 });

function net(over = {}) {
  const seen = [];
  const routes = {
    [GW]: (init) => (init.headers.authorization
      ? json(200, { result: { tools: [{ name: 'read_invoice' }] } }, { 'mcp-session-id': 's1' })
      : json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/pft/mcp"' })),
    'https://gw.example/.well-known/oauth-protected-resource/pft/mcp': () => json(200, { authorization_servers: ['https://gw.example/pft'] }),
    'https://gw.example/.well-known/oauth-authorization-server/pft': () => json(200, AS),
    'https://gw.example/pft/register': () => json(201, { client_id: 'muse-123' }),
    'https://gw.example/pft/token': () => json(200, { access_token: SECRET_TOKEN, token_type: 'Bearer' }),
    ...over,
  };
  const f = async (url, init) => { seen.push({ url: String(url), init }); const r = routes[String(url)]; if (!r) throw new Error(`unexpected ${url}`); return r(init); };
  return { f, seen };
}

async function boot(fetchImpl) {
  const server = createApp(ENV, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json: j, text };
  };
  const live = async () => { await call('POST', '/api/gateway-mode', { mode: 'live' }); await call('POST', '/api/discover'); };
  return { call, live, base, close: () => new Promise((r) => server.close(r)) };
}

test('live flow: register, sign in with PKCE, token back without the cookie, call the gateway; token never reaches the page', async () => {
  const n = net();
  const a = await boot(n.f);
  await a.live();
  assert.equal((await a.call('POST', '/api/live/signin')).status, 409, 'cannot sign in before registering');
  const reg = await a.call('POST', '/api/live/register');
  assert.equal(reg.json.registered, true);
  const body = JSON.parse(n.seen.find((s) => s.url.endsWith('/register')).init.body);
  assert.deepEqual(body.redirect_uris, [`${a.base}/api/callback`]);
  assert.equal(body.token_endpoint_auth_method, 'none');

  const si = await a.call('POST', '/api/live/signin');
  const u = new URL(si.json.url);
  assert.equal(u.origin + u.pathname, AS.authorization_endpoint);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('resource'), GW);
  assert.equal(u.searchParams.get('client_id'), 'muse-123');
  const state = u.searchParams.get('state');

  // The identity provider's redirect is cross-site, so it arrives with no cookie.
  const cb = await fetch(`${a.base}/api/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 200);
  const tokenReq = n.seen.find((s) => s.url.endsWith('/token')).init.body;
  assert.match(tokenReq, /code_verifier=/);
  assert.match(tokenReq, /code=abc/);

  const again = await fetch(`${a.base}/api/callback?code=abc&state=${state}`);
  assert.equal(again.status, 400, 'state is single use');

  const sess = await a.call('GET', '/api/session');
  assert.equal(sess.json.liveAuth.signedIn, true);
  assert.equal(sess.json.liveAuth.claims.aud, GW);
  assert.ok(!sess.text.includes(SECRET_TOKEN), 'the token is not in the session');

  assert.equal((await a.call('POST', '/api/live/call')).status, 200);
  const after = await a.call('GET', '/api/session');
  assert.deepEqual(after.json.liveAuth.steps.map((s) => s.n), [4, 5, 6, 7, 8]);
  assert.ok(!after.text.includes(SECRET_TOKEN));
  const authed = n.seen.filter((s) => s.init.headers.authorization);
  assert.equal(authed.length, 2);
  assert.equal(authed[0].init.headers.authorization, `Bearer ${SECRET_TOKEN}`);
  assert.equal(authed[1].init.headers['mcp-session-id'], 's1');

  await a.call('POST', '/api/signout');
  assert.equal((await a.call('GET', '/api/session')).json.liveAuth.signedIn, false);
  await a.close();
});

test('live flow: a bad state is refused and nothing is exchanged', async () => {
  const n = net();
  const a = await boot(n.f);
  await a.live();
  const before = n.seen.length;
  assert.equal((await fetch(`${a.base}/api/callback?code=x&state=forged`)).status, 400);
  assert.equal(n.seen.length, before);
  await a.close();
});

test('live flow: a refused registration, a refusal at sign-in and a wrong audience are each reported', async () => {
  const a = await boot(net({ 'https://gw.example/pft/register': () => json(400, { error: 'invalid_redirect_uri' }) }).f);
  await a.live();
  const reg = await a.call('POST', '/api/live/register');
  assert.equal(reg.json.registered, false);
  assert.match(reg.json.error, /refused \(400\)/);
  await a.close();

  const b = await boot(net({ 'https://gw.example/pft/token': () => json(200, { access_token: jwt({ aud: 'https://other.example', sub: 's' }) }) }).f);
  await b.live(); await b.call('POST', '/api/live/register');
  const state = new URL((await b.call('POST', '/api/live/signin')).json.url).searchParams.get('state');
  await fetch(`${b.base}/api/callback?code=c&state=${state}`);
  const steps = (await b.call('GET', '/api/session')).json.liveAuth.steps;
  assert.match(steps.find((s) => s.n === 6).note, /not the gateway/);
  await b.close();

  const c = await boot(net().f);
  await c.live(); await c.call('POST', '/api/live/register');
  const st = new URL((await c.call('POST', '/api/live/signin')).json.url).searchParams.get('state');
  await fetch(`${c.base}/api/callback?error=access_denied&state=${st}`);
  const s = (await c.call('GET', '/api/session')).json.liveAuth;
  assert.match(s.error, /access_denied/);
  assert.equal(s.signedIn, false);
  await c.close();
});

test('live steps are refused in mock mode and before discovery; mock mode makes no outbound calls', async () => {
  const n = net();
  const a = await boot(n.f);
  assert.equal((await a.call('POST', '/api/live/register')).status, 409);
  await a.call('POST', '/api/gateway-mode', { mode: 'live' });
  assert.equal((await a.call('POST', '/api/live/register')).status, 409, 'discovery not run');
  assert.equal(n.seen.length, 0);
  await a.close();
});
