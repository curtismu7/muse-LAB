import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { liveConfig, liveDiscovery, mockDiscovery } from '../src/discovery.js';

const GW = 'https://gw.example/pft/mcp';
const LIVE_ENV = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW };
const AS = { issuer: 'https://gw.example/pft', authorization_endpoint: 'https://gw.example/pft/authorize', token_endpoint: 'https://gw.example/pft/token', registration_endpoint: 'https://gw.example/pft/register', scopes_supported: ['openid'], code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A fake network: every request is recorded, so a test can prove which URLs were (not) contacted.
function fakeNet(routes) {
  const seen = [];
  const f = async (url, init) => { seen.push({ url: String(url), init }); const r = routes[String(url)]; if (!r) throw new Error(`unexpected ${url}`); return r(); };
  return { f, seen };
}
const happy = () => ({
  [GW]: () => json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="x", resource_metadata="http://gw.example/.well-known/oauth-protected-resource/pft/mcp"' }),
  'https://gw.example/.well-known/oauth-protected-resource/pft/mcp': () => json(200, { resource: GW, authorization_servers: ['https://gw.example/pft'] }),
  'https://gw.example/.well-known/oauth-authorization-server/pft': () => json(200, AS),
});

test('mock discovery is static, uses only .example hosts and learns the sign-in endpoints', () => {
  const d = mockDiscovery();
  assert.equal(d.live, false);
  assert.equal(d.steps[0].response.status, 401);
  assert.match(d.steps[0].response.headers['www-authenticate'], /resource_metadata=/);
  assert.equal(d.learned.pkce, true);
  assert.ok(!/https?:\/\/(?![a-z.]*\.example)/.test(JSON.stringify(d)));
});

test('live mode needs ALLOW_LIVE, a gateway URL, https, and is never available when hosted', () => {
  assert.equal(liveConfig({}), null);
  assert.equal(liveConfig({ ALLOW_LIVE: '1' }), null);
  assert.equal(liveConfig({ MUSE_LIVE_GATEWAY_URL: GW }), null);
  assert.equal(liveConfig({ ...LIVE_ENV, MUSE_HOSTED: '1' }), null);
  assert.equal(liveConfig({ ...LIVE_ENV, MUSE_LIVE_GATEWAY_URL: 'http://gw.example/mcp' }), null);
  assert.equal(liveConfig({ ...LIVE_ENV, MUSE_LIVE_GATEWAY_URL: 'nonsense' }), null);
  assert.equal(liveConfig(LIVE_ENV).origin, 'https://gw.example');
});

test('live discovery: 401, resource metadata, authorization-server metadata; http advert upgraded on the same host', async () => {
  const net = fakeNet(happy());
  const d = await liveDiscovery(liveConfig(LIVE_ENV), net.f);
  assert.equal(d.stopped, null);
  assert.equal(d.steps.length, 3);
  assert.equal(d.learned.registrationEndpoint, AS.registration_endpoint);
  assert.match(d.steps[1].note, /advertised .* \(http\)/);
  assert.deepEqual(net.seen.map((s) => s.url), Object.keys(happy()));
  for (const s of net.seen) assert.equal(s.init.redirect, 'manual');
  assert.equal(net.seen[0].init.method, 'POST');
  assert.equal(net.seen[0].init.headers.authorization, undefined, 'the first call carries no token');
});

test('live discovery stops, and says why, when the gateway does not answer 401 with metadata', async () => {
  const ok = await liveDiscovery(liveConfig(LIVE_ENV), fakeNet({ [GW]: () => json(200, {}) }).f);
  assert.match(ok.stopped, /Expected a 401/);
  const bare = await liveDiscovery(liveConfig(LIVE_ENV), fakeNet({ [GW]: () => json(401, {}, { 'www-authenticate': 'Bearer' }) }).f);
  assert.match(bare.stopped, /no resource_metadata/);
});

test('an authorization server on another origin is reported, not contacted', async () => {
  const r = happy();
  r['https://gw.example/.well-known/oauth-protected-resource/pft/mcp'] = () => json(200, { authorization_servers: ['https://other.example'] });
  const net = fakeNet(r);
  const d = await liveDiscovery(liveConfig(LIVE_ENV), net.f);
  assert.match(d.stopped, /another origin/);
  assert.ok(d.steps[2].skipped);
  assert.ok(!net.seen.some((s) => s.url.includes('other.example')));
});

test('a metadata URL on another origin is not contacted either', async () => {
  const r = happy();
  r[GW] = () => json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://evil.example/prm"' });
  const net = fakeNet(r);
  const d = await liveDiscovery(liveConfig(LIVE_ENV), net.f);
  assert.match(d.stopped, /not allowed/);
  assert.equal(net.seen.length, 1);
});

async function boot(env, fetchImpl) {
  const server = createApp(env, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('API: mock discovery works with no network; live is refused when not enabled and when hosted', async () => {
  const net = fakeNet({});
  for (const env of [{}, { ...LIVE_ENV, MUSE_HOSTED: '1', MUSE_ALLOWED_HOSTS: '127.0.0.1' }]) {
    const a = await boot(env, net.f);
    assert.equal((await a.call('GET', '/api/session')).json.live.available, false);
    assert.equal((await a.call('POST', '/api/gateway-mode', { mode: 'live' })).status, 403);
    const d = await a.call('POST', '/api/discover');
    assert.equal(d.status, 200);
    assert.equal(d.json.live, false);
    await a.close();
  }
  assert.equal(net.seen.length, 0, 'zero outbound calls without live mode');
});

test('API: live mode discovers through the injected network, and live sign-in is refused until it is built', async () => {
  const net = fakeNet(happy());
  const a = await boot(LIVE_ENV, net.f);
  assert.deepEqual((await a.call('GET', '/api/session')).json.live, { available: true, origin: 'https://gw.example', viaPingOne: false, lane: null, userLogin: false });
  assert.equal((await a.call('GET', '/api/session')).json.mode, 'live', 'a new visitor starts in Real when it is configured');
  assert.equal((await a.call('POST', '/api/gateway-mode', { mode: 'nope' })).status, 400);
  assert.equal((await a.call('POST', '/api/gateway-mode', { mode: 'live' })).status, 200);
  const d = await a.call('POST', '/api/discover');
  assert.equal(d.json.live, true);
  assert.equal(d.json.steps.length, 3);
  assert.equal((await a.call('POST', '/api/signin', {})).status, 409);
  await a.call('POST', '/api/reset');
  assert.equal((await a.call('GET', '/api/session')).json.mode, 'live', 'Real is the default whenever live is configured');
  assert.equal((await a.call('POST', '/api/gateway-mode', { mode: 'mock' })).status, 200, 'Mock stays one click away');
  assert.equal((await a.call('GET', '/api/session')).json.mode, 'mock');
  await a.close();
});

test('API: a network failure becomes a short 502, not a stack trace', async () => {
  const a = await boot(LIVE_ENV, async () => { throw new Error('/secret/path ECONNREFUSED'); });
  await a.call('POST', '/api/gateway-mode', { mode: 'live' });
  const d = await a.call('POST', '/api/discover');
  assert.equal(d.status, 502);
  assert.ok(!JSON.stringify(d.json).includes('secret'));
  await a.close();
});
