// Starts three in-process copies of Muse with stub fetch only. Nothing real is contacted; any unexpected outbound URL throws and is counted.
import { createApp } from '../../server/src/index.js';
import { once } from 'node:events';
const ENV_ID = '00000000-1111-4111-8111-111111111111';
const WORKER = '00000000-2222-4222-8222-222222222222';
const U1 = '00000000-3333-4333-8333-333333333333';
const log = { ok: 0, unexpected: [], writes: 0 };
const json = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const stub = async (input, init = {}) => {
  const u = new URL(String(input));
  if (u.pathname === `/${ENV_ID}/as/token`) { log.ok++; return json(200, { access_token: 'stub-token', expires_in: 3600 }); }
  if (u.pathname === `/v1/environments/${ENV_ID}/users/${U1}`) { if ((init.method ?? 'GET') !== 'GET') log.writes++; log.ok++; return json(200, { id: U1, airlineMemberTier: 'Premier Gold', agentSpendLimit: '750' }); }
  log.unexpected.push(String(input)); throw new Error('stub: unexpected outbound call');
};
const LIVE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: 'https://gw.example/muse-ig/mcp', MUSE_P1_ENV_ID: ENV_ID, MUSE_P1_CLIENT_ID: WORKER, MUSE_P1_CLIENT_SECRET: 'proof-secret-not-real', MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1', MUSE_CONNECTOR_AIRLINE: 'SkyHigh', MUSE_CONNECTOR_CLIENT_ID: 'airline-connector', MUSE_CONNECTOR_REDIRECT_URIS: 'https://chat.agent.example/oauth/callback',
  MUSE_TIER_ENABLE: 'read', MUSE_TIER_WORKER_CLIENT_ID: WORKER, MUSE_TIER_WORKER_CLIENT_SECRET: 'proof-worker-secret-not-real', MUSE_TIER_USER_IDS: U1 };
const apps = [
  [5701, {}],                                                              // Mock
  [5702, { ...LIVE, MUSE_PUBLIC_URL: 'http://127.0.0.1:5702' }],            // Real, local address (warning)
  [5703, { ...LIVE, MUSE_PUBLIC_URL: 'https://muse.example' }],             // Real, public address (no warning)
];
for (const [port, env] of apps) { const s = createApp(env, { fetchImpl: stub }).listen(port, '127.0.0.1'); await once(s, 'listening'); }
console.log('ready');
setInterval(() => {}, 1 << 30);
import http from 'node:http';
http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(log)); }).listen(5799, '127.0.0.1');
