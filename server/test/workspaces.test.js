import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaces } from '../src/workspaces.js';

test('a full store refuses new visitors and never evicts an existing one', () => {
  const store = createWorkspaces({ max: 2 });
  const a = store.create();
  const b = store.create();
  assert.ok(a && b);
  assert.equal(store.create(), null, 'third visitor is refused');
  assert.equal(store.find(a.id), a, 'first visitor still has its workspace');
  assert.equal(store.size(), 2);
});

test('an idle workspace expires and frees its slot', () => {
  let t = 0;
  const store = createWorkspaces({ max: 1, idleMs: 1000, now: () => t });
  const a = store.create();
  assert.equal(store.create(), null);
  t = 1001;
  assert.equal(store.find(a.id), null, 'idle workspace is gone');
  assert.ok(store.create(), 'slot is free again');
});

test('find returns null for an unknown or missing id', () => {
  const store = createWorkspaces();
  assert.equal(store.find(null), null);
  assert.equal(store.find('nope'), null);
});
