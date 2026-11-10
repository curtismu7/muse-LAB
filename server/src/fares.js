// The fare catalogue and the two booking rules. The catalogue is display data for the page and the authority for the Mock decision:
// the caller never supplies the fare that is judged. Mock looks it up here by flight, the way PingGateway looks it up from its own
// read-only catalogue in Real. The rules below are what Mock stands in for; the names and codes are the ones the Authorize policy uses.
import { readFileSync } from 'node:fs';

const CATALOGUE = JSON.parse(readFileSync(new URL('./fares.json', import.meta.url), 'utf8'));
const BY_ID = new Map(CATALOGUE.flights.map((f) => [f.id, f]));

// The tool name Authorize's rules key on (the existing airline MCP tool), and the decision context they see.
export const BOOKING_TOOL_NAME = 'book_airline_flight';
export const BOOKING_CONTEXT = 'McpToolCall';
// The agent identity a Mock agent call carries (an invented host). A direct call carries none.
export const MOCK_AGENT_CLIENT = 'personal-agent.example';

// Rule A is the user's own preference; its number is per-user data (a member record), not part of the rule. Rule B is the airline's.
export const AGENT_LIMIT_DEFAULT = 500;
export const PREMIUM_THRESHOLD = 750;
// Where the member tier lives (owner decision 2026-11-09): a custom field on the PingOne user, user-schema attribute airlineMemberTier (STRING).
// In Real, PingOne Authorize reads it from the PingOne user itself; the gateway does not look it up or send it, and Muse never sees the user record.
export const TIER_ATTRIBUTE = 'airlineMemberTier';
export const TIER_SOURCE_REAL = `PingOne user attribute ${TIER_ATTRIBUTE} (read by Authorize)`;
export const TIER_SOURCE_MOCK = `Mock PingOne user (mimics the ${TIER_ATTRIBUTE} attribute)`;
export const TIER_NOT_SET = 'not set';
// Premium is an explicit list. Premier Silver, any other value, an empty value and a missing attribute are all NOT premium (fail closed).
// The owner does not care whether it is called Gold or premium; the demo user holds "Premier Gold" in the owner's tenant.
export const PREMIUM_TIERS = ['Premier Gold'];

export const RULES = {
  agentSpendLimit: { id: 'agent_spend_limit', name: 'MCP Deny — Agent Booking Over User Limit', code: 'mcp-airline-agent-spend-limit', owner: 'You', short: 'Your rule', line: (limit) => (limit === undefined ? 'No tickets bought by an AI agent over your limit' : `No tickets bought by an AI agent over $${limit}`) },
  premiumOnly: { id: 'premium_only', name: 'MCP Deny — Airline Premium-Only Over $750', code: 'mcp-airline-premium-only', owner: 'The airline', short: 'Airline rule', line: () => `Only premium members can book over $${PREMIUM_THRESHOLD}` },
};
export const RULE_BY_CODE = Object.fromEntries(Object.values(RULES).map((r) => [r.code, r]));

// The Mock member records. `tier` mimics the airlineMemberTier attribute on the PingOne user (Real: Authorize reads the real one; Mock has no tenant).
// `none` is a user with no airlineMemberTier at all: NOT premium. agentSpendLimit is the user's preference for rule A (gateway/data side).
export const MEMBERS = {
  standard: { key: 'standard', label: 'Standard', tier: 'Premier Silver', agentSpendLimit: AGENT_LIMIT_DEFAULT },
  premium: { key: 'premium', label: 'Premium', tier: 'Premier Gold', agentSpendLimit: AGENT_LIMIT_DEFAULT },
  none: { key: 'none', label: 'No tier set', agentSpendLimit: AGENT_LIMIT_DEFAULT },
};
export const tierLabel = (member) => (typeof member?.tier === 'string' && member.tier !== '' ? member.tier : TIER_NOT_SET);
export const memberFor = (key) => (typeof key === 'string' && Object.hasOwn(MEMBERS, key) ? MEMBERS[key] : null);
// The Mock member with the Mock agent limit applied (the card's "agent limit" control). limit: whole dollars, or null/undefined for the default.
// Falls back to the standard member for an unknown key. A limit that is not a positive integer is ignored (the default applies).
export const mockMember = (key, limit) => {
  const m = memberFor(key) ?? MEMBERS.standard;
  return Number.isSafeInteger(limit) && limit > 0 ? { ...m, agentSpendLimit: limit } : m;
};

// Only a string names a flight: an array or object that happens to print like one does not.
export const flightId = (id) => (typeof id === 'string' ? id.trim().toUpperCase() : '');

export function fareFor(id) {
  const f = BY_ID.get(flightId(id));
  return f ? f.fare : null;
}

export const listFlights = () => CATALOGUE.flights.map((f) => ({ ...f }));

// ---- Booking by destination or by price (the Airline Connector's book_flight) ----------------------------------------------------
// The open-fare flight: not in the catalogue. Its price is whatever is quoted, and only the trusted connector may quote it (the gateway enforces that).
export const OPEN_FARE_FLIGHT = 'SH000';
export const OPEN_FARE_MAX = 100000;
export const DESTINATION_MAX = 40;
// A stated price: a finite number above zero, at most 100000, at most two decimals. A string, an object, NaN or Infinity is never a price.
export const validAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= OPEN_FARE_MAX && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
// The catalogue flight a destination names: by city, by 3-letter airport code, or by route string, case-insensitive. Nothing fuzzier. null when it names none.
// Only a string of at most 40 characters can name a destination.
export function flightForDestination(dest) {
  if (typeof dest !== 'string' || dest.length > DESTINATION_MAX) return null;
  const d = norm(dest);
  if (!d) return null;
  return CATALOGUE.flights.find((f) => norm(f.city) === d || norm(f.route) === d || f.route.split('-')[1].toLowerCase() === d) ?? null;
}
export const flightById = (id) => { const f = BY_ID.get(flightId(id)); return f ? { ...f } : null; };

export const isPremium = (tier) => PREMIUM_TIERS.includes(tier);

// Both rules, both always evaluated, strictly "over" (exactly the limit passes). actor: 'agent' | 'human'.
// member: { tier, agentSpendLimit }. Returns every rule that failed, with the clause the page shows for it.
export function evaluateBooking({ fare, actor, member }) {
  const given = member?.agentSpendLimit;
  const limit = given !== '' && given !== null && given !== undefined && Number.isFinite(Number(given)) ? Number(given) : AGENT_LIMIT_DEFAULT;
  const tier = tierLabel(member);
  const failed = [];
  if (actor === 'agent' && fare > limit) failed.push({ ...RULES.agentSpendLimit, message: `fare $${fare} is over your $${limit} limit` });
  if (fare > PREMIUM_THRESHOLD && !isPremium(tier)) failed.push({ ...RULES.premiumOnly, message: `fare $${fare}; member tier ${tier}, from the ${TIER_SOURCE_MOCK}` });
  return { failed, decision: failed.length ? 'DENY' : 'PERMIT', limit, tier };
}
