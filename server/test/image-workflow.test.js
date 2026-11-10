import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The CI image publish (.github/workflows/image.yml) is never run by a test; these pin what it must say, and what the Dockerfile it builds must keep.
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const wf = read('.github/workflows/image.yml');
const dockerfile = read('Dockerfile');

test('image workflow: runs on a push to main and by hand only, on a GitHub-hosted runner', () => {
  assert.match(wf, /^on:\n {2}workflow_dispatch:\n {2}push:\n {4}branches: \[main\]\n/m);
  assert.doesNotMatch(wf, /pull_request|schedule:|pull_request_target/);
  assert.doesNotMatch(wf, /self-hosted/);
  assert.match(wf, /runs-on: ubuntu-24\.04-arm/);
});

test('image workflow: GITHUB_TOKEN is the only secret, with packages: write on the job and contents: read overall', () => {
  const secrets = [...wf.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0);
  assert.deepEqual([...new Set(secrets)], ['GITHUB_TOKEN']);
  assert.match(wf, /^permissions:\n {2}contents: read\n/m);
  assert.match(wf, /packages: write/);
  assert.equal((wf.match(/packages: write/g) ?? []).length, 1, 'write access only on the image job');
  assert.doesNotMatch(wf, /id-token|contents: write|actions: write/);
});

test('image workflow: pushes ghcr.io/<owner>/muse-lab:sha-<full commit> and never latest', () => {
  assert.match(wf, /ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/muse-lab/);
  assert.match(wf, /:sha-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(wf, /latest/);
  assert.equal((wf.match(/docker push/g) ?? []).length, 1);
  assert.ok(wf.indexOf('Smoke the built image') < wf.indexOf('docker push'), 'the smoke test runs before the push');
});

test('image workflow: actions are pinned by version, and it builds the repo Dockerfile for the cluster (arm64)', () => {
  const uses = [...wf.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@v\d+$/, u);
  assert.match(wf, /platforms: linux\/arm64/);
  assert.match(wf, /context: \./);
  assert.doesNotMatch(wf, /file:/, 'the repo Dockerfile, not a second one');
});

test('image workflow: the smoke test checks non-root, a read-only root and a writable /data, and the health contract', () => {
  assert.match(wf, /--read-only/);
  assert.match(wf, /--tmpfs \/data/);
  assert.match(wf, /--entrypoint id muse-smoke -u/);
  assert.match(wf, /demo-health\/1/);
});

test('Dockerfile: Node 26, runs as the node user, /data owned by it, loopback publish documented', () => {
  assert.match(dockerfile, /^FROM node:26-alpine AS build$/m);
  assert.match(dockerfile, /^FROM node:26-alpine$/m);
  assert.match(dockerfile, /mkdir -p \/data && chown node:node \/data/);
  const user = dockerfile.lastIndexOf('USER node');
  assert.ok(user > dockerfile.indexOf('chown node:node /data'), 'USER node comes after /data is prepared');
  assert.ok(dockerfile.indexOf('CMD ', user) > user, 'the app runs as the node user');
  assert.doesNotMatch(dockerfile, /USER root|^ENV .*SECRET|^ARG .*SECRET/m);
});
