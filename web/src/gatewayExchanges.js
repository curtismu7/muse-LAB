// Turns one server-built trace (server/src/museTrace.js) into the exchanges list the shared GatewayTrace shows (Rule 25).
// Returns [] when there is no trace or it is not the kind (mock | real) the page is showing now, so the panel never shows another mode's call.
export function exchangesOf(trace, source) {
  if (!trace || trace.source !== source) return [];
  const m = trace.request?.body;
  const title = m?.method === 'tools/call' ? `Gateway call: ${m.params?.name ?? 'tools/call'}` : m?.method ? `Gateway call: ${m.method}` : 'Gateway call';
  return [{ step: 1, title, status: trace.response?.status ?? null, trace }];
}
