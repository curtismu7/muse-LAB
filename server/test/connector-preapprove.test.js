// The connector's pre-approval headers, the MCP server's answer passed through, and accurate limit numbers in block messages.
// In-process stubs only (see helpers/preapprove-stack.js): a stub PingOne, the tier switch's stub PingOne user, and a stub gateway. Invented ids (00000000-...), invented secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingToolResult, limitHeaderValue, passThroughResult, scrubAnswer, statementLimit, NOT_CONFIRMED, FACTS_TIMEOUT_MS } from '../src/connector.js';
import { ACTOR, BRIDGE_SECRET, GW, STRANGER, TIER_ON, USER, USER2, audit, boot, hdr, json, newState, realStackGateway, stub, text } from './helpers/preapprove-stack.js';

const WITH_BRIDGE = { MUSE_GATEWAY_INTERNAL_SECRET: BRIDGE_SECRET };
const FULL = { ...WITH_BRIDGE, ...TIER_ON };
const PRE = 'x-hitl-preapproved';
const LIM = 'x-agent-spend-limit';
const callHeaders = (a) => a.gwCall().map((x) => x.init.headers);
const lowerKeys = (h) => Object.keys(h).map((k) => k.toLowerCase());
const withApp = async (extra, opts, fn) => { const a = await boot(extra, opts); try { return await fn(a); } finally { await a.close(); } };

// ---------------------------------------------------------------- headers

test('with the bridge secret and a limit held in PingOne: the booking call (and only it) carries X-Hitl-Preapproved: user-limit and X-Agent-Spend-Limit: the limit as plain digits', async () => {
  await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
    assert.equal((await a.call('book_flight', { flightId: 'SH101' })).result.isError, false);
    const calls = a.gw();
    assert.deepEqual(calls.map((x) => x.method), ['initialize', 'tools/list', 'tools/call']);
    const h = a.gwCall()[0].init.headers;
    assert.equal(hdr(h, PRE), 'user-limit'); assert.equal(hdr(h, LIM), '1000');
    assert.equal(hdr(h, 'x-internal-gateway-secret'), BRIDGE_SECRET); assert.equal(hdr(h, 'X-May-Act-Sub'), ACTOR);
    for (const x of calls.filter((y) => y.method !== 'tools/call')) for (const k of [PRE, LIM]) assert.equal(hdr(x.init.headers, k), undefined, `${x.method} has no ${k}`);
    for (const x of a.seen.filter((y) => y.url !== GW)) for (const k of [PRE, LIM]) assert.equal(hdr(x.init.headers, k), undefined, `${x.method} (PingOne) has no ${k}`);
    assert.deepEqual(a.state.reads, [USER], 'one PingOne read, of the signed-in user');
    assert.deepEqual(a.gwCall()[0].args, { flight_number: 'SH101', amount: 180 });
  });
});

test('limit unknown (none held, tier switch not configured, user not on the allow-list): the marker is sent, the limit header is not, and a limit is never invented', async () => {
  const cases = [
    ['no limit held in PingOne', FULL, newState({ limit: null }), 1],
    ['tier switch not configured', WITH_BRIDGE, newState({ limit: '1000' }), 0],
    ['signed-in user is not on the allow-list', FULL, newState({ limit: '1000', sub: STRANGER }), 0],
    ['session user id is not an id at all', FULL, newState({ limit: '1000', sub: 'sam' }), 0],
  ];
  for (const [why, env, state, reads] of cases) {
    await withApp(env, { state }, async (a) => {
      assert.equal((await a.call('book_flight', { flightId: 'SH101' })).result.isError, false, why);
      const h = callHeaders(a)[0];
      assert.equal(hdr(h, PRE), 'user-limit', why); assert.equal(hdr(h, LIM), undefined, why);
      assert.equal(a.state.reads.length, reads, `${why}: PingOne reads`);
    });
  }
});

test('no pre-approval headers on the loyalty tools or list_flights, and none on anything when the bridge secret is unset, empty, blank or not a plain value', async () => {
  await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
    for (const name of ['get_loyalty_status', 'loyalty_balance', 'list_flights']) assert.equal((await a.call(name, {})).result.isError, false, name);
    assert.ok(a.gw().length >= 6);
    for (const x of a.gw()) for (const k of [PRE, LIM, 'x-internal-gateway-secret']) assert.equal(hdr(x.init.headers, k), undefined, `${x.method} ${x.tool ?? ''} ${k}`);
    assert.equal(a.state.reads.length, 0, 'the limit is read for book_flight only');
  });
  for (const secret of [undefined, '', '   ', 'has space', 'new\nline', 'x'.repeat(513)]) {
    await withApp({ ...TIER_ON, ...(secret === undefined ? {} : { MUSE_GATEWAY_INTERNAL_SECRET: secret }) }, { state: newState({ limit: '1000' }) }, async (a) => {
      assert.equal((await a.call('book_flight', { flightId: 'SH101' })).result.isError, false);
      for (const x of a.gw()) for (const k of [PRE, LIM, 'x-internal-gateway-secret', 'x-may-act-sub']) assert.equal(hdr(x.init.headers, k), undefined, `${JSON.stringify(secret)} ${x.method} ${k}`);
      assert.equal(a.state.reads.length, 0, 'no bridge, no pre-approval, so no read');
    });
  }
});

test('the limit comes from the session\'s own user id only: hostile arguments, hostile request headers and another allow-listed user cannot change it', async () => {
  const env = { ...FULL, MUSE_TIER_USER_IDS: `${USER},${USER2}` };
  await withApp(env, { state: newState({ limit: '1000', sub: USER2 }) }, async (a) => {
    const r = await a.call('book_flight', { flightId: 'SH101', userId: USER, sub: USER, limit: 99999, agentSpendLimit: 99999, 'X-Agent-Spend-Limit': '99999', 'X-Hitl-Preapproved': 'evil', headers: { 'X-Agent-Spend-Limit': '99999' } });
    assert.equal(r.result.isError, false);
    assert.deepEqual(a.state.reads, [USER2], 'only the signed-in user was read');
    const h = callHeaders(a)[0];
    assert.equal(hdr(h, LIM), '1000'); assert.equal(hdr(h, PRE), 'user-limit');
    assert.ok(!JSON.stringify(a.gwCall()[0].init).includes('99999') && !JSON.stringify(a.gwCall()[0].init).includes('evil'));
    // The agent's own request headers to /mcp are not forwarded either.
    const raw = await fetch(`${a.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}`, 'x-agent-spend-limit': '99999', 'x-hitl-preapproved': 'evil' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'book_flight', arguments: { flightId: 'SH102' } } }) });
    assert.equal(raw.status, 200);
    const h2 = callHeaders(a)[1];
    assert.equal(hdr(h2, LIM), '1000'); assert.equal(hdr(h2, PRE), 'user-limit');
  });
});

test('every booking reads the limit fresh: raising it in PingOne changes the next call\'s header', async () => {
  await withApp(FULL, { state: newState({ limit: '600' }) }, async (a) => {
    await a.call('book_flight', { flightId: 'SH101' });
    a.state.limit = '900';
    await a.call('book_flight', { flightId: 'SH101' });
    a.state.limit = null;
    await a.call('book_flight', { flightId: 'SH101' });
    assert.deepEqual(callHeaders(a).map((h) => hdr(h, LIM)), ['600', '900', undefined]);
    assert.equal(a.state.reads.length, 3);
  });
});

test('limitHeaderValue accepts whole dollars as plain ASCII digits (1 to 7 characters, above zero) and nothing else', () => {
  for (const ok of [500, '500', '1', '1000', 1234567, '9999999']) assert.equal(limitHeaderValue(ok), String(ok), String(ok));
  const bad = ['500\r\nX-Evil: 1', '500\n', '1e9', '-5', ' 500', '500 ', '0', '00', '0500', '99999999', 99999999, '500.5', 500.5, '', ' ', null, undefined, true, false, {}, { a: 1 }, [], ['500'], NaN, Infinity, -1, 0, 1e21, '１２３', '٥٠٠', '5_00', '0x1F', '+5', '500;', 'abc'];
  for (const v of bad) assert.equal(limitHeaderValue(v), null, JSON.stringify(v) ?? String(v));
});

test('a hostile value in the PingOne record never becomes a header: no limit header, no extra header, the booking still goes out', async () => {
  const hostile = ['500\r\nX-Evil: 1', '500\n', '1e9', '-5', ' 500', '500 ', '0', '99999999', { a: 1 }, ['500'], true, 500.5, '500.5', '0x1F', '１２３'];
  for (const limit of hostile) {
    await withApp(FULL, { state: newState({ limit }) }, async (a) => {
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, false, JSON.stringify(limit));
      const h = callHeaders(a)[0];
      assert.equal(hdr(h, LIM), undefined, `${JSON.stringify(limit)} sent a limit`);
      assert.equal(hdr(h, 'x-evil'), undefined);
      assert.equal(hdr(h, PRE), 'user-limit');
      for (const v of Object.values(h)) assert.doesNotMatch(String(v), /[\r\n]/);
      assert.equal(a.state.reads.length, 1, 'it was read');
    });
  }
  // The largest value that fits in 7 digits does pass.
  await withApp(FULL, { state: newState({ limit: '1234567' }) }, async (a) => {
    await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(hdr(callHeaders(a)[0], LIM), '1234567');
  });
});

test('a PingOne read that fails (429, 500, refused worker credential, dropped connection) never blocks the booking: it goes out with the marker and no limit header', async () => {
  for (const mode of ['429', '500', 'tokenfail', 'throw']) {
    await withApp(FULL, { state: newState({ limit: '1000', mode }) }, async (a) => {
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, false, mode); assert.match(text(r), /^Booked a flight to Denver/, mode);
      const h = callHeaders(a)[0];
      assert.equal(hdr(h, LIM), undefined, mode); assert.equal(hdr(h, PRE), 'user-limit', mode);
      assert.equal(a.gwCall().length, 1, `${mode}: the booking was sent once`);
    });
  }
});

test('a PingOne read that never answers delays the booking by the small timeout at most, then it goes out without a limit header', async () => {
  await withApp(FULL, { state: newState({ limit: '1000', mode: 'hang' }) }, async (a) => {
    const t0 = Date.now();
    const r = await a.call('book_flight', { flightId: 'SH101' });
    const ms = Date.now() - t0;
    assert.equal(r.result.isError, false);
    assert.ok(ms >= FACTS_TIMEOUT_MS - 200 && ms < FACTS_TIMEOUT_MS + 2500, `took ${ms} ms`);
    assert.equal(hdr(callHeaders(a)[0], LIM), undefined);
    assert.equal(hdr(callHeaders(a)[0], PRE), 'user-limit');
  });
});

test('a user-facts read that throws, rejects, returns garbage or is slow never blocks the booking and never yields a header', async () => {
  const reads = [() => { throw new Error('boom'); }, async () => { throw new Error('boom'); }, () => 'garbage', () => null, () => ({ limit: '1000; x' }), () => ({ limit: { a: 1 } }), () => new Promise(() => {})];
  for (const userFacts of reads) {
    await withApp(WITH_BRIDGE, { userFacts }, async (a) => {
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, false); assert.match(text(r), /^Booked a flight to Denver/);
      assert.equal(hdr(callHeaders(a)[0], LIM), undefined); assert.equal(hdr(callHeaders(a)[0], PRE), 'user-limit');
      assert.equal(a.gwCall().length, 1);
    });
  }
  let asked = null;
  await withApp(WITH_BRIDGE, { userFacts: async (id) => { asked = id; return { tier: null, limit: 750 }; } }, async (a) => {
    await a.call('book_flight', { flightId: 'SH101', userId: 'evil' });
    assert.equal(hdr(callHeaders(a)[0], LIM), '750'); assert.equal(asked, USER, "asked about the session's user");
  });
});

test('only a 200 is ever read as the MCP server\'s answer: a 403, 428, 500 or 401 whose body carries content stays a denial, a hold or an error', async () => {
  const body = { result: { content: [T(JSON.stringify({ booked: true, confirmationNumber: 'FAKE' }))] } };
  for (const [status, re] of [[403, /did not allow this booking/], [428, /held for the member's approval/], [500, /No booking was confirmed/], [401, /did not accept the connector's sign-in/], [201, /No booking was confirmed/], [202, /No booking was confirmed/]]) {
    await withApp(WITH_BRIDGE, {}, async (a) => {
      a.script.book = () => json(status, body);
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, true, String(status)); assert.match(text(r), re, String(status)); assert.doesNotMatch(text(r), /FAKE|^Booked/, String(status));
    });
  }
});

test('the PingOne user id and the worker secret appear in no result, log line or header sent to the gateway', async () => {
  await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
    const out = text(await a.call('book_flight', { flightId: 'SH101' }));
    for (const s of [USER, 'worker-test-secret-not-real-0002', 'worker-token-not-real']) {
      assert.ok(!out.includes(s));
      assert.ok(!JSON.stringify(a.gwCall()[0].init).includes(s));
    }
  });
});

// ---------------------------------------------------------------- pass-through

const answer = (content, extra = {}) => () => json(200, { result: { content, ...extra } });
const T = (t) => ({ type: 'text', text: t });

test('200 with booked true: the one-line summary first, then the MCP server\'s own text, not an error', async () => {
  await withApp(WITH_BRIDGE, {}, async (a) => {
    a.script.book = answer([T(JSON.stringify({ booked: true, confirmationNumber: 'CONF-STUB-9', fare: 180, passenger: 'Stub Passenger' }))]);
    const r = await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content.length, 2);
    assert.equal(r.result.content[0].text, 'Booked a flight to Denver for $180 (airline price). Booking reference: CONF-STUB-9.');
    assert.deepEqual(JSON.parse(r.result.content[1].text), { booked: true, confirmationNumber: 'CONF-STUB-9', fare: 180, passenger: 'Stub Passenger' });
  });
});

test('200 where the server did not say booked true (false, absent, plain text, a string "true"): its answer comes back under "not a confirmed booking", never as booked', async () => {
  const cases = [
    ['booked false', JSON.stringify({ booked: false, note: 'sold out' }), /sold out/],
    ['no booked flag', JSON.stringify({ fare: 180 }), /"fare":180/],
    ['plain text', 'Seat 12A is held for 15 minutes.', /Seat 12A/],
    ['booked as a string', JSON.stringify({ booked: 'true' }), /"booked":"true"/],
    ['booked in prose', 'Booked! Your flight is confirmed.', /Booked! Your flight/],
  ];
  for (const [why, body, re] of cases) {
    await withApp(WITH_BRIDGE, {}, async (a) => {
      a.script.book = answer([T(body)]);
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, false, why);
      assert.equal(r.result.content[0].text, NOT_CONFIRMED, why);
      assert.match(r.result.content[1].text, re, why);
      assert.doesNotMatch(r.result.content[0].text, /^Booked/, why);
      assert.ok(!r.result.content.some((c) => /^Booked a flight to Denver/.test(c.text)), `${why}: nothing says Booked SH101`);
    });
  }
});

test('200 with isError true: isError comes from the MCP result, and even booked true is not called booked then', async () => {
  await withApp(WITH_BRIDGE, {}, async (a) => {
    a.script.book = answer([T(JSON.stringify({ booked: false, note: 'airline system down' }))], { isError: true });
    const r = await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(r.result.isError, true); assert.equal(r.result.content[0].text, NOT_CONFIRMED); assert.match(r.result.content[1].text, /airline system down/);
    a.script.book = answer([T(JSON.stringify({ booked: true, confirmationNumber: 'C1' }))], { isError: true });
    const r2 = await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(r2.result.isError, true); assert.equal(r2.result.content[0].text, NOT_CONFIRMED); assert.ok(!r2.result.content.some((c) => /^Booked a flight to Denver/.test(c.text)));
    // isError that is not the boolean true counts as false.
    a.script.book = answer([T('ok')], { isError: 'yes' });
    assert.equal((await a.call('book_flight', { flightId: 'SH101' })).result.isError, false);
  });
});

test('200 with garbage or empty content: the plain "could not be read, no booking was confirmed" error, never a booking', async () => {
  const bad = [[], null, 'text', {}, [null, 5, 'x'], [{ type: 'image', data: 'AAAA' }], [{ type: 'text', text: '' }], [{ type: 'text', text: '   ' }], [{ type: 'text' }], [{ type: 'text', text: 42 }], [{ type: 'resource', text: 'x' }]];
  for (const content of bad) {
    await withApp(WITH_BRIDGE, {}, async (a) => {
      a.script.book = () => json(200, { result: { content } });
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, true, JSON.stringify(content)); assert.match(text(r), /No booking was confirmed/); assert.doesNotMatch(text(r), /^Booked/);
    });
  }
  for (const body of [{ result: null }, { result: {} }, { jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'rpc down' } }, []]) {
    await withApp(WITH_BRIDGE, {}, async (a) => {
      a.script.book = () => json(200, body);
      const r = await a.call('book_flight', { flightId: 'SH101' });
      assert.equal(r.result.isError, true); assert.match(text(r), /No booking was confirmed/); assert.doesNotMatch(text(r), /^Booked|rpc down/);
    });
  }
});

test('the MCP server\'s text is scrubbed: the bridge secret, bearer tokens, JWT-shaped values and URLs that carry ids never reach muse.ai (a plain URL does)', async () => {
  const jwtLike = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLWJ5dGVz';
  await withApp(WITH_BRIDGE, {}, async (a) => {
    a.script.book = (args, headers) => json(200, { result: { content: [
      T(JSON.stringify({ booked: true, confirmationNumber: hdr(headers, 'x-internal-gateway-secret'), fare: 180 })),
      T(`echo ${hdr(headers, 'x-internal-gateway-secret')} and ab!cd Bearer abcdefghijklmnop12345 and ${jwtLike}`),
      T('see https://airline.example/trips/00000000-0000-0000-0000-0000000000b1/receipt and https://airline.example/r?id=abc123 and https://airline.example/help and https://x.example/a/ABCDEFGHIJKLMNOPQRSTUVWX'),
    ] } });
    const r = await a.call('book_flight', { flightId: 'SH101' });
    const all = text(r);
    assert.ok(!all.includes(BRIDGE_SECRET), 'secret'); assert.ok(!/abcdefghijklmnop12345/.test(all), 'bearer'); assert.ok(!all.includes(jwtLike) && !/eyJ/.test(all), 'jwt');
    assert.ok(!/00000000-0000-0000-0000-0000000000b1|id=abc123|ABCDEFGHIJKLMNOPQRSTUVWX/.test(all), 'url with ids');
    assert.match(all, /https:\/\/airline\.example\/help/, 'a plain URL is kept');
    assert.match(all, /<url>/); assert.match(all, /Bearer \[redacted\]/);
    assert.equal(r.result.isError, false);
  });
  assert.equal(scrubAnswer('a Bearer abcdefgh12345 b'), 'a Bearer [redacted] b');
});

test('the answer is capped: at most 5 items (plus the summary line), 4000 characters each', async () => {
  await withApp(WITH_BRIDGE, {}, async (a) => {
    a.script.book = answer([T(JSON.stringify({ booked: true, confirmationNumber: 'C1', fare: 180 })), ...Array.from({ length: 9 }, (_, i) => T(`item ${i + 2} ${'x'.repeat(5000)}`))]);
    const r = await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(r.result.content.length, 1 + 5);
    for (const c of r.result.content.slice(1)) assert.ok(c.text.length <= 4000);
    assert.equal(r.result.content[2].text.length, 4000);
    // A body past the gateway reader's 64 KB cap is cut, cannot be read, and so is never described as a booking.
    a.script.book = answer([T(JSON.stringify({ booked: true, confirmationNumber: 'C1', fare: 180 })), T('y'.repeat(70000))]);
    const big = await a.call('book_flight', { flightId: 'SH101' });
    assert.equal(big.result.isError, true); assert.match(text(big), /No booking was confirmed/); assert.doesNotMatch(text(big), /^Booked/);
  });
});

test('booked true with a second text item: the summary comes first and both of the server\'s items follow', async () => {
  await withApp(WITH_BRIDGE, {}, async (a) => {
    a.script.book = answer([T(JSON.stringify({ booked: true, confirmationNumber: 'C2', fare: 320 })), T('Check in opens 24 hours before departure.')]);
    const r = await a.call('book_flight', { flightId: 'SH102' });
    assert.deepEqual(r.result.content.map((c) => c.text.slice(0, 22)), ['Booked a flight to Sea', '{"booked":true,"confir', 'Check in opens 24 hour']);
  });
});

test('passThroughResult on its own: null when there is nothing readable, so the caller falls back', () => {
  const bk = { status: 'booked', fare: 180, confirmation: 'C1' };
  assert.equal(passThroughResult(bk, 'SH101', undefined), null);
  assert.equal(passThroughResult(bk, 'SH101', { result: { content: [] } }), null);
  assert.equal(passThroughResult(bk, 'SH101', { error: { message: 'x' }, result: { content: [T('a')] } }), null);
  assert.equal(passThroughResult(bk, 'SH101', { result: { content: [T('a')] } }).content[0].text, 'Booked SH101 for $180. Booking reference: C1.');
});

// ---------------------------------------------------------------- block messages

const OVER = (id, fare, lim, payload = {}) => () => json(403, { error: 'access_denied' }, audit({ parameters: { Amount: String(fare), AgentSpendLimit: String(lim), ActClientId: 'personal-agent.example' }, statements: [{ code: 'mcp-airline-agent-spend-limit', payload: { message: 'over', ...payload } }] }));

test('over the limit: the number comes from the deny statement itself first, then from PingOne, never from the audit trail\'s AgentSpendLimit parameter', async () => {
  // The owner\'s case: the audit trail says 500, PingOne holds 1000, the fare is 1200. The message says 1000.
  await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
    a.script.book = OVER('SH107', 1200, 500);
    const r = await a.call('book_flight', { flightId: 'SH107' });
    assert.equal(r.result.isError, true);
    assert.match(text(r), /an AI agent cannot buy a ticket over your limit \(SH107 costs \$1200; your limit is \$1000\)/);
    assert.doesNotMatch(text(r), /\$500/); assert.match(text(r), /Nothing was booked/);
    assert.equal(a.gwCall().length, 1, 'no retry, no approval offered');
    assert.doesNotMatch(text(r), /approv/i);
    assert.equal(a.state.reads.length, 1, 'the one PingOne read of this call served both the header and the message');
  });
  // The statement's own payload wins over PingOne and over the audit parameter: a numeric field, or the words of its message.
  for (const payload of [{ limit: 750 }, { agentSpendLimit: '750' }, { AgentSpendLimit: 750 }, { message: 'fare $940 is over your $750 limit' }, { message: 'the limit is $750' }]) {
    await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
      a.script.book = OVER('SH107', 940, 500, payload);
      assert.match(text(await a.call('book_flight', { flightId: 'SH107' })), /your limit is \$750\)/, JSON.stringify(payload));
    });
  }
  // A payload number that is not a positive amount is ignored; PingOne is the next source.
  for (const payload of [{ limit: -5 }, { limit: 0 }, { limit: 'lots' }, { limit: { a: 1 } }, { limit: '1e9' }]) {
    await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
      a.script.book = OVER('SH107', 1200, 500, payload);
      assert.match(text(await a.call('book_flight', { flightId: 'SH107' })), /your limit is \$1000\)/, JSON.stringify(payload));
    });
  }
});

test('over the limit and no source for the number: "your limit was not reported", never the gateway\'s 500', async () => {
  const cases = [
    ['tier switch not configured', WITH_BRIDGE, newState({ limit: '1000' })],
    ['no limit held in PingOne', FULL, newState({ limit: null })],
    ['user not on the allow-list', FULL, newState({ limit: '1000', sub: STRANGER })],
    ['PingOne 429', FULL, newState({ limit: '1000', mode: '429' })],
    ['PingOne unreadable value', FULL, newState({ limit: '10e2' })],
  ];
  for (const [why, env, state] of cases) {
    await withApp(env, { state }, async (a) => {
      a.script.book = OVER('SH106', 620, 500);
      const r = await a.call('book_flight', { flightId: 'SH106' });
      assert.equal(r.result.isError, true, why);
      assert.match(text(r), /over your limit \(SH106 costs \$620; your limit was not reported\)/, why);
      assert.doesNotMatch(text(r), /\$500|\$1000/, why);
    });
  }
  // With no bridge secret at all, the PingOne number is still read (once, after the denial) for the message.
  await withApp(TIER_ON, { state: newState({ limit: '600' }) }, async (a) => {
    a.script.book = OVER('SH106', 620, 500, {});
    const r = await a.call('book_flight', { flightId: 'SH106' });
    assert.match(text(r), /your limit is \$600\)/); assert.equal(a.state.reads.length, 1);
    assert.equal(hdr(callHeaders(a)[0], PRE), undefined, 'still no pre-approval without the secret');
  });
});

test('a denial that is not about the spend limit reads no limit for its message; premium-only and consent messages are unchanged', async () => {
  await withApp(WITH_BRIDGE, { }, async (a) => {
    a.script.book = () => json(403, { error: 'access_denied' }, audit({ parameters: { Amount: '940', MemberTier: 'Premier Silver' }, statements: [{ code: 'mcp-airline-premium-only', payload: { message: 'x' } }] }));
    assert.match(text(await a.call('book_flight', { flightId: 'SH107' })), /^The booking was denied: fares over \$750 are for premium members only \(SH107 costs \$940; your member tier is Premier Silver\)\. Nothing was booked\.$/);
    a.script.book = () => json(403, { error: 'access_denied' }, audit({ statements: [{ code: 'no_user_consent' }] }));
    assert.match(text(await a.call('book_flight', { flightId: 'SH107' })), /^Booking denied: you have not authorized this agent to act for you on bookings\. Nothing was booked\.$/);
  });
  await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
    a.script.book = () => json(403, { error: 'access_denied' }, audit({ parameters: { Amount: '940' }, statements: [{ code: 'mcp-airline-premium-only', payload: {} }] }));
    await a.call('book_flight', { flightId: 'SH107' });
    assert.equal(a.state.reads.length, 1, 'only the read made for the header');
  });
});

test('statementLimit reads only the spend-limit statement\'s own payload', () => {
  assert.equal(statementLimit([{ code: 'mcp-airline-agent-spend-limit', payload: { limit: 750 } }]), 750);
  assert.equal(statementLimit([{ code: 'mcp-airline-premium-only', payload: { limit: 750 } }]), undefined);
  assert.equal(statementLimit([{ code: 'mcp-airline-agent-spend-limit', payload: 'text', message: undefined }]), undefined);
  assert.equal(statementLimit(undefined), undefined);
  assert.equal(statementLimit([null, 5, { code: 'mcp-airline-agent-spend-limit', message: 'fare $940 is over your $750.50 limit' }]), 750.5);
});

test('held (428): the text is unchanged with the bridge; without it, it also says what to configure', async () => {
  const held = () => json(428, { error: 'consent_pending', decision: 'PERMIT' });
  await withApp(WITH_BRIDGE, {}, async (a) => {
    a.script.book = held;
    const r = await a.call('book_flight', { flightId: 'SH103' });
    assert.equal(r.result.isError, true);
    assert.equal(text(r), "This booking is held for the member's approval. Nothing was booked yet. Do not book it again until the member has approved it.");
  });
  await withApp({}, {}, async (a) => {
    a.script.book = held;
    const t = text(await a.call('book_flight', { flightId: 'SH103' }));
    assert.match(t, /^This booking is held for the member's approval\. Nothing was booked yet\. Do not book it again until the member has approved it\./);
    assert.match(t, /trusted-caller setting for the gateway must be configured/);
  });
  const bk = { status: 'consent_pending', fare: 480, facts: {}, evidence: {} };
  assert.doesNotMatch(bookingToolResult(bk, 'SH103', { bridge: true }).content[0].text, /trusted-caller/);
});

// ---------------------------------------------------------------- against a stack that applies the real rules

test('end to end against the rule-applying stub stack: within the limit the MCP server answers; over it is blocked with the right numbers; raising the limit lets a fare in between through', async () => {
  const state = newState({ limit: null });
  await withApp(FULL, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    const book = async (flightId) => a.call('book_flight', { flightId });
    // No limit held: Authorize's default of 500 applies.
    let r = await book('SH103');
    assert.equal(r.result.isError, false); assert.match(r.result.content[0].text, /^Booked a flight to Boston for \$480 \(airline price\)\. Booking reference: CONF-STUB-SH103\.$/); assert.match(r.result.content[1].text, /"passenger":"Stub Passenger"/);
    r = await book('SH106');
    assert.equal(r.result.isError, true); assert.match(text(r), /over your limit \(SH106 costs \$620; your limit was not reported\)/); assert.doesNotMatch(text(r), /^Booked/);
    // The owner raises the limit in PingOne: the fare between the old default and the new limit now goes straight through, with no hold.
    state.limit = '1000';
    r = await book('SH106');
    assert.equal(r.result.isError, false); assert.match(r.result.content[0].text, /^Booked a flight to London for \$620 \(airline price\)\./);
    assert.equal(hdr(callHeaders(a).at(-1), LIM), '1000');
    // A fare over the raised limit is still blocked; the premium-only rule is judged on its own (SH107 is 940, Premier Silver).
    state.limit = '900';
    r = await book('SH107');
    assert.equal(r.result.isError, true); assert.match(text(r), /over your limit \(SH107 costs \$940; your limit is \$900\)/); assert.match(text(r), /premium members only/);
    // Lowered below the old default.
    state.limit = '300';
    r = await book('SH103');
    assert.match(text(r), /over your limit \(SH103 costs \$480; your limit is \$300\)/);
  });
});

test('degraded: tier switch not configured and a raised PingOne limit: a fare above the gateway default is held, not booked', async () => {
  const state = newState({ limit: '1000' });
  await withApp(WITH_BRIDGE, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    const within = await a.call('book_flight', { flightId: 'SH103' });
    assert.match(text(within), /^Booked a flight to Boston/, 'within the gateway default of 500 it passes');
    const held = await a.call('book_flight', { flightId: 'SH106' });
    assert.equal(held.result.isError, true); assert.match(text(held), /held for the member's approval/); assert.doesNotMatch(text(held), /^Booked/);
    assert.equal(hdr(callHeaders(a).at(-1), LIM), undefined);
  });
});

test('degraded: no bridge secret: the stack denies for consent, with the existing message, and nothing pre-approved is sent', async () => {
  const state = newState({ limit: '1000' });
  await withApp(TIER_ON, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    const r = await a.call('book_flight', { flightId: 'SH103' });
    assert.equal(r.result.isError, true); assert.match(text(r), /^Booking denied: you have not authorized this agent[\s\S]*consent bridge is not configured/);
    assert.equal(hdr(callHeaders(a)[0], PRE), undefined); assert.equal(hdr(callHeaders(a)[0], LIM), undefined);
  });
});

test('the gateway URL is the only place the headers go (the PingOne reads carry neither the secret nor the pre-approval)', async () => {
  await withApp(FULL, { state: newState({ limit: '1000' }) }, async (a) => {
    await a.call('book_flight', { flightId: 'SH101' });
    for (const x of a.seen.filter((y) => y.url !== GW)) {
      for (const k of [PRE, LIM, 'x-internal-gateway-secret', 'x-may-act-sub']) assert.equal(hdr(x.init.headers, k), undefined, `${x.method} ${k}`);
      assert.ok(!lowerKeys(x.init.headers).includes('x-evil'));
    }
  });
});

// ---------------------------------------------------------------- book_flight by price or destination, against the rule-applying stub stack
// The stub gateway implements the open-fare rule (helpers/preapprove-stack.js): SH000 takes the STATED amount only from the trusted caller, with a valid amount; every other flight uses the catalogue fare.

const stackBook = async (a, args) => a.call('book_flight', args);
const gwArgs = (a) => a.gwCall().at(-1).args;

test('stated price vs the rule stack: over the limit is blocked with the numbers, within it books and says the price was stated', async () => {
  const state = newState({ limit: null });
  await withApp(FULL, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    // "Book me a flight for $620", limit 500 (Authorize's default).
    let r = await stackBook(a, { amount: 620 });
    assert.equal(r.result.isError, true); assert.deepEqual(gwArgs(a), { flight_number: 'SH000', amount: 620 });
    assert.match(text(r), /an AI agent cannot buy a ticket over your limit \(your stated price is \$620; your limit was not reported\)/); assert.doesNotMatch(text(r), /^Booked|SH000/);
    // "Book me a flight for $450".
    r = await stackBook(a, { amount: 450 });
    assert.equal(r.result.isError, false); assert.deepEqual(gwArgs(a), { flight_number: 'SH000', amount: 450 });
    assert.equal(r.result.content[0].text, 'Booked a flight for $450 (price as you stated it). Booking reference: CONF-STUB-SH000.'); assert.match(r.result.content[1].text, /"fare":450/);
    // Exactly the limit passes (strictly over is denied).
    r = await stackBook(a, { amount: 500 }); assert.equal(r.result.isError, false);
    r = await stackBook(a, { amount: 500.01 }); assert.equal(r.result.isError, true);
    // The owner raises the limit in PingOne: "for $620" now books.
    state.limit = '1000';
    r = await stackBook(a, { amount: 620 });
    assert.equal(r.result.isError, false); assert.match(text(r), /^Booked a flight for \$620 \(price as you stated it\)\./); assert.equal(hdr(callHeaders(a).at(-1), LIM), '1000');
  });
});

test('destination vs the rule stack: the airline price is judged; a stated price replaces it and the answer says both', async () => {
  const state = newState({ limit: null });
  await withApp(FULL, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    // "to London": the airline lists $620, over the limit of 500.
    let r = await stackBook(a, { destination: 'London' });
    assert.equal(r.result.isError, true); assert.deepEqual(gwArgs(a), { flight_number: 'SH106', amount: 620 });
    assert.match(text(r), /over your limit \(SH106 costs \$620; your limit was not reported\)/); assert.doesNotMatch(text(r), /^Booked/);
    // "to Denver": $180.
    r = await stackBook(a, { destination: 'Denver' });
    assert.equal(r.result.isError, false); assert.deepEqual(gwArgs(a), { flight_number: 'SH101', amount: 180 });
    assert.match(r.result.content[0].text, /^Booked a flight to Denver for \$180 \(airline price\)\. Booking reference: CONF-STUB-SH101\.$/);
    // "to Denver for $450": booked at $450 with the note.
    r = await stackBook(a, { destination: 'Denver', amount: 450 });
    assert.equal(r.result.isError, false); assert.deepEqual(gwArgs(a), { flight_number: 'SH000', amount: 450 });
    assert.match(r.result.content[0].text, /^Booked a flight to Denver for \$450 \(price as you stated it\)\. Booking reference: CONF-STUB-SH000\. You asked for \$450; the airline lists Denver at \$180; booked at your price\.$/);
    // "to London for $620" is the same price: no note, and the limit still blocks it.
    r = await stackBook(a, { destination: 'London', amount: 620 });
    assert.equal(r.result.isError, true); assert.match(text(r), /your stated price is \$620/); assert.doesNotMatch(text(r), /airline lists/);
    // "to London for $450": a stated price under the limit books, whatever London lists.
    r = await stackBook(a, { destination: 'London', amount: 450 });
    assert.equal(r.result.isError, false); assert.match(r.result.content[0].text, /^Booked a flight to London for \$450 \(price as you stated it\)\..*the airline lists London at \$620; booked at your price\.$/);
  });
});

test('premium-only judges a stated price too: $940 with a non-premium tier is blocked, with a premium tier and a high limit it books', async () => {
  const state = newState({ limit: '2000', tier: 'Premier Silver' });
  await withApp(FULL, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    let r = await stackBook(a, { amount: 940 });
    assert.equal(r.result.isError, true); assert.match(text(r), /fares over \$750 are for premium members only \(your stated price is \$940; your member tier is Premier Silver\)/); assert.doesNotMatch(text(r), /AI agent cannot|^Booked/);
    r = await stackBook(a, { amount: 750 }); assert.equal(r.result.isError, false, 'exactly 750 is not over 750');
    state.tier = 'Premier Gold';
    r = await stackBook(a, { amount: 940 });
    assert.equal(r.result.isError, false); assert.match(text(r), /^Booked a flight for \$940 \(price as you stated it\)\./);
    // Both rules at once: a low limit and a stated premium price.
    state.limit = '500'; state.tier = 'Premier Silver';
    r = await stackBook(a, { amount: 940 });
    assert.match(text(r), /over your limit \(your stated price is \$940; your limit is \$500\)|over your limit \(your stated price is \$940; your limit was not reported\)/); assert.match(text(r), /premium members only/);
  });
});

test('held 428: a stated price over the gateway default with no pre-approval limit is held, not booked', async () => {
  const state = newState({ limit: '1000' });
  await withApp(WITH_BRIDGE, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    assert.match(text(await stackBook(a, { amount: 450 })), /^Booked a flight for \$450/);
    const held = await stackBook(a, { amount: 620 });
    assert.equal(held.result.isError, true); assert.match(text(held), /held for the member's approval/); assert.match(text(held), /Nothing was booked yet/); assert.doesNotMatch(text(held), /Booked/);
    const heldNote = await stackBook(a, { destination: 'Denver', amount: 620 });
    assert.match(text(heldNote), /^You asked for \$620; the airline lists Denver at \$180\. This booking is held/); assert.doesNotMatch(text(heldNote), /Booked/);
  });
});

test('open-fare fails closed at the gateway for an untrusted connector: a clear message, nothing booked; catalogue flights are unaffected', async () => {
  const state = newState({ limit: '1000' });
  // No bridge secret: the connector is not a trusted caller.
  await withApp(TIER_ON, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    const r = await stackBook(a, { amount: 450 });
    assert.equal(r.result.isError, true); assert.match(text(r), /would not take a stated price from this connector/); assert.match(text(r), /trusted-caller setting/); assert.match(text(r), /Nothing was booked/); assert.doesNotMatch(text(r), /^Booked|open_fare|SH000/);
    assert.deepEqual(gwArgs(a), { flight_number: 'SH000', amount: 450 });
    for (const h of [PRE, LIM, 'x-internal-gateway-secret']) assert.equal(hdr(callHeaders(a)[0], h), undefined, `no ${h} without the secret`);
    const cat = await stackBook(a, { destination: 'Denver' });
    assert.match(text(cat), /^Booking denied: you have not authorized this agent/, 'a catalogue flight gets today\'s consent message');
  });
  // A wrong secret is the same.
  await withApp({ MUSE_GATEWAY_INTERNAL_SECRET: 'some-other-secret-not-real-0099', ...TIER_ON }, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    assert.match(text(await stackBook(a, { amount: 450 })), /would not take a stated price/);
  });
});

test('headers are unchanged: the consent bridge and pre-approval ride only on the book_flight tools/call, for a stated price too', async () => {
  const state = newState({ limit: '1000' });
  await withApp(FULL, { state }, async (a) => {
    a.script.book = realStackGateway({ state });
    for (const args of [{ amount: 450 }, { destination: 'Denver' }, { destination: 'Denver', amount: 450 }, { flightId: 'SH103' }, { destination: 'Nowhere', amount: 450 }]) {
      const before = a.gwCall().length;
      assert.equal((await stackBook(a, args)).result.isError, false, JSON.stringify(args));
      const h = a.gwCall()[before].init.headers;
      assert.equal(hdr(h, PRE), 'user-limit'); assert.equal(hdr(h, LIM), '1000'); assert.equal(hdr(h, 'x-internal-gateway-secret'), BRIDGE_SECRET); assert.equal(hdr(h, 'X-May-Act-Sub'), ACTOR);
    }
    for (const x of a.gw().filter((y) => y.method !== 'tools/call')) for (const k of [PRE, LIM, 'x-internal-gateway-secret', 'x-may-act-sub']) assert.equal(hdr(x.init.headers, k), undefined, `${x.method} has no ${k}`);
    // Bad input sends nothing at all, so no header can leave either.
    const n = a.gw().length;
    await stackBook(a, { amount: -1 }); await stackBook(a, {}); await a.call('list_flights', {});
    assert.equal(a.gw().length, n);
    // The other tool never carries them.
    await a.call('get_loyalty_status', {});
    assert.equal(hdr(a.gwCall().at(-1).init.headers, PRE), undefined);
  });
});

test('no secret, token or raw body reaches the agent for a stated price, whatever the stub gateway echoes', async () => {
  const state = newState({ limit: '1000' });
  await withApp(FULL, { state }, async (a) => {
    const leak = `${BRIDGE_SECRET} Bearer abcdefghijklmnop eyJhbGciOiJub25lIn0.eyJhYmNkZWZnaA.c2lnbmF0dXJl https://gw.example/muse-ig/mcp`;
    const runs = [
      () => json(200, stub.mcp({ confirmationNumber: BRIDGE_SECRET, fare: 450, note: leak })),
      () => json(403, { error: 'open_fare_untrusted', message: leak }),
      () => json(403, { error: 'access_denied' }, audit({ parameters: { Amount: '620' }, statements: [{ code: 'mcp-airline-agent-spend-limit', payload: { message: leak } }] }, { note: leak })),
      () => json(428, { error: 'consent_pending', detail: leak }),
    ];
    for (const [i, fn] of runs.entries()) {
      a.script.book = fn;
      const t = text(await stackBook(a, { destination: 'Denver', amount: 450 }));
      // A plain URL inside the airline server's own 200 answer is its content (only id-bearing URLs and tokens are scrubbed there); the error paths never carry the gateway URL.
      for (const bad of [BRIDGE_SECRET, 'abcdefghijklmnop', 'eyJhYmNkZWZnaA', ...(i === 0 ? [] : ['gw.example'])]) assert.ok(!t.includes(bad), `leaked ${bad} (run ${i})`);
    }
  });
});

test('a stated booking the airline server itself refuses (booked false, bad_open_fare_amount) is passed on as NOT confirmed, never as booked', async () => {
  const state = newState({ limit: '1000' });
  await withApp(FULL, { state }, async (a) => {
    a.script.book = () => json(200, { result: { content: [{ type: 'text', text: JSON.stringify({ booked: false, reason: 'bad_open_fare_amount', note: 'The quoted amount for an open-fare flight must be a positive number up to 100000 with at most 2 decimals.' }) }] } });
    const r = await stackBook(a, { amount: 450 });
    assert.equal(r.result.isError, false, 'the server answered; it is the content that says not booked');
    assert.equal(r.result.content[0].text, NOT_CONFIRMED); assert.doesNotMatch(r.result.content[0].text, /^Booked/); assert.match(text(r), /bad_open_fare_amount/);
    assert.ok(!r.result.content.some((c) => /^Booked/.test(c.text)));
  });
});

test('bookingToolResult with a plan: booked wording by source, denial wording by source; no plan keeps the flight-id wording', () => {
  const booked = { status: 'booked', fare: 450, confirmation: 'C-1' };
  assert.equal(bookingToolResult(booked, 'SH000', { plan: { flight: 'SH000', amount: 450, source: 'stated' } }).content[0].text, 'Booked a flight for $450 (price as you stated it). Booking reference: C-1.');
  assert.equal(bookingToolResult({ ...booked, fare: 620 }, 'SH106', { plan: { flight: 'SH106', amount: 620, source: 'catalogue', city: 'London' } }).content[0].text, 'Booked a flight to London for $620 (airline price). Booking reference: C-1.');
  assert.equal(bookingToolResult({ ...booked, fare: 180 }, 'SH101').content[0].text, 'Booked SH101 for $180. Booking reference: C-1.');
  for (const status of ['denied', 'consent_pending', 'not_booked', 'error', 'held', undefined]) {
    for (const plan of [null, { flight: 'SH000', amount: 450, source: 'stated', city: 'Denver' }, { flight: 'SH101', amount: 180, source: 'catalogue', city: 'Denver' }]) {
      const r = bookingToolResult({ status, fare: 450, evidence: null, facts: {} }, plan?.flight ?? 'SH101', { plan });
      assert.equal(r.isError, true); assert.doesNotMatch(r.content[0].text, /^Booked/);
    }
  }
});
