// Connector refresh tokens (opt-in, MUSE_CONNECTOR_REFRESH=1). In memory only: a restart drops every family, and the agent signs in again.
// One FAMILY per sign-in: the connector's refresh tokens (each one used once, then rotated), the PingOne refresh token behind them (server side only,
// never sent to any client) and what the family is bound to (the client it was issued to, the signed-in user). The store holds state and answers
// "what is this token?"; the connector decides what to do about it.
import { randomBytes } from 'node:crypto';

export const REFRESH_DEFAULT_HOURS = 24;
export const REFRESH_HARD_CAP_HOURS = 168;
// A rotated token presented again within this time gets the same successful answer again (a network retry); later it is reuse.
export const REFRESH_GRACE_MS = 10 * 1000;
export const REFRESH_FAMILY_CAP = 200;
// Rotated tokens remembered per family, so a stolen old token is still recognised as reuse. Older ones are forgotten (they are then just unknown, and refused).
const ROTATED_KEEP = 32;

export const newRefreshToken = () => randomBytes(32).toString('base64url');

// The absolute lifetime in hours: a positive number, at most the hard cap (a bigger number is cut to it). Anything that is not a plain positive number falls back to the default.
export function refreshMaxHours(v) {
  if (v === undefined || v === null) return REFRESH_DEFAULT_HOURS;
  const s = String(v).trim();
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(s)) return REFRESH_DEFAULT_HOURS;
  const n = Number(s);
  return n > 0 ? Math.min(n, REFRESH_HARD_CAP_HOURS) : REFRESH_DEFAULT_HOURS;
}

export function createRefreshStore({ now = () => Date.now(), maxHours = REFRESH_DEFAULT_HOURS, cap = REFRESH_FAMILY_CAP, onDrop = () => {} } = {}) {
  const maxMs = refreshMaxHours(maxHours) * 3600 * 1000;
  const families = new Map();   // family id -> family
  const byToken = new Map();    // refresh token -> { family, rotatedAt: null while current, response: the answer given when it was rotated }
  let seq = 0;

  const drop = (f) => {
    if (f.dead) return;
    f.dead = true;
    families.delete(f.id);
    for (const t of f.tokens) byToken.delete(t);
    onDrop(f);
  };
  const purge = () => { const t = now(); for (const f of [...families.values()]) if (t >= f.expiresAt) drop(f); };

  return {
    maxMs,
    get size() { return families.size; },
    // A new family with its first refresh token. `init` is what the family is bound to and what a refresh needs (client, userId, actor, idp, learned, p1Refresh).
    issue(init) {
      purge();
      while (families.size >= cap) drop(families.values().next().value);
      const startedAt = now();
      const token = newRefreshToken();
      const family = { ...init, id: `f${++seq}`, startedAt, expiresAt: startedAt + maxMs, current: token, tokens: new Set([token]), tail: Promise.resolve(), dead: false };
      families.set(family.id, family);
      byToken.set(token, { family, rotatedAt: null, response: null });
      return { family, token };
    },
    // What a presented token is: unknown (never issued, evicted, expired, revoked), current, grace (rotated within the grace time; carries the answer to repeat), or reuse (rotated earlier).
    classify(token) {
      purge();
      const e = byToken.get(String(token));
      if (!e || e.family.dead) return { kind: 'unknown' };
      if (e.rotatedAt === null) return { kind: 'current', family: e.family };
      if (now() - e.rotatedAt <= REFRESH_GRACE_MS && e.response) return { kind: 'grace', family: e.family, response: e.response };
      return { kind: 'reuse', family: e.family };
    },
    alive: (family) => !family.dead && now() < family.expiresAt,
    // The presented token is now spent; `next` is the family's one live token. `response` is repeated to a retry within the grace time.
    rotate(family, token, next, response) {
      const t = now();
      const e = byToken.get(token);
      e.rotatedAt = t; e.response = response;
      for (const x of family.tokens) { const o = byToken.get(x); if (o && o.rotatedAt !== null && t - o.rotatedAt > REFRESH_GRACE_MS) o.response = null; }
      family.tokens.add(next); family.current = next;
      byToken.set(next, { family, rotatedAt: null, response: null });
      while (family.tokens.size > ROTATED_KEEP + 1) { const oldest = family.tokens.values().next().value; family.tokens.delete(oldest); byToken.delete(oldest); }
    },
    revoke: drop,
    // One refresh at a time per family: the second caller waits, then looks at the token again (it is by then rotated, so it gets the repeat answer).
    async withLock(family, fn) {
      const before = family.tail;
      let release;
      family.tail = new Promise((r) => { release = r; });
      await before;
      try { return await fn(); } finally { release(); }
    },
    purge,
  };
}
