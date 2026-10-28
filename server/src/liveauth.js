// Steps 4 to 8 of the pattern against the real Agent Privilege: register Muse (RFC 7591), sign in (auth code + PKCE, RFC 8707
// resource), swap the code for a token, call the gateway with it. Owner-run only. The token stays on the server; the page
// sees the claims, never the token. Every request goes through one gate: allowed origin, no redirects, a timeout, a size cap.
import { createHash, randomBytes } from 'node:crypto';
import { readCapped, TIMEOUT_MS } from './discovery.js';

const b64u = (buf) => buf.toString('base64url');
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '0.1.0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

async function send(cfg, fetchImpl, { n, title, method, url, headers = {}, body, form, note }) {
  const u = new URL(url);
  if (!cfg.allow.has(u.origin)) return { step: { n, title, request: { method, url: u.href }, skipped: true, note: `Not contacted: ${u.origin} is not an allowed origin.` } };
  const res = await fetchImpl(u.href, {
    method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json, text/event-stream', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
  });
  const parsed = await readCapped(res);
  // The step shown to the page never carries a bearer token or a client secret.
  const shownReq = { method, url: u.href, ...(body ? { body } : {}), ...(form ? { form: Object.fromEntries(Object.entries(form).map(([k, v]) => [k, ['code_verifier', 'code', 'client_secret', 'subject_token', 'actor_token'].includes(k) ? '(sent)' : v])) } : {}) };
  const shownRes = parsed && typeof parsed === 'object' && parsed.access_token ? { ...parsed, access_token: '(held by Muse server)', refresh_token: parsed.refresh_token ? '(held by Muse server)' : undefined, id_token: parsed.id_token ? '(held by Muse server)' : undefined } : parsed;
  return { res, parsed, step: { n, title, request: shownReq, response: { status: res.status, headers: Object.fromEntries(['www-authenticate', 'content-type', 'mcp-session-id'].filter((h) => res.headers.get(h)).map((h) => [h, res.headers.get(h)])), body: shownRes }, note } };
}

export async function registerClient(cfg, learned, redirectUri, fetchImpl = fetch) {
  if (!learned?.registrationEndpoint) return { step: null, error: 'The authorization server offers no registration endpoint. Muse would need a client metadata document (CIMD), which this build does not publish.' };
  const r = await send(cfg, fetchImpl, {
    n: 4, title: 'Register Muse as a client', method: 'POST', url: learned.registrationEndpoint,
    body: { client_name: 'Muse (personal agent demo)', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    note: 'Dynamic client registration. Muse is a public client: PKCE, no secret.',
  });
  if (r.step.skipped) return { step: r.step, error: 'The registration endpoint is on an origin that is not allowed.' };
  const id = r.parsed?.client_id;
  if (r.res.status >= 300 || typeof id !== 'string') return { step: r.step, error: `Registration was refused (${r.res.status}).` };
  return { step: r.step, client: { clientId: id, redirectUri } };
}

export function startSignIn(learned, client, resource, { forceLogin = false, scope = null, loginHint = null } = {}) {
  const verifier = b64u(randomBytes(32));
  const state = b64u(randomBytes(16));
  const u = new URL(learned.authorizeEndpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, state, ...(resource ? { resource } : {}), ...(forceLogin ? { prompt: 'login' } : {}), ...(loginHint ? { login_hint: loginHint } : {}),
    code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    ...(scope ? { scope } : learned.scopes.includes('openid') ? { scope: 'openid' } : {}),
  }).toString();
  return { url: u.href, state, verifier };
}

function claimsOf(token) {
  const part = token.split('.')[1];
  if (token.split('.').length !== 3 || !part) return null;
  try {
    const c = JSON.parse(Buffer.from(part, 'base64url').toString());
    return { iss: c.iss, aud: c.aud, sub: c.sub, scope: c.scope ?? c.scp, exp: c.exp, ...(c.act ? { act: c.act } : {}), ...(c.protect_agent ? { protect_agent: c.protect_agent } : {}) };
  } catch { return null; }
}

export async function exchangeCode(cfg, learned, { code, verifier, client, resource, clientSecret }, fetchImpl = fetch) {
  const r = await send(cfg, fetchImpl, {
    n: 6, title: 'Swap the code for a token', method: 'POST', url: learned.tokenEndpoint,
    form: { grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: verifier, ...(clientSecret ? { client_secret: clientSecret } : {}), ...(resource ? { resource } : {}) },
    note: 'The token is held by the Muse server. This page only shows its claims.',
  });
  if (r.step.skipped) return { step: r.step, error: 'The token endpoint is on an origin that is not allowed.' };
  const token = r.parsed?.access_token;
  if (r.res.status !== 200 || typeof token !== 'string') return { step: r.step, error: `The token request was refused (${r.res.status}).` };
  const claims = claimsOf(token);
  const aud = claims ? [].concat(claims.aud ?? []) : [];
  const audOk = !resource || aud.some((a) => a === resource || a === new URL(resource).origin);
  return { step: { ...r.step, note: `${r.step.note} ${claims ? (!resource ? `Issued by PingOne for Muse (aud ${JSON.stringify(claims.aud)}).` : audOk ? 'The audience is the gateway.' : `The audience is ${JSON.stringify(claims.aud)}, not the gateway.`) : 'The token is opaque, so its audience cannot be read here.'}` }, token, claims, audOk };
}

export async function callGateway(cfg, token, fetchImpl = fetch, { tool = null } = {}) {
  const gw = cfg.idp ? 'Agent Gateway' : 'Agent Privilege';
  const auth = { authorization: `Bearer ${token}`, ...(cfg.idp ? { 'x-token-validation': 'jwks', 'mcp-protocol-version': '2025-06-18' } : {}) };
  const init = await send(cfg, fetchImpl, { n: 7, title: `Call ${gw} with the token`, method: 'POST', url: cfg.url, headers: auth, body: INIT, note: 'Same call as step 1, now with the bearer token.' });
  if (init.step.skipped) return [init.step];
  const steps = [init.step];
  if (init.res.status !== 200) return steps;
  const sid = init.res.headers.get('mcp-session-id');
  const list = await send(cfg, fetchImpl, { n: 8, title: `List the tools ${gw} lets Muse see`, method: 'POST', url: cfg.url, headers: { ...auth, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: LIST, note: `Tool-level authorization: ${gw} decides which tools this token may see.` });
  steps.push(list.step);
  if (tool && list.res?.status === 200) {
    const call = await send(cfg, fetchImpl, { n: 9, title: `Call ${tool}`, method: 'POST', url: cfg.url, headers: { ...auth, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: {} } }, note: 'Agent Gateway checks the token, PingOne Authorize decides, then the tool runs.' });
    steps.push(call.step);
  }
  return steps;
}

// Steps 6b to 6d: act on the user's behalf (RFC 8693). Muse gets its own actor token, then two exchanges. The first stamps
// act = Muse on a gateway-side resource; the second carries act on to the gateway's audience.
export async function delegate(cfg, idp, userToken, fetchImpl = fetch) {
  const base = { client_id: idp.clientId, client_secret: idp.clientSecret };
  const steps = [];
  const post = async (n, title, form, note) => {
    const r = await send(cfg, fetchImpl, { n, title, method: 'POST', url: idp.tokenEndpoint, form: { ...base, ...form }, note });
    const token = r.parsed?.access_token;
    steps.push({ ...r.step, ...(r.step.response ? { note: `${note}${token ? ` ${JSON.stringify(claimsOf(token) ?? {})}` : ''}` } : {}) });
    return r.res?.status === 200 && typeof token === 'string' ? token : null;
  };
  const TE = 'urn:ietf:params:oauth:grant-type:token-exchange', AT = 'urn:ietf:params:oauth:token-type:access_token';
  const actor = await post(6.1, 'Muse gets its own agent token', { grant_type: 'client_credentials', scope: idp.actorScope }, 'Who is acting: Muse itself.');
  if (!actor) return { steps, error: 'PingOne would not issue Muse an agent token.' };
  const first = await post(6.2, 'Exchange 1: Sam, with Muse acting', { grant_type: TE, subject_token: userToken, subject_token_type: AT, actor_token: actor, actor_token_type: AT, scope: idp.actorScope }, 'Same user, plus act = Muse (RFC 8693 delegation).');
  if (!first) return { steps, error: 'The first token exchange was refused.' };
  const second = await post(6.3, 'Exchange 2: for Agent Gateway', { grant_type: TE, subject_token: first, subject_token_type: AT, scope: idp.gatewayScope }, 'Audience becomes the gateway; act carries over.');
  if (!second) return { steps, error: 'The second token exchange was refused.' };
  return { steps, token: second, claims: claimsOf(second) };
}
