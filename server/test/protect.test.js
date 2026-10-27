import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProtect } from '../src/protect.js';

const LIVE = { PROTECT_MODE: 'live', PROTECT_FLOW_URL: 'https://flow.example/start', PROTECT_API_KEY: 'k', PROTECT_RISK_POLICY_ID: 'policy-1' };
const reply = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body });

test('mock is the default and needs no config', async () => {
  const p = createProtect({});
  assert.equal(p.mode, 'mock');
  assert.equal((await p.assess('muse')).actor, 'agent');
  assert.equal((await p.assess('browser')).actor, 'human');
});

test('live mode is refused in the hosted build and without config', () => {
  assert.throws(() => createProtect({ ...LIVE, MUSE_HOSTED: '1' }), /owner-run/);
  assert.throws(() => createProtect({ ...LIVE, PROTECT_API_KEY: '' }), /API_KEY/);
  assert.throws(() => createProtect({ ...LIVE, PROTECT_FLOW_URL: 'http://flow.example/x' }), /https/);
});

test('live: LOW risk keeps the declared channel; the request carries Muse as the agent client', async () => {
  let sent;
  const p = createProtect(LIVE, { fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return reply({ protectRiskLevel: 'LOW', protectPredictor: 'NONE', protectRiskEvalId: 'e1' })(); } });
  const v = await p.assess('muse', { userName: 'sam', sessionId: 'abc' });
  assert.equal(v.actor, 'agent');
  assert.ok(!v.deny);
  assert.match(sent.userAgent, /Muse-Agent/);
  assert.equal(sent.p1ProtectRiskPolicyId, 'policy-1');
  assert.ok(v.signals.includes('Protect risk level: LOW'));
});

test('live: the flow can name the caller, and HIGH risk is denied', async () => {
  const human = await createProtect(LIVE, { fetchImpl: reply({ protectRiskLevel: 'LOW', caller: 'human' }) }).assess('muse');
  assert.equal(human.actor, 'human');
  const high = await createProtect(LIVE, { fetchImpl: reply({ protectRiskLevel: 'HIGH', protectPredictor: 'CHALLENGE' }) }).assess('browser');
  assert.equal(high.deny, true);
});

test('live: failure fails closed', async () => {
  for (const f of [reply({}, 500), reply({ nope: 1 }), async () => { throw new Error('down'); }]) {
    const v = await createProtect(LIVE, { fetchImpl: f }).assess('browser');
    assert.equal(v.deny, true);
    assert.match(v.rule, /blocked/);
  }
});
