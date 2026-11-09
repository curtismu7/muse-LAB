// Behind the family lab-proxy: Host is this app's LAB_ALLOWED_HOSTS name with its PORT, the browser's Origin is the
// launcher's, and the proxy says so in X-Forwarded-Host/-Proto. Placeholder names here; compose sets the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, labProxyHosts } from '../src/index.js';

const NAME = 'muse.proxy.example';
const XFH = 'launcher.example:8443';
const PROXY = `https://${XFH}`;
const HOST = `${NAME}:5100`;
const fwd = { 'x-forwarded-host': XFH, 'x-forwarded-proto': 'https' };

async function withMuse(fn, env = {}) {
  const server = createApp({ LAB_ALLOWED_HOSTS: ` ${NAME.toUpperCase()} `, PORT: '5100', ...env }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}
const send = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
  });
  req.on('error', reject); req.end(body);
});
const write = (port, headers) => send(port, 'POST', '/api/reset', headers, '{}');

test('LAB_ALLOWED_HOSTS: unset is none; names become <name>:<PORT>; a port or URL is refused at start', () => {
  assert.deepEqual([...labProxyHosts({})], []);
  assert.deepEqual([...labProxyHosts({ LAB_ALLOWED_HOSTS: 'A.example, b.example,', PORT: '5100' })], ['a.example:5100', 'b.example:5100']);
  for (const bad of ['a.example:5100', 'http://a.example', 'a.example/x']) assert.throws(() => createApp({ LAB_ALLOWED_HOSTS: bad }));
});

test('launcher Host <name>:<PORT> gets the page; the bare name, another port or a Host outside the set is refused', async () => {
  await withMuse(async (port) => {
    assert.equal((await send(port, 'GET', '/api/info', { host: HOST })).status, 200);
    for (const host of [NAME, `${NAME}:1`, 'proxy.example:5100', XFH, 'evil.example:5100']) {
      const r = await send(port, 'GET', '/api/info', { host });
      assert.equal(r.status, 403, host);
      assert.match(r.text, /host not allowed/);
    }
  });
});

test('a proxied same-origin write is accepted; a foreign or mismatched Origin is refused', async () => {
  await withMuse(async (port) => {
    const ok = await write(port, { host: HOST, ...fwd, origin: PROXY });
    assert.notEqual(ok.status, 403, ok.text);
    for (const origin of ['https://evil.example', `http://${XFH}`, `https://${XFH.split(':')[0]}`]) assert.equal((await write(port, { host: HOST, ...fwd, origin })).status, 403, origin);
    assert.equal((await write(port, { host: HOST, ...fwd, 'x-forwarded-proto': 'ftp', origin: `ftp://${XFH}` })).status, 403);
    assert.equal((await write(port, { host: HOST, 'x-forwarded-proto': 'https', origin: 'https://' })).status, 403, 'empty X-Forwarded-Host');
    assert.equal((await write(port, { host: HOST, 'x-forwarded-host': XFH, origin: PROXY })).status, 403, 'no X-Forwarded-Proto');
  });
});

test('forwarded headers on a loopback Host are ignored; a Host outside the set is refused before any Origin check', async () => {
  await withMuse(async (port) => {
    assert.equal((await write(port, { host: `127.0.0.1:${port}`, ...fwd, origin: PROXY })).status, 403);
    assert.equal((await write(port, { host: `localhost:${port}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' })).status, 403);
    const r = await write(port, { host: 'evil.example:5100', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.match(r.text, /host not allowed/);
  });
});

test('the launcher does not unlock mock sign-in: the persona picker stays off in the hosted (container) build', async () => {
  await withMuse(async (port) => {
    const info = JSON.parse((await send(port, 'GET', '/api/session', { host: HOST })).text);
    assert.equal(info.picker, false);
  }, { MUSE_HOSTED: '1', IDP: 'mock', ALLOW_MOCK_SIGNIN: '1' });
});

test('a write whose Origin does not parse ("null", "https://") is refused, on loopback too', async () => {
  await withMuse(async (port) => {
    for (const origin of ['null', 'https://']) assert.equal((await write(port, { host: `127.0.0.1:${port}`, origin })).status, 403, origin);
    assert.notEqual((await write(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 403);
  });
});
