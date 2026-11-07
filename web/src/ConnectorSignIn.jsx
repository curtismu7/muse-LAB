import { useEffect, useState } from 'react';
import SignInModal from './SignInModal.jsx';

// /connector/signin: where an assistant's customer lands from /connector/authorize. The sign-in runs here, in the Sign in dialog (pi.flow), not on a
// PingOne login page. When it is done the server answers with the assistant's own redirect address, and this page opens it (that return is the OAuth
// redirect back to the assistant, not a login redirect).
async function call(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

export default function ConnectorSignIn() {
  const flow = new URLSearchParams(window.location.search).get('flow') ?? '';
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { call('GET', `/connector/signin/config?flow=${encodeURIComponent(flow)}`).then(setCfg).catch((e) => setError(e.message)); }, [flow]);

  const onClose = async (result) => {
    try {
      const r = result.done ? result.result : await call('POST', '/connector/signin/complete', { state: flow, error: 'access_denied' });
      if (r?.redirectTo) window.location.assign(r.redirectTo);
    } catch (e) { setError(e.message); }
  };

  return (
    <main className="connector-signin">
      <h1>Sign in</h1>
      {error ? <p className="signin-error" role="alert">{error}</p>
        : <p>{cfg ? `Sign in so ${cfg.agent ?? 'your assistant'} can act for you.` : 'Opening the sign-in…'}</p>}
      {cfg && !error && <SignInModal config={cfg.piflow} api={call} onClose={onClose} completePath="/connector/signin/complete" />}
    </main>
  );
}
