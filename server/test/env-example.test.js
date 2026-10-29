import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const example = readFileSync(new URL('.env.example', root), 'utf8');
const src = readdirSync(new URL('server/src/', root)).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(`server/src/${f}`, root), 'utf8')).join('\n');

test('.env.example only names settings the server reads, with placeholder values', () => {
  const lines = example.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
  assert.ok(lines.length > 10);
  for (const l of lines) {
    const [k, v] = [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)];
    assert.match(src, new RegExp(`env\\.${k}\\b`), `${k} is read by server/src`);
    assert.doesNotMatch(v, /^[0-9a-f]{8}-(?!0000)[0-9a-f]{4}-/i, `${k} must not hold a real id`);
  }
  assert.doesNotMatch(example, /ping-devops|pingidentity\.com|auth\.pingone\.com\/[0-9a-f]{8}-(?!0000)/, 'no real hosts or tenants');
});
