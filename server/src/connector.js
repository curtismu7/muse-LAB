// The Airline Connector: Personal Agent's server as a custom connector for other agents (for example Meta's Muse at muse.ai, ChatGPT, Claude). Standard MCP over HTTP with OAuth:
//   agent -> /mcp (401 + metadata) -> /connector/authorize -> PingOne (the same DaVinci flow: login, Protect, agent-detected, consent)
//   -> /connector/callback (Personal Agent does the on-behalf-of exchanges) -> /connector/token -> agent calls /mcp with the token.
// Personal Agent is both the OAuth authorization server the agent talks to and the MCP server. The tools it serves are a fixed list,
// answered by calling the gateway with the delegated token. Nothing here is on unless MUSE_CONNECTOR=1 and real mode is configured.
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { callGateway, delegate, exchangeCode, piflowFor, refreshWithPingOne, startSignIn } from './liveauth.js';
import { createRefreshStore, newRefreshToken, REFRESH_FAMILY_CAP } from './refreshStore.js';
import { SELF_MARK, simKeyOf } from './platforms.js';
import { bookingTool, classifyBooking } from './booking.js';
import { DESTINATION_MAX, OPEN_FARE_FLIGHT, OPEN_FARE_MAX, PREMIUM_THRESHOLD, RULES, fareFor, flightById, flightForDestination, flightId as flightIdOf, listFlights, validAmount } from './fares.js';

const b64u = (b) => b.toString('base64url');
const rand = (n = 32) => b64u(randomBytes(n));
const schema = { type: 'object', properties: {}, additionalProperties: false };
const FLIGHT_ID_MAX = 16;
// With an airline named (MUSE_CONNECTOR_AIRLINE), the tool descriptions say whose points these are, so an agent with two airline connectors can tell them apart.
export const toolsFor = (airline) => [
  { name: 'loyalty_balance', description: airline ? `The member's ${airline} points balance and tier. Use it for ${airline} points only.` : "The member's airline points balance and tier.", inputSchema: schema },
  { name: 'get_loyalty_status', description: airline ? `The member's ${airline} loyalty status: tier, points and account status. Use it for ${airline} only.` : "The member's loyalty status: tier, points and account status.", inputSchema: schema },
  {
    name: 'list_flights', description: airline ? `Lists the ${airline} flights that can be booked: flight id, route and fare in US dollars. Call it before book_flight. Read-only.` : 'Lists the flights that can be booked: flight id, route and fare in US dollars. Call it before book_flight. Read-only.', inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'book_flight',
    description: `Books one ${airline ? `${airline} ` : ''}flight for the signed-in member. Say where to (destination), the price in US dollars the member wants to pay or is paying (amount), or a flight id from list_flights (flightId); give at least one. When amount is given, that price is what is booked and judged, and it takes precedence over the airline's listed fare. With only a destination or a flightId, the airline's listed fare is used. Authorization rules (the member's spending limit for AI agents, premium-only fares) may deny or hold the booking; the result says which, and nothing is booked unless it says Booked. You do NOT need a route, origin, travel date, passenger name or payment details: this demo books at once from just a price or a destination, so do not ask the member for them. Call this tool as soon as the member gives a price or a destination.`,
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', maxLength: DESTINATION_MAX, description: 'Where the member wants to fly to: a city (for example London), a 3-letter airport code (LHR) or a route (AUS-LHR). list_flights shows the destinations the airline lists.' },
        amount: { type: 'number', exclusiveMinimum: 0, maximum: OPEN_FARE_MAX, description: "The price in US dollars that the member wants to pay or is paying, for example 450 or 620.50 (at most 2 decimal places). Use it whenever the member names a price: it takes precedence over the airline's listed fare." },
        flightId: { type: 'string', maxLength: FLIGHT_ID_MAX, description: 'A flight id from list_flights, for example SH101. Only needed when the member names a flight id.' },
      },
      anyOf: [{ required: ['destination'] }, { required: ['amount'] }, { required: ['flightId'] }],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

// list_flights: the fixed, invented catalogue. No gateway call.
export const flightsResult = () => ({ content: [{ type: 'text', text: JSON.stringify({ currency: 'USD', flights: listFlights().map((f) => ({ flightId: f.id, route: f.route, city: f.city, fare: f.fare })) }) }], isError: false });

const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
// Gateway-supplied words (a rule code, a tier, a reference) reach the agent only after they are cut down to plain, short text.
const plain = (v, n = 40) => String(v ?? '').replace(/[^\w .:-]/g, '').trim().slice(0, n);
// The flight id the caller named, or null: a string, short, and in the catalogue. Nothing else is ever sent to the gateway.
export const validFlight = (args) => {
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args.flightId : undefined;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > FLIGHT_ID_MAX) return null;
  const id = flightIdOf(raw);
  return fareFor(id) === null ? null : id;
};

const usd = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const destinationList = () => listFlights().map((f) => `${f.city} (${f.route.split('-')[1]}) $${usd(f.fare)}`).join(', ');
const HOW_TO = () => `Give a destination or a price in US dollars (for example amount 450), or both. Destinations: ${destinationList()}. Nothing was booked.`;
// What a book_flight call asks for, from its arguments, or { error } (no gateway call). The price judged is either one the caller STATED (then the open-fare flight is booked at that price) or the airline's
// catalogue fare for the flight a destination or flightId names. A stated price takes precedence; a destination or flightId that also names a catalogue flight then only supplies the wording and the "airline lists" note.
export function resolveBooking(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const { destination, amount, flightId: fid } = a;
  if (destination !== undefined && (typeof destination !== 'string' || destination.length > DESTINATION_MAX)) return { error: `destination must be a city, airport code or route of at most ${DESTINATION_MAX} characters. ${HOW_TO()}` };
  if (fid !== undefined && (typeof fid !== 'string' || fid.length > FLIGHT_ID_MAX)) return { error: `flightId must be a flight id from list_flights, for example SH101. ${HOW_TO()}` };
  if (amount !== undefined && !validAmount(amount)) return { error: `amount must be a price in US dollars: a number above 0, at most ${OPEN_FARE_MAX}, with at most 2 decimals. Nothing was booked.` };
  const byId = typeof fid === 'string' && fid.trim() ? flightById(fid) : null;
  const byDest = flightForDestination(destination);
  if (byId && byDest && byId.id !== byDest.id) return { error: `destination ${plain(destination)} and flightId ${byId.id} name different flights. Give one of them. Nothing was booked.` };
  const named = byId ?? byDest;
  if (amount !== undefined) {
    const unlisted = !named && typeof destination === 'string' && destination.trim() ? plain(destination) : undefined;
    return { plan: { flight: OPEN_FARE_FLIGHT, amount, source: 'stated', city: named?.city, listed: named?.fare, unlisted: unlisted || undefined } };
  }
  if (named) return { plan: { flight: named.id, amount: named.fare, source: 'catalogue', city: named.city, listed: named.fare } };
  const given = typeof destination === 'string' && destination.trim() ? `"${plain(destination)}" is not a destination this airline lists. ` : typeof fid === 'string' && fid.trim() ? `${plain(fid, 16)} is not a flight id this airline lists. ` : '';
  return { error: `${given}${HOW_TO()}` };
}
// The plain-words description of what was booked: "a flight to London for $620 (price as you stated it)".
const planWords = (plan, fare) => `a flight${plan.city ? ` to ${plan.city}` : ''} for $${usd(fare)} (${plan.source === 'stated' ? 'price as you stated it' : 'airline price'})`;
// The sentence for a stated price that differs from what the airline lists for the named destination, and for a destination the airline does not list.
export function planNote(plan) {
  if (plan?.source !== 'stated') return '';
  const parts = [];
  if (plan.listed !== undefined && plan.listed !== plan.amount) parts.push(`You asked for $${usd(plan.amount)}; the airline lists ${plan.city} at $${usd(plan.listed)}`);
  if (plan.unlisted) parts.push(`The airline does not list "${plan.unlisted}", so only your price was used`);
  return parts.join('. ');
}
export const withNote = (result, plan) => {
  const note = planNote(plan);
  if (!note) return result;
  const [first, ...rest] = result.content;
  const booked = !result.isError && /^Booked /.test(first.text);
  return { ...result, content: [{ type: 'text', text: booked ? `${first.text} ${note}${plan.listed !== undefined && plan.listed !== plan.amount ? '; booked at your price' : ''}.` : `${note}. ${first.text}` }, ...rest] };
};
// The gateway's own refusals of a stated price (the open-fare rule), in words an agent can act on. Authorize was not asked.
const OPEN_FARE_REFUSALS = {
  open_fare_untrusted: "The gateway would not take a stated price from this connector: it only does so for its trusted caller, and the connector's trusted-caller setting for the gateway is missing or wrong (see the README). Nothing was booked.",
  open_fare_bad_amount: 'The gateway did not accept the stated price (it must be above 0, at most 100000, with at most 2 decimals). Nothing was booked.',
  unknown_flight_fare: 'The gateway does not yet support booking at a stated price (the open fare is not in its data). Nothing was booked.',
  unknown_flight: 'The airline server does not support booking at a stated price yet. Nothing was booked.',
};

// The two Authorize statement codes for a missing or mismatched user consent (the signed-in user's may_act).
const CONSENT_CODES = ['no_user_consent', 'may_act_mismatch'];

// The consent bridge's trusted-caller secret (owner-approved 2026-11-09). Only a plain header value is accepted, so a bad value can never end up in a fetch error.
const bridgeSecretOf = (env) => { const v = typeof env.MUSE_GATEWAY_INTERNAL_SECRET === 'string' ? env.MUSE_GATEWAY_INTERNAL_SECRET.trim() : ''; return /^[\x21-\x7e]{1,512}$/.test(v) ? v : null; };
const plainId = (v) => (typeof v === 'string' && /^[\x21-\x7e]{1,128}$/.test(v) ? v : null);

// The pre-approval headers (they ride on the consent-bridge exception; the gateway decides, Muse only presents). The limit header is whole dollars as plain digits, at most 7 characters, above zero,
// and only ever a value PingOne returned for the signed-in user; anything else is dropped and the gateway's own default applies.
export const PREAPPROVED_HEADER = 'X-Hitl-Preapproved';
export const PREAPPROVED_VALUE = 'user-limit';
export const LIMIT_HEADER = 'X-Agent-Spend-Limit';
export const FACTS_TIMEOUT_MS = 2500;
export const limitHeaderValue = (v) => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v : '';
  return /^[1-9][0-9]{0,6}$/.test(s) ? s : null;
};

// The limit a deny statement itself reports (its payload), or undefined. Looked at only on the spend-limit statement. Never the audit trail's AgentSpendLimit parameter: Authorize reads the limit from the
// PingOne user, so that parameter may not be the one that denied the booking.
const numberish = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined);
export function statementLimit(statements) {
  for (const s of statements ?? []) {
    if (s?.code !== RULES.agentSpendLimit.code) continue;
    const p = s.payload;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const k of ['limit', 'agentSpendLimit', 'AgentSpendLimit', 'spendLimit', 'agentSpendLimitUsd']) { const n = numberish(p[k]); if (n !== undefined) return n; }
    }
    const m = typeof s.message === 'string' ? /\b(?:over your \$(\d{1,9}(?:\.\d{1,2})?) limit|limit (?:of|is) \$(\d{1,9}(?:\.\d{1,2})?))/i.exec(s.message) : null;
    const n = m ? numberish(m[1] ?? m[2]) : undefined;
    if (n !== undefined) return n;
  }
  return undefined;
}

// What muse.ai is told, from what the gateway answered. Booked only for HTTP 200 with booked true; every other path says nothing was booked or that no booking was confirmed.
export function bookingToolResult(bk, flight, { bridge = false, limit = null, plan = null } = {}) {
  const fare = typeof bk.fare === 'number' ? bk.fare : plan ? plan.amount : fareFor(flight);
  const stated = plan?.source === 'stated';
  const costs = stated ? `your stated price is $${usd(fare)}` : `${flight} costs $${fare}`;
  const what = stated ? 'the flight at your stated price' : flight;
  if (bk.status === 'booked') {
    const ref = plain(bk.confirmation, 60);
    return { content: [{ type: 'text', text: `Booked ${plan ? planWords(plan, fare) : `${flight} for $${fare}`}.${ref ? ` Booking reference: ${ref}.` : ''}` }], isError: false };
  }
  if (bk.status === 'denied') {
    const codes = (bk.evidence?.statements ?? []).map((s) => plain(s.code, 80)).filter(Boolean);
    const parts = [];
    // The number comes from the deny statement itself, else from what PingOne holds for this user (read in this call); never from the audit trail's AgentSpendLimit parameter. No source, no number.
    const shownLimit = statementLimit(bk.evidence?.statements) ?? (Number.isSafeInteger(limit) && limit > 0 ? limit : undefined);
    if (codes.includes(RULES.agentSpendLimit.code)) parts.push(`an AI agent cannot buy a ticket over your limit (${costs}; ${shownLimit !== undefined ? `your limit is $${shownLimit}` : 'your limit was not reported'})`);
    if (codes.includes(RULES.premiumOnly.code)) parts.push(`fares over $${PREMIUM_THRESHOLD} are for premium members only (${costs}; ${bk.facts?.memberTier ? `your member tier is ${plain(bk.facts.memberTier)}` : 'your member tier was not reported'})`);
    const consent = codes.some((c) => CONSENT_CODES.includes(c));
    const other = codes.filter((c) => c !== RULES.agentSpendLimit.code && c !== RULES.premiumOnly.code && !CONSENT_CODES.includes(c));
    if (consent) {
      return toolError(`Booking denied: you have not authorized this agent to act for you on bookings.${bridge ? '' : " The connector's consent bridge is not configured, so it cannot pass on the consent you gave at sign-in."}${parts.length ? ` The booking was also denied: ${parts.join(', and ')}.` : ''}${other.length ? ` The gateway also returned ${other.join(', ')}.` : ''} Nothing was booked.`);
    }
    if (parts.length) return toolError(`The booking was denied: ${parts.join(', and ')}.${other.length ? ` The gateway also returned ${other.join(', ')}.` : ''} Nothing was booked.`);
    return toolError(`The gateway did not allow this booking${other.length ? ` (${other.join(', ')})` : ''}. Nothing was booked.`);
  }
  if (bk.status === 'consent_pending') return toolError(`This booking is held for the member's approval. Nothing was booked yet. Do not book it again until the member has approved it.${bridge ? '' : " To let a booking within the member's limit skip this hold, the connector's trusted-caller setting for the gateway must be configured (see the README)."}`);
  if (bk.status === 'not_booked') return toolError(`The airline server did not book ${what}. Nothing was booked.`);
  const http = bk.evidence?.httpStatus;
  if (http === 401) return toolError('The gateway did not accept the connector\'s sign-in (HTTP 401). Nothing was booked. Reconnect the connector and try again.');
  return toolError(`The gateway's answer${Number.isInteger(http) ? ` (HTTP ${http})` : ''} could not be read as a booking. No booking was confirmed.`);
}
// The MCP server's own answer to a 200, worded for muse.ai. Items are plain text, at most 5, 4000 characters each. A token, a bearer value or a URL that carries an id never passes.
const PASS_ITEMS = 5;
const PASS_CHARS = 4000;
export const NOT_CONFIRMED = 'The airline system answered (not a confirmed booking):';
export const scrubAnswer = (t) => String(t)
  .replace(/\bBearer\s+[\w~+/.=-]{8,}/gi, 'Bearer [redacted]')
  .replace(/\b((?:refresh|access)_token["']?\s*[:=]\s*["']?)[\w~+/.=-]{8,}/gi, '$1[redacted]')
  .replace(/\b[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g, '[token]')
  .replace(/https?:\/\/[^\s"'<>)]*/gi, (u) => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[?#]|\/[\w-]{20,}/i.test(u) ? '<url>' : u));
// The text items of a gateway 200 (JSON-RPC result.content), or null when there is nothing readable to pass on.
export function answerItems(body) {
  const c = body && typeof body === 'object' && !Array.isArray(body) && !body.error ? body.result?.content : null;
  if (!Array.isArray(c)) return null;
  const items = c.filter((x) => x && typeof x === 'object' && (x.type === undefined || x.type === 'text') && typeof x.text === 'string' && x.text.trim() !== '').slice(0, PASS_ITEMS).map((x) => x.text);
  return items.length ? items : null;
}
// Returns null when the gateway's 200 has no readable content (the caller then falls back to bookingToolResult). booked true is the only thing that is ever called booked, and not when the server also flagged isError.
export function passThroughResult(bk, flight, body, redact = (x) => x, plan = null) {
  const items = answerItems(body);
  if (!items) return null;
  const isError = body.result.isError === true;
  const head = bk.status === 'booked' && !isError ? bookingToolResult(bk, flight, { plan }).content[0].text : NOT_CONFIRMED;
  return { content: [head, ...items.map((t) => scrubAnswer(redact(t)).slice(0, PASS_CHARS))].map((text) => ({ type: 'text', text })), isError };
}
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PENDING_MS = 10 * 60 * 1000;
const CODE_MS = 60 * 1000;
const TOKEN_MAX_S = 3600;
const CAP = 500;

// Public address: https, or http on loopback for a local run. Only the origin is kept.
export function connectorConfig(env, live) {
  if (env.MUSE_CONNECTOR !== '1' || !live?.idp?.clientSecret) return null;
  let pu;
  try { pu = new URL(env.MUSE_PUBLIC_URL ?? ''); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(pu.hostname);
  if (pu.protocol !== 'https:' && !(loopback && pu.protocol === 'http:')) return null;
  const hosts = (env.MUSE_CONNECTOR_REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  // A client the owner names up front, for agents that ask you to type a client id instead of registering.
  const staticUris = (env.MUSE_CONNECTOR_REDIRECT_URIS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const staticClient = env.MUSE_CONNECTOR_CLIENT_ID && staticUris.length ? { id: env.MUSE_CONNECTOR_CLIENT_ID, redirectUris: staticUris, name: 'Pre-registered agent' } : null;
  // Agents with their own PingOne app (MUSE_CONNECTOR_AGENTS, JSON), picked by the agent's callback host, so Protect and the PingOne screens can name them.
  // Their hosts are allowed to register too. An agent with no hosts (Codex, which calls back on loopback) is only picked from the directory Connect path, never by host.
  // A bad entry is dropped, and that agent falls back to Personal Agent's app.
  let agents = [];
  try { agents = JSON.parse(env.MUSE_CONNECTOR_AGENTS || '[]'); } catch { agents = []; }
  agents = (Array.isArray(agents) ? agents : []).filter((a) => a && typeof a.clientId === 'string' && a.clientId && typeof a.clientSecret === 'string' && a.clientSecret && (a.hosts === undefined || Array.isArray(a.hosts)))
    .map((a) => ({ name: String(a.name ?? 'Agent').slice(0, 40), clientId: a.clientId, clientSecret: a.clientSecret, hosts: (a.hosts ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean) }));
  for (const a of agents) for (const h of a.hosts) if (!hosts.includes(h)) hosts.push(h);
  // Base path support (lab-proxy serves the app under /agent-connect): origin plus the configured path.
  const basePath = pu.pathname.replace(/\/+$/, '');
  return { publicUrl: `${pu.origin}${basePath}`, hosts, staticClient, agents };
}

// The assistants a customer can connect from (the demo's "find the airline in your assistant, click Connect" path).
// Meta AI has no app directory, so it uses Personal Agent's own app through the Airline Connector; ChatGPT and Claude use their own apps.
// Returns the PingOne app (idp) for each; only names and keys ever leave the server.
export function assistantsFor(env, live) {
  const cfg = connectorConfig(env, live);
  if (!cfg) return [];
  const own = cfg.agents.map((a) => ({ key: a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: a.name, idp: { ...live.idp, clientId: a.clientId, clientSecret: a.clientSecret } }));
  return [...own, { key: 'meta-ai', name: 'Meta AI', idp: live.idp }];
}

// The PingOne app a sign-in uses: the agent's own when its callback host is listed (or when it is Personal Agent's stand-in callback for that platform), otherwise Personal Agent's.
const idpFor = (cfg, live, redirectUri) => {
  let h = '';
  try { h = new URL(redirectUri).hostname.toLowerCase(); } catch { /* no host, Personal Agent's app */ }
  const sim = simKeyOf(cfg.publicUrl, redirectUri);
  const a = sim ? cfg.agents.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === sim) : cfg.agents.find((x) => x.hosts.some((y) => h === y || h.endsWith(`.${y}`)));
  return a ? { ...live.idp, clientId: a.clientId, clientSecret: a.clientSecret } : live.idp;
};

const okRedirect = (uri, hosts, publicUrl) => {
  // Personal Agent's stand-in platform callbacks (/sim/<platform>/callback on its own address) may register too.
  if (publicUrl && simKeyOf(publicUrl, uri)) return true;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'http:' && loop) return true;
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return hosts.some((x) => h === x || h.endsWith(`.${x}`));
};

// Stored as plain JSON, written to a temp file and renamed so a crash cannot leave a half-written file.
function loadClients(file) {
  const clients = new Map();
  if (!file) return clients;
  try { for (const [id, c] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) clients.set(id, c); } catch { /* no file yet, or unreadable: start empty */ }
  return clients;
}
function saveClients(file, clients) {
  if (!file) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(clients)));
  renameSync(tmp, file);
}

function capped(map) { while (map.size >= CAP) map.delete(map.keys().next().value); }

export function mountConnector(app, { env, live, fetchImpl = fetch, userFacts = null, factsTimeoutMs = FACTS_TIMEOUT_MS, refreshCap = REFRESH_FAMILY_CAP }) {
  const cfg = connectorConfig(env, live);
  if (!cfg) return false;
  const PUBLIC = cfg.publicUrl;
  const signoutFirst = env.MUSE_CONNECTOR_SIGNOUT_FIRST === '1';
  const airline = (env.MUSE_CONNECTOR_AIRLINE ?? '').trim().slice(0, 40).replace(/[^\p{L}\p{N} .&'-]/gu, '');
  const TOOLS = toolsFor(airline);
  // Write-only: lives in this closure, never in cfg, a session, a step, a log line or a result.
  const bridgeSecret = bridgeSecretOf(env);
  const redact = (x) => (bridgeSecret ? String(x).split(bridgeSecret).join('[redacted]') : String(x));
  // Everything the gateway says (a rule code, a confirmation number) is scrubbed of the secret before it is worded for muse.ai, and the finished result is scrubbed again.
  const scrub = (v) => (typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v);
  if (env.MUSE_GATEWAY_INTERNAL_SECRET && !bridgeSecret) console.log('[connector] MUSE_GATEWAY_INTERNAL_SECRET ignored: it is not a plain header value');
  // Dynamic registrations. With MUSE_CLIENTS_FILE set they survive a restart: loaded here, and written after each registration.
  // Refresh tokens (opt-in): off means no refresh_token anywhere, in the metadata, a registration or a token answer, and a refresh_token grant is unsupported.
  const refreshOn = env.MUSE_CONNECTOR_REFRESH === '1';
  const refresh = refreshOn ? createRefreshStore({ maxHours: env.MUSE_CONNECTOR_REFRESH_MAX_HOURS, cap: refreshCap, onDrop: (f) => { for (const [k, v] of tokens) if (v.family === f.id) tokens.delete(k); } }) : null;
  const GRANTS = refreshOn ? ['authorization_code', 'refresh_token'] : ['authorization_code'];
  // A client may refresh unless its registration said it will not (a client saved before this setting existed has no grant list and is allowed).
  const mayRefresh = (client) => !client?.grants || client.grants.includes('refresh_token');
  const clients = loadClients(env.MUSE_CLIENTS_FILE);   // client_id -> { redirectUris, name, grants }
  const pending = new Map();   // our state -> { client, redirectUri, state, challenge, verifier, at }
  const codes = new Map();     // our code -> { token, client, redirectUri, challenge, at }
  const tokens = new Map();    // access token -> { delegated, actor, userId, exp, family }
  const hits = new Map();
  if (cfg.staticClient) clients.set(cfg.staticClient.id, { redirectUris: cfg.staticClient.redirectUris, name: cfg.staticClient.name, ...(refreshOn ? { grants: GRANTS } : {}) });

  // Public endpoints take no cookie, so they get their own small limiter (per address, and across everyone).
  const limit = (req, res, next) => {
    // Personal Agent's own platform runs (platforms.js) are not counted; the /api/sim/start route that starts them has its own per-visitor limit.
    if (req.get('x-muse-self') === SELF_MARK) return next();
    const now = Date.now(); const key = req.ip || 'x';
    for (const [k, v] of hits) { const f = v.filter((t) => now - t < 60000); if (f.length) hits.set(k, f); else hits.delete(k); }
    const mine = hits.get(key) ?? []; const all = [...hits.values()].reduce((n, v) => n + v.length, 0);
    if (mine.length >= 30 || all >= 300) return res.status(429).json({ error: 'slow_down' });
    hits.set(key, [...mine, now]); next();
  };
  const oauthErr = (res, status, error, description) => res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });

  // One line per request to the OAuth and MCP endpoints, so the owner can see what a real client sends. Shapes and hosts only: never codes, tokens, verifiers, assertions or secrets.
  const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return u ? '?' : null; } };
  const urlId = (v) => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : null; } catch { return null; } };
  const traceFields = (req) => {
    const b = req.body ?? {}; const q = req.query ?? {};
    if (req.path === '/connector/register') return { auth_method: b.token_endpoint_auth_method ?? null, grants: b.grant_types ?? null, redirect_hosts: Array.isArray(b.redirect_uris) ? b.redirect_uris.slice(0, 5).map(hostOf) : null, client_name: b.client_name ? String(b.client_name).slice(0, 60) : null };
    if (req.path === '/connector/authorize') return { client_id_is_url: urlId(q.client_id) !== null, client_id_url: urlId(q.client_id), redirect_host: hostOf(q.redirect_uri), pkce: q.code_challenge_method ?? null, response_type: q.response_type ?? null };
    if (req.path === '/connector/token') return { grant_type: b.grant_type ?? null, client_id_is_url: urlId(b.client_id) !== null, client_assertion: b.client_assertion_type ?? null, basic_auth: /^Basic /i.test(req.headers.authorization ?? ''), verifier: Boolean(b.code_verifier) };
    if (req.path === '/mcp') return { bearer: /^Bearer /i.test(req.headers.authorization ?? ''), rpc: [].concat(req.body ?? []).slice(0, 5).map((m) => m?.method ?? null) };
    return null;
  };
  app.use(['/connector/register', '/connector/authorize', '/connector/resume', '/connector/token', '/mcp'], (req, res, next) => {
    const path = req.baseUrl;
    res.on('finish', () => {
      const f = traceFields({ path, body: req.body, query: req.query, headers: req.headers });
      console.log(`[connector] ${req.method} ${path} -> ${res.statusCode} ${JSON.stringify({ ...f, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) })}`);
    });
    next();
  });

  // Discovery (RFC 9728, RFC 8414). Public documents, so a plain CORS header is fine.
  const open = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=60'); next(); };
  const prm = { resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: airline ? `${airline} Airline Connector` : 'Airline Connector' };
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], open, (req, res) => res.json(prm));
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], open, (req, res) => res.json({
    issuer: PUBLIC, authorization_endpoint: `${PUBLIC}/connector/authorize`, token_endpoint: `${PUBLIC}/connector/token`,
    registration_endpoint: `${PUBLIC}/connector/register`,
    response_types_supported: ['code'], grant_types_supported: GRANTS, code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  }));

  // Dynamic registration (RFC 7591) for redirect hosts the owner named, and for Personal Agent's own stand-in platform callbacks. Public clients with PKCE; no secrets issued.
  app.post('/connector/register', limit, express.json({ limit: '8kb' }), (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    // Hostnames only, so the owner can see what an agent asked for and decide whether to allow it.
    const hostsAsked = [...new Set(uris.slice(0, 5).map((u) => { try { return new URL(u).hostname; } catch { return '?'; } }))];
    if (!uris.length || uris.length > 5 || !uris.every((u) => okRedirect(u, cfg.hosts, PUBLIC))) { console.warn(`[connector] registration refused, redirect host not allowed: ${hostsAsked.join(', ')}`); return oauthErr(res, 400, 'invalid_redirect_uri', 'Every redirect URI must be https on an allowed host.'); }
    capped(clients);
    const id = `muse-${rand(12)}`;
    // refresh_token is granted only when the connector offers it and the client did not list grant types without it (a client that lists none is offered it).
    const asked = Array.isArray(req.body?.grant_types) ? req.body.grant_types.map(String) : null;
    const grants = refreshOn && (!asked || asked.includes('refresh_token')) ? GRANTS : ['authorization_code'];
    // With refresh off the grant list is not stored (only echoed below), so the saved file is as before and a later switch-on still lets this client refresh.
    clients.set(id, { redirectUris: uris, name: String(req.body?.client_name ?? 'Agent').slice(0, 60), ...(refreshOn ? { grants } : {}) });
    saveClients(env.MUSE_CLIENTS_FILE, clients);
    res.status(201).set('Cache-Control', 'no-store').json({ client_id: id, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: grants, response_types: ['code'], client_name: clients.get(id).name });
  });

  // The agent's browser lands here. Personal Agent validates the request, then sends the user to PingOne.
  app.get('/connector/authorize', limit, (req, res) => {
    const q = req.query;
    const client = clients.get(String(q.client_id ?? ''));
    // An unknown client or a redirect that does not match exactly never gets redirected anywhere.
    if (!client || !client.redirectUris.includes(String(q.redirect_uri ?? ''))) {
      let h = '?'; try { h = new URL(String(q.redirect_uri)).hostname; } catch { /* keep ? */ }
      console.warn(`[connector] authorize refused: ${client ? 'redirect does not match' : 'unknown client'} (redirect host ${h})`);
      return res.status(400).type('text').send('Unknown client or redirect address.');
    }
    const back = (error) => { const u = new URL(String(q.redirect_uri)); u.searchParams.set('error', error); if (q.state) u.searchParams.set('state', String(q.state)); return res.redirect(302, u.href); };
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request');
    // '.conn' on the login hint tells the PingOne flow this sign-in came through the Airline Connector, so its screens name it.
    const learned = { authorizeEndpoint: live.idp.authorizeEndpoint, tokenEndpoint: live.idp.tokenEndpoint, scopes: ['openid'] };
    const idp = idpFor(cfg, live, String(q.redirect_uri));
    // offline_access asks PingOne for a refresh token; only when refresh is on (PingOne issues one only if the app has the refresh grant).
    const r = startSignIn(learned, { clientId: idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }, null, { forceLogin: true, loginHint: idp.loginHint ? `${idp.loginHint}.conn` : null, scope: refreshOn ? 'openid offline_access' : null });
    capped(pending);
    // The user signs in on Personal Agent's own page, in the Sign in dialog (pi.flow): no redirect to a PingOne login page.
    const signin = `${PUBLIC}/connector/signin?flow=${r.state}`;
    pending.set(r.state, { client: String(q.client_id), redirectUri: String(q.redirect_uri), state: q.state ? String(q.state) : null, challenge: String(q.code_challenge), verifier: r.verifier, learned, idp, at: Date.now(), go: signin, authUrl: r.url });
    // Optional: clear any PingOne session in this browser first (demo only), so the consent step cannot hit userSessionMismatch.
    // PingOne sends the browser back to /connector/resume, which must be a registered post-logout redirect URI on the app.
    const signoff = signoutFirst ? String(learned.authorizeEndpoint ?? '').replace(/\/authorize$/, '/signoff') : '';
    if (signoff && signoff.endsWith('/signoff')) {
      const u = new URL(signoff); u.searchParams.set('client_id', idp.clientId); u.searchParams.set('post_logout_redirect_uri', `${PUBLIC}/connector/resume`);
      res.set('Set-Cookie', `muse_resume=${r.state}; Path=/connector; Max-Age=300; HttpOnly; SameSite=Lax${PUBLIC.startsWith('https:') ? '; Secure' : ''}`);
      return res.redirect(302, u.href);
    }
    res.redirect(302, signin);
  });

  // The browser is back from PingOne's sign-out. Continue to the sign-in that /connector/authorize prepared. The address comes from our own record, never from the request.
  app.get('/connector/resume', limit, (req, res) => {
    const id = /(?:^|; )muse_resume=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const p = id ? pending.get(id) : null;
    res.set('Set-Cookie', 'muse_resume=; Path=/connector; Max-Age=0');
    if (!p || !p.go || Date.now() - p.at > PENDING_MS) return res.status(400).type('text').send('Unknown or expired sign-in. Start again from the agent.');
    res.redirect(302, p.go);
  });

  // PingOne's answer: swap the code, act for the user, and give the agent our own one-time code. Returns where to send the browser: the agent's own redirect address.
  const finish = async (p, q) => {
    const back = (params) => { const u = new URL(p.redirectUri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (p.state) u.searchParams.set('state', p.state); return u.href; };
    if (q.error) return back({ error: 'access_denied' });
    try {
      const r = await exchangeCode(live, p.learned, { code: String(q.code ?? ''), verifier: p.verifier, client: { clientId: p.idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }, resource: null, clientSecret: p.idp.clientSecret }, fetchImpl);
      if (!r.token) return back({ error: 'server_error' });
      const d = await delegate(live, p.idp, r.token, fetchImpl);
      if (!d.token) return back({ error: 'server_error' });
      capped(codes);
      const code = rand(24);
      // PingOne's refresh token (if it issued one) stays here, server side: it rides in the code record to the token step and is never sent to any client.
      codes.set(code, { token: d.token, actor: plainId(p.idp.clientId), userId: plainId(d.claims?.sub), exp: d.claims?.exp ?? null, client: p.client, redirectUri: p.redirectUri, challenge: p.challenge, at: Date.now(), ...(refreshOn ? { p1Refresh: r.refreshToken ?? null, idp: p.idp, learned: p.learned } : {}) });
      return back({ code });
    } catch { return back({ error: 'server_error' }); }
  };

  // The sign-in page (the app's own /connector/signin, served with the rest of the web app) asks for the SDK config of the sign-in that /connector/authorize prepared...
  app.get('/connector/signin/config', limit, (req, res) => {
    const flow = String(req.query.flow ?? '');
    const p = pending.get(flow);
    if (!p || Date.now() - p.at > PENDING_MS) return res.status(400).set('Cache-Control', 'no-store').json({ error: 'Unknown or expired sign-in. Start again from the agent.' });
    res.set('Cache-Control', 'no-store').json({ agent: clients.get(p.client)?.name ?? null, piflow: piflowFor({ url: p.authUrl, state: flow }, p.learned, { clientId: p.idp.clientId, redirectUri: `${PUBLIC}/connector/callback` }) });
  });
  // ...and hands back the code (or the refusal) when the dialog is done. The answer is the agent's redirect address, which the page then opens. One use per state.
  app.post('/connector/signin/complete', limit, express.json({ limit: '8kb' }), async (req, res) => {
    const state = String(req.body?.state ?? '');
    const p = pending.get(state);
    pending.delete(state);
    if (!p || Date.now() - p.at > PENDING_MS) return res.status(400).set('Cache-Control', 'no-store').json({ error: 'Unknown or expired sign-in. Start again from the agent.' });
    const q = req.body?.error ? { error: String(req.body.error).slice(0, 60) } : { code: String(req.body?.code ?? '') };
    res.set('Cache-Control', 'no-store').json({ redirectTo: await finish(p, q) });
  });

  // How long an access token lasts: at most an hour, and never past the delegated token's own expiry.
  const ttlFor = (exp) => Math.max(60, Math.min(TOKEN_MAX_S, exp ? exp - Math.floor(Date.now() / 1000) : TOKEN_MAX_S));
  const transient = (status) => Number.isInteger(status) && (status >= 500 || status === 429 || status === 408);

  // The refresh_token grant. Public client: client_id must be sent and must be the client the token was issued to. Each token is used once and replaced; presenting a spent one
  // revokes the family (a retry within a few seconds gets the same answer again). The refresh itself is done against PingOne here, then the delegation is redone.
  // Nothing in a log line or an error below is ever a token: only fixed words.
  async function refreshGrant(b, res) {
    const clientId = String(b.client_id ?? ''); const presented = String(b.refresh_token ?? '');
    const refuse = (reason) => { console.log(`[connector] refresh refused: ${reason}`); return oauthErr(res, 400, 'invalid_grant', 'The refresh token is invalid, expired or revoked. Sign in again.'); };
    const unavailable = (reason) => { console.log(`[connector] refresh unavailable: ${reason}`); return oauthErr(res, 503, 'temporarily_unavailable', 'The sign-in service could not be reached. Try again shortly.'); };
    if (!clientId || !presented) { console.log('[connector] refresh refused: client_id and refresh_token are required'); return oauthErr(res, 400, 'invalid_request', 'client_id and refresh_token are required.'); }
    const first = refresh.classify(presented);
    if (first.kind === 'unknown') return refuse('unknown, expired or revoked');
    if (first.family.client !== clientId) return refuse('issued to another client');
    const fam = first.family;
    try {
      return await refresh.withLock(fam, async () => {
        // Looked at again inside the lock: a refresh that was ahead of this one has rotated the token by now.
        const st = refresh.classify(presented);
        if (st.kind === 'grace') { console.log('[connector] refresh ok (repeat answer within the grace time)'); return res.set('Cache-Control', 'no-store').json(st.response); }
        if (st.kind === 'reuse') { refresh.revoke(fam); return refuse('spent token presented again, sign-in revoked'); }
        if (st.kind !== 'current') return refuse('unknown, expired or revoked');
        const p1 = await refreshWithPingOne(live, fam.learned, { refreshToken: fam.p1Refresh, clientId: fam.idp.clientId, clientSecret: fam.idp.clientSecret }, fetchImpl);
        if (p1.kind === 'unavailable') return unavailable('PingOne did not answer');
        if (p1.kind === 'refused') { refresh.revoke(fam); return refuse('PingOne refused the refresh, sign-in revoked'); }
        // PingOne may have rotated its token: keep the new one now, before anything else can fail, or the next try would present a dead one.
        if (p1.refreshToken) fam.p1Refresh = p1.refreshToken;
        let d;
        try { d = await delegate(live, fam.idp, p1.token, fetchImpl); } catch { return unavailable('PingOne did not answer the token exchange'); }
        if (!d.token) {
          if (transient(d.steps.at(-1)?.response?.status)) return unavailable('PingOne could not do the token exchange');
          refresh.revoke(fam); return refuse('PingOne refused the token exchange, sign-in revoked');
        }
        const sub = plainId(d.claims?.sub);
        if (fam.userId && sub !== fam.userId) { refresh.revoke(fam); return refuse('the refreshed token is for another user, sign-in revoked'); }
        if (!refresh.alive(fam)) return refuse('revoked or expired while refreshing');
        const ttl = ttlFor(d.claims?.exp);
        capped(tokens);
        const access = rand(32);
        tokens.set(access, { delegated: d.token, actor: fam.actor, userId: fam.userId, exp: Date.now() + ttl * 1000, family: fam.id });
        const next = newRefreshToken();
        const answer = { access_token: access, token_type: 'Bearer', expires_in: ttl, scope: 'mcp', refresh_token: next };
        refresh.rotate(fam, presented, next, answer);
        console.log('[connector] refresh ok');
        return res.set('Cache-Control', 'no-store').json(answer);
      });
    } catch { return oauthErr(res, 500, 'server_error', 'The refresh could not be completed.'); }
  }

  // The agent trades our code for an access token. PKCE S256, one use, bound to the client and redirect. With refresh on it also trades a refresh token for a new access token.
  app.post('/connector/token', limit, express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    const b = req.body ?? {};
    if (refreshOn && b.grant_type === 'refresh_token') return refreshGrant(b, res);
    if (b.grant_type !== 'authorization_code') return oauthErr(res, 400, 'unsupported_grant_type', refreshOn ? 'Only authorization_code and refresh_token are supported.' : 'Only authorization_code is supported.');
    const c = codes.get(String(b.code ?? ''));
    codes.delete(String(b.code ?? ''));
    if (!c || Date.now() - c.at > CODE_MS) return oauthErr(res, 400, 'invalid_grant', 'The code is unknown or expired.');
    if (c.client !== String(b.client_id ?? '') || c.redirectUri !== String(b.redirect_uri ?? '')) return oauthErr(res, 400, 'invalid_grant', 'The client or redirect address does not match.');
    const verifierHash = createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url');
    if (!b.code_verifier || verifierHash !== c.challenge) return oauthErr(res, 400, 'invalid_grant', 'The code verifier does not match.');
    const ttl = ttlFor(c.exp);
    // A refresh token only when PingOne gave one for this sign-in (otherwise it is exactly the behaviour without refresh) and the client may have one.
    let family = null; let refreshToken;
    if (refreshOn) {
      if (c.p1Refresh && mayRefresh(clients.get(c.client))) {
        const f = refresh.issue({ client: c.client, userId: c.userId, actor: c.actor, idp: c.idp, learned: c.learned, p1Refresh: c.p1Refresh });
        family = f.family; refreshToken = f.token;
      } else console.log(`[connector] sign-in done without a refresh token (${c.p1Refresh ? 'the client did not ask for the refresh grant' : 'PingOne issued none: does the app have the refresh grant?'})`);
    }
    capped(tokens);
    const access = rand(32);
    tokens.set(access, { delegated: c.token, actor: c.actor, userId: c.userId, exp: Date.now() + ttl * 1000, ...(family ? { family: family.id } : {}) });
    res.set('Cache-Control', 'no-store').json({ access_token: access, token_type: 'Bearer', expires_in: ttl, scope: 'mcp', ...(refreshToken ? { refresh_token: refreshToken } : {}) });
  });

  // MCP over streamable HTTP, JSON responses only.
  const challenge = (res) => res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`).json({ error: 'unauthorized' });
  const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  // The gateway sits behind a load balancer and now and then drops a connection; one retry covers it (the sign-in and tool-list steps; a booking call that was sent is never repeated).
  async function askGateway(session, tool, args, extraHeaders = null) {
    const ask = () => callGateway(live, session.delegated, fetchImpl, { tool, args, extraHeaders });
    const steps = await ask().catch((e) => { console.log(redact(`[connector] gateway call failed once: ${e?.name}: ${e?.cause?.code ?? e?.message}`)); return ask(); });
    console.log(`[connector] gateway steps ${JSON.stringify(steps.map((x) => [x.n, x.skipped ? 'skipped' : x.response?.status ?? null]))}`);
    // When a step is refused, say why: the error text only (for example an audience mismatch), never a token or the rest of the body.
    for (const x of steps) {
      const b = x.response?.body; const why = typeof b === 'object' && b ? (b.error_description ?? b.error?.message ?? b.error) : null;
      if (x.response && x.response.status >= 400 && typeof why === 'string') console.log(redact(`[connector] gateway step ${x.n} refused: ${why.replace(/\s+/g, ' ').slice(0, 300)}`));
    }
    return steps;
  }
  // What PingOne holds for the signed-in user (the tier switch's allow-listed read), at most once per booking call, and never a reason to hold the booking: a slow, failed or refused read is "unknown".
  const factsFor = () => {
    const cache = new Map();
    return (userId) => {
      if (!cache.has(userId)) {
        const read = typeof userFacts === 'function' && typeof userId === 'string' ? Promise.resolve().then(() => userFacts(userId)).catch(() => null) : Promise.resolve(null);
        let t;
        const timer = new Promise((r) => { t = setTimeout(() => r(null), factsTimeoutMs); t.unref?.(); });
        cache.set(userId, Promise.race([read, timer]).finally(() => clearTimeout(t)).then((f) => (f && typeof f === 'object' ? f : { tier: null, limit: null })));
      }
      return cache.get(userId);
    };
  };
  // book_flight: the caller names a destination, a flight id, a price, or some of them (resolveBooking). With a stated price Muse books the open-fare flight at that price (the gateway accepts it only from this trusted
  // connector); otherwise it sends the catalogue flight plus the catalogue fare (never a caller value), which the gateway also sets from its own catalogue. The airline MCP server needs an amount to book.
  async function bookFlight(args, session) {
    const facts = factsFor();
    const { plan, error } = resolveBooking(args);
    if (error) return toolError(error);
    const flight = plan.flight;
    try {
      const tool = bookingTool(env);
      // The consent bridge (owner-approved 2026-11-09): the user accepted the "act for you" screen at sign-in, and a session holding a delegated token means they did. Only here, only with
      // the secret configured, and X-May-Act-Sub is always the actor app this session was signed in with (configured, never taken from the request).
      const bridge = bridgeSecret && session.actor ? { 'x-internal-gateway-secret': bridgeSecret, 'X-May-Act-Sub': session.actor } : null;
      // The pre-approval (same condition, same call, same gateway only): the gateway skips its human hold when the authoritative fare is within the user's limit. The limit is what PingOne holds
      // for the signed-in user (read now, never from a request); unknown means no limit header and the gateway's default applies. The gateway, not Muse, compares the fare with the limit.
      let limit = null;
      if (bridge) {
        bridge[PREAPPROVED_HEADER] = PREAPPROVED_VALUE;
        limit = limitHeaderValue((await facts(session.userId)).limit);
        if (limit) bridge[LIMIT_HEADER] = limit;
      }
      const steps = await askGateway(session, tool, { flight_number: flight, amount: plan.amount }, bridge);
      const step9 = steps.find((x) => x.n === 9);
      if (!step9) {
        const last = steps.at(-1);
        console.log(`[connector] book_flight ${flight} -> not sent (${last?.skipped ? 'origin not allowed' : last?.response?.status ?? 'no answer'})`);
        return toolError(`The booking was not sent: the gateway refused the sign-in or tool list${Number.isInteger(last?.response?.status) ? ` (HTTP ${last.response.status})` : ''}. Nothing was booked.${last?.response?.status === 401 ? ' Reconnect the connector and try again.' : ''}`);
      }
      if (step9.error) {
        console.log(`[connector] book_flight ${flight} -> no answer (${plain(step9.error, 40)})`);
        return toolError('The gateway did not answer the booking call in time. No booking was confirmed, so do not assume it was booked; check before trying again.');
      }
      const bk = classifyBooking(step9, { flightId: flight, quoted: plan.source === 'stated' ? plan.amount : undefined, tool });
      console.log(`[connector] book_flight ${flight} (${plan.source}) -> ${bk.status} (HTTP ${bk.evidence?.httpStatus ?? 'none'})`);
      const safe = scrub(bk);
      // The open-fare rule's own refusals (HTTP 403 with an error name, Authorize not asked) get their own plain message.
      const refusal = step9.response?.status === 403 && plan.source === 'stated' ? OPEN_FARE_REFUSALS[step9.response.body?.error] : undefined;
      if (refusal) return withNote(toolError(refusal), plan);
      // A 200 carrying content is the MCP server's own answer: muse.ai gets it (and only booked true is ever called booked).
      if (step9.response?.status === 200) { const through = passThroughResult(safe, flight, step9.response.body, redact, plan); if (through) return withNote(through, plan); }
      // The limit in a spend-limit denial: the deny statement's own number if it has one, else what PingOne holds for this user (read once per call, never waited on twice).
      const wantsLimit = safe.status === 'denied' && (safe.evidence?.statements ?? []).some((x) => x.code === RULES.agentSpendLimit.code) && statementLimit(safe.evidence.statements) === undefined;
      return withNote(bookingToolResult(safe, flight, { bridge: Boolean(bridgeSecret), limit: wantsLimit ? (await facts(session.userId)).limit : null, plan }), plan);
    } catch (e) { console.log(redact(`[connector] book_flight failed: ${e?.name}: ${e?.cause?.code ?? e?.message}`)); return toolError('The gateway could not be reached. No booking was confirmed, so do not assume it was booked.'); }
  }
  async function handle(msg, session) {
    const { id, method, params } = msg ?? {};
    if (method === 'initialize') return rpc(id, { protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: airline ? `${airline.toLowerCase().replace(/ +/g, '-')}-airline-connector` : 'airline-connector', version: '0.1.0' } });
    if (method === 'ping') return rpc(id, {});
    if (method === 'tools/list') return rpc(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, 'Unknown tool');
      if (name === 'list_flights') return rpc(id, flightsResult());
      if (name === 'book_flight') return rpc(id, scrub(await bookFlight(params?.arguments, session)));
      try {
        // Both tools read the airline passenger record (get_loyalty_status) through the gateway, so the balance and the status can never disagree.
        const steps = await askGateway(session, 'get_loyalty_status');
        const resp = steps.find((s) => s.n === 9)?.response;
        const content = resp?.status === 200 ? resp.body?.result?.content : null;
        if (Array.isArray(content) && content.length) {
          let d = null;
          try { d = JSON.parse(String(content[0].text ?? '')); } catch { /* fall through to the plain result */ }
          if (d && d.loyaltyPoints !== undefined) {
            const out = name === 'loyalty_balance'
              ? { points: d.loyaltyPoints, tier: d.loyaltyTier, passenger: d.name, matchedBy: d.matchedBy }
              : { passengerRef: d.passengerRef, passenger: d.name, loyaltyTier: d.loyaltyTier, loyaltyPoints: d.loyaltyPoints, matchedBy: d.matchedBy };
            return rpc(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false });
          }
          return rpc(id, { content: content.slice(0, 5).map((c) => ({ type: 'text', text: String(c.text ?? '').slice(0, 4000) })), isError: false });
        }
        return rpc(id, { content: [{ type: 'text', text: `The gateway did not allow or complete this call (${resp?.status ?? 'no answer'}).` }], isError: true });
      } catch (e) { console.log(`[connector] gateway call failed: ${e?.name}: ${e?.cause?.code ?? e?.message}`); return rpc(id, { content: [{ type: 'text', text: 'The gateway could not be reached.' }], isError: true }); }
    }
    return id === undefined ? null : rpcErr(id, -32601, 'Method not found');
  }
  app.post('/mcp', limit, express.json({ limit: '32kb' }), async (req, res) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    const session = m ? tokens.get(m[1]) : null;
    if (!session || Date.now() > session.exp) { if (m) tokens.delete(m[1]); return challenge(res); }
    const body = req.body;
    const msgs = Array.isArray(body) ? body.slice(0, 10) : [body];
    const out = [];
    for (const msg of msgs) { const r = await handle(msg, session); if (r) out.push(r); }
    if (!out.length) return res.status(202).end();
    res.set('Cache-Control', 'no-store').json(Array.isArray(body) ? out : out[0]);
  });
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  return { name: prm.resource_name, url: `${PUBLIC}/mcp`, authorizeUrl: `${PUBLIC}/connector/authorize`, tokenUrl: `${PUBLIC}/connector/token`, scope: 'mcp', clientId: cfg.staticClient?.id ?? null, redirectUri: cfg.staticClient?.redirectUris[0] ?? null, airline: airline || null, assistants: assistantsFor(env, live).map(({ key, name }) => ({ key, name })) };
}
