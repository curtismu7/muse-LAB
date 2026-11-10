// Turns a typed request into one tool call, the same calls the prompt chips make. Anything it cannot map gets a short
// reply that says what Personal Agent can do. Pure function: no network, no state.
const HELP = 'I can read your calendar, draft a note, send a payment, export records, or book a flight. Try "pay Acme 800", "export 25 rows", "book a flight to London" or "book a flight for 620".';

// The flight a typed destination names, from the airline's flight list (the page loads it): a city, a 3-letter airport code or a route, case-insensitive.
const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const byDestination = (dest, flights) => {
  const d = norm(dest);
  return d ? flights.find((f) => norm(f.city ?? '') === d || norm(f.route ?? '') === d || norm(String(f.route ?? '').split('-')[1] ?? '') === d) ?? null : null;
};
const listed = (flights) => flights.filter((f) => f.city).map((f) => `${f.city} $${f.fare}`).join(', ');

// "book a flight to London", "book me a flight for 620", "book a flight to Denver for $450". The chat books through the Mock engine, which judges the airline's listed fare
// for a flight, so a typed price only picks the flight whose listed fare it equals: it is never sent as an argument. A price the airline does not list gets a plain reply.
function bookByWords(typed, flights) {
  const rest = typed.slice(0, 120); // bounded before any pattern runs on it
  const amountMatch = rest.match(/\b(?:for|at)\s+\$?(\d+(?:\.\d{1,2})?)\b/i);
  const amount = amountMatch ? Number(amountMatch[1]) : undefined;
  const destMatch = (amountMatch ? rest.replace(amountMatch[0], ' ') : rest).match(/\bto\s+(.+?)\s*$/i);
  const dest = destMatch?.[1];
  if (dest === undefined && amount === undefined) return { reply: 'Where to, or for how much? Try "book a flight to London" or "book a flight for 620". You do not need a route or a date.' };
  if (!flights.length) return { reply: 'I do not have the flight list yet. Try "book SH106" for now.' };
  const byCity = dest === undefined ? null : byDestination(dest, flights);
  if (dest !== undefined && !byCity) return { reply: `The airline does not list "${dest.slice(0, 40)}". It lists: ${listed(flights)}.` };
  if (byCity && (amount === undefined || amount === byCity.fare)) return { tool: 'flights.book', args: { flightId: byCity.id } };
  if (byCity) return { reply: `The airline lists ${byCity.city} at $${byCity.fare}, not $${amount}. This chat books at the airline's listed price; the Airline Connector books at a price you state.` };
  const byFare = flights.find((f) => f.fare === amount);
  if (byFare) return { tool: 'flights.book', args: { flightId: byFare.id } };
  return { reply: `No listed flight costs $${amount}. The airline lists: ${listed(flights)}. This chat books at the airline's listed price; the Airline Connector books at a price you state.` };
}

export function parseIntent(text, flights = []) {
  const t = text.trim();
  if (!t) return { reply: HELP };

  if (/\bburst\b|\bseven\b|\b7 calls\b/i.test(t)) return { burst: true };

  // "pay Acme 800" or "send $120 to Acme"
  const payFirst = t.match(/^(?:pay|send|transfer)\s+(?:to\s+)?(.+?)\s+\$?(\d+(?:\.\d+)?)$/i);
  const amountFirst = t.match(/^(?:pay|send|transfer)\s+\$?(\d+(?:\.\d+)?)\s+(?:to|for)\s+(.+)$/i);
  if (payFirst || amountFirst) {
    const payee = (payFirst?.[1] ?? amountFirst?.[2] ?? '').trim();
    const amount = Number(payFirst?.[2] ?? amountFirst?.[1]);
    if (!payee) return { reply: 'Who should I pay? Try "pay Acme 800".' };
    return { tool: 'payments.send', args: { payee, amount }, label: t };
  }

  if (/^(?:pay|send|transfer)\b/i.test(t) && /\d/.test(t)) return { reply: 'Who should I pay? Try "pay Acme 800".' };

  // "book SH106" or "book flight SH106" (the older form): the flight id only. The fare is looked up by the gateway, never typed.
  const flight = t.match(/^book\s+(?:flight\s+)?([a-z]{2}\d{3,4})$/i);
  if (flight) return { tool: 'flights.book', args: { flightId: flight[1].toUpperCase() }, label: t };

  const words = t.match(/^(?:please\s+)?book\s+(?:me\s+)?(?:a\s+|the\s+)?(?:flight|ticket)\b(.*)$/i);
  if (words) { const r = bookByWords(words[1], Array.isArray(flights) ? flights : []); return r.tool ? { ...r, label: t } : r; }

  const rows = t.match(/\bexport\D*(\d+)/i);
  if (rows) return { tool: 'records.export', args: { rows: Number(rows[1]) }, label: t };

  if (/\b(calendar|meetings?|schedule|agenda)\b/i.test(t)) return { tool: 'calendar.read', args: {}, label: t };

  if (/\b(draft|email|note|write|message)\b/i.test(t)) return { tool: 'mail.draft', args: { body: t }, label: t };

  return { reply: HELP };
}
