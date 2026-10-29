// Netguard (rules 1 and safety): in mock mode the app makes zero real outbound calls. Every outbound fetch goes through wrap(), which refuses anything
// that is not loopback and counts each refusal. In live mode (the owner's real build, with its tenant settings) nothing is refused, but every outbound
// origin is counted, so the owner can see where the app really talks. selfTest() proves the guard itself works and is run by the tests and by doctor.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_ORIGINS = 20;

const originOf = (input) => {
  try { return new URL(typeof input === 'string' ? input : input?.url ?? String(input)); } catch { return null; }
};

export function createNetguard({ mode = 'mock' } = {}) {
  if (mode !== 'mock' && mode !== 'live') throw new Error('netguard mode must be "mock" or "live"');
  const seen = new Map();   // origin -> count, live mode only
  let attempts = 0, blocked = 0, last = null;

  const wrap = (fetchImpl) => async (input, init) => {
    const u = originOf(input);
    const loopback = Boolean(u) && LOOPBACK.has(u.hostname);
    if (!loopback) {
      attempts += 1;
      const origin = u ? u.origin : 'an unparseable address';
      if (mode === 'mock') { blocked += 1; last = origin; throw new Error(`netguard: outbound call to ${origin} refused (mock mode makes no outbound calls)`); }
      if (u && (seen.has(u.origin) || seen.size < MAX_ORIGINS)) seen.set(u.origin, (seen.get(u.origin) ?? 0) + 1);
    }
    return fetchImpl(input, init);
  };

  const stats = () => ({ mode, attempts, blocked, last, origins: [...seen.keys()] });

  // Does a real fetch to a non-loopback address get refused in mock mode, and does loopback pass? Uses its own throwaway guard, so the counters above stay clean.
  async function selfTest() {
    const probe = createNetguard({ mode: 'mock' });
    let reached = 0;
    const f = probe.wrap(async () => { reached += 1; return { ok: true }; });
    let refused = false;
    try { await f('https://netguard-selftest.invalid/'); } catch { refused = true; }
    await f('http://127.0.0.1:1/');
    const s = probe.stats();
    return { ok: refused && reached === 1 && s.blocked === 1 && s.attempts === 1, refused, loopbackPassed: reached === 1 };
  }

  return { wrap, stats, selfTest, mode };
}
