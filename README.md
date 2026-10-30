# Muse

Tier: Demo

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

## Branding, stories and the network guard
- **Name and wording** come from `server/src/customer.config.json` (set `MUSE_CUSTOMER_CONFIG` to use your own file): `brandName` is the site's name, `agentName` the personal agent in the story, `vertical` the default story.
- **Stories** are data in `server/src/stories.json`: three vertical packs (airline, bank, hotel), each with a cast and text using `{{cast.x}}` tokens. `GET /api/story?vertical=bank` serves one; the clients page has a story picker. A typo in a token fails the tests.
- **Network guard:** in mock mode the server refuses every outbound call that is not loopback and counts them; `GET /api/netguard` shows the count and its self-test, and `node scripts/doctor.mjs` fails if it is not zero.

## Hosted builds (SE cluster)
`k8s/deploy.sh` deploys the same image in one of two modes (`APP_NAME` names every object):

- **Mock-only** (`MODE=mock`, the default): live mode is refused even if a Secret is present; sign-in, Protect and the gateway run in the existing offline mock (no stub servers), the Airline Connector is off (`/mcp` answers 404), `/clients.html` plays its scripted run, and the page says "This is the hosted, mock-only build". Per-visitor workspaces, no secrets. The owner runs a hosted copy on the SE cluster as `APP_NAME=muse-mock`.
- **Real** (`MODE=live`, owner-run): reads the Secret `<APP_NAME>-real`, which holds `ALLOW_LIVE=1`, `MUSE_ALLOW_LIVE_HOSTED=1`, `MUSE_PUBLIC_URL` and the tenant settings. Nothing tenant-specific is in this repo. The server refuses `MODE=live` without `ALLOW_LIVE=1`.

## Real mode in local Docker (owner-run)
The image is the hosted build, which refuses real mode on a plain-http address. For local Docker only, set `MUSE_ALLOW_LIVE_LOOPBACK=1` with `MUSE_ALLOW_LIVE_HOSTED=1` and a loopback `MUSE_PUBLIC_URL` (for example `http://127.0.0.1:5102`), and publish the port on `127.0.0.1` only (`-p 127.0.0.1:5102:5100`). The opt-in does not allow any other http address. The PingOne apps need `<MUSE_PUBLIC_URL>/connector/callback` as a redirect URI (and `<MUSE_PUBLIC_URL>/connector/resume` as a post-logout redirect URI when `MUSE_CONNECTOR_SIGNOUT_FIRST=1`).

## Use your own PingOne and PingFederate
`cp .env.example .env`, fill it in, then `npm start`. The server reads `.env` when it starts; anything already set in the environment wins. Without a `.env` Muse is the offline mock. Real mode runs with `npm start` only: the Docker image is the hosted build (`MUSE_HOSTED=1`), which allows real mode only behind an https public address.

What to create in your PingOne environment (the `.env.example` comments name the matching setting):
1. **Muse's app**: OIDC web app with authorization code + PKCE, client credentials and token exchange, client secret post. Redirect URIs `<MUSE_PUBLIC_URL>/api/callback` and, for the connector, `<MUSE_PUBLIC_URL>/connector/callback`.
2. **Resources and scopes**: a workload resource with `agent:invoke` (Muse's own agent token) and the gateway's resource with the scope in `MUSE_P1_GATEWAY_SCOPE`. Grant both to Muse's app. The token exchange must set `act` to Muse's client id.
3. **Your gateway** (`MUSE_LIVE_GATEWAY_URL`) must accept PingOne tokens for that audience and an `act` of each agent app.
4. Optional: a user app with no agent (`MUSE_USER_CLIENT_ID`), one app per assistant (`MUSE_CONNECTOR_AGENTS`), and a DaVinci sign-in flow with Protect, consent and the agent screen, assigned to those apps. The login hint suffixes `.conn` and `.nomfa` are how the flow tells the paths apart.

PingFederate (optional, the CIMD path): set `MUSE_PF_ISSUER`. ChatGPT, Claude and Codex then present a client ID metadata document instead of registering, as they do with servers that advertise CIMD. Muse serves `/mcp-pf` with PingFederate as its authorization server, labelled copies of the three documents at `/sim/<platform>/client.json` (Muse's own callbacks), and ChatGPT's JWKS for its `private_key_jwt`. In PingFederate 13.1 or later you need: CIMD on; one CIMD policy per document URL with PKCE required; a JWT access token manager with its own signing key and `aud` = `<MUSE_PUBLIC_URL>/mcp-pf`; the scope `MUSE_PF_SCOPE` (default `muse:mcp`); and an access token mapping from your sign-in adapter to that manager. `/mcp-pf` checks the signature against PingFederate's JWKS, plus `iss`, `aud`, `exp` and the scope, then answers from Muse's demo record; the airline gateway is only on the PingOne path.

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
- **Assistants with their own PingOne app:** `MUSE_CONNECTOR_AGENTS` is a JSON list of `{ name, hosts, clientId, clientSecret }` (for example ChatGPT on `chatgpt.com`, Claude on `claude.ai`). The agent's callback host picks the app, so Protect and the PingOne screens name the agent and the token's `act` is that agent. Their hosts may register. Agents not listed use Muse's app.
- **Connect from your assistant:** the page's customer path. A stand-in directory card per assistant (the listed ones plus Meta AI, which uses Muse's app). Connect (`POST /api/sim/start {platform}`) then does what that platform does as an MCP client, against Muse's real connector (`server/src/platforms.js`): `/mcp` without a token (401), the protected-resource and authorization-server metadata, then CIMD if the server advertises it or dynamic registration otherwise (Muse's connector has no CIMD, so today it is registration), authorization code with PKCE S256 and `resource`, the PingOne sign-in with that assistant's own app, the token, `initialize`, `tools/list` and `tools/call`. Each request and response is shown. Stand-ins, labelled on the page: the callback (`/sim/<platform>/callback` instead of chatgpt.com or the customer's loopback) and the model's choice of tool. The older `POST /api/live/signin` with `as: 'assistant'` still works for `/clients.html`.
- **PingOne:** the Muse app needs `<public address>/connector/callback` as a redirect URI; each assistant's app needs both `<public address>/connector/callback` and `<public address>/api/callback`.
- Refused registrations and authorizations log the redirect host only, so you can see what an agent asked for.
