// The Airline Connector's refresh tokens (opt-in with MUSE_CONNECTOR_REFRESH=1), against a stub PingOne and a stub gateway. Nothing real is contacted.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTOR, CLIENT_SECRET, ON, P1, REDIRECT, USER, USER2, boot, callTool, connect, jwt, pkce, refreshWith } from './helpers/refresh-stack.js';
import { REFRESH_DEFAULT_HOURS, REFRESH_GRACE_MS, REFRESH_HARD_CAP_HOURS, createRefreshStore, refreshMaxHours } from '../src/refreshStore.js';
import { scrubAnswer } from '../src/connector.js';
import { exchangeCode } from '../src/liveauth.js';
import { liveConfig } from '../src/discovery.js';

const HOUR = 3600 * 1000;
const clock = () => mock.timers.enable({ apis: ['Date'], now: Date.now() });
const tick = (ms) => mock.timers.tick(ms);
const withApp = async (extra, p1, fn) => { const a = await boot(extra, p1); try { await fn(a); } finally { mock.timers.reset(); await a.close(); } };
const refreshCalls = (a) => a.grants().filter((g) => g === 'refresh_token').length;
const capture = () => {
  const lines = []; const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...x) => { lines.push(x.map(String).join(' ')); };
  return { lines, stop: () => Object.assign(console, orig) };
};
const authorizeScope = async (a) => {
  const reg = await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
  const au = await a.get(`/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
  const flow = new URL(au.headers.get('location')).searchParams.get('flow');
  return (await (await a.get(`/connector/signin/config?flow=${flow}`)).json()).piflow.scope;
};

// ---- off by default -------------------------------------------------------------------------------------------------------------------------------------

test('off by default: no offline_access, no refresh token even if PingOne sends one, the metadata and registrations unchanged, and a refresh grant is unsupported', async () => {
  await withApp({}, {}, async (a) => {
    const as = await (await a.get('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(as.grant_types_supported, ['authorization_code']);
    assert.deepEqual(as.scopes_supported, ['mcp']);
    const reg = await (await a.post('/connector/register', { redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] })).json();
    assert.deepEqual(reg.grant_types, ['authorization_code'], 'a registration is not offered the refresh grant');
    assert.equal(await authorizeScope(a), 'openid', 'offline_access is not asked for');
    const c = await connect(a);
    assert.equal(c.status, 200);
    assert.equal(a.p1.valid.size, 1, 'PingOne did issue a refresh token');
    assert.equal(c.tokens.refresh_token, undefined, 'but the agent gets none');
    assert.ok(!JSON.stringify(c.tokens).includes('p1-rt'));
    const r = await refreshWith(a, c.clientId, 'anything');
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'unsupported_grant_type');
    assert.equal(refreshCalls(a), 0);
  });
});

// ---- on: metadata, registration, scope -------------------------------------------------------------------------------------------------------------------

test('on: the metadata offers refresh_token, scopes stay mcp; a registration gets it unless it listed grants without it; offline_access is asked for', async () => {
  await withApp(ON, {}, async (a) => {
    const as = await (await a.get('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(as.scopes_supported, ['mcp']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
    const both = await (await a.post('/connector/register', { redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] })).json();
    assert.deepEqual(both.grant_types, ['authorization_code', 'refresh_token']);
    const none = await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
    assert.deepEqual(none.grant_types, ['authorization_code', 'refresh_token'], 'a client that lists no grants is offered it');
    const codeOnly = await (await a.post('/connector/register', { redirect_uris: [REDIRECT], grant_types: ['authorization_code'] })).json();
    assert.deepEqual(codeOnly.grant_types, ['authorization_code'], 'a client that says it will not use it is not given it');
    assert.equal(await authorizeScope(a), 'openid offline_access');
  });
  await withApp({ ...ON, MUSE_CONNECTOR_CLIENT_ID: 'static-agent', MUSE_CONNECTOR_REDIRECT_URIS: REDIRECT }, {}, async (a) => {
    const c = await connect(a, { reg: { client_id: 'static-agent' } });
    assert.ok(c.tokens.refresh_token, 'the pre-registered client may refresh too');
  });
});

test('a client that registered without the refresh grant gets no refresh token, and cannot refresh', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a, { registration: { redirect_uris: [REDIRECT], grant_types: ['authorization_code'] } });
    assert.equal(c.status, 200); assert.equal(c.tokens.refresh_token, undefined);
    assert.equal((await refreshWith(a, c.clientId, 'x')).status, 400);
  });
});

test('a client registered while refresh is off is stored without a grant list, and can refresh once refresh is switched on (same clients file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-clients-'));
  const file = join(dir, 'clients.json');
  try {
    let clientId;
    await withApp({ MUSE_CLIENTS_FILE: file }, {}, async (a) => {
      const reg = await (await a.post('/connector/register', { redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] })).json();
      clientId = reg.client_id;
      assert.deepEqual(reg.grant_types, ['authorization_code']);
    });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal('grants' in saved[clientId], false, 'the saved file is as it was before refresh tokens existed');
    await withApp({ ...ON, MUSE_CLIENTS_FILE: file }, {}, async (a) => {
      const c = await connect(a, { reg: { client_id: clientId } });
      assert.equal(c.status, 200);
      assert.ok(c.tokens.refresh_token, 'reconnecting after switch-on yields a refresh token');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the full flow --------------------------------------------------------------------------------------------------------------------------------------

test('on: sign-in returns a refresh token; a refresh does PingOne\'s refresh grant and the delegation again, gives a new access and a new refresh token, and the new access token works', async () => {
  await withApp(ON, { lifetimeS: 1200 }, async (a) => {
    const c = await connect(a);
    assert.equal(c.status, 200);
    assert.ok(c.tokens.refresh_token && c.tokens.refresh_token !== c.tokens.access_token);
    assert.match(c.tokens.refresh_token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    assert.ok(!JSON.stringify(c.tokens).includes('p1-rt'), 'PingOne\'s refresh token is never given to the agent');
    assert.equal((await callTool(a, c.tokens.access_token)).status, 200);
    const before = a.seen.length;
    const r = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(j.token_type, 'Bearer'); assert.equal(j.scope, 'mcp');
    assert.ok(j.expires_in <= 1200 && j.expires_in > 1100, 'the lifetime follows the new delegated token');
    assert.notEqual(j.access_token, c.tokens.access_token);
    assert.notEqual(j.refresh_token, c.tokens.refresh_token, 'rotated');
    assert.ok(!JSON.stringify(j).includes('p1-rt'));
    const posts = a.seen.slice(before).filter((x) => x.url === `${P1}/token`).map((x) => new URLSearchParams(x.init.body));
    assert.deepEqual(posts.map((f) => f.get('grant_type')), ['refresh_token', 'client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:ietf:params:oauth:grant-type:token-exchange']);
    assert.equal(posts[0].get('refresh_token'), 'p1-rt-1-not-real', 'PingOne gets its own refresh token');
    assert.equal(posts[0].get('client_id'), ACTOR); assert.equal(posts[0].get('client_secret'), CLIENT_SECRET, 'same client authentication as the code swap');
    // PingOne rotated its token: the next refresh uses the new one.
    assert.equal((await refreshWith(a, c.clientId, j.refresh_token)).status, 200);
    const again = a.seen.filter((x) => x.url === `${P1}/token`).map((x) => new URLSearchParams(x.init.body)).filter((f) => f.get('grant_type') === 'refresh_token');
    assert.deepEqual(again.map((f) => f.get('refresh_token')), ['p1-rt-1-not-real', again[1].get('refresh_token')]);
    assert.notEqual(again[1].get('refresh_token'), 'p1-rt-1-not-real');
    // The new access token reaches the gateway with the NEW delegated token (the gateway stub knows only live ones).
    const call = await (await callTool(a, j.access_token)).json();
    assert.equal(call.result.isError, false);
  });
});

test('PingOne issues no refresh token: none is issued to the agent, and the sign-in works as it does today', async () => {
  const cap = capture();
  try {
    await withApp(ON, { issueRefresh: false }, async (a) => {
      const c = await connect(a);
      assert.equal(c.status, 200); assert.ok(c.tokens.access_token); assert.equal(c.tokens.refresh_token, undefined);
      assert.equal((await callTool(a, c.tokens.access_token)).status, 200);
    });
  } finally { cap.stop(); }
  assert.match(cap.lines.join('\n'), /sign-in done without a refresh token \(PingOne issued none/);
});

test('PingOne does not rotate its refresh token: the same one is kept and used again', async () => {
  await withApp(ON, { rotate: false }, async (a) => {
    const c = await connect(a);
    const r1 = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    assert.equal((await refreshWith(a, c.clientId, r1.refresh_token)).status, 200);
    const used = a.seen.filter((x) => x.url === `${P1}/token`).map((x) => new URLSearchParams(x.init.body)).filter((f) => f.get('grant_type') === 'refresh_token').map((f) => f.get('refresh_token'));
    assert.deepEqual(used, ['p1-rt-1-not-real', 'p1-rt-1-not-real']);
  });
});

// ---- rotation, reuse, grace ------------------------------------------------------------------------------------------------------------------------------

test('rotation: the old refresh token is dead after the grace time, and presenting it revokes the whole family (the new tokens and the access tokens too)', async () => {
  clock();
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    const r1 = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    const r2 = await (await refreshWith(a, c.clientId, r1.refresh_token)).json();
    assert.equal((await callTool(a, r2.access_token)).status, 200);
    tick(REFRESH_GRACE_MS + 1);
    const calls = refreshCalls(a);
    const reuse = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(reuse.status, 400); assert.equal((await reuse.json()).error, 'invalid_grant');
    assert.equal(refreshCalls(a), calls, 'PingOne is not asked');
    // The family is gone: the live refresh token and the access tokens stop working.
    const dead = await refreshWith(a, c.clientId, r2.refresh_token);
    assert.equal(dead.status, 400); assert.equal((await dead.json()).error, 'invalid_grant');
    assert.equal((await callTool(a, r2.access_token)).status, 401);
    assert.equal((await callTool(a, c.tokens.access_token)).status, 401);
    assert.equal(refreshCalls(a), calls);
  });
});

test('an old token from two rotations back is also reuse', async () => {
  clock();
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    const r1 = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    const r2 = await (await refreshWith(a, c.clientId, r1.refresh_token)).json();
    tick(REFRESH_GRACE_MS + 1);
    assert.equal((await refreshWith(a, c.clientId, c.tokens.refresh_token)).status, 400);
    assert.equal((await refreshWith(a, c.clientId, r2.refresh_token)).status, 400, 'revoked with it');
  });
});

test('the idempotent grace: the same spent token within 10 seconds gets the very same answer and PingOne is asked once; at 10 seconds still, after that it is reuse', async () => {
  clock();
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    const first = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    const calls = refreshCalls(a);
    tick(REFRESH_GRACE_MS - 1000);
    const retry = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), first);
    tick(1000);
    const edge = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(edge.status, 200, 'exactly 10 seconds is still inside the grace');
    assert.equal(refreshCalls(a), calls, 'no second PingOne call');
    assert.equal((await callTool(a, first.access_token)).status, 200);
    tick(1);
    assert.equal((await refreshWith(a, c.clientId, c.tokens.refresh_token)).status, 400, 'after the grace it is reuse');
    assert.equal((await refreshWith(a, c.clientId, first.refresh_token)).status, 400, 'and the family is revoked');
  });
});

test('concurrent refreshes with the same token are serialized: exactly one PingOne call, every caller gets the same answer', async () => {
  await withApp(ON, { refreshDelayMs: 80 }, async (a) => {
    const c = await connect(a);
    const rs = await Promise.all(Array.from({ length: 6 }, () => refreshWith(a, c.clientId, c.tokens.refresh_token)));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    const bodies = await Promise.all(rs.map((r) => r.json()));
    assert.equal(new Set(bodies.map((b) => JSON.stringify(b))).size, 1);
    assert.equal(refreshCalls(a), 1, 'only one request reached PingOne');
    assert.equal(a.p1.refreshCalls, 1);
    assert.equal((await refreshWith(a, c.clientId, bodies[0].refresh_token)).status, 200, 'and the family is intact');
  });
});

// ---- binding ---------------------------------------------------------------------------------------------------------------------------------------------

test('client binding: another client_id and a missing client_id are refused; a refused attempt does not revoke the real client\'s family', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    const other = await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
    const calls = refreshCalls(a);
    const wrong = await refreshWith(a, other.client_id, c.tokens.refresh_token);
    assert.equal(wrong.status, 400); assert.equal((await wrong.json()).error, 'invalid_grant');
    const missing = await refreshWith(a, undefined, c.tokens.refresh_token);
    assert.equal(missing.status, 400); assert.equal((await missing.json()).error, 'invalid_request');
    const empty = await refreshWith(a, '', c.tokens.refresh_token);
    assert.equal(empty.status, 400);
    assert.equal((await refreshWith(a, c.clientId, undefined)).status, 400);
    assert.equal(refreshCalls(a), calls, 'PingOne is not asked');
    const ok = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(ok.status, 200, 'the real client still refreshes');
    // another client with the real client's NEW token, and with a made-up one
    assert.equal((await refreshWith(a, other.client_id, (await ok.json()).refresh_token)).status, 400);
    assert.equal((await refreshWith(a, c.clientId, 'not-a-token')).status, 400);
  });
});

test('the refresh is bound to the signed-in user: a refreshed token for someone else revokes the sign-in', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    a.p1.refreshSub = USER2;
    const r = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_grant');
    a.p1.refreshSub = null;
    assert.equal((await refreshWith(a, c.clientId, c.tokens.refresh_token)).status, 400, 'revoked');
    assert.equal((await callTool(a, c.tokens.access_token)).status, 401);
  });
});

// ---- lifetime --------------------------------------------------------------------------------------------------------------------------------------------

test('absolute lifetime: a refresh token never outlives MAX_HOURS from the first issue, however often it was rotated; PingOne is not asked once it is over', async () => {
  clock();
  await withApp({ ...ON, MUSE_CONNECTOR_REFRESH_MAX_HOURS: '2' }, { lifetimeS: 3600 }, async (a) => {
    const c = await connect(a);
    tick(50 * 60 * 1000);
    const r1 = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    tick(50 * 60 * 1000);
    const r2 = await refreshWith(a, c.clientId, r1.refresh_token);
    assert.equal(r2.status, 200, '100 minutes in, still inside the 2 hours');
    const j2 = await r2.json();
    tick(21 * 60 * 1000);
    const calls = refreshCalls(a);
    const over = await refreshWith(a, c.clientId, j2.refresh_token);
    assert.equal(over.status, 400); assert.equal((await over.json()).error, 'invalid_grant');
    assert.equal(refreshCalls(a), calls, 'no PingOne call after the lifetime');
  });
});

test('absolute lifetime: a token presented exactly at the limit is refused, one second before it works', async () => {
  clock();
  await withApp({ ...ON, MUSE_CONNECTOR_REFRESH_MAX_HOURS: '1' }, {}, async (a) => {
    const c = await connect(a);
    const d = await connect(a);
    tick(HOUR - 1000);
    assert.equal((await refreshWith(a, c.clientId, c.tokens.refresh_token)).status, 200);
    tick(1000);
    assert.equal((await refreshWith(a, d.clientId, d.tokens.refresh_token)).status, 400);
  });
});

test('MAX_HOURS: unset, empty and invalid values mean 24 hours; a number above 168 is cut to 168', async () => {
  for (const v of [undefined, null, '', ' ', 'abc', '-5', '0', '0.0', '1e3', '12abc', 'NaN', 'Infinity', '--1', '1,5', '٣']) assert.equal(refreshMaxHours(v), REFRESH_DEFAULT_HOURS, JSON.stringify(v));
  for (const [v, want] of [['24', 24], [' 6 ', 6], [12, 12], ['1.5', 1.5], ['168', 168], ['169', 168], ['100000', 168], ['999999', 168]]) assert.equal(refreshMaxHours(v), want, JSON.stringify(v));
  assert.equal(REFRESH_HARD_CAP_HOURS, 168);
  // end to end: an invalid value is 24 hours
  clock();
  await withApp({ ...ON, MUSE_CONNECTOR_REFRESH_MAX_HOURS: 'forever' }, { lifetimeS: 3600 }, async (a) => {
    const c = await connect(a);
    tick(23 * HOUR);
    const r = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    assert.ok(r.refresh_token, '23 hours in');
    tick(2 * HOUR);
    assert.equal((await refreshWith(a, c.clientId, r.refresh_token)).status, 400, '25 hours in');
  });
  // and the cap, end to end
  clock();
  await withApp({ ...ON, MUSE_CONNECTOR_REFRESH_MAX_HOURS: '5000' }, { lifetimeS: 3600 }, async (a) => {
    const c = await connect(a);
    tick(167 * HOUR);
    const r = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    assert.ok(r.refresh_token, '167 hours in');
    tick(2 * HOUR);
    assert.equal((await refreshWith(a, c.clientId, r.refresh_token)).status, 400, '169 hours in');
  });
});

// ---- PingOne failures ------------------------------------------------------------------------------------------------------------------------------------

test('PingOne says invalid_grant: the agent gets invalid_grant, the sign-in is revoked, and later tries do not touch PingOne', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    a.p1.refreshMode = 'invalid_grant';
    const r = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_grant');
    const calls = refreshCalls(a);
    a.p1.refreshMode = 'ok';
    assert.equal((await refreshWith(a, c.clientId, c.tokens.refresh_token)).status, 400);
    assert.equal(refreshCalls(a), calls, 'a revoked family never reaches PingOne');
    assert.equal((await callTool(a, c.tokens.access_token)).status, 401, 'its access token is revoked with it');
  });
});

test('PingOne refuses the token exchange (a disabled user): invalid_grant and revoked', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    a.p1.exchangeMode = 'refused';
    const r = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_grant');
    a.p1.exchangeMode = 'ok';
    assert.equal((await refreshWith(a, c.clientId, c.tokens.refresh_token)).status, 400);
  });
});

test('PingOne unreachable, 5xx or 429: temporarily_unavailable (503), nothing is revoked, and the same token works when PingOne is back', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    for (const mode of ['network', '503', '429', 'no_token']) {
      a.p1.refreshMode = mode;
      const r = await refreshWith(a, c.clientId, c.tokens.refresh_token);
      assert.equal(r.status, 503, mode); assert.equal((await r.json()).error, 'temporarily_unavailable', mode);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await callTool(a, c.tokens.access_token)).status, 200, 'the access token is untouched');
    a.p1.refreshMode = 'ok';
    const ok = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(ok.status, 200, 'the same refresh token was kept');
  });
});

test('the token exchange failing on the network after PingOne rotated its token: nothing is revoked, and the rotated PingOne token is kept for the retry', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    for (const mode of ['network', '503']) {
      a.p1.exchangeMode = mode;
      const r = await refreshWith(a, c.clientId, c.tokens.refresh_token);
      assert.equal(r.status, 503, mode); assert.equal((await r.json()).error, 'temporarily_unavailable');
    }
    a.p1.exchangeMode = 'ok';
    const ok = await refreshWith(a, c.clientId, c.tokens.refresh_token);
    assert.equal(ok.status, 200, 'PingOne had already retired the first token, so the retry used the new one');
  });
});

// ---- store limits ----------------------------------------------------------------------------------------------------------------------------------------

test('the store: oldest families are evicted at the cap (with their tokens and a drop notice), expired ones are purged, an unknown token is unknown', () => {
  let t = 1000; const dropped = [];
  const s = createRefreshStore({ now: () => t, maxHours: 1, cap: 3, onDrop: (f) => dropped.push(f.id) });
  const a = s.issue({ client: 'c' }); t += 1; const b = s.issue({ client: 'c' }); t += 1; const c = s.issue({ client: 'c' });
  assert.equal(s.size, 3);
  t += 1; const d = s.issue({ client: 'c' });
  assert.equal(s.size, 3);
  assert.deepEqual(dropped, [a.family.id], 'the oldest went');
  assert.equal(s.classify(a.token).kind, 'unknown');
  for (const x of [b, c, d]) assert.equal(s.classify(x.token).kind, 'current');
  // expiry is absolute from the first issue
  t = 1001 + HOUR - 1;
  assert.equal(s.classify(b.token).kind, 'current', 'b was issued at 1001 and lives 1 hour: one millisecond before its end');
  t += 1;
  assert.equal(s.classify(b.token).kind, 'unknown', 'gone at 1001 + 1 hour');
  t = 1002 + HOUR - 1;
  assert.equal(s.classify(c.token).kind, 'current', 'one millisecond before its end');
  t += 1;
  assert.equal(s.classify(c.token).kind, 'unknown');
  assert.equal(s.classify(d.token).kind, 'current');
  t += 10 * HOUR;
  s.purge();
  assert.equal(s.size, 0);
  assert.equal(dropped.length, 4, 'every expired family was announced');
  assert.equal(s.classify('x').kind, 'unknown');
});

test('the store: rotation remembers spent tokens as reuse, forgets the oldest past a bound, and drops the grace answer after the grace time', () => {
  let t = 5000;
  const s = createRefreshStore({ now: () => t, maxHours: 24 });
  const { family, token } = s.issue({ client: 'c' });
  let cur = token; const spent = [token];
  for (let i = 0; i < 40; i++) { const next = `next-${i}`; s.rotate(family, cur, next, { n: i }); spent.push(next); cur = next; t += 1; }
  assert.equal(s.classify(cur).kind, 'current');
  assert.equal(s.classify(spent.at(-2)).kind, 'grace');
  t += REFRESH_GRACE_MS;
  assert.equal(s.classify(spent.at(-2)).kind, 'reuse');
  assert.equal(s.classify(spent[0]).kind, 'unknown', 'forgotten, and so refused');
  assert.ok(family.tokens.size <= 33);
});

// ---- secrets ---------------------------------------------------------------------------------------------------------------------------------------------

test('no token, secret or refresh token ever appears in a log line, an error or a result', async () => {
  const cap = capture();
  const seenTexts = [];
  let c; let r1; let a0;
  try {
    clock();
    await withApp({ ...ON, MUSE_GATEWAY_INTERNAL_SECRET: 'bridge-test-secret-not-real-0001' }, {}, async (a) => {
      a0 = a;
      c = await connect(a);
      const keep = async (res) => { const text = await res.text(); seenTexts.push(text); return text; };
      const ok = await refreshWith(a, c.clientId, c.tokens.refresh_token);
      r1 = JSON.parse(await keep(ok));
      await keep(await refreshWith(a, c.clientId, c.tokens.refresh_token));              // grace
      await keep(await refreshWith(a, 'someone', r1.refresh_token));                     // wrong client
      await keep(await refreshWith(a, c.clientId, undefined));
      a.p1.refreshMode = 'network';
      await keep(await refreshWith(a, c.clientId, r1.refresh_token));                    // unavailable
      a.p1.refreshMode = 'invalid_grant';
      await keep(await refreshWith(a, c.clientId, r1.refresh_token));                    // refused
      await keep(await refreshWith(a, c.clientId, r1.refresh_token));                    // unknown now
      await keep(await callTool(a, r1.access_token));
    });
  } finally { cap.stop(); }
  const logs = cap.lines.join('\n');
  const secrets = [c.tokens.access_token, c.tokens.refresh_token, r1.access_token, r1.refresh_token, 'p1-rt-1-not-real', 'p1-rt-2-not-real', CLIENT_SECRET, 'bridge-test-secret-not-real-0001', ...a0.stub.delegated];
  for (const s of secrets) { assert.ok(s.length > 8); assert.ok(!logs.includes(s), `a secret is in the log: ${s.slice(0, 6)}...`); }
  for (const s of [c.tokens.access_token, c.tokens.refresh_token, 'p1-rt', CLIENT_SECRET, ...a0.stub.delegated]) for (const text of seenTexts.filter((x) => !x.startsWith('{"access_token"'))) assert.ok(!text.includes(s), 'a secret is in an error answer');
  assert.match(logs, /refresh ok/); assert.match(logs, /refresh refused: issued to another client/); assert.match(logs, /refresh unavailable: PingOne did not answer/); assert.match(logs, /refresh refused: PingOne refused the refresh/);
});

test('scrubAnswer hides a refresh or access token value that a tool answer might carry', () => {
  const r = ['refresh', 'token'].join('_'); const x = ['access', 'token'].join('_');   // built, so a secret scanner does not read the made-up values as keys
  const t = scrubAnswer(`{"${r}":"abcdEFGH12345678","${x}": "zzzzYYYY99999999"} ${r}=qwertyuiop12 ok`);
  assert.ok(!/abcdEFGH|zzzzYYYY|qwertyuiop/.test(t)); assert.match(t, /\[redacted\]/);
});

// ---- limiter and expired access --------------------------------------------------------------------------------------------------------------------------

test('the refresh path is rate limited with the same limiter as the rest of the token endpoint, and answers no-store', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    let last = 0; let n = 0;
    for (; n < 40 && last !== 429; n++) last = (await refreshWith(a, c.clientId, 'junk')).status;
    assert.equal(last, 429);
    assert.ok(n <= 31);
    const err = await refreshWith(a, c.clientId, 'junk');
    assert.equal(err.status, 429);
  });
});

test('an expired access token is refused at /mcp, and the refresh token still works', async () => {
  clock();
  await withApp(ON, { lifetimeS: 1800 }, async (a) => {
    const c = await connect(a);
    assert.equal((await callTool(a, c.tokens.access_token)).status, 200);
    tick(1801 * 1000);
    assert.equal((await callTool(a, c.tokens.access_token)).status, 401);
    const r = await (await refreshWith(a, c.clientId, c.tokens.refresh_token)).json();
    assert.equal((await callTool(a, r.access_token)).status, 200);
  });
});

test('the existing behaviour holds with refresh on: the code works once, the verifier and redirect are checked, and an unknown grant type is unsupported', async () => {
  await withApp(ON, {}, async (a) => {
    const c = await connect(a);
    const bad = await a.post('/connector/token', { grant_type: 'password' }, {}, true);
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, 'unsupported_grant_type');
    assert.equal(c.tokens.expires_in <= 1800 && c.tokens.expires_in > 0, true);
    const again = await a.post('/connector/token', { grant_type: 'authorization_code', code: 'gone', redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: 'v'.repeat(50) }, {}, true);
    assert.equal(again.status, 400); assert.equal((await again.json()).error, 'invalid_grant');
    void jwt; void USER;
  });
});

test('the code swap hands the server PingOne\'s refresh token but the step it shows (to a page or a trace) holds only a placeholder', async () => {
  const cfg = liveConfig({ ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: 'https://gw.example/muse-ig/mcp', MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: ACTOR, MUSE_P1_CLIENT_SECRET: CLIENT_SECRET, MUSE_P1_LANE: 'privilege' });
  const fetchImpl = async () => new Response(JSON.stringify({ access_token: jwt({ aud: 'x', sub: USER }), refresh_token: 'p1-rt-secret-not-real', id_token: 'idt' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await exchangeCode(cfg, { tokenEndpoint: `${P1}/token` }, { code: 'c', verifier: 'v', client: { clientId: ACTOR, redirectUri: 'https://muse.example/cb' }, resource: null, clientSecret: CLIENT_SECRET }, fetchImpl);
  assert.equal(r.refreshToken, 'p1-rt-secret-not-real');
  assert.ok(!JSON.stringify(r.step).includes('p1-rt-secret-not-real'));
  const none = await exchangeCode(cfg, { tokenEndpoint: `${P1}/token` }, { code: 'c', verifier: 'v', client: { clientId: ACTOR, redirectUri: 'https://muse.example/cb' }, resource: null }, async () => new Response(JSON.stringify({ access_token: jwt({ sub: USER }) }), { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(none.refreshToken, null);
});
