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
} catch (e) {
  check('app reachable', false, e.message);
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
