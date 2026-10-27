// Turns a typed request into one tool call, the same calls the prompt chips make. Anything it cannot map gets a short
// reply that says what Muse can do. Pure function: no network, no state.
const HELP = 'I can read your calendar, draft a note, send a payment, or export records. Try "pay Acme 800" or "export 25 rows".';

export function parseIntent(text) {
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

  const rows = t.match(/\bexport\D*(\d+)/i);
  if (rows) return { tool: 'records.export', args: { rows: Number(rows[1]) }, label: t };

  if (/\b(calendar|meetings?|schedule|agenda)\b/i.test(t)) return { tool: 'calendar.read', args: {}, label: t };

  if (/\b(draft|email|note|write|message)\b/i.test(t)) return { tool: 'mail.draft', args: { body: t }, label: t };

  return { reply: HELP };
}
