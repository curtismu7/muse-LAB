// The in-cluster gateway address: plain http to a single-label name (http://ping-gateway:8080/mcp) is allowed ONLY on a hosted build that opts in.
// Everything runs against in-process stubs. No real service, host, tenant or token is involved (names are placeholders).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { inClusterGatewayOk, liveConfig } from '../src/discovery.js';

const IN = 'http://ping-gateway:8080/mcp';
// A hosted real-mode build with the in-cluster opt-in. liveConfig() takes the gateway URL from here.
const HOSTED = { ALLOW_LIVE: '1', MUSE_HOSTED: '1', MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_PUBLIC_URL: 'https://muse.example', MUSE_ALLOW_LIVE_INCLUSTER: '1' };
const withUrl = (url, extra = {}) => liveConfig({ ...HOSTED, MUSE_LIVE_GATEWAY_URL: url, ...extra });
const LOCAL = { ALLOW_LIVE: '1' };

test('unchanged rules: https and loopback http still work, with or without the in-cluster flag', () => {
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: 'https://gw.example/muse-ig/mcp' }).origin, 'https://gw.example');
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: 'http://127.0.0.1:5000/mcp' }).origin, 'http://127.0.0.1:5000');
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: 'http://localhost:5000/mcp' }).origin, 'http://localhost:5000');
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: 'http://[::1]:5000/mcp' }).origin, 'http://[::1]:5000');
  assert.equal(withUrl('https://gw.example/muse-ig/mcp').origin, 'https://gw.example');
  assert.equal(withUrl('http://127.0.0.1:5000/mcp').origin, 'http://127.0.0.1:5000');
  // Plain http to anything else is still refused.
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: 'http://gw.example/mcp' }), null);
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: IN }), null, 'single label, no flag, not hosted');
  assert.equal(liveConfig({ ...LOCAL, MUSE_LIVE_GATEWAY_URL: 'ftp://ping-gateway/mcp' }), null);
});

test('a single-label http gateway is accepted only with MUSE_ALLOW_LIVE_INCLUSTER=1 AND MUSE_HOSTED=1', () => {
  const c = withUrl(IN);
  assert.ok(c, 'flag and hosted: accepted');
  assert.equal(c.url, IN);
  assert.equal(c.origin, 'http://ping-gateway:8080');
  assert.deepEqual([...c.allow], ['http://ping-gateway:8080'], 'only that one origin is allowed');
  assert.equal(c.publicUrl, 'https://muse.example');
  // The flag must be exactly '1'.
  for (const v of ['true', '0', ' 1', '1 ', 'yes', 'on', '01', '', undefined]) {
    assert.equal(withUrl(IN, { MUSE_ALLOW_LIVE_INCLUSTER: v }), null, `flag ${JSON.stringify(v)}`);
  }
  const noFlag = { ...HOSTED, MUSE_LIVE_GATEWAY_URL: IN }; delete noFlag.MUSE_ALLOW_LIVE_INCLUSTER;
  assert.equal(liveConfig(noFlag), null, 'flag unset');
  // MUSE_HOSTED must be exactly '1' (a build that is not hosted never takes the in-cluster path).
  for (const v of ['true', '0', ' 1', '', undefined]) {
    assert.equal(withUrl(IN, { MUSE_HOSTED: v }), null, `hosted ${JSON.stringify(v)}`);
  }
  // The helper itself, so each condition is pinned on its own rather than through liveConfig's other gates.
  const u = new URL(IN);
  assert.equal(inClusterGatewayOk(u, { MUSE_ALLOW_LIVE_INCLUSTER: '1', MUSE_HOSTED: '1' }), true);
  assert.equal(inClusterGatewayOk(u, { MUSE_HOSTED: '1' }), false);
  assert.equal(inClusterGatewayOk(u, { MUSE_ALLOW_LIVE_INCLUSTER: '1' }), false);
  assert.equal(inClusterGatewayOk(u, { MUSE_ALLOW_LIVE_INCLUSTER: 'true', MUSE_HOSTED: '1' }), false);
  assert.equal(inClusterGatewayOk(u, { MUSE_ALLOW_LIVE_INCLUSTER: '1', MUSE_HOSTED: 'true' }), false);
  // Hosted real mode keeps its own gates (opt-in and an https public address): the in-cluster flag replaces none of them.
  assert.equal(withUrl(IN, { MUSE_ALLOW_LIVE_HOSTED: undefined }), null);
  assert.equal(withUrl(IN, { MUSE_PUBLIC_URL: 'http://muse.example' }), null);
  assert.equal(withUrl(IN, { MODE: 'mock' }), null);
  assert.equal(withUrl(IN, { ALLOW_LIVE: undefined }), null);
});

test('only a single DNS label qualifies: dotted names, IP addresses in any form, IPv6 and look-alikes are refused', () => {
  const refused = [
    'http://ping-gateway.ns.svc:8080/mcp', 'http://ping-gateway.ns.svc.cluster.local/mcp', 'http://example.com/mcp', 'http://example.com:8080/mcp',
    'http://10.0.0.1/mcp', 'http://10/mcp', 'http://10.1/mcp', 'http://0x0a000001/mcp', 'http://167772161/mcp', 'http://012.0.0.1/mcp', 'http://169.254.169.254/latest',
    'http://[fd00::1]:8080/mcp', 'http://[::ffff:10.0.0.1]/mcp', 'http://[::ffff:a00:1]/mcp',
    'http://user:pw@ping-gateway:8080/mcp', 'http://user@ping-gateway:8080/mcp', 'http://:pw@ping-gateway:8080/mcp',
    'http://ping_gateway:8080/mcp', 'http://ping%5Fgateway:8080/mcp', 'http://-ping:8080/mcp', 'http://ping-:8080/mcp',
    `http://${'a'.repeat(64)}:8080/mcp`, 'http://:8080/mcp', 'http://ping-gateway.:8080/mcp', 'http://ping-gateway..:8080/mcp', 'http://ping gateway:8080/mcp',
    '', 'ping-gateway:8080/mcp', 'ping-gateway',
  ];
  for (const url of refused) {
    // 127.x forms normalise to loopback, which the older loopback rule already accepted; none of the cases here do.
    assert.equal(withUrl(url), null, JSON.stringify(url));
  }
  // Loopback forms are not the in-cluster rule: the helper refuses them, and liveConfig accepts them only through the older loopback rule (so they work with no flag at all).
  for (const url of ['http://[::1]:8080/mcp', 'http://0x7f.1/mcp', 'http://127.1/mcp', 'http://2130706433/mcp']) {
    assert.equal(inClusterGatewayOk(new URL(url), { MUSE_ALLOW_LIVE_INCLUSTER: '1', MUSE_HOSTED: '1' }), false, `${url}: not an in-cluster name`);
  }
  assert.equal(inClusterGatewayOk(new URL('http://localhost:8080/mcp'), { MUSE_ALLOW_LIVE_INCLUSTER: '1', MUSE_HOSTED: '1' }), true, 'localhost IS a single label (the old loopback rule accepts it anyway)');
  // https to a single label is not the in-cluster rule; it falls under the ordinary https rule (unchanged).
  assert.ok(withUrl('https://ping-gateway:8443/mcp'));
});

test('single-label forms that are accepted: case, length, digits-with-letters, ports and paths', () => {
  assert.equal(withUrl('http://PING-Gateway:8080/mcp').origin, 'http://ping-gateway:8080', 'the URL parser lowercases the label');
  assert.ok(withUrl(`http://${'a'.repeat(63)}:8080/mcp`), '63 characters is the longest label');
  assert.ok(withUrl('http://a:8080/mcp'), 'one character');
  assert.ok(withUrl('http://gw-1:8080/mcp'));
  assert.ok(withUrl('http://1gw:8080/mcp'), 'digits first is fine when a letter is present');
  assert.ok(withUrl('http://gw1:8080/mcp'));
  assert.equal(withUrl('http:///mcp').origin, 'http://mcp', 'the URL parser reads the empty host as the first path segment, so this is the single label mcp: still cluster-internal');
  // Ports: this rule says nothing about the port, so any port the URL parser accepts follows.
  assert.equal(withUrl('http://ping-gateway/mcp').origin, 'http://ping-gateway');
  assert.equal(withUrl('http://ping-gateway:80/mcp').origin, 'http://ping-gateway', ':80 is the default http port and is dropped');
  assert.equal(withUrl('http://ping-gateway:0/mcp').origin, 'http://ping-gateway:0', ':0 parses; it fails at connect time, not here');
  assert.equal(withUrl('http://ping-gateway:99999/mcp'), null, 'not a port');
  assert.equal(withUrl('http://ping-gateway:abc/mcp'), null);
  // Paths and query strings are the gateway URL as given.
  assert.equal(withUrl('http://ping-gateway:8080/').url, 'http://ping-gateway:8080/');
  assert.equal(withUrl('http://ping-gateway:8080/muse-ig/mcp').url, 'http://ping-gateway:8080/muse-ig/mcp');
  assert.equal(withUrl('http://ping-gateway:8080/mcp?x=1').url, 'http://ping-gateway:8080/mcp?x=1');
});

test('a purely numeric label never qualifies (checked on the helper, because the URL parser turns it into an IPv4 address first)', () => {
  const env = { MUSE_ALLOW_LIVE_INCLUSTER: '1', MUSE_HOSTED: '1' };
  const fake = (hostname) => ({ protocol: 'http:', username: '', password: '', hostname });
  assert.equal(inClusterGatewayOk(fake('gw'), env), true, 'the fake object is shaped like a URL');
  assert.equal(inClusterGatewayOk(fake('1234'), env), false);
  assert.equal(inClusterGatewayOk(fake('0'), env), false);
  assert.equal(new URL('http://1234/mcp').hostname, '0.0.4.210', 'what the parser does to it');
  assert.equal(withUrl('http://1234/mcp'), null);
  assert.equal(withUrl('http://0/mcp'), null);
  assert.equal(inClusterGatewayOk(fake('a.b'), env), false);
  assert.equal(inClusterGatewayOk(fake('[::1]'), env), false);
  assert.equal(inClusterGatewayOk(fake(''), env), false);
  assert.equal(inClusterGatewayOk({ ...fake('gw'), protocol: 'https:' }, env), false, 'the rule is for http only');
  assert.equal(inClusterGatewayOk({ ...fake('gw'), username: 'u' }, env), false);
  assert.equal(inClusterGatewayOk({ ...fake('gw'), password: 'p' }, env), false);
});

test('the extra-origins list stays https only, whatever the in-cluster flag says', () => {
  const c = withUrl(IN, { MUSE_LIVE_ALLOW_ORIGINS: 'http://other-svc:8080, https://extra.example, http://10.0.0.1' });
  assert.deepEqual([...c.allow].sort(), ['http://ping-gateway:8080', 'https://extra.example']);
});

// ---- End to end: a connector booking call goes to the in-cluster address through a stub fetch ----------------------------------------------------
const P1 = 'https://auth.pingone.com/env1/as';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const DELEGATED = jwt({ iss: P1, aud: 'priv-nhi-x', sub: 'sam', act: { sub: 'c1' }, exp: Math.floor(Date.now() / 1000) + 1800 });
const REDIRECT = 'https://chat.agent.example/oauth/callback';
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

async function bootConnector(extra) {
  const port = await freePort(); const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url) === `${P1}/token`) {
      const f = new URLSearchParams(init.body);
      return json(200, { access_token: f.get('grant_type') === 'authorization_code' ? jwt({ aud: 'x', sub: 'sam' }) : DELEGATED });
    }
    if (String(url) !== IN) throw new Error(`unexpected ${url}`);
    const m = JSON.parse(init.body);
    if (m.method === 'tools/call') return json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ booked: true, confirmationNumber: 'CONF-TEST-1', fare: 180 }) }] } });
    return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
  };
  const env = {
    ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: IN, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'c1', MUSE_P1_CLIENT_SECRET: 'sekret', MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1',
    MUSE_HOSTED: '1', MUSE_ALLOW_LIVE_HOSTED: '1', MUSE_ALLOW_LIVE_LOOPBACK: '1', MUSE_PUBLIC_URL: `http://127.0.0.1:${port}`, MUSE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    MUSE_CONNECTOR_REDIRECT_HOSTS: 'agent.example', ...extra,
  };
  const server = createApp(env, { fetchImpl }).listen(port, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}, form = false) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  return { base, seen, post, close: () => new Promise((r) => server.close(r)) };
}
async function connect(a) {
  const reg = await (await a.post('/connector/register', { redirect_uris: [REDIRECT] })).json();
  const verifier = 'v'.repeat(50);
  const au = await fetch(`${a.base}/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  const flow = new URL(au.headers.get('location')).searchParams.get('flow');
  const done = await (await a.post('/connector/signin/complete', { state: flow, code: 'pingone-code' })).json();
  const code = new URL(done.redirectTo).searchParams.get('code');
  const tj = await (await a.post('/connector/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }, {}, true)).json();
  return { authorization: `Bearer ${tj.access_token}` };
}

test('end to end: with the flag set, a connector booking call is sent to http://ping-gateway:8080/mcp', async () => {
  const a = await bootConnector({ MUSE_ALLOW_LIVE_INCLUSTER: '1' });
  try {
    const auth = await connect(a);
    const r = await (await a.post('/mcp', { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'book_flight', arguments: { destination: 'Boston' } } }, auth)).json();
    const calls = a.seen.filter((x) => x.url === IN).map((x) => JSON.parse(x.init.body));
    assert.ok(calls.some((m) => m.method === 'tools/call'), 'the booking tools/call reached the in-cluster address');
    assert.ok(a.seen.every((x) => x.url === IN || x.url === `${P1}/token`), 'nothing else was contacted');
    assert.equal(a.seen.find((x) => x.url === IN).init.redirect, 'manual', 'redirects are still not followed');
    assert.match(r.result.content[0].text, /Booked/i);
  } finally { await a.close(); }
});

test('end to end: without the flag, live is off and the gateway is never contacted', async () => {
  const a = await bootConnector({});
  try {
    assert.equal(a.seen.length, 0);
    const r = await fetch(`${a.base}/api/session`);
    assert.equal((await r.json()).live.available, false, 'live mode is off');
    assert.equal((await a.post('/connector/register', { redirect_uris: [REDIRECT] })).status, 404, 'no connector without live mode');
    assert.equal(a.seen.length, 0, 'no outbound call at all');
  } finally { await a.close(); }
});
