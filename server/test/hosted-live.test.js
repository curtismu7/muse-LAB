import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { liveConfig } from '../src/discovery.js';

const GW = 'https://gw.example/muse-ig/mcp';
const BASE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_HOSTED: '1', MUSE_ALLOWED_HOSTS: '127.0.0.1' };
const P1 = { MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1' };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('a hosted build stays mock-only unless real mode is turned on on purpose, with an https public address', () => {
  assert.equal(liveConfig(BASE), null, 'hosted alone refuses real mode');
  assert.equal(liveConfig({ ...BASE, MUSE_ALLOW_LIVE_HOSTED: '1' }), null, 'no public address');
  assert.equal(liveConfig({ ...BASE, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'http://muse.example' }), null, 'http public address');
  assert.equal(liveConfig({ ...BASE, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'nonsense' }), null);
  const ok = liveConfig({ ...BASE, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example/ignored/path' });
  assert.equal(ok.publicUrl, 'https://muse.example', 'only the origin is kept');
  assert.equal(liveConfig({ ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example' }).publicUrl, null, 'a local run ignores the public address');
});

test('MODE=mock is mock-only even with every real-mode setting present', async () => {
  const full = { ...BASE, ...P1, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example', MUSE_P1_CLIENT_SECRET: 's', MUSE_CONNECTOR: '1' };
  assert.ok(liveConfig(full), 'the same settings without MODE give real mode');
  assert.equal(liveConfig({ ...full, MODE: 'mock' }), null);
  const a = await boot({ ...full, MODE: 'mock' }, async () => { throw new Error('no network in the mock-only build'); });
  try {
    const s = (await a.call('GET', '/api/session')).j;
    assert.equal(s.live.available, false);
    assert.equal((await a.call('POST', '/api/gateway-mode', { mode: 'live' })).s, 403);
  } finally { await a.close(); }
});

async function boot(env, fetchImpl) {
  const server = createApp(env, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  return { call, close: () => new Promise((r) => server.close(r)) };
}
const net = () => async (url) => {
  if (String(url) === GW) return json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/muse-ig/mcp"' });
  if (String(url).includes('oauth-protected-resource')) return json(200, { authorization_servers: ['https://gw.example/muse-ig'] });
  return json(200, { issuer: 'https://gw.example/muse-ig', authorization_endpoint: 'https://gw.example/muse-ig/authorize', token_endpoint: 'https://gw.example/muse-ig/token', code_challenge_methods_supported: ['S256'] });
};

test('hosted real mode returns to the public https address, not the host the request names', async () => {
  const a = await boot({ ...BASE, ...P1, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example', MUSE_P1_CLIENT_SECRET: 's' }, net());
  await a.call('POST', '/api/discover'); await a.call('POST', '/api/live/register');
  const u = new URL((await a.call('POST', '/api/live/signin')).j.url);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://muse.example/api/callback');
  await a.close();
});

test('starting real flows is limited per visitor', async () => {
  const a = await boot({ ...BASE, ...P1, MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example', MUSE_P1_CLIENT_SECRET: 's', MUSE_LIVE_PER_VISITOR_PER_MIN: '3' }, net());
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await a.call('POST', '/api/live/ask', { prompt: 'show my points' })).s);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  await a.close();
});
