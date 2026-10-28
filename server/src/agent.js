// Real Muse's brain: a local model (llama.cpp, OpenAI-compatible) picks ONE tool from a fixed list and writes the reply.
// The model never writes tool arguments and never sees a token. Anything it returns is checked before use, and if the model is
// off, slow or wrong, Muse falls back to keyword matching so the demo still runs. Off by default; never on a hosted build.
const TOOLS = [
  { name: 'loyalty_balance', description: 'The member\'s airline points balance and tier.' },
  { name: 'get_loyalty_status', description: 'The member\'s loyalty status: tier, points and passenger name.' },
];
const KEYWORDS = /point|mile|balance|loyal|tier|status/i;
const MAX_PROMPT = 300;
const DECLINE = 'I can only help with your airline points and loyalty status.';

export const agentTools = () => TOOLS.map((t) => ({ ...t }));

// MUSE_LLM_URL must be loopback (or listed in MUSE_LLM_ALLOW_HOSTS). Hosted builds never get a model.
export function agentConfig(env) {
  if (env.MUSE_HOSTED === '1' || !env.MUSE_LLM_URL) return null;
  let u;
  try { u = new URL(env.MUSE_LLM_URL); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  const allowed = (env.MUSE_LLM_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!loopback && !allowed.includes(u.hostname)) return null;
  return { endpoint: `${u.origin}/v1/chat/completions`, model: env.MUSE_LLM_MODEL || 'local', timeoutMs: Number(env.MUSE_LLM_TIMEOUT_MS) || 25000 };
}

async function chat(cfg, fetchImpl, messages, maxTokens) {
  const res = await fetchImpl(cfg.endpoint, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
  });
  if (res.status !== 200) throw new Error(`model answered ${res.status}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('model returned no text');
  return { text: text.slice(0, 2000), model: body.model ?? cfg.model };
}

const keywordPlan = (prompt, why) => ({ tool: KEYWORDS.test(prompt) ? 'loyalty_balance' : null, reply: KEYWORDS.test(prompt) ? null : DECLINE, via: 'keywords', note: why });

// Step 0: which tool, if any? The model answers JSON; we accept only a tool from our own list.
export async function plan(cfg, prompt, fetchImpl = fetch) {
  const p = String(prompt ?? '').slice(0, MAX_PROMPT);
  if (!cfg) return keywordPlan(p, 'No model configured, matched by keywords.');
  const system = 'You are Muse, a personal airline assistant. You can use exactly one tool, or none. Tools:\n'
    + TOOLS.map((t) => `- ${t.name}: ${t.description}`).join('\n')
    + '\nAnswer with JSON only, no other text: {"tool":"<tool name>"} or {"tool":"none","reply":"<one short sentence>"}. Choose "none" when the request is not about the member\'s airline points or loyalty status.';
  try {
    const { text, model } = await chat(cfg, fetchImpl, [{ role: 'system', content: system }, { role: 'user', content: p }], 80);
    const m = /\{[\s\S]*?\}/.exec(text);
    const parsed = m ? JSON.parse(m[0]) : null;
    const tool = parsed?.tool;
    // A decline uses a fixed sentence: a small model's own wording for "no" is not worth trusting.
    if (tool === 'none') return { tool: null, reply: DECLINE, via: 'llm', model };
    if (typeof tool === 'string' && TOOLS.some((t) => t.name === tool)) return { tool, reply: null, via: 'llm', model };
    return keywordPlan(p, 'The model did not name a tool Muse knows, matched by keywords.');
  } catch (e) {
    return keywordPlan(p, `The model could not be used (${String(e?.message ?? e).slice(0, 60)}), matched by keywords.`);
  }
}

// Normalise the two tools' results to the same small shape.
export function normaliseResult(text) {
  try {
    const j = JSON.parse(text);
    const d = j.data ?? j;
    const points = d.points ?? d.loyaltyPoints;
    const tier = d.tier ?? d.loyaltyTier;
    if (points === undefined) return null;
    return { points, tier, ...(d.name ? { name: d.name } : {}) };
  } catch { return null; }
}

const numbersIn = (s) => (String(s).match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, ''));
const template = (r) => `You have ${Number(r.points).toLocaleString('en-US')} points (${r.tier}).`;

// Last step: the model words the answer from the tool result. Every number in its reply must be in the result, else the plain sentence is used.
export async function reply(cfg, prompt, result, fetchImpl = fetch) {
  const plain = template(result);
  if (!cfg) return { text: plain, via: 'template' };
  try {
    const facts = JSON.stringify(result);
    const { text, model } = await chat(cfg, fetchImpl, [
      { role: 'system', content: 'You are Muse, a personal airline assistant. Answer the member in one or two plain sentences using only these facts. Do not add numbers that are not in the facts. Facts: ' + facts },
      { role: 'user', content: String(prompt ?? '').slice(0, MAX_PROMPT) },
    ], 90);
    const out = text.trim().replace(/\s+/g, ' ').slice(0, 400);
    const allowed = new Set(numbersIn(facts));
    if (!out || numbersIn(out).some((n) => !allowed.has(n))) return { text: plain, via: 'template', note: 'The model\'s wording included a number that is not in the result, so the plain answer was used.' };
    return { text: out, via: 'llm', model };
  } catch (e) {
    return { text: plain, via: 'template', note: `The model could not be used (${String(e?.message ?? e).slice(0, 60)}).` };
  }
}
