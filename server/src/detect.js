// Muse-detect: a DaVinci-shaped flow, run before the Privilege checks. It is a stub. The real DaVinci flow is not
// reached from here, and nothing in this file calls out.
export const BURST_WINDOW_MS = 60_000;
export const BURST_MAX = 6;

// Fixed patterns only (no user-supplied regex), so there is no ReDoS surface.
const INSTRUCTION = /ignore (all |any |your )?(previous|prior|above) (instructions|rules)|disable (the )?(guard|check|detection)|reveal (the )?system prompt/i;

export function runDetectionFlow({ ws, args = {}, now = Date.now() }) {
  const recent = ws.calls.filter((t) => now - t < BURST_WINDOW_MS).length;
  const burst = recent >= BURST_MAX;
  const injected = INSTRUCTION.test(JSON.stringify(args));

  const signals = [];
  if (burst) signals.push('burst');
  if (injected) signals.push('injected-instruction');

  return {
    verdict: injected ? 'block' : burst ? 'step_up' : 'allow',
    signals,
    steps: [
      { node: 'velocity', result: burst ? 'flag' : 'pass' },
      { node: 'instruction-check', result: injected ? 'block' : 'pass' },
    ],
  };
}
