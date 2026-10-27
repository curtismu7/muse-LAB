// Privilege-shaped gateway: Muse-detect first, then the coarse tool check, then the fine business rule.
// The most restrictive answer wins: blocked beats held for approval, which beats allowed.
import { TOOLS } from './tools.js';
import { runDetectionFlow } from './detect.js';
import { assessCaller } from './protect.js';

export const PAYMENT_APPROVAL_LIMIT = 500;
export const EXPORT_ROW_CAP = 100;
export const DRAFT_BODY_CAP = 2000;

export function coarseCheck(persona, tool) {
  const allowed = TOOLS[tool].personas.includes(persona);
  return {
    result: allowed ? 'allow' : 'deny',
    rule: `${TOOLS[tool].label} is open to: ${TOOLS[tool].personas.join(', ')}`,
  };
}

export function fineCheck(tool, args = {}) {
  if (tool === 'payments.send') {
    const amount = Number(args.amount);
    const payee = String(args.payee ?? '').trim();
    if (!Number.isFinite(amount) || amount <= 0) return { result: 'deny', rule: 'Amount must be a positive number' };
    if (!payee || payee.length > 80) return { result: 'deny', rule: 'Payee is required (80 characters or fewer)' };
    if (amount > PAYMENT_APPROVAL_LIMIT) {
      return { result: 'step_up', rule: `Payments over ${PAYMENT_APPROVAL_LIMIT} need a person to approve` };
    }
    return { result: 'allow', rule: `Payments up to ${PAYMENT_APPROVAL_LIMIT} go straight through` };
  }
  if (tool === 'records.export') {
    const rows = Number(args.rows);
    if (!Number.isFinite(rows) || rows < 1) return { result: 'deny', rule: 'Rows must be at least 1' };
    if (rows > EXPORT_ROW_CAP) return { result: 'deny', rule: `Exports are capped at ${EXPORT_ROW_CAP} rows` };
    return { result: 'allow', rule: `Exports up to ${EXPORT_ROW_CAP} rows are allowed` };
  }
  if (tool === 'mail.draft') {
    const length = String(args.body ?? '').length;
    if (length > DRAFT_BODY_CAP) return { result: 'deny', rule: `Drafts are capped at ${DRAFT_BODY_CAP} characters` };
  }
  return { result: 'allow', rule: 'No business rule applies to this call' };
}

// Records the call on the workspace (for the burst check) and returns the decision. It does not run the tool.
// Protect and consent happen earlier, when the caller is authorized (see /api/authorize). The verdict rides in on the token.
export function decide(ws, { tool, args = {}, now = Date.now(), via = 'muse', protect = assessCaller(via) }) {
  const detect = runDetectionFlow({ ws, args, now });
  ws.calls.push(now);
  if (ws.calls.length > 50) ws.calls.splice(0, ws.calls.length - 50);

  const coarse = coarseCheck(ws.user, tool);
  const fine = coarse.result === 'allow' ? fineCheck(tool, args) : null;

  let outcome = 'allowed';
  if (protect.deny || detect.verdict === 'block' || coarse.result === 'deny' || fine?.result === 'deny') outcome = 'blocked';
  else if (detect.verdict === 'step_up' || fine?.result === 'step_up') outcome = 'held';

  return { outcome, protect, detect, coarse, fine };
}
