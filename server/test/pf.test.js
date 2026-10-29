import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createApp } from '../src/index.js';
import { checkPfToken } from '../src/pf-resource.js';

const PF = 'https://pf.example';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const pfKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PF_JWK = { ...pfKey.publicKey.export({ format: 'jwk' }), kid: 'pf1', alg: 'RS256' };
const pfJwt = (claims, kid = 'pf1', key = pfKey.privateKey) => { const h = `${b64({ alg: 'RS256', kid })}.${b64(claims)}`; return `${h}.${sign('RSA-SHA256', Buffer.from(h), key).toString('base64url')}`; };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

// A stand-in PingFederate: advertises CIMD, fetches the client document (and ChatGPT's JWKS) from Muse, checks the assertion the way
// PingFederate 13.1 does (aud = issuer, typ client-authentication+jwt), issues an RS256 JWT.
function fakePf(base, seen) {
  return async (url, init = {}) => {
    const u = String(url); seen.push({ url: u, init });
    if (u === `${PF}/.well-known/oauth-authorization-server`) return json(200, { issuer: PF, authorization_endpoint: `${PF}/as/authorization.oauth2`, token_endpoint: `${PF}/as/token.oauth2`, registration_endpoint: `${PF}/as/clients.oauth2`, client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], code_challenge_methods_supported: ['S256'] });
    if (u === `${PF}/.well-known/openid-configuration`) return json(200, { issuer: PF, jwks_uri: `${PF}/pf/JWKS` });
    if (u === `${PF}/pf/JWKS`) return json(200, { keys: [PF_JWK] });
    if (u === `${PF}/as/token.oauth2`) {
      const f = new URLSearchParams(init.body);
      const doc = await (await fetch(f.get('client_id'))).json();
      if (doc.client_id !== f.get('client_id') || !doc.redirect_uris.includes(f.get('redirect_uri'))) return json(400, { error: 'invalid_client' });
      if (doc.token_endpoint_auth_method === 'private_key_jwt') {
        const a = f.get('client_assertion') ?? ''; const [h, c, s] = a.split('.');
        const keys = (await (await fetch(doc.jwks_uri)).json()).keys;
        const k = keys.find((x) => x.kid === JSON.parse(Buffer.from(h, 'base64url')).kid);
        const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString() || '{}');
        if (!k || !verify('RSA-SHA256', Buffer.from(`${h}.${c}`), createPublicKey({ key: k, format: 'jwk' }), Buffer.from(s, 'base64url')) || claims.iss !== doc.client_id || claims.aud !== PF || JSON.parse(Buffer.from(h, 'base64url')).typ !== 'client-authentication+jwt') return json(401, { error: 'invalid_client' });
      }
      return json(200, { access_token: pfJwt({ iss: PF, aud: `${base}/mcp-pf`, sub: 'sam@pf', scope: 'openid muse:mcp', client_id: doc.client_id, exp: Math.floor(Date.now() / 1000) + 600 }), token_type: 'Bearer', expires_in: 600 });
    }
    throw new Error(`unexpected ${u}`);
  };
}

async function boot() {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`; const seen = [];
  const env = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: 'https://gw.example/x/mcp', MUSE_PUBLIC_URL: base, MUSE_PF_ISSUER: PF };
  const server = createApp(env, { fetchImpl: fakePf(base, seen) }).listen(port, '127.0.0.1');
  await once(server, 'listening');
  const jar = {}; const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (m, p, body, headers = {}) => { const r = await fetch(p.startsWith('http') ? p : base + p, { method: m, redirect: 'manual', headers: { 'content-type': 'application/json', cookie: cookie(), ...headers }, body: body ? JSON.stringify(body) : undefined }); for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; } return r; };
  return { base, seen, call, close: () => new Promise((r) => server.close(r)) };
}

for (const [key, signs] of [['chatgpt', true], ['codex', false], ['claude', false]]) {
  test(`${key} on the PingFederate server: CIMD (no registration), PKCE + resource, ${signs ? 'private_key_jwt' : 'public client'}, PF JWT checked by /mcp-pf`, async () => {
    const a = await boot();
    try {
      await a.call('GET', '/api/session');
      const doc = await (await a.call('GET', `/sim/${key}/client.json`)).json();
      assert.equal(doc.client_id, `${a.base}/sim/${key}/client.json`); assert.deepEqual(doc.redirect_uris, [`${a.base}/sim/${key}/callback`]);
      const st = await (await a.call('POST', '/api/sim/start', { platform: key, server: 'pf' })).json();
      assert.equal(st.method, 'cimd');
      const au = new URL(st.url);
      assert.equal(au.origin + au.pathname, `${PF}/as/authorization.oauth2`);
      assert.equal(au.searchParams.get('client_id'), doc.client_id, 'client_id is the document address');
      assert.equal(au.searchParams.get('resource'), `${a.base}/mcp-pf`); assert.equal(au.searchParams.get('scope'), 'muse:mcp');
      assert.ok(!a.seen.some((x) => x.url.endsWith('/as/clients.oauth2')), 'no dynamic registration');
      await a.call('GET', `/sim/${key}/callback?code=pfcode&state=${au.searchParams.get('state')}`);
      const s = (await (await a.call('GET', '/api/session')).json()).assistant;
      assert.equal(s.error, null); assert.equal(s.method, 'cimd'); assert.equal(s.points.points, 52000); assert.equal(s.points.passenger, 'sam@pf');
      const tokenReq = new URLSearchParams(a.seen.find((x) => x.url === `${PF}/as/token.oauth2`).init.body);
      assert.equal(Boolean(tokenReq.get('client_assertion')), signs);
      assert.equal(s.steps.find((x) => x.n === 7).request.body.client_assertion ?? null, signs ? '(signed JWT, sent)' : null);
    } finally { await a.close(); }
  });
}

test('/mcp-pf refuses tokens that are not PingFederate\'s, for another resource, without the scope, or expired', async () => {
  const a = await boot();
  try {
    const good = { iss: PF, aud: `${a.base}/mcp-pf`, sub: 's', scope: 'muse:mcp', exp: Math.floor(Date.now() / 1000) + 60 };
    const ask = (t) => a.call('POST', '/mcp-pf', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, t ? { authorization: `Bearer ${t}` } : {});
    assert.equal((await ask(pfJwt(good))).status, 200);
    const r0 = await ask(null); assert.equal(r0.status, 401); assert.match(r0.headers.get('www-authenticate'), /oauth-protected-resource\/mcp-pf/);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const [why, t] of [['other key', pfJwt(good, 'pf1', other.privateKey)], ['unknown kid', pfJwt(good, 'nope')], ['issuer', pfJwt({ ...good, iss: 'https://evil.example' })], ['audience', pfJwt({ ...good, aud: 'https://other.example/api' })], ['scope', pfJwt({ ...good, scope: 'admin:write' })], ['expired', pfJwt({ ...good, exp: 1 })], ['alg none', `${b64({ alg: 'none', kid: 'pf1' })}.${b64(good)}.`]]) {
      assert.equal((await ask(t)).status, 401, why);
    }
  } finally { await a.close(); }
});

test('checkPfToken reads the scope as a list or a string', async () => {
  const getJwks = async () => [PF_JWK];
  const c = { iss: PF, aud: 'r', exp: Math.floor(Date.now() / 1000) + 60 };
  assert.equal((await checkPfToken(pfJwt({ ...c, scope: ['muse:mcp'] }), { issuer: PF, resource: 'r', scope: 'muse:mcp', getJwks })).ok, true);
  assert.equal((await checkPfToken(pfJwt({ ...c, scope: 'openid muse:mcpx' }), { issuer: PF, resource: 'r', scope: 'muse:mcp', getJwks })).ok, false);
});

test('without MUSE_PF_ISSUER nothing of the PingFederate path is served', async () => {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const server = createApp({ ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: 'https://gw.example/x/mcp', MUSE_PUBLIC_URL: base }).listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const d = await fetch(`${base}/sim/chatgpt/client.json`);
    assert.ok(d.status === 404 || !String(d.headers.get('content-type')).includes('json'), 'no client document (a built page may answer GETs with index.html)');
    assert.equal((await fetch(`${base}/mcp-pf`, { method: 'POST' })).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});
