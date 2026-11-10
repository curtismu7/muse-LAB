import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { DEFAULT_AIRLINE, TOKEN_AUTH, connectorInfo, isPublicHost } from '../src/connectorInfo.js';
import { connectorConfig } from '../src/connector.js';
import { liveConfig } from '../src/discovery.js';

// GET /api/connector/info: public facts only. Every value here is invented; the secrets below must appear in no response.
const GW = 'https://gw.example/muse-ig/mcp';
const IDP_SECRET = 'idp-secret-not-real-7f3a';
const BRIDGE_SECRET = 'bridge-secret-not-real-91bc';
const AGENT_SECRET = 'agent-app-secret-not-real-5d20';
const WORKER_SECRET = 'worker-secret-not-real-aa41';
const REDIRECT = 'https://chat.agent.example/oauth/callback';
const BASE = {
  ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: '00000000-0000-0000-0000-0000000000e1', MUSE_P1_CLIENT_ID: '00000000-0000-0000-0000-0000000000a1',
  MUSE_P1_CLIENT_SECRET: IDP_SECRET, MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1', MUSE_PUBLIC_URL: 'https://muse.example',
  MUSE_GATEWAY_INTERNAL_SECRET: BRIDGE_SECRET, MUSE_TIER_WORKER_CLIENT_SECRET: WORKER_SECRET,
  MUSE_CONNECTOR_AGENTS: JSON.stringify([{ name: 'ChatGPT', hosts: ['chatgpt.example'], clientId: '00000000-0000-0000-0000-0000000000a2', clientSecret: AGENT_SECRET }]),
};

async function boot(env) {
  const server = createApp(env, { fetchImpl: async (u) => { throw new Error(`no outbound call expected: ${u}`); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ } return { s: r.status, j, text }; };
  return { get, close: () => new Promise((r) => server.close(r)) };
}

test('the info has exactly the public fields, with the static client, the redirect URIs, the four tools and the airline name', async () => {
  const a = await boot({ ...BASE, MUSE_CONNECTOR_AIRLINE: 'Blue Yonder', MUSE_CONNECTOR_CLIENT_ID: 'airline-connector', MUSE_CONNECTOR_REDIRECT_URIS: `${REDIRECT}, https://chat2.agent.example/cb` });
  try {
    const r = await a.get('/api/connector/info');
    assert.equal(r.s, 200);
    assert.deepEqual(Object.keys(r.j).sort(), ['airline', 'clientId', 'publicReachable', 'redirectUris', 'scope', 'tokenAuth', 'tools', 'url']);
    assert.deepEqual(r.j, {
      url: 'https://muse.example/mcp', clientId: 'airline-connector', tokenAuth: TOKEN_AUTH, scope: 'mcp',
      redirectUris: [REDIRECT, 'https://chat2.agent.example/cb'], airline: 'Blue Yonder', publicReachable: true,
      tools: ['loyalty_balance', 'get_loyalty_status', 'list_flights', 'book_flight'],
    });
    assert.equal(TOKEN_AUTH, 'none (public client, PKCE S256)');
  } finally { await a.close(); }
});

test('with no static client or airline: clientId null, no redirect URIs, the demo airline name', async () => {
  const a = await boot(BASE);
  try {
    const r = await a.get('/api/connector/info');
    assert.equal(r.s, 200);
    assert.deepEqual([r.j.clientId, r.j.redirectUris, r.j.airline], [null, [], DEFAULT_AIRLINE]);
  } finally { await a.close(); }
});

test('no secret, token or internal setting is in the response, whatever is configured', async () => {
  const a = await boot({ ...BASE, MUSE_CONNECTOR_CLIENT_ID: 'airline-connector', MUSE_CONNECTOR_REDIRECT_URIS: REDIRECT, MUSE_CONNECTOR_AIRLINE: 'SkyHigh' });
  try {
    const r = await a.get('/api/connector/info');
    for (const s of [IDP_SECRET, BRIDGE_SECRET, AGENT_SECRET, WORKER_SECRET, BASE.MUSE_P1_CLIENT_ID, BASE.MUSE_P1_ENV_ID, 'gw.example', 'pingone', 'access_token', 'Bearer']) {
      assert.ok(!r.text.includes(s), `the response must not contain ${s}`);
    }
  } finally { await a.close(); }
});

test('404 connector_not_enabled when the connector is off or Real is not configured', async () => {
  const off = await boot({ ...BASE, MUSE_CONNECTOR: '0' });
  try { assert.deepEqual(await off.get('/api/connector/info').then((r) => [r.s, r.j.error]), [404, 'connector_not_enabled']); } finally { await off.close(); }
  const mock = await boot({});
  try { assert.deepEqual(await mock.get('/api/connector/info').then((r) => [r.s, r.j.error]), [404, 'connector_not_enabled']); } finally { await mock.close(); }
});

test('publicReachable matrix on the public URL', () => {
  const reach = (publicUrl) => {
    const env = { ...BASE, MUSE_PUBLIC_URL: publicUrl };
    const cfg = connectorConfig(env, liveConfig(env));
    return cfg ? connectorInfo({ url: `${cfg.publicUrl}/mcp`, scope: 'mcp', airline: null }, env, liveConfig(env)).publicReachable : 'refused';
  };
  const no = ['http://localhost:5100', 'http://127.0.0.1:5102', 'http://[::1]:5100', 'https://muse.local', 'https://x.muse.local', 'https://muse.ping.demo', 'https://a.b.ping.demo',
    'https://local.ping-devops.com:8443/muse', 'https://10.1.2.3', 'https://192.168.0.5', 'https://172.16.4.4', 'https://172.31.255.1', 'https://169.254.1.1', 'https://muse', 'https://app.localhost', 'https://app.internal', 'https://printer.lan'];
  for (const u of no) assert.equal(reach(u), false, u);
  const yes = ['https://muse.example', 'https://muse.example/base', 'https://muse.team-demo.example:8443', 'https://203.0.113.9', 'https://172.32.0.1', 'https://172.15.0.1', 'https://local.ping-devops.com.example'];
  for (const u of yes) assert.equal(reach(u), true, u);
  assert.equal(reach('http://muse.example'), 'refused', 'plain http is only for loopback, so the connector would not even start');
});

test('isPublicHost handles odd input without throwing', () => {
  for (const h of [undefined, null, '', ' ', '[]', '.', '999.1.1.1', '::', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1']) assert.equal(isPublicHost(h), false, String(h));
  assert.equal(isPublicHost('2001:db8::1'), true);
  assert.equal(isPublicHost('MUSE.EXAMPLE.'), true);
});
