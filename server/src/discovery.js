// The 401 and discovery steps of the personal agent pattern. Muse calls Agent Privilege with no token, reads what the 401
// says, then reads the resource metadata (RFC 9728) and the authorization-server metadata (RFC 8414).
// Mock: static, no network. Live: owner-run, read-only GETs and one unauthenticated POST to the one configured gateway.
import { readFileSync } from 'node:fs';
const MAX_BYTES = 64 * 1024;
export const TIMEOUT_MS = 6000;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '0.1.0' } } };

const learnedFrom = (as) => ({
  authorizationServer: as.issuer ?? null,
  authorizeEndpoint: as.authorization_endpoint ?? null,
  tokenEndpoint: as.token_endpoint ?? null,
  registrationEndpoint: as.registration_endpoint ?? null,
  pkce: (as.code_challenge_methods_supported ?? []).includes('S256'),
  clientMetadataDocuments: as.client_id_metadata_document_supported === true,
  scopes: as.scopes_supported ?? [],
});

export function mockDiscovery() {
  const gw = 'https://aigateway.example';
  const as = {
    issuer: 'https://login.example', authorization_endpoint: 'https://login.example/authorize', token_endpoint: 'https://login.example/token',
    registration_endpoint: 'https://login.example/register', scopes_supported: ['openid', 'profile', 'tools:call'],
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true,
  };
  return {
    live: false,
    gateway: gw,
    steps: [
      { n: 1, title: 'Call Agent Privilege with no token', request: { method: 'POST', url: `${gw}/mcp`, body: INIT },
        response: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${gw}/.well-known/oauth-protected-resource/mcp"` }, body: { error: 'unauthorized' } },
        note: 'The 401 is the question. Its WWW-Authenticate header says where to learn how to sign in.' },
      { n: 2, title: 'Read the resource metadata', request: { method: 'GET', url: `${gw}/.well-known/oauth-protected-resource/mcp` },
        response: { status: 200, body: { resource: `${gw}/mcp`, authorization_servers: ['https://login.example'], bearer_methods_supported: ['header'] } },
        note: 'This names the authorization server Muse must use, and the audience the token must carry.' },
      { n: 3, title: 'Read the authorization-server metadata', request: { method: 'GET', url: 'https://login.example/.well-known/oauth-authorization-server' },
        response: { status: 200, body: as }, note: 'Endpoints, PKCE, and how Muse identifies itself. Next: Muse registers, the user signs in, and the token comes back with aud = the gateway.' },
    ],
    learned: learnedFrom(as),
  };
}

// Live mode needs ALLOW_LIVE=1 and MUSE_LIVE_GATEWAY_URL, and is never available on the hosted build.
export function liveConfig(env) {
  // MODE=mock is the mock-only build (rule 18): no live mode, whatever else is set.
  if (env.MODE === 'mock') return null;
  // Hosted builds stay mock-only unless the owner turns real mode on deliberately (MUSE_ALLOW_LIVE_HOSTED=1) and names the
  // public https address the PingOne return comes back to (or, with MUSE_ALLOW_LIVE_LOOPBACK=1, a loopback http address for local Docker).
  const hostedLive = env.MUSE_HOSTED === '1' && env.MUSE_ALLOW_LIVE_HOSTED === '1';
  if ((env.MUSE_HOSTED === '1' && !hostedLive) || env.ALLOW_LIVE !== '1' || !env.MUSE_LIVE_GATEWAY_URL) return null;
  let publicUrl = null;
  if (hostedLive) {
    try {
      const pu = new URL(env.MUSE_PUBLIC_URL ?? '');
      // Local Docker only: the owner may opt in (MUSE_ALLOW_LIVE_LOOPBACK=1) to a plain-http loopback address, which must be published on 127.0.0.1 only.
      const loopbackOk = env.MUSE_ALLOW_LIVE_LOOPBACK === '1' && pu.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(pu.hostname);
      if (pu.protocol !== 'https:' && !loopbackOk) return null;
      publicUrl = pu.origin;
    } catch { return null; }
  }
  let u;
  try { u = new URL(env.MUSE_LIVE_GATEWAY_URL); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:')) return null;
  const allow = new Set([u.origin]);
  for (const o of (env.MUSE_LIVE_ALLOW_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try { const ou = new URL(o); if (ou.protocol === 'https:') allow.add(ou.origin); } catch { /* ignore */ }
  }
  // Optional: sign in at PingOne instead of the gateway's own authorization server. Muse only redirects; PingOne runs the rest.
  let idp = null;
  if (env.MUSE_P1_ENV_ID && env.MUSE_P1_CLIENT_ID) {
    const base = `https://auth.pingone.${/^[a-z]{2,4}$/.test(env.MUSE_P1_REGION ?? '') ? env.MUSE_P1_REGION : 'com'}`;
    let clientSecret = env.MUSE_P1_CLIENT_SECRET ?? '';
    if (!clientSecret && env.MUSE_P1_CLIENT_SECRET_FILE) { try { clientSecret = readFileSync(env.MUSE_P1_CLIENT_SECRET_FILE, 'utf8').trim(); } catch { /* none */ } }
    const lane = env.MUSE_P1_LANE === 'privilege' ? 'privilege' : 'gateway';
    // gateway: Muse calls Agent Gateway directly. privilege: Muse calls an Agent Privilege app (token-pass) that fronts Agent Gateway.
    idp = { lane, loginHint: env.MUSE_P1_LOGIN_HINT ?? 'demouser', clientSecret, actorScope: env.MUSE_P1_ACTOR_SCOPE || 'agent:invoke', gatewayScope: env.MUSE_P1_GATEWAY_SCOPE || (lane === 'privilege' ? 'mcp:invoke' : 'gateway:mcp:invoke'), clientId: env.MUSE_P1_CLIENT_ID, userClientId: /^[0-9a-f-]{36}$/i.test(env.MUSE_USER_CLIENT_ID ?? '') ? env.MUSE_USER_CLIENT_ID : null, authorizeEndpoint: `${base}/${env.MUSE_P1_ENV_ID}/as/authorize`, tokenEndpoint: `${base}/${env.MUSE_P1_ENV_ID}/as/token`, issuer: `${base}/${env.MUSE_P1_ENV_ID}` };
    allow.add(base);
  }
  return { url: u.href, origin: u.origin, allow, idp, publicUrl };
}

export async function readCapped(res) {
  const text = await res.text();
  const body = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  try { return JSON.parse(body); } catch { return body.slice(0, 500); }
}

export async function liveDiscovery(cfg, fetchImpl = fetch) {
  const steps = [];
  const gw = cfg.idp?.lane === 'gateway' ? 'Agent Gateway' : 'Agent Privilege';
  const shown = (res) => Object.fromEntries(['www-authenticate', 'content-type'].filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)]));
  // Every request goes through one gate: https (or the configured loopback), an allowed origin, no redirects, a timeout.
  async function call(n, title, method, url, body, note) {
    let target = new URL(url);
    let observed;
    // Some gateways advertise an http:// metadata URL on a host that serves https. Same host only: upgrade, and say so.
    if (target.protocol === 'http:' && target.hostname === new URL(cfg.origin).hostname && new URL(cfg.origin).protocol === 'https:') {
      observed = `The gateway advertised ${url} (http). Muse used https on the same host.`;
      target = new URL(url.replace(/^http:/, 'https:'));
    }
    if (!cfg.allow.has(target.origin)) {
      steps.push({ n, title, request: { method, url: target.href }, skipped: true, note: `Not contacted: ${target.origin} is not an allowed origin. Add it to MUSE_LIVE_ALLOW_ORIGINS to follow it.` });
      return null;
    }
    const res = await fetchImpl(target.href, {
      method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: body ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = await readCapped(res);
    steps.push({ n, title, request: { method, url: target.href, ...(body ? { body } : {}) }, response: { status: res.status, headers: shown(res), body: parsed }, note: [note, observed].filter(Boolean).join(' ') });
    return { res, parsed };
  }
  const stop = (reason) => ({ live: true, gateway: cfg.origin, steps, learned: null, stopped: reason });

  const first = await call(1, `Call ${gw} with no token`, 'POST', cfg.url, INIT, 'The 401 is the question. Its WWW-Authenticate header says where to learn how to sign in.');
  if (!first) return stop('The Agent Privilege origin is not allowed.');
  if (first.res.status !== 401) return stop(`Expected a 401 with no token, got ${first.res.status}.`);
  const m = /resource_metadata="([^"]+)"/.exec(first.res.headers.get('www-authenticate') ?? '');
  if (!m) return stop('The 401 has no resource_metadata in WWW-Authenticate, so Muse cannot discover how to sign in.');

  const prm = await call(2, 'Read the resource metadata', 'GET', m[1], null, 'This names the authorization server Muse must use, and the audience the token must carry.');
  if (!prm) return stop('The resource metadata origin is not allowed.');
  const issuer = prm.parsed?.authorization_servers?.[0];
  if (prm.res.status !== 200 || typeof issuer !== 'string') return stop('The resource metadata did not name an authorization server.');

  const ai = new URL(issuer);
  const asUrl = `${ai.origin}/.well-known/oauth-authorization-server${ai.pathname === '/' ? '' : ai.pathname}`;
  const asr = await call(3, 'Read the authorization-server metadata', 'GET', asUrl, null, 'Endpoints, PKCE, and how Muse identifies itself.');
  if (!asr) return stop(`The authorization server (${ai.origin}) is on another origin and was not contacted.`);
  if (asr.res.status !== 200 || typeof asr.parsed !== 'object') return stop('The authorization-server metadata could not be read.');
  return { live: true, gateway: cfg.origin, steps, learned: learnedFrom(asr.parsed), stopped: null };
}
