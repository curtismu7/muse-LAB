// The owner-run script that enables the refresh grant on a PingOne application: its planning and its run, against a stub PingOne API. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRefresh, run, verifyApplied } from '../../scripts/enable-pingone-refresh.mjs';

const ENV = '00000000-0000-0000-0000-0000000000e1';
const APP = '00000000-0000-0000-0000-0000000000a9';
const CREDS = { PINGONE_ENV_ID: ENV, PINGONE_WORKER_CLIENT_ID: '00000000-0000-0000-0000-0000000000c1', PINGONE_WORKER_CLIENT_SECRET: 'worker-secret-not-real-0004' };
const app = (over = {}) => ({
  id: APP, environment: { id: ENV }, name: 'Muse (stub)', description: 'x', type: 'WEB_APP', protocol: 'OPENID_CONNECT', enabled: true, grantTypes: ['AUTHORIZATION_CODE', 'CLIENT_CREDENTIALS'],
  responseTypes: ['CODE'], tokenEndpointAuthMethod: 'CLIENT_SECRET_POST', redirectUris: ['https://muse.example/connector/callback'], pkceEnforcement: 'OPTIONAL', accessTokenValiditySeconds: 3600,
  refreshTokenDuration: 2592000, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', _links: { self: { href: 'https://api.example/x' } }, ...over,
});

// A stub PingOne: worker token, GET and PUT of one application. `mangle` changes what a PUT stores (to test the read-back check).
function stub({ initial = app(), tokenStatus = 200, putStatus = 200, mangle = null } = {}) {
  const calls = []; let stored = structuredClone(initial);
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); const method = init.method ?? 'GET';
    calls.push({ url: u, method, body: init.body });
    const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u === `https://auth.pingone.com/${ENV}/as/token`) return tokenStatus === 200 ? res(200, { access_token: 'worker-token-not-real' }) : res(tokenStatus, { error: 'invalid_client' });
    if (u === `https://api.pingone.com/v1/environments/${ENV}/applications/${APP}`) {
      assert.equal(init.headers.authorization, 'Bearer worker-token-not-real');
      if (method === 'GET') return res(200, stored);
      if (method === 'PUT') {
        if (putStatus !== 200) return res(putStatus, { code: 'INVALID_VALUE', message: 'refreshTokenDuration is out of range' });
        const body = JSON.parse(init.body);
        stored = { ...body, id: APP, environment: { id: ENV }, createdAt: stored.createdAt, updatedAt: '2026-02-02T00:00:00Z', _links: stored._links, ...(mangle ?? {}) };
        return res(200, stored);
      }
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  return { fetchImpl, calls, get stored() { return stored; } };
}
const go = async (argv, s, env = CREDS) => {
  const lines = []; const saved = [];
  const code = await run({ argv, env, fetchImpl: s.fetchImpl, out: (x) => lines.push(x), saveBefore: (name, text) => { saved.push({ name, text, putsBefore: s.calls.filter((c) => c.method === 'PUT').length }); return `scripts/${name}`; }, now: () => new Date('2026-03-04T05:06:07.890Z') });
  return { code, lines, text: lines.join('\n'), saved };
};

test('planRefresh adds REFRESH_TOKEN, sets the three durations for N hours, keeps every other field and drops only the read-only ones', () => {
  const a = app();
  const p = planRefresh(a, 24);
  assert.equal(p.ok, true);
  assert.deepEqual(p.changes.map((c) => c.field), ['grantTypes', 'refreshTokenDuration', 'refreshTokenRollingDuration', 'refreshTokenRollingGracePeriodDuration']);
  assert.deepEqual(p.body.grantTypes, ['AUTHORIZATION_CODE', 'CLIENT_CREDENTIALS', 'REFRESH_TOKEN']);
  assert.equal(p.body.refreshTokenDuration, 86400); assert.equal(p.body.refreshTokenRollingDuration, 86400); assert.equal(p.body.refreshTokenRollingGracePeriodDuration, 0);
  for (const k of ['id', 'environment', 'createdAt', 'updatedAt', '_links']) assert.ok(!(k in p.body), k);
  for (const [k, v] of Object.entries(a)) if (!['id', 'environment', 'createdAt', 'updatedAt', '_links', 'grantTypes', 'refreshTokenDuration'].includes(k)) assert.deepEqual(p.body[k], v, `${k} is unchanged`);
  assert.equal(planRefresh(a, 168).body.refreshTokenDuration, 168 * 3600);
  assert.equal(planRefresh(a, 0.5).body.refreshTokenDuration, 1800);
  assert.deepEqual(a.grantTypes, ['AUTHORIZATION_CODE', 'CLIENT_CREDENTIALS'], 'the input is not modified');
});

test('planRefresh: nothing to change when it is already set; refuses bad hours, other protocols and applications without the authorization code grant', () => {
  const done = app({ grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN'], refreshTokenDuration: 86400, refreshTokenRollingDuration: 86400, refreshTokenRollingGracePeriodDuration: 0 });
  assert.deepEqual(planRefresh(done, 24).changes, []);
  assert.deepEqual(planRefresh(done, 12).changes.map((c) => c.field), ['refreshTokenDuration', 'refreshTokenRollingDuration']);
  for (const h of [0, -1, 169, NaN, Infinity]) assert.equal(planRefresh(app(), h).ok, false, String(h));
  assert.equal(planRefresh(app({ protocol: 'SAML' }), 24).ok, false);
  assert.equal(planRefresh(app({ grantTypes: ['CLIENT_CREDENTIALS'] }), 24).ok, false);
  assert.equal(planRefresh(null, 24).ok, false); assert.equal(planRefresh([], 24).ok, false);
});

test('verifyApplied flags a field that is not as planned or that changed without being planned', () => {
  const before = app(); const plan = planRefresh(before, 24);
  const good = { ...plan.body, id: APP, updatedAt: 'later' };
  assert.deepEqual(verifyApplied(before, good, plan), []);
  assert.deepEqual(verifyApplied(before, { ...good, refreshTokenDuration: 1 }, plan), ['refreshTokenDuration']);
  assert.deepEqual(verifyApplied(before, { ...good, pkceEnforcement: 'REQUIRED' }, plan), ['pkceEnforcement']);
  assert.deepEqual(verifyApplied(before, { ...good, enabled: undefined }, plan), ['enabled']);
});

test('a dry run (the default) reads the application and shows the plan; it changes nothing and saves nothing', async () => {
  const s = stub();
  const r = await go([APP], s);
  assert.equal(r.code, 0);
  assert.deepEqual(s.calls.map((c) => c.method), ['POST', 'GET']);
  assert.equal(r.saved.length, 0);
  assert.match(r.text, /Dry run: nothing was changed/); assert.match(r.text, /refreshTokenDuration: 2592000 -> 86400/); assert.match(r.text, /REFRESH_TOKEN/);
  assert.deepEqual(s.stored, app());
});

test('--apply saves the BEFORE copy first, then changes only the planned fields, then verifies by reading it back', async () => {
  const s = stub();
  const r = await go([APP, '--apply'], s);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(s.calls.map((c) => c.method), ['POST', 'GET', 'PUT', 'GET']);
  assert.equal(r.saved.length, 1); assert.equal(r.saved[0].putsBefore, 0, 'saved before the PUT');
  assert.equal(r.saved[0].name, `pingone-app-before-${APP}-2026-03-04T05-06-07-890Z.json`);
  assert.deepEqual(JSON.parse(r.saved[0].text), app(), 'the BEFORE copy is the application as it was');
  assert.deepEqual(s.stored.grantTypes, ['AUTHORIZATION_CODE', 'CLIENT_CREDENTIALS', 'REFRESH_TOKEN']);
  assert.equal(s.stored.refreshTokenDuration, 86400); assert.equal(s.stored.redirectUris[0], 'https://muse.example/connector/callback');
  assert.match(r.text, /Verified by reading it back/); assert.match(r.text, /reconnect muse\.ai once/);
});

test('--hours sets the lifetime; the credentials, the worker token and the secret are never printed or saved', async () => {
  const s = stub();
  const r = await go([APP, '--hours', '48', '--apply'], s);
  assert.equal(r.code, 0); assert.equal(s.stored.refreshTokenRollingDuration, 48 * 3600);
  for (const secret of [CREDS.PINGONE_WORKER_CLIENT_SECRET, CREDS.PINGONE_WORKER_CLIENT_ID, 'worker-token-not-real', Buffer.from(`${CREDS.PINGONE_WORKER_CLIENT_ID}:${CREDS.PINGONE_WORKER_CLIENT_SECRET}`).toString('base64')]) {
    assert.ok(!r.text.includes(secret)); assert.ok(!r.saved[0].text.includes(secret));
  }
  const bad = await go([APP, '--hours', '500'], stub());
  assert.equal(bad.code, 1); assert.match(bad.text, /--hours must be above 0 and at most 168/);
  assert.equal((await go([APP, '--hours'], stub())).code, 1);
});

test('already set: nothing is changed and nothing is saved', async () => {
  const s = stub({ initial: app({ grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN'], refreshTokenDuration: 86400, refreshTokenRollingDuration: 86400, refreshTokenRollingGracePeriodDuration: 0 }) });
  const r = await go([APP, '--apply'], s);
  assert.equal(r.code, 0); assert.match(r.text, /Nothing to change/);
  assert.deepEqual(s.calls.map((c) => c.method), ['POST', 'GET']); assert.equal(r.saved.length, 0);
});

test('failures are reported without secrets: missing variables, a bad id, a refused token, a refused change, a read-back that differs', async () => {
  const none = await go([APP], stub(), {});
  assert.equal(none.code, 2); assert.match(none.text, /PINGONE_ENV_ID, PINGONE_WORKER_CLIENT_ID, PINGONE_WORKER_CLIENT_SECRET/);
  assert.equal((await go([APP], stub(), { ...CREDS, PINGONE_ENV_ID: 'not-a-uuid' })).code, 2);
  assert.equal((await go([APP], stub(), { ...CREDS, PINGONE_REGION: 'evil.example/' })).code, 2);
  assert.equal((await go([], stub())).code, 2);
  assert.equal((await go(['not-an-id'], stub())).code, 2);
  const noTok = await go([APP], stub({ tokenStatus: 401 }));
  assert.equal(noTok.code, 1); assert.match(noTok.text, /would not give the worker a token \(HTTP 401\)/); assert.ok(!noTok.text.includes(CREDS.PINGONE_WORKER_CLIENT_SECRET));
  const s = stub({ putStatus: 400 });
  const refused = await go([APP, '--apply'], s);
  assert.equal(refused.code, 1); assert.match(refused.text, /refused the change \(HTTP 400 INVALID_VALUE: refreshTokenDuration is out of range\)/); assert.equal(refused.saved.length, 1, 'the BEFORE copy was kept');
  assert.deepEqual(s.stored, app(), 'nothing changed');
  const odd = await go([APP, '--apply'], stub({ mangle: { refreshTokenDuration: 5 } }));
  assert.equal(odd.code, 1); assert.match(odd.text, /not as planned: refreshTokenDuration/);
  const saml = await go([APP], stub({ initial: app({ protocol: 'SAML' }) }));
  assert.equal(saml.code, 1); assert.match(saml.text, /Cannot plan/);
});

test('the region picks the PingOne hosts, and a name that is not a region is refused', async () => {
  const s = stub();
  const calls = []; const f = s.fetchImpl;
  s.fetchImpl = async (u, i) => { calls.push(String(u)); return f(String(u).replace('.eu/', '.com/').replace('.eu/', '.com/'), i); };
  const r = await go([APP], s, { ...CREDS, PINGONE_REGION: 'eu' });
  assert.equal(r.code, 0);
  assert.ok(calls.every((u) => /^https:\/\/(auth|api)\.pingone\.eu\//.test(u)), calls.join(' '));
});
