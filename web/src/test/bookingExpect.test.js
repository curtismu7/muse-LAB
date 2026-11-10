// @vitest-environment node
import { describe, expect, it } from 'vitest';
// The server's rules are the authority for what a row should say; the page only words it. These tests pin the two together.
import { MEMBERS, PREMIUM_THRESHOLD, evaluateBooking, listFlights, mockMember } from '../../../server/src/fares.js';
import { deniedBy, expectFor, parseDollars } from '../bookingExpect.js';

const ROWS = [
  { n: 1, caller: 'agent', flight: 'SH103', member: 'standard' },
  { n: 2, caller: 'agent', flight: 'SH104', member: 'standard' },
  { n: 3, caller: 'agent', flight: 'SH106', member: 'standard' },
  { n: 4, caller: 'agent', flight: 'SH107', member: 'premium' },
  { n: 5, caller: 'human', flight: 'SH106', member: 'standard' },
  { n: 6, caller: 'human', flight: 'SH108', member: 'standard' },
  { n: 7, caller: 'human', flight: 'SH107', member: 'standard' },
  { n: 8, caller: 'human', flight: 'SH107', member: 'premium' },
  { n: 9, caller: 'agent', flight: 'SH107', member: 'standard' },
  { n: 10, caller: 'human', flight: 'SH107', member: 'none' },
];
const FARES = Object.fromEntries(listFlights().map((f) => [f.id, f.fare]));
const ctx = (r, limit) => ({ fare: FARES[r.flight], limit, threshold: PREMIUM_THRESHOLD });

describe('expectFor', () => {
  it('at the default limit it says exactly what the table always said', () => {
    const said = ROWS.map((r) => expectFor(r, ctx(r, 500)));
    expect(said).toEqual([
      'Allowed past both rules',
      'Allowed: exactly the limit passes',
      'Denied by your rule',
      'Denied by your rule, even for a premium member',
      'Allowed: your rule only limits agents',
      'Allowed: exactly $750 passes',
      'Denied by the airline rule',
      'Allowed: premium members can book over $750',
      'Denied by both rules',
      'Denied by the airline rule: no tier set is not premium',
    ]);
  });

  it('follows the limit: $1000 lets the agent rows through, $250 stops row 1', () => {
    const at = (limit) => Object.fromEntries(ROWS.map((r) => [r.n, expectFor(r, ctx(r, limit))]));
    expect(at(1000)[3]).toBe('Allowed past both rules');
    expect(at(1000)[4]).toBe('Allowed: premium members can book over $750');
    expect(at(1000)[9]).toBe('Denied by the airline rule');
    expect(at(250)[1]).toBe('Denied by your rule');
    expect(at(250)[5]).toBe('Allowed: your rule only limits agents');
    expect(at(620)[3]).toBe('Allowed: exactly the limit passes');
  });

  it('says nothing until the numbers are known', () => {
    expect(expectFor(ROWS[0], { fare: undefined, limit: 500, threshold: 750 })).toBe('');
    expect(expectFor(ROWS[0], { fare: 480, limit: undefined, threshold: 750 })).toBe('');
  });

  it('agrees with the server rules for every row, every flight and many limits', () => {
    const limits = [1, 179, 180, 250, 320, 479, 480, 499, 500, 501, 619, 620, 749, 750, 751, 939, 940, 1000, 100000];
    for (const caller of ['agent', 'human']) for (const member of Object.keys(MEMBERS)) for (const flight of Object.keys(FARES)) for (const limit of limits) {
      const row = { caller, member, flight };
      const server = evaluateBooking({ fare: FARES[flight], actor: caller, member: mockMember(member, limit) }).failed.map((r) => r.id).sort();
      expect(deniedBy(row, ctx(row, limit)).sort(), JSON.stringify(row) + limit).toEqual(server);
      const said = expectFor(row, ctx(row, limit));
      expect(said.startsWith('Denied'), JSON.stringify(row) + limit).toBe(server.length > 0);
    }
  });
});

describe('parseDollars', () => {
  it('accepts whole dollars 1 to 100000', () => {
    for (const t of ['1', '250', '500', '1000', '100000']) expect(parseDollars(t)).toEqual({ ok: true, n: Number(t) });
  });
  it('refuses everything else with a plain message', () => {
    for (const t of ['', '0', '-5', '12.5', '1e3', ' 500', '500 ', '+5', '٣', '1000000', '100001', '0500', 'NaN', 'abc', '5,000', '$500', null, undefined, 500, [], {}]) {
      const r = parseDollars(t);
      expect(r.ok, JSON.stringify(t)).toBe(false);
      expect(r.message.length).toBeGreaterThan(5);
    }
  });
});
