// Sam signs in as himself: no agent, no consent, no exchange. Then his own token goes straight to the gateway, which should refuse it.
export default function UserLoginPanel({ session, api, guarded, mfaOff }) {
  if (session.mode !== 'live' || !session.live?.userLogin) return null;
  const u = session.userLogin;
  const start = () => guarded(async () => { if (!session.discovery) await api('POST', '/api/discover'); const r = await api('POST', '/api/live/signin', { as: 'user', mfa: mfaOff ? 'off' : 'on' }); window.location.assign(r.url); });
  const last = u?.steps?.filter((s) => s.response).slice(-1)[0];
  return (
    <section className="disco userlogin" aria-label="Sign in as a user" data-testid="user-login-panel">
      <strong>Just a user, no agent</strong>
      <p className="muted small">Sam signs in as himself. PingOne shows no "AI agent detected" screen and no consent, and nothing is exchanged. His own token then goes straight to the gateway.</p>
      <button type="button" onClick={start}>Sign in as Sam (no agent)</button>
      {u && (
        <div data-testid="user-login-result">
          {u.error && <p className="muted small">{u.error}</p>}
          {u.claims && <p className="small">Token: <code>sub {String(u.claims.sub).slice(0, 8)}…</code>, <code>{u.claims.act ? 'act present' : 'no act claim'}</code>, aud <code>{JSON.stringify(u.claims.aud)}</code></p>}
          {u.denied === true && <p className="small" data-testid="user-denied"><strong>Denied.</strong> The gateway refused Sam's own token ({last?.response?.status}). Only a token that names an agent acting for him gets through.</p>}
          {u.denied === false && <p className="small" data-testid="user-allowed"><strong>Allowed.</strong> The gateway accepted Sam's own token ({last?.response?.status}).</p>}
        </div>
      )}
    </section>
  );
}
