import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// What goes in a zip or an image must not point at our environment: no real tenant, app or user ids, no SE host names.
// Internal notes (left out of zips, see docs/handoff-deployment.md) and these guard tests are skipped.
const root = new URL('../../', import.meta.url);
const INTERNAL = /^docs\/(HANDOFF\.md|handoff-|plan-agent-clients\.md|protect-davinci\.md|mocks\/)/;
const GUARDS = /^server\/test\/(portable|env-example)\.test\.js$/;
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !INTERNAL.test(f) && !GUARDS.test(f) && !/\.(png|jpe?g|ico|woff2?)$/.test(f));

test('shipped files hold only placeholder ids and no SE host names', () => {
  assert.ok(files.length > 30, 'git ls-files ran');
  const bad = [];
  for (const f of files) {
    let s; try { s = readFileSync(new URL(f, root), 'utf8'); } catch { continue; }
    for (const m of s.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []) if (!m.startsWith('00000000')) bad.push(`${f}: ${m}`);
    if (/ping-devops|ai-demo\.ping/i.test(s)) bad.push(`${f}: SE host name`);
  }
  assert.deepEqual(bad, []);
});
