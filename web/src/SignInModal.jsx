import { useEffect, useRef, useState } from 'react';
import { davinci } from '@forgerock/davinci-client';
import { protect } from '@forgerock/protect';
import FloatingDialog from './floating-dialog/FloatingDialog';

// The standard pi.flow Sign in dialog. PingOne's DaVinci flow runs in this dialog through Ping's DaVinci client SDK: the SDK asks PingOne what
// the next screen is (username and password, MFA, consent, ...), this component draws it, and the SDK sends the answers back. The page never
// leaves for a PingOne login page. When the flow succeeds the SDK hands over the code and state; the server swaps them (it holds the PKCE verifier).
//
// Shape of the family's dialog: title bar "Sign in", fields, an error line, Cancel and Sign in in the footer. The frame is the shared
// FloatingDialog (owner 2026-11-09): drag by the title bar, resize, keyboard move. Not blocking: no backdrop and no focus trap (noBackdrop), so
// the trace steps behind it stay usable while it waits. No pop-out: the DaVinci SDK and Protect's behaviour signals run in this document.

const textOf = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// PingOne's screen text (the consent wording, headings) can arrive as HTML. It is parsed (scripts never run) and drawn from a short allowlist of
// tags; anything else keeps only its text, links must be http(s), and nothing is ever set as innerHTML. Labels are plain text.
const KEEP = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'DIV', 'SPAN']);
const parse = (html) => new DOMParser().parseFromString(textOf(html), 'text/html').body;
const plain = (html) => parse(html).textContent ?? '';
const nodes = (list) => [...list].map((n, i) => {
  if (n.nodeType === 3) return n.textContent;
  if (n.nodeType !== 1 || ['SCRIPT', 'STYLE'].includes(n.tagName)) return null;
  const kids = nodes(n.childNodes);
  if (n.tagName === 'BR') return <br key={i} />;
  if (n.tagName === 'A') { const h = n.getAttribute('href') ?? ''; return /^https?:\/\//i.test(h) ? <a key={i} href={h} target="_blank" rel="noopener noreferrer">{kids}</a> : <span key={i}>{kids}</span>; }
  if (KEEP.has(n.tagName)) { const T = n.tagName.toLowerCase(); return <T key={i}>{kids}</T>; }
  return <span key={i}>{kids}</span>;
});
const Rich = ({ html }) => <div className="signin-rich">{nodes(parse(html).childNodes)}</div>;

function Collector({ c, client, disabled, onChange, onPick }) {
  const label = plain(c.output?.label);
  const id = `signin-${c.id ?? c.name}`;
  const set = (value) => { client.update(c)(value); onChange?.(); };
  switch (c.type) {
    case 'TextCollector':
    case 'ValidatedTextCollector':
      return (
        <div className="signin-field">
          <label htmlFor={id}>{label}</label>
          <input id={id} defaultValue={textOf(c.input?.value)} autoComplete={/mail|user|number/i.test(`${c.name}${label}`) ? 'username' : 'off'} maxLength={256} disabled={disabled} onChange={(e) => set(e.target.value)} />
          {c.error && <p className="signin-error" role="alert">{textOf(c.error)}</p>}
        </div>
      );
    case 'PasswordCollector':
    case 'ValidatedPasswordCollector':
      // Uncontrolled: the password is never held in React state.
      return (
        <div className="signin-field">
          <label htmlFor={id}>{label}</label>
          <input id={id} type="password" autoComplete="current-password" maxLength={256} disabled={disabled} onChange={(e) => set(e.target.value)} />
          {c.error && <p className="signin-error" role="alert">{textOf(c.error)}</p>}
        </div>
      );
    case 'BooleanCollector':
    case 'ValidatedBooleanCollector':
      return (
        <div className="signin-field signin-check">
          <input id={id} type="checkbox" defaultChecked={c.input?.value === true} disabled={disabled} onChange={(e) => set(e.target.checked)} />
          <label htmlFor={id}>{label}</label>
        </div>
      );
    case 'SingleSelectCollector':
      return (
        <div className="signin-field">
          <label htmlFor={id}>{label}</label>
          <select id={id} defaultValue={textOf(c.input?.value)} disabled={disabled} onChange={(e) => set(e.target.value)}>
            <option value="">Choose</option>
            {(c.output?.options ?? []).map((o) => <option key={textOf(o.value)} value={textOf(o.value)}>{textOf(o.label)}</option>)}
          </select>
        </div>
      );
    case 'MultiSelectCollector':
      return (
        <fieldset className="signin-field">
          <legend>{label}</legend>
          {(c.output?.options ?? []).map((o) => (
            <label key={textOf(o.value)} className="signin-check">
              <input type="checkbox" defaultChecked={(c.input?.value ?? []).includes(o.value)} disabled={disabled}
                onChange={(e) => { const cur = new Set(c.input?.value ?? []); if (e.target.checked) cur.add(o.value); else cur.delete(o.value); set([...cur]); }} />
              {textOf(o.label)}
            </label>
          ))}
        </fieldset>
      );
    case 'RichTextCollector':
      return <Rich html={c.output?.content ?? c.output?.label} />;
    case 'ReadOnlyCollector': // also how an agreement (the consent wording) arrives: a title and HTML content
      return <div className="signin-rich">{c.output?.title ? <strong>{plain(c.output.title)}</strong> : null}<Rich html={c.output?.content ?? c.output?.label} /></div>;
    case 'NoValueCollector':
      return <Rich html={c.output?.label ?? c.output?.content} />;
    case 'ERROR_DISPLAY': // PingOne's placeholder for the error line: this dialog draws its own
    case 'ProtectCollector': // collects device signals for PingOne Protect; nothing to draw (the signals SDK is not used here)
      return null;
    case 'DeviceAuthenticationCollector': // MFA: which device should PingOne use. Choosing one is the action, so it continues at once.
    case 'DeviceRegistrationCollector':
      return (
        <fieldset className="signin-field">
          <legend>{label}</legend>
          <div className="signin-choices">
            {(c.output?.options ?? []).map((o) => (
              <button type="button" key={textOf(o.value)} className="signin-choice" disabled={disabled} onClick={() => onPick(c, o.value)}>
                <strong>{textOf(o.label)}</strong>{o.content ? <span>{textOf(o.content)}</span> : null}
              </button>
            ))}
          </div>
          {c.error && <p className="signin-error" role="alert">{textOf(c.error)}</p>}
        </fieldset>
      );
    case 'PollingCollector': // push approval: the dialog polls and continues when the device answers
      return <p className="signin-text" role="status">Waiting for you to approve on your device…</p>;
    case 'SubmitCollector':
    case 'FlowCollector':
      return null; // buttons are drawn in the footer
    default:
      return <p className="signin-error" role="alert">This step uses {c.type}, which this demo cannot show yet.</p>;
  }
}

// completePath: where the code is handed back when the flow succeeds; its answer goes to onClose as `result`.
export default function SignInModal({ config, api, onClose, completePath = '/api/live/signin/complete' }) {
  const [view, setView] = useState({ status: 'loading', collectors: [], name: '', error: '' });
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const client = useRef(null);
  const dead = useRef(false);
  const dialog = useRef(null);
  const protectApi = useRef(null); // Ping's Protect module: collects the device and behaviour signals PingOne Protect asks for
  const autoSteps = useRef(0);
  const lastScreen = useRef(''); // the last screen PingOne showed, named in a failure so it can be told apart
  const pollGen = useRef(0); // bumped for each poll: an answer to an older poll is ignored

  // PingOne Protect asks for device data on its own screen. Collect it with Ping's Protect module and set it on the collector; a screen that
  // has nothing else for the user to do then moves on by itself, as PingOne's own sign-in page does.
  const collectProtect = async (c, collector) => {
    try {
      if (!protectApi.current) {
        const cfg = collector.output?.config ?? {};
        protectApi.current = protect({ envId: new URL(config.wellknown).pathname.split('/')[1], behavioralDataCollection: cfg.behavioralDataCollection !== false, universalDeviceIdentification: cfg.universalDeviceIdentification === true });
        const started = await protectApi.current.start();
        if (started?.error) throw new Error(textOf(started.error));
      }
      const data = await protectApi.current.getData();
      if (data && typeof data === 'object' && data.error) throw new Error(textOf(data.error));
      c.update(collector)(data);
      return '';
    } catch (e) { return `Protect data was not collected (${textOf(e?.message) || 'unknown error'}).`; }
  };
  const QUIET = ['ProtectCollector', 'ERROR_DISPLAY', 'SubmitCollector', 'RichTextCollector', 'ReadOnlyCollector', 'NoValueCollector'];

  const show = async (node) => {
    const c = client.current;
    if (node?.status === 'success') return finish(c);
    if (node?.status === 'failure') return setView({ status: 'failure', collectors: [], name: '', error: `${textOf(c.getError?.()?.message) || 'PingOne ended the sign-in. Cancel and try again.'} (HTTP ${node.httpStatus ?? c.getError?.()?.internalHttpStatus ?? '?'}, after the "${lastScreen.current || 'first'}" screen)` });
    const info = c.getClient?.() ?? {};
    let err = node?.status === 'error' ? textOf(c.getError?.()?.message) || 'That did not work. Check the fields and try again.' : '';
    const collectors = c.getCollectors();
    const prot = collectors.find((x) => x.type === 'ProtectCollector');
    const note = prot ? await collectProtect(c, prot) : '';
    const nothingToAsk = collectors.every((x) => QUIET.includes(x.type)) && collectors.some((x) => x.type === 'SubmitCollector');
    if (prot && !note && nothingToAsk && node?.status === 'continue' && autoSteps.current < 4 && !dead.current) {
      autoSteps.current += 1;
      return show(await c.next());
    }
    lastScreen.current = textOf(info.name) || lastScreen.current;
    setView({ status: 'continue', collectors, name: textOf(info.name), description: textOf(info.description), error: err || note });
    const poll = collectors.find((x) => x.type === 'PollingCollector');
    if (poll) runPoll(c, poll);
  };

  // Push approval: wait for PingOne's answer, hand it to the collector, then continue.
  const runPoll = async (c, poll) => {
    const g = ++pollGen.current;
    setBusy(true);
    try {
      const r = await c.pollStatus(poll)();
      if (dead.current || g !== pollGen.current) return;
      if (r && typeof r === 'object') { setView((v) => ({ ...v, error: textOf(r.message) || 'Waiting for your device failed. Cancel and try again.' })); return; }
      c.update(poll)(r);
      await show(await c.next());
    } catch (e) { if (!dead.current && g === pollGen.current) setView({ status: 'failure', collectors: [], name: '', error: textOf(e?.message) || 'Waiting for your device failed.' }); } finally { if (!dead.current && g === pollGen.current) setBusy(false); }
  };

  const finish = async (c) => {
    const auth = c.getClient?.()?.authorization;
    if (!auth?.code) return setView({ status: 'failure', collectors: [], name: '', error: 'PingOne finished the flow without a code. Cancel and try again.' });
    try {
      const result = await api('POST', completePath, { state: auth.state ?? config.state, code: auth.code });
      if (!dead.current) onClose({ done: true, result });
    } catch (e) { setView({ status: 'failure', collectors: [], name: '', error: e.message }); }
  };

  useEffect(() => {
    dead.current = false;
    (async () => {
      try {
        client.current = await davinci({ config: { clientId: config.clientId, redirectUri: config.redirectUri, scope: config.scope, responseType: 'code', serverConfig: { wellknown: config.wellknown } } });
        const node = await client.current.start({ query: config.query });
        if (!dead.current) await show(node);
      } catch (e) { if (!dead.current) setView({ status: 'failure', collectors: [], name: '', error: `Could not start the sign-in: ${textOf(e?.message) || 'PingOne did not answer'}.` }); }
    })();
    return () => { dead.current = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { dialog.current?.querySelector('input,select,button')?.focus(); }, [view.status, view.name]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose({ cancelled: true }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e?.preventDefault();
    if (busy || view.status !== 'continue') return;
    setBusy(true);
    try { await show(await client.current.next()); } catch (err) { setView({ status: 'failure', collectors: [], name: '', error: textOf(err?.message) || 'The sign-in step failed.' }); } finally { if (!dead.current) setBusy(false); }
  };
  const pick = async (c, value) => {
    if (busy) return;
    setBusy(true);
    try { client.current.update(c)(value); await show(await client.current.next()); } catch (err) { setView({ status: 'failure', collectors: [], name: '', error: textOf(err?.message) || 'That choice failed.' }); } finally { if (!dead.current) setBusy(false); }
  };
  const flowButton = async (c) => {
    if (busy) return;
    setBusy(true);
    try { await show(await client.current.flow(c)()); } catch (err) { setView({ status: 'failure', collectors: [], name: '', error: textOf(err?.message) || 'That choice failed.' }); } finally { if (!dead.current) setBusy(false); }
  };

  const submitC = view.collectors.find((c) => c.type === 'SubmitCollector');
  const flowCs = view.collectors.filter((c) => c.type === 'FlowCollector' && !/^cancel$/i.test(textOf(c.output?.label).trim())); // this dialog has its own Cancel
  const ready = view.status === 'continue';
  return (
    <FloatingDialog isOpen noBackdrop onClose={() => onClose({ cancelled: true })} title="Sign in" closeAriaLabel="Close sign-in"
      footer={null} className="signin-dialog" testId="signin-modal" defaultWidth={420} defaultHeight={null} defaultY={96} minHeight={200}>
      <form ref={dialog} onSubmit={submit} noValidate>
        {view.status === 'loading' && <p className="signin-text" role="status">Opening PingOne…</p>}
        {ready && view.collectors.map((c) => <Collector key={`${c.id}-${c.type}`} c={c} client={client.current} disabled={busy} onChange={() => bump((n) => n + 1)} onPick={pick} />)}
        {view.error && <p className="signin-error" role="alert">{view.error}</p>}
        {ready && flowCs.length > 0 && <div className="signin-flows">{flowCs.map((c) => <button type="button" key={c.id} className="signin-link" disabled={busy} onClick={() => flowButton(c)}>{plain(c.output?.label)}</button>)}</div>}
        <div className="signin-actions">
          <button type="button" className="signin-cancel" onClick={() => onClose({ cancelled: true })}>Cancel</button>
          {ready && submitC && <button type="submit" className="primary signin-submit" disabled={busy || !submitC}>{busy ? 'Signing in…' : plain(submitC?.output?.label) || 'Sign in'}</button>}
        </div>
        {ready && <details className="signin-details"><summary>Screen details</summary>
          <p>{view.name || 'PingOne screen'}: {view.collectors.map((c) => `${c.type} ${textOf(c.output?.label)}`.trim()).join(' · ')}</p></details>}
      </form>
    </FloatingDialog>
  );
}
