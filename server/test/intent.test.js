import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../../web/src/intent.js';

test('payments are read from either word order', () => {
  assert.deepEqual(parseIntent('pay Acme 800').args, { payee: 'Acme', amount: 800 });
  assert.deepEqual(parseIntent('send $120 to Acme Supplies').args, { payee: 'Acme Supplies', amount: 120 });
  assert.equal(parseIntent('pay Acme 800').tool, 'payments.send');
});

test('a payment with no payee asks who to pay instead of guessing', () => {
  assert.match(parseIntent('pay 800').reply, /Who should I pay/);
});

test('exports, calendar and drafts map to their tools', () => {
  assert.deepEqual(parseIntent('export 25 rows').args, { rows: 25 });
  assert.equal(parseIntent('what is on my calendar').tool, 'calendar.read');
  assert.equal(parseIntent('draft a note to Pat').tool, 'mail.draft');
});

test('burst and an empty or unknown request are handled', () => {
  assert.equal(parseIntent('burst').burst, true);
  assert.match(parseIntent('').reply, /I can read your calendar/);
  assert.match(parseIntent('make me a sandwich').reply, /I can read your calendar/);
});

test('"book SH106" maps to the booking tool with the flight id only: a typed price is never an argument', () => {
  const i = parseIntent('book SH106');
  assert.equal(i.tool, 'flights.book');
  assert.deepEqual(i.args, { flightId: 'SH106' });
  assert.deepEqual(parseIntent('Book flight sh107').args, { flightId: 'SH107' });
  assert.match(parseIntent('book SH106 for 100').reply, /I can read your calendar/, 'a price after the flight is not understood, so it cannot be smuggled in');
  assert.match(parseIntent('book SH106').label, /book SH106/i);
});

// Natural phrases. The page passes the airline's flight list (GET /api/flights); a typed price only picks the flight whose listed fare equals it.
const FLIGHTS = [
  { id: 'SH101', route: 'AUS-DEN', city: 'Denver', fare: 180 },
  { id: 'SH103', route: 'AUS-BOS', city: 'Boston', fare: 480 },
  { id: 'SH105', route: 'AUS-HNL', city: 'Honolulu', fare: 500.01 },
  { id: 'SH106', route: 'AUS-LHR', city: 'London', fare: 620 },
  { id: 'SH109', route: 'AUS-SFO', city: 'San Francisco', fare: 750.01 },
];

test('the help text speaks in natural phrases, not flight ids', () => {
  const help = parseIntent('make me a sandwich').reply;
  assert.match(help, /book a flight to London/);
  assert.match(help, /book a flight for 620/);
  assert.doesNotMatch(help, /SH\d{3}/);
});

test('"book a flight to London" and its variants pick the flight by destination (city, airport code or route, any case)', () => {
  for (const text of ['book a flight to London', 'Book me a flight to london', 'book flight to LHR', 'please book me the flight to AUS-LHR', 'book a ticket to  London ']) {
    const i = parseIntent(text, FLIGHTS);
    assert.equal(i.tool, 'flights.book', text);
    assert.deepEqual(i.args, { flightId: 'SH106' }, text);
    assert.equal(i.label, text.trim());
  }
  assert.deepEqual(parseIntent('book a flight to San Francisco', FLIGHTS).args, { flightId: 'SH109' });
});

test('"book a flight for 620" picks the flight listed at that price; the typed price is never an argument', () => {
  for (const text of ['book a flight for 620', 'Book me a flight for $620', 'book a flight at 620.00']) {
    const i = parseIntent(text, FLIGHTS);
    assert.deepEqual(i.args, { flightId: 'SH106' }, text);
    assert.deepEqual(Object.keys(i.args), ['flightId']);
  }
  assert.deepEqual(parseIntent('book a flight for $500.01', FLIGHTS).args, { flightId: 'SH105' });
});

test('a destination and a price together book only when the airline lists that price; otherwise a plain reply, no tool call', () => {
  assert.deepEqual(parseIntent('book a flight to Boston for $480', FLIGHTS).args, { flightId: 'SH103' });
  assert.deepEqual(parseIntent('book a flight for $480 to Boston', FLIGHTS).args, { flightId: 'SH103' });
  const diff = parseIntent('book me a flight to Denver for $450', FLIGHTS);
  assert.equal(diff.tool, undefined);
  assert.match(diff.reply, /Denver at \$180, not \$450/);
  assert.match(diff.reply, /Airline Connector books at a price you state/);
});

test('an unlisted destination or price, a missing flight list and a bare "book a flight" get a reply, never a guess', () => {
  assert.match(parseIntent('book a flight to Mars', FLIGHTS).reply, /does not list "Mars"/);
  assert.match(parseIntent('book a flight to Mars', FLIGHTS).reply, /London \$620/);
  assert.match(parseIntent('book a flight for 451', FLIGHTS).reply, /No listed flight costs \$451/);
  assert.match(parseIntent('book a flight to London').reply, /flight list/);
  assert.match(parseIntent('book a flight').reply, /Where to, or for how much/);
  assert.equal(parseIntent('book a flight to London', 'not a list').tool, undefined);
});

test('the older "book SH106" and "book flight SH107" forms are still recognised, with or without a flight list', () => {
  assert.deepEqual(parseIntent('book SH106', FLIGHTS).args, { flightId: 'SH106' });
  assert.deepEqual(parseIntent('book flight sh107').args, { flightId: 'SH107' });
});

test('hostile or huge input to the flight phrase is bounded', () => {
  const t0 = Date.now();
  const r = parseIntent(`book a flight to ${' '.repeat(50000)}x`, FLIGHTS);
  parseIntent(`book a flight for ${'9'.repeat(50000)}`, FLIGHTS);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.tool, undefined);
});
