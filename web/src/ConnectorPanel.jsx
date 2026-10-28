import { useState } from 'react';

// Prompts to paste into Meta's Muse once the Airline Connector is added. Copy only: they run in that app, not here.
const CONNECTOR_PROMPTS = [
  'How many airline points do I have?',
  "What's my loyalty status?",
  'Use the Airline Connector to check my points and my status. Do both numbers agree?',
];

function Copy({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard refused; the text is selectable */ }
  };
  return <button type="button" onClick={copy} aria-label={`Copy ${label}`}>{done ? 'Copied' : 'Copy'}</button>;
}

export default function ConnectorPanel({ connector }) {
  if (!connector) return null;
  const rows = [['Server URL', connector.url], ['Client ID', connector.clientId], ['Callback', connector.redirectUri]].filter(([, v]) => v);
  return (
    <section className="disco connector" aria-label="Airline Connector" data-testid="connector-panel">
      <strong>Try it in Meta's Muse</strong>
      <p className="muted small">Add this as a custom connector, sign in at PingOne, then paste a prompt below. Leave the client secret blank.</p>
      <p className="muted small">Meta's Muse picks a connector by reading each tool's name and description. If you also have another airline connected, name the airline in your prompt. <a href="/how-muse-works.html#pick">More</a></p>
      <ul className="connector-rows">
        {rows.map(([k, v]) => (
          <li key={k}><span className="muted small">{k}</span><code>{v}</code><Copy text={v} label={k} /></li>
        ))}
      </ul>
      <ul className="connector-rows">
        {CONNECTOR_PROMPTS.map((t) => (
          <li key={t}><span>{t}</span><Copy text={t} label="prompt" /></li>
        ))}
      </ul>
    </section>
  );
}
