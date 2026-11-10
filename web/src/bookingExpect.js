// Pure helpers for the Book a flight panel: the browser-side check of the agent-limit input, and what the scenario rows should say given the
// limit in force. The rules are the server's (fares.js evaluateBooking is the authority, and web/src/test/bookingExpect.test.js pins the two
// together); nothing here decides a booking, it only words the "Rules say" column.
export const DEFAULT_LIMIT_MIN = 1;
export const DEFAULT_LIMIT_MAX = 100000;

// Whole dollars typed by a person: ASCII digits only, no sign, decimals, spaces or leading zero. The server checks again.
export function parseDollars(text, min = DEFAULT_LIMIT_MIN, max = DEFAULT_LIMIT_MAX) {
  const t = typeof text === 'string' ? text : '';
  if (t === '') return { ok: false, message: 'Type a whole number of dollars.' };
  if (!/^[0-9]+$/.test(t)) return { ok: false, message: 'Digits only: whole dollars, no sign, decimals, spaces or letters.' };
  if (t.length > 1 && t.startsWith('0')) return { ok: false, message: 'No leading zero.' };
  const n = Number(t);
  if (n < min) return { ok: false, message: `The smallest limit is $${min}.` };
  if (n > max) return { ok: false, message: `The largest limit is $${max}.` };
  return { ok: true, n };
}

// Which rules deny a row. row: { caller: 'agent'|'human', member: 'premium'|'standard'|'none' }.
export function deniedBy(row, { fare, limit, threshold }) {
  const denied = [];
  if (row.caller === 'agent' && fare > limit) denied.push('agent_spend_limit');
  if (fare > threshold && row.member !== 'premium') denied.push('premium_only');
  return denied;
}

// The "Rules say" text for one row. At the default limit these are the ten sentences the table has always had.
export function expectFor(row, { fare, limit, threshold }) {
  if (!Number.isFinite(fare) || !Number.isFinite(limit) || !Number.isFinite(threshold)) return '';
  const d = deniedBy(row, { fare, limit, threshold });
  if (d.length === 2) return 'Denied by both rules';
  if (d[0] === 'agent_spend_limit') return fare > threshold ? 'Denied by your rule, even for a premium member' : 'Denied by your rule';
  if (d[0] === 'premium_only') return row.member === 'none' ? 'Denied by the airline rule: no tier set is not premium' : 'Denied by the airline rule';
  if (fare === threshold) return `Allowed: exactly $${threshold} passes`;
  if (fare > threshold) return `Allowed: premium members can book over $${threshold}`;
  if (row.caller === 'human' && fare > limit) return 'Allowed: your rule only limits agents';
  if (row.caller === 'agent' && fare === limit) return 'Allowed: exactly the limit passes';
  return 'Allowed past both rules';
}
