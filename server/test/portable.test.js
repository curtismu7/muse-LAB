import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// What goes in a zip or an image must not point at our environment: no real tenant, app or user ids, no SE host names.
// Internal notes (left out of zips, see docs/handoff-deployment.md) and these guard tests are skipped.
const root = new URL('../../', import.meta.url);
const INTERNAL = /^docs\/(HANDOFF\.md|handoff-|plan-agent-clients\.md|protect-davinci\.md|mocks\/)/;
const GUARDS = /^server\/test\/(portable|env-example)\.test\.js$/;
// In a git checkout, the tracked files; in an unzipped copy (no .git), every file except installed and built ones.
const walk = (dir) => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (['node_modules', 'dist', '.git'].includes(e.name) ? [] : e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
let listed;
try { listed = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); } catch { listed = []; }
if (!listed.some(Boolean)) listed = walk(''); // not tracked here (unzipped, or inside another repo)
const files = listed.filter((f) => f && !INTERNAL.test(f) && !GUARDS.test(f) && !/\.(png|jpe?g|ico|woff2?)$/.test(f));

test('shipped files hold only placeholder ids and no SE host names', () => {
  assert.ok(files.length > 30, 'git ls-files ran');
  const bad = [];
  for (const f of files) {
    let s; try { s = readFileSync(new URL(f, root), 'utf8'); } catch { continue; }
    for (const m of s.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []) if (!m.startsWith('00000000')) bad.push(`${f}: ${m}`);
    // One exception: compose's LAB_ALLOWED_HOSTS default, the inbound Host name the family lab-proxy sends (not an SE host).
    if (f === 'docker-compose.yml') s = s.replace(/^ {6}LAB_ALLOWED_HOSTS: \$\{LAB_ALLOWED_HOSTS:-muse\.local\.ping-devops\.com\}$/m, '');
    // Second exception: the connector info's list of addresses muse.ai cannot reach names the local lab-proxy host (a loopback name, not an SE host), and its test checks it.
    if (f === 'server/src/connectorInfo.js' || f === 'server/test/connector-info.test.js') s = s.replace(/\blocal\.ping-devops\.com\b/g, '');
    if (/ping-devops|ai-demo\.ping/i.test(s)) bad.push(`${f}: SE host name`);
  }
  assert.deepEqual(bad, []);
});
