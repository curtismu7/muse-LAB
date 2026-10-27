import { useState } from 'react';

// The 401 and discovery steps, for the mock Agent Privilege or (owner-run) the real one. Every request and response is shown raw.
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function DiscoveryPanel({ session, api, onChange, busy, guarded }) {
  const [open, setOpen] = useState(null);
  const live = session.mode === 'live';
  const d = session.discovery;

  const setMode = (mode) => guarded(async () => { await api('POST', '/api/gateway-mode', { mode }); await onChange(); setOpen(null); });
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
        <button type="button" onClick={discover} disabled={busy}>Call Agent Privilege with no token</button>
      </div>
      <p className="muted small">
        {live ? `Real: Muse calls ${session.live.origin}. Reads only; no client is registered and nobody signs in.` : 'Fake: nothing leaves this page. The answers are teaching values.'}
      </p>
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
          {live ? ' Live registration and sign-in come next.' : ''}
        </p>
      )}
    </section>
  );
}
