import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '../../web/src/diagrams/personal-agent-flow.json');
const d = JSON.parse(readFileSync(file, 'utf8'));
const COLORS = new Set(['red', 'dark', 'grey', 'blue', 'green', 'amber']);

test('the personal agent flow is valid diagram-studio/1 data', () => {
  assert.equal(d.schema, 'diagram-studio/1');
  assert.match(d.id, /^[a-z0-9-]+$/);
  assert.ok(d.nodes.length <= 60 && d.edges.length <= 120 && d.steps.length <= 60);
  for (const g of Object.values(d.groups)) assert.ok(COLORS.has(g.color), `colour ${g.color}`);
});

test('every edge and node reference resolves', () => {
  const ids = new Set(d.nodes.map((n) => n.id));
  assert.equal(ids.size, d.nodes.length, 'node ids are unique');
  for (const n of d.nodes) assert.ok(d.groups[n.group], `group ${n.group} exists`);
  for (const e of d.edges) {
    assert.ok(ids.has(e.source), `source ${e.source}`);
    assert.ok(ids.has(e.target), `target ${e.target}`);
  }
});

test('steps are cumulative: each step covers the one before, and indexes stay in range', () => {
  let prev = [];
  for (const s of d.steps) {
    for (const i of prev) assert.ok(s.edges.includes(i), `step "${s.title}" keeps edge ${i}`);
    for (const i of s.edges) assert.ok(i >= 0 && i < d.edges.length, `edge index ${i} in range`);
    prev = s.edges;
  }
});
