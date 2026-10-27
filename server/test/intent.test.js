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
