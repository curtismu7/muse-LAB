// The official MCP SDK client against the connector with refresh on (stub PingOne and gateway, in-process): sign in, tools work, the access token expires (mocked clock),
// the call is refused with 401, the SDK's own refresh grant gets a new token, tools work again, and the old refresh token is dead.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ON, REDIRECT, boot, callTool, refreshWith } from './helpers/refresh-stack.js';

// What an MCP client keeps between calls. The SDK drives discovery, registration, PKCE and the token requests through it.
class Memory {
  tokensNow; info; verifier; authUrl;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: 'sdk-test', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.info; }
  saveClientInformation(i) { this.info = i; }
  tokens() { return this.tokensNow; }
  saveTokens(t) { this.tokensNow = t; }
  redirectToAuthorization(url) { this.authUrl = url; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

test('the official SDK client: sign in, tools work, the access token expires, the call gets 401, the SDK refreshes, tools work again, the old refresh token is dead', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const a = await boot(ON, { lifetimeS: 1800 });
  try {
    const memory = new Memory();
    const wire = [];   // what the SDK sent to the connector: method, path, status (and the grant of a token request)
    const spyFetch = async (url, init) => {
      const res = await fetch(url, init);
      const u = new URL(String(url));
      const grant = u.pathname === '/connector/token' ? new URLSearchParams(String(init?.body ?? '')).get('grant_type') : undefined;
      wire.push({ method: init?.method ?? 'GET', path: u.pathname, status: res.status, grant });
      return res;
    };
    const open = () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${a.base}/mcp`), { authProvider: memory, fetch: spyFetch });
      return { transport, client: new Client({ name: 'sdk-test', version: '1.0.0' }) };
    };

    // 1. Sign in: the first connect is refused with 401, the SDK discovers and registers and asks for the browser.
    const first = open();
    await assert.rejects(() => first.client.connect(first.transport), UnauthorizedError);
    assert.ok(memory.authUrl, 'the SDK asked for a browser sign-in');
    assert.equal(memory.authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.match(memory.info.client_id, /^muse-/);
    // The browser: the connector sends it to its own sign-in page; the page finishes the PingOne flow (pi.flow) and is sent back to the agent with the code.
    const au = await a.get(`/connector/authorize${memory.authUrl.search}`);
    assert.equal(au.status, 302);
    const flow = new URL(au.headers.get('location')).searchParams.get('flow');
    const done = await (await a.post('/connector/signin/complete', { state: flow, code: 'pingone-code' })).json();
    const code = new URL(done.redirectTo).searchParams.get('code');
    await first.transport.finishAuth(code);
    assert.ok(memory.tokensNow.refresh_token, 'the SDK was given a refresh token');
    const firstRefresh = memory.tokensNow.refresh_token;
    const firstAccess = memory.tokensNow.access_token;

    // 2. Tools work.
    const s = open();
    await s.client.connect(s.transport);
    assert.deepEqual((await s.client.listTools()).tools.map((t) => t.name), ['loyalty_balance', 'get_loyalty_status', 'list_flights', 'book_flight']);
    const before = await s.client.callTool({ name: 'loyalty_balance', arguments: {} });
    assert.equal(before.isError, false);
    assert.equal(JSON.parse(before.content[0].text).points, 52000);
    assert.equal(wire.filter((w) => w.grant === 'refresh_token').length, 0, 'no refresh yet');

    // 3. The access token expires (the clock is moved), and the connector refuses it with 401.
    mock.timers.tick(1801 * 1000);
    const stale = await callTool(a, firstAccess);
    assert.equal(stale.status, 401);
    assert.match(stale.headers.get('www-authenticate'), /resource_metadata=/);

    // 4. The SDK's next call gets that 401, refreshes by itself, and goes on.
    const mark = wire.length;
    const after = await s.client.callTool({ name: 'loyalty_balance', arguments: {} });
    assert.equal(after.isError, false);
    assert.equal(JSON.parse(after.content[0].text).points, 52000);
    const sequence = wire.slice(mark).filter((w) => w.path === '/mcp' || w.path === '/connector/token').map((w) => `${w.method} ${w.path} ${w.status}${w.grant ? ` ${w.grant}` : ''}`);
    assert.deepEqual(sequence.slice(0, 3), ['POST /mcp 401', 'POST /connector/token 200 refresh_token', 'POST /mcp 200'], 'the 401, the refresh grant, then the call again');
    assert.equal(a.grants().filter((g) => g === 'refresh_token').length, 1, 'PingOne was asked to refresh once');
    assert.notEqual(memory.tokensNow.access_token, firstAccess);
    assert.notEqual(memory.tokensNow.refresh_token, firstRefresh, 'the refresh token was rotated');
    assert.equal((await s.client.listTools()).tools.length, 4, 'tools work again');

    // 5. The old refresh token is dead (after the retry grace), and presenting it revokes the sign-in.
    mock.timers.tick(11 * 1000);
    const old = await refreshWith(a, memory.info.client_id, firstRefresh);
    assert.equal(old.status, 400); assert.equal((await old.json()).error, 'invalid_grant');
    assert.equal((await callTool(a, memory.tokensNow.access_token)).status, 401, 'the reuse revoked the whole sign-in');
    await s.client.close();
  } finally { mock.timers.reset(); await a.close(); }
});
