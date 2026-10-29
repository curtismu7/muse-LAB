import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/index.js';

test('a non-loopback bind is refused unless MUSE_HOSTED=1', async () => {
  assert.throws(() => start({ MUSE_BIND: '0.0.0.0', PORT: '0' }), /refusing to bind/);
  const server = start({ MUSE_BIND: '0.0.0.0', PORT: '0', MUSE_HOSTED: '1' });
  await new Promise((r) => server.once('listening', r));
  await new Promise((r) => server.close(r));
});

test('MODE must be mock, or live with ALLOW_LIVE=1', async () => {
  assert.throws(() => start({ MODE: 'live', PORT: '0' }), /MODE must be/);
  assert.throws(() => start({ MODE: 'real', PORT: '0', ALLOW_LIVE: '1' }), /MODE must be/);
  const server = start({ MODE: 'live', ALLOW_LIVE: '1', PORT: '0' });
  await new Promise((r) => server.once('listening', r));
  await new Promise((r) => server.close(r));
});

test('the default bind is loopback only', async () => {
  const server = start({ PORT: '0' });
  await new Promise((r) => server.once('listening', r));
  assert.equal(server.address().address, '127.0.0.1');
  await new Promise((r) => server.close(r));
});
