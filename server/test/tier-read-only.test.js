import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { READ_ONLY_MESSAGE, createTierSwitch } from '../src/tier.js';

// MUSE_TIER_ENABLE=read: the mode for a PUBLIC hosted URL. Everything here is invented (ids, secrets, hosts) and the "PingOne" is a stub fetch that
// counts every call. Nothing real is contacted.
const ENV_ID = '00000000-1111-4111-8111-111111111111';
const CLIENT_ID = '00000000-2222-4222-8222-222222222222';
const USER_1 = '00000000-3333-4333-8333-333333333333';
const USER_2 = '00000000-4444-4444-8444-444444444444';
const SECRET = 'tier-read-secret-ZZtop-9d41c7';
const TOKEN = 'tier-read-token-QQ77-aa90be';
const GW = 'https://gw.example/muse-ig/mcp';
const BASE_ENV = { MUSE_TIER_WORKER_CLIENT_ID: CLIENT_ID, MUSE_TIER_WORKER_CLIENT_SECRET: SECRET, MUSE_TIER_USER_IDS: `${USER_1},${USER_2}`, MUSE_TIER_ENV_ID: ENV_ID };
const LIVE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function pingOneStub() {
  const store = new Map([[USER_1, { airlineMemberTier: 'Premier Gold', agentSpendLimit: '750' }], [USER_2, { airlineMemberTier: 'Premier Gold', agentSpendLimit: '750' }]]);
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', url: url.href, body: init.body };
    calls.push(call);
    if (url.pathname === `/${ENV_ID}/as/token`) return json(200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 });
    const m = /^\/v1\/environments\/([^/]+)\/users\/([^/]+)$/.exec(url.pathname);
    if (!m || !store.has(m[2])) return json(404, { code: 'NOT_FOUND' });
    if (call.method === 'PATCH') { Object.assign(store.get(m[2]), JSON.parse(init.body)); return json(200, store.get(m[2])); }
    return json(200, { id: m[2], ...store.get(m[2]) });
  };
  return { fn, calls, store, patches: () => calls.filter((c) => c.method === 'PATCH'), nonRead: () => calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/as/token')) };
}

async function boot(env, fetchImpl) {
  const server = createApp(env, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
    const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0];
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { s: r.status, j, text };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const sw = (flag, stub) => createTierSwitch({ env: { ...BASE_ENV, ...(flag === undefined ? {} : { MUSE_TIER_ENABLE: flag }) }, live: {}, fetchImpl: stub.fn });

test('read mode: every write on the switch is refused with the plain message and zero PingOne calls', async () => {
  const stub = pingOneStub();
  const t = sw('read', stub);
  assert.equal(t.configured, true);
  assert.equal(t.readOnly, true);
  for (const change of [{ tier: 'Premier Silver' }, { limit: '250' }, { tier: null, limit: '250' }, { tier: 'Premier Gold', limit: null }, {}]) {
    const r = await t.apply(change);
    assert.equal(r.ok, false);
    assert.equal(r.error, READ_ONLY_MESSAGE);
    assert.equal(r.readOnly, true);
  }
  for (const v of ['Premier Silver', 'Premier Gold', null]) assert.equal((await t.switchTo(v)).error, READ_ONLY_MESSAGE);
  assert.equal(stub.calls.length, 0, 'no PingOne call at all, not even a token request');
  assert.equal(t.view().tierMode, 'read');
  assert.equal(t.view().readOnly, true);
  assert.equal(t.view().readOnlyMessage, READ_ONLY_MESSAGE);
});

test('read mode: reads still work (read() and readUserFacts), with the allow-list, and never write', async () => {
  const stub = pingOneStub();
  const t = sw('read', stub);
  assert.deepEqual(await t.readUserFacts(USER_1), { tier: 'Premier Gold', limit: 750 });
  assert.deepEqual(await t.readUserFacts(USER_1.toUpperCase()), { tier: 'Premier Gold', limit: 750 });
  assert.deepEqual(await t.readUserFacts('00000000-5555-4555-8555-555555555555'), { tier: null, limit: null }, 'a stranger is not on the allow-list');
  const r = await t.read();
  assert.equal(r.ok, true);
  assert.deepEqual(r.users.map((u) => [u.known, u.value, u.limit]), [[true, 'Premier Gold', 750], [true, 'Premier Gold', 750]]);
  assert.equal(stub.nonRead().length, 0, 'only the token POST and GETs');
  assert.equal(stub.patches().length, 0);
  const text = JSON.stringify([r, t.view()]);
  assert.ok(!text.includes(SECRET) && !text.includes(TOKEN), 'neither the secret nor the token appears in anything the switch returns');
});

test('read mode keeps the read rate limit', async () => {
  const stub = pingOneStub();
  const t = sw('read', stub);
  let blanks = 0;
  for (let i = 0; i < 40; i += 1) if ((await t.readUserFacts(USER_1)).tier === null) blanks += 1;
  assert.ok(blanks >= 10, 'past the per-minute cap the facts are unknown, not read');
  assert.ok(stub.calls.filter((c) => c.method === 'GET').length <= 30);
});

test('only "1" writes, only "read" reads; unset, 0, true, READ and every other value are off and call nothing', async () => {
  const w = pingOneStub();
  const on = sw('1', w);
  assert.equal(on.readOnly, false);
  assert.equal((await on.apply({ limit: '250' })).ok, true);
  assert.equal(w.patches().length, 2, 'one PATCH per user');
  assert.equal(on.view().tierMode, 'write');
  for (const flag of [undefined, '', '0', 'true', 'READ', 'Read', ' read', 'read ', 'yes', 'on', '1 ', ' 1', 'write']) {
    const stub = pingOneStub();
    const t = sw(flag, stub);
    assert.equal(t.configured, false, JSON.stringify(flag));
    assert.equal(t.readOnly, false);
    assert.equal(t.view().tierMode, 'off');
    assert.equal((await t.apply({ limit: '250' })).ok, false);
    assert.equal((await t.read()).ok, false);
    assert.deepEqual(await t.readUserFacts(USER_1), { tier: null, limit: null });
    assert.equal(stub.calls.length, 0, JSON.stringify(flag));
  }
});

test('through the app (Real, read mode): GET says read-only, POST is refused with 403, the mock-only paths and PingOne reads are untouched, zero writes', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...BASE_ENV, MUSE_TIER_ENABLE: 'read', MUSE_HOSTED: '1', MUSE_ALLOWED_HOSTS: '127.0.0.1', MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example', MUSE_P1_ENV_ID: ENV_ID, MUSE_P1_CLIENT_ID: CLIENT_ID }, stub.fn);
  try {
    const g = await a.call('GET', '/api/booking/tier');
    assert.equal(g.s, 200);
    assert.deepEqual([g.j.mode, g.j.source, g.j.configured, g.j.readOnly, g.j.readOnlyMessage], ['read-only', 'real', true, true, READ_ONLY_MESSAGE]);
    for (const body of [{ limit: 250 }, { member: 'standard' }, { member: 'none', limit: 'default' }, { limit: 250, member: 'premium', extra: 1 }]) {
      const w = await a.call('POST', '/api/booking/tier', body);
      assert.deepEqual([w.s, w.j.error, w.j.message], [403, 'read_only', READ_ONLY_MESSAGE], JSON.stringify(body));
    }
    assert.equal(stub.calls.length, 0, 'the refusals made no PingOne call');
    const r = await a.call('POST', '/api/booking/tier/read');
    assert.equal(r.s, 200);
    assert.equal(r.j.ok, true);
    assert.equal(stub.patches().length, 0);
    assert.ok(!JSON.stringify([g, r]).includes(SECRET) && !JSON.stringify([g, r]).includes(TOKEN));
    // A malformed write is still a 400 (nothing to refuse), and still no PingOne call.
    const before = stub.calls.length;
    assert.equal((await a.call('POST', '/api/booking/tier', {})).s, 400);
    assert.equal(stub.calls.length, before);
  } finally { await a.close(); }
});

test('through the app (Real, write mode "1"): behaves as before, GET says real', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...BASE_ENV, MUSE_TIER_ENABLE: '1' }, stub.fn);
  try {
    const g = await a.call('GET', '/api/booking/tier');
    assert.deepEqual([g.j.mode, g.j.readOnly, g.j.tierMode], ['real', false, 'write']);
    const w = await a.call('POST', '/api/booking/tier', { limit: 250 });
    assert.deepEqual([w.s, w.j.ok], [200, true]);
    assert.equal(stub.patches().length, 2);
  } finally { await a.close(); }
});

test('through the app (Mock): the per-visitor Mock controls still work and call PingOne never', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...BASE_ENV, MUSE_TIER_ENABLE: 'read' }, stub.fn);
  try {
    const g = await a.call('GET', '/api/booking/tier');
    assert.equal(g.j.mode, 'mock');
    const w = await a.call('POST', '/api/booking/tier', { limit: 250 });
    assert.equal(w.s, 200);
    assert.equal(w.j.limit, 250);
    assert.equal(stub.calls.length, 0);
  } finally { await a.close(); }
});
