import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { agentConfig, normaliseResult, plan, reply } from '../src/agent.js';
import { createApp } from '../src/index.js';

const CFG = { endpoint: 'http://127.0.0.1:8090/v1/chat/completions', model: 'local', timeoutMs: 1000 };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const says = (text) => async () => json(200, { model: 'm1', choices: [{ message: { content: text } }] });

test('a model is only used when its address is loopback (or listed), never on a hosted build', () => {
  assert.equal(agentConfig({}), null);
  assert.equal(agentConfig({ MUSE_LLM_URL: 'http://127.0.0.1:8090' }).endpoint, 'http://127.0.0.1:8090/v1/chat/completions');
  assert.equal(agentConfig({ MUSE_LLM_URL: 'http://model.example:8090' }), null);
  assert.equal(agentConfig({ MUSE_LLM_URL: 'http://model.example:8090', MUSE_LLM_ALLOW_HOSTS: 'model.example' }).model, 'local');
  assert.equal(agentConfig({ MUSE_LLM_URL: 'http://127.0.0.1:8090', MUSE_HOSTED: '1' }), null);
  assert.equal(agentConfig({ MUSE_LLM_URL: 'file:///etc/passwd' }), null);
});

test('plan: the model picks a tool from Muse\'s list; text around the JSON is tolerated', async () => {
  const p = await plan(CFG, 'what are my miles', says('Sure! {"tool":"get_loyalty_status"} done'));
  assert.deepEqual([p.tool, p.via, p.model], ['get_loyalty_status', 'llm', 'm1']);
});

test('plan: a tool the model invents is refused and keywords decide', async () => {
  const p = await plan(CFG, 'show my points', says('{"tool":"transfer_money"}'));
  assert.equal(p.via, 'keywords'); assert.equal(p.tool, 'loyalty_balance'); assert.match(p.note, /did not name a tool/);
  const q = await plan(CFG, 'wire money to Rome', says('{"tool":"transfer_money"}'));
  assert.equal(q.tool, null);
});

test('plan: "none" declines with the model\'s short reply; a model that is down falls back to keywords', async () => {
  const d = await plan(CFG, 'book a flight', says('{"tool":"none","reply":"I can only help with your points."}'));
  assert.deepEqual([d.tool, d.reply, d.via], [null, 'I can only help with your airline points and loyalty status.', 'llm'], 'the model\'s own wording for no is not used');
  const down = await plan(CFG, 'my points', async () => { throw new Error('ECONNREFUSED'); });
  assert.deepEqual([down.tool, down.via], ['loyalty_balance', 'keywords']);
  const bad = await plan(CFG, 'my points', async () => json(500, {}));
  assert.equal(bad.via, 'keywords');
  const junk = await plan(CFG, 'my points', says('no json here'));
  assert.equal(junk.via, 'keywords');
});

test('plan: only the prompt and Muse\'s own tool list go to the model, and the prompt is capped', async () => {
  let sent;
  await plan(CFG, 'x'.repeat(1000), async (url, init) => { sent = JSON.parse(init.body); return json(200, { choices: [{ message: { content: '{"tool":"none"}' } }] }); });
  assert.equal(sent.messages[1].content.length, 300);
  assert.ok(!JSON.stringify(sent).toLowerCase().includes('bearer'));
  assert.match(sent.messages[0].content, /loyalty_balance/);
});

test('reply: wording by the model is used only if every number comes from the result', async () => {
  const result = { points: 4500, tier: 'Gold' };
  const ok = await reply(CFG, 'my points?', result, says('You have 4,500 points and Gold status.'));
  assert.deepEqual([ok.via, ok.text], ['llm', 'You have 4,500 points and Gold status.']);
  const made = await reply(CFG, 'my points?', result, says('You have 9,999 points.'));
  assert.equal(made.via, 'template'); assert.equal(made.text, 'You have 4,500 points (Gold).'); assert.match(made.note, /not in the result/);
  const none = await reply(null, 'my points?', result);
  assert.equal(none.text, 'You have 4,500 points (Gold).');
});

test('normaliseResult reads both tools\' shapes', () => {
  assert.deepEqual(normaliseResult('{"success":true,"data":{"points":4500,"tier":"Gold"}}'), { points: 4500, tier: 'Gold' });
  assert.deepEqual(normaliseResult('{"loyaltyTier":"Premier Gold","loyaltyPoints":20320,"name":"J R"}'), { points: 20320, tier: 'Premier Gold', name: 'J R' });
  assert.equal(normaliseResult('not json'), null);
});

const GW = 'https://gw.example/pft/mcp';
const P1 = 'https://auth.pingone.com/env1/as';
const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
function net(modelSays) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).startsWith('http://127.0.0.1:8090')) return json(200, { model: 'm1', choices: [{ message: { content: modelSays(JSON.parse(init.body)) } }] });
    if (String(url) === GW) {
      if (!init.headers.authorization) return json(401, {}, { 'www-authenticate': 'Bearer resource_metadata="https://gw.example/.well-known/oauth-protected-resource/pft/mcp"' });
      const m = JSON.parse(init.body);
      if (m.method === 'tools/call') return json(200, { result: { content: [{ type: 'text', text: JSON.stringify(m.params.name === 'get_loyalty_status' ? { loyaltyTier: 'Premier Gold', loyaltyPoints: 20320 } : { data: { points: 4500, tier: 'Gold' } }) }] } });
      return json(200, { result: { tools: [] } }, { 'mcp-session-id': 's1' });
    }
    if (String(url).includes('oauth-protected-resource')) return json(200, { authorization_servers: ['https://gw.example/pft'] });
    if (String(url).includes('oauth-authorization-server')) return json(200, { issuer: 'https://gw.example/pft', authorization_endpoint: 'https://gw.example/pft/authorize', token_endpoint: 'https://gw.example/pft/token', code_challenge_methods_supported: ['S256'] });
    if (String(url) === `${P1}/token`) return json(200, { access_token: jwt({ aud: GW, sub: 'sam', act: { sub: 'c1' } }) });
    throw new Error(`unexpected ${url}`);
  };
  return { f, seen };
}
async function boot(env, f) {
  const server = createApp(env, { fetchImpl: f }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`; let cookie = null;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
  return { call, base, close: () => new Promise((r) => server.close(r)) };
}
const ENV = { ALLOW_LIVE: '1', MUSE_LIVE_GATEWAY_URL: GW, MUSE_P1_ENV_ID: 'env1', MUSE_P1_CLIENT_ID: 'c1', MUSE_P1_CLIENT_SECRET: 's', MUSE_LLM_URL: 'http://127.0.0.1:8090' };

test('API: the model picks the tool before the 401, and writes the reply after sign-in', async () => {
  const n = net((req) => (req.messages[0].content.includes('Facts:') ? 'You have 20,320 points as Premier Gold.' : '{"tool":"get_loyalty_status"}'));
  const a = await boot(ENV, n.f);
  const first = await a.call('POST', '/api/live/ask', { prompt: 'what is my loyalty status?' });
  assert.equal(first.j.state, 'auth_required');
  const s1 = (await a.call('GET', '/api/session')).j;
  assert.equal(s1.agent.enabled, true);
  assert.equal(s1.liveAuth.steps[0].n, 0, 'the model step comes first');
  assert.equal(s1.liveAuth.steps[0].response.body.tool, 'get_loyalty_status');
  assert.equal(n.seen.filter((x) => x.url === GW && x.init.headers.authorization).length, 0, 'no authenticated call before sign-in');
  await a.call('POST', '/api/live/register');
  const u = new URL((await a.call('POST', '/api/live/signin')).j.url);
  await fetch(`${a.base}/api/callback?code=c&state=${u.searchParams.get('state')}`);
  const call = n.seen.filter((x) => x.url === GW && x.init.headers.authorization).map((x) => JSON.parse(x.init.body)).find((b) => b.method === 'tools/call');
  assert.equal(call.params.name, 'get_loyalty_status');
  assert.deepEqual(call.params.arguments, {}, 'the model never writes arguments');
  const s2 = (await a.call('GET', '/api/session')).j.liveAuth;
  assert.equal(s2.answer.reply, 'You have 20,320 points as Premier Gold.');
  assert.ok(s2.steps.some((x) => x.n === 10));
  await a.close();
});

test('API: when the model declines, nobody is sent to PingOne', async () => {
  const n = net(() => '{"tool":"none","reply":"whatever the model feels like saying"}');
  const a = await boot(ENV, n.f);
  const r = await a.call('POST', '/api/live/ask', { prompt: 'book me a flight to Rome' });
  assert.deepEqual([r.j.state, r.j.reply], ['declined', 'I can only help with your airline points and loyalty status.']);
  assert.equal(n.seen.filter((x) => x.url === GW).length, 0, 'the gateway was not called');
  assert.equal((await a.call('GET', '/api/session')).j.liveAuth.answer.reply, 'I can only help with your airline points and loyalty status.');
  await a.close();
});
