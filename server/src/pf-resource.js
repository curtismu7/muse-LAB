// The CIMD path: an MCP resource whose authorization server is a real PingFederate (13.1 or later, CIMD on).
// ChatGPT, Claude and Codex present a client ID metadata document there instead of registering. Muse serves labelled copies of those
// documents (the real ones name chatgpt.com and claude.ai callbacks Muse cannot receive at) and a JWKS for ChatGPT's private_key_jwt.
// /mcp-pf checks PingFederate's JWT (signature against PF's JWKS, iss, aud = this resource, exp, the scope), then answers from Muse's own
// demo record: on this path the airline gateway is not called (that leg runs on the PingOne path), and the answer says so.
// Only on when real mode is configured and MUSE_PF_ISSUER is set.
import express from 'express';
import { createPublicKey, generateKeyPairSync, verify as verifySig } from 'node:crypto';
import { toolsFor } from './connector.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const JWKS_TTL_MS = 10 * 60 * 1000;
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export function pfConfig(env, live) {
  if (!live || !env.MUSE_PF_ISSUER) return null;
  let issuer; let pub;
  try { issuer = new URL(env.MUSE_PF_ISSUER); pub = new URL(env.MUSE_PUBLIC_URL ?? ''); } catch { return null; }
  if (issuer.protocol !== 'https:' || (pub.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(pub.hostname))) return null;
  return { issuer: issuer.origin, publicUrl: pub.origin, scope: (env.MUSE_PF_SCOPE || 'muse:mcp').trim() };
}

// The documents as Muse serves them: the real platform's fields, with Muse's own client_id URL and callback.
export function clientDocuments(publicUrl) {
  const id = (k) => `${publicUrl}/sim/${k}/client.json`;
  const cb = (k) => [`${publicUrl}/sim/${k}/callback`];
  const note = 'Labelled copy for the Muse demo. The real document is at the address in x_real_document; its callbacks are on the platform\'s own host.';
  return {
    chatgpt: { client_id: id('chatgpt'), client_name: 'ChatGPT (Muse demo copy)', client_uri: 'https://chatgpt.com/', redirect_uris: cb('chatgpt'), token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], token_endpoint_auth_signing_alg: 'RS256', jwks_uri: `${publicUrl}/sim/chatgpt/jwks.json`, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], x_real_document: 'https://chatgpt.com/oauth/client.json', x_note: note },
    codex: { client_id: id('codex'), client_name: 'Codex (Muse demo copy)', client_uri: 'https://chatgpt.com/codex', application_type: 'native', redirect_uris: cb('codex'), token_endpoint_auth_method: 'none', token_endpoint_auth_methods_supported: ['none'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], x_real_document: 'https://chatgpt.com/oauth/codex/client.json', x_note: `${note} Real Codex calls back on the customer's loopback (http://127.0.0.1/callback, any port).` },
    claude: { client_id: id('claude'), client_name: 'Claude (Muse demo copy)', client_uri: 'https://claude.ai', redirect_uris: cb('claude'), token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], x_real_document: 'https://claude.ai/oauth/claude-code-client-metadata', x_note: `${note} Claude's web document address is not published; this copy follows Claude Code's.` },
  };
}

// ChatGPT signs its token request (private_key_jwt). The key lives only in this process; the public half is in /sim/chatgpt/jwks.json.
export function chatgptKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `muse-sim-${Date.now().toString(36)}`;
  return { privateKey, kid, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}

// A PingFederate access token: an RS256 JWT, checked against PF's published keys.
export async function checkPfToken(token, { issuer, resource, scope, getJwks }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, why: 'not a JWT' };
  let h; let c;
  try { h = b64json(parts[0]); c = b64json(parts[1]); } catch { return { ok: false, why: 'unreadable JWT' }; }
  if (h.alg !== 'RS256') return { ok: false, why: `algorithm ${String(h.alg).slice(0, 10)} not accepted` };
  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === h.kid);
  if (!jwk) return { ok: false, why: 'signing key not in PingFederate\'s JWKS' };
  const good = verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!good) return { ok: false, why: 'bad signature' };
  if (c.iss !== issuer) return { ok: false, why: 'wrong issuer' };
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(resource)) return { ok: false, why: 'not for this resource (aud)' };
  if (typeof c.exp !== 'number' || c.exp * 1000 < Date.now()) return { ok: false, why: 'expired' };
  const scopes = (Array.isArray(c.scope) ? c.scope : String(c.scope ?? '').split(' ')).filter(Boolean);
  if (!scopes.includes(scope)) return { ok: false, why: `missing scope ${scope}` };
  return { ok: true, claims: c };
}

export function mountPfResource(app, { env, live, fetchImpl = fetch, key }) {
  const cfg = pfConfig(env, live);
  if (!cfg) return null;
  const PUBLIC = cfg.publicUrl;
  const resource = `${PUBLIC}/mcp-pf`;
  const airline = (env.MUSE_CONNECTOR_AIRLINE ?? '').trim().slice(0, 40).replace(/[^\p{L}\p{N} .&'-]/gu, '');
  const TOOLS = toolsFor(airline);
  const docs = clientDocuments(PUBLIC);
  const open = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=60'); next(); };

  // PingFederate's keys, from its discovery document, cached for ten minutes.
  let jwks = { at: 0, keys: [] };
  const getJwks = async () => {
    if (Date.now() - jwks.at < JWKS_TTL_MS && jwks.keys.length) return jwks.keys;
    const d = await (await fetchImpl(`${cfg.issuer}/.well-known/openid-configuration`)).json();
    const k = await (await fetchImpl(d.jwks_uri)).json();
    jwks = { at: Date.now(), keys: Array.isArray(k.keys) ? k.keys : [] };
    return jwks.keys;
  };

  app.get('/sim/:k/client.json', open, (req, res) => (docs[req.params.k] ? res.type('application/json').send(JSON.stringify(docs[req.params.k])) : res.status(404).end()));
  app.get('/sim/chatgpt/jwks.json', open, (req, res) => res.json({ keys: [key.jwk] }));
  const prm = { resource, authorization_servers: [cfg.issuer], bearer_methods_supported: ['header'], scopes_supported: [cfg.scope], resource_name: airline ? `${airline} Airline Connector (PingFederate)` : 'Airline Connector (PingFederate)' };
  app.get('/.well-known/oauth-protected-resource/mcp-pf', open, (req, res) => res.json(prm));

  const challenge = (res, why) => res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp-pf"${why ? `, error="invalid_token", error_description="${why}"` : ''}`).json({ error: 'unauthorized', ...(why ? { detail: why } : {}) });
  const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
  app.post('/mcp-pf', express.json({ limit: '32kb' }), async (req, res) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return challenge(res);
    let r;
    try { r = await checkPfToken(m[1], { issuer: cfg.issuer, resource, scope: cfg.scope, getJwks }); } catch { return res.status(503).json({ error: 'PingFederate keys could not be read' }); }
    if (!r.ok) return challenge(res, r.why);
    const one = (msg) => {
      const { id, method, params } = msg ?? {};
      if (method === 'initialize') return rpc(id, { protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'airline-connector-pf', version: '0.1.0' } });
      if (method === 'tools/list') return rpc(id, { tools: TOOLS });
      if (method === 'tools/call') {
        if (!TOOLS.some((t) => t.name === params?.name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
        const who = String(r.claims.sub ?? 'member').slice(0, 60);
        const rec = { points: 52000, tier: 'Premier Gold', passenger: who, source: 'Muse demo record: on the PingFederate path the airline gateway is not called (that leg runs on the PingOne path).' };
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify(rec) }], isError: false });
      }
      if (method === 'ping') return rpc(id, {});
      return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    };
    const body = req.body;
    const out = (Array.isArray(body) ? body.slice(0, 10) : [body]).map(one).filter(Boolean);
    if (!out.length) return res.status(202).end();
    res.set('Cache-Control', 'no-store').json(Array.isArray(body) ? out : out[0]);
  });
  return { url: resource, issuer: cfg.issuer, scope: cfg.scope };
}
