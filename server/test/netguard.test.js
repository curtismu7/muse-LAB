import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { createNetguard } from '../src/netguard.js';

test('netguard self-test: a non-loopback call is refused, loopback passes', async () => {
  const g = createNetguard({ mode: 'mock' });
  const r = await g.selfTest();
  assert.deepEqual(r, { ok: true, refused: true, loopbackPassed: true });
  assert.equal(g.stats().attempts, 0, 'the self-test uses its own throwaway guard, so the real counters stay clean');
});

test('mock mode refuses and counts every non-loopback outbound call, loopback goes through', async () => {
  const g = createNetguard({ mode: 'mock' });
  let reached = 0;
  const f = g.wrap(async () => { reached += 1; return { ok: true }; });
  await assert.rejects(f('https://example.com/x'), /netguard: outbound call to https:\/\/example\.com refused/);
  await assert.rejects(f(new URL('https://auth.example.net/token')), /refused/);
  await assert.rejects(f('not a url'), /refused/);
  await f('http://127.0.0.1:5100/api/health');
  await f('http://localhost:5100/');
  await f('http://[::1]:5100/');
  assert.equal(reached, 3, 'only the loopback calls got through');
  assert.deepEqual({ attempts: g.stats().attempts, blocked: g.stats().blocked }, { attempts: 3, blocked: 3 });
});

test('live mode lets calls through and counts the origins they go to', async () => {
  const g = createNetguard({ mode: 'live' });
  let reached = 0;
  const f = g.wrap(async () => { reached += 1; return { ok: true }; });
  await f('https://idp.example/token'); await f('https://idp.example/authorize'); await f('https://gw.example/mcp'); await f('http://127.0.0.1:1/');
  assert.equal(reached, 4);
  const s = g.stats();
  assert.equal(s.blocked, 0);
  assert.equal(s.attempts, 3, 'loopback is not an outbound call');
  assert.deepEqual(s.origins.sort(), ['https://gw.example', 'https://idp.example']);
});

test('a bad mode is refused', () => assert.throws(() => createNetguard({ mode: 'both' }), /mock" or "live/));

test('the mock app makes zero outbound attempts across its routes, and says so', async () => {
  let called = 0;
  const server = createApp({}, { fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) }; } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    for (const p of ['/api/health', '/api/session', '/api/story', '/api/story?vertical=bank', '/api/netguard']) assert.equal((await call('GET', p)).status, 200, p);
    assert.equal((await call('POST', '/api/request', {})).status, 401);
    const ng = (await call('GET', '/api/netguard')).json;
    assert.deepEqual(ng, { mode: 'mock', attempts: 0, blocked: 0, selfTest: true });
    assert.equal(called, 0, 'nothing reached the network');
    assert.equal((await call('GET', '/api/session')).json.netguard, undefined, 'the session does not carry guard data');
  } finally { await new Promise((r) => server.close(r)); }
});
