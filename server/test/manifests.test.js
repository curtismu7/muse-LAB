import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../k8s/deploy.sh', import.meta.url));
const render = (env) => execFileSync('bash', [script, '--dry-run'], { env: { PATH: process.env.PATH, IMAGE: 'ghcr.io/x/muse:sha-1', SE_HOST: 'muse.example', ...env }, encoding: 'utf8' });

test('the hosted manifests default to the mock-only build', () => {
  const out = render({});
  assert.match(out, /\{ name: MODE, value: mock \}/);
  assert.match(out, /name: muse\n/);
});

test('APP_NAME and MODE=live render a second, real deployment', () => {
  const out = render({ APP_NAME: 'muse-mock', MODE: 'live' });
  assert.match(out, /\{ name: MODE, value: live \}/);
  assert.match(out, /secretRef: \{ name: muse-mock-real, optional: true \}/);
  assert.doesNotMatch(out, /name: muse\n/);
});

test('an unknown MODE is refused', () => {
  assert.throws(() => render({ MODE: 'real' }), /MODE must be mock or live/);
});
