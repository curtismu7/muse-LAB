// Simulated PingOne sign-in. The trace shows the pi.flow steps a real sign-in would take, including the DaVinci call.
// Nothing here talks to PingOne or DaVinci.
export function signInTrace(persona) {
  return [
    { node: 'pi.flow: start', result: 'ok' },
    { node: 'DaVinci: identify user (simulated)', result: 'ok' },
    { node: 'DaVinci: Muse-detect risk (simulated)', result: 'pass' },
    { node: `session issued for ${persona}`, result: 'ok' },
  ];
}
