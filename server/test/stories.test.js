import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/index.js';
import { loadStories, renderStory, validateStories } from '../src/stories.js';

const good = () => JSON.parse(JSON.stringify(loadStories()));

test('three vertical packs ship, each with a cast and no undefined token', () => {
  const data = loadStories();
  assert.deepEqual(Object.keys(data.verticals), ['airline', 'bank', 'hotel']);
  for (const name of Object.keys(data.verticals)) {
    const s = renderStory(data, name);
    for (const text of [s.ask, s.answer, s.summary]) {
      assert.ok(!/\{\{cast/.test(text), `${name}: cast tokens are all filled: ${text}`);
      for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(data.runtimeTokens.includes(m[1]), `${name}: only runtime tokens are left: ${m[1]}`);
    }
    assert.ok(s.ask.includes(data.verticals[name].cast.provider), `${name}: the story is about its own provider`);
  }
  assert.notEqual(renderStory(data, 'bank').ask, renderStory(data, 'hotel').ask, 'the packs differ');
});

test('an undefined token fails the load (so a typo fails the build)', () => {
  const a = good(); a.verticals.bank.story.ask = 'How many {{cast.unitt}} do I have?';
  assert.throws(() => validateStories(a), /bank: story\.ask uses undefined token \{\{cast\.unitt\}\}/);
  const b = good(); b.verticals.hotel.story.answer = 'You have {{balance}}.';
  assert.throws(() => validateStories(b), /hotel: story\.answer uses undefined token \{\{balance\}\}/);
});

test('a malformed pack file is refused', () => {
  assert.throws(() => validateStories({ schema: 'other' }), /schema/);
  const few = good(); delete few.verticals.hotel; assert.throws(() => validateStories(few), /at least three/);
  const markup = good(); markup.verticals.bank.cast.provider = '<b>x</b>'; assert.throws(() => validateStories(markup), /plain text/);
  const dflt = good(); dflt.default = 'nope'; assert.throws(() => validateStories(dflt), /default vertical/);
});

test('/api/story serves the default pack, a chosen one, and refuses an unknown vertical', async () => {
  const server = createApp({}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = await (await fetch(base + '/api/story')).json();
    assert.equal(d.vertical, 'airline'); assert.deepEqual(d.verticals.map((v) => v.key), ['airline', 'bank', 'hotel']);
    assert.ok(d.ask.includes('SkyHigh Airlines'));
    const b = await (await fetch(base + '/api/story?vertical=bank')).json();
    assert.ok(b.answer.includes('Harbor Bank') && b.answer.includes('{{points}}'), 'runtime tokens are left for the page');
    assert.equal((await fetch(base + '/api/story?vertical=spaceship')).status, 400);
    assert.equal((await fetch(base + '/api/story?vertical=')).status, 400);
  } finally { await new Promise((r) => server.close(r)); }
});
