import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/index.js';
import { createNetguard } from '../src/netguard.js';
import { LIMIT_ATTRIBUTE, LIMIT_MAX, TIER_ENV, TIER_WRITABLE, createTierSwitch, parseLimit } from '../src/tier.js';

// Everything here is invented: ids, host names, secrets. The "PingOne" is a stub fetch. Nothing real is ever contacted.
const ENV_ID = '00000000-1111-4111-8111-111111111111';
const CLIENT_ID = '00000000-2222-4222-8222-222222222222';
const USER_1 = '00000000-3333-4333-8333-333333333333';
const USER_2 = '00000000-4444-4444-8444-444444444444';
const STRANGER = '00000000-5555-4555-8555-555555555555';
const SECRET = 'tier-test-secret-ZZtop-9d41c7';
const TOKEN = 'tier-test-token-QQ77-aa90be';
const AUTH = 'https://auth.pingone.com';
const API = 'https://api.pingone.com';
const GW = 'https://gw.example/muse-ig/mcp';
const TIER_ENV_VARS = { MUSE_TIER_ENABLE: '1', MUSE_TIER_WORKER_CLIENT_ID: CLIENT_ID, MUSE_TIER_WORKER_CLIENT_SECRET: SECRET, MUSE_TIER_USER_IDS: `${USER_1},${USER_2}`, MUSE_TIER_ENV_ID: ENV_ID };
const LIVE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const EXPECTED_BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`;

// A stand-in PingOne: a token endpoint, and a user store. `faults` lets a test break one thing.
// A user is a tier text (or null for none), or { tier, limit } where limit is the text PingOne holds in agentSpendLimit (or undefined for none).
function pingOneStub({ users = { [USER_1]: { tier: 'Premier Gold', limit: '500' }, [USER_2]: { tier: 'Premier Gold', limit: '500' } }, faults = {} } = {}) {
  const asRecord = (v) => { const o = v !== null && typeof v === 'object' ? v : { tier: v }; return { ...(o.tier ? { airlineMemberTier: o.tier } : {}), ...(o.limit !== undefined ? { agentSpendLimit: o.limit } : {}) }; };
  const store = new Map(Object.entries(users).map(([id, v]) => [id, asRecord(v)]));
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', url: url.href, origin: url.origin, headers: init.headers ?? {}, body: init.body, redirect: init.redirect, hasSignal: Boolean(init.signal) };
    calls.push(call);
    if (faults.throwAll) throw Object.assign(new Error(`connect failed to ${url.href}`), { name: 'TypeError' });
    if (url.pathname === `/${ENV_ID}/as/token`) {
      if (faults.token) return faults.token(call);
      if (call.headers.authorization !== EXPECTED_BASIC) return json(401, { error: 'invalid_client' });
      return json(200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 });
    }
    const m = /^\/v1\/environments\/([^/]+)\/users\/([^/]+)$/.exec(url.pathname);
    if (!m || m[1] !== ENV_ID) return json(404, { code: 'NOT_FOUND', message: 'no such thing' });
    if (call.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { code: 'ACCESS_FAILED', message: 'bad token' });
    const id = m[2];
    if (faults[`${call.method}:${id}`]) return faults[`${call.method}:${id}`](call);
    if (!store.has(id)) return json(404, { code: 'NOT_FOUND', message: `user ${id} not found` });
    if (call.method === 'PATCH') {
      const patch = JSON.parse(call.body);
      const u = store.get(id);
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete u[k]; else u[k] = v; }
      return json(200, { id, ...u });
    }
    return json(200, { id, ...store.get(id) });
  };
  return { fn, calls, store, held: (id) => store.get(id)?.airlineMemberTier ?? null, heldLimit: (id) => store.get(id)?.agentSpendLimit ?? null };
}

const tierFor = (stub, env = TIER_ENV_VARS, live = { origin: 'https://gw.example' }) => createTierSwitch({ env: { ...env }, live, fetchImpl: stub.fn });

// ---- Real switching against the stub -------------------------------------------------------------------------------------------------

test('switching writes both allow-listed users, verifies by reading them back, and sends exactly {airlineMemberTier: value}', async () => {
  const stub = pingOneStub();
  const sw = tierFor(stub);
  const r = await sw.switchTo('Premier Silver');
  assert.equal(r.ok, true);
  assert.deepEqual(r.intended, { tier: 'Premier Silver' });
  assert.deepEqual(r.users.map((u) => [u.label, u.written, u.known, u.value, u.verified]), [['Demo user 1', true, true, 'Premier Silver', true], ['Demo user 2', true, true, 'Premier Silver', true]]);
  assert.equal(stub.held(USER_1), 'Premier Silver');
  assert.equal(stub.held(USER_2), 'Premier Silver');
  const patches = stub.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2);
  for (const p of patches) assert.equal(p.body, JSON.stringify({ airlineMemberTier: 'Premier Silver' }), 'the body is exactly the one attribute');
  assert.deepEqual(patches.map((p) => new URL(p.url).pathname), [`/v1/environments/${ENV_ID}/users/${USER_1}`, `/v1/environments/${ENV_ID}/users/${USER_2}`]);
  // read-back happens after each write
  const order = stub.calls.filter((c) => c.method !== 'POST').map((c) => `${c.method}:${new URL(c.url).pathname.split('/').pop()}`);
  assert.deepEqual(order, [`PATCH:${USER_1}`, `GET:${USER_1}`, `PATCH:${USER_2}`, `GET:${USER_2}`]);
  assert.match(r.summary, /PingOne now holds Premier Silver on all 2 demo users \(read back\)/);
  assert.match(r.summary, /Run the booking again/);
});

test('Gold, Silver, Gold round trip; clear removes the attribute (null) and the read-back says no tier set', async () => {
  const stub = pingOneStub({ users: { [USER_1]: 'Premier Silver', [USER_2]: 'Premier Silver' } });
  const sw = tierFor(stub);
  assert.equal((await sw.switchTo('Premier Gold')).ok, true);
  assert.equal(stub.held(USER_1), 'Premier Gold');
  assert.equal((await sw.switchTo('Premier Silver')).ok, true);
  assert.equal(stub.held(USER_2), 'Premier Silver');
  const c = await sw.switchTo(null);
  assert.equal(c.ok, true);
  assert.equal(stub.held(USER_1), null);
  assert.deepEqual(c.users.map((u) => [u.known, u.value]), [[true, null], [true, null]]);
  assert.match(c.summary, /PingOne now has no tier set on all 2 demo users \(read back\)/);
  const clearPatch = stub.calls.filter((x) => x.method === 'PATCH').at(-1);
  assert.equal(clearPatch.body, '{"airlineMemberTier":null}');
});

test('the token request uses Basic auth, a form body of exactly grant_type=client_credentials, and never puts the secret in the body or a URL', async () => {
  const stub = pingOneStub();
  await tierFor(stub).switchTo('Premier Gold');
  const tok = stub.calls.filter((c) => c.method === 'POST');
  assert.equal(tok.length, 1);
  assert.equal(tok[0].url, `${AUTH}/${ENV_ID}/as/token`);
  assert.equal(tok[0].headers.authorization, EXPECTED_BASIC);
  assert.equal(tok[0].body, 'grant_type=client_credentials');
  for (const c of stub.calls) {
    assert.ok(!c.url.includes(SECRET) && !String(c.body ?? '').includes(SECRET), 'the secret is only in the Basic header');
    assert.ok(!c.url.includes(TOKEN), 'the token is only in the Authorization header');
    assert.equal(c.redirect, 'manual');
    assert.ok(c.hasSignal, 'every request has a timeout');
  }
  assert.ok(stub.calls.filter((c) => c.method !== 'POST').every((c) => c.headers.authorization === `Bearer ${TOKEN}`));
});

test('the only hosts contacted are auth.pingone.<region> and api.pingone.<region>, and the region follows the settings', async () => {
  const stub = pingOneStub();
  await tierFor(stub).switchTo('Premier Gold');
  assert.deepEqual([...new Set(stub.calls.map((c) => c.origin))].sort(), [API, AUTH]);
  const eu = pingOneStub();
  const sw = createTierSwitch({ env: { ...TIER_ENV_VARS, MUSE_TIER_REGION: 'eu' }, live: {}, fetchImpl: eu.fn });
  await sw.switchTo('Premier Gold').catch(() => {});
  assert.deepEqual([...new Set(eu.calls.map((c) => c.origin))].sort(), ['https://api.pingone.eu', 'https://auth.pingone.eu']);
  const bad = createTierSwitch({ env: { ...TIER_ENV_VARS, MUSE_TIER_REGION: 'evil.example/x' }, live: {}, fetchImpl: eu.fn });
  assert.equal(bad.configured, false);
  assert.ok(bad.view().needs.some((n) => n.startsWith('MUSE_TIER_REGION')));
});

test('the worker token is cached in memory: two switches make one token request', async () => {
  const stub = pingOneStub();
  const sw = tierFor(stub);
  await sw.switchTo('Premier Gold'); await sw.switchTo('Premier Silver');
  assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 1);
});

test('an expired token is asked for again', async () => {
  const stub = pingOneStub();
  let t = 1_000_000;
  const sw = createTierSwitch({ env: { ...TIER_ENV_VARS }, live: {}, fetchImpl: stub.fn, now: () => t });
  await sw.switchTo('Premier Gold');
  t += 3_700_000;
  await sw.switchTo('Premier Silver');
  assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 2);
});

test('partial failure: one user refuses the write, the result says which one and what PingOne still holds', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_2}`]: () => json(403, { code: 'ACCESS_FAILED', message: `no permission on ${USER_2}` }) } });
  const r = await tierFor(stub).switchTo('Premier Silver');
  assert.equal(r.ok, false);
  const [u1, u2] = r.users;
  assert.deepEqual([u1.written, u1.verified, u1.value], [true, true, 'Premier Silver']);
  assert.deepEqual([u2.label, u2.written, u2.verified, u2.value], ['Demo user 2', false, false, 'Premier Gold']);
  assert.match(u2.writeError, /403/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(`${USER_2}|${USER_1}|${ENV_ID}`), 'no ids in the answer');
  assert.match(r.summary, /Demo user 2: PingOne holds Premier Gold; the change failed/);
});

test('a write PingOne accepts but does not keep is reported as not verified, never as success', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_1}`]: () => json(200, {}) } });
  const r = await tierFor(stub).switchTo('Premier Silver');
  assert.equal(r.ok, false);
  assert.equal(r.users[0].written, true);
  assert.equal(r.users[0].verified, false);
  assert.equal(r.users[0].value, 'Premier Gold');
  assert.match(r.summary, /accepted but PingOne still holds Premier Gold/);
});

for (const [name, status, pattern] of [['401', 401, /401/], ['403', 403, /not allowed to edit users in this environment \(403\)/], ['429', 429, /rate limiting this app \(429\)/], ['500', 500, /answered 500/]]) {
  test(`the token endpoint answering ${name} is reported plainly and nothing is written`, async () => {
    const stub = pingOneStub({ faults: { token: () => json(status, { code: 'X', message: 'nope' }) } });
    const r = await tierFor(stub).switchTo('Premier Gold');
    assert.equal(r.ok, false);
    assert.match(r.error, pattern);
    assert.deepEqual(r.users, []);
    assert.equal(stub.calls.filter((c) => c.method === 'PATCH').length, 0);
  });
}

test('a user-write 429 and a 404 are reported per user', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_1}`]: () => json(429, {}), [`PATCH:${USER_2}`]: () => json(404, { code: 'NOT_FOUND', message: 'gone' }) } });
  const r = await tierFor(stub).switchTo('Premier Silver');
  assert.equal(r.ok, false);
  assert.match(r.users[0].writeError, /429/);
  assert.match(r.users[1].writeError, /404/);
});

test('a PingOne 400 shows its own code and message, with ids and URLs removed', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_1}`]: () => json(400, { code: 'INVALID_VALUE', message: `bad value for ${USER_1} at https://api.pingone.com/v1/x` }) } });
  const r = await tierFor(stub).switchTo('Premier Silver');
  assert.match(r.users[0].writeError, /PingOne said: INVALID_VALUE: bad value for <id> at <url>/);
});

// Redaction of the worker secret and the worker token. Each secret is checked on its own, so removing either one from scrub() fails here.
const ECHO = `rejected ${SECRET} and ${TOKEN} for ${USER_1} at https://api.pingone.com/v1/environments/${ENV_ID}/users/${USER_1}`;
const noSecrets = (value, where) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(SECRET), `the secret leaked in ${where}`);
  assert.ok(!text.includes(TOKEN), `the token leaked in ${where}`);
  assert.ok(!text.includes(Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')), `the Basic value leaked in ${where}`);
  assert.doesNotMatch(text, new RegExp(`${USER_1}|${USER_2}|${ENV_ID}|https?:`), `an id or URL survived in ${where}`);
};

test('a PingOne error that echoes the secret and the token is redacted in the write error, the read error and the summary', async () => {
  const cases = {
    'a 500 on the write': { [`PATCH:${USER_1}`]: () => json(500, { code: 'ECHO', message: ECHO }) },
    'a 400 on the write': { [`PATCH:${USER_1}`]: () => json(400, { code: 'ECHO', message: ECHO }) },
    'a 500 on the read-back': { [`GET:${USER_1}`]: () => json(500, { code: 'ECHO', message: ECHO }) },
  };
  for (const [where, faults] of Object.entries(cases)) {
    const r = await tierFor(pingOneStub({ faults })).switchTo('Premier Silver');
    assert.equal(r.ok, false, where);
    const text = JSON.stringify(r);
    assert.match(text, /\[redacted\]/, `${where}: the secret or token was replaced`);
    noSecrets(r, where);
    noSecrets(r.summary, `${where} (summary)`);
  }
});

test('the secret and the token are each redacted on their own', async () => {
  for (const [name, echoed] of [['secret', SECRET], ['token', TOKEN]]) {
    const stub = pingOneStub({ faults: { [`PATCH:${USER_1}`]: () => json(500, { code: 'ECHO', message: `value was ${echoed} here` }) } });
    const r = await tierFor(stub).switchTo('Premier Gold');
    assert.match(r.users[0].writeError, /value was \[redacted\] here/, `the ${name} is replaced by [redacted]`);
    assert.ok(!JSON.stringify(r).includes(echoed), `the ${name} is gone from the whole answer`);
  }
});

test('a token endpoint that echoes the secret is redacted', async () => {
  // No token exists yet at this stage, so only the secret (and the ids and URLs) can be echoed.
  const stub = pingOneStub({ faults: { token: () => json(500, { code: 'ECHO', message: ECHO.replace(TOKEN, 'nothing') }) } });
  const r = await tierFor(stub).switchTo('Premier Gold');
  assert.equal(r.ok, false);
  assert.match(r.error, /\[redacted\]/);
  noSecrets(r, 'token endpoint 500');
  assert.equal(stub.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('a fetch that throws an error containing the secret, the token and a URL leaks none of them', async () => {
  const inner = pingOneStub();
  let n = 0;
  const throwing = async (input, init) => {
    // The token request succeeds; every later request throws with everything sensitive in the message.
    if (n++ === 0) return inner.fn(input, init);
    throw new Error(`socket failed ${SECRET} ${TOKEN} https://api.pingone.com/v1/environments/${ENV_ID}/users/${USER_1}`);
  };
  const r = await createTierSwitch({ env: { ...TIER_ENV_VARS }, live: {}, fetchImpl: throwing }).switchTo('Premier Silver');
  assert.equal(r.ok, false);
  assert.match(r.users[0].writeError, /Could not reach PingOne/);
  noSecrets(r, 'fetch throw');
});

test('malformed JSON from the token endpoint or a user read is handled, not thrown', async () => {
  const bad = () => new Response('<html>not json', { status: 200 });
  const a = await tierFor(pingOneStub({ faults: { token: bad } })).switchTo('Premier Gold');
  assert.equal(a.ok, false);
  assert.match(a.error, /not understood/);
  const b = await tierFor(pingOneStub({ faults: { [`GET:${USER_1}`]: bad } })).switchTo('Premier Silver');
  assert.equal(b.ok, false);
  assert.equal(b.users[0].known, false);
  assert.equal(b.users[0].verified, false);
  assert.match(b.users[0].readError, /not understood/);
});

test('a non-text tier value on the user is not trusted', async () => {
  const stub = pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(200, { airlineMemberTier: { x: 1 } }) } });
  const r = await tierFor(stub).read();
  assert.equal(r.users[0].known, false);
  assert.match(r.users[0].readError, /not text/);
});

test('a timeout and an unreachable PingOne are reported without a URL', async () => {
  const slow = pingOneStub({ faults: { token: () => { throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }); } } });
  const a = await tierFor(slow).switchTo('Premier Gold');
  assert.match(a.error, /did not answer in time/);
  const down = pingOneStub({ faults: { throwAll: true } });
  const b = await tierFor(down).switchTo('Premier Gold');
  assert.match(b.error, /Could not reach PingOne/);
  assert.doesNotMatch(JSON.stringify([a, b]), /https?:|pingone\.com/);
});

test('a real timeout aborts: a request that never answers ends within the limit', async () => {
  const hang = async (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
  // Shorten the wait by aborting the signal ourselves through a fast AbortSignal.timeout stand-in.
  const orig = AbortSignal.timeout;
  AbortSignal.timeout = () => orig.call(AbortSignal, 20);
  try {
    const r = await createTierSwitch({ env: { ...TIER_ENV_VARS }, live: {}, fetchImpl: hang }).switchTo('Premier Gold');
    assert.match(r.error, /did not answer in time/);
  } finally { AbortSignal.timeout = orig; }
});

// ---- What is refused -------------------------------------------------------------------------------------------------------------------

test('only Premier Gold, Premier Silver and clear are writable; anything else is refused with no call to PingOne', async () => {
  assert.deepEqual([...TIER_WRITABLE], ['Premier Gold', 'Premier Silver', null]);
  const stub = pingOneStub();
  const sw = tierFor(stub);
  for (const v of ['premier gold', 'Premier Platinum', '', 'Premier Gold ', undefined, 0, false, {}, ['Premier Gold'], 'none']) {
    const r = await sw.switchTo(v);
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(r.error, /not allowed/);
  }
  assert.equal(stub.calls.length, 0);
});

test('missing or bad settings leave the switch off, name only the variables, and never call PingOne', async () => {
  for (const drop of ['MUSE_TIER_ENABLE', 'MUSE_TIER_WORKER_CLIENT_ID', 'MUSE_TIER_WORKER_CLIENT_SECRET', 'MUSE_TIER_USER_IDS', 'MUSE_TIER_ENV_ID']) {
    const stub = pingOneStub();
    const env = { ...TIER_ENV_VARS }; delete env[drop];
    const sw = tierFor(stub, env);
    assert.equal(sw.configured, false, drop);
    assert.ok(sw.view().needs.some((n) => n.startsWith(drop)), drop);
    assert.match(sw.view().explanation, /Not configured\. Set /);
    assert.equal((await sw.switchTo('Premier Gold')).ok, false);
    assert.equal((await sw.read()).ok, false);
    assert.equal(stub.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(sw.view()), new RegExp(`${SECRET}|${CLIENT_ID}|${USER_1}`));
  }
  // an env id may come from the app's existing PingOne settings instead
  const env = { ...TIER_ENV_VARS }; delete env.MUSE_TIER_ENV_ID;
  assert.equal(tierFor(pingOneStub(), { ...env, MUSE_P1_ENV_ID: ENV_ID }).configured, true);
  // without Real configured the switch is off
  assert.equal(createTierSwitch({ env: { ...TIER_ENV_VARS }, live: null, fetchImpl: pingOneStub().fn }).configured, false);
  // bad ids are not accepted
  for (const ids of ['not-a-uuid', `${USER_1},oops`, '', ' , ']) assert.equal(tierFor(pingOneStub(), { ...TIER_ENV_VARS, MUSE_TIER_USER_IDS: ids }).configured, false, ids);
});

test('the view never carries the secret, the client id, a user id or the environment id', () => {
  const sw = tierFor(pingOneStub());
  const text = JSON.stringify(sw.view());
  for (const secret of [SECRET, CLIENT_ID, USER_1, USER_2, ENV_ID]) assert.ok(!text.includes(secret));
  assert.equal(sw.view().users, 2);
});

test('one change at a time, and a small rate limit', async () => {
  const stub = pingOneStub();
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { ...stub, fn: async (...a) => { await gate; return stub.fn(...a); } };
  const sw = tierFor(slow);
  const first = sw.switchTo('Premier Silver');
  const second = await sw.switchTo('Premier Gold');
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  release();
  assert.equal((await first).ok, true);
  const lim = tierFor(stub);
  const seen = Array.from({ length: 12 }, () => lim.limited());
  assert.deepEqual([seen.filter((x) => !x).length, seen.filter(Boolean).length], [10, 2]);
});

// ---- Through the app (routes, mode, netguard) ----------------------------------------------------------------------------------------

async function boot(env, fetchImpl) {
  const server = createApp(env, { fetchImpl }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (m, p, b, headers = {}) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: b === undefined ? undefined : JSON.stringify(b) });
    const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  return { call, base, close: () => new Promise((r) => server.close(r)) };
}

function captureConsole() {
  const lines = []; const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => { lines.push(a.map(String).join(' ')); }; }
  return { lines, restore: () => { for (const k of Object.keys(orig)) console[k] = orig[k]; } };
}

test('Real through the app: GET reports the state, POST switches, the secret and token appear in no response and no log line', async () => {
  const stub = pingOneStub();
  const cap = captureConsole();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  const seen = [];
  try {
    const g = await a.call('GET', '/api/booking/tier'); seen.push(g);
    assert.equal(g.s, 200);
    assert.deepEqual([g.j.mode, g.j.configured, g.j.attribute, g.j.users], ['real', true, 'airlineMemberTier', 2]);
    const r0 = await a.call('POST', '/api/booking/tier/read'); seen.push(r0);
    assert.deepEqual([r0.s, r0.j.ok, r0.j.users.map((u) => u.value)], [200, true, ['Premier Gold', 'Premier Gold']]);
    const s = await a.call('POST', '/api/booking/tier', { member: 'standard' }); seen.push(s);
    assert.equal(s.s, 200);
    assert.equal(s.j.ok, true);
    assert.equal(stub.held(USER_1), 'Premier Silver');
    assert.equal(stub.held(USER_2), 'Premier Silver');
    const c = await a.call('POST', '/api/booking/tier', { member: 'none' }); seen.push(c);
    assert.equal(c.j.ok, true);
    assert.equal(stub.held(USER_1), null);
    const back = await a.call('POST', '/api/booking/tier', { member: 'premium' }); seen.push(back);
    assert.equal(stub.held(USER_2), 'Premier Gold');
    const g2 = await a.call('GET', '/api/booking/tier'); seen.push(g2);
    assert.deepEqual(g2.j.last.users.map((u) => u.value), ['Premier Gold', 'Premier Gold']);
    const ng = (await a.call('GET', '/api/netguard')).j; seen.push({ j: ng });
    assert.equal(ng.blocked, 0);
  } finally { await a.close(); cap.restore(); }
  const everything = JSON.stringify(seen) + cap.lines.join('\n');
  for (const secret of [SECRET, TOKEN, CLIENT_ID, USER_1, USER_2, ENV_ID, Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')]) assert.ok(!everything.includes(secret), 'no secret, token or id in any response or log line');
});

test('Real through the app: a failing PingOne is shown as a 502 with the honest per-user result', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_2}`]: () => json(403, { code: 'ACCESS_FAILED', message: 'nope' }) } });
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    const r = await a.call('POST', '/api/booking/tier', { member: 'standard' });
    assert.equal(r.s, 502);
    assert.equal(r.j.ok, false);
    assert.deepEqual(r.j.users.map((u) => u.verified), [true, false]);
  } finally { await a.close(); }
});

test('the request can only name a member key: attribute, value and user id fields are ignored; unknown members are 400', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    for (const body of [{ member: 'Premier Platinum' }, { member: 'Premier Silver' }, { member: ['standard'] }, { member: null }, {}, { tier: 'Premier Gold' }, { value: 'Premier Gold' }]) {
      assert.equal((await a.call('POST', '/api/booking/tier', body)).s, 400, JSON.stringify(body));
    }
    assert.equal(stub.calls.length, 0, 'rejected requests never reach PingOne');
    const r = await a.call('POST', '/api/booking/tier', { member: 'standard', attribute: 'role', userId: STRANGER, userIds: [STRANGER], id: STRANGER, value: 'admin', airlineMemberTier: 'Premier Gold', environment: STRANGER });
    assert.equal(r.s, 200);
    const writes = stub.calls.filter((c) => c.method === 'PATCH');
    assert.deepEqual(writes.map((w) => w.body), ['{"airlineMemberTier":"Premier Silver"}', '{"airlineMemberTier":"Premier Silver"}']);
    assert.ok(stub.calls.every((c) => !c.url.includes(STRANGER)), 'an id from the request is never used');
    assert.equal(stub.store.has(STRANGER), false);
  } finally { await a.close(); }
});

test('a cross-origin write is refused before it can reach PingOne', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    for (const p of ['/api/booking/tier', '/api/booking/tier/read']) assert.equal((await a.call('POST', p, { member: 'standard' }, { origin: 'https://evil.example' })).s, 403);
    assert.equal(stub.calls.length, 0);
  } finally { await a.close(); }
});

test('Real but not configured: the card state says what is needed (names only) and a write is refused with no call', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE }, stub.fn);
  try {
    const g = await a.call('GET', '/api/booking/tier');
    assert.equal(g.j.configured, false);
    assert.ok(g.j.needs.includes('MUSE_TIER_ENABLE') && g.j.needs.includes('MUSE_TIER_WORKER_CLIENT_ID') && g.j.needs.includes('MUSE_TIER_WORKER_CLIENT_SECRET') && g.j.needs.includes('MUSE_TIER_USER_IDS'));
    assert.match(g.j.explanation, /\.env/);
    const w = await a.call('POST', '/api/booking/tier', { member: 'standard' });
    assert.equal(w.s, 409);
    assert.equal(w.j.error, 'tier_not_configured');
    assert.equal((await a.call('POST', '/api/booking/tier/read')).s, 409);
    assert.equal(stub.calls.length, 0);
  } finally { await a.close(); }
});

test('Mock: switching sets the Mock PingOne user, and not a single outbound call is made even with every tier setting present', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...TIER_ENV_VARS }, stub.fn); // no ALLOW_LIVE: mock-only
  try {
    const g = await a.call('GET', '/api/booking/tier');
    assert.deepEqual([g.j.mode, g.j.member, g.j.configured], ['mock', 'standard', false]);
    for (const [key, ws] of [['premium', 'premium'], ['standard', 'standard'], ['none', 'none']]) {
      const r = await a.call('POST', '/api/booking/tier', { member: key });
      assert.deepEqual([r.s, r.j.mode, r.j.member], [200, 'mock', ws]);
      assert.equal((await a.call('GET', '/api/session')).j.member, ws, 'the same Mock member the booking judges');
    }
    assert.equal((await a.call('POST', '/api/booking/tier', { member: 'gold' })).s, 400);
    assert.equal((await a.call('POST', '/api/booking/tier/read')).s, 409, 'reading PingOne is Real only');
    assert.equal(stub.calls.length, 0);
    assert.deepEqual((await a.call('GET', '/api/netguard')).j, { mode: 'mock', attempts: 0, blocked: 0, selfTest: true });
  } finally { await a.close(); }
});

test('a Real-capable build toggled to Mock does not write to PingOne', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    assert.equal((await a.call('POST', '/api/mode', { source: 'mock' })).s, 200);
    const r = await a.call('POST', '/api/booking/tier', { member: 'standard' });
    assert.deepEqual([r.s, r.j.mode, r.j.member], [200, 'mock', 'standard']);
    assert.equal((await a.call('POST', '/api/booking/tier/read')).s, 409);
    assert.equal(stub.calls.length, 0);
  } finally { await a.close(); }
});

test('the mock decision follows the card: Silver denies the $940 direct booking, Gold allows it', async () => {
  const a = await boot({}, async () => { throw new Error('no network'); });
  try {
    await a.call('POST', '/api/signin', {});
    const au = await a.call('POST', '/api/authorize', { client: 'browser' });
    if (au.j.status === 'consent_required') await a.call('POST', '/api/consent', { client: 'browser', approve: true });
    const book = async () => (await a.call('POST', '/api/request', { tool: 'flights.book', args: { flightId: 'SH107' }, via: 'browser' })).j;
    await a.call('POST', '/api/booking/tier', { member: 'standard' });
    const silver = await book();
    assert.equal(silver.outcome, 'blocked');
    await a.call('POST', '/api/booking/tier', { member: 'premium' });
    const gold = await book();
    assert.equal(gold.outcome, 'allowed');
  } finally { await a.close(); }
});

// ---- Netguard ---------------------------------------------------------------------------------------------------------------------------

test('netguard: the tier module cannot reach PingOne through a mock-mode guard, and the guard self-test still passes', async () => {
  const stub = pingOneStub();
  const guard = createNetguard({ mode: 'mock' });
  const sw = createTierSwitch({ env: { ...TIER_ENV_VARS }, live: {}, fetchImpl: guard.wrap(stub.fn) });
  const r = await sw.switchTo('Premier Gold');
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not reach PingOne/);
  assert.equal(stub.calls.length, 0, 'nothing got through');
  assert.equal(guard.stats().blocked, 1);
  assert.doesNotMatch(JSON.stringify(r), /netguard|pingone\.com/, 'the guard message (it names an origin) is not shown');
  assert.deepEqual(await createNetguard({ mode: 'mock' }).selfTest(), { ok: true, refused: true, loopbackPassed: true });
});

test('netguard in Real counts the two PingOne origins and refuses nothing else because the module never asks for anything else', async () => {
  const stub = pingOneStub();
  const a = createNetguard({ mode: 'live' });
  const sw = createTierSwitch({ env: { ...TIER_ENV_VARS }, live: {}, fetchImpl: a.wrap(stub.fn) });
  await sw.switchTo('Premier Silver');
  assert.deepEqual(a.stats().origins.sort(), [API, AUTH]);
});

// ---- The agent limit (second allow-listed attribute) -----------------------------------------------------------------------------------

const patchesOf = (stub) => stub.calls.filter((c) => c.method === 'PATCH');

test('parseLimit: whole dollars 1 to 100000 as ASCII digits only; the word default clears; everything else is refused', () => {
  for (const ok of ['1', '250', '500', '1000', '100000', 1, 500, 100000]) assert.deepEqual(parseLimit(ok), { ok: true, value: String(ok) }, String(ok));
  assert.deepEqual(parseLimit('default'), { ok: true, value: null });
  const bad = ['0', '-5', '12.5', '1e3', ' 500', '500 ', '+5', '٣', '١٠', '1000000', '100001', '0500', '007', 'NaN', 'Infinity', '', ' ', '5_0', '0x10', '5\n', 'DEFAULT', 'default ',
    null, undefined, true, false, [], ['500'], [500], {}, { toString: () => '500' }, { valueOf: () => 500 },
    0, -5, 12.5, 500.5, NaN, Infinity, -Infinity, 100001, 1e21, 2 ** 53, -0, Symbol.iterator.description, new String('500')];
  for (const v of bad) assert.equal(parseLimit(v).ok, false, `${typeof v === 'string' ? JSON.stringify(v) : String(v)} is refused`);
  assert.equal(LIMIT_MAX, 100000);
  assert.equal(LIMIT_ATTRIBUTE, 'agentSpendLimit');
});

test('limit only: the PATCH body is exactly {"agentSpendLimit":"500"} (a string) on both users, then read back and verified', async () => {
  const stub = pingOneStub({ users: { [USER_1]: { tier: 'Premier Gold', limit: '250' }, [USER_2]: { tier: 'Premier Silver' } } });
  const r = await tierFor(stub).apply({ limit: '500' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.intended, { limit: 500 });
  assert.deepEqual(patchesOf(stub).map((p) => p.body), ['{"agentSpendLimit":"500"}', '{"agentSpendLimit":"500"}']);
  assert.deepEqual(patchesOf(stub).map((p) => new URL(p.url).pathname), [`/v1/environments/${ENV_ID}/users/${USER_1}`, `/v1/environments/${ENV_ID}/users/${USER_2}`]);
  assert.equal(typeof JSON.parse(patchesOf(stub)[0].body).agentSpendLimit, 'string');
  assert.deepEqual(r.users.map((u) => [u.label, u.written, u.known, u.limit, u.verified]), [['Demo user 1', true, true, 500, true], ['Demo user 2', true, true, 500, true]]);
  assert.equal(stub.heldLimit(USER_1), '500');
  assert.equal(stub.held(USER_2), 'Premier Silver', 'the tier was not touched');
  assert.match(r.summary, /PingOne now holds an agent limit of \$500 on all 2 demo users \(read back\)\. Run the booking again/);
  const order = stub.calls.filter((c) => c.method !== 'POST').map((c) => `${c.method}:${new URL(c.url).pathname.split('/').pop()}`);
  assert.deepEqual(order, [`PATCH:${USER_1}`, `GET:${USER_1}`, `PATCH:${USER_2}`, `GET:${USER_2}`]);
});

test('tier and limit together are ONE PATCH per user with exactly the two attributes, and both are read back', async () => {
  const stub = pingOneStub();
  const r = await tierFor(stub).apply({ tier: 'Premier Silver', limit: '250' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.intended, { tier: 'Premier Silver', limit: 250 });
  assert.equal(patchesOf(stub).length, 2, 'one PATCH per user, never one per attribute');
  for (const p of patchesOf(stub)) assert.equal(p.body, '{"airlineMemberTier":"Premier Silver","agentSpendLimit":"250"}');
  assert.deepEqual(r.users.map((u) => [u.value, u.limit, u.verified]), [['Premier Silver', 250, true], ['Premier Silver', 250, true]]);
  assert.equal(stub.heldLimit(USER_2), '250');
  assert.match(r.summary, /PingOne now holds Premier Silver and holds an agent limit of \$250 on all 2 demo users \(read back\)/);
});

test('round trips: limits 250, 1000, 500, then default clears the field (null) and Authorize falls back to 500', async () => {
  const stub = pingOneStub();
  const sw = tierFor(stub);
  for (const v of ['250', '1000', '500']) { const r = await sw.apply({ limit: v }); assert.equal(r.ok, true, v); assert.equal(stub.heldLimit(USER_1), v); assert.equal(stub.heldLimit(USER_2), v); }
  const c = await sw.apply({ limit: null });
  assert.equal(c.ok, true);
  assert.equal(patchesOf(stub).at(-1).body, '{"agentSpendLimit":null}');
  assert.equal(stub.heldLimit(USER_1), null);
  assert.deepEqual(c.users.map((u) => [u.known, u.limit, u.verified]), [[true, null, true], [true, null, true]]);
  assert.match(c.summary, /has no agent limit set on all 2 demo users \(read back\)\. Authorize then uses its default agent limit of \$500\./);
  assert.deepEqual(sw.view().held, { tier: 'Premier Gold', limit: null });
});

test('verified only if BOTH attributes read back as sent: a dropped limit or a dropped tier is not verified', async () => {
  // the PATCH is accepted; the tier lands, the limit does not
  const a = pingOneStub({ faults: { [`PATCH:${USER_1}`]: (call) => { const b = JSON.parse(call.body); a.store.get(USER_1).airlineMemberTier = b.airlineMemberTier; return json(200, {}); } } });
  const ra = await tierFor(a).apply({ tier: 'Premier Silver', limit: '250' });
  assert.equal(ra.ok, false);
  assert.deepEqual([ra.users[0].written, ra.users[0].value, ra.users[0].limit, ra.users[0].verified], [true, 'Premier Silver', 500, false], 'the tier matched but the limit did not');
  assert.equal(ra.users[1].verified, true);
  assert.match(ra.summary, /Demo user 1: .*accepted but PingOne still holds Premier Silver and an agent limit of \$500/);
  // the limit lands, the tier does not
  const b = pingOneStub({ faults: { [`PATCH:${USER_2}`]: (call) => { const x = JSON.parse(call.body); b.store.get(USER_2).agentSpendLimit = x.agentSpendLimit; return json(200, {}); } } });
  const rb = await tierFor(b).apply({ tier: 'Premier Silver', limit: '250' });
  assert.equal(rb.ok, false);
  assert.deepEqual([rb.users[1].value, rb.users[1].limit, rb.users[1].verified], ['Premier Gold', 250, false]);
});

test('partial failure on a combined change names the user, and that user is not half-updated', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_2}`]: () => json(403, { code: 'ACCESS_FAILED', message: `no permission on ${USER_2}` }) } });
  const r = await tierFor(stub).apply({ tier: 'Premier Silver', limit: '250' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.users.map((u) => [u.label, u.written, u.verified, u.value, u.limit]), [['Demo user 1', true, true, 'Premier Silver', 250], ['Demo user 2', false, false, 'Premier Gold', 500]]);
  assert.match(r.users[1].writeError, /403/);
  assert.match(r.summary, /Demo user 2: PingOne holds Premier Gold and an agent limit of \$500; the change failed/);
  assert.equal(patchesOf(stub).length, 2, 'one PATCH per user, so a refused user keeps both old values');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(`${USER_1}|${USER_2}|${ENV_ID}`));
});

test('apply refuses a bad tier, a bad limit and an empty request without calling PingOne', async () => {
  const stub = pingOneStub();
  const sw = tierFor(stub);
  for (const a of [{}, undefined, { tier: 'Premier Platinum' }, { limit: 500 }, { limit: '0' }, { limit: '500 ' }, { limit: '1e3' }, { limit: 12.5 }, { limit: '' }, { limit: 'default' }, { limit: ['500'] }, { tier: 'Premier Gold', limit: '-1' }, { limit: '٣' }]) {
    const r = await sw.apply(a);
    assert.equal(r.ok, false, JSON.stringify(a));
    assert.match(r.error, /not allowed|Nothing to change/);
  }
  assert.equal(stub.calls.length, 0);
});

test('a limit PingOne holds that is not a whole dollar amount is shown as unreadable, not guessed', async () => {
  for (const held of ['five hundred', '12.5', '-3', { x: 1 }]) {
    const stub = pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(200, { airlineMemberTier: 'Premier Gold', agentSpendLimit: held }) } });
    const r = await tierFor(stub).read();
    assert.equal(r.users[0].known, false);
    assert.match(r.users[0].readError, /agentSpendLimit holds something that is not a whole dollar amount/);
  }
  const text = pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(200, { agentSpendLimit: '' }) } });
  assert.deepEqual((await tierFor(text).read()).users[0].limit, null, 'an empty limit is no limit');
});

// ---- Opt-in (MUSE_TIER_ENABLE) -------------------------------------------------------------------------------------------------------

test('opt-in: MUSE_HOSTED=1 without MUSE_TIER_ENABLE=1 is refused with an explanation that names the flag, and nothing is called', async () => {
  for (const flag of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 'on']) {
    const stub = pingOneStub();
    const env = { ...TIER_ENV_VARS, MUSE_HOSTED: '1' }; if (flag === undefined) delete env.MUSE_TIER_ENABLE; else env.MUSE_TIER_ENABLE = flag;
    const sw = createTierSwitch({ env, live: {}, fetchImpl: stub.fn });
    assert.equal(sw.configured, false, JSON.stringify(flag));
    assert.match(sw.view().explanation, /MUSE_TIER_ENABLE=1/);
    assert.match(sw.view().explanation, /MUSE_HOSTED=1/);
    assert.ok(sw.view().needs.includes('MUSE_TIER_ENABLE'));
    assert.equal((await sw.apply({ limit: '250' })).ok, false);
    assert.equal((await sw.switchTo('Premier Gold')).ok, false);
    assert.equal((await sw.read()).ok, false);
    assert.deepEqual(await sw.readUserFacts(USER_1), { tier: null, limit: null });
    assert.equal(stub.calls.length, 0);
  }
});

test('opt-in: without MUSE_HOSTED the flag is still required', () => {
  const env = { ...TIER_ENV_VARS }; delete env.MUSE_TIER_ENABLE;
  const sw = createTierSwitch({ env, live: {}, fetchImpl: pingOneStub().fn });
  assert.equal(sw.configured, false);
  assert.deepEqual(sw.view().needs, ['MUSE_TIER_ENABLE']);
  assert.match(sw.view().explanation, /Not configured\. Set MUSE_TIER_ENABLE in Muse's own \.env/);
});

test('opt-in: MUSE_HOSTED=1 with MUSE_TIER_ENABLE=1 and the credentials works; without the credentials it refuses and says which', async () => {
  const stub = pingOneStub();
  const on = createTierSwitch({ env: { ...TIER_ENV_VARS, MUSE_HOSTED: '1' }, live: {}, fetchImpl: stub.fn });
  assert.equal(on.configured, true);
  assert.equal((await on.apply({ tier: 'Premier Silver', limit: '1000' })).ok, true);
  assert.equal(stub.heldLimit(USER_1), '1000');
  for (const drop of ['MUSE_TIER_WORKER_CLIENT_ID', 'MUSE_TIER_WORKER_CLIENT_SECRET', 'MUSE_TIER_USER_IDS', 'MUSE_TIER_ENV_ID']) {
    const s2 = pingOneStub();
    const env = { ...TIER_ENV_VARS, MUSE_HOSTED: '1' }; delete env[drop];
    const off = createTierSwitch({ env, live: {}, fetchImpl: s2.fn });
    assert.equal(off.configured, false, drop);
    assert.ok(off.view().needs.some((n) => n.startsWith(drop)));
    assert.equal(off.view().explanation.includes('MUSE_TIER_ENABLE=1'), false, 'the flag is set, so the explanation does not blame it');
    assert.equal((await off.apply({ limit: '250' })).ok, false);
    assert.equal(s2.calls.length, 0);
  }
});

const HOSTED_APP = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_HOSTED: '1', MUSE_ALLOWED_HOSTS: '127.0.0.1', MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example', MUSE_P1_ENV_ID: ENV_ID, MUSE_P1_CLIENT_ID: CLIENT_ID };

test('through the app as the Docker container runs (MUSE_HOSTED=1): off without the flag (409 naming it), on with it', async () => {
  const stub = pingOneStub();
  const off = await boot({ ...HOSTED_APP, ...TIER_ENV_VARS, MUSE_TIER_ENABLE: '' }, stub.fn);
  try {
    const g = await off.call('GET', '/api/booking/tier');
    assert.deepEqual([g.j.mode, g.j.configured], ['real', false]);
    assert.match(g.j.explanation, /MUSE_TIER_ENABLE/);
    assert.ok(g.j.needs.includes('MUSE_TIER_ENABLE'));
    const w = await off.call('POST', '/api/booking/tier', { limit: 250 });
    assert.deepEqual([w.s, w.j.error], [409, 'tier_not_configured']);
    assert.equal(stub.calls.length, 0);
  } finally { await off.close(); }
  const on = await boot({ ...HOSTED_APP, ...TIER_ENV_VARS }, stub.fn);
  try {
    assert.equal((await on.call('GET', '/api/booking/tier')).j.configured, true);
    const w = await on.call('POST', '/api/booking/tier', { limit: 250 });
    assert.deepEqual([w.s, w.j.ok], [200, true]);
    assert.equal(stub.heldLimit(USER_1), '250');
  } finally { await on.close(); }
});

// ---- Routes: body rules, both modes, secrecy -------------------------------------------------------------------------------------------

test('the body is {member?, limit?}: either or both, one PATCH per user, unknown fields ignored, names and ids never from the request', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    const only = await a.call('POST', '/api/booking/tier', { limit: 250 });
    assert.deepEqual([only.s, only.j.ok, only.j.intended], [200, true, { limit: 250 }]);
    assert.deepEqual(patchesOf(stub).map((p) => p.body), ['{"agentSpendLimit":"250"}', '{"agentSpendLimit":"250"}']);
    stub.calls.length = 0;
    const text = await a.call('POST', '/api/booking/tier', { limit: '1000' });
    assert.equal(text.s, 200);
    assert.deepEqual(patchesOf(stub).map((p) => p.body), ['{"agentSpendLimit":"1000"}', '{"agentSpendLimit":"1000"}']);
    stub.calls.length = 0;
    const both = await a.call('POST', '/api/booking/tier', { member: 'standard', limit: 500 });
    assert.deepEqual([both.s, both.j.ok, both.j.intended], [200, true, { tier: 'Premier Silver', limit: 500 }]);
    assert.deepEqual(patchesOf(stub).map((p) => p.body), Array(2).fill('{"airlineMemberTier":"Premier Silver","agentSpendLimit":"500"}'));
    stub.calls.length = 0;
    const def = await a.call('POST', '/api/booking/tier', { limit: 'default' });
    assert.equal(def.s, 200);
    assert.deepEqual(patchesOf(stub).map((p) => p.body), Array(2).fill('{"agentSpendLimit":null}'));
    stub.calls.length = 0;
    const none = await a.call('POST', '/api/booking/tier', { member: 'none', limit: 'default' });
    assert.equal(none.s, 200);
    assert.deepEqual(patchesOf(stub).map((p) => p.body), Array(2).fill('{"airlineMemberTier":null,"agentSpendLimit":null}'));
    stub.calls.length = 0;
    const r = await a.call('POST', '/api/booking/tier', { limit: 300, attribute: 'role', attributes: ['role'], userId: STRANGER, userIds: [STRANGER], id: STRANGER, agentSpendLimit: '99999', airlineMemberTier: 'Premier Gold', value: 'x', environment: STRANGER, __proto__: { member: 'premium' } });
    assert.equal(r.s, 200);
    assert.deepEqual(patchesOf(stub).map((p) => p.body), Array(2).fill('{"agentSpendLimit":"300"}'));
    assert.ok(stub.calls.every((c) => !c.url.includes(STRANGER)));
    assert.equal(stub.store.has(STRANGER), false);
  } finally { await a.close(); }
});

test('a bad body is a 400 before PingOne is touched, in Real and in Mock', async () => {
  const bodies = [{}, [], { limit: 0 }, { limit: '0' }, { limit: -5 }, { limit: '-5' }, { limit: 12.5 }, { limit: '12.5' }, { limit: '1e3' }, { limit: ' 500' }, { limit: '500 ' }, { limit: '+5' }, { limit: '٣' },
    { limit: 1000000 }, { limit: '1000000' }, { limit: 'NaN' }, { limit: '' }, { limit: null }, { limit: [500] }, { limit: ['500'] }, { limit: {} }, { limit: true }, { limit: 'DEFAULT' },
    { member: 'gold' }, { member: null }, { member: ['standard'] }, { member: 'standard', limit: 'x' }, { member: 'x', limit: 250 }, { tier: 'Premier Gold' }, { value: 5 }];
  const stub = pingOneStub();
  const real = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  const mock = await boot({ ...TIER_ENV_VARS }, stub.fn);
  try {
    for (const body of bodies) {
      assert.equal((await real.call('POST', '/api/booking/tier', body)).s, 400, `real ${JSON.stringify(body)}`);
      assert.equal((await mock.call('POST', '/api/booking/tier', body)).s, 400, `mock ${JSON.stringify(body)}`);
    }
    assert.equal(stub.calls.length, 0);
    assert.equal((await mock.call('GET', '/api/booking/tier')).j.limit, 500, 'a refused body changed nothing');
    const raw = await fetch(`${real.base}/api/booking/tier`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"limit":' });
    assert.equal(raw.status, 400, 'malformed JSON');
    const huge = await fetch(`${real.base}/api/booking/tier`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: '9'.repeat(100000) }) });
    assert.ok(huge.status >= 400 && huge.status < 600, 'an oversized body is refused (the body cap is the server\'s own, 16kb)');
    assert.equal(stub.calls.length, 0);
  } finally { await real.close(); await mock.close(); }
});

test('GET and read return the tier AND the limit: Real per user and agreed, Mock the Mock user', async () => {
  const stub = pingOneStub({ users: { [USER_1]: { tier: 'Premier Silver', limit: '750' }, [USER_2]: { tier: 'Premier Silver', limit: '750' } } });
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    assert.equal((await a.call('GET', '/api/booking/tier')).j.held, null, 'nothing read yet');
    const r = await a.call('POST', '/api/booking/tier/read');
    assert.deepEqual(r.j.users.map((u) => [u.value, u.limit, u.known]), [['Premier Silver', 750, true], ['Premier Silver', 750, true]]);
    const g = await a.call('GET', '/api/booking/tier');
    assert.deepEqual([g.j.limitAttribute, g.j.held], ['agentSpendLimit', { tier: 'Premier Silver', limit: 750 }]);
    assert.deepEqual(g.j.last.users.map((u) => u.limit), [750, 750]);
    stub.store.get(USER_2).agentSpendLimit = '100';
    await a.call('POST', '/api/booking/tier/read');
    assert.equal((await a.call('GET', '/api/booking/tier')).j.held, null, 'users that differ are not summarised as one value');
  } finally { await a.close(); }
  const m = await boot({}, async () => { throw new Error('no network'); });
  try {
    const g0 = (await m.call('GET', '/api/booking/tier')).j;
    assert.deepEqual([g0.mode, g0.member, g0.tier, g0.limit, g0.limitIsDefault], ['mock', 'standard', 'Premier Silver', 500, true]);
    const p = (await m.call('POST', '/api/booking/tier', { member: 'premium', limit: 750 })).j;
    assert.deepEqual([p.mode, p.member, p.tier, p.limit, p.limitIsDefault], ['mock', 'premium', 'Premier Gold', 750, false]);
    const s = (await m.call('GET', '/api/session')).j;
    assert.deepEqual([s.member, s.agentLimit, s.agentLimitIsDefault], ['premium', 750, false]);
    const e = (await m.call('POST', '/api/booking/tier', { limit: 500 })).j;
    assert.deepEqual([e.limit, e.limitIsDefault], [500, false], 'an explicit 500 is not the default');
    const d = (await m.call('POST', '/api/booking/tier', { limit: 'default' })).j;
    assert.deepEqual([d.limit, d.limitIsDefault, d.member], [500, true, 'premium'], 'default clears the limit and leaves the tier alone');
    assert.equal((await m.call('POST', '/api/booking/tier', { member: 'none' })).j.tier, null);
  } finally { await m.close(); }
});

test('Real through the app with limit changes: the secret, token, ids and Basic value appear in no response and no log line, even when PingOne echoes them', async () => {
  const stub = pingOneStub({ faults: { [`PATCH:${USER_2}`]: () => json(500, { code: 'ECHO', message: ECHO }) } });
  const cap = captureConsole();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  const seen = [];
  try {
    seen.push(await a.call('GET', '/api/booking/tier'));
    seen.push(await a.call('POST', '/api/booking/tier', { limit: 250 }));
    seen.push(await a.call('POST', '/api/booking/tier', { member: 'standard', limit: 'default' }));
    seen.push(await a.call('POST', '/api/booking/tier/read'));
    seen.push(await a.call('GET', '/api/booking/tier'));
    seen.push(await a.call('GET', '/api/session'));
  } finally { await a.close(); cap.restore(); }
  assert.ok(seen[1].s === 502 && seen[1].j.users[1].writeError.includes('[redacted]'));
  const everything = JSON.stringify(seen) + cap.lines.join('\n');
  for (const secret of [SECRET, TOKEN, CLIENT_ID, USER_1, USER_2, ENV_ID, Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')]) assert.ok(!everything.includes(secret), 'no secret, token or id anywhere');
});

test('a cross-origin limit write is refused before it can reach PingOne, and the rate limit counts limit writes too', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...LIVE, ...TIER_ENV_VARS }, stub.fn);
  try {
    assert.equal((await a.call('POST', '/api/booking/tier', { limit: 250 }, { origin: 'https://evil.example' })).s, 403);
    assert.equal(stub.calls.length, 0);
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await a.call('POST', '/api/booking/tier', { limit: 100 + i })).s);
    assert.deepEqual([codes.filter((c) => c === 200).length, codes.filter((c) => c === 429).length], [10, 2]);
  } finally { await a.close(); }
});

test('Mock: no limit or tier setting, however complete, makes a single outbound call', async () => {
  const stub = pingOneStub();
  const a = await boot({ ...TIER_ENV_VARS }, stub.fn);
  try {
    for (const b of [{ limit: 250 }, { limit: 'default' }, { member: 'premium', limit: 1000 }]) assert.equal((await a.call('POST', '/api/booking/tier', b)).s, 200);
    assert.equal(stub.calls.length, 0);
    assert.deepEqual((await a.call('GET', '/api/netguard')).j, { mode: 'mock', attempts: 0, blocked: 0, selfTest: true });
  } finally { await a.close(); }
});

// ---- readUserFacts (for the connector change; not wired in yet) --------------------------------------------------------------------------

test('readUserFacts: the tier and the limit (a number) of an allow-listed user, from the same token and the configured URL', async () => {
  const stub = pingOneStub({ users: { [USER_1]: { tier: 'Premier Gold', limit: '750' }, [USER_2]: { tier: 'Premier Silver' } } });
  const sw = tierFor(stub);
  assert.deepEqual(await sw.readUserFacts(USER_1), { tier: 'Premier Gold', limit: 750 });
  assert.deepEqual(await sw.readUserFacts(USER_2), { tier: 'Premier Silver', limit: null });
  assert.deepEqual(await sw.readUserFacts(USER_1.toUpperCase()), { tier: 'Premier Gold', limit: 750 }, 'ids compare case-insensitively');
  assert.deepEqual(stub.calls.filter((c) => c.method === 'POST').length, 1, 'one cached worker token');
  const gets = stub.calls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 3);
  assert.ok(gets.every((c) => c.headers.authorization === `Bearer ${TOKEN}` && c.redirect === 'manual' && c.hasSignal));
  assert.equal(new URL(gets[2].url).pathname, `/v1/environments/${ENV_ID}/users/${USER_1}`, 'the URL is built from the configured id');
  assert.equal(stub.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.deepEqual([...new Set(stub.calls.map((c) => c.origin))].sort(), [API, AUTH]);
});

test('readUserFacts: an id that is not on the allow-list gets nulls and PingOne is never called, not even for a token', async () => {
  const stub = pingOneStub();
  const sw = tierFor(stub);
  for (const id of [STRANGER, '', ' ', `${USER_1}/../${STRANGER}`, `${USER_1}?x=1`, `${USER_1}x`, `x${USER_1}`, null, undefined, 5, {}, [USER_1], { toString: () => USER_1 }, '*', '..']) {
    assert.deepEqual(await sw.readUserFacts(id), { tier: null, limit: null }, JSON.stringify(id));
  }
  assert.equal(stub.calls.length, 0);
});

test('readUserFacts: not configured, a PingOne error, an unreadable value and a down PingOne all give nulls without throwing or leaking', async () => {
  const off = pingOneStub();
  const env = { ...TIER_ENV_VARS }; delete env.MUSE_TIER_ENABLE;
  assert.deepEqual(await tierFor(off, env).readUserFacts(USER_1), { tier: null, limit: null });
  assert.equal(off.calls.length, 0);
  const cases = {
    'a 500': pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(500, { code: 'ECHO', message: ECHO }) } }),
    'a 404': pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(404, {}) } }),
    'a bad limit': pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(200, { airlineMemberTier: 'Premier Gold', agentSpendLimit: 'lots' }) } }),
    'a non-text tier': pingOneStub({ faults: { [`GET:${USER_1}`]: () => json(200, { airlineMemberTier: 5 }) } }),
    'garbage': pingOneStub({ faults: { [`GET:${USER_1}`]: () => new Response('<html>', { status: 200 }) } }),
    'a token refusal': pingOneStub({ faults: { token: () => json(401, { error: 'invalid_client' }) } }),
    'network down': pingOneStub({ faults: { throwAll: true } }),
  };
  for (const [name, stub] of Object.entries(cases)) {
    const out = await tierFor(stub).readUserFacts(USER_1);
    assert.deepEqual(out, { tier: null, limit: null }, name);
    noSecrets(out, name);
  }
});

test('readUserFacts has its own limiter: 30 reads a minute, then nulls, and the write limiter is untouched', async () => {
  const stub = pingOneStub();
  let t = 5_000_000;
  const sw = createTierSwitch({ env: { ...TIER_ENV_VARS }, live: {}, fetchImpl: stub.fn, now: () => t });
  const outs = [];
  for (let i = 0; i < 32; i++) outs.push(await sw.readUserFacts(USER_1));
  assert.equal(outs.filter((o) => o.tier === 'Premier Gold').length, 30);
  assert.deepEqual(outs.slice(30), [{ tier: null, limit: null }, { tier: null, limit: null }]);
  assert.equal(stub.calls.filter((c) => c.method === 'GET').length, 30);
  assert.equal(sw.limited(), false, 'reads did not spend the write budget');
  t += 61_000;
  assert.equal((await sw.readUserFacts(USER_1)).tier, 'Premier Gold', 'the window moves on');
});

// ---- Repo hygiene -------------------------------------------------------------------------------------------------------------------

test('.env.example, README and CLAUDE.md name every tier setting and label the deviation as owner-approved', () => {
  const root = new URL('../../', import.meta.url);
  const read = (f) => readFileSync(new URL(f, root), 'utf8');
  for (const [file, text] of [['.env.example', read('.env.example')], ['README.md', read('README.md')], ['CLAUDE.md', read('CLAUDE.md')]]) {
    for (const name of Object.values(TIER_ENV)) assert.ok(text.includes(name), `${file} names ${name}`);
    assert.match(text, /owner-approved 2026-11-09/, `${file} labels the deviation`);
    assert.match(text, /opt-in/i, `${file} says the opt-in flag is required`);
    assert.ok(text.includes(LIMIT_ATTRIBUTE), `${file} names ${LIMIT_ATTRIBUTE}`);
  }
  const example = read('.env.example');
  assert.doesNotMatch(example, /^MUSE_TIER_[A-Z_]+=.*[0-9a-f]{8}-(?!0000)[0-9a-f]{4}-/im, 'no real ids in the example');
  assert.match(example, /^# MUSE_TIER_ENABLE=1\s*$/m, 'the opt-in flag is in the example, commented');
  assert.doesNotMatch(example, /^MUSE_TIER_ENABLE=/m, 'and never on by default');
  const compose = read('docker-compose.yml');
  assert.doesNotMatch(compose, new RegExp(`${SECRET}`));
  assert.match(compose, /MUSE_TIER_ENABLE: \$\{MUSE_TIER_ENABLE:-\}/, 'compose passes the flag through, empty by default');
  assert.doesNotMatch(compose, /MUSE_TIER_ENABLE: ['"]?1/, 'and never turns it on');
});
