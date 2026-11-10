import { useEffect, useRef, useState } from 'react';

// "Connect muse.ai": tells a person exactly how to add the Airline Connector to muse.ai (a cloud assistant used as the MCP client) and how the
// booking prompts work. The facts come from GET /api/connector/info (public facts only); nothing here is a secret.
// Real / connector-enabled: the full card. Mock: one line saying the connector is not enabled in this mode.

// Each example with what it does. muse.ai's assistant asks for a destination and a day before it acts, so the examples include both; the
// connector ignores the day and needs only a price or a destination.
export const EXAMPLES = [
  { prompt: 'Book me a flight to London for $620 tomorrow', outcome: 'Blocked: over the $500 limit.' },
  { prompt: 'Book me a flight to Denver for $450 tomorrow', outcome: 'Booked at your $450, noting the airline lists $180.' },
  { prompt: 'Book me a flight to Denver tomorrow', outcome: "Booked at the airline's $180." },
  { prompt: 'Book me a flight to Seattle for $500 tomorrow', outcome: 'Booked: exactly at the limit.' },
  { prompt: 'List the flights I can book', outcome: 'Lists the flights and their prices.' },
  { prompt: 'How many points do I have?', outcome: 'Shows your points balance.' },
];
export const EXAMPLE_PROMPTS = EXAMPLES.map((e) => e.prompt);

// The prompt a person pastes into muse.ai so that muse.ai sets the connector up itself.
export function buildPrompt(info) {
  const name = `${info.airline || 'SkyHigh'} Airline Connector`;
  const fallback = info.clientId
    ? ` If registration fails or asks for a client ID, use client ID ${info.clientId}: it is a public client with no client secret, PKCE S256, scope ${info.scope || 'mcp'}.`
    : '';
  return `Set up an MCP connector for me. Name: ${name}. URL: ${info.url}. It uses OAuth. If you can register yourself automatically, do that.${fallback} When it sends me to PingOne to sign in I will sign in as the demo user. Once it is connected, list the tools you got.`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* no clipboard permission (or an insecure page): fall back to a selection copy */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch { return false; }
}

// A real button (Enter and Space work), a visible "Copied" next to it, and the same text in a polite live region for screen readers.
export function CopyButton({ text, what, testId }) {
  const [state, setState] = useState(null); // null | 'copied' | 'failed'
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const press = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 2500);
  };
  return (
    <span className="cm-copy">
      <button type="button" className="cm-copy__btn" onClick={press} aria-label={`Copy ${what}`} data-testid={testId}>Copy</button>
      <span className={`cm-copy__state${state ? ' on' : ''}`} role="status" aria-live="polite" data-testid={testId ? `${testId}-state` : undefined}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed: select the text and copy it yourself' : ''}
      </span>
    </span>
  );
}

function Fact({ label, value, testId, copy = true }) {
  return (
    <div className="cm-fact">
      <dt>{label}</dt>
      <dd>
        <code data-testid={`${testId}-value`}>{value}</code>
        {copy && <CopyButton text={value} what={label} testId={`${testId}-copy`} />}
      </dd>
    </div>
  );
}

const HOW = (rules, airline) => [
  <><strong>"for $620"</strong>: the price you state is the price the rules judge. Say "for $620" and $620 is what your limit and the airline's rule look at.</>,
  <><strong>"to London"</strong>: the airline's own price for London is used. Ask for the flights list to see every destination and its price.</>,
  <><strong>Both</strong>, like "to Denver for $450": your price wins, and the answer tells you what the airline lists for that destination.</>,
  <><strong>The rules.</strong> Your own limit (the default is ${rules.agentLimit}) blocks an AI agent's booking that is over it. The airline's rule: only premium members ({rules.premiumTiers.join(', ')}) can book over ${rules.premiumThreshold}. The Test controls card on this page shows the demo user's tier and limit and, where it allows changes, sets them.</>,
  <><strong>What you get back.</strong> Booked, with a confirmation number. Blocked, with the rule that stopped it and the numbers. Or held for approval, which means nothing is booked until a person approves.</>,
  <><strong>One honest caveat.</strong> When you state a price, the rules judge the price the agent states. A real airline would price the ticket itself.</>,
  <><strong>Include a destination and "tomorrow".</strong> muse.ai's assistant asks for a destination and a day first, so include them. The connector ignores the day and only needs a price or a destination. If muse.ai has other airline tools, say "using the {airline} connector" to steer it to this one.</>,
];

export default function ConnectMuseAi({ session, api }) {
  const real = session.mode === 'live';
  const enabled = real && Boolean(session.connector);
  const [info, setInfo] = useState(null);
  const [problem, setProblem] = useState(null);
  const [rules, setRules] = useState({ agentLimit: 500, premiumThreshold: 750, premiumTiers: ['Premier Gold'] });
  useEffect(() => {
    if (!enabled) { setInfo(null); setProblem(null); return undefined; }
    let live = true;
    api('GET', '/api/connector/info').then((r) => { if (live) { setInfo(r); setProblem(null); } }).catch((e) => { if (live) { setInfo(null); setProblem(e.message); } });
    api('GET', '/api/flights').then((r) => { if (live && r?.rules) setRules({ agentLimit: r.rules.agentLimit, premiumThreshold: r.rules.premiumThreshold, premiumTiers: r.rules.premiumTiers ?? ['Premier Gold'] }); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, api]);

  if (!enabled) {
    return (
      <section className="disco connect-muse" aria-labelledby="cm-title" data-testid="connect-muse" data-state="off">
        <h2 id="cm-title">Connect muse.ai</h2>
        <p className="muted small" data-testid="connect-muse-off">
          {real
            ? 'The Airline Connector is not enabled on this build, so there is nothing to connect muse.ai to. The owner turns it on in Muse\'s own .env (MUSE_CONNECTOR).'
            : 'The Airline Connector is not enabled in Mock mode. Switch to Real (top right) to see how to connect muse.ai.'}
        </p>
      </section>
    );
  }
  if (!info) {
    return (
      <section className="disco connect-muse" aria-labelledby="cm-title" data-testid="connect-muse" data-state={problem ? 'error' : 'loading'}>
        <h2 id="cm-title">Connect muse.ai</h2>
        <p className={problem ? 'bad small' : 'muted small'} role={problem ? 'alert' : undefined}>{problem ? `Could not load the connection details: ${problem}` : 'Loading the connection details...'}</p>
      </section>
    );
  }

  const prompt = buildPrompt(info);
  const redirects = info.redirectUris ?? [];
  return (
    <section className="disco connect-muse" aria-labelledby="cm-title" data-testid="connect-muse" data-state="ready">
      <h2 id="cm-title">Connect muse.ai</h2>
      <p className="muted small">muse.ai is a cloud assistant. Once you add this connector, you can ask it to book {info.airline} flights, and the rules on this page decide what goes through.</p>

      {info.publicReachable === false && (
        <div className="cm-warn" role="status" data-testid="connect-muse-warning">
          <strong>Not reachable from the internet.</strong> muse.ai runs in the cloud and cannot reach this address. Use the hosted URL.
        </div>
      )}

      <dl className="cm-facts" aria-label="Connection details">
        <Fact label="MCP URL" value={info.url} testId="cm-url" />
        {info.clientId
          ? <Fact label="Client ID" value={info.clientId} testId="cm-client" />
          : <div className="cm-fact"><dt>Client ID</dt><dd><span className="muted small" data-testid="cm-client-none">None to type: muse.ai registers itself.</span></dd></div>}
        <Fact label="Client secret" value="none" testId="cm-secret" />
        <Fact label="PKCE" value="S256" testId="cm-pkce" />
        <Fact label="Scope" value={info.scope} testId="cm-scope" />
        {redirects.length > 0
          ? redirects.map((u, i) => <Fact key={u} label={redirects.length > 1 ? `Redirect URI ${i + 1}` : 'Redirect URI'} value={u} testId={`cm-redirect-${i}`} />)
          : <div className="cm-fact"><dt>Redirect URI</dt><dd><span className="muted small" data-testid="cm-redirect-none">None to type: muse.ai tells the connector its own when it registers.</span></dd></div>}
      </dl>

      <div className="cm-step">
        <h3>Step 1: ask muse.ai to add it</h3>
        <p className="small">Copy this and paste it into muse.ai. It sets the connector up itself.</p>
        <pre className="cm-prompt" tabIndex={0} aria-label="Prompt to paste into muse.ai" data-testid="cm-prompt">{prompt}</pre>
        <CopyButton text={prompt} what="the prompt for muse.ai" testId="cm-prompt-copy" />
      </div>

      <div className="cm-step">
        <h3>Step 2: sign in</h3>
        <p className="small">muse.ai sends you to PingOne. Sign in as the demo user, then accept the "Allow the Airline Connector to act for you" screen.</p>
      </div>

      <div className="cm-step">
        <h3>Step 3: check you have four tools</h3>
        <ul className="cm-tools" aria-label="Tools muse.ai should list">{info.tools.map((t) => <li key={t}><code>{t}</code></li>)}</ul>
        <p className="small" data-testid="cm-tools-note">If muse.ai shows only two (<code>loyalty_balance</code> and <code>get_loyalty_status</code>), it is on an old connector. Remove it and add it again.</p>
      </div>

      <div className="cm-step">
        <h3>Step 4: try these prompts</h3>
        <ul className="cm-prompts" aria-label="Example prompts">
          {EXAMPLES.map(({ prompt: p, outcome }, i) => (
            <li key={p}><q data-testid={`cm-example-${i}`}>{p}</q> <CopyButton text={p} what={`the prompt "${p}"`} testId={`cm-example-copy-${i}`} /> <span className="muted small" data-testid={`cm-example-outcome-${i}`}>{outcome}</span></li>
          ))}
        </ul>
      </div>

      <div className="cm-step" data-testid="cm-how">
        <h3>How the prompts work</h3>
        <ol className="cm-how">{HOW(rules, info.airline || 'SkyHigh').map((t, i) => <li key={i}>{t}</li>)}</ol>
      </div>
    </section>
  );
}
