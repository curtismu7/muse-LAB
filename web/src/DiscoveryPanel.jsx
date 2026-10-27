import { useState } from 'react';

const POINTS_PROMPT = 'Show my airline points';

// The 401 and discovery steps, for the mock Agent Privilege or (owner-run) the real one. Every request and response is shown raw.
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function DiscoveryPanel({ session, api, onChange, busy, guarded }) {
  const [open, setOpen] = useState(null);
  const live = session.mode === 'live';
  const d = session.discovery && { ...session.discovery, steps: [...session.discovery.steps, ...(live ? (session.liveAuth?.steps ?? []) : [])] };

  const setMode = (mode) => guarded(async () => { await api('POST', '/api/gateway-mode', { mode }); await onChange(); setOpen(null); });
  const la = session.liveAuth ?? { steps: [] };
  const register = () => guarded(async () => { await api('POST', '/api/live/register'); await onChange(); });
  const signIn = () => guarded(async () => { if (!session.discovery) await api('POST', '/api/discover'); if (!la.registered) await api('POST', '/api/live/register'); const r = await api('POST', '/api/live/signin'); window.location.assign(r.url); });
  const callGw = () => guarded(async () => { await api('POST', '/api/live/call'); await onChange(); });
  const reset = () => guarded(async () => { await api('POST', '/api/reset'); await onChange(); setOpen(null); });
  const [prompt, setPrompt] = useState('');
  const ask = (text) => guarded(async () => { await api('POST', '/api/live/ask', { prompt: text }); await onChange(); setOpen(null); });
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
        {live ? `Real: Muse calls ${session.live.origin}. The first three steps only read. Registering writes one client at the gateway's authorization server, and only when you click it.` : 'Fake: nothing leaves this page. The answers are teaching values.'}
      </p>
      {live && (
        <div className="live-ask" data-testid="live-ask">
          {!la.ask && (
            <form className="disco-top" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) ask(prompt.trim()); }}>
              <input aria-label="Ask Muse" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask Muse, for example: show my points" disabled={busy} />
              <button type="submit" className="primary" disabled={busy || !prompt.trim()}>Ask Muse</button>
              <button type="button" onClick={() => ask(POINTS_PROMPT)} disabled={busy}>{POINTS_PROMPT}</button>
            </form>
          )}
          {la.ask && <div className="bubble user">{la.ask.prompt}</div>}
          {la.ask && !la.signedIn && d && (
            <p className="small">Muse called the gateway with no token and got the 401 below. Next it sends you to PingOne to sign in.</p>
          )}
        </div>
      )}
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
      {live && (
        <div className="disco-top" data-testid="live-steps">
          {la.ask && !la.signedIn && <button type="button" className="primary" onClick={signIn} disabled={busy}>Continue to PingOne</button>}
          {la.answer && <div className="bubble muse" data-testid="answer">You have {Number(la.answer.points).toLocaleString()} points ({la.answer.tier}).</div>}
          <button type="button" onClick={reset} disabled={busy} title="Clear this session and start again">Reset</button>
        </div>
      )}
      {live && la.error && <p role="alert" className="small bad">{la.error}</p>}
      {live && la.claims && <p className="small" data-testid="claims">Token claims (the token itself stays on the Muse server): <code>{JSON.stringify(la.claims)}</code></p>}
    </section>
  );
}
