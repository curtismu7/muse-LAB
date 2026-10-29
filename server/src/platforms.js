// What ChatGPT, Claude, Codex and Meta AI do when a customer clicks Connect on an MCP server, run by Muse step by step against a real server.
// Each platform is an MCP client: it calls /mcp, gets a 401, reads the protected-resource metadata (RFC 9728) and the authorization server
// metadata (RFC 8414), then identifies itself: with its client ID metadata document (CIMD) when the server says it supports one, otherwise by
// dynamic client registration (RFC 7591). Then authorization code + PKCE S256 with resource = the MCP server, the token, and MCP calls.
// Two things are stand-ins and say so: the callback (Muse cannot receive at chatgpt.com or on the customer's loopback, so it listens on its own
// /sim/<platform>/callback), and the model (the platform's model picks the tool from tools/list; here the choice is fixed).
// Platform facts are from their published client documents (fetched 2026-10-29) and their docs; anything not confirmed is marked.
import { createHash, randomBytes, sign as signData } from 'node:crypto';

const b64u = (b) => b.toString('base64url');
const rand = (n = 32) => b64u(randomBytes(n));
const PENDING_MS = 10 * 60 * 1000;
const CAP = 200;
// Every platform run calls Muse's own public address about nine times, all from the pod's one address. This per-process value marks those calls
// so the connector's per-address limit does not count them; nobody outside the process knows it.
export const SELF_MARK = rand(24);

export const PLATFORMS = {
  chatgpt: {
    name: 'ChatGPT', kind: 'web',
    realRedirect: 'https://chatgpt.com/connector_platform_oauth_redirect',
    cimd: { url: 'https://chatgpt.com/oauth/client.json', auth: 'private_key_jwt' },
    dcr: { client_name: 'ChatGPT', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  },
  claude: {
    name: 'Claude', kind: 'web',
    realRedirect: 'https://claude.ai/api/mcp/auth_callback',
    // Claude uses CIMD only when the server also lists "none" as a token auth method. Its web document's URL is not published (Claude Code's is).
    cimd: { url: null, auth: 'none', needsNone: true },
    dcr: { client_name: 'Claude', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  },
  codex: {
    name: 'Codex', kind: 'native',
    realRedirect: 'http://127.0.0.1:<port>/callback',
    cimd: { url: 'https://chatgpt.com/oauth/codex/client.json', auth: 'none' },
    dcr: { client_name: 'Codex', application_type: 'native', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  },
  'meta-ai': {
    name: 'Meta AI', kind: 'web',
    realRedirect: 'https://agent.meta.ai/…',
    cimd: null, // not researched
    dcr: { client_name: 'Meta AI', grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  },
};

export const simCallback = (publicUrl, key) => `${publicUrl}/sim/${key}/callback`;
export const simKeyOf = (publicUrl, uri) => {
  const m = typeof uri === 'string' && uri.startsWith(`${publicUrl}/sim/`) ? /^\/sim\/([a-z-]{1,12})\/callback$/.exec(uri.slice(publicUrl.length)) : null;
  return m && PLATFORMS[m[1]] ? m[1] : null;
};

// Muse's own address is fetched with the plain fetch (a real HTTP call to itself, as the platform would make); anything else goes through fetchImpl.
export function createPlatformEngine({ publicUrl, fetchImpl = fetch, selfFetch = fetch, signer = null }) {
  const pending = new Map(); // state -> { key, wsId, verifier, clientId, redirectUri, tokenEndpoint, resource, mcpUrl, method, steps, returnTo, at }
  const go = (url, init) => (String(url).startsWith(publicUrl)
    ? selfFetch(url, { redirect: 'manual', ...init, headers: { ...(init?.headers ?? {}), 'x-muse-self': SELF_MARK } })
    : fetchImpl(url, { redirect: 'manual', ...init }));
  const record = async (steps, n, title, url, init = {}, note) => {
    const r = await go(url, init);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 600); }
    const headers = {};
    for (const h of ['www-authenticate', 'mcp-session-id', 'content-type', 'location']) { const v = r.headers.get(h); if (v) headers[h] = v; }
    const shownBody = init.body && typeof init.body === 'string' ? (init.headers?.['content-type']?.includes('json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
    if (shownBody?.code_verifier) shownBody.code_verifier = '(sent)';
    if (shownBody?.code) shownBody.code = '(sent)';
    if (shownBody?.client_assertion) shownBody.client_assertion = '(signed JWT, sent)';
    steps.push({ n, title, request: { method: init.method ?? 'GET', url: String(url), ...(shownBody ? { body: shownBody } : {}) }, response: { status: r.status, headers, body: redact(body) }, note });
    return { r, body };
  };

  // Steps 1 to 5: what the platform does before the browser leaves for the sign-in.
  async function start(key, { mcpUrl, wsId, returnTo }) {
    const p = PLATFORMS[key];
    if (!p) throw new Error('unknown platform');
    const steps = [];
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: p.name, version: 'sim' } } };
    const a = await record(steps, 1, `${p.name} calls the MCP server`, mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) }, 'No token yet. The server answers 401 and says where its metadata is.');
    const meta = /resource_metadata="([^"]+)"/.exec(a.r.headers.get('www-authenticate') ?? '')?.[1];
    if (a.r.status !== 401 || !meta) return { steps, error: 'The server did not answer 401 with resource_metadata.' };
    const prm = (await record(steps, 2, 'Read the protected resource metadata (RFC 9728)', meta, {}, 'Which authorization server protects this MCP server, and its resource identifier.')).body;
    const asUrl = prm?.authorization_servers?.[0];
    if (!asUrl) return { steps, error: 'The metadata names no authorization server.' };
    const asMeta = (await record(steps, 3, 'Read the authorization server metadata (RFC 8414)', `${asUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`, {}, 'What the server supports: CIMD, dynamic registration, PKCE, token auth methods.')).body;
    const redirectUri = simCallback(publicUrl, key);
    // How the platform identifies itself: its client document if the server supports CIMD, otherwise dynamic registration.
    const canCimd = p.cimd && asMeta?.client_id_metadata_document_supported === true && (!p.cimd.needsNone || (asMeta.token_endpoint_auth_methods_supported ?? []).includes('none'));
    let clientId; let method;
    if (canCimd) {
      // No registration: the client_id IS the address of the platform's client document, which the server fetches and checks.
      method = 'cimd';
      clientId = `${publicUrl}/sim/${key}/client.json`;
      steps.push({ n: 4, title: `${p.name} presents its client ID metadata document (CIMD)`, request: { method: 'GET', url: clientId }, note: `The server advertises client_id_metadata_document_supported, so there is no registration: client_id = the document's address, and the server fetches it. This is Muse's labelled copy of ${p.cimd.url ?? 'the platform\'s document'}, with Muse's callback.${p.cimd.auth === 'private_key_jwt' ? ' It asks for private_key_jwt: the token request is signed with the key in its jwks_uri.' : ''}` });
    } else if (asMeta?.registration_endpoint) {
      method = 'dcr';
      const why = asMeta?.client_id_metadata_document_supported ? '' : 'The server does not advertise client ID metadata documents, so the platform registers. ';
      const reg = await record(steps, 4, `Register ${p.name} (dynamic client registration, RFC 7591)`, asMeta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p.dcr, redirect_uris: [redirectUri] }) },
        `${why}Fields from ${p.name}'s published client document. The redirect URI stands in for ${p.realRedirect}.`);
      clientId = reg.body?.client_id;
      if (reg.r.status !== 201 || !clientId) return { steps, error: `Registration was refused (${reg.r.status}).` };
    } else {
      return { steps, error: 'The server offers neither CIMD nor dynamic registration. The platform would ask the customer for a client ID.' };
    }
    const verifier = rand(48);
    const state = rand(16);
    const resource = prm.resource ?? mcpUrl;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource, ...(prm.scopes_supported?.length ? { scope: prm.scopes_supported.join(' ') } : {}) });
    const authorizeUrl = `${asMeta.authorization_endpoint}?${q}`;
    steps.push({ n: 5, title: 'Send the customer to sign in', request: { method: 'GET', url: authorizeUrl.replace(/code_challenge=[^&]+/, 'code_challenge=(sent)') }, note: 'Authorization code with PKCE S256, and resource = the MCP server. The browser leaves the platform for the server\'s sign-in.' });
    while (pending.size >= CAP) pending.delete(pending.keys().next().value);
    pending.set(state, { key, wsId, verifier, clientId, redirectUri, tokenEndpoint: asMeta.token_endpoint, issuer: asMeta.issuer, resource, mcpUrl, method, signs: method === 'cimd' && p.cimd.auth === 'private_key_jwt', steps, returnTo, at: Date.now() });
    return { steps, authorizeUrl, method };
  }

  // Steps 6 to 9: the callback, the token, then the MCP calls the platform makes with it.
  async function finish(state, { code, error }) {
    const s = pending.get(String(state ?? ''));
    pending.delete(String(state ?? ''));
    if (!s || Date.now() - s.at > PENDING_MS) return null;
    const p = PLATFORMS[s.key];
    const out = { key: s.key, name: p.name, method: s.method, realRedirect: p.realRedirect, steps: s.steps, points: null, error: null, wsId: s.wsId, returnTo: s.returnTo };
    if (error || !code) { out.error = `The sign-in did not finish (${String(error ?? 'no code').slice(0, 40)}).`; return out; }
    s.steps.push({ n: 6, title: `The sign-in returns to ${p.name}`, request: { method: 'GET', url: `${s.redirectUri}?code=(sent)&state=(sent)` }, note: `Stands in for ${p.realRedirect}. The platform checks the state it sent.` });
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: s.redirectUri, client_id: s.clientId, code_verifier: s.verifier, resource: s.resource });
    if (s.signs && signer) {
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set('client_assertion', clientAssertion(signer, s.clientId, s.issuer ?? s.tokenEndpoint));
    }
    const t = await record(s.steps, 7, 'Swap the code for an access token', s.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      s.signs ? 'PKCE verifier, the same redirect URI and resource, and a client assertion signed with the key in the document\'s jwks_uri (private_key_jwt; aud = the issuer, typ client-authentication+jwt, as PingFederate requires).' : 'PKCE verifier, the same redirect URI and resource. A public client: no secret.');
    const token = t.body?.access_token;
    if (t.r.status !== 200 || !token) { out.error = `The token request was refused (${t.r.status}).`; return out; }
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
    const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const i = await record(s.steps, 8, 'initialize, now with the token', s.mcpUrl, { method: 'POST', headers: auth, body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: p.name, version: 'sim' } }) });
    const sid = i.r.headers.get('mcp-session-id');
    const h2 = { ...auth, ...(sid ? { 'mcp-session-id': sid } : {}) };
    await go(s.mcpUrl, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const list = await record(s.steps, 9, 'tools/list', s.mcpUrl, { method: 'POST', headers: h2, body: rpc(2, 'tools/list') }, `${p.name} shows these tools to its model.`);
    const tools = list.body?.result?.tools ?? [];
    // The platform's model would pick the tool for "How many points do I have?". Here: the first tool whose description mentions points.
    const pick = tools.find((x) => /points/i.test(x.description ?? '')) ?? tools[0];
    if (!pick) { out.error = 'The server listed no tools.'; return out; }
    const call = await record(s.steps, 10, `tools/call ${pick.name}`, s.mcpUrl, { method: 'POST', headers: h2, body: rpc(3, 'tools/call', { name: pick.name, arguments: {} }) }, `Asked "How many points do I have?". In ${p.name} its model picks the tool; here the pick is fixed (the first tool about points).`);
    let rec = null;
    try { rec = JSON.parse(String(call.body?.result?.content?.[0]?.text ?? '')); } catch { /* not JSON */ }
    if (rec && (rec.points ?? rec.loyaltyPoints) !== undefined) out.points = { points: rec.points ?? rec.loyaltyPoints, tier: rec.tier ?? rec.loyaltyTier, passenger: rec.passenger };
    else out.error = call.body?.result?.content?.[0]?.text ? String(call.body.result.content[0].text).slice(0, 200) : `The tool call failed (${call.r.status}).`;
    return out;
  }

  return { start, finish };
}

// private_key_jwt (RFC 7523): a short JWT naming the client, signed with the client's key. aud = the authorization server's issuer and
// typ = client-authentication+jwt are what PingFederate 13.1 requires (it refuses aud = token endpoint and typ JWT); what ChatGPT itself
// sends is not confirmed.
function clientAssertion(signer, clientId, audience) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', typ: 'client-authentication+jwt', kid: signer.kid })}.${enc({ iss: clientId, sub: clientId, aud: audience, jti: rand(16), iat: now, exp: now + 300 })}`;
  return `${head}.${signData('RSA-SHA256', Buffer.from(head), signer.privateKey).toString('base64url')}`;
}

// Tokens and codes never go to the page.
function redact(v) {
  if (!v || typeof v !== 'object') return v;
  const o = Array.isArray(v) ? [...v] : { ...v };
  for (const k of Object.keys(o)) {
    if (['access_token', 'refresh_token', 'id_token', 'code', 'client_secret'].includes(k)) o[k] = '(hidden)';
    else if (o[k] && typeof o[k] === 'object') o[k] = redact(o[k]);
  }
  return o;
}
