import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { DEFAULT_AIRLINE } from '../src/connectorInfo.js';
import { connectorName } from '../src/connectorName.js';
import { loadStories, renderStory } from '../src/stories.js';

// The family's airline brand is AirGuard Airlines (owner decision, 2026-11-28). The earlier brand is retired: it is built from pieces here so this file does not trip its own sweep.
const RETIRED = new RegExp(['Sky', 'High'].join('') + '|' + ['sky', 'high'].join(''), 'i');

test('the default airline is AirGuard Airlines in the connector facts and in the story pack', async () => {
  assert.equal(DEFAULT_AIRLINE, 'AirGuard Airlines');
  const data = loadStories();
  assert.equal(data.default, 'airline');
  assert.equal(data.verticals.airline.cast.provider, 'AirGuard Airlines');
  assert.ok(renderStory(data, 'airline').ask.includes('AirGuard Airlines'));
  const server = createApp({}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const d = await (await fetch(`http://127.0.0.1:${server.address().port}/api/story`)).json();
    assert.ok(d.ask.includes('AirGuard Airlines') && d.summary.includes('AirGuard Airlines'));
    assert.ok(!RETIRED.test(JSON.stringify(d)), 'the rendered default story carries no retired brand');
  } finally { await new Promise((r) => server.close(r)); }
});

test('the retired airline brand appears nowhere in the repo text (code, docs, diagrams, config examples)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
  const text = new Set(['.js', '.jsx', '.mjs', '.json', '.md', '.html', '.py', '.yml', '.yaml', '.example', '.css']);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!text.has(extname(name)) || name === 'package-lock.json') continue;
      if (RETIRED.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length));
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

test('connectorName: no second "Airline" after the full brand; an older value keeps its form; blank is the generic name', () => {
  const OLD = ['Sky', 'High'].join(''); // the value the hosted site still runs until its Secret is changed
  assert.equal(connectorName('AirGuard Airlines'), 'AirGuard Airlines Connector');
  assert.equal(connectorName('  AirGuard Airlines  '), 'AirGuard Airlines Connector');
  assert.equal(connectorName('AirGuard Airline'), 'AirGuard Airline Connector');
  assert.equal(connectorName('AirGuard'), 'AirGuard Airline Connector');
  assert.equal(connectorName(OLD), `${OLD} Airline Connector`);
  assert.equal(connectorName(''), 'Airline Connector');
  assert.equal(connectorName(undefined), 'Airline Connector');
});
