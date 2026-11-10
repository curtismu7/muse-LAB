// The "Book a flight" scenario: Muse -> Agent Gateway -> PingOne Authorize -> airline MCP server, under two rules:
//   A (yours)   no tickets bought by an AI agent over your limit ($500 by default, a per-user value)
//   B (airline) only premium members can book over $750
// Pure functions, no network, no state. Mock builds the same five hops from the local catalogue (labelled simulated);
// Real reads them from what the gateway actually answered, and says "not reported" for anything it did not send.
// The member tier is not the gateway's to send: PingOne Authorize reads it from the PingOne user (attribute airlineMemberTier). Muse only
// shows it when the answer happens to carry it, always with that source, and says "not reported to Muse" when it does not.
import { BOOKING_CONTEXT, BOOKING_TOOL_NAME, MOCK_AGENT_CLIENT, PREMIUM_THRESHOLD, RULES, RULE_BY_CODE, TIER_ATTRIBUTE, TIER_SOURCE_MOCK, TIER_SOURCE_REAL, evaluateBooking, fareFor, isPremium, mockMember, tierLabel } from './fares.js';

export const bookingTool = (env = {}) => String(env.MUSE_BOOKING_TOOL || BOOKING_TOOL_NAME);

// X-Gw-Audit-Trail comes from a server we do not control. Bounded in size, parsed once, every field optional.
export const AUDIT_CAP = 32768;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const prim = (v) => (typeof v === 'string' ? v.slice(0, 200) : (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// Authorize sends numbers as plain strings ("620"); read either.
const numish = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : undefined; if (typeof v === 'string' && /^\d{1,9}(\.\d{1,4})?$/.test(v.trim())) return Number(v); return undefined; };
const ATTRS = ['ToolName', 'Amount', 'DecisionContext', 'ActClientId', 'MemberTier', 'AgentSpendLimit'];

export function parseAuditTrail(value) {
  if (typeof value !== 'string' || !value || value.length > AUDIT_CAP) return null;
  try { const j = JSON.parse(value); return isObj(j) ? j : null; } catch { return null; }
}

export function auditEvidence(audit) {
  const az = isObj(audit?.authorize) ? audit.authorize : {};
  const attributes = {};
  if (isObj(az.parameters)) for (const k of ATTRS) { const v = prim(az.parameters[k]); if (v !== undefined) attributes[k] = v; }
  const statements = (Array.isArray(az.statements) ? az.statements : []).slice(0, 20).filter(isObj).map((s) => {
    let payload = s.payload;
    if (typeof payload === 'string' && payload.length <= 2000) { try { payload = JSON.parse(payload); } catch { /* keep the text */ } }
    if (typeof payload === 'string') payload = payload.slice(0, 500);
    else if (!isObj(payload)) payload = undefined;
    return { code: text(s.code, 120), ...(payload !== undefined ? { payload } : {}), ...(isObj(payload) && text(payload.message, 400) ? { message: text(payload.message, 400) } : {}) };
  });
  const fo = isObj(audit?.fareOverride) ? audit.fareOverride : null;
  const bf = isObj(audit?.bookingFacts) ? audit.bookingFacts : null;
  const d = text(az.decision, 20)?.toUpperCase();
  return {
    attributes: Object.keys(attributes).length ? attributes : null,
    statements,
    reason: text(az.reason),
    decision: d === 'DENY' || d === 'PERMIT' ? d : null,
    fareOverride: fo && (num(fo.claimed) !== undefined || num(fo.authoritative) !== undefined) ? { claimed: num(fo.claimed), authoritative: num(fo.authoritative) } : null,
    bookingFacts: bf ? { profileSource: ['sub', 'default'].includes(bf.profileSource) ? bf.profileSource : undefined, memberTier: text(bf.memberTier, 60), agentSpendLimitUsd: numish(bf.agentSpendLimitUsd) } : null,
  };
}

// ---- Words ------------------------------------------------------------------------------------------------------------
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const clauseFor = (rule, { fare, limit, tier }) => (rule.id === RULES.agentSpendLimit.id
  ? `fare ${fare === undefined ? '(not reported)' : `$${fare}`} is over your ${limit === undefined ? 'limit' : `$${limit} limit`}`
  : `fare ${fare === undefined ? '(not reported)' : `$${fare}`}; member tier ${tier ?? 'not reported to Muse'}, from the ${TIER_SOURCE_REAL}`);
// One denying rule, as the page shows it: the rule's own words first, then why it fired for this call.
export function deniedRule(rule, facts, message) {
  const line = rule.line(facts.limit);
  const m = message ?? clauseFor(rule, facts);
  return { id: rule.id, name: rule.name, code: rule.code, owner: rule.owner, short: rule.short, line, message: m, sentence: `${rule.short} — ${lower(line)}: ${m}.` };
}

const HEAD_DENIED = 'Authorize rule applied: booking stopped';
function words(status, c) {
  const denied = c.rulesDenied ?? [];
  const passedBits = [c.fare !== undefined && c.fare !== null ? `fare $${c.fare}` : null, c.limit !== undefined ? `agent limit $${c.limit}` : null, c.tier ? `member tier ${c.tier}` : null].filter(Boolean).join(', ');
  if (status === 'booked' && c.unexpected) return { headline: 'Booked, but an Authorize rule should have stopped it', subheading: null, lines: [], message: `Booked ${c.flightId} for $${c.fare} (${c.confirmation}). The facts the gateway reported say a rule should have denied this. Check that the policy change was imported and published.` };
  if (status === 'booked') return { headline: 'Booked', subheading: null, lines: [], message: `Booked ${c.flightId} for $${c.fare} (${c.confirmation}).` };
  if (status === 'denied' && denied.length) {
    const lines = denied.map((r) => r.sentence);
    return { headline: HEAD_DENIED, subheading: denied.length > 1 ? `${denied.length} rules denied this booking` : null, lines, message: `${lines.join(' ')} Nothing was booked.` };
  }
  if (status === 'denied') return { headline: 'Booking stopped', subheading: null, lines: [], message: c.reason ? `${c.reason}. Nothing was booked.` : 'Denied by the gateway (HTTP 403). The reason is not in the response.' };
  if (status === 'consent_pending') return { headline: 'Held for approval', subheading: null, lines: [], message: `Both rules passed${passedBits ? ` (${passedBits})` : ''}. The gateway now wants a person to approve before booking. Nothing was booked yet.` };
  if (status === 'held') return { headline: 'Held for approval', subheading: null, lines: [], message: 'The detection check held this call for a person to approve. Nothing was booked yet.' };
  if (status === 'not_booked') return { headline: 'Not booked', subheading: null, lines: [], message: c.reason ? `The airline server did not book it: ${c.reason}` : 'The airline server did not book it.' };
  return { headline: 'Could not complete the booking', subheading: null, lines: [], message: `${c.reason ?? 'The booking call failed.'} Nothing was booked.` };
}

// ---- Hops -------------------------------------------------------------------------------------------------------------
const hop = (n, from, to, title, summary, state, raw = {}, simulated = false) => ({ n, from, to, title, summary, state, ...(simulated ? { simulated: true } : {}), raw });
const money = (v) => (v === undefined || v === null ? '(not reported)' : `$${v}`);

// The five hops, from facts that either mode can fill in. state: ok | stop | unknown | skipped.
export function buildHops(f) {
  const sim = Boolean(f.simulated);
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: f.tool, arguments: { flight_number: f.flightId, amount: f.quoted } } };
  const fareKnown = typeof f.fareUsed === 'number';
  const stoppedEarly = f.stoppedAt === 2;
  const claimed = f.fareOverride?.claimed ?? (fareKnown && f.quoted !== f.fareUsed ? f.quoted : undefined);
  const facts = f.facts ?? {};
  const factText = `agent spend limit ${money(facts.agentSpendLimit)}${facts.profileSource === 'default' ? ' (default member record: this user has no record of their own)' : facts.profileSource === 'sub' ? " (this user's own record)" : facts.profileSource === 'mock' ? ' (the Mock member record)' : ''}`;
  const h2 = fareKnown
    ? hop(2, 'Agent Gateway', 'Fare + agent limit', 'The gateway looks up the facts', `Catalogue fare for ${f.flightId} is $${f.fareUsed}; ${factText}.${claimed !== undefined && claimed !== f.fareUsed ? ` Muse said $${claimed}; the claim is ignored.` : ''}`, 'ok', { response: { flight_number: f.flightId, fare: f.fareUsed, ...(claimed !== undefined ? { claimed } : {}), ...(facts.agentSpendLimit !== undefined ? { agentSpendLimit: facts.agentSpendLimit } : {}), ...(facts.profileSource ? { profileSource: facts.profileSource } : {}) } }, sim)
    : stoppedEarly
      ? hop(2, 'Agent Gateway', 'Fare + agent limit', 'The gateway looks up the facts', f.stopNote ?? `${f.flightId} has no fare in the catalogue, so the gateway stops here.`, 'stop', {}, sim)
      : hop(2, 'Agent Gateway', 'Fare + agent limit', 'The gateway looks up the facts', 'The gateway did not report which fare or limit it used.', f.status === 'error' ? 'skipped' : 'unknown', {}, sim);
  const h3 = f.attributes
    ? hop(3, 'Agent Gateway', 'PingOne Authorize', 'The gateway asks Authorize', Object.entries(f.attributes).map(([k, v]) => `${k} ${v === '' ? '(empty)' : v}`).join(', '), 'ok', { request: { attributes: f.attributes } }, sim)
    : hop(3, 'Agent Gateway', 'PingOne Authorize', 'The gateway asks Authorize', stoppedEarly || f.status === 'error' ? 'Authorize was not asked.' : 'The gateway did not report what it sent to Authorize.', stoppedEarly || f.status === 'error' ? 'skipped' : 'unknown', {}, sim);
  const denied = f.rulesDenied ?? [];
  // The tier is Authorize's own read of the PingOne user, not something the gateway sends: shown with its source, never in the gateway hops.
  const tierSource = facts.tierSource ?? (sim ? TIER_SOURCE_MOCK : TIER_SOURCE_REAL);
  const tierText = `Member tier ${facts.memberTier ?? 'not reported to Muse'}, read from the ${tierSource}.`;
  const decided = f.decision === 'DENY' || f.decision === 'PERMIT';
  const h4 = decided
    ? hop(4, 'PingOne Authorize', 'Agent Gateway', 'Authorize decides', `${f.decision === 'PERMIT' ? 'PERMIT: neither booking rule fired' : denied.length ? `DENY by ${denied.map((r) => `${r.short.toLowerCase()} (${r.code})`).join(' and ')}` : `DENY${f.genericReason ? `: ${f.genericReason}` : ''}`}. ${tierText}`, f.decision === 'DENY' ? 'stop' : 'ok', { response: { decision: f.decision, memberTier: { attribute: TIER_ATTRIBUTE, value: facts.memberTier ?? null, source: tierSource }, ...(denied.length ? { rulesDenied: denied.map((r) => ({ name: r.name, code: r.code, owner: r.owner, message: r.message })) } : {}), ...(f.audit ? { auditTrail: f.audit } : {}) } }, sim)
    : hop(4, 'PingOne Authorize', 'Agent Gateway', 'Authorize decides', stoppedEarly || f.status === 'error' ? 'No Authorize decision.' : 'No decision or rule was reported in the response.', stoppedEarly || f.status === 'error' ? 'skipped' : 'unknown', f.audit ? { response: { auditTrail: f.audit } } : {}, sim);
  const h5 = hop(5, 'Agent Gateway', 'Muse', 'The result comes back', f.resultNote, f.status === 'booked' ? 'ok' : 'stop', { response: f.rawResponse ?? { status: f.status } }, sim);
  const who = f.actor === 'human' ? ' with Sam\'s own token (no agent)' : '';
  return [hop(1, 'Muse', 'Agent Gateway', 'Muse calls the gateway', `tools/call ${f.tool} {flight_number: ${f.flightId}, amount: ${f.quoted}}${who}`, 'ok', { request: f.rawRequest ?? call }, sim), h2, h3, h4, h5];
}

// ---- Mock -------------------------------------------------------------------------------------------------------------
const mockAttributes = (fare, actor, member, tool = BOOKING_TOOL_NAME) => ({
  ToolName: tool, Amount: fare, DecisionContext: BOOKING_CONTEXT,
  ActClientId: actor === 'agent' ? MOCK_AGENT_CLIENT : '', AgentSpendLimit: member.agentSpendLimit,
});

// What Authorize would be asked and answer, from the catalogue fare and the member record (never from the claimed amount).
export function mockAuthorize({ flightId, fine, actor = 'agent', member = 'standard', limit, tool = BOOKING_TOOL_NAME }) {
  const fare = fareFor(flightId);
  if (!fine || fare === null) return null;
  const m = mockMember(member, limit);
  const ev = evaluateBooking({ fare, actor, member: m });
  const rulesDenied = ev.failed.map((r) => deniedRule(r, { fare, limit: ev.limit, tier: ev.tier }, r.message));
  const passed = Object.values(RULES).filter((r) => !ev.failed.some((x) => x.id === r.id)).map((r) => ({ id: r.id, name: r.name, code: r.code, owner: r.owner, applies: !(r.id === RULES.agentSpendLimit.id && actor !== 'agent') }));
  return {
    simulated: true, source: 'Mock',
    attributes: mockAttributes(fare, actor, m, tool),
    // What the simulated Authorize read from the Mock PingOne user. In Real this is Authorize's own lookup; the gateway does not send it.
    pingOneUser: { attribute: TIER_ATTRIBUTE, value: m.tier ?? null, source: TIER_SOURCE_MOCK },
    decision: fine.result === 'deny' ? 'DENY' : 'PERMIT',
    rulesDenied: rulesDenied.map(({ id, name, code, owner, message }) => ({ id, name, code, owner, message })),
    rulesPassed: passed,
  };
}

export function mockBooking({ flightId, quoted, fine, outcome, rules = [], result = null, actor = 'agent', member = 'standard', limit, tool = BOOKING_TOOL_NAME }) {
  const fare = fareFor(flightId);
  const m = mockMember(member, limit);
  const q = Number.isFinite(Number(quoted)) && Number(quoted) > 0 ? Number(quoted) : fare ?? 0;
  const unknown = fare === null;
  const status = outcome === 'allowed' ? 'booked' : outcome === 'held' ? 'held' : 'denied';
  const az = fine && !unknown ? mockAuthorize({ flightId, fine, actor, member, limit, tool }) : null;
  const rulesDenied = (fine?.rules ?? []).map((r) => deniedRule(r, { fare, limit: m.agentSpendLimit, tier: tierLabel(m) }, r.message));
  const reason = fine?.result === 'deny' ? fine.rule : (rules.find(Boolean) ?? 'Blocked');
  const confirmation = result?.confirmationNumber;
  const w = words(status, { flightId, fare, confirmation, reason, rulesDenied, limit: m.agentSpendLimit, tier: tierLabel(m) });
  const decision = fine && !unknown ? (fine.result === 'deny' ? 'DENY' : 'PERMIT') : null;
  const resultNote = status === 'booked' ? `Booked: ${confirmation}.` : status === 'held' ? 'Held for approval. Nothing was booked yet.' : `Stopped. The tool did not run. ${reason}`;
  const hops = buildHops({
    simulated: true, tool, flightId, quoted: q, actor, fareUsed: fare ?? undefined, stoppedAt: unknown ? 2 : undefined, stopNote: unknown ? `${flightId} has no fare in the catalogue, so the gateway stops here.` : undefined,
    facts: { memberTier: tierLabel(m), tierSource: TIER_SOURCE_MOCK, agentSpendLimit: m.agentSpendLimit, profileSource: 'mock' },
    attributes: az?.attributes ?? null, decision, rulesDenied, genericReason: fine?.result === 'deny' ? fine.rule : undefined,
    status: status === 'denied' && !fine ? 'error' : status, resultNote,
    rawResponse: status === 'booked' ? result : { blocked: true, reason },
  });
  return {
    mode: 'mock', flightId, fare, quoted: q, actor, member, status, rulesDenied, ruleApplied: rulesDenied.length > 0,
    reason: status === 'denied' ? reason : null, ...w, chip: 'simulated', hops, facts: { memberTier: tierLabel(m), tierSource: TIER_SOURCE_MOCK, agentSpendLimit: m.agentSpendLimit, profileSource: 'mock' },
    attributes: az?.attributes ?? null, evidence: null, at: new Date().toISOString(),
  };
}

// ---- Real -------------------------------------------------------------------------------------------------------------
// Reads the gateway's answer to the tools/call (the step 9 record from liveauth.js) into a booking. Never throws; anything it
// cannot read is an error that books nothing. channel: 'agent' (delegated token) or 'user' (Sam's own token).
export function classifyBooking(step9, { flightId, quoted, tool = BOOKING_TOOL_NAME, channel = 'agent' } = {}) {
  const catalogueFare = fareFor(flightId);
  const base = { mode: 'live', flightId, quoted, channel, at: new Date().toISOString() };
  const finish = (status, c) => {
    const ev = c.ev ?? null;
    const attrs = ev?.attributes ?? null;
    const bf = ev?.bookingFacts ?? null;
    const fare = numish(attrs?.Amount) ?? ev?.fareOverride?.authoritative ?? c.fare ?? catalogueFare ?? undefined;
    const limit = numish(attrs?.AgentSpendLimit) ?? bf?.agentSpendLimitUsd;
    const tier = text(typeof attrs?.MemberTier === 'string' ? attrs.MemberTier : undefined, 60) ?? bf?.memberTier;
    const actor = attrs && attrs.ActClientId !== undefined ? (attrs.ActClientId === '' ? 'human' : 'agent') : channel === 'user' ? 'human' : 'agent';
    const facts = { memberTier: tier, tierSource: TIER_SOURCE_REAL, agentSpendLimit: limit, profileSource: bf?.profileSource };
    // Only the rules the policy names by statement code are called rules; any other code is shown raw with its own message.
    const codes = (ev?.statements ?? []).map((s) => s.code);
    const stmtMessage = (r) => ev.statements.find((s) => s.code === r.code)?.message;
    const rulesDenied = status === 'denied' ? Object.values(RULES).filter((r) => codes.includes(r.code)).map((r) => deniedRule(r, { fare, limit, tier }, fare === undefined ? stmtMessage(r) : undefined)) : [];
    // A booking that went through although the reported facts say a rule should have denied it.
    const shouldDeny = status === 'booked' && typeof fare === 'number' && ((actor === 'agent' && limit !== undefined && fare > limit) || (tier !== undefined && fare > PREMIUM_THRESHOLD && !isPremium(tier)));
    const w = words(status, { flightId, fare, limit, tier, ...c, rulesDenied, unexpected: shouldDeny });
    const other = (ev?.statements ?? []).find((s) => (s.message || s.code) && !RULE_BY_CODE[s.code]);
    const hops = buildHops({
      simulated: false, tool, flightId, quoted, actor, fareUsed: typeof fare === 'number' && (attrs || ev?.fareOverride) ? fare : c.fareUsed, attributes: attrs, fareOverride: ev?.fareOverride, facts,
      decision: c.decision ?? ev?.decision ?? null, rulesDenied, genericReason: other?.message ?? (other?.code ? `Authorize returned ${other.code}` : c.reason), audit: c.audit ?? null,
      status, stoppedAt: c.stoppedAt, stopNote: c.stopNote, rawRequest: step9?.request?.body ? step9.request : undefined,
      resultNote: c.resultNote, rawResponse: step9?.response ? { status: step9.response.status, body: step9.response.body } : undefined,
    });
    return {
      ...base, fare: fare ?? null, actor, confirmation: c.confirmation ?? null, status, rulesDenied, ruleApplied: rulesDenied.length > 0, reason: c.reason ?? null, unexpected: shouldDeny, ...w,
      chip: rulesDenied.length && ev ? 'PingOne Authorize' : null, hops, facts, attributes: attrs,
      evidence: { httpStatus: step9?.response?.status ?? null, auditTrailPresent: Boolean(c.audit), ...(ev ? { attributes: attrs, statements: ev.statements, authorizeReason: ev.reason ?? null, fareOverride: ev.fareOverride, bookingFacts: bf } : {}) },
    };
  };

  if (!step9) return finish('error', { reason: 'The gateway did not run the booking call (the tool list was not available)', resultNote: 'No booking call was made.' });
  if (step9.skipped) return finish('error', { reason: 'The booking call was not made: that origin is not allowed', resultNote: 'No booking call was made.' });
  if (step9.error) return finish('error', { reason: `The booking call did not complete (${String(step9.error).slice(0, 40)})`, resultNote: `No answer (${String(step9.error).slice(0, 40)}). Nothing was booked.` });
  const res = step9.response;
  const status = Number(res?.status);
  if (!Number.isInteger(status)) return finish('error', { reason: 'The gateway gave no HTTP status', resultNote: 'No usable answer.' });
  const audit = parseAuditTrail(res.headers?.['x-gw-audit-trail']);
  const ev = audit ? auditEvidence(audit) : null;
  const body = res.body;
  const ctx = { ev, audit: ev ? { ...(isObj(audit.authorize) ? { authorize: { decision: ev.decision, tool: text(audit.authorize.tool, 80), parameters: ev.attributes, reason: ev.reason, statements: ev.statements } } : {}), ...(ev.fareOverride ? { fareOverride: ev.fareOverride } : {}), ...(ev.bookingFacts ? { bookingFacts: ev.bookingFacts } : {}) } : null };

  if (status === 200) {
    if (isObj(body) && body.error) return finish('error', { ...ctx, reason: `The gateway answered with a JSON-RPC error: ${text(isObj(body.error) ? body.error.message : body.error, 120) ?? 'no message'}`, resultNote: 'JSON-RPC error. Nothing was booked.' });
    const t = isObj(body) ? body.result?.content?.[0]?.text : undefined;
    let r = null;
    try { r = JSON.parse(String(t ?? '')); } catch { /* not JSON */ }
    if (!isObj(r)) return finish('error', { ...ctx, reason: 'The answer was not readable as a booking result', resultNote: 'Unreadable answer. Nothing was booked.' });
    if (r.booked === true) {
      const booked = num(r.fare) ?? num(r.amount) ?? catalogueFare ?? undefined;
      const confirmation = text(r.confirmationNumber, 60) ?? 'no confirmation number';
      return finish('booked', { ...ctx, fare: booked, confirmation, resultNote: `Booked: ${confirmation}.` });
    }
    if (r.booked === false) {
      const why = text(r.note, 200) ?? text(r.reason, 100) ?? 'no reason given';
      return finish('not_booked', { ...ctx, reason: why, resultNote: `Not booked: ${why}` });
    }
    return finish('error', { ...ctx, reason: 'The result did not say whether it booked', resultNote: 'Unclear answer. Nothing was booked.' });
  }

  if (status === 403) {
    const b = isObj(body) ? body : {};
    const known = ev?.statements.some((s) => RULE_BY_CODE[s.code]);
    const other = ev?.statements.find((s) => s.message || s.code);
    const err = text(b.error, 80);
    // The gateway's own backstop (unknown flight, no data, missing scope) answers with an error name; Authorize was never asked.
    const local = Boolean(err) && err !== 'access_denied';
    const reason = known ? null : local ? `${err}${text(b.message, 200) ? `: ${text(b.message, 200)}` : ''}` : other?.message ?? (other?.code ? `Authorize returned ${other.code}` : ev?.reason ?? null);
    const decision = known || err === 'access_denied' ? 'DENY' : ev?.decision ?? null;
    return finish('denied', {
      ...ctx, reason, decision: local ? null : decision, stoppedAt: local ? 2 : undefined, stopNote: local ? reason : undefined,
      resultNote: `HTTP 403${known ? ` with ${ev.statements.filter((s) => RULE_BY_CODE[s.code]).map((s) => s.code).join(' and ')}` : ''}. The tool did not run.`,
    });
  }

  if (status === 428) {
    const b = isObj(body) ? body : {};
    return finish('consent_pending', { ...ctx, decision: text(b.decision, 20)?.toUpperCase() === 'PERMIT' ? 'PERMIT' : ev?.decision ?? null, resultNote: 'HTTP 428: a person must approve. Muse does not do the approval step. Nothing was booked.' });
  }

  return finish('error', { ...ctx, reason: `The gateway answered HTTP ${status}`, resultNote: `HTTP ${status}. Nothing was booked.` });
}
