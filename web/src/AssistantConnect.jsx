import { useState } from 'react';

// How a customer adds the airline: they find it in their assistant's app directory and click Connect. No server address, no client id.
// The directory card is a stand-in (this demo is not listed anywhere); Connect runs the real PingOne sign-in with that assistant's own app.
export default function AssistantConnect({ session, api, guarded, mfaOff }) {
  const c = session.connector;
  const list = c?.assistants ?? [];
  const [pick, setPick] = useState(session.assistant?.key ?? list[0]?.key ?? null);
  if (!list.length) return null;
  const a = list.find((x) => x.key === pick) ?? list[0];
  const airline = c.airline || 'the airline';
  const done = session.assistant?.key === a.key ? session.assistant : null;
  const connect = () => guarded(async () => { const r = await api('POST', '/api/live/signin', { as: 'assistant', assistant: a.key, mfa: mfaOff ? 'off' : 'on' }); window.location.assign(r.url); });
  return (
    <section className="disco assistant" aria-label="Connect from your assistant" data-testid="assistant-connect">
      <strong>Connect from your assistant</strong>
      <p className="muted small">Customers never type a server address. {airline} lists its connector once in each assistant's directory; a customer finds it there, clicks Connect and signs in at PingOne.</p>
      <div className="assistant-tabs" role="tablist" aria-label="Assistant">
        {list.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={x.key === a.key} className={x.key === a.key ? 'on' : ''} onClick={() => setPick(x.key)}>{x.name}</button>
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
      {done && (
        <div className="small" data-testid="assistant-result">
          {done.points && <p><strong>Connected in {done.name}.</strong> Asked "How many points do I have?": {done.points.points.toLocaleString()} points, {done.points.tier}, for {done.points.passenger}.</p>}
          {done.claims?.act && <p className="muted">Token: <code>sub {String(done.claims.sub).slice(0, 8)}…</code> with <code>act {String(done.claims.act.sub ?? done.claims.act.client_id ?? '').slice(0, 8)}…</code>, {done.name} acting for the customer.</p>}
          {done.error && <p className="muted">{done.error}</p>}
        </div>
      )}
      <p className="muted small">The card stands in for the assistant's directory listing; {airline} has to be approved by each vendor before it appears. Everything after Connect is real. <a href="/how-muse-works.html#connect">More</a></p>
    </section>
  );
}
