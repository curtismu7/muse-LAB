// gatewayTrace.js — "What Privilege did": builds one trace record per gateway call, for GatewayTrace.jsx.
// Vendor to server/src/gatewayTrace.js (never server/src/trace.js: shared/trace is the W3C traceparent helper).
// Dependency-free ESM, Node >= 22.
//
// The record is the contract of GatewayTrace.jsx (see its header):
//   { source: 'mock'|'real', request: {method,url,headers,body}, response: {status,headers,body}|null,
//     decisions: [{ id, label, outcome: 'pass'|'fail'|'skipped'|'info', basis: 'checked'|'inferred'|'observed', evidence }],
//     record: string|null, at?, requestId?, setup?: [{label,status}] }
//
// HONESTY. A real gateway answers with a status and a body, not a per-check breakdown. So in a real trace
// every decision is 'inferred' (read from the outcome) or 'observed' (read from the response), never 'checked'.
// 'checked' is only for a lab's own simulated gateway, which computed it. assertTrace() enforces this.
// SECRETS. Nothing secret goes in: an agent key or a real token is never shown (see bearerForDisplay and the
// redaction at capture in ../gateway-real/gatewayClient.js).

export const OUTCOMES = ['pass', 'fail', 'skipped', 'info'];
export const BASES = ['checked', 'inferred', 'observed'];

// The Authorization line for display. `resolve` maps a placeholder to the real value a lab keeps server-side:
// if it resolves to something else, the real thing is never shown, only its length.
export function bearerForDisplay(bearer, resolve = (b) => b) {
  const actual = String(resolve(bearer));
  if (actual !== bearer) return `Bearer <token, ${actual.length} characters, kept on the server>`;
  if (String(bearer).split('.').length === 3) return `Bearer ${bearer.slice(0, 20)}… (${bearer.length} characters, shortened)`; // a mock JWT
  return `Bearer ${bearer}`; // a typed value, such as the garbage control
}

export const sentHeaders = (authorization) => ({ authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });

const decision = (id, label, outcome, basis, evidence) => ({ id, label, outcome, basis, evidence });

// ---- A lab's own simulated gateway ----------------------------------------------------------------------
// decisions: what the simulation computed (basis 'checked'). The host of a simulated call is never a real one.
export function mockTrace({ url, authorization, rpc, status, body, headers = { 'content-type': 'application/json' }, decisions, record = null }) {
  return {
    source: 'mock',
    request: { method: 'POST', url, headers: sentHeaders(authorization), body: rpc },
    response: { status, headers, body },
    decisions: decisions.map((d) => ({ basis: 'checked', ...d })),
    record,
  };
}

// ---- The real gateway ------------------------------------------------------------------------------------
// credential: 'agent-key' (an agent access key, the shared hop) or 'workload-token' (a signed JWT the gateway verifies).
const WHAT = {
  'agent-key': { name: 'Agent key', ok: 'the gateway recognised the agent key', no: 'the gateway did not accept the agent key' },
  'workload-token': { name: 'Authentication', ok: 'token accepted', no: 'token refused' },
};

const toolNamesOf = (body) => (Array.isArray(body?.result?.tools) ? body.result.tools.map((t) => t?.name).filter(Boolean) : []);

const firstText = (body) => (Array.isArray(body?.result?.content) ? body.result.content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join(' ') : '');

// callOk: false when the lab's own client could not use the reply (not JSON, too large, empty), even though the status was 200.
export function realDecisions({ credential = 'agent-key', rpc, status, body, detail, forward, callOk }) {
  const w = WHAT[credential] || WHAT['agent-key'];
  const d = [];
  const rpcError = body && typeof body === 'object' ? body.error : undefined;
  const unusable = status === 200 && !rpcError && (callOk === false || body === null || body === undefined || typeof body !== 'object' || body.result === undefined);
  const toolError = status === 200 && !rpcError && !unusable && body.result?.isError === true;
  if (unusable) {
    d.push(decision('authenticated', w.name, 'pass', 'inferred', `${w.ok}. HTTP 200: the gateway answered, which it does only after authenticating the caller.`));
    d.push(decision('result', 'Reply', 'info', 'observed', 'the reply was not a usable JSON-RPC answer (empty, not JSON, or too large), so no grant can be read from it'));
  } else if (toolError) {
    d.push(decision('authenticated', w.name, 'pass', 'inferred', `${w.ok}. HTTP 200: the gateway answered.`));
    d.push(decision('result', 'Tool call', 'fail', 'observed', `the call came back as an error: ${firstText(body).slice(0, 200) || 'no message'}`));
  } else if (status === 200 && !rpcError) {
    d.push(decision('authenticated', w.name, 'pass', 'inferred', `${w.ok}. HTTP 200: the gateway answered, which it does only after authenticating the caller.`));
    const names = toolNamesOf(body);
    d.push(decision('grant', 'Grant', 'pass', 'inferred', rpc?.method === 'tools/list'
      ? (names.length ? `the caller's grant allows ${names.length} tool${names.length === 1 ? '' : 's'} on this app: ${names.join(', ')}` : 'the caller may use this app (it returned no tools)')
      : `the caller's grant allows ${rpc?.params?.name || rpc?.method || 'this call'}`));
    if (forward !== undefined) {
      d.push(decision('forward', 'Pass Agent Token', forward === true ? 'pass' : forward === false ? 'fail' : 'info', 'observed',
        forward === true ? "the backend's reply reports the same claims as the token that was sent"
          : forward === false ? "the backend's reply reports different claims than the token that was sent"
            : 'the backend answered, but its reply had no claims to compare'));
    }
  } else if (status === 200 && rpcError) {
    d.push(decision('authenticated', w.name, 'pass', 'inferred', `${w.ok}. HTTP 200: the gateway answered.`));
    d.push(decision('result', 'Tool call', 'fail', 'observed', `the gateway returned a JSON-RPC error: ${String(rpcError.message || rpcError.code || 'no message').slice(0, 200)}`));
  } else if (status === 401) {
    d.push(decision('authenticated', w.name, 'fail', 'inferred', `${w.no}. HTTP 401: the reply does not say which check failed; the gateway log line does.`));
    d.push(decision('grant', 'Grant', 'skipped', 'inferred', 'not reached: the caller was not accepted'));
  } else if (status === 403) {
    d.push(decision('authenticated', w.name, 'pass', 'inferred', `${w.ok}. HTTP 403 is answered after the caller is known.`));
    d.push(decision('grant', 'Grant', 'fail', 'inferred', detail || 'the caller\'s grant does not allow this app or tool (the reply does not say which)'));
  } else {
    d.push(decision('status', `HTTP ${status}`, 'info', 'observed', detail || 'an answer this panel does not interpret'));
  }
  return d;
}

const RECORD = {
  200: 'Look for the gateway log line for this key and call, with no "policy denied" beside it.',
  401: 'Look for a "rejected" line: its reason names the check that failed.',
  403: 'Look for "policy denied": the caller was accepted, the grant did not allow the call.',
};

// One real exchange, as an object, from a lab that makes its own HTTP call to the gateway.
export function realTrace({ url, authorization, rpc, status, headers, body, detail, forward, credential, at, requestId, setup }) {
  return {
    source: 'real',
    request: { method: 'POST', url, headers: sentHeaders(authorization), body: rpc },
    response: { status, headers, body },
    decisions: realDecisions({ credential, rpc, status, body, detail, forward }),
    record: RECORD[status] || null,
    at, requestId, setup,
  };
}

// The gateway could not be reached at all: there is a request, but no response and no decision to show.
export function failureTrace({ url, authorization, rpc, error }) {
  return {
    source: 'real',
    request: { method: 'POST', url, headers: sentHeaders(authorization), body: rpc },
    response: null,
    decisions: [decision('reach', 'Reach the gateway', 'fail', 'observed', String(error))],
    record: null,
  };
}

// ---- From the shared hop's capture -----------------------------------------------------------------------
// `result` is what createRealDoor({ capture: true }).list() / .call() returned: its `wire` array holds every HTTP exchange.
// The call itself (tools/list or tools/call) is the exchange shown; the session calls around it become one line.
export function traceFromDoor(result, { rpcMethod = 'tools/list', credential = 'agent-key' } = {}) {
  const wire = Array.isArray(result?.wire) ? result.wire : [];
  // A refusal can come at the handshake (a bad key is a 401 on `initialize`), so with no `rpcMethod` exchange the last POST is the call.
  const primary = [...wire].reverse().find((w) => w.rpcMethod === rpcMethod) || [...wire].reverse().find((w) => w.http === 'POST') || null;
  const setup = wire.filter((w) => w !== primary).map((w) => ({ label: w.rpcMethod, status: w.response?.status ?? null }));
  if (!primary) return { source: 'real', request: { method: 'POST', url: '', headers: {}, body: null }, response: null, decisions: [decision('reach', 'Reach the gateway', 'fail', 'observed', 'no exchange was captured')], record: null, setup };
  const request = { method: primary.http, url: primary.url, headers: primary.request.headers, body: primary.request.body };
  if (!primary.response) {
    return { source: 'real', request, response: null, decisions: [decision('reach', 'Reach the gateway', 'fail', 'observed', primary.error || 'no answer')], record: null, at: primary.at, setup };
  }
  const { status, headers, body } = primary.response;
  const detail = result?.refusal?.message;
  return {
    source: 'real', request, response: { status, headers, body },
    decisions: realDecisions({ credential, rpc: primary.request.body, status, body, detail, callOk: result?.ok }),
    record: RECORD[status] || null,
    at: primary.at,
    requestId: headers?.['x-request-id'] || headers?.['request-id'] || headers?.['x-correlation-id'],
    setup,
  };
}

// ---- The contract ----------------------------------------------------------------------------------------
// Returns a list of problems (empty = fine). Labs run it in their tests; it is the honesty rule, written as code.
export function assertTrace(t) {
  const bad = [];
  if (!t || typeof t !== 'object') return ['not an object'];
  if (t.source !== 'mock' && t.source !== 'real') bad.push(`source must be mock or real, got ${t.source}`);
  if (!t.request || !t.request.method || t.request.url === undefined) bad.push('request needs method and url');
  if (t.response !== null && !(t.response && Number.isInteger(t.response.status))) bad.push('response must be null or have an integer status');
  if (!Array.isArray(t.decisions)) bad.push('decisions must be an array');
  for (const d of t.decisions || []) {
    if (!d || typeof d !== 'object') { bad.push('a decision is not an object'); continue; }
    if (!d.id || !d.label) bad.push('a decision needs an id and a label');
    if (!OUTCOMES.includes(d.outcome)) bad.push(`decision ${d.id}: outcome ${d.outcome}`);
    if (!BASES.includes(d.basis)) bad.push(`decision ${d.id}: basis ${d.basis}`);
    if (t.source === 'real' && d.basis === 'checked') bad.push(`decision ${d.id}: a real trace cannot say "checked"; the real gateway reports no per-check detail`);
  }
  const text = JSON.stringify(t);
  if (/Bearer eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/.test(text) && t.source === 'real') bad.push('a real trace holds a full bearer token');
  return bad;
}
