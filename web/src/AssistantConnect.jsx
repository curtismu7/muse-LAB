import { useState } from 'react';

const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const METHOD = { dcr: 'dynamic client registration (RFC 7591)', cimd: 'its client ID metadata document (CIMD)' };

// How a customer adds the airline: they find it in their assistant's app directory and click Connect. No server address, no client id.
// The directory card is a stand-in (this demo is not listed anywhere). Connect then does what that platform does as an MCP client, against
// Muse's real connector: 401, metadata, registration or CIMD, PKCE sign-in at PingOne with that assistant's app, the token, the MCP calls.
export default function AssistantConnect({ session, api, guarded }) {
  const c = session.connector;
  const list = c?.assistants ?? [];
  const [pick, setPick] = useState(session.assistant?.key ?? list[0]?.key ?? null);
  const [open, setOpen] = useState(null);
  if (!list.length) return null;
  const a = list.find((x) => x.key === pick) ?? list[0];
  const airline = c.airline || 'the airline';
  const done = session.assistant?.key === a.key ? session.assistant : null;
  const connect = () => guarded(async () => { const r = await api('POST', '/api/sim/start', { platform: a.key, server: 'pf' }); window.location.assign(r.url); });
  const startOver = () => guarded(async () => { await api('POST', '/api/assistant/reset'); window.location.reload(); });
  return (
    <section className="disco assistant" aria-label="Connect from your assistant" data-testid="assistant-connect">
      <strong>Connect from your assistant</strong>
      <p className="muted small">Customers never type a server address. {airline} lists its connector once in each assistant's directory; a customer finds it there, clicks Connect and signs in at PingOne.</p>
      <div className="assistant-tabs" role="tablist" aria-label="Assistant">
        {list.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={x.key === a.key} className={x.key === a.key ? 'on' : ''} onClick={() => { setPick(x.key); setOpen(null); }}>{x.name}</button>
        ))}
      </div>
      <div className="assistant-dir" data-testid="assistant-dir">
        <div className="assistant-dir-top"><span className="muted small">{a.name}: apps and connectors</span><span className="assistant-search" aria-hidden="true">{airline}</span></div>
        <div className="assistant-card">
          <span className="avatar" aria-hidden="true">{airline.slice(0, 1)}</span>
          <div className="assistant-card-text">
            <strong>{c.airline ? `${c.airline} Airlines` : 'Airline'}</strong>
            <span className="muted small">Check your points and loyalty status. Published by {airline}.</span>
          </div>
          <button type="button" onClick={connect} data-testid="assistant-connect-btn">{done?.points ? 'Connected' : 'Connect'}</button>
        </div>
      </div>
      {done && <button type="button" onClick={startOver} data-testid="assistant-start-over">Start over</button>}
      {done && (
        <div className="small" data-testid="assistant-result">
          {done.points && <p><strong>Connected in {done.name}.</strong> Asked "How many points do I have?": {done.points.points.toLocaleString()} points, {done.points.tier}, for {done.points.passenger}.</p>}
          {done.error && <p role="alert" className="bad">{done.error}</p>}
          {done.method && <p className="muted">{done.name} identified itself with {METHOD[done.method] ?? done.method}. The sign-in came back to Muse's stand-in for <code>{done.realRedirect}</code>. {done.name} never sees the customer's PingOne token, only the connector's own.</p>}
          {done.steps?.length > 0 && (
            <ol className="disco-steps" data-testid="assistant-steps">
              {done.steps.map((s) => (
                <li key={s.n}>
                  <button type="button" className="disco-head" aria-expanded={open === s.n} onClick={() => setOpen(open === s.n ? null : s.n)}>
                    <b>{s.n}</b> {s.title}
                    {s.response && <code className={s.response.status >= 400 && s.n !== 1 ? 'bad' : 'ok'}>{s.response.status}</code>}
                  </button>
                  {s.note && <p className="small">{s.note}</p>}
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
        </div>
      )}
      <p className="muted small">Stand-ins: the directory card ({airline} has to be approved by each vendor before it appears), the callback address, and the model's choice of tool. Every request after Connect is real. <a href="/how-muse-works.html#connect">How customers connect</a></p>
    </section>
  );
}
