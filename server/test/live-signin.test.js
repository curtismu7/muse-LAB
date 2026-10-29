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

test('PingOne mode: no registration, redirect to PingOne with prompt=login and no resource, token swapped at PingOne', async () => {
  const P1 = 'https://auth.pingone.com/env1/as';
  const n = net({
    [`${P1}/token`]: () => json(200, { access_token: jwt({ iss: 'https://auth.pingone.com/env1', aud: 'client1', sub: 'FF1' }) }),
  });
  const server = createApp({ ...ENV, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1' }, { fetchImpl: n.f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  await call('POST', '/api/gateway-mode', { mode: 'live' }); await call('POST', '/api/discover');
  assert.equal((await call('POST', '/api/live/register')).j.registered, true);
  assert.ok(!n.seen.some((s) => s.url.endsWith('/register')), 'nothing registered at the gateway');
  const u = new URL((await call('POST', '/api/live/signin')).j.url);
  assert.equal(u.origin + u.pathname, `${P1}/authorize`);
  assert.equal(u.searchParams.get('prompt'), 'login');
  assert.equal(u.searchParams.get('login_hint'), 'demouser', 'the sign-in page is pre-filled with the user name');
  assert.equal(u.searchParams.get('client_id'), 'client1');
  assert.equal(u.searchParams.has('resource'), false);
  await fetch(`${base}/api/callback?code=c&state=${u.searchParams.get('state')}`);
  const tokenCall = n.seen.find((s) => s.url === `${P1}/token`);
  assert.ok(tokenCall && !/resource=/.test(tokenCall.init.body));
  assert.equal((await call('GET', '/api/session')).j.liveAuth.signedIn, true);
  await new Promise((r) => server.close(r));
});

test('acting for the user: sign-in, agent token, two exchanges, then Agent Gateway tools/call with the delegated token', async () => {
  const P1 = 'https://auth.pingone.com/env1/as';
  const bodies = [];
  const act = { sub: 'client1' };
  const n = net({
    [GW]: (init) => {
      if (!init.headers.authorization) return json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/pft/mcp"' });
      const m = JSON.parse(init.body).method;
      if (m === 'tools/call') return json(200, { result: { content: [{ type: 'text', text: '{"points":4500}' }] } });
      return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
    },
    [`${P1}/token`]: (init) => {
      const f = new URLSearchParams(init.body); bodies.push(Object.fromEntries(f));
      const g = f.get('grant_type');
      if (g === 'authorization_code') return json(200, { access_token: jwt({ aud: GW, sub: 'sam' }) });
      if (g === 'client_credentials') return json(200, { access_token: jwt({ aud: 'workload', sub: 'client1' }) });
      return json(200, { access_token: jwt({ aud: f.get('actor_token') ? 'workload' : GW, sub: 'sam', act, protect_agent: 'HIGH' }) });
    },
  });
  const server = createApp({ ...ENV, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1', MUSE_P1_CLIENT_SECRET: 'sekret' }, { fetchImpl: n.f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; const t = await r.text(); return { s: r.status, t, j: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
  await call('POST', '/api/gateway-mode', { mode: 'live' }); await call('POST', '/api/discover'); await call('POST', '/api/live/register');
  const u = new URL((await call('POST', '/api/live/signin')).j.url);
  assert.equal(u.searchParams.get('resource'), GW);
  assert.equal(u.searchParams.get('scope'), 'openid gateway:mcp:invoke');
  await fetch(`${base}/api/callback?code=c&state=${u.searchParams.get('state')}`);
  assert.deepEqual(bodies.map((b) => b.grant_type), ['authorization_code', 'client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:token-exchange']);
  assert.ok(bodies.every((b) => b.client_secret === 'sekret'));
  assert.equal(bodies[2].actor_token_type, 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(bodies[3].actor_token, undefined, 'exchange 2 carries act on from the first token');
  const s = await call('GET', '/api/session');
  assert.deepEqual(s.j.liveAuth.claims.act, act);
  assert.equal(s.j.liveAuth.claims.protect_agent, 'HIGH', 'the page can tell a Protect verdict from a client id match');
  assert.ok(!s.t.includes('sekret'));
  await call('POST', '/api/live/call');
  const authed = n.seen.filter((x) => x.url === GW && x.init.headers.authorization);
  assert.equal(authed.length, 3);
  assert.equal(authed[0].init.headers['x-token-validation'], 'jwks');
  assert.equal(authed[0].init.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(JSON.parse(authed[2].init.body).params.name, 'loyalty_balance');
  const steps = (await call('GET', '/api/session')).j.liveAuth.steps.map((x) => x.n);
  assert.deepEqual(steps, [4, 5, 6, 6.1, 6.2, 6.3, 7, 8, 9]);
  await new Promise((r) => server.close(r));
});

test('Privilege lane: sign-in asks for openid only, no resource; exchange 2 asks for the Privilege scope', async () => {
  const P1 = 'https://auth.pingone.com/env1/as';
  const bodies = [];
  const n = net({
    [`${P1}/token`]: (init) => { const f = new URLSearchParams(init.body); bodies.push(Object.fromEntries(f)); return json(200, { access_token: jwt({ aud: 'x', sub: 'sam', act: { sub: 'client1' } }) }); },
  });
  const server = createApp({ ...ENV, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1', MUSE_P1_CLIENT_SECRET: 's', MUSE_P1_LANE: 'privilege' }, { fetchImpl: n.f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { j: await r.json().catch(() => null) }; };
  assert.equal((await call('GET', '/api/session')).j.live.lane, 'privilege');
  await call('POST', '/api/discover'); await call('POST', '/api/live/register');
  const u = new URL((await call('POST', '/api/live/signin')).j.url);
  assert.equal(u.searchParams.get('scope'), 'openid');
  assert.equal(u.searchParams.has('resource'), false);
  await fetch(`${base}/api/callback?code=c&state=${u.searchParams.get('state')}`);
  assert.equal(bodies.at(-1).scope, 'mcp:invoke', 'exchange 2 targets the Muse Privilege resource');
  await new Promise((r) => server.close(r));
});

test('the user asks first: 401 from the gateway, then PingOne, then Muse retries and answers on return', async () => {
  const P1 = 'https://auth.pingone.com/env1/as';
  const n = net({
    [GW]: (init) => {
      if (!init.headers.authorization) return json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/pft/mcp"' });
      const m = JSON.parse(init.body).method;
      if (m === 'tools/call') return json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { points: 4500, tier: 'Gold' } }) }] } });
      return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
    },
    [`${P1}/token`]: () => json(200, { access_token: jwt({ aud: GW, sub: 'sam', act: { sub: 'client1' } }) }),
  });
  const server = createApp({ ...ENV, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1', MUSE_P1_CLIENT_SECRET: 's' }, { fetchImpl: n.f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  assert.equal((await call('POST', '/api/live/ask', { prompt: 'book me a flight to Rome' })).s, 400, 'only points are answered in Real mode so far');
  const first = await call('POST', '/api/live/ask', { prompt: 'Show my airline points' });
  assert.equal(first.j.state, 'auth_required');
  const before = (await call('GET', '/api/session')).j;
  assert.equal(before.discovery.steps[0].response.status, 401, 'the 401 is shown first');
  assert.equal(before.liveAuth.ask.prompt, 'Show my airline points');
  assert.equal(before.liveAuth.answer, null, 'no answer before sign-in');
  assert.equal(n.seen.filter((x) => x.init.headers.authorization).length, 0, 'nothing authenticated was sent yet');
  await call('POST', '/api/live/register');
  const u = new URL((await call('POST', '/api/live/signin')).j.url);
  await fetch(`${base}/api/callback?code=c&state=${u.searchParams.get('state')}`);
  const after = (await call('GET', '/api/session')).j;
  assert.deepEqual([after.liveAuth.answer.points, after.liveAuth.answer.tier, after.liveAuth.answer.reply], [4500, 'Gold', 'You have 4,500 points (Gold).'], 'Muse finished the request after the redirect');
  assert.ok(after.liveAuth.steps.some((x) => x.n === 9));
  await new Promise((r) => server.close(r));
});

test('the PingOne MFA switch: off adds the .nomfa flag to the login hint, on leaves it alone', async () => {
  const n = net();
  const server = createApp({ ...ENV, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1' }, { fetchImpl: n.f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { j: await r.json().catch(() => null) }; };
  await call('POST', '/api/discover'); await call('POST', '/api/live/register');
  const on = new URL((await call('POST', '/api/live/signin', { mfa: 'on' })).j.url);
  const off = new URL((await call('POST', '/api/live/signin', { mfa: 'off' })).j.url);
  assert.equal(on.searchParams.get('login_hint'), 'demouser');
  assert.equal(off.searchParams.get('login_hint'), 'demouser.nomfa');
  await new Promise((r) => server.close(r));
});

test('just a user: separate PingOne app, no exchange, own token to the gateway is refused', async () => {
  const P1 = 'https://auth.pingone.com/env1/as';
  const UID = '00000000-0000-0000-0000-0000000000a1';
  const bodies = [];
  const n = net({
    [GW]: (init) => (init.headers.authorization ? json(401, { error: 'invalid_token' }) : json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/pft/mcp"' })),
    [`${P1}/token`]: (init) => { bodies.push(Object.fromEntries(new URLSearchParams(init.body))); return json(200, { access_token: jwt({ iss: 'https://auth.pingone.com/env1', aud: UID, sub: 'FF1' }) }); },
  });
  const server = createApp({ ...ENV, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1', MUSE_P1_CLIENT_SECRET: 'sekret', MUSE_USER_CLIENT_ID: UID }, { fetchImpl: n.f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  await call('POST', '/api/gateway-mode', { mode: 'live' }); await call('POST', '/api/discover');
  assert.equal((await call('GET', '/api/session')).j.live.userLogin, true);
  const su = await call('POST', '/api/live/signin', { as: 'user', mfa: 'off' });
  assert.ok(su.j?.url, JSON.stringify(su));
  const u = new URL(su.j.url);
  assert.equal(u.searchParams.get('client_id'), UID, 'a different app from Muse, so the flow skips the agent screen and consent');
  assert.equal(u.searchParams.get('login_hint'), 'demouser.nomfa');
  assert.equal(u.searchParams.has('resource'), false);
  await fetch(`${base}/api/callback?code=c&state=${u.searchParams.get('state')}`);
  assert.deepEqual(bodies.map((b) => b.grant_type), ['authorization_code'], 'no agent token, no exchange');
  assert.equal(bodies[0].client_secret, undefined, 'public client');
  const s = (await call('GET', '/api/session')).j;
  assert.equal(s.userLogin.denied, true);
  assert.equal(s.userLogin.claims.act, undefined);
  assert.equal(s.liveAuth.signedIn, false, 'the agent sign-in is untouched');
  await new Promise((r) => server.close(r));
});
