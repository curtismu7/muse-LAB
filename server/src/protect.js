// Protect: is the caller an agent (Muse) or a person using the browser?
// Mock (default): reads the channel the request declares, so the demo shows both paths. Nothing is sent anywhere.
// Live (owner-run, PROTECT_MODE=live): posts the request to a DaVinci flow built on the CIAM Plus Protect subflow, which
// creates a PingOne Protect risk evaluation. Refused in the hosted build. See docs/protect-davinci.md.
export const CHANNELS = ['muse', 'browser'];

const LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);
const TIMEOUT_MS = 5000;

export function assessCaller(via) {
  if (via === 'browser') {
    return { actor: 'human', mode: 'mock', signals: ['interactive browser session'], rule: 'Protect: a person is using the browser. No consent needed.' };
  }
  return { actor: 'agent', mode: 'mock', signals: ['agent client: Muse', 'no direct input from Sam in this request'], rule: 'Protect: the caller is Muse, an agent. Sam is asked to consent.' };
}

function liveConfig(env) {
  const url = new URL(env.PROTECT_FLOW_URL ?? '');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('PROTECT_FLOW_URL must be https (or loopback http)');
  if (!env.PROTECT_API_KEY) throw new Error('PROTECT_API_KEY is required for live Protect');
  if (!env.PROTECT_RISK_POLICY_ID) throw new Error('PROTECT_RISK_POLICY_ID is required for live Protect');
  return { url, apiKey: env.PROTECT_API_KEY, policyId: env.PROTECT_RISK_POLICY_ID };
}

// Returns { mode, assess(via, ctx) }. assess never throws: a failed live call fails closed (deny).
export function createProtect(env = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (env.PROTECT_MODE !== 'live') return { mode: 'mock', assess: async (via) => assessCaller(via) };
  if (env.MUSE_HOSTED === '1') throw new Error('live Protect is owner-run only: refused in the hosted build');
  const cfg = liveConfig(env);

  async function assess(via, { userName = '', sessionId = '', ipAddress = '127.0.0.1' } = {}) {
    const declared = via === 'browser' ? 'human' : 'agent';
    const body = {
      flowType: 'AUTHENTICATION',
      p1UserName: userName,
      p1ProtectRiskPolicyId: cfg.policyId,
      ipAddress,
      SessionId: sessionId,
      userAgent: declared === 'agent' ? 'Muse-Agent/1.0' : 'Mozilla/5.0 (browser)',
      customAttributes: JSON.stringify({ channel: via }),
    };
    try {
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sk-api-key': cfg.apiKey },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`flow answered ${res.status}`);
      const out = await res.json();
      const level = String(out.protectRiskLevel ?? '').toUpperCase();
      if (!LEVELS.has(level)) throw new Error('flow returned no risk level');
      const actor = out.caller === 'agent' || out.caller === 'human' ? out.caller : declared;
      const signals = [`Protect risk level: ${level}`, `recommended action: ${out.protectPredictor ?? 'none'}`];
      if (out.protectRiskEvalId) signals.push(`risk evaluation: ${out.protectRiskEvalId}`);
      if (level === 'HIGH') return { actor, mode: 'live', deny: true, signals, rule: 'Protect: risk is HIGH. The call is blocked.' };
      return {
        actor, mode: 'live', signals,
        rule: actor === 'agent' ? 'Protect: the caller is an agent. Sam is asked to consent.' : 'Protect: a person is using the browser. No consent needed.',
      };
    } catch (err) {
      return { actor: declared, mode: 'live', deny: true, signals: ['Protect unavailable'], rule: `Protect: no verdict (${err.message}). The call is blocked.` };
    }
  }
  return { mode: 'live', assess };
}
