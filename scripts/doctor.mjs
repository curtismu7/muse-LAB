// Doctor for Muse: checks the running app against the health contract and the mock-only promise.
// Usage: node scripts/doctor.mjs [baseUrl]   (default http://127.0.0.1:5100)
const base = process.argv[2] ?? 'http://127.0.0.1:5100';
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

try {
  const h = await fetch(`${base}/api/health`);
  const body = await h.json();
  check('health answers 200', h.status === 200, `status ${h.status}`);
  check('health schema is demo-health/1', body.schema === 'demo-health/1');
  check('health state is ready', body.state === 'ready', String(body.state));
  check('runtime is offline (no tenant)', body.runtime === 'offline', String(body.runtime));

  const s = await fetch(`${base}/api/session`);
  const session = await s.json();
  check('session reports mock mode', session.mode === 'mock');
  check('no persona picker in hosted builds', !(session.hosted && session.picker));
  check('workspace id is a public label', /^[0-9a-f]{12}$/.test(String(session.workspaceId)), String(session.workspaceId));
  check('customer config present', Boolean(session.customer?.brandName && session.customer?.agentName), JSON.stringify(session.customer ?? null));

  // Rule 1: netguard. Zero outbound attempts in mock mode, and its self-test passes.
  const ng = await (await fetch(`${base}/api/netguard`)).json();
  check('netguard self-test passes', ng.selfTest === true);
  check('netguard: zero outbound attempts', ng.mode === 'mock' ? ng.attempts === 0 && ng.blocked === 0 : true, `${ng.mode}, attempts ${ng.attempts}, blocked ${ng.blocked}`);

  // Rule 10: three vertical packs, every token filled.
  const story = await (await fetch(`${base}/api/story`)).json();
  check('three story packs', Array.isArray(story.verticals) && story.verticals.length >= 3, (story.verticals ?? []).map((v) => v.key).join(', '));
  let filled = true;
  for (const v of story.verticals ?? []) {
    const t = await (await fetch(`${base}/api/story?vertical=${encodeURIComponent(v.key)}`)).json();
    if (/\{\{cast/.test(`${t.ask} ${t.answer} ${t.summary}`)) filled = false;
  }
  check('story packs have no undefined cast token', filled);
} catch (e) {
  check('app reachable', false, e.message);
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
