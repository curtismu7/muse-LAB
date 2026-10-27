// Protect-shaped caller check: is the caller an agent (Muse) or a person using the browser?
// Simulated. The real check is a PingOne Protect risk evaluation inside a DaVinci flow (not called here). This stub reads
// the channel the request declares, so the demo can show both paths. Nothing is sent anywhere.
export const CHANNELS = ['muse', 'browser'];

export function assessCaller(via) {
  if (via === 'browser') {
    return { actor: 'human', signals: ['interactive browser session'], rule: 'Protect: a person is using the browser. No consent needed.' };
  }
  return { actor: 'agent', signals: ['agent client: Muse', 'no direct input from Sam in this request'], rule: 'Protect: the caller is Muse, an agent. Sam must consent first.' };
}
