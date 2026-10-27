# Muse

A personal agent demo. Muse is a browser front end. It signs in with a simulated PingOne flow, which calls a
DaVinci-shaped detection flow ("Muse-detect"). Each tool call then passes a Agent Privilege-shaped gateway:

1. **Muse-detect** (DaVinci-shaped, simulated): bursts of calls are held; instructions hidden in tool arguments are blocked.
2. **Coarse check**: which personas may call a tool at all.
3. **Fine check**: the business rule inside an allowed call (payments over 500 need a person; exports capped at 100 rows).

The most restrictive answer wins. Held calls wait for a simulated CIBA approval.

## Run locally
    npm install
    npm start        # http://127.0.0.1:5100/

## Test
    npm test
    npm run build

## Real or fake Agent Privilege (owner-run)
On the sign-in screen, **Call Agent Privilege with no token** shows the 401 and the two metadata reads. The switch picks which Agent Privilege answers:
**Fake** is static and never leaves the page; **Real** calls one Agent Privilege endpoint you name, read-only (one unauthenticated POST and two GETs).

    ALLOW_LIVE=1 MUSE_LIVE_GATEWAY_URL=https://<gateway>/<app>/mcp npm start

Live is refused on the hosted build and unless both variables are set. Only that origin (plus any in `MUSE_LIVE_ALLOW_ORIGINS`) is contacted, no redirects are followed.

After the three read-only steps, three buttons go further: **4 Register Muse** (one dynamic client registration, a real write at the gateway's authorization server, only on click, redirect URI `http://127.0.0.1:<port>/api/callback`), **5 Sign in** (auth code + PKCE S256, `resource` = the gateway) and **7 Call with the token** (initialize, then tools/list). The token is held on the Muse server; the page shows only its claims, and says if the audience is not the gateway. If the authorization server has no registration endpoint, Muse stops and says so (CIMD is not built). Real sign-in has been tested against a fake network only, not yet against the real gateway.

## Honest scope
Simulated: PingOne sign-in, the DaVinci flow, Privilege and approvals. No tenant, no real money or mail. OBO (token exchange) is coming soon: the pattern diagram shows it, marked as such, and nothing here performs it.
