// "What Privilege did" for Muse (Rule 25): builds the trace records the page shows, with the shared gatewayTrace.js.
//
// MOCK. Muse's own simulated gateway (gateway.js decide) computes, in this order: who is calling (Protect, decided when the token was issued and
// carried on it), the velocity check, the instruction check, the coarse tool check, then the business rule (for a booking, the two Authorize rules,
// evaluated by fares.js evaluateBooking). Each of those is a `checked` decision here, because the code really evaluated it. Nothing else is invented:
// the request is the call the simulation received, the reply is what it answered, and the host is a non-real one (.invalid).
//
// REAL. Muse has its own hop (liveauth.js callGateway), not the shared gateway-real client, so the trace is built from the steps it already holds.
// The real gateway reports no per-check breakdown: decisions are `inferred` (read from the status) or `observed` (read from the reply, including the
// X-Gw-Audit-Trail header the gateway sends with an Authorize decision). Never `checked`. The bearer token is shown as its length only.
import { bearerForDisplay, failureTrace, mockTrace, realTrace } from './gatewayTrace.js';
import { auditEvidence, parseAuditTrail } from './booking.js';
import { PREMIUM_THRESHOLD, RULES, RULE_BY_CODE, TIER_NOT_SET } from './fares.js';
import { BURST_MAX, BURST_WINDOW_MS } from './detect.js';

export const MOCK_GATEWAY_URL = 'https://gateway.mock.invalid/mcp';
const MOCK_AUTHORIZATION = 'Bearer simulated-token (Mock: no real token exists)';

const rpcCall = (tool, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args ?? {} } });
const toolResult = (result) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
const dec = (id, label, outcome, evidence) => ({ id, label, outcome, evidence });
// Read from the gateway's reply (the audit trail header): `observed`.
const seen = (id, label, outcome, evidence) => ({ ...dec(id, label, outcome, evidence), basis: 'observed' });

// The two booking rules as Authorize's stand-in evaluated them. `authorize` is booking.js mockAuthorize's answer.
function bookingRuleDecisions(authorize) {
  const attrs = authorize.attributes ?? {};
  const fare = attrs.Amount;
  const limit = attrs.AgentSpendLimit;
  const tier = authorize.pingOneUser?.value ?? TIER_NOT_SET;
  const denied = new Map(authorize.rulesDenied.map((r) => [r.id, r]));
  return [RULES.agentSpendLimit, RULES.premiumOnly].map((rule) => {
    const label = `${rule.short}: ${rule.name}`;
    const no = denied.get(rule.id);
    if (no) return dec(rule.id, label, 'fail', `${rule.code}: ${no.message}`);
    if (rule.id === RULES.agentSpendLimit.id) {
      const applies = authorize.rulesPassed.find((r) => r.id === rule.id)?.applies !== false;
      return dec(rule.id, label, 'pass', applies ? `${rule.code}: fare $${fare} is not over your $${limit} limit` : `${rule.code}: does not apply, a person is booking directly and not an agent`);
    }
    return dec(rule.id, label, 'pass', fare > PREMIUM_THRESHOLD ? `${rule.code}: fare $${fare}; member tier ${tier} is premium` : `${rule.code}: fare $${fare} is not over $${PREMIUM_THRESHOLD}`);
  });
}

// d = gateway.js decide()'s answer; authorize = booking.js mockAuthorize() for a flights.book call (else null); result = the tool's result when it ran.
export function mockCallTrace({ tool, args, d, authorize = null, result = null, rules = [] }) {
  const decisions = [dec('caller', 'Who is calling (Protect)', d.protect.deny ? 'fail' : 'pass', `${d.protect.rule} Decided when the token was issued and carried on it.`)];
  const [velocity, instruction] = d.detect.steps;
  decisions.push(velocity.result === 'flag'
    ? dec('velocity', 'Velocity check', 'info', `${BURST_MAX} or more calls in the last ${BURST_WINDOW_MS / 1000} seconds: the call is held for a person`)
    : dec('velocity', 'Velocity check', 'pass', tool === 'flights.book' ? 'booking calls are not counted toward the burst limit' : `fewer than ${BURST_MAX} calls in the last ${BURST_WINDOW_MS / 1000} seconds`));
  decisions.push(instruction.result === 'block'
    ? dec('instruction', 'Instruction check', 'fail', 'the arguments match an injected-instruction pattern')
    : dec('instruction', 'Instruction check', 'pass', 'no injected-instruction pattern in the arguments'));
  decisions.push(dec('tool-access', 'Tool check', d.coarse.result === 'allow' ? 'pass' : 'fail', d.coarse.rule));
  if (!d.fine) decisions.push(dec('business-rule', 'Business rule', 'skipped', 'not reached: the tool check refused the call'));
  else if (tool === 'flights.book' && authorize) decisions.push(...bookingRuleDecisions(authorize));
  else decisions.push(dec('business-rule', 'Business rule', d.fine.result === 'allow' ? 'pass' : d.fine.result === 'deny' ? 'fail' : 'info', d.fine.rule));

  const status = d.outcome === 'allowed' ? 200 : d.outcome === 'held' ? 428 : 403;
  const body = d.outcome === 'allowed' ? toolResult(result)
    : d.outcome === 'held' ? { error: 'approval_required', reasons: rules }
      : { error: 'access_denied', decision: 'DENY', reasons: rules };
  return mockTrace({ url: MOCK_GATEWAY_URL, authorization: MOCK_AUTHORIZATION, rpc: rpcCall(tool, args), status, body, decisions });
}

// A held call a person approved: the simulation recorded the approval, then ran the tool.
export function approvedTrace({ tool, args, result }) {
  return mockTrace({
    url: MOCK_GATEWAY_URL, authorization: MOCK_AUTHORIZATION, rpc: rpcCall(tool, args), status: 200, body: toolResult(result),
    decisions: [dec('approval', 'Person approval', 'pass', 'a person approved the held call (simulated CIBA), then the tool ran')],
  });
}

// ---- Real ---------------------------------------------------------------------------------------------------------------
const MIN_SECRET = 8;
// Replaces every secret value found anywhere in `value` (string leaves only). A trace is never allowed to carry the token the call was made with.
export function scrubDeep(value, secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET).sort((a, b) => b.length - a.length);
  const walk = (v) => {
    if (typeof v === 'string') return list.reduce((s, secret) => s.split(secret).join('[redacted]'), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

const SETUP = { 7: 'initialize', 8: 'tools/list' };
const shortSession = (h = {}) => (typeof h['mcp-session-id'] === 'string' ? { ...h, 'mcp-session-id': `${h['mcp-session-id'].slice(0, 6)}… (shortened)` } : h);

// What the audit header says Authorize decided. The gateway sent this in the reply, so these are `observed`.
function auditDecisions(headers) {
  const ev = auditEvidence(parseAuditTrail(headers?.['x-gw-audit-trail']) ?? {});
  if (!ev.decision) return null;
  const out = [seen('authorize', 'PingOne Authorize', ev.decision === 'DENY' ? 'fail' : 'pass', `the gateway's audit trail (X-Gw-Audit-Trail) reports ${ev.decision}${ev.reason ? `: ${ev.reason}` : ''}`)];
  if (ev.decision === 'DENY') {
    ev.statements.filter((s) => s.code || s.message).slice(0, 5).forEach((s, i) => {
      const rule = RULE_BY_CODE[s.code];
      out.push(rule
        ? seen(rule.id, `${rule.short}: ${rule.name}`, 'fail', `statement ${s.code}${s.message ? `: ${s.message}` : ''}`)
        : seen(`statement-${i}`, 'Authorize statement', 'fail', `${s.code ?? 'no code'}${s.message ? `: ${s.message}` : ''}`));
    });
  }
  return out;
}

// steps = what liveauth.js callGateway returned (n 7 initialize, 8 tools/list, 9 tools/call). token = the bearer it used, shown by length only.
// Returns null when there was no gateway call to show.
export function realCallTrace(steps, { token, secrets = [] } = {}) {
  const calls = (steps ?? []).filter((s) => SETUP[s.n] || s.n === 9);
  const primary = calls.at(-1);
  if (!primary) return null;
  const authorization = bearerForDisplay('(token)', () => token ?? '');
  const url = primary.request?.url ?? '';
  const rpc = primary.request?.body ?? null;
  const setup = calls.slice(0, -1).map((s) => ({ label: SETUP[s.n] ?? 'tools/call', status: s.response?.status ?? null }));
  let trace;
  if (primary.skipped) trace = { ...failureTrace({ url, authorization, rpc, error: primary.note ?? 'not contacted: the origin is not allowed' }), setup };
  else if (!primary.response) trace = { ...failureTrace({ url, authorization, rpc, error: `no answer (${primary.error ?? 'error'})` }), setup };
  else {
    const { status, headers, body } = primary.response;
    trace = realTrace({ url, authorization, rpc, status, headers: shortSession(headers), body, credential: 'workload-token', setup });
    const audit = auditDecisions(headers);
    if (audit) trace.decisions = [...trace.decisions.filter((x) => x.id !== 'grant'), ...audit];
    if (status === 428) trace.decisions = trace.decisions.map((x) => (x.id === 'status' ? { ...x, id: 'approval', label: 'Approval', evidence: 'HTTP 428: the gateway holds the call until a person approves it; Muse does not do the approval step' } : x));
  }
  return scrubDeep(trace, [token, ...secrets]);
}
