// The Real member-tier switch (owner-approved 2026-11-09): writes the PingOne user attribute airlineMemberTier on the owner's demo users, so the
// owner can flip Premier Gold / Premier Silver from the Book a flight panel instead of a terminal. This is the ONE place Muse holds a PingOne
// credential that can edit users. It is deliberately narrow:
//   - a dedicated worker app (MUSE_TIER_WORKER_CLIENT_ID / _SECRET), supplied in Muse's own .env, never provisioning.json, never committed;
//   - the only attribute ever written is airlineMemberTier; the only values are "Premier Gold", "Premier Silver" or clear (null);
//   - the only users ever touched are the ids in MUSE_TIER_USER_IDS (an id can never come from a request);
//   - the only hosts ever contacted are auth.pingone.<region> (token) and api.pingone.<region> (users); no redirects, a timeout, a size cap;
//   - the secret and the worker token live in this closure only: never returned, logged, put in an error or shown. Errors are scrubbed;
//   - every write is verified by reading the user back, and the result says what PingOne now holds, never what we hoped it holds.
// Tested against stubs only. Agents never call a real tenant; the owner runs Real.
import { Buffer } from 'node:buffer';
import { readCapped } from './discovery.js';
import { MEMBERS, TIER_ATTRIBUTE } from './fares.js';

export const TIER_TIMEOUT_MS = 8000;
export const TIER_ENV = {
  clientId: 'MUSE_TIER_WORKER_CLIENT_ID',
  clientSecret: 'MUSE_TIER_WORKER_CLIENT_SECRET',
  userIds: 'MUSE_TIER_USER_IDS',
  envId: 'MUSE_TIER_ENV_ID',
  region: 'MUSE_TIER_REGION',
};
// The only values that may be written. null clears the attribute.
export const TIER_WRITABLE = Object.freeze([MEMBERS.premium.tier, MEMBERS.standard.tier, null]);
const REGIONS = new Set(['com', 'eu', 'ca', 'asia', 'com.au', 'sg']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_USERS = 5;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

// Which of the settings are missing or invalid. Names only: never a value.
function readConfig(env, live) {
  const needs = [];
  if (env.MUSE_HOSTED === '1') return { needs: [], blocked: 'The member-tier switch is never available on a hosted build.' };
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
  return { needs, clientId, clientSecret, ids, envId, region };
}

export function createTierSwitch({ env = process.env, live = null, fetchImpl = fetch, now = Date.now } = {}) {
  const cfg = readConfig(env, live);
  const configured = !cfg.blocked && cfg.needs.length === 0;
  const auth = configured ? `https://auth.pingone.${cfg.region}` : null;
  const api = configured ? `https://api.pingone.${cfg.region}` : null;
  const origins = new Set(configured ? [auth, api] : []);
  const labels = (cfg.ids ?? []).map((_, i) => `Demo user ${i + 1}`);
  let token = null;       // { value, exp }: in memory only, for its lifetime
  let tokenSeen = '';     // the last token value, kept only so scrub() can still remove it from text
  let last = null;        // the last verified read-back, shown by the page
  let busy = false;
  let stamps = [];

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

  // What PingOne holds for one user right now.
  async function readUser(t, id) {
    try {
      const r = await call(userUrl(id), { method: 'GET', headers: headers(t) });
      if (r.status === 401) token = null;
      if (r.status !== 200) return { known: false, value: null, error: explain(r.status, r.body, 'api') };
      if (!r.body || typeof r.body !== 'object') return { known: false, value: null, error: 'PingOne answered, but the user record was not understood.' };
      const v = r.body[TIER_ATTRIBUTE];
      if (v === undefined || v === null || v === '') return { known: true, value: null };
      if (typeof v !== 'string') return { known: false, value: null, error: `${TIER_ATTRIBUTE} holds something that is not text.` };
      return { known: true, value: v };
    } catch (e) { return { known: false, value: null, error: scrub(e.message) }; }
  }

  const limited = () => {
    const t = now();
    stamps = stamps.filter((s) => t - s < WINDOW_MS);
    if (stamps.length >= MAX_PER_WINDOW) return true;
    stamps.push(t);
    return false;
  };

  const view = () => ({
    configured,
    needs: configured || cfg.blocked ? [] : cfg.needs,
    explanation: configured ? null : cfg.blocked ?? `Not configured. Set ${cfg.needs.join(', ')} in Muse's own .env (see .env.example), then restart Muse.`,
    attribute: TIER_ATTRIBUTE,
    users: labels.length,
    last,
  });

  // Run one operation at a time: a second press while one is running is refused rather than interleaved.
  async function exclusive(fn) {
    if (busy) return { ok: false, busy: true, error: 'A tier change is already running. Wait for it to finish.' };
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  async function run(intended, write) {
    let t;
    try { t = await workerToken(); } catch (e) { return { ok: false, intended, attribute: TIER_ATTRIBUTE, error: scrub(e.message), users: [] }; }
    const users = [];
    for (const [i, id] of cfg.ids.entries()) {
      const row = { label: labels[i], written: null };
      if (write) {
        try {
          const r = await call(userUrl(id), { method: 'PATCH', headers: headers(t, { 'content-type': 'application/json' }), body: JSON.stringify({ [TIER_ATTRIBUTE]: intended }) });
          if (r.status === 401) token = null;
          row.written = r.status >= 200 && r.status < 300;
          if (!row.written) row.writeError = explain(r.status, r.body, 'api');
        } catch (e) { row.written = false; row.writeError = scrub(e.message); }
      }
      // Always read back, even after a failed write: the page shows what PingOne holds, not what was asked for.
      const held = await readUser(t, id);
      Object.assign(row, { known: held.known, value: held.value, ...(held.error ? { readError: held.error } : {}) });
      row.verified = write ? row.written === true && held.known && held.value === intended : undefined;
      users.push(row);
    }
    const at = new Date(now()).toISOString();
    const ok = write ? users.every((u) => u.verified) : users.every((u) => u.known);
    const shown = (v) => (v === null ? 'no tier set' : v);
    let summary;
    if (write && ok) summary = `PingOne now ${intended === null ? 'has no tier set' : `holds ${intended}`} on ${users.length === 1 ? 'the demo user' : `all ${users.length} demo users`} (read back). Run the booking again to see the decision change.`;
    else summary = users.map((u) => `${u.label}: ${u.known ? `PingOne holds ${shown(u.value)}` : 'could not read the value'}${u.writeError ? `; the change failed (${u.writeError})` : write && u.written && u.known && !u.verified ? `; the change was accepted but PingOne still holds ${shown(u.value)}` : ''}${u.readError ? ` (${u.readError})` : ''}`).join('. ');
    const out = { ok, intended: write ? intended : undefined, attribute: TIER_ATTRIBUTE, at, users, summary };
    last = { ok, at, users: users.map(({ label, known, value, verified }) => ({ label, known, value, ...(verified === undefined ? {} : { verified }) })) };
    return out;
  }

  // Set the tier on every allow-listed user, then read them all back.
  async function switchTo(value) {
    if (!configured) return { ok: false, error: 'The member-tier switch is not configured.', users: [] };
    if (!TIER_WRITABLE.includes(value)) return { ok: false, error: 'That tier value is not allowed.', users: [] };
    return exclusive(() => run(value, true));
  }
  // Read only: what PingOne holds now.
  async function read() {
    if (!configured) return { ok: false, error: 'The member-tier switch is not configured.', users: [] };
    return exclusive(() => run(undefined, false));
  }

  return { configured, view, switchTo, read, limited };
}
