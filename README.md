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


## Real sign-in through PingOne, acting for the user (owner-run)

Muse redirects to PingOne; PingOne handles login. Then Muse acts on the user's behalf (RFC 8693) and calls Agent Gateway.

    NODE_EXTRA_CA_CERTS=<mkcert root CA> ALLOW_LIVE=1 \
    MUSE_LIVE_GATEWAY_URL=https://api.ping.demo:3036/mcp \
    MUSE_P1_ENV_ID=<env id> MUSE_P1_CLIENT_ID=<Muse app id> MUSE_P1_CLIENT_SECRET_FILE=<file, mode 600> npm start

Flow: sign in (auth code + PKCE, `prompt=login`, resource and scope for the gateway) -> Muse's own agent token (`client_credentials`) -> exchange 1 (user + actor, stamps `act`) -> exchange 2 (gateway audience, `act` carried) -> gateway call with `X-Token-Validation: jwks` and `MCP-Protocol-Version` -> `tools/call loyalty_balance`.

PingOne needs: an OIDC web app for Muse (auth code, client credentials, token exchange, secret, its callback URI), grants on the gateway resource (`gateway:mcp:invoke`) and the workload resource (`agent:invoke`), and Muse's client id added to the Authorize `HasValidActorChain` list (snapshot import). Verified live 2026-10-27: Authorize PERMIT, `loyalty_balance` returned points. Not yet built: the DaVinci login flow with Protect that detects Muse, and consent.


## Real Muse with a local model (llama.cpp, optional)

Set `MUSE_LLM_URL` to an OpenAI-compatible server on this machine (for example `http://127.0.0.1:8090`, optionally `MUSE_LLM_MODEL`). In Real mode the model then does two jobs:

1. **Picks the tool.** Before the 401, Muse asks the model which of its own tools fits the request (`loyalty_balance`, `get_loyalty_status`) or none. The model answers JSON; Muse accepts only a name from its own list. It never writes tool arguments and never sees a token. A request it declines gets a fixed sentence and nobody is sent to PingOne.
2. **Words the reply.** After the tool runs, the model writes one or two sentences from the result. Muse checks that every number in the reply comes from the result, otherwise it uses the plain sentence.

If the model is off, slow or wrong, Muse falls back to keyword matching and says so in the step list. The address must be loopback (or listed in `MUSE_LLM_ALLOW_HOSTS`), and a hosted build never gets a model. Without `MUSE_LLM_URL` nothing changes.

## The Airline Connector: Muse as a connector for other agents (for example Meta's Muse at muse.ai)

With `MUSE_CONNECTOR=1`, real mode configured and an https `MUSE_PUBLIC_URL`, this app also acts as the **Airline Connector**,  a standard MCP server with OAuth, so another agent can add it as a custom connector (remote streamable HTTP, OAuth).

- **MCP endpoint:** `<public address>/mcp` (JSON responses, `initialize`, `tools/list`, `tools/call`). Tools: `loyalty_balance` and `get_loyalty_status`, answered through the gateway.
- **Sign-in:** `/connector/authorize` sends the user to the same PingOne flow as the app (login, Protect, agent-detected screen, consent). `/connector/callback` does the on-behalf-of exchanges. `/connector/token` gives the agent its own opaque token (PKCE S256, one-use code, no refresh token, at most an hour). The agent never receives the delegated token.
- **Clients:** dynamic registration (`/connector/register`) is offered only for redirect hosts you list in `MUSE_CONNECTOR_REDIRECT_HOSTS` (comma separated, https only). For an agent that asks you to type a client id, set `MUSE_CONNECTOR_CLIENT_ID` and `MUSE_CONNECTOR_REDIRECT_URIS`. With neither set, nothing can be issued.
- **PingOne:** the Muse app needs `<public address>/connector/callback` as a redirect URI.
- Refused registrations and authorizations log the redirect host only, so you can see what an agent asked for.
