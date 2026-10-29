import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { loadCustomer } from '../src/customer.js';

const V = ['airline', 'bank', 'hotel'];
const tmpFile = (obj) => { const f = join(mkdtempSync(join(tmpdir(), 'muse-cc-')), 'c.json'); writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };

test('the shipped customer config names the site Agent Connect and the agent Muse', () => {
  const c = loadCustomer({}, V);
  assert.equal(c.brandName, 'Agent Connect'); assert.equal(c.agentName, 'Muse'); assert.equal(c.vertical, 'airline');
});

test('a customer file overrides the branding; bad values and bad files fall back to the defaults', () => {
  const ok = loadCustomer({ MUSE_CUSTOMER_CONFIG: tmpFile({ brandName: 'Acme Connect', agentName: 'Ace', tagline: 'Hi', vertical: 'bank' }) }, V);
  assert.deepEqual(ok, { brandName: 'Acme Connect', agentName: 'Ace', tagline: 'Hi', vertical: 'bank' });
  const bad = loadCustomer({ MUSE_CUSTOMER_CONFIG: tmpFile({ brandName: '<script>alert(1)</script>', agentName: 42, vertical: 'spaceship', tagline: 'x'.repeat(500) }) }, V);
  assert.equal(bad.brandName, 'Agent Connect', 'markup is refused');
  assert.equal(bad.agentName, 'Muse', 'a non-string is refused');
  assert.equal(bad.vertical, 'airline', 'an unknown vertical falls back to the first pack');
  assert.equal(bad.tagline.length, 120, 'long text is cut');
  assert.equal(loadCustomer({ MUSE_CUSTOMER_CONFIG: tmpFile('{not json') }, V).brandName, 'Agent Connect', 'a broken file falls back');
  assert.equal(loadCustomer({ MUSE_CUSTOMER_CONFIG: '/nonexistent/file.json' }, V).brandName, 'Agent Connect', 'a missing file falls back');
});

test('the session carries the customer config and a public workspaceId that is not the cookie', async () => {
  const server = createApp({}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/session');
    const cookie = res.headers.get('set-cookie').split(';')[0].split('=')[1];
    const s = await res.json();
    assert.equal(s.customer.brandName, 'Agent Connect');
    assert.match(s.workspaceId, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(s).includes(cookie), 'the HttpOnly session id never appears in the payload');
    const other = await (await fetch(base + '/api/session')).json();
    assert.notEqual(other.workspaceId, s.workspaceId, 'each visitor gets their own workspace');
  } finally { await new Promise((r) => server.close(r)); }
});
