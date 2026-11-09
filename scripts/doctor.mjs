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
  // Book a flight (Mock): the two rules, the contract's boundaries, and a ledger that stays empty on a deny. Uses its own visitor.
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const book = async (flightId, via, member) => {
    await call('POST', '/api/member', { member });
    const a = await call('POST', '/api/authorize', { client: via });
    if (a.json?.status === 'consent_required') await call('POST', '/api/consent', { client: via, approve: true });
    return (await call('POST', '/api/request', { tool: 'flights.book', args: { flightId }, via })).json;
  };
  if (session.mode === 'mock') {
    await call('GET', '/api/session'); await call('POST', '/api/signin');
    const ids = (r) => (r?.authorize?.rulesDenied ?? []).map((x) => x.id).join('+');
    check('book: agent $620 is denied by your rule only', ids(await book('SH106', 'muse', 'standard')) === 'agent_spend_limit');
    check('book: agent exactly $500 passes both rules', (await book('SH104', 'muse', 'standard'))?.outcome === 'allowed');
    check('book: Sam directly, $750 standard, passes', (await book('SH108', 'browser', 'standard'))?.outcome === 'allowed');
    check('book: Sam directly, $940 standard, is denied by the airline rule only', ids(await book('SH107', 'browser', 'standard')) === 'premium_only');
    check('book: Sam directly, $940, user with no airlineMemberTier, is denied by the airline rule only', ids(await book('SH107', 'browser', 'none')) === 'premium_only');
    check('book: agent $940 standard is denied by both rules', ids(await book('SH107', 'muse', 'standard')) === 'agent_spend_limit+premium_only');
    await call('POST', '/api/reset'); await call('POST', '/api/signin');
    await book('SH106', 'muse', 'standard');
    const after = (await call('GET', '/api/session')).json;
    check('book: a denied booking leaves the ledger empty', Array.isArray(after.bookings) && after.bookings.length === 0);
    const ng2 = await (await fetch(`${base}/api/netguard`)).json();
    check('book: still zero outbound attempts', ng2.attempts === 0, `attempts ${ng2.attempts}`);
  }
} catch (e) {
  check('app reachable', false, e.message);
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
