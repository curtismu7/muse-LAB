// Tool catalogue and personas. The coarse check (gateway.js) asks which personas may call a tool at all;
// the fine check asks whether this particular call passes the business rule.
export const PERSONAS = {
  staff: { name: 'Alex', title: 'Staff member' },
  finance: { name: 'Sam', title: 'Finance lead' },
};

export const TOOLS = {
  'calendar.read': { label: 'Read calendar', personas: ['staff', 'finance'], fields: [] },
  'mail.draft': { label: 'Draft email', personas: ['staff', 'finance'], fields: ['body'] },
  'payments.send': { label: 'Send payment', personas: ['finance'], fields: ['payee', 'amount'] },
  'records.export': { label: 'Export records', personas: ['finance'], fields: ['rows'] },
};

// Simulated results. Nothing leaves the process: no mail, no payment, no export file.
export function runTool(tool, args = {}) {
  switch (tool) {
    case 'calendar.read':
      return { events: ['09:30 Pipeline review', '13:00 Vendor call', '16:00 Board prep'], simulated: true };
    case 'mail.draft':
      return { saved: true, words: String(args.body ?? '').split(/\s+/).filter(Boolean).length, simulated: true };
    case 'payments.send':
      return { queued: true, payee: String(args.payee ?? ''), amount: Number(args.amount), simulated: true, note: 'No money moves in this demo.' };
    case 'records.export':
      return { rows: Math.min(Number(args.rows) || 0, 100), simulated: true };
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}
