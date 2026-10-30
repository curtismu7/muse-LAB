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

for (const id of ['personal-agent-pattern', 'personal-agent-pattern-ig']) test(`${id} is valid, resolves, and its steps are cumulative`, () => {
  const p = JSON.parse(readFileSync(path.join(here, `../../web/src/diagrams/${id}.json`), 'utf8'));
  assert.equal(p.id, id);
  assert.equal(p.schema, 'diagram-studio/1');
  const ids = new Set(p.nodes.map((n) => n.id));
  assert.equal(ids.size, p.nodes.length);
  for (const g of Object.values(p.groups)) assert.ok(COLORS.has(g.color), `colour ${g.color}`);
  for (const n of p.nodes) assert.ok(p.groups[n.group], `group ${n.group}`);
  for (const e of p.edges) assert.ok(ids.has(e.source) && ids.has(e.target));
  assert.equal(p.steps.length, p.edges.length);
  let prev = [];
  for (const s of p.steps) {
    for (const i of prev) assert.ok(s.edges.includes(i));
    for (const i of s.edges) assert.ok(i >= 0 && i < p.edges.length);
    prev = s.edges;
  }
  assert.ok(!/https?:\/\/(?![a-z]+\.example)/.test(JSON.stringify(p)), 'only .example hosts');
});

for (const id of ['muse-overview', 'muse-config', 'muse-runtime-a', 'muse-runtime-b', 'muse-runtime-c', 'muse-runtime-d', 'muse-runtime-e', 'muse-runtime-f', 'muse-registration', 'muse-agent-connect']) test(`${id}: ReactFlow data meets the diagram standard (numbered and named arrows, a card per step, cumulative steps)`, () => {
  const p = JSON.parse(readFileSync(path.join(here, `../../web/src/diagrams/${id}.json`), 'utf8'));
  assert.equal(p.id, id); assert.equal(p.schema, 'diagram-studio/1');
  const ids = new Set(p.nodes.map((n) => n.id));
  assert.equal(ids.size, p.nodes.length, 'node ids are unique');
  for (const g of Object.values(p.groups)) assert.ok(COLORS.has(g.color), `colour ${g.color}`);
  for (const n of p.nodes) assert.ok(p.groups[n.group], `group ${n.group}`);
  const labels = new Set();
  for (const e of p.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `edge ${e.label} resolves`);
    assert.ok(e.label && e.name && e.name.length <= 40, `arrow ${e.label} is numbered and named`);
    assert.ok(!labels.has(e.label), `arrow number ${e.label} is unique`); labels.add(e.label);
  }
  assert.equal(p.steps.length, p.edges.length, 'one step per arrow');
  let prev = [];
  for (const s of p.steps) {
    assert.ok(s.title && s.what && s.why, `step "${s.title}" has a title, what and why`);
    for (const i of prev) assert.ok(s.edges.includes(i));
    for (const i of s.edges) assert.ok(i >= 0 && i < p.edges.length);
    prev = s.edges;
  }
  assert.deepEqual([...prev].sort((a, b) => a - b), p.edges.map((_, i) => i), 'the last step covers every arrow');
});
