import { useEffect, useState } from 'react';
import MuseFlow from './MuseFlow.jsx';

// "Book a flight": Muse -> Agent Gateway -> PingOne Authorize, under two rules from two owners. Both modes use this panel.
// Mock runs the existing local gateway and a simulated Authorize (labelled so everywhere). Real sends the same call to the owner's gateway.
// The numbers (limit, threshold, tiers, fares) come from /api/flights; nothing is hard-coded here.
const CALLERS = [
  { id: 'agent', label: 'Personal Agent (AI agent)' },
  { id: 'human', label: 'Sam directly, no agent' },
];

// The nine scenarios of the contract in talk-track order, then row 10: a user with no airlineMemberTier (not premium). `expect` is what the rules say should happen.
const ROWS = [
  { n: 1, caller: 'agent', flight: 'SH103', member: 'standard', expect: 'Allowed past both rules' },
  { n: 2, caller: 'agent', flight: 'SH104', member: 'standard', expect: 'Allowed: exactly the limit passes' },
  { n: 3, caller: 'agent', flight: 'SH106', member: 'standard', expect: 'Denied by your rule' },
  { n: 4, caller: 'agent', flight: 'SH107', member: 'premium', expect: 'Denied by your rule, even for a premium member' },
  { n: 5, caller: 'human', flight: 'SH106', member: 'standard', expect: 'Allowed: your rule only limits agents' },
  { n: 6, caller: 'human', flight: 'SH108', member: 'standard', expect: 'Allowed: exactly $750 passes' },
  { n: 7, caller: 'human', flight: 'SH107', member: 'standard', expect: 'Denied by the airline rule' },
  { n: 8, caller: 'human', flight: 'SH107', member: 'premium', expect: 'Allowed: premium members can book over $750' },
  { n: 9, caller: 'agent', flight: 'SH107', member: 'standard', expect: 'Denied by both rules' },
  { n: 10, caller: 'human', flight: 'SH107', member: 'none', expect: 'Denied by the airline rule: no tier set is not premium' },
];
// Real: what the demo user's airlineMemberTier must be for the row to behave as listed (the owner flips it in the PingOne tenant).
const REAL_TIER = { premium: 'Premier Gold expected', standard: 'Premier Silver expected', none: 'no airlineMemberTier expected' };

const MOCK_TIER = { premium: 'Premium (Gold)', standard: 'Standard (Silver)', none: 'No tier set' };

const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const mfaOff = () => { try { return window.localStorage.getItem('muse.p1mfa') === '0'; } catch { return false; } };
const money = (n) => `$${n}`;

function Banner({ b }) {
  if (!b) return null;
  const stopped = b.status === 'denied' && b.rulesDenied.length > 0;
  const kind = stopped ? 'stop' : b.status === 'booked' ? (b.unexpected ? 'warn' : 'ok') : b.status === 'error' ? 'warn' : 'info';
  return (
    <section className={`bk-banner bk-banner--${kind}`} role={stopped ? 'alert' : 'status'} data-testid="booking-banner" data-status={b.status}>
      <h3 data-testid="booking-headline">{b.headline}</h3>
      {b.subheading && <p className="bk-sub" data-testid="booking-subheading">{b.subheading}</p>}
      {stopped ? (
        <>
          <ul className="bk-lines">{b.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <p data-testid="booking-nothing">Nothing was booked.</p>
        </>
      ) : <p>{b.message}</p>}
      <p className="bk-chips">
        {b.chip && <span className="bk-chip bk-chip--sim" data-testid="booking-chip">{b.chip}</span>}
        {b.rulesDenied.map((r) => <span key={r.code} className="bk-chip" title={r.name}>{r.code}</span>)}
      </p>
    </section>
  );
}

function Trace({ hops }) {
  const [open, setOpen] = useState(null);
  return (
    <ol className="bk-trace" aria-label="Trace" data-testid="booking-trace">
      {hops.map((h) => (
        <li key={h.n} className={`bk-hop bk-hop--${h.state}`}>
          <button type="button" className="bk-hop__head" aria-expanded={open === h.n} onClick={() => setOpen(open === h.n ? null : h.n)}>
            <b>{h.n}</b> <span>{h.from} &rarr; {h.to}</span> <strong>{h.title}</strong>
            {h.simulated && <span className="bk-chip bk-chip--sim">simulated</span>}
            <span className={`bk-state bk-state--${h.state}`}>{h.state === 'stop' ? 'stopped' : h.state === 'unknown' ? 'not reported' : h.state === 'skipped' ? 'not reached' : 'ok'}</span>
          </button>
          <p className="small">{h.summary}</p>
          {open === h.n && <pre className="bk-raw">{pretty(h.raw)}</pre>}
        </li>
      ))}
    </ol>
  );
}

// The Member tier card: one control for both modes. Mock sets the Mock PingOne user (the server's member). Real writes the PingOne user attribute
// airlineMemberTier on the owner's demo users and shows what PingOne says it holds afterwards (a read-back), never what was asked for.
const TIER_BUTTONS = [
  { key: 'premium', label: 'Premier Gold', hint: 'premium' },
  { key: 'standard', label: 'Premier Silver', hint: 'standard' },
  { key: 'none', label: 'No tier set', hint: 'not premium' },
];
const heldLabel = (v) => (v === null || v === undefined ? 'No tier set' : v);
const TIER_KEY_OF = { 'Premier Gold': 'premium', 'Premier Silver': 'standard' };

function TierCard({ live, session, info, api, busy, onChanged }) {
  const [state, setState] = useState(null);     // GET /api/booking/tier
  const [result, setResult] = useState(null);   // the last switch or read in Real
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState(null);
  const attribute = info?.rules?.tierAttribute ?? 'airlineMemberTier';
  const load = () => api('GET', '/api/booking/tier').then(setState).catch(() => setState(null));
  useEffect(() => { load(); }, [api, live]);
  const configured = state?.configured === true;
  const users = (result ?? state?.last)?.users ?? [];
  const readAll = users.length > 0 && users.every((u) => u.known);
  const values = [...new Set(users.map((u) => u.value ?? null))];
  const heldKey = live ? (readAll && values.length === 1 ? (values[0] === null ? 'none' : TIER_KEY_OF[values[0]] ?? null) : null) : session.member;
  const mixed = live && readAll && values.length > 1;

  const send = async (path, body) => {
    setWorking(true); setProblem(null);
    try {
      const r = await api('POST', path, body);
      if (live) setResult(r);
      await load(); await onChanged?.();
    } catch (e) {
      // A refused or failed write still carries the honest per-user answer; show it, never a success.
      if (e.body?.users) { setResult(e.body); await load(); } else setProblem(e.message);
    } finally { setWorking(false); }
  };
  const read = () => send('/api/booking/tier/read');
  useEffect(() => { if (live && configured) read(); }, [live, configured]); // eslint-disable-line react-hooks/exhaustive-deps
  const off = busy || working || (live && !configured);

  const current = live
    ? (readAll ? (mixed ? 'The demo users differ' : heldLabel(values[0])) : users.length ? 'Could not read every user' : configured ? 'Reading PingOne...' : 'Not available')
    : heldLabel(info?.members?.find((m) => m.key === session.member)?.tier);

  return (
    <section className="bk-tier" aria-label="Member tier" data-testid="tier-card" data-mode={live ? 'real' : 'mock'}>
      <h3>Member tier</h3>
      <p className="small muted">
        {live
          ? <>Real. Writes the PingOne user attribute <code>{attribute}</code> on your demo users, then reads them back. Authorize reads the same attribute, so run the booking again to see the decision change.</>
          : <>Simulated. Sets the Mock PingOne user the stand-in Authorize reads (mimics <code>{attribute}</code>). Nothing leaves this machine.</>}
      </p>
      <p className="bk-tier__now" data-testid="tier-current">
        <strong>{live ? 'PingOne holds' : 'Mock PingOne user holds'}:</strong> <span className="bk-chip" data-testid="tier-value">{current}</span>
        {live && configured && state?.last?.at && <span className="small muted"> read {new Date(state.last.at).toLocaleTimeString()}</span>}
      </p>
      <div className="bk-tier__btns" role="group" aria-label="Choose the member tier">
        {TIER_BUTTONS.map((b) => (
          <button key={b.key} type="button" aria-pressed={heldKey === b.key} disabled={off} onClick={() => send('/api/booking/tier', { member: b.key })} data-testid={`tier-${b.key}`}>
            {b.label}<span className="small"> ({b.hint})</span>
          </button>
        ))}
        {live && <button type="button" onClick={read} disabled={off} data-testid="tier-read" title="Read what PingOne holds now. Changes nothing.">Check PingOne</button>}
      </div>
      {live && !configured && (
        <p className="small bk-tier__off" role="status" data-testid="tier-unconfigured">
          {state?.needs?.length > 0
            ? <>Switching is off until these are set in Muse's own <code>.env</code>, then restart Muse: {state.needs.map((n, i) => <span key={n}>{i > 0 && ', '}<code>{n}</code></span>)}. See <code>.env.example</code>.</>
            : <>Switching is off. {state?.explanation ?? 'The tier switch is not configured.'}</>}
          {' '}You can still flip the user in PingOne yourself and run the rows.
        </p>
      )}
      {mixed && <p className="small bk-tier__off" role="status">The demo users hold different tiers. Press a tier to set them all the same.</p>}
      {problem && <p className="small bk-tier__bad" role="alert" data-testid="tier-error">{problem}</p>}
      <div aria-live="polite" data-testid="tier-result">
        {live && result && (
          <>
            {result.error && <p className="small bk-tier__bad" role="alert">{result.error}</p>}
            {result.summary && <p className={`small ${result.ok ? 'bk-tier__ok' : 'bk-tier__bad'}`}>{result.ok ? 'Verified. ' : 'Not verified. '}{result.summary}</p>}
            {result.users?.length > 0 && (
              <ul className="small bk-tier__users">
                {result.users.map((u) => (
                  <li key={u.label}>{u.label}: {u.known ? heldLabel(u.value) : 'unknown'}{u.verified === true ? ' (verified)' : u.verified === false ? ' (NOT verified)' : ''}{u.writeError ? `. ${u.writeError}` : ''}{u.readError ? `. ${u.readError}` : ''}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {!live && <p className="small muted">The scenario rows below set their own tier when you run them; the card follows.</p>}
      </div>
    </section>
  );
}

export default function BookFlight({ session, api, busy, guarded, signInWith, bookMock, onReset, onTierChanged }) {
  const live = session.mode === 'live';
  const [info, setInfo] = useState(null);
  const [caller, setCaller] = useState('agent');
  const [flight, setFlight] = useState('SH106');
  const [diagram, setDiagram] = useState(false);
  useEffect(() => { api('GET', '/api/flights').then(setInfo).catch(() => setInfo(null)); }, [api]);
  const b = session.booking ?? null;
  const ledger = session.bookings ?? [];
  const fares = Object.fromEntries((info?.flights ?? []).map((f) => [f.id, f.fare]));
  const userOk = !live || session.live?.userLogin;
  const member = session.member ?? 'standard';

  const runReal = async (flightId, who, quoted) => {
    const r = await api('POST', '/api/live/ask', { scenario: 'book', flightId, channel: who === 'human' ? 'user' : 'agent', ...(quoted !== undefined ? { quoted } : {}) });
    if (r.state !== 'auth_required') return;
    if (who === 'human') await signInWith({ as: 'user', mfa: mfaOff() ? 'off' : 'on' });
    else { await api('POST', '/api/live/register'); await signInWith({ mfa: mfaOff() ? 'off' : 'on' }); }
  };
  const run = (flightId, who, mem, quoted) => guarded(async () => {
    if (live) await runReal(flightId, who, quoted);
    else await bookMock({ flightId, caller: who, member: mem, quoted });
  });

  return (
    <section className="bookflight" aria-label="Book a flight" data-testid="book-flight">
      <h2>Book a flight</h2>
      <p className="muted small">
        {live
          ? 'Real. Muse calls your Agent Gateway for book_airline_flight. The gateway asks PingOne Authorize, and Authorize applies the two rules below. Authorize reads the member tier itself, from the PingOne user attribute airlineMemberTier. Setup is owner-run; until you have run it this is unproven.'
          : 'Simulated. A local gateway and a stand-in for PingOne Authorize apply the same two rules. No tenant is contacted. Switch to Real to send the call to your own gateway.'}
      </p>

      <div className="bk-rules" aria-label="The two rules">
        {(info?.ruleCards ?? []).map((c) => (
          <article key={c.id} className={`bk-rule bk-rule--${c.id}`} data-testid={`rule-card-${c.id}`}>
            <h3>{c.short}: {c.line}</h3>
            <p className="small muted">Owner: {c.owner}. Authorize rule <code>{c.code}</code>.</p>
            <p className="small">{c.id === 'agent_spend_limit' ? `Applies only when an AI agent is acting. The limit is your own setting (default $${info.rules.agentLimit}). Exactly the limit passes.` : `Applies to every caller. Authorize reads the member tier from the PingOne user attribute ${info.rules.tierAttribute}. Premium means: ${info.rules.premiumTiers.join(', ')}. Any other value, an empty value or no attribute is not premium. Exactly $${info.rules.premiumThreshold} passes.`}</p>
          </article>
        ))}
      </div>

      <TierCard live={live} session={session} info={info} api={api} busy={busy} onChanged={onTierChanged} />

      <div className="bk-who" role="group" aria-label="Who is booking">
        <label className="field"><span>Who is booking</span>
          <select value={caller} onChange={(e) => setCaller(e.target.value)} disabled={busy} data-testid="who-select">
            {CALLERS.map((c) => <option key={c.id} value={c.id} disabled={c.id === 'human' && !userOk}>{c.label}</option>)}
          </select>
        </label>
        {live ? (
          <p className="small" data-testid="gateway-facts">
            <strong>As the gateway sees it:</strong>{' '}
            {b?.facts?.agentSpendLimit !== undefined
              ? `agent spend limit ${money(b.facts.agentSpendLimit)}${b.facts.profileSource === 'default' ? ' (default member record)' : ''}`
              : 'not reported yet. Run a row first.'}
            <br />
            <strong>Member tier:</strong> {b?.facts?.memberTier ?? 'not reported to Muse'}. Source: {info?.rules?.tierSourceReal ?? 'PingOne user attribute airlineMemberTier (read by Authorize)'}.
            {' '}Use the Member tier card to set Premier Gold or Premier Silver on the demo users.
          </p>
        ) : null}
      </div>

      <h3>Scenarios</h3>
      <div className="bk-table-wrap">
        <table className="bk-table" data-testid="scenario-table">
          <thead><tr><th>#</th><th>Caller</th><th>Flight</th><th>Member tier</th><th>Rules say</th><th /></tr></thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.n} data-testid={`row-${r.n}`}>
                <td>{r.n}</td>
                <td>{r.caller === 'agent' ? 'AI agent' : 'Sam, direct'}</td>
                <td>{r.flight} {fares[r.flight] !== undefined && <b>{money(fares[r.flight])}</b>}</td>
                <td>{live ? <span className="small muted" title="Set on the PingOne user, read by Authorize">{REAL_TIER[r.member]}</span> : MOCK_TIER[r.member]}</td>
                <td className="small">{r.expect}</td>
                <td><button type="button" className="primary" onClick={() => run(r.flight, r.caller, r.member)} disabled={busy || (r.caller === 'human' && !userOk)} data-testid={`run-${r.n}`}>Run</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {live && !userOk && <p className="small muted">Sam-direct rows need the user sign-in app (MUSE_USER_CLIENT_ID); it is not configured.</p>}
      <p className="small muted">
        {live
          ? 'A booking that passes both rules still meets the consent gate: the gateway answers HTTP 428 and nothing is booked yet. Muse does not approve it.'
          : 'In Mock a booking that passes both rules books: the agent asks Sam\'s consent once (the existing consent dialog), a direct call has no consent step. In Real the consent gate stops these at HTTP 428.'}
      </p>

      <div className="bk-picker" role="group" aria-label="Pick any flight">
        <label className="field"><span>Any flight</span>
          <select value={flight} onChange={(e) => setFlight(e.target.value)} disabled={busy} data-testid="flight-select">
            {(info?.flights ?? []).map((f) => <option key={f.id} value={f.id}>{f.id} {f.route} {money(f.fare)}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => run(flight, caller, member)} disabled={busy || (caller === 'human' && !userOk)} data-testid="run-picked">Book it</button>
        <button type="button" onClick={onReset} disabled={busy} data-testid="book-reset" title="Clear this session: the trace, the ledger and the sign-in">Reset</button>
        <button type="button" onClick={() => run('SH107', 'agent', 'standard', 100)} disabled={busy} data-testid="run-lie" title="Muse sends amount 100. The fare that is judged is still the catalogue's.">Book SH107 but claim $100 (try to lie)</button>
      </div>

      <Banner b={b} />
      {b && <Trace hops={b.hops} />}

      <section className="bk-ledger" aria-label="Bookings made this session" data-testid="ledger">
        <h3>Bookings made this session</h3>
        {ledger.length === 0 ? <p data-testid="ledger-empty">Nothing booked.</p> : (
          <ul>{ledger.map((l) => <li key={l.confirmation ?? l.at}>{l.flightId} {money(l.fare)} <code>{l.confirmation}</code> <span className="small muted">{l.mode === 'live' ? 'Real' : 'simulated'}</span></li>)}</ul>
        )}
      </section>

      <button type="button" className="bk-diagram-toggle" aria-expanded={diagram} onClick={() => setDiagram(!diagram)} data-testid="diagram-toggle">{diagram ? 'Hide' : 'Show'} the diagram</button>
      {diagram && <MuseFlow only="booking-rules-flow" />}
    </section>
  );
}
