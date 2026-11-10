// The Airline Connector's consent bridge (owner-approved 2026-11-09): for book_flight only, and only when MUSE_GATEWAY_INTERNAL_SECRET is set, the gateway call carries
// x-internal-gateway-secret and X-May-Act-Sub (the actor app's client id). Everything runs against in-process stubs with invented ids and invented secrets: a stub PingOne
// token endpoint and a stub gateway that enforces the trusted-caller rule the way the real gateway's decision script does. Nothing real is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { bookingToolResult } from '../src/connector.js';

const GW = 'https://gw.example/muse-ig/mcp';
const P1 = 'https://auth.pingone.com/00000000-0000-0000-0000-0000000000e1/as';
const ACTOR = '00000000-0000-0000-0000-0000000000a1';
const OTHER_APP = '00000000-0000-0000-0000-0000000000a2';
const SECRET = 'bridge-test-secret-not-real-0001';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const delegatedFor = (actor) => jwt({ iss: P1, aud: 'priv-nhi-x', sub: 'sam', act: { sub: actor }, exp: Math.floor(Date.now() / 1000) + 1800 });
const BASE = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: '00000000-0000-0000-0000-0000000000e1', MUSE_P1_CLIENT_ID: ACTOR, MUSE_P1_CLIENT_SECRET: 'idp-secret-not-real', MUSE_P1_LANE: 'privilege', MUSE_CONNECTOR: '1' };
const REDIRECT = 'https://chat.agent.example/oauth/callback';
const hdr = (h, name) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const keys = (h) => Object.keys(h).map((k) => k.toLowerCase()).sort();

// The stub gateway and PingOne. script.book(args, headers) answers the book_airline_flight call; script.other answers get_loyalty_status.
function stubNet(seen, script) {
  return async (url, init) => {
    if (String(url) === `${P1}/token`) {
      const f = new URLSearchParams(init.body);
      // The delegated token is remembered as minted, so a test compares against it and never rebuilds it (its exp moves with the clock).
      const access = f.get('grant_type') === 'authorization_code' ? jwt({ aud: 'x', sub: 'sam' }) : delegatedFor(f.get('client_id'));
      seen.push({ url: String(url), init, method: 'token', access, grant: f.get('grant_type') });
      return json(200, { access_token: access });
    }
    if (String(url) !== GW) throw new Error(`unexpected ${url}`);
    const m = JSON.parse(init.body);
    seen.push({ url: String(url), init, method: m.method, tool: m.params?.name });
    if (script.throwOnCall && m.method === 'tools/call') throw script.throwOnCall;
    if (m.method === 'tools/call') return m.params.name === 'get_loyalty_status' ? script.other() : script.book(m.params.arguments, init.headers);
    return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
  };
}
const audit = (codes, parameters = {}) => ({ 'x-gw-audit-trail': JSON.stringify({ authorize: { decision: 'DENY', tool: 'book_airline_flight', parameters, statements: codes.map((code) => ({ code, payload: { message: 'The signed-in user has not authorized agent X to act for them on book_airline_flight.' } })) } }) });
const bookedBody = { result: { content: [{ type: 'text', text: JSON.stringify({ booked: true, confirmationNumber: 'CONF-TEST-1', fare: 180 }) }] } };

// What the real gateway's decision script does with the consent: the header is honoured only from a caller presenting the shared secret (constant-time compare); native may_act is absent in this token.
function enforcing(secret, actClientId, next) {
  return (args, headers) => {
    const presented = Buffer.from(String(hdr(headers, 'x-internal-gateway-secret') ?? ''));
    const expected = Buffer.from(secret);
    const trusted = presented.length === expected.length && timingSafeEqual(presented, expected);
    const mayActSub = trusted ? String(hdr(headers, 'X-May-Act-Sub') ?? '') : '';
    if (!mayActSub) return json(403, { error: 'access_denied' }, audit(['no_user_consent'], { MayActSub: '', ActClientId: actClientId }));
    if (mayActSub !== actClientId) return json(403, { error: 'access_denied' }, audit(['may_act_mismatch'], { MayActSub: mayActSub, ActClientId: actClientId }));
    return next(args);
  };
}

async function boot(extra = {}, { redirect = REDIRECT } = {}) {
  // Listen on port 0 first and attach the app afterwards, so no other test process can take the port in between.
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; const seen = [];
  const script = { book: () => json(200, bookedBody), other: () => json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ loyaltyPoints: 1200, loyaltyTier: 'Silver', name: 'Sam', passengerRef: 'P-1' }) }] } }) };
  const env = { ...BASE, MUSE_PUBLIC_URL: `http://127.0.0.1:${port}`, MUSE_CONNECTOR_REDIRECT_HOSTS: 'agent.example', ...extra };
  server.on('request', createApp(env, { fetchImpl: stubNet(seen, script) }));
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}, form = false) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  const reg = await (await post('/connector/register', { redirect_uris: [redirect] })).json();
  const verifier = 'v'.repeat(50);
  const au = await fetch(`${base}/connector/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  const flow = new URL(au.headers.get('location')).searchParams.get('flow');
  const done = await (await post('/connector/signin/complete', { state: flow, code: 'pingone-code' })).json();
  const code = new URL(done.redirectTo).searchParams.get('code');
  const tj = await (await post('/connector/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }, {}, true)).json();
  const auth = { authorization: `Bearer ${tj.access_token}` };
  let n = 10;
  const rpc = async (method, params) => (await post('/mcp', { jsonrpc: '2.0', id: n++, method, params }, auth)).json();
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const gw = () => seen.filter((x) => x.url === GW);
  return { base, seen, script, gw, call, rpc, close: () => new Promise((r) => server.close(r)) };
}
const text = (r) => r.result.content.map((c) => c.text).join('\n');
const capture = async (fn) => { const lines = []; const o = console.log; const w = console.warn; console.log = (...x) => lines.push(x.join(' ')); console.warn = (...x) => lines.push(x.join(' ')); try { await fn(); } finally { console.log = o; console.warn = w; } return lines.join('\n'); };
const EXTRA = ['x-hitl-preapproved', 'x-internal-gateway-secret', 'x-may-act-sub'];

test('with the secret set, the booking call carries exactly the two consent headers (plus the fixed pre-approval marker), with the secret and the configured actor id', async () => {
  const withSecret = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET });
  const without = await boot();
  try {
    await withSecret.call('book_flight', { flightId: 'SH101' });
    await without.call('book_flight', { flightId: 'SH101' });
    const a = withSecret.gw(); const b = without.gw();
    assert.deepEqual(a.map((x) => x.method), ['initialize', 'tools/list', 'tools/call']);
    const callA = a.find((x) => x.method === 'tools/call'); const callB = b.find((x) => x.method === 'tools/call');
    assert.deepEqual(keys(callA.init.headers).filter((k) => !keys(callB.init.headers).includes(k)), EXTRA, 'exactly these are new (the two consent headers and the fixed pre-approval marker)');
    assert.deepEqual(keys(callB.init.headers).filter((k) => !keys(callA.init.headers).includes(k)), [], 'nothing else changed');
    assert.equal(hdr(callA.init.headers, 'x-internal-gateway-secret'), SECRET);
    assert.equal(hdr(callA.init.headers, 'X-May-Act-Sub'), ACTOR);
    // Decision: the consent is judged at tools/call, so only that request carries the headers. initialize and tools/list are exactly as they were.
    for (const x of a.filter((y) => y.method !== 'tools/call')) for (const h of EXTRA) assert.equal(hdr(x.init.headers, h), undefined, `${x.method} has no ${h}`);
    // Only the gateway URL is ever sent them, and no other trusted header is invented.
    for (const x of withSecret.seen.filter((y) => y.url !== GW)) for (const h of EXTRA) assert.equal(hdr(x.init.headers, h), undefined, 'the sign-in endpoints never see them');
    for (const h of ['x-authz-simulated', 'x-act-client-id', 'x-demo-force-actor']) assert.equal(hdr(callA.init.headers, h), undefined, h);
    const minted = withSecret.seen.filter((x) => x.method === 'token' && x.grant !== 'authorization_code').at(-1);
    assert.ok(minted, 'a delegated token was minted at sign-in');
    assert.equal(hdr(callA.init.headers, 'authorization'), `Bearer ${minted.access}`);
    assert.equal(JSON.parse(Buffer.from(minted.access.split('.')[1], 'base64url')).act.sub, ACTOR);
  } finally { await withSecret.close(); await without.close(); }
});

test('the loyalty tools and list_flights never carry the headers', async () => {
  const a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET });
  try {
    for (const name of ['get_loyalty_status', 'loyalty_balance', 'list_flights']) assert.equal((await a.call(name, {})).result.isError, false, name);
    const calls = a.gw();
    assert.ok(calls.length >= 6, 'the loyalty tools reached the stub gateway');
    for (const x of calls) for (const h of EXTRA) assert.equal(hdr(x.init.headers, h), undefined, `${x.method} ${x.tool ?? ''}`);
  } finally { await a.close(); }
});

test('with no secret (unset, empty, blank) the booking call is exactly as before: no extra headers on any request', async () => {
  for (const extra of [{}, { MUSE_GATEWAY_INTERNAL_SECRET: '' }, { MUSE_GATEWAY_INTERNAL_SECRET: '   ' }]) {
    const a = await boot(extra);
    try {
      assert.equal((await a.call('book_flight', { flightId: 'SH101' })).result.isError, false);
      for (const x of a.gw()) for (const h of EXTRA) assert.equal(hdr(x.init.headers, h), undefined, `${x.method} ${JSON.stringify(extra)}`);
    } finally { await a.close(); }
  }
});

test('a secret that is not a plain header value is ignored (no headers, no crash, value not logged)', async () => {
  for (const bad of ['has space', 'new\nline', 'café-secret', 'x'.repeat(513)]) {
    let a; const logs = await capture(async () => { a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: bad }); });
    try {
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, false);
      for (const x of a.gw()) for (const h of EXTRA) assert.equal(hdr(x.init.headers, h), undefined);
      assert.ok(!logs.includes(bad) || bad.length === 0, 'the value is not logged');
    } finally { await a.close(); }
  }
});

test('a caller-supplied argument cannot change the headers', async () => {
  const a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET });
  try {
    const r = await a.call('book_flight', { flightId: 'SH101', 'X-May-Act-Sub': 'evil', 'x-internal-gateway-secret': 'evil', headers: { 'X-May-Act-Sub': 'evil' }, actor: 'evil', actClientId: 'evil', mayActSub: 'evil', secret: 'evil' });
    assert.equal(r.result.isError, false);
    const c = a.gw().find((x) => x.method === 'tools/call');
    assert.equal(hdr(c.init.headers, 'X-May-Act-Sub'), ACTOR); assert.equal(hdr(c.init.headers, 'x-internal-gateway-secret'), SECRET);
    assert.deepEqual(JSON.parse(c.init.body).params.arguments, { flight_number: 'SH101' });
    assert.ok(!JSON.stringify(c.init).includes('evil'));
    // Request headers of the agent's own /mcp call are not forwarded either.
    const raw = await fetch(`${a.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-May-Act-Sub': 'evil', 'x-internal-gateway-secret': 'evil' }, body: '{}' });
    assert.equal(raw.status, 401);
  } finally { await a.close(); }
});

test('X-May-Act-Sub is the actor app the session signed in with (an assistant with its own PingOne app uses that app\'s id)', async () => {
  const agents = JSON.stringify([{ name: 'Chat', hosts: ['chat.example'], clientId: OTHER_APP, clientSecret: 'own-app-secret-not-real' }]);
  const a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET, MUSE_CONNECTOR_AGENTS: agents }, { redirect: 'https://chat.example/oauth/callback' });
  try {
    await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(hdr(a.gw().find((x) => x.method === 'tools/call').init.headers, 'X-May-Act-Sub'), OTHER_APP);
  } finally { await a.close(); }
});

test('the secret appears in no result, log line, error text, trace or page, even when the stub gateway echoes or throws it', async () => {
  const a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET });
  const out = [];
  const logs = await capture(async () => {
    const runs = [
      () => json(200, bookedBody),
      () => json(403, { error: 'access_denied', message: SECRET }, audit(['no_user_consent', 'mcp-airline-agent-spend-limit'], { Amount: '620', AgentSpendLimit: '500' })),
      () => json(403, { error: 'access_denied', error_description: `echo ${SECRET}` }, audit(['may_act_mismatch'])),
      () => json(401, { error: 'invalid_token', error_description: `echo ${SECRET}` }),
      () => json(428, { error: 'consent_pending', detail: SECRET }),
      () => new Response(`raw ${SECRET}`, { status: 502 }),
      () => { throw new Error(`socket closed, sent x-internal-gateway-secret: ${SECRET}`); },
    ];
    for (const fn of runs) { a.script.book = fn; out.push(text(await a.call('book_flight', { flightId: 'SH103' }))); }
    out.push(JSON.stringify(await a.rpc('tools/list')));
  });
  try {
    for (const where of [out.join('\n'), logs]) { assert.ok(!where.includes(SECRET), 'secret leaked'); assert.doesNotMatch(where, /x-internal-gateway-secret/i); }
    assert.match(logs, /book_flight SH103 -> booked \(HTTP 200\)/);
    assert.match(logs, /\[redacted\]/, 'the echoed value was redacted in the log');
    for (const p of ['/', '/api/info', '/api/session', '/api/flights', '/api/health', '/api/netguard']) {
      const r = await fetch(a.base + p);
      assert.ok(!(await r.text()).includes(SECRET), p);
    }
  } finally { await a.close(); }
});

test('a gateway that reflects the secret in an audit code or a confirmation number does not get it into the result', async () => {
  const a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET });
  try {
    a.script.book = (args, headers) => json(403, { error: 'access_denied' }, audit([hdr(headers, 'x-internal-gateway-secret')]));
    const denied = text(await a.call('book_flight', { flightId: 'SH101' }));
    assert.ok(!denied.includes(SECRET), 'reflected audit code'); assert.match(denied, /Nothing was booked\./);
    a.script.book = (args, headers) => json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ booked: true, confirmationNumber: hdr(headers, 'x-internal-gateway-secret'), fare: 180 }) }] } });
    const booked = text(await a.call('book_flight', { flightId: 'SH101' }));
    assert.ok(!booked.includes(SECRET), 'reflected confirmation number'); assert.match(booked, /^Booked SH101 for \$180\./);
    // A secret with characters that plain() would strip is also kept out (the raw value is scrubbed before it is worded).
    const odd = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: 'ab!cd@ef#gh-not-real' });
    try {
      odd.script.book = (args, headers) => json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ booked: true, confirmationNumber: hdr(headers, 'x-internal-gateway-secret'), fare: 180 }) }] } });
      const t = text(await odd.call('book_flight', { flightId: 'SH101' }));
      assert.ok(!t.includes('ab!cd@ef#gh-not-real') && !t.includes('abcdefgh-not-real'), 'stripped form not leaked either');
    } finally { await odd.close(); }
  } finally { await a.close(); }
});

test('no_user_consent and may_act_mismatch give the plain consent message, with and without the secret configured; other rules stay intact', async () => {
  for (const [extra, note] of [[{}, true], [{ MUSE_GATEWAY_INTERNAL_SECRET: SECRET }, false]]) {
    const a = await boot(extra);
    try {
      for (const code of ['no_user_consent', 'may_act_mismatch']) {
        a.script.book = () => json(403, { error: 'access_denied' }, audit([code]));
        const r = await a.call('book_flight', { flightId: 'SH101' });
        assert.equal(r.result.isError, true);
        assert.match(text(r), /^Booking denied: you have not authorized this agent to act for you on bookings\./);
        assert.match(text(r), /Nothing was booked\.$/);
        assert.equal(/consent bridge is not configured/.test(text(r)), note, `${code} note when ${note ? 'absent' : 'configured'}`);
        assert.doesNotMatch(text(r), /did not allow this booking|no_user_consent|may_act_mismatch/);
      }
      // Consent plus the spend-limit rule: both named. The consent code is never echoed as an "other" code.
      a.script.book = () => json(403, { error: 'access_denied' }, audit(['no_user_consent', 'mcp-airline-agent-spend-limit', 'extra-rule'], { Amount: '620', AgentSpendLimit: '500' }));
      const both = text(await a.call('book_flight', { flightId: 'SH106' }));
      assert.match(both, /not authorized this agent/); assert.match(both, /also denied: an AI agent cannot buy a ticket over your limit/); assert.match(both, /also returned extra-rule/); assert.doesNotMatch(both, /no_user_consent/);
      // The existing mappings are untouched.
      a.script.book = () => json(403, { error: 'access_denied' }, audit(['mcp-airline-agent-spend-limit'], { Amount: '620', AgentSpendLimit: '500' }));
      assert.match(text(await a.call('book_flight', { flightId: 'SH106' })), /^The booking was denied: an AI agent cannot buy a ticket over your limit/);
      a.script.book = () => json(428, { error: 'consent_pending' });
      assert.match(text(await a.call('book_flight', { flightId: 'SH103' })), /held for the member's approval/);
    } finally { await a.close(); }
  }
  const bk = { status: 'denied', fare: 180, facts: {}, evidence: { statements: [{ code: 'no_user_consent' }] } };
  assert.match(bookingToolResult(bk, 'SH101').content[0].text, /bridge is not configured/);
  assert.doesNotMatch(bookingToolResult(bk, 'SH101', { bridge: true }).content[0].text, /bridge is not configured/);
});

test('against a gateway that enforces the trusted-caller rule: no secret is denied for consent; the right secret passes the consent rule; a wrong secret is denied', async () => {
  const next = () => json(428, { error: 'consent_pending', decision: 'PERMIT' });
  for (const [extra, re, label] of [
    [{}, /^Booking denied: you have not authorized this agent[\s\S]*bridge is not configured/, 'no secret'],
    [{ MUSE_GATEWAY_INTERNAL_SECRET: SECRET }, /held for the member's approval/, 'right secret'],
    [{ MUSE_GATEWAY_INTERNAL_SECRET: 'some-other-secret-not-real' }, /^Booking denied: you have not authorized this agent/, 'wrong secret'],
  ]) {
    const a = await boot(extra);
    try {
      a.script.book = enforcing(SECRET, ACTOR, next);
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, true, label); assert.match(text(r), re, label); assert.doesNotMatch(text(r), /^Booked/, label);
    } finally { await a.close(); }
  }
  // A secret that matches, but a gateway expecting a different actor: may_act_mismatch, plain message.
  const a = await boot({ MUSE_GATEWAY_INTERNAL_SECRET: SECRET });
  try {
    a.script.book = enforcing(SECRET, '00000000-0000-0000-0000-0000000000ff', next);
    assert.match(text(await a.call('book_flight', { flightId: 'SH101' })), /^Booking denied: you have not authorized this agent/);
  } finally { await a.close(); }
});
