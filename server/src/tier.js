// The Real test controls (owner-approved 2026-11-09, opt-in flag required): writes two PingOne user attributes on the owner's demo users, so the
// owner can flip Premier Gold / Premier Silver and the user's agent spend limit (dollars) from the Book a flight panel instead of a terminal.
// This is the ONE place Muse holds a PingOne credential that can edit users. It is deliberately narrow:
//   - off unless MUSE_TIER_ENABLE=1 (a hosted build, which the Docker image always is, also needs that opt-in; the SE deployment never sets it).
//     MUSE_TIER_ENABLE=read is the READ-ONLY mode for a PUBLIC hosted URL: readUserFacts and read() work (same allow-list, token, scrubbing,
//     timeouts and limiter) but every write is refused here, before any PingOne call, so nobody on the internet can change a user. Exactly "1" and
//     exactly "read" turn anything on; unset, "0", "true", "READ" and every other value are off;
//   - a dedicated worker app (MUSE_TIER_WORKER_CLIENT_ID / _SECRET), supplied in Muse's own .env, never provisioning.json, never committed;
//   - the only attributes ever written are airlineMemberTier ("Premier Gold", "Premier Silver" or clear) and agentSpendLimit (whole dollars
//     1 to 100000 as text, or clear); both in ONE PATCH when both change, so a user is never half-updated;
//   - the only users ever touched are the ids in MUSE_TIER_USER_IDS (an id can never come from a request);
//   - the only hosts ever contacted are auth.pingone.<region> (token) and api.pingone.<region> (users); no redirects, a timeout, a size cap;
//   - the secret and the worker token live in this closure only: never returned, logged, put in an error or shown. Errors are scrubbed;
//   - every write is verified by reading the user back, and the result says what PingOne now holds, never what we hoped it holds.
// Tested against stubs only. Agents never call a real tenant; the owner runs Real.
import { Buffer } from 'node:buffer';
import { readCapped } from './discovery.js';
import { AGENT_LIMIT_DEFAULT, MEMBERS, TIER_ATTRIBUTE } from './fares.js';

export const TIER_TIMEOUT_MS = 8000;
// The second attribute: the user's own cap, in dollars, on tickets bought by an AI agent (PingOne user-schema attribute, STRING, e.g. "500").
// PingOne Authorize reads it live; an empty field means Authorize's default (AGENT_LIMIT_DEFAULT).
export const LIMIT_ATTRIBUTE = 'agentSpendLimit';
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100000;
export const TIER_ENV = {
  enable: 'MUSE_TIER_ENABLE',
  clientId: 'MUSE_TIER_WORKER_CLIENT_ID',
  clientSecret: 'MUSE_TIER_WORKER_CLIENT_SECRET',
  userIds: 'MUSE_TIER_USER_IDS',
  envId: 'MUSE_TIER_ENV_ID',
  region: 'MUSE_TIER_REGION',
};
// The only values that may be written. null clears the attribute.
export const TIER_WRITABLE = Object.freeze([MEMBERS.premium.tier, MEMBERS.standard.tier, null]);
// A limit comes in as a whole number of dollars (a JSON integer, or text of ASCII digits only, 1 to 6 characters, no leading zero) or the word
// 'default' (clears the attribute so Authorize uses its default). Anything else is refused. Returns the canonical text to write, or null to clear.
export function parseLimit(v) {
  if (v === 'default') return { ok: true, value: null };
  let n;
  if (typeof v === 'number') n = Number.isSafeInteger(v) ? v : NaN;
  else if (typeof v === 'string' && /^[1-9][0-9]{0,5}$/.test(v)) n = Number(v);
  else return { ok: false };
  if (!(n >= LIMIT_MIN && n <= LIMIT_MAX)) return { ok: false };
  return { ok: true, value: String(n) };
}
export const LIMIT_RULE = `a whole number of dollars from ${LIMIT_MIN} to ${LIMIT_MAX}, or "default"`;
// The three states of MUSE_TIER_ENABLE: 'write' (exactly "1"), 'read' (exactly "read": reads only), 'off' (anything else).
export const TIER_MODES = Object.freeze({ write: 'write', read: 'read', off: 'off' });
export const READ_ONLY_MESSAGE = 'Read-only here: change the tier and limit on the local Muse page.';
const modeOf = (v) => (v === '1' ? TIER_MODES.write : v === 'read' ? TIER_MODES.read : TIER_MODES.off);
const REGIONS = new Set(['com', 'eu', 'ca', 'asia', 'com.au', 'sg']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_USERS = 5;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_READS_PER_WINDOW = 30;

// Which of the settings are missing or invalid. Names only: never a value.
function readConfig(env, live) {
  const needs = [];
  // Opt-in. The Docker image always runs with MUSE_HOSTED=1 (it must bind a non-loopback address), so the opt-in is what lets the owner's
  // container use the switch; the SE deployment never sets it.
  const mode = modeOf(env.MUSE_TIER_ENABLE);
  const enabled = mode !== TIER_MODES.off;
  if (!enabled) needs.push(TIER_ENV.enable);
  const blocked = !enabled && env.MUSE_HOSTED === '1'
    ? `The test controls are off on this build (MUSE_HOSTED=1, which the Docker container always sets). Set ${TIER_ENV.enable}=1 in Muse's own .env to opt in, then restart Muse. The SE deployment never sets it. On a public URL use ${TIER_ENV.enable}=read, which only reads.`
    : null;
  if (!live) needs.push('Real mode (ALLOW_LIVE=1 and MUSE_LIVE_GATEWAY_URL)');
  const clientId = String(env.MUSE_TIER_WORKER_CLIENT_ID ?? '').trim();
  if (!UUID.test(clientId)) needs.push(TIER_ENV.clientId);
  const clientSecret = String(env.MUSE_TIER_WORKER_CLIENT_SECRET ?? '');
  if (clientSecret === '') needs.push(TIER_ENV.clientSecret);
  const ids = [...new Set(String(env.MUSE_TIER_USER_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_USERS || !ids.every((x) => UUID.test(x))) needs.push(TIER_ENV.userIds);
  // The environment and region default to the ones Muse already signs in with (MUSE_P1_*), so one tenant needs one set of ids.
  const envId = String(env.MUSE_TIER_ENV_ID || env.MUSE_P1_ENV_ID || '').trim();
  if (!UUID.test(envId)) needs.push(`${TIER_ENV.envId} (or MUSE_P1_ENV_ID)`);
  const region = String(env.MUSE_TIER_REGION || env.MUSE_P1_REGION || 'com').trim();
  if (!REGIONS.has(region)) needs.push(`${TIER_ENV.region} (or MUSE_P1_REGION): com, eu, ca, asia, com.au or sg`);
  return { needs, blocked, mode, clientId, clientSecret, ids, envId, region };
}

export function createTierSwitch({ env = process.env, live = null, fetchImpl = fetch, now = Date.now } = {}) {
  const cfg = readConfig(env, live);
  const configured = cfg.needs.length === 0;
  const readOnly = configured && cfg.mode === TIER_MODES.read;
  const auth = configured ? `https://auth.pingone.${cfg.region}` : null;
  const api = configured ? `https://api.pingone.${cfg.region}` : null;
  const origins = new Set(configured ? [auth, api] : []);
  const labels = (cfg.ids ?? []).map((_, i) => `Demo user ${i + 1}`);
  let token = null;       // { value, exp }: in memory only, for its lifetime
  let tokenSeen = '';     // the last token value, kept only so scrub() can still remove it from text
  let last = null;        // the last verified read-back, shown by the page
  let busy = false;

  // Remove anything that must never reach a page or a log: the secret, the token, ids and URLs.
  const scrub = (text) => {
    let s = String(text ?? '');
    for (const secret of [cfg.clientSecret, tokenSeen]) if (secret) s = s.split(secret).join('[redacted]');
    s = s.replace(/https?:\/\/\S+/gi, '<url>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  };

  // The one gate every request goes through: a known PingOne origin only, no redirects, a timeout, a size cap. Never throws a message that carries a URL.
  async function call(url, init) {
    const u = new URL(url);
    if (!origins.has(u.origin)) throw Object.assign(new Error('refused'), { kind: 'origin' });
    let res;
    try {
      res = await fetchImpl(u.href, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIER_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw Object.assign(new Error(timedOut ? 'PingOne did not answer in time.' : 'Could not reach PingOne.'), { kind: timedOut ? 'timeout' : 'network' });
    }
    const body = await readCapped(res).catch(() => null);
    return { status: res.status, body };
  }

  const detail = (body) => {
    if (!body || typeof body !== 'object') return '';
    const d = [body.code, body.message].filter((x) => typeof x === 'string' && x !== '').join(': ');
    return d ? ` PingOne said: ${scrub(d)}` : '';
  };
  const explain = (status, body, stage) => {
    if (status === 401) return stage === 'token' ? 'PingOne refused the worker credential (401). Check the worker app, and that it uses client secret basic.' : 'PingOne refused the worker token (401). Try again.';
    if (status === 403) return 'The worker app is not allowed to edit users in this environment (403). Give it a role that can update users.';
    if (status === 404) return 'PingOne does not know that user (404).';
    if (status === 429) return 'PingOne is rate limiting this app (429). Wait a minute and try again.';
    if (status >= 500) return `PingOne answered ${status}.${detail(body)}`;
    return `PingOne rejected the request (${status}).${detail(body)}`;
  };
  const fail = (message) => Object.assign(new Error(message), { kind: 'tier' });

  async function workerToken() {
    if (token && token.exp - 30_000 > now()) return token.value;
    token = null;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    let r;
    try {
      r = await call(`${auth}/${cfg.envId}/as/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'grant_type=client_credentials' });
    } catch (e) { throw fail(e.message); }
    if (r.status !== 200) throw fail(explain(r.status, r.body, 'token'));
    const t = r.body;
    if (!t || typeof t !== 'object' || typeof t.access_token !== 'string' || t.access_token === '') throw fail('PingOne answered the token request, but the answer was not understood.');
    const life = Number.isFinite(Number(t.expires_in)) && Number(t.expires_in) > 0 ? Number(t.expires_in) : 300;
    token = { value: t.access_token, exp: now() + life * 1000 };
    tokenSeen = t.access_token;
    return token.value;
  }

  const userUrl = (id) => `${api}/v1/environments/${cfg.envId}/users/${id}`;
  const headers = (t, extra = {}) => ({ authorization: `Bearer ${t}`, accept: 'application/json', ...extra });

  // What PingOne holds for one user right now: the tier (text or none) and the limit (whole dollars or none). A value that is not what we
  // would ever write is reported as unreadable, never guessed at.
  async function readUser(t, id) {
    try {
      const r = await call(userUrl(id), { method: 'GET', headers: headers(t) });
      if (r.status === 401) token = null;
      if (r.status !== 200) return { known: false, value: null, limit: null, error: explain(r.status, r.body, 'api') };
      if (!r.body || typeof r.body !== 'object') return { known: false, value: null, limit: null, error: 'PingOne answered, but the user record was not understood.' };
      const v = r.body[TIER_ATTRIBUTE];
      const l = r.body[LIMIT_ATTRIBUTE];
      const none = (x) => x === undefined || x === null || x === '';
      if (!none(v) && typeof v !== 'string') return { known: false, value: null, limit: null, error: `${TIER_ATTRIBUTE} holds something that is not text.` };
      let limit = null;
      if (!none(l)) {
        const n = typeof l === 'number' ? l : typeof l === 'string' && /^[0-9]{1,9}$/.test(l) ? Number(l) : NaN;
        if (!Number.isSafeInteger(n)) return { known: false, value: none(v) ? null : v, limit: null, error: `${LIMIT_ATTRIBUTE} holds something that is not a whole dollar amount.` };
        limit = n;
      }
      return { known: true, value: none(v) ? null : v, limit };
    } catch (e) { return { known: false, value: null, limit: null, error: scrub(e.message) }; }
  }

  // A small sliding-window limiter per kind of work.
  const makeLimiter = (max) => {
    let stamps = [];
    return () => {
      const t = now();
      stamps = stamps.filter((s) => t - s < WINDOW_MS);
      if (stamps.length >= max) return true;
      stamps.push(t);
      return false;
    };
  };
  const limited = makeLimiter(MAX_PER_WINDOW);
  const readLimited = makeLimiter(MAX_READS_PER_WINDOW);

  // What every demo user holds, when the last read-back could read them all and they agree; otherwise null (the page shows each user).
  const heldNow = () => {
    const u = last?.users ?? [];
    if (u.length === 0 || !u.every((x) => x.known) || !u.every((x) => x.value === u[0].value && x.limit === u[0].limit)) return null;
    return { tier: u[0].value, limit: u[0].limit };
  };

  const view = () => ({
    configured,
    needs: configured ? [] : cfg.needs,
    explanation: configured ? null : cfg.blocked ?? `Not configured. Set ${cfg.needs.join(', ')} in Muse's own .env (see .env.example), then restart Muse.`,
    tierMode: configured ? cfg.mode : TIER_MODES.off,
    readOnly,
    ...(readOnly ? { readOnlyMessage: READ_ONLY_MESSAGE } : {}),
    attribute: TIER_ATTRIBUTE,
    limitAttribute: LIMIT_ATTRIBUTE,
    users: labels.length,
    held: heldNow(),
    last,
  });

  // Run one operation at a time: a second press while one is running is refused rather than interleaved.
  async function exclusive(fn) {
    if (busy) return { ok: false, busy: true, error: 'A change is already running. Wait for it to finish.' };
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  const dollars = (n) => `$${n}`;
  const shownTier = (v) => (v === null ? 'no tier set' : v);
  const shownLimit = (n) => (n === null ? 'no agent limit set' : `an agent limit of ${dollars(n)}`);

  // want: { tier?: string|null, limit?: string|null } (limit as the canonical text to write). Only the keys present are written, in ONE PATCH per user.
  async function run(want, write) {
    // The last line of defence: whatever called us, a write never leaves this function unless MUSE_TIER_ENABLE is exactly "1".
    if (write && cfg.mode !== TIER_MODES.write) return { ok: false, readOnly: true, error: READ_ONLY_MESSAGE, users: [] };
    const wantTier = write && Object.hasOwn(want, 'tier');
    const wantLimit = write && Object.hasOwn(want, 'limit');
    const body = { ...(wantTier ? { [TIER_ATTRIBUTE]: want.tier } : {}), ...(wantLimit ? { [LIMIT_ATTRIBUTE]: want.limit } : {}) };
    const intended = write ? { ...(wantTier ? { tier: want.tier } : {}), ...(wantLimit ? { limit: want.limit === null ? null : Number(want.limit) } : {}) } : undefined;
    let t;
    try { t = await workerToken(); } catch (e) { return { ok: false, intended, attribute: TIER_ATTRIBUTE, limitAttribute: LIMIT_ATTRIBUTE, error: scrub(e.message), users: [] }; }
    const users = [];
    for (const [i, id] of cfg.ids.entries()) {
      const row = { label: labels[i], written: null };
      if (write) {
        try {
          const r = await call(userUrl(id), { method: 'PATCH', headers: headers(t, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
          if (r.status === 401) token = null;
          row.written = r.status >= 200 && r.status < 300;
          if (!row.written) row.writeError = explain(r.status, r.body, 'api');
        } catch (e) { row.written = false; row.writeError = scrub(e.message); }
      }
      // Always read back, even after a failed write: the page shows what PingOne holds, not what was asked for.
      const held = await readUser(t, id);
      Object.assign(row, { known: held.known, value: held.value, limit: held.limit, ...(held.error ? { readError: held.error } : {}) });
      // Verified only if EVERY attribute that was sent now reads back as sent.
      row.verified = write ? row.written === true && held.known && (!wantTier || held.value === want.tier) && (!wantLimit || held.limit === intended.limit) : undefined;
      users.push(row);
    }
    const at = new Date(now()).toISOString();
    const ok = write ? users.every((u) => u.verified) : users.every((u) => u.known);
    const who = users.length === 1 ? 'the demo user' : `all ${users.length} demo users`;
    const heldText = (u) => [
      ...(!write || wantTier ? [shownTier(u.value)] : []),
      ...(!write || wantLimit ? [shownLimit(u.limit)] : []),
    ].join(' and ');
    let summary;
    if (write && ok) {
      const said = [
        ...(wantTier ? [want.tier === null ? 'has no tier set' : `holds ${want.tier}`] : []),
        ...(wantLimit ? [want.limit === null ? 'has no agent limit set' : `holds an agent limit of ${dollars(want.limit)}`] : []),
      ].join(' and ');
      summary = `PingOne now ${said} on ${who} (read back).${wantLimit && want.limit === null ? ` Authorize then uses its default agent limit of ${dollars(AGENT_LIMIT_DEFAULT)}.` : ''} Run the booking again to see the decision change.`;
    } else {
      summary = users.map((u) => `${u.label}: ${u.known ? `PingOne holds ${heldText(u)}` : 'could not read the value'}${u.writeError ? `; the change failed (${u.writeError})` : write && u.written && u.known && !u.verified ? `; the change was accepted but PingOne still holds ${heldText(u)}` : ''}${u.readError ? ` (${u.readError})` : ''}`).join('. ');
    }
    const out = { ok, intended, attribute: TIER_ATTRIBUTE, limitAttribute: LIMIT_ATTRIBUTE, at, users, summary };
    last = { ok, at, users: users.map(({ label, known, value, limit, verified }) => ({ label, known, value, limit, ...(verified === undefined ? {} : { verified }) })) };
    return out;
  }

  // Apply a tier, a limit or both to every allow-listed user in one PATCH each, then read them all back. A key that is absent is left alone.
  // limit is the canonical text from parseLimit (or null to clear); anything else is refused here too, whatever the caller did.
  async function apply(change = {}) {
    if (!configured) return { ok: false, error: 'The test controls are not configured.', users: [] };
    if (readOnly) return { ok: false, readOnly: true, error: READ_ONLY_MESSAGE, users: [] };
    const { tier, limit } = change ?? {};
    const want = {};
    if (change && Object.hasOwn(change, 'tier')) {
      if (!TIER_WRITABLE.includes(tier)) return { ok: false, error: 'That tier value is not allowed.', users: [] };
      want.tier = tier;
    }
    if (change && Object.hasOwn(change, 'limit')) {
      const p = typeof limit === 'string' ? parseLimit(limit) : { ok: limit === null, value: null };
      if (!p.ok || (typeof limit === 'string' && p.value !== limit)) return { ok: false, error: 'That limit value is not allowed.', users: [] };
      want.limit = limit;
    }
    if (Object.keys(want).length === 0) return { ok: false, error: 'Nothing to change.', users: [] };
    return exclusive(() => run(want, true));
  }
  // The tier alone (kept for callers that only know about the tier).
  const switchTo = (value) => apply({ tier: value });
  // Read only: what PingOne holds now.
  async function read() {
    if (!configured) return { ok: false, error: 'The test controls are not configured.', users: [] };
    return exclusive(() => run({}, false));
  }

  // For a later connector change (not wired in yet): the tier and the limit PingOne holds for ONE user, only for an id on the allow-list.
  // Same worker token, timeouts, scrubbing and origin gate as above, with its own small read limiter. Anything it cannot know (not on the
  // list, not configured, rate limited, PingOne error, unreadable value) is {tier: null, limit: null}: no tier is not premium, no limit means
  // Authorize's default. The caller's id is only compared with the list; the URL is built from the configured id.
  async function readUserFacts(userId) {
    const none = { tier: null, limit: null };
    if (!configured || typeof userId !== 'string') return none;
    const id = cfg.ids.find((x) => x.toLowerCase() === userId.trim().toLowerCase());
    if (!id || readLimited()) return none;
    try {
      const held = await readUser(await workerToken(), id);
      return held.known ? { tier: held.value, limit: held.limit } : none;
    } catch { return none; }
  }

  return { configured, readOnly, view, apply, switchTo, read, limited, readUserFacts };
}
