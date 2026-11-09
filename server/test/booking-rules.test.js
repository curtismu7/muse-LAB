import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { fineCheck } from '../src/gateway.js';
import { AGENT_LIMIT_DEFAULT, MEMBERS, PREMIUM_THRESHOLD, PREMIUM_TIERS, RULES, TIER_ATTRIBUTE, TIER_SOURCE_MOCK, TIER_SOURCE_REAL, evaluateBooking, fareFor, listFlights } from '../src/fares.js';
import { AUDIT_CAP, auditEvidence, classifyBooking, parseAuditTrail } from '../src/booking.js';

const A = RULES.agentSpendLimit.id;
const B = RULES.premiumOnly.id;

// The nine scenarios of the contract plus row 10 (a user with no airlineMemberTier): caller, flight, Mock PingOne user, and the rules that must deny.
const ROWS = [
  { n: 1, caller: 'agent', flight: 'SH103', fare: 480, member: 'standard', deny: [] },
  { n: 2, caller: 'agent', flight: 'SH104', fare: 500, member: 'standard', deny: [] },
  { n: 3, caller: 'agent', flight: 'SH106', fare: 620, member: 'standard', deny: [A] },
  { n: 4, caller: 'agent', flight: 'SH107', fare: 940, member: 'premium', deny: [A] },
  { n: 5, caller: 'human', flight: 'SH106', fare: 620, member: 'standard', deny: [] },
  { n: 6, caller: 'human', flight: 'SH108', fare: 750, member: 'standard', deny: [] },
  { n: 7, caller: 'human', flight: 'SH107', fare: 940, member: 'standard', deny: [B] },
  { n: 8, caller: 'human', flight: 'SH107', fare: 940, member: 'premium', deny: [] },
  { n: 9, caller: 'agent', flight: 'SH107', fare: 940, member: 'standard', deny: [A, B] },
  { n: 10, caller: 'human', flight: 'SH107', fare: 940, member: 'none', deny: [B] },
];

test('the shared catalogue holds the nine contract flights with the contract fares', () => {
  const f = Object.fromEntries(listFlights().map((x) => [x.id, x.fare]));
  assert.deepEqual(f, { SH101: 180, SH102: 320, SH103: 480, SH104: 500, SH105: 500.01, SH106: 620, SH107: 940, SH108: 750, SH109: 750.01 });
  assert.deepEqual(PREMIUM_TIERS, ['Premier Gold']);
  assert.equal(PREMIUM_THRESHOLD, 750);
  assert.equal(AGENT_LIMIT_DEFAULT, 500);
  assert.equal(MEMBERS.standard.tier, 'Premier Silver');
  assert.equal(MEMBERS.premium.tier, 'Premier Gold');
  assert.equal(MEMBERS.none.tier, undefined, 'the no-tier member has no airlineMemberTier at all');
  assert.equal(TIER_ATTRIBUTE, 'airlineMemberTier');
});

for (const s of ROWS) test(`scenario ${s.n}: ${s.caller} books ${s.flight} ($${s.fare}) as ${s.member} -> ${s.deny.length ? `DENY by ${s.deny.join(' and ')}` : 'passes both rules'}`, () => {
  assert.equal(fareFor(s.flight), s.fare);
  const r = fineCheck('flights.book', { flightId: s.flight }, { actor: s.caller, member: s.member });
  assert.equal(r.result, s.deny.length ? 'deny' : 'allow');
  assert.notEqual(r.result, 'step_up', 'over the limit is a hard deny, never a step-up');
  assert.deepEqual((r.rules ?? []).map((x) => x.id), s.deny, 'every denying rule is listed, A before B');
  assert.deepEqual((r.rules ?? []).map((x) => x.code), s.deny.map((id) => Object.values(RULES).find((x) => x.id === id).code));
});

test('extra rows: 500.01 by an agent is denied by A, 750.01 direct standard by B, exactly 500 and exactly 750 pass', () => {
  const ids = (flight, actor, member) => (fineCheck('flights.book', { flightId: flight }, { actor, member }).rules ?? []).map((x) => x.id);
  assert.deepEqual(ids('SH105', 'agent', 'standard'), [A]);
  assert.deepEqual(ids('SH104', 'agent', 'standard'), []);
  assert.deepEqual(ids('SH109', 'human', 'standard'), [B]);
  assert.deepEqual(ids('SH108', 'human', 'standard'), []);
  assert.deepEqual(ids('SH109', 'human', 'premium'), []);
  assert.deepEqual(ids('SH108', 'agent', 'standard'), [A], 'an agent at 750 is over the 500 limit but not over 750');
});

test("the user's own limit is data: an agent limit of 800 passes 620 and stops 940; no limit given means 500", () => {
  const m = (agentSpendLimit) => ({ tier: 'Premier Gold', agentSpendLimit });
  assert.equal(evaluateBooking({ fare: 620, actor: 'agent', member: m(800) }).failed.length, 0);
  assert.deepEqual(evaluateBooking({ fare: 940, actor: 'agent', member: m(800) }).failed.map((x) => x.id), [A]);
  for (const bad of [undefined, '', null, 'abc', NaN]) assert.deepEqual(evaluateBooking({ fare: 620, actor: 'agent', member: m(bad) }).failed.map((x) => x.id), [A], `limit ${String(bad)} falls back to 500`);
  assert.deepEqual(evaluateBooking({ fare: 940, actor: 'human', member: { tier: 'none' } }).failed.map((x) => x.id), [B], 'an unknown tier is not premium');
});

test('premium is an explicit list: Premier Silver, an empty value, a wrong-case value and a missing attribute are all NOT premium; only Premier Gold is', () => {
  const direct940 = (member) => evaluateBooking({ fare: 940, actor: 'human', member }).failed.map((x) => x.id);
  for (const tier of ['Premier Silver', '', 'premier gold', 'Gold', 'premium', 'Premier Gold ', undefined, null, 7]) assert.deepEqual(direct940({ tier }), [B], `tier ${JSON.stringify(tier)}`);
  assert.deepEqual(direct940({}), [B], 'no tier key');
  assert.deepEqual(direct940(undefined), [B], 'no member at all');
  assert.deepEqual(direct940({ tier: 'Premier Gold' }), []);
  const m = evaluateBooking({ fare: 940, actor: 'human', member: MEMBERS.none }).failed[0].message;
  assert.match(m, /member tier not set, from the Mock PingOne user \(mimics the airlineMemberTier attribute\)/);
});

test('the caller cannot lie: fare, amount, quoted, tier and limit in the arguments are never read', () => {
  const lie = { flightId: 'SH106', fare: 1, amount: 1, quoted: 1, tier: 'Premier Gold', limit: 99999, memberTier: 'Premier Gold', agentSpendLimit: 99999 };
  assert.deepEqual(fineCheck('flights.book', lie, { actor: 'agent', member: 'standard' }).rules.map((x) => x.id), [A]);
  assert.deepEqual(fineCheck('flights.book', { ...lie, flightId: 'SH107' }, { actor: 'human', member: 'standard' }).rules.map((x) => x.id), [B]);
});

test('unknown or malformed flights are denied as unknown, and a garbage member or actor falls back to the strict side', () => {
  for (const flightId of ['SH999', '', undefined, null, {}, ['SH106'], '__proto__', 'constructor']) {
    const r = fineCheck('flights.book', { flightId }, { actor: 'agent', member: 'standard' });
    assert.equal(r.result, 'deny');
    assert.match(r.rule, /Unknown flight/);
  }
  // a member key that is not one of the two records is the standard record, never a premium one
  for (const member of ['gold', '__proto__', 'constructor', undefined, 7]) assert.deepEqual(fineCheck('flights.book', { flightId: 'SH107' }, { actor: 'human', member }).rules.map((x) => x.id), [B]);
  // an unknown actor is judged as an agent (rule A applies)
  assert.deepEqual(fineCheck('flights.book', { flightId: 'SH106' }, { actor: 'robot', member: 'premium' }).rules.map((x) => x.id), [A]);
});

// ---- the app, end to end in Mock --------------------------------------------------------------------------------------
async function boot(env = {}, opts) {
  const server = createApp(env, opts).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
function visitor(base) {
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
}
async function mockSession(base) {
  const v = visitor(base);
  assert.equal((await v.post('/api/signin')).status, 200);
  return v;
}
// Runs one scenario the way the page does: set the member, get a token for the caller (consent for the agent), book.
async function runMock(v, s, args = {}) {
  assert.equal((await v.post('/api/member', { member: s.member })).status, 200);
  const via = s.caller === 'agent' ? 'muse' : 'browser';
  const a = await v.post('/api/authorize', { client: via });
  if (a.json.status === 'consent_required') await v.post('/api/consent', { client: via, approve: true });
  return v.post('/api/request', { tool: 'flights.book', args: { flightId: s.flight, ...args }, via });
}

test('end to end in Mock: all ten scenarios (nine contract rows and the no-tier user) through /api/request, with the rules named, the ledger and the Authorize attributes', async () => {
  const app = await boot();
  try {
    for (const s of ROWS) {
      const v = await mockSession(app.base);
      const r = await runMock(v, s);
      assert.equal(r.status, 200, `scenario ${s.n}`);
      const sess = (await v.get('/api/session')).json;
      if (s.deny.length) {
        assert.equal(r.json.outcome, 'blocked', `scenario ${s.n}`);
        assert.equal(r.json.result, undefined, 'the tool did not run');
        assert.deepEqual(sess.bookings, [], 'the ledger stays empty');
        assert.equal(sess.booking.status, 'denied');
        assert.equal(sess.booking.headline, 'Authorize rule applied: booking stopped');
        assert.deepEqual(sess.booking.rulesDenied.map((x) => x.id), s.deny);
        assert.equal(sess.booking.subheading, s.deny.length > 1 ? '2 rules denied this booking' : null);
        assert.equal(sess.booking.lines.length, s.deny.length);
        assert.match(sess.booking.message, /Nothing was booked\.$/);
        assert.equal(sess.booking.chip, 'simulated');
        assert.deepEqual(r.json.authorize.rulesDenied.map((x) => x.id), s.deny);
        assert.equal(r.json.authorize.decision, 'DENY');
      } else {
        assert.equal(r.json.outcome, 'allowed', `scenario ${s.n}`);
        assert.equal(r.json.result.fare, s.fare);
        assert.equal(sess.bookings.length, 1);
        assert.equal(sess.bookings[0].fare, s.fare);
        assert.equal(sess.booking.status, 'booked');
        assert.equal(r.json.authorize.decision, 'PERMIT');
      }
      const at = r.json.authorize.attributes;
      assert.equal(at.ToolName, 'book_airline_flight');
      assert.equal(at.Amount, s.fare, 'Authorize is asked about the catalogue fare');
      assert.equal(at.DecisionContext, 'McpToolCall');
      assert.equal('MemberTier' in at, false, 'the gateway sends no tier: Authorize reads it from the PingOne user');
      assert.equal(r.json.authorize.pingOneUser.attribute, 'airlineMemberTier');
      assert.equal(r.json.authorize.pingOneUser.value, MEMBERS[s.member].tier ?? null);
      assert.equal(r.json.authorize.pingOneUser.source, TIER_SOURCE_MOCK);
      assert.equal(sess.booking.facts.memberTier, MEMBERS[s.member].tier ?? 'not set');
      assert.equal(sess.booking.facts.tierSource, TIER_SOURCE_MOCK, 'the Mock tier is labelled as the Mock PingOne user mimicking the attribute');
      assert.match(sess.booking.hops[3].summary, /Member tier .*, read from the Mock PingOne user \(mimics the airlineMemberTier attribute\)\./);
      assert.doesNotMatch(sess.booking.hops[2].summary, /MemberTier/, 'hop 3 lists what the gateway sent, and it sent no tier');
      assert.doesNotMatch(sess.booking.hops[1].summary, /member tier/i, 'the gateway hop looks up no tier');
      assert.equal(at.AgentSpendLimit, 500);
      assert.equal(at.ActClientId === '', s.caller === 'human', 'a direct call carries no agent identity');
      assert.equal(r.json.authorize.simulated, true);
      assert.deepEqual(sess.booking.hops.map((h) => h.n), [1, 2, 3, 4, 5]);
      assert.ok(sess.booking.hops.every((h) => h.simulated === true), 'Mock hops say simulated');
    }
  } finally { await app.close(); }
});

test('Mock: a lying quote is judged at the catalogue fare, and a quote cannot raise the limit or change the tier', async () => {
  const app = await boot();
  try {
    const v = await mockSession(app.base);
    const r = await runMock(v, { caller: 'agent', flight: 'SH107', member: 'standard' }, { quoted: 100, fare: 1, amount: 1, tier: 'Premier Gold', limit: 99999 });
    assert.equal(r.json.outcome, 'blocked');
    assert.deepEqual(r.json.authorize.rulesDenied.map((x) => x.id), [A, B]);
    assert.equal(r.json.authorize.attributes.Amount, 940);
    const hop2 = (await v.get('/api/session')).json.booking.hops[1];
    assert.match(hop2.summary, /Muse said \$100; the claim is ignored/);
  } finally { await app.close(); }
});

test('Mock: an unknown flight is stopped by the gateway before Authorize and books nothing', async () => {
  const app = await boot();
  try {
    const v = await mockSession(app.base);
    const r = await runMock(v, { caller: 'agent', flight: 'SH999', member: 'standard' });
    assert.equal(r.json.outcome, 'blocked');
    const s = (await v.get('/api/session')).json;
    assert.deepEqual(s.bookings, []);
    assert.equal(s.booking.hops[1].state, 'stop');
    assert.equal(s.booking.hops[2].state, 'skipped');
  } finally { await app.close(); }
});

test('/api/member: only the two records, Mock only, same-origin, and Reset, sign-out and a mode switch put it back', async () => {
  const app = await boot();
  try {
    const v = await mockSession(app.base);
    for (const bad of ['gold', '', 7, null, ['premium'], { a: 1 }, '__proto__']) assert.equal((await v.post('/api/member', { member: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await v.post('/api/member', {})).status, 400);
    assert.equal((await v.post('/api/member', { member: 'premium' })).status, 200);
    const cross = await fetch(`${app.base}/api/member`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"member":"premium"}' });
    assert.equal(cross.status, 403);
    // the booking and the ledger go with it
    await runMock(v, { caller: 'human', flight: 'SH107', member: 'premium' });
    assert.equal((await v.get('/api/session')).json.bookings.length, 1);
    await v.post('/api/reset');
    let s = (await v.get('/api/session')).json;
    assert.deepEqual([s.booking, s.bookings], [null, []]);
    await v.post('/api/signin');
    await v.post('/api/member', { member: 'premium' });
    await v.post('/api/signout');
    await v.post('/api/signin');
    const again = await runMock(v, { caller: 'human', flight: 'SH107', member: 'standard' });
    assert.equal(again.json.outcome, 'blocked', 'sign-out put the member back to standard before this row set it');
    await v.post('/api/member', { member: 'premium' });
    await v.post('/api/mode', { source: 'mock' });
    s = (await v.get('/api/session')).json;
    assert.deepEqual([s.booking, s.bookings], [null, []]);
    await v.post('/api/signin');
    const r = await v.post('/api/request', { tool: 'flights.book', args: { flightId: 'SH107' }, via: 'browser' });
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) assert.equal(r.json.outcome, 'blocked', 'a mode switch put the member back to standard');
  } finally { await app.close(); }
});

test('all ten rows in one session, in order, inside 60 seconds: booking calls never trip the burst check (row 8 books)', async () => {
  const app = await boot();
  try {
    const v = await mockSession(app.base);
    const got = [];
    for (const s of ROWS) got.push((await runMock(v, s)).json.outcome);
    assert.deepEqual(got, ROWS.map((s) => (s.deny.length ? 'blocked' : 'allowed')), 'no row is held');
    const sess = (await v.get('/api/session')).json;
    assert.deepEqual(sess.bookings.map((b) => b.flightId), ['SH103', 'SH104', 'SH106', 'SH108', 'SH107'], 'rows 1, 2, 5, 6 and 8 are on the ledger; row 10 (no tier) books nothing');
  } finally { await app.close(); }
});

test('the burst demo (7 calendar calls) does not hold a booking that follows it, and bookings do not count toward the burst', async () => {
  const app = await boot();
  try {
    const v = await mockSession(app.base);
    assert.equal((await v.post('/api/authorize', { client: 'browser' })).json.status, 'issued');
    const burst = [];
    for (let i = 0; i < 7; i++) burst.push((await v.post('/api/request', { tool: 'calendar.read', args: {}, via: 'browser' })).json.outcome);
    assert.equal(burst.at(-1), 'held', 'the burst demo itself still holds');
    await v.post('/api/member', { member: 'premium' });
    const r = await v.post('/api/request', { tool: 'flights.book', args: { flightId: 'SH107' }, via: 'browser' });
    assert.equal(r.json.outcome, 'allowed', 'the booking is not held by the burst that came before it');
    // eight more bookings leave the burst counter where it was: the next calendar call is held only because of the earlier burst, not the bookings
    const fresh = await mockSession(app.base);
    await fresh.post('/api/authorize', { client: 'browser' });
    for (let i = 0; i < 8; i++) assert.equal((await fresh.post('/api/request', { tool: 'flights.book', args: { flightId: 'SH101' }, via: 'browser' })).json.outcome, 'allowed');
    assert.equal((await fresh.post('/api/request', { tool: 'calendar.read', args: {}, via: 'browser' })).json.outcome, 'allowed');
  } finally { await app.close(); }
});

test('/api/flights gives the page its numbers and rule cards; nothing is hard-coded in the page', async () => {
  const app = await boot();
  try {
    const j = (await visitor(app.base).get('/api/flights')).json;
    assert.deepEqual(j.rules, { agentLimit: 500, premiumThreshold: 750, premiumTiers: ['Premier Gold'], tierAttribute: 'airlineMemberTier', tierSourceReal: TIER_SOURCE_REAL, tierSourceMock: TIER_SOURCE_MOCK });
    assert.equal(TIER_SOURCE_REAL, 'PingOne user attribute airlineMemberTier (read by Authorize)');
    assert.equal(j.flights.length, 9);
    assert.deepEqual(j.members.map((m) => [m.key, m.tier]), [['standard', 'Premier Silver'], ['premium', 'Premier Gold'], ['none', undefined]]);
    assert.deepEqual(j.ruleCards.map((c) => [c.id, c.owner, c.line]), [[A, 'You', 'No tickets bought by an AI agent over $500'], [B, 'The airline', 'Only premium members can book over $750']]);
    assert.deepEqual(j.ruleCards.map((c) => c.code), ['mcp-airline-agent-spend-limit', 'mcp-airline-premium-only']);
  } finally { await app.close(); }
});

test('Mock booking makes zero outbound calls (netguard)', async () => {
  const app = await boot();
  try {
    const v = await mockSession(app.base);
    for (const s of ROWS) await runMock(v, s);
    const ng = (await v.get('/api/netguard')).json;
    assert.deepEqual([ng.mode, ng.attempts, ng.blocked, ng.selfTest], ['mock', 0, 0, true]);
  } finally { await app.close(); }
});

// ---- Real: the gateway's answer, read from a stub ---------------------------------------------------------------------
const URL9 = 'https://gw.example/mcp';
const step9 = (status, body, headers = {}) => ({ n: 9, title: 'Call book_airline_flight', request: { method: 'POST', url: URL9, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'book_airline_flight', arguments: { flight_number: 'SH106', amount: 620 } } } }, response: { status, headers, body } });
const trail = (o) => JSON.stringify(o);
// What the gateway sends Authorize now: no MemberTier. Authorize reads the tier from the PingOne user (attribute airlineMemberTier) itself.
const PARAMS_AGENT = { ToolName: 'book_airline_flight', Amount: '620', DecisionContext: 'McpToolCall', ActClientId: 'personal-agent.example', AgentSpendLimit: '500' };
const CODE_A = 'mcp-airline-agent-spend-limit';
const CODE_B = 'mcp-airline-premium-only';
const stmts = (...codes) => codes.map((code) => ({ code, payload: JSON.stringify({ denied: true, message: `from ${code}` }) })).concat([{ code: 'mcp-authorization-denied' }]);
const deny = (params, codes, extra = {}) => step9(403, { error: 'access_denied', decision: 'DENY', backend: 'real', tool: 'book_airline_flight' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'DENY', tool: 'book_airline_flight', parameters: params, statements: stmts(...codes) }, ...extra }) });
const classify = (s, o = {}) => classifyBooking(s, { flightId: 'SH106', quoted: 620, ...o });

test('Real 403 with rule A: the banner words, the rule named by its code, the attributes Authorize saw, nothing booked', () => {
  const b = classify(deny(PARAMS_AGENT, [CODE_A], { bookingFacts: { profileSource: 'default', agentSpendLimitUsd: 500 } }));
  assert.equal(b.status, 'denied');
  assert.equal(b.headline, 'Authorize rule applied: booking stopped');
  assert.deepEqual(b.rulesDenied.map((r) => r.code), [CODE_A]);
  assert.deepEqual(b.lines, ['Your rule — no tickets bought by an AI agent over $500: fare $620 is over your $500 limit.']);
  assert.equal(b.message, 'Your rule — no tickets bought by an AI agent over $500: fare $620 is over your $500 limit. Nothing was booked.');
  assert.equal(b.subheading, null);
  assert.equal(b.chip, 'PingOne Authorize');
  assert.equal(b.attributes.ActClientId, 'personal-agent.example');
  assert.equal('MemberTier' in b.attributes, false, 'the gateway did not send a tier');
  assert.equal(b.attributes.AgentSpendLimit, '500');
  assert.deepEqual([b.facts.memberTier, b.facts.agentSpendLimit, b.facts.profileSource], [undefined, 500, 'default'], 'the tier is not reported to Muse; it is not invented');
  assert.equal(b.facts.tierSource, 'PingOne user attribute airlineMemberTier (read by Authorize)');
  assert.doesNotMatch(b.hops[1].summary, /member tier/i, 'the gateway hop looks up no tier');
  assert.equal(b.hops[2].summary.includes('MemberTier'), false);
  assert.match(b.hops[3].summary, /Member tier not reported to Muse, read from the PingOne user attribute airlineMemberTier \(read by Authorize\)\./);
  assert.deepEqual(b.hops[3].raw.response.memberTier, { attribute: 'airlineMemberTier', value: null, source: 'PingOne user attribute airlineMemberTier (read by Authorize)' });
  assert.match(b.hops[1].summary, /default member record/, 'the default member record is said honestly');
  assert.equal(b.hops[3].state, 'stop');
  assert.equal(b.hops[3].raw.response.rulesDenied[0].code, CODE_A);
});

test('Real 403 with rule B (direct caller): the airline rule, with the tier source and no invented tier value', () => {
  const b = classify(deny({ ...PARAMS_AGENT, Amount: '940', ActClientId: '' }, [CODE_B]), { flightId: 'SH107', quoted: 940, channel: 'user' });
  assert.deepEqual(b.rulesDenied.map((r) => r.id), [B]);
  assert.deepEqual(b.lines, ['Airline rule — only premium members can book over $750: fare $940; member tier not reported to Muse, from the PingOne user attribute airlineMemberTier (read by Authorize).']);
  assert.equal(b.actor, 'human');
});

test('Real row 10, a user with no airlineMemberTier booking $940 directly: denied by the airline rule only, nothing invented about the tier', () => {
  const b = classify(deny({ ...PARAMS_AGENT, Amount: '940', ActClientId: '' }, [CODE_B]), { flightId: 'SH107', quoted: 940, channel: 'user' });
  assert.equal(b.status, 'denied');
  assert.deepEqual(b.rulesDenied.map((r) => r.id), [B]);
  assert.equal(b.actor, 'human');
  assert.equal(b.facts.memberTier, undefined);
  assert.match(b.lines[0], /^Airline rule/);
  assert.match(b.message, /Nothing was booked\.$/);
});

test('Real: a tier that the answer does carry is shown with its source; a stale gateway that still sends one is read, not trusted blindly', () => {
  const b = classify(deny({ ...PARAMS_AGENT, Amount: '940', ActClientId: '', MemberTier: 'Premier Silver' }, [CODE_B]), { flightId: 'SH107', quoted: 940, channel: 'user' });
  assert.equal(b.facts.memberTier, 'Premier Silver');
  assert.equal(b.facts.tierSource, TIER_SOURCE_REAL);
  assert.equal(b.lines[0], `Airline rule — only premium members can book over $750: fare $940; member tier Premier Silver, from the ${TIER_SOURCE_REAL}.`);
  assert.match(b.hops[3].summary, /Member tier Premier Silver, read from the PingOne user attribute airlineMemberTier \(read by Authorize\)\./);
});

test('Real 403 with both rules: both listed, "2 rules denied this booking", A then B whatever order the statements came in', () => {
  const b = classify(deny({ ...PARAMS_AGENT, Amount: '940' }, [CODE_B, CODE_A]), { flightId: 'SH107', quoted: 940 });
  assert.deepEqual(b.rulesDenied.map((r) => r.id), [A, B]);
  assert.equal(b.subheading, '2 rules denied this booking');
  assert.equal(b.lines.length, 2);
  assert.match(b.lines[0], /^Your rule/);
  assert.match(b.lines[1], /^Airline rule/);
  assert.match(b.message, /Nothing was booked\.$/);
});

test('Real 403 with only a generic code: still denied, no invented rule text, the code and its message shown raw', () => {
  const b = classify(step9(403, { error: 'access_denied' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'DENY', parameters: PARAMS_AGENT, statements: [{ code: 'some-other-rule', payload: { message: 'Nope' } }] } }) }));
  assert.equal(b.status, 'denied');
  assert.deepEqual(b.rulesDenied, []);
  assert.equal(b.headline, 'Booking stopped');
  assert.match(b.message, /Nope/);
  const c = classify(step9(403, { error: 'access_denied' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'DENY', statements: [{ code: 'mcp-authorization-denied' }] } }) }));
  assert.match(c.message, /Authorize returned mcp-authorization-denied/);
});

test('Real 403 without the audit header: denied, and it says the reason is not in the response', () => {
  const b = classify(step9(403, { error: 'access_denied', decision: 'DENY' }));
  assert.equal(b.status, 'denied');
  assert.equal(b.message, 'Denied by the gateway (HTTP 403). The reason is not in the response.');
  assert.deepEqual(b.rulesDenied, []);
  assert.equal(b.hops[3].state, 'stop', "the body's own decision is shown, with no rule behind it");
  assert.equal(b.hops[3].raw.response.rulesDenied, undefined);
});

test('Real 403 from the gateway itself (unknown flight fare, no data): the gateway stopped it before Authorize', () => {
  const b = classify(step9(403, { error: 'unknown_flight_fare', message: 'No fare for SH999', tool: 'book_airline_flight' }), { flightId: 'SH999', quoted: 100 });
  assert.equal(b.status, 'denied');
  assert.match(b.message, /unknown_flight_fare: No fare for SH999/);
  assert.equal(b.hops[1].state, 'stop');
  assert.equal(b.hops[2].state, 'skipped');
  assert.equal(b.hops[3].state, 'skipped');
  assert.deepEqual(b.rulesDenied, []);
});

test('Real 428: both rules passed, a person must approve, nothing booked, no ledger row', () => {
  const b = classify(step9(428, { error: 'hitl_required', hitl: true, decision: 'PERMIT', challengeId: 'c1' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'PERMIT', parameters: { ...PARAMS_AGENT, Amount: '480' } } }) }), { flightId: 'SH103', quoted: 480 });
  assert.equal(b.status, 'consent_pending');
  assert.match(b.message, /^Both rules passed \(fare \$480, agent limit \$500\)\. The gateway now wants a person to approve before booking\. Nothing was booked yet\.$/);
  assert.equal(b.hops[3].state, 'ok');
});

test('Real 200: booked, not_booked (fare_mismatch), and a booking the reported facts say a rule should have stopped is flagged', () => {
  const ok = (text) => step9(200, { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify(text) }] } });
  const booked = classify(ok({ booked: true, confirmationNumber: 'CNF1', flightNumber: 'SH103', amount: 480, fare: 480 }), { flightId: 'SH103', quoted: 480 });
  assert.equal(booked.status, 'booked');
  assert.equal(booked.message, 'Booked SH103 for $480 (CNF1).');
  assert.equal(booked.unexpected, false);
  const nb = classify(ok({ booked: false, reason: 'fare_mismatch', note: 'Quoted $100 does not match the fare for SH106.' }));
  assert.equal(nb.status, 'not_booked');
  assert.match(nb.message, /does not match the fare/);
  // booked at 940 by an agent: the reported limit says rule A should have denied it
  const withTrail = (params, fare) => ({ ...ok({ booked: true, confirmationNumber: 'CNF9', fare }), response: { status: 200, headers: { 'x-gw-audit-trail': trail({ authorize: { decision: 'PERMIT', parameters: params } }) }, body: ok({ booked: true, confirmationNumber: 'CNF9', fare }).response.body } });
  const bad = classify(withTrail({ ...PARAMS_AGENT, Amount: '940' }, 940), { flightId: 'SH107', quoted: 940 });
  assert.equal(bad.status, 'booked');
  assert.equal(bad.unexpected, true);
  assert.match(bad.headline, /should have stopped it/);
  // booked at 940 by a direct caller with no tier reported: Muse cannot tell whether rule B should have denied it (the tier is Authorize's), so it does not claim so
  const quiet = classify(withTrail({ ...PARAMS_AGENT, Amount: '940', ActClientId: '' }, 940), { flightId: 'SH107', quoted: 940, channel: 'user' });
  assert.equal(quiet.status, 'booked');
  assert.equal(quiet.unexpected, false);
  // but if the answer does carry a non-premium tier, a booking over 750 is flagged
  const flagged = classify(withTrail({ ...PARAMS_AGENT, Amount: '940', ActClientId: '', MemberTier: 'Premier Silver' }, 940), { flightId: 'SH107', quoted: 940, channel: 'user' });
  assert.equal(flagged.unexpected, true);
});

test('Real: 401, 500, a timeout, malformed JSON and a missing call are errors that never read as a booking', () => {
  for (const s of [step9(401, { error: 'invalid_token' }), step9(500, 'boom'), step9(200, 'not json'), step9(200, { result: { content: [{ type: 'text', text: 'not json' }] } }), step9(200, { result: { content: [{ type: 'text', text: '{"hello":1}' }] } }), step9(200, { error: { message: 'x' } }), { n: 9, request: {}, error: 'TimeoutError' }, { n: 9, skipped: true }, undefined, step9('200')]) {
    const b = classify(s);
    assert.equal(b.status, 'error', JSON.stringify(s)?.slice(0, 80));
    assert.match(b.message, /Nothing was booked|did not|stopped/i);
    assert.equal(b.confirmation, null);
  }
});

test('the audit header parser survives garbage, missing keys, arrays, huge values and hostile payloads', () => {
  assert.equal(parseAuditTrail(undefined), null);
  assert.equal(parseAuditTrail(''), null);
  assert.equal(parseAuditTrail('{not json'), null);
  assert.equal(parseAuditTrail('[1,2]'), null);
  assert.equal(parseAuditTrail('x'.repeat(AUDIT_CAP + 1)), null);
  assert.deepEqual(auditEvidence({}).statements, []);
  const e = auditEvidence({ authorize: { decision: 'deny', parameters: { Amount: { a: 1 }, MemberTier: ['x'], ToolName: 'x'.repeat(500), Evil: '<script>' }, statements: [null, 5, 'x', { code: 7, payload: '{"message":"m"}' }, { code: CODE_A, payload: { message: 'y'.repeat(900) } }] }, bookingFacts: { profileSource: 'evil', agentSpendLimitUsd: 'NaN' }, fareOverride: { claimed: 'a' } });
  assert.equal(e.decision, 'DENY');
  assert.equal(e.attributes.ToolName.length, 200);
  assert.equal('Evil' in e.attributes, false, 'only the named attributes are kept');
  assert.equal('Amount' in e.attributes, false);
  assert.equal(e.statements[1].message.length, 400);
  assert.equal(e.bookingFacts.profileSource, undefined);
  assert.equal(e.bookingFacts.agentSpendLimitUsd, undefined);
  assert.equal(e.fareOverride, null);
  assert.equal(classify(step9(403, {}, { 'x-gw-audit-trail': 'x'.repeat(AUDIT_CAP + 5) })).message, 'Denied by the gateway (HTTP 403). The reason is not in the response.');
});

// ---- Real, through the app: the request Muse sends, both channels, tokens kept on the server ----------------------------
const GW = 'https://gw.example/pft/mcp';
const P1 = 'https://auth.pingone.com/env1/as';
const UID = '00000000-0000-0000-0000-0000000000a1';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const AGENT_TOKEN = jwt({ iss: 'https://auth.pingone.com/env1', aud: 'client1', sub: 'sam', exp: 9999999999, marker: 'agent-token-marker' });
const USER_TOKEN = jwt({ iss: 'https://auth.pingone.com/env1', aud: UID, sub: 'sam', exp: 9999999999, marker: 'user-token-marker' });

async function liveBoot(callReply) {
  // The per-visitor sign-in limit is not what these tests are about.
  const seen = [];
  const routes = {
    [GW]: (init) => {
      if (!init.headers.authorization) return json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/pft/mcp"' });
      const m = JSON.parse(init.body).method;
      if (m === 'tools/call') return callReply(init);
      return json(200, { result: { tools: [{ name: 'book_airline_flight' }] } }, { 'mcp-session-id': 's1' });
    },
    'https://gw.example/.well-known/oauth-protected-resource/pft/mcp': () => json(200, { authorization_servers: ['https://gw.example/pft'] }),
    'https://gw.example/.well-known/oauth-authorization-server/pft': () => json(200, { issuer: 'https://gw.example/pft', authorization_endpoint: 'https://gw.example/pft/authorize', token_endpoint: 'https://gw.example/pft/token', scopes_supported: ['openid'], code_challenge_methods_supported: ['S256'] }),
    [`${P1}/token`]: (init) => json(200, { access_token: new URLSearchParams(init.body).get('client_id') === UID ? USER_TOKEN : AGENT_TOKEN }),
  };
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); const r = routes[String(url)]; if (!r) throw new Error(`unexpected ${url}`); return r(init); };
  const app = await boot({ ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'client1', MUSE_USER_CLIENT_ID: UID, MUSE_LIVE_PER_VISITOR_PER_MIN: '500', MUSE_LIVE_GLOBAL_PER_MIN: '500' }, { fetchImpl });
  const v = visitor(app.base);
  await v.post('/api/gateway-mode', { mode: 'live' });
  await v.post('/api/discover');
  await v.post('/api/live/register');
  const signIn = async (body) => { const pf = (await v.post('/api/live/signin', { ...body, piflow: true })).json.piflow; return v.post('/api/live/signin/complete', { state: pf.state, code: 'c' }); };
  return { app, v, seen, signIn, calls: () => seen.filter((s) => s.url === GW && JSON.parse(s.init.body).method === 'tools/call') };
}

test('Real through the app, agent channel: the 401 first, then sign-in, then Muse sends only flight_number and amount; the token never reaches the page', async () => {
  const t = await liveBoot(() => json(403, { error: 'access_denied', decision: 'DENY', backend: 'real', tool: 'book_airline_flight' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'DENY', parameters: PARAMS_AGENT, statements: stmts(CODE_A) } }) }));
  try {
    const ask = await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH106', channel: 'agent' });
    assert.equal(ask.json.state, 'auth_required');
    assert.equal(t.calls().length, 0, 'nothing is booked before sign-in');
    assert.equal((await t.signIn({})).status, 200);
    const c = t.calls();
    assert.equal(c.length, 1);
    const body = JSON.parse(c[0].init.body);
    assert.equal(body.params.name, 'book_airline_flight');
    assert.deepEqual(body.params.arguments, { flight_number: 'SH106', amount: 620 }, 'no tier, no limit, no token in the arguments');
    assert.equal(c[0].init.headers.authorization, `Bearer ${AGENT_TOKEN}`);
    const s = await t.v.get('/api/session');
    assert.equal(s.json.booking.status, 'denied');
    assert.deepEqual(s.json.booking.rulesDenied.map((r) => r.code), [CODE_A]);
    assert.deepEqual(s.json.bookings, []);
    assert.ok(!s.text.includes('agent-token-marker') && !s.text.includes('user-token-marker') && !s.text.includes(AGENT_TOKEN), 'no token in the session');
    const step = s.json.liveAuth.steps.find((x) => x.n === 9);
    assert.ok(step.response.headers['x-gw-audit-trail'], 'the audit header is kept for the trace');
    assert.ok(!/bearer\s+h\./i.test(JSON.stringify(s.json.liveAuth.steps)), 'no bearer token in any shown request');
    // a second row reuses the token and does not ask again
    const again = await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH103', channel: 'agent' });
    assert.equal(again.json.state, 'done');
    assert.equal(t.calls().length, 2);
  } finally { await t.app.close(); }
});

test('Real through the app, user channel: Sam signs in as himself (no agent), his token stays on the server, the booking runs with it', async () => {
  const t = await liveBoot(() => json(403, { error: 'access_denied', decision: 'DENY' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'DENY', parameters: { ...PARAMS_AGENT, Amount: '940', ActClientId: '' }, statements: stmts(CODE_B) } }) }));
  try {
    const ask = await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH107', channel: 'user' });
    assert.equal(ask.json.state, 'auth_required');
    assert.equal(ask.json.channel, 'user');
    assert.equal((await t.signIn({ as: 'user' })).status, 200);
    const c = t.calls();
    assert.equal(c.length, 1);
    assert.equal(c[0].init.headers.authorization, `Bearer ${USER_TOKEN}`, "Sam's own token, not the agent's");
    const s = await t.v.get('/api/session');
    assert.equal(s.json.booking.status, 'denied');
    assert.deepEqual(s.json.booking.rulesDenied.map((r) => r.id), [B]);
    assert.equal(s.json.booking.attributes.ActClientId, '');
    assert.equal(s.json.liveAuth.signedIn, false, 'the agent sign-in is untouched');
    assert.ok(!s.text.includes('user-token-marker') && !s.text.includes(USER_TOKEN), 'the user token never reaches the page');
    // Reset clears it: the next user row asks for sign-in again
    await t.v.post('/api/reset');
    await t.v.post('/api/gateway-mode', { mode: 'live' });
    const next = await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH107', channel: 'user' });
    assert.equal(next.json.state, 'auth_required');
  } finally { await t.app.close(); }
});

test('Real through the app: 428 is consent_pending and the ledger stays empty; a 200 booking adds one ledger row', async () => {
  let reply = () => json(428, { error: 'hitl_required', hitl: true, decision: 'PERMIT', challengeId: 'c1' }, { 'x-gw-audit-trail': trail({ authorize: { decision: 'PERMIT', parameters: { ...PARAMS_AGENT, Amount: '480' } } }) });
  const t = await liveBoot((init) => reply(init));
  try {
    await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH103', channel: 'agent' });
    await t.signIn({});
    let s = (await t.v.get('/api/session')).json;
    assert.equal(s.booking.status, 'consent_pending');
    assert.deepEqual(s.bookings, []);
    reply = () => json(200, { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"booked":true,"confirmationNumber":"CNF77","fare":480}' }] } });
    assert.equal((await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH103', channel: 'agent' })).json.state, 'done');
    s = (await t.v.get('/api/session')).json;
    assert.equal(s.booking.status, 'booked');
    assert.deepEqual(s.bookings.map((b) => [b.flightId, b.fare, b.confirmation]), [['SH103', 480, 'CNF77']]);
  } finally { await t.app.close(); }
});

test('Real through the app: a gateway that fails or answers garbage is an error, and bad input is refused before any call', async () => {
  const t = await liveBoot(() => new Response('not json', { status: 500 }));
  try {
    for (const bad of [{ flightId: 'NOPE' }, { flightId: 'SH999' }, { flightId: 'SH106', quoted: -1 }, { flightId: 'SH106', quoted: 'x' }, { flightId: 'SH106', quoted: 1e9 }, { flightId: {} }]) {
      assert.equal((await t.v.post('/api/live/ask', { scenario: 'book', ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH999', unknown: true })).json.state, 'auth_required', 'the explicit unknown-flight test is allowed');
    await t.signIn({});
    const s = (await t.v.get('/api/session')).json;
    assert.equal(s.liveAuth.error, null);
    assert.equal(s.booking.status, 'error');
    assert.deepEqual(s.bookings, []);
    // a lying quote is sent as quoted: the gateway, not Muse, decides which fare counts
    await t.v.post('/api/live/ask', { scenario: 'book', flightId: 'SH107', quoted: 100, channel: 'agent' });
    const last = JSON.parse(t.calls().at(-1).init.body);
    assert.deepEqual(last.params.arguments, { flight_number: 'SH107', amount: 100 });
  } finally { await t.app.close(); }
});

test('Real booking needs Real: in Mock the ask is refused (409)', async () => {
  const app = await boot();
  try {
    assert.equal((await visitor(app.base).post('/api/live/ask', { scenario: 'book', flightId: 'SH106' })).status, 409);
  } finally { await app.close(); }
});
