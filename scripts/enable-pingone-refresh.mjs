#!/usr/bin/env node
// OWNER-RUN. Turns on the refresh grant for one PingOne application, so the Airline Connector (MUSE_CONNECTOR_REFRESH=1) can be given a PingOne refresh token.
//
//   node scripts/enable-pingone-refresh.mjs <application-id>                   dry run: reads the application and shows the plan, changes nothing
//   node scripts/enable-pingone-refresh.mjs <application-id> --apply           saves the BEFORE json next to this script, changes the application, reads it back
//   --hours N       how long a refresh token may live in total (default 24, at most 168; keep it equal to MUSE_CONNECTOR_REFRESH_MAX_HOURS)
//
// Which application: the PingOne app the connector signs in with (MUSE_P1_CLIENT_ID), or the agent's own app from MUSE_CONNECTOR_AGENTS.
// Credentials are read from the environment when the script runs (a PingOne worker application that may read and update applications) and are never printed or saved:
//   PINGONE_ENV_ID                  the environment that holds the application (and the worker)
//   PINGONE_WORKER_CLIENT_ID        the worker application's client id
//   PINGONE_WORKER_CLIENT_SECRET    the worker application's client secret
//   PINGONE_REGION                  optional: com (default), eu, asia, ca, com.au or sg
// What it changes, and nothing else: REFRESH_TOKEN is added to grantTypes, and refreshTokenDuration, refreshTokenRollingDuration (both N hours in seconds, so the chain
// ends N hours after sign-in) and refreshTokenRollingGracePeriodDuration (0: the connector keeps its own 10 second retry grace) are set.
// The field names are from PingOne's application schema. Whether a particular tenant accepts the values is UNVERIFIED until the owner runs it: the dry run shows the plan first.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REGIONS = ['com', 'eu', 'asia', 'ca', 'com.au', 'sg'];
export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 168;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY = ['_links', 'id', 'environment', 'createdAt', 'updatedAt'];
const FIELDS = ['refreshTokenDuration', 'refreshTokenRollingDuration', 'refreshTokenRollingGracePeriodDuration'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure: what has to change on this application for N hours of refresh, or why it cannot. { ok, changes: [{field, from, to}], body } or { ok: false, reason }.
export function planRefresh(app, hours = DEFAULT_HOURS) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) return { ok: false, reason: 'PingOne did not return an application.' };
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) return { ok: false, reason: `--hours must be above 0 and at most ${MAX_HOURS}.` };
  if (app.protocol !== 'OPENID_CONNECT') return { ok: false, reason: `This application uses ${app.protocol ?? 'an unknown protocol'}; only OPENID_CONNECT applications have a refresh grant.` };
  const grants = Array.isArray(app.grantTypes) ? app.grantTypes : [];
  if (!grants.includes('AUTHORIZATION_CODE')) return { ok: false, reason: 'This application does not have the AUTHORIZATION_CODE grant, which the connector sign-in needs. Nothing was planned.' };
  const seconds = Math.round(hours * 3600);
  const want = { grantTypes: grants.includes('REFRESH_TOKEN') ? grants : [...grants, 'REFRESH_TOKEN'], refreshTokenDuration: seconds, refreshTokenRollingDuration: seconds, refreshTokenRollingGracePeriodDuration: 0 };
  const changes = [];
  for (const field of ['grantTypes', ...FIELDS]) if (!same(app[field], want[field])) changes.push({ field, from: app[field] ?? null, to: want[field] });
  const body = Object.fromEntries(Object.entries({ ...app, ...want }).filter(([k]) => !READ_ONLY.includes(k)));
  return { ok: true, changes, body };
}

// What an application must look like after the change: every field as before except the planned ones (read-only fields are ignored).
export function verifyApplied(before, after, plan) {
  const strip = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !READ_ONLY.includes(k)));
  const b = strip(before); const w = strip(after);
  const problems = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(w)])) {
    const planned = plan.body[k];
    const expected = plan.changes.some((c) => c.field === k) ? planned : b[k];
    if (!same(w[k], expected)) problems.push(k);
  }
  return problems;
}

// PingOne answers with { code, message } (and details); only those are ever shown, never a request.
const why = async (res) => { const j = await res.json().catch(() => null); return `HTTP ${res.status}${j?.code ? ` ${String(j.code).slice(0, 60)}` : ''}${j?.message ? `: ${String(j.message).slice(0, 200)}` : ''}`; };

export async function run({ argv, env, fetchImpl = fetch, out = (s) => console.log(s), saveBefore, now = () => new Date() }) {
  const args = argv.filter((x) => !x.startsWith('--'));
  const flag = (n) => argv.includes(n);
  const hi = argv.indexOf('--hours');
  const hours = hi >= 0 ? Number(argv[hi + 1]) : DEFAULT_HOURS;
  const appId = args.find((x) => UUID.test(x));
  if (!appId) { out('Usage: node scripts/enable-pingone-refresh.mjs <application-id> [--hours N] [--apply]'); return 2; }
  const need = ['PINGONE_ENV_ID', 'PINGONE_WORKER_CLIENT_ID', 'PINGONE_WORKER_CLIENT_SECRET'].filter((k) => !env[k]);
  if (need.length) { out(`Set these environment variables first (values are not printed): ${need.join(', ')}.`); return 2; }
  if (!UUID.test(env.PINGONE_ENV_ID)) { out('PINGONE_ENV_ID must be an environment id (a UUID).'); return 2; }
  const region = env.PINGONE_REGION || 'com';
  if (!REGIONS.includes(region)) { out(`PINGONE_REGION must be one of ${REGIONS.join(', ')}.`); return 2; }
  const api = `https://api.pingone.${region}/v1/environments/${env.PINGONE_ENV_ID}/applications/${appId}`;

  // A worker token for this run only. Held in this function; never printed, saved or logged.
  const basic = Buffer.from(`${env.PINGONE_WORKER_CLIENT_ID}:${env.PINGONE_WORKER_CLIENT_SECRET}`).toString('base64');
  const tr = await fetchImpl(`https://auth.pingone.${region}/${env.PINGONE_ENV_ID}/as/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const token = tr.status === 200 ? (await tr.json().catch(() => null))?.access_token : null;
  if (typeof token !== 'string') { out(`PingOne would not give the worker a token (${await why(tr)}). Check the worker's id and secret.`); return 1; }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const got = await fetchImpl(api, { headers });
  if (got.status !== 200) { out(`Could not read the application (${await why(got)}).`); return 1; }
  const before = await got.json();
  const plan = planRefresh(before, hours);
  out(`Application: ${String(before.name ?? '').slice(0, 80)} (${appId}), type ${before.type ?? '?'}, ${before.protocol ?? '?'}`);
  if (!plan.ok) { out(`Cannot plan: ${plan.reason}`); return 1; }
  if (!plan.changes.length) { out(`Nothing to change: REFRESH_TOKEN is already a grant and the durations are already ${hours} hours.`); return 0; }
  out(`Plan (${hours} hours):`);
  for (const c of plan.changes) out(`  ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  out('  every other field is sent back as it is. Also check, in the PingOne console, that the application\'s Resources allow the openid scope offline_access (this script does not).');
  if (!flag('--apply')) { out('Dry run: nothing was changed. Run again with --apply to change the application.'); return 0; }

  // The BEFORE copy is written before anything changes, so the application can be put back by hand.
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const file = saveBefore(`pingone-app-before-${appId}-${stamp}.json`, JSON.stringify(before, null, 2));
  out(`Saved the BEFORE copy: ${file}`);
  const put = await fetchImpl(api, { method: 'PUT', headers, body: JSON.stringify(plan.body) });
  if (put.status !== 200) { out(`PingOne refused the change (${await why(put)}). The application was not changed; the BEFORE copy is kept.`); return 1; }
  const check = await fetchImpl(api, { headers });
  if (check.status !== 200) { out(`The change was sent, but reading it back failed (${await why(check)}). Check the application in the console.`); return 1; }
  const problems = verifyApplied(before, await check.json(), plan);
  if (problems.length) { out(`Read back: these fields are not as planned: ${problems.join(', ')}. Compare with the BEFORE copy.`); return 1; }
  out('Verified by reading it back: REFRESH_TOKEN is a grant and the durations are set. Every other field is unchanged.');
  out(`Next: set MUSE_CONNECTOR_REFRESH=1 (and MUSE_CONNECTOR_REFRESH_MAX_HOURS=${hours}), restart Muse, and reconnect muse.ai once to receive its first refresh token.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const code = await run({
    argv: process.argv.slice(2), env: process.env,
    saveBefore: (name, text) => { const f = join(dir, name); writeFileSync(f, text, { mode: 0o600 }); return f; },
  });
  process.exit(code);
}
