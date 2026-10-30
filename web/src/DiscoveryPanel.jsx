import { useState } from 'react';

const POINTS_PROMPT = 'Show my airline points';
const AUTO_KEY = 'muse.autoPingOne';
const MFA_KEY = 'muse.p1mfa';
const readMfa = () => { try { return window.localStorage.getItem(MFA_KEY) !== '0'; } catch { return true; } };
const readAuto = () => { try { return window.localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } };

// The 401 and discovery steps, for the mock Agent Privilege or (owner-run) the real one. Every request and response is shown raw.
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function DiscoveryPanel({ session, api, onChange, busy, guarded }) {
  const [open, setOpen] = useState(null);
  const live = session.mode === 'live';
  const liveSteps = live ? (session.liveAuth?.steps ?? []) : [];
  // Without discovery (a declined request) the model's own step is still shown.
  const d = !session.discovery && liveSteps.length ? { steps: [...liveSteps].sort((a, b) => a.n - b.n), learned: null, stopped: null } : session.discovery && { ...session.discovery, steps: [...session.discovery.steps, ...(live ? (session.liveAuth?.steps ?? []) : [])].sort((a, b) => a.n - b.n) };

  const setMode = (mode) => guarded(async () => { await api('POST', '/api/gateway-mode', { mode }); await onChange(); setOpen(null); });
  const la = session.liveAuth ?? { steps: [] };
  const register = () => guarded(async () => { await api('POST', '/api/live/register'); await onChange(); });
  const signIn = () => guarded(async () => { if (!session.discovery) await api('POST', '/api/discover'); if (!la.registered) await api('POST', '/api/live/register'); const r = await api('POST', '/api/live/signin', { mfa: mfa ? 'on' : 'off' }); window.location.assign(r.url); });
  const callGw = () => guarded(async () => { await api('POST', '/api/live/call'); await onChange(); });
  const reset = () => guarded(async () => { await api('POST', '/api/reset'); await onChange(); setOpen(null); });
  const [prompt, setPrompt] = useState('');
  // Off: Muse shows the 401 and a Continue button. On: no button; Muse shows the 401 for a moment, goes to PingOne, and answers on return.
  const [auto, setAuto] = useState(readAuto);
  // PingOne MFA: on leaves the flow as it is (MFA on medium risk); off sends a flag the DaVinci flow reads to skip it.
  const [mfa, setMfa] = useState(readMfa);
  const toggleMfa = (on) => { setMfa(on); try { window.localStorage.setItem(MFA_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } };
  const toggleAuto = (on) => { setAuto(on); try { window.localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } };
  const ask = (text) => guarded(async () => {
    const r = await api('POST', '/api/live/ask', { prompt: text });
    await onChange(); setOpen(null);
    if (r?.state === 'auth_required' && auto) setTimeout(() => signIn(), 1500);
  });
  const discover = () => guarded(async () => { await api('POST', '/api/discover'); await onChange(); });

  return (
    <section className="disco" aria-label="Agent Privilege discovery" data-testid="discovery">
      <div className="disco-top">
        <strong>Agent Privilege</strong>
        <div className="seg" role="group" aria-label="Real or fake Agent Privilege">
          <button type="button" aria-pressed={!live} onClick={() => setMode('mock')} disabled={busy}>Fake (mock)</button>
          <button type="button" aria-pressed={live} onClick={() => setMode('live')} disabled={busy || !session.live.available}
            title={session.live.available ? `Calls ${session.live.origin}` : 'Live mode is owner-run: set ALLOW_LIVE=1 and MUSE_LIVE_GATEWAY_URL when starting locally. Not available on the hosted build.'}>Real (live)</button>
        </div>
        {!live && <button type="button" onClick={discover} disabled={busy}>Call Agent Privilege with no token</button>}
      </div>
      <p className="muted small">
        {live ? `Real: Muse calls ${session.live.origin} for you. PingOne signs you in, then Muse acts on your behalf.` : 'Fake: nothing leaves this page. The answers are teaching values.'}
      </p>
      {live && (
        <div className="live-chat" data-testid="live-ask">
          <div className="feed live-feed" role="log" aria-live="polite">
            {!la.ask && <p className="muted center">Ask Muse for something, for example: {POINTS_PROMPT.toLowerCase()}.</p>}
            {la.ask && <div className="bubble user">{la.ask.prompt}</div>}
            {la.ask && session.discovery && (
              <div className="msg">
                <span className="avatar sm" aria-hidden="true">M</span>
                <div className="bubble muse">
                  <span>I called the gateway without a token and it answered <strong>401</strong>. {la.signedIn ? 'You signed in, so I asked again with a token for you.' : ''}</span>
                </div>
              </div>
            )}
            {la.answer && (
              <div className="msg">
                <span className={`avatar sm ${la.claims?.protect_agent === 'HIGH' ? 'detected' : la.claims?.act ? 'undetected' : ''}`} aria-hidden="true">M</span>
                <div className="bubble muse" data-testid="answer">{la.answer.reply ?? <>You have <strong>{Number(la.answer.points).toLocaleString()} points</strong> ({la.answer.tier}).</>}</div>
              </div>
            )}
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) { ask(prompt.trim()); setPrompt(''); } }}>
            <label className="sr-only" htmlFor="live-ask-input">Ask Muse</label>
            <input id="live-ask-input" type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder='Ask Muse, e.g. "show my airline points"' autoComplete="off" disabled={busy} />
            <button type="submit" className="primary" disabled={busy || !prompt.trim()}>Send</button>
          </form>
          <div className="prompts" role="group" aria-label="Prompts">
            <button type="button" className="chip" onClick={() => ask(POINTS_PROMPT)} disabled={busy}>{POINTS_PROMPT}</button>
            <button type="button" className="chip" onClick={reset} disabled={busy} title="Clear this session and start again">Reset</button>
            <label className="toggle" title="On: PingOne asks for MFA when the risk is medium. Off: MFA is skipped for this sign-in.">
              <input type="checkbox" role="switch" checked={mfa} onChange={(e) => toggleMfa(e.target.checked)} />
              <span>PingOne MFA</span>
            </label>
            <label className="toggle" title="On: no button. Muse goes to PingOne after the 401, and answers when you return. Off: show the Continue button.">
              <input type="checkbox" role="switch" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
              <span>Run all the way through</span>
            </label>
          </div>
        </div>
      )}
      {d && live && <p className="small muted"><strong>What Muse did</strong>, step by step (click a step for the raw request and response):</p>}
      {d && (
        <ol className="disco-steps">
          {d.steps.map((s) => (
            <li key={s.n} className={s.skipped ? 'skipped' : ''}>
              <button type="button" className="disco-head" aria-expanded={open === s.n} onClick={() => setOpen(open === s.n ? null : s.n)}>
                <b>{s.n}</b> {s.title}
                {s.response && <code className={s.response.status >= 400 ? 'bad' : 'ok'}>{s.response.status}</code>}
                {s.skipped && <code>not contacted</code>}
              </button>
              <p className="small">{s.note}</p>
              {open === s.n && (
                <div className="disco-raw">
                  <pre>{`${s.request.method} ${s.request.url}${s.request.body ? `\n\n${pretty(s.request.body)}` : ''}`}</pre>
                  {s.response && <pre>{`${s.response.status}${Object.entries(s.response.headers ?? {}).map(([k, v]) => `\n${k}: ${v}`).join('')}\n\n${pretty(s.response.body)}`}</pre>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {d?.stopped && <p role="alert" className="small bad">Stopped: {d.stopped}</p>}
      {d?.learned && (
        <p className="small" data-testid="learned">
          Muse learned: sign in at <code>{d.learned.authorizeEndpoint}</code>, token from <code>{d.learned.tokenEndpoint}</code>{d.learned.pkce ? ', PKCE required' : ''}.
        </p>
      )}
      {live && la.error && <p role="alert" className="small bad">{la.error}</p>}
      {live && la.claims && <p className="small" data-testid="claims">Token claims (the token itself stays on the Muse server): <code>{JSON.stringify(la.claims)}</code></p>}
    </section>
  );
}
