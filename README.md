# Muse LAB

Tier: Demo

Repo: https://github.com/curtismu7/muse-LAB

A personal agent demo. Muse is a browser front end. It signs in with a simulated PingOne flow, which calls a
DaVinci-shaped detection flow ("Muse-detect"). Each tool call then passes a Agent Privilege-shaped gateway:

1. **Muse-detect** (DaVinci-shaped, simulated): bursts of calls are held; instructions hidden in tool arguments are blocked.
2. **Coarse check**: which personas may call a tool at all.
3. **Fine check**: the business rule inside an allowed call (payments over 500 need a person; exports capped at 100 rows).

The most restrictive answer wins. Held calls wait for a simulated CIBA approval.

## Book a flight: two rules stop a booking

The "Book a flight" panel (both modes) shows Muse calling the Agent Gateway to book a flight, the gateway asking PingOne Authorize, and two rules from two owners:

- **Your rule** (owner: you): *no tickets bought by an AI agent over $500.* Applies only when an agent is acting. The $500 is your own setting (gateway-side data, default 500), not part of the rule. A person booking directly ("Sam directly, no agent") is not limited by it.
- **Airline rule** (owner: the airline): *only premium members can book over $750.* Applies to every caller. The member tier is a custom field on the PingOne user, the user-schema attribute `airlineMemberTier` (STRING), and **PingOne Authorize reads it from the PingOne user itself**; the gateway does not look it up or send it. Premium is an explicit list, currently `Premier Gold` (the owner does not care whether it is called Gold or premium). Premier Silver, any other value, an empty value and a missing attribute are **not premium** (fail closed).

Both are strict "over": exactly $500 and exactly $750 pass. When both fail, both are listed ("2 rules denied this booking"). On this page the fare that is judged always comes from the catalogue by flight id (`SH101`-`SH109`), never from what the caller says (the Airline Connector can also book at a price the user states: see *Booking from muse.ai*). The panel has ten scenario rows (the nine contract scenarios plus row 10, a user with no `airlineMemberTier`: $940 direct is denied by the airline rule), a free flight picker and a "try to lie" button; the banner reads "Authorize rule applied: booking stopped", the five-hop trace shows the attributes Authorize was given and the rule that fired, and the ledger ("Bookings made this session") stays at "Nothing booked." on a deny. The scenario rows are labelled by destination and price ("Boston $480") with the flight id as small secondary text; the ids, test ids and rules behind the rows are unchanged.

**Honesty.** Mock is a local stand-in: its rules live in `server/src/fares.js` and every Mock hop says "simulated"; it never claims to be PingOne Authorize. The three Mock members (Standard = `Premier Silver`, Premium = `Premier Gold`, No tier set = no attribute) are labelled as a Mock PingOne user that mimics the `airlineMemberTier` attribute; there is no tenant behind them. Real sends `tools/call book_airline_flight {flight_number, amount}` to the gateway at `MUSE_LIVE_GATEWAY_URL` and reads the answer, including the gateway's `X-Gw-Audit-Trail` header, which is where the rule names come from. Real is wired and tested against stubs only. It stays unproven until the owner has imported the policy change into PingOne Authorize, restarted the gateway and signed in. A booking that passes both rules still meets the consent gate (HTTP 428) in Real, and Muse does not approve it. In Real the tier is Authorize's own read, so Muse usually cannot show its value: the trace says `Member tier not reported to Muse, read from the PingOne user attribute airlineMemberTier (read by Authorize)` and never invents one. Muse shows a value only if the gateway's answer happens to carry it, with the same source label. See `docs/talk-track.md` and the AI-DEMO2 import note (`docs/airline-booking-rules-import.md`) for the owner steps.

**Real setup (owner-run; agents never do these).**

1. The `airlineMemberTier` attribute exists in your PingOne user schema and the demo user holds `Premier Gold`. There is **no `members` entry** to add for the tier: the gateway's data file no longer carries one, and an unmapped or tier-less user is NOT premium.
2. In the Authorize console, create the `MemberTier` attribute with the PingOne User resolver (reads `airlineMemberTier`), merge and import the rules, publish, restart the gateway (steps in the AI-DEMO2 import note).
3. In Muse, switch to Real and run the rows. While the demo user holds `Premier Gold`, a direct $940 booking is allowed (row 8); rows 7, 9 and 10 only show the airline rule after you change the user (step 4).
4. To demo the airline rule in Real, press **Premier Silver** in the *Test controls* card (needs the switch below), run rows 7 and 9, then press **Premier Gold** and run row 8. For row 10, press **No tier set** (the card clears `airlineMemberTier` on the demo users). To demo your own rule, press **$250**, **$500**, **$1000** or type an amount: the card writes `agentSpendLimit` on the demo users and Authorize uses it on the next booking. Without the switch, flip the demo user in PingOne yourself, for example with the AI-DEMO2 owner script `scripts/set-airline-member-tier.js <username> "Premier Silver" --apply`.
5. Nothing here has been run against a real tenant by an agent. Real stays unproven until you do.

### Test controls: member tier and agent limit (owner-approved 2026-11-09, opt-in)

The *Test controls* card at the top of Book a flight is one control for both modes, for the two PingOne fields that decide a booking:

- **Member tier:** **Premier Gold** (premium), **Premier Silver** (standard) and **No tier set**. The airline's rule: only premium members can book over $750.
- **Agent spend limit:** presets **$250**, **$500**, **$1000**, a custom amount (whole dollars, 1 to 100000, checked in the browser and again on the server) with **Apply**, and **Default**. It is the user's own cap for tickets bought by an AI agent; a booking the person makes directly is not limited by it. The PingOne user-schema attribute is `agentSpendLimit` (STRING, dollars as text such as `"500"`); PingOne Authorize reads it live, and an empty field means its default of $500.

The card always shows the current tier and limit, and the scenario table's "Rules say" column follows the limit in force.

- **Mock:** the card sets the Mock PingOne user (tier) and the Mock agent limit that the simulated Authorize reads, so one control rules both modes (running a row sets the row's tier and uses the limit above; the card follows). Reset, sign-out and a mode switch put both back to Silver and the default limit. Nothing leaves the machine.
- **Real:** the card **writes the PingOne user attributes** `airlineMemberTier` and `agentSpendLimit` on your demo users through the PingOne Management API: `PATCH /v1/environments/{env}/users/{id}` with exactly the attribute(s) you changed, `{"airlineMemberTier": value}`, `{"agentSpendLimit": "500"}` or both in one request so a user is never half-updated; clearing sends `null`. It then **reads each user back** and shows what PingOne now holds, per user, with "verified" only when every field you sent reads back as sent. Both demo users are changed together. If a write fails or PingOne still holds another value, the card says which user and why; it never reports a success it did not read back. Clearing with `null` is unverified against a real tenant: if PingOne keeps the old value the read-back shows it.
- **Opt-in, and off unless configured.** The controls work in Real only when `MUSE_TIER_ENABLE=1` **and** the worker credential and user ids are set. The Docker container always runs with `MUSE_HOSTED=1` (it must bind a non-loopback address), so the flag is what lets the owner's container use them; a build with `MUSE_HOSTED=1` and no `MUSE_TIER_ENABLE` refuses and the card says so. The SE deployment never sets `=1`. With anything missing the card is disabled and lists the variable names to set.
- **Read-only mode for a public hosted URL: `MUSE_TIER_ENABLE=read`.** Exactly `1` writes, exactly `read` only reads, and every other value (unset, `0`, `true`, `READ`) is off. In read mode the worker credential is still used, but only to read: `readUserFacts` (the signed-in user's limit for the pre-approval) and the card's *Check PingOne* read work with the same allow-list, token handling, scrubbing, timeouts and rate limit. **Every write path is refused with a plain message and no PingOne call**: `POST /api/booking/tier` answers 403 `read_only`, the switch's `apply` and `switchTo` refuse before they build a request, and in Real the card's tier and limit buttons are disabled with "Read-only here: change the tier and limit on the local Muse page". `GET /api/booking/tier` reports `mode: "read-only"` (with `source: "real"`). In Mock, read mode changes nothing: the Mock controls only change that visitor's own workspace and never call PingOne. **On a public URL the write switch (`=1`) must stay off**: anyone who can open the page could otherwise change the demo users in PingOne.
- **For a later connector change:** `readUserFacts(userId)` on the tier switch (`server/src/tier.js`) reads `{tier, limit}` (limit a number or null) for an allow-listed user only; it is not wired into the connector yet.

**Deviation from the standalone rulebook (owner-approved 2026-11-09, opt-in flag required).** The rulebook keeps PingOne admin credentials out of standalone apps. The owner asked for these controls inside the app, so this one feature holds a runtime credential under hard limits, and only when the opt-in flag `MUSE_TIER_ENABLE=1` is set:

- A **dedicated worker app** that can only update users, supplied in Muse's own `.env` (`MUSE_TIER_ENABLE`, `MUSE_TIER_WORKER_CLIENT_ID`, `MUSE_TIER_WORKER_CLIENT_SECRET`, `MUSE_TIER_USER_IDS`, optionally `MUSE_TIER_ENV_ID` and `MUSE_TIER_REGION`, which default to `MUSE_P1_ENV_ID` and `MUSE_P1_REGION`). Never `provisioning.json`, never committed. Its token endpoint auth must be client secret basic.
- The only attributes ever written are `airlineMemberTier` (exactly `Premier Gold`, `Premier Silver` or clear) and `agentSpendLimit` (digits only, 1 to 6 characters, whole dollars 1 to 100000, written as text, or clear); the only users are the ids in `MUSE_TIER_USER_IDS`. An id or an attribute name can never come from a request: the body is `{member?: standard|premium|none, limit?: <dollars>|"default"}` and unknown fields are ignored.
- Tested against stubs only (`server/test/tier.test.js`). Agents never call a real tenant; the first real write is yours.

## Run from a clone

Prerequisites: Node 26. Docker (OrbStack) only for the Docker form.

```
git clone https://github.com/curtismu7/muse-LAB.git
cd muse-LAB
npm ci
npm run build
npm run doctor
PORT=5100 MODE=mock npm start
```

## Ports, and what to do if the port is taken

```
Ports: muse listens on 5100 (set with PORT, default 5100).
Port range for this app: 5100.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:5100 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
```

Other variable: `HOST_PORT` (Docker host port, default 5100). `LAB_ALLOWED_HOSTS`: comma-separated host names (no ports) the app answers to besides loopback, as `<name>:<PORT>`; Docker defaults it to the name the family lab-proxy sends in Host (see `docker-compose.yml`), and on that Host only a write whose Origin equals `X-Forwarded-Proto://X-Forwarded-Host` counts as same-origin.

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

### In-cluster gateway address (`MUSE_ALLOW_LIVE_INCLUSTER`)
A hosted Real build that runs in Kubernetes next to the gateway can call it by its in-cluster Service address, for example `MUSE_LIVE_GATEWAY_URL=http://ping-gateway:8080/mcp` (no TLS inside the cluster). Plain http to a non-loopback gateway is refused everywhere else, and is allowed here only when **all** of these hold:

- `MUSE_ALLOW_LIVE_INCLUSTER` is exactly `1` (opt-in; `true`, `0`, ` 1` and unset are off), **and** `MUSE_HOSTED` is exactly `1`;
- the protocol is `http:` and the URL has no username or password;
- the host is **one DNS label** (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, so no dot) and is not purely numeric.

Why this is safe: a single label has no dot, so it cannot be a public host name. It resolves only through the cluster's own DNS search path (a Service name). An IPv4 address in any spelling (`10.0.0.1`, `http://10/`, which the URL parser turns into `0.0.0.10`, `0x7f.1`) always contains dots after parsing, and an IPv6 literal has brackets, so none passes. A name with a dot (`ping-gateway.ns.svc`, `example.com`) is refused: use https for those. Nothing else changes: hosted Real still needs `MUSE_ALLOW_LIVE_HOSTED=1` and an https `MUSE_PUBLIC_URL`; the gateway origin is the only origin contacted (plus `MUSE_LIVE_ALLOW_ORIGINS`, which stays https only); redirects are never followed; the timeouts and caps are unchanged. Tests: `server/test/incluster-gateway.test.js`.

### Image publish and the public hosted URL (US Kubernetes namespace)
- **Image:** `.github/workflows/image.yml` builds the repo `Dockerfile` on a push to `main` (or by hand) for linux/arm64 on a GitHub-hosted runner, smoke-tests it as the cluster runs it (non-root, read-only root filesystem, a writable `/data`, `/api/health` answering `demo-health/1`), then pushes `ghcr.io/curtismu7/muse-lab:sha-<full commit sha>`. The tag is the only tag (nothing is called latest) and the workflow uses only its own `GITHUB_TOKEN` (packages write, contents read). Deploying it is owner-run; `k8s/deploy.sh` takes `IMAGE` and `SE_HOST`.
- **Public URL settings (names only; values go in the Secret, never in this repo):** `MUSE_PUBLIC_URL` (the https address muse.ai can reach, <your-host>), `MUSE_CONNECTOR=1`, `MUSE_CONNECTOR_AIRLINE`, `MUSE_CONNECTOR_CLIENT_ID` and `MUSE_CONNECTOR_REDIRECT_URIS` for a client that wants an id typed, and **`MUSE_TIER_ENABLE=read`** if the connector should read the user's limit. **Never `MUSE_TIER_ENABLE=1` on a public URL.**
- **Connect muse.ai card:** the page tells a person how to connect muse.ai (below). It warns when the public address is one muse.ai cannot reach.

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

After the three read-only steps, Real sign-in needs the PingOne app (see "Real sign-in through PingOne" below): **4 Use Muse's PingOne app** (no registration; nothing is written at the gateway), **5 Sign in** (the Sign in dialog runs PingOne's flow on the page; auth code + PKCE S256) and **7 Call with the token** (initialize, then tools/list). The token is held on the Muse server; the page shows only its claims, and says if the audience is not the gateway. Without the PingOne app, Real mode refuses to register or sign in (409): there is no redirect fallback and no dynamic client registration at the gateway's own authorization server. Real sign-in has been tested against a fake network only, not yet against the real gateway.

## Honest scope
Simulated: PingOne sign-in, the DaVinci flow, Privilege and approvals. No tenant, no real money or mail. OBO (token exchange) is coming soon: the pattern diagram shows it, marked as such, and nothing here performs it.


## Real sign-in through PingOne, acting for the user (owner-run)

The Sign in dialog runs PingOne's flow on the page (pi.flow); PingOne handles login. Then Muse acts on the user's behalf (RFC 8693) and calls Agent Gateway.

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

- **MCP endpoint:** `<public address>/mcp` (JSON responses, `initialize`, `tools/list`, `tools/call`). Tools: `loyalty_balance` and `get_loyalty_status` (answered through the gateway), `list_flights` (the fixed invented catalogue, no gateway call) and `book_flight` (see below). The PingFederate path (`/mcp-pf`) lists the same four, but it never calls the gateway: `list_flights` answers, `book_flight` books nothing and says so.
- **Sign-in:** `/connector/authorize` sends the user to the same PingOne flow as the app (login, Protect, agent-detected screen, consent). `/connector/callback` does the on-behalf-of exchanges. `/connector/token` gives the agent its own opaque token (PKCE S256, one-use code, at most an hour; a refresh token only if you turn on refresh, see below). The agent never receives the delegated token.
- **Clients:** dynamic registration (`/connector/register`) is offered only for redirect hosts you list in `MUSE_CONNECTOR_REDIRECT_HOSTS` (comma separated, https only). For an agent that asks you to type a client id, set `MUSE_CONNECTOR_CLIENT_ID` and `MUSE_CONNECTOR_REDIRECT_URIS`. With neither set, nothing can be issued.
- **Assistants with their own PingOne app:** `MUSE_CONNECTOR_AGENTS` is a JSON list of `{ name, hosts, clientId, clientSecret }` (for example ChatGPT on `chatgpt.com`, Claude on `claude.ai`). The agent's callback host picks the app, so Protect and the PingOne screens name the agent and the token's `act` is that agent. Their hosts may register. Agents not listed use Muse's app.
- **Connect from your assistant:** the page's customer path. A stand-in directory card per assistant (the listed ones plus Meta AI, which uses Muse's app). Connect (`POST /api/sim/start {platform}`) then does what that platform does as an MCP client, against Muse's real connector (`server/src/platforms.js`): `/mcp` without a token (401), the protected-resource and authorization-server metadata, then CIMD if the server advertises it or dynamic registration otherwise (Muse's connector has no CIMD, so today it is registration), authorization code with PKCE S256 and `resource`, the PingOne sign-in with that assistant's own app, the token, `initialize`, `tools/list` and `tools/call`. Each request and response is shown. Stand-ins, labelled on the page: the callback (`/sim/<platform>/callback` instead of chatgpt.com or the customer's loopback) and the model's choice of tool. The older `POST /api/live/signin` with `as: 'assistant'` still works for `/clients.html`.
- **PingOne:** the Muse app needs `<public address>/connector/callback` as a redirect URI; each assistant's app needs both `<public address>/connector/callback` and `<public address>/api/callback`.
- Refused registrations and authorizations log the redirect host only, so you can see what an agent asked for.

### Refresh tokens: stay connected longer than an hour (opt-in, owner-run)

Off by default. Without it the access token lasts at most an hour (and never longer than the delegated PingOne token), muse.ai does not renew it, and you reconnect about hourly. With `MUSE_CONNECTOR_REFRESH=1` the connector also gives a connected assistant a **refresh token**, so it renews itself without sending you back to sign in. Off, everything is exactly as before: no `refresh_token` in any answer, the metadata and registrations are unchanged, and a `refresh_token` request is `unsupported_grant_type`.

**Owner steps** (the agents never run these):

1. Enable the refresh grant on the PingOne app the connector signs in with (the Muse app, or the assistant's own app from `MUSE_CONNECTOR_AGENTS`). Set these in your shell (never in a file you commit; the script never prints them): `PINGONE_ENV_ID`, `PINGONE_WORKER_CLIENT_ID`, `PINGONE_WORKER_CLIENT_SECRET` (a worker app that may read and update applications) and optionally `PINGONE_REGION` (`com` default, `eu`, `asia`, `ca`, `com.au`, `sg`). Then:
   - `node scripts/enable-pingone-refresh.mjs <application id>` is a **dry run**: it reads the application and prints the plan.
   - add `--apply` to change it (and `--hours N`, default 24, at most 168, to match `MUSE_CONNECTOR_REFRESH_MAX_HOURS`). It saves the application as it was to `scripts/pingone-app-before-<id>-<time>.json` (git-ignored) before changing anything, adds `REFRESH_TOKEN` to `grantTypes`, sets `refreshTokenDuration` and `refreshTokenRollingDuration` to N hours in seconds and `refreshTokenRollingGracePeriodDuration` to 0, sends every other field back as it was, then reads the application again and checks it. Whether your tenant accepts these values is UNVERIFIED until you run the dry run and the apply. Also check, in the PingOne console, that the application's Resources allow the `openid` scope `offline_access` (the script does not check it; UNVERIFIED that PingOne needs more than the grant).
2. Set `MUSE_CONNECTOR_REFRESH=1` (and optionally `MUSE_CONNECTOR_REFRESH_MAX_HOURS`, see below) where the connector gets its settings, and restart.
3. **Reconnect muse.ai once.** A refresh token is only issued at sign-in, so a connection made before this was turned on keeps working until its hour is up and then needs one new sign-in; after that it renews itself.

**How it works.**
- With refresh on, the sign-in asks PingOne for `openid offline_access` (only then). If PingOne returns a refresh token it stays on the server, inside the connector's own record; if it returns none (the app does not have the grant yet), the connector issues no refresh token and behaves as it does today. The log says which.
- `/connector/token` with the authorization code also returns a connector `refresh_token` (32 random bytes, base64url). The metadata then lists `refresh_token` under `grant_types_supported` (scopes stay `mcp`), and a registration is given the grant unless it listed `grant_types` without `refresh_token`.
- `grant_type=refresh_token` is for public clients: `client_id` is required and must be the client the token was issued to (another client gets `invalid_grant` and nothing changes for the real one). Each refresh token works **once**: the answer carries a new one and the old one is dead. A spent token presented again **revokes the whole sign-in** (every refresh token and access token of it), except that the same spent token within **10 seconds** gets the very same answer again (a network retry).
- The connector then refreshes at PingOne with its own copy of the PingOne refresh token (same client authentication as the code swap), keeps PingOne's rotated token if it sent one, redoes the on-behalf-of exchanges (agent token plus the two token exchanges) with the new user token, and mints a new access token that lasts at most an hour and never past the new delegated token's expiry. The refreshed token must be for the same user.
- If PingOne refuses (an `invalid_grant`, a disabled user, a refused exchange) the answer is `invalid_grant` and the sign-in is revoked, so the assistant asks you to sign in again. If PingOne cannot be reached, answers 5xx or 429, the answer is HTTP 503 `temporarily_unavailable` and nothing is revoked: the same refresh token works when PingOne is back. Refreshes of one sign-in are done one at a time, so two at once make one PingOne call.
- **Lifetime.** `MUSE_CONNECTOR_REFRESH_MAX_HOURS` (default 24, a number above 168 is cut to 168, anything that is not a plain positive number means 24) is the most a sign-in can be renewed for, counted from the first sign-in however often it is refreshed; PingOne's own refresh lifetime should match it (the script's `--hours`). Refresh tokens live **in memory only**: a restart or a new pod drops them all and every assistant signs in once more. At most 200 sign-ins are kept (the oldest goes first) and expired ones are removed.
- **Secrets.** Refresh tokens, PingOne refresh tokens and access tokens are never in a log line, an error, a result or a trace (the log says only `refresh ok` or `refresh refused: <reason>`); the PingOne refresh token is never sent to any client; every token answer is `Cache-Control: no-store`; the refresh path uses the same rate limit as the rest of the token endpoint.
- Tests: `server/test/connector-refresh.test.js` (stub PingOne and gateway), `server/test/connector-refresh-sdk.test.js` (the official MCP SDK client: sign in, expiry, 401, refresh, tools again, the old token dead) and `server/test/enable-pingone-refresh.test.js` (the script's planning, against a stub).

### Connect muse.ai: the card on the page

In Real, with the connector on, the page opens with a **Connect muse.ai** card (in Mock it says the connector is not enabled in this mode). It is fed by `GET /api/connector/info`, which returns public facts only: `{url, clientId, tokenAuth, scope, redirectUris, airline, publicReachable, tools}`. No secret, token or internal setting is ever in it (a test sets every secret and checks none appears). `publicReachable` is false when the public address is localhost, 127.x, a private or link-local address, `*.local`, `*.ping.demo`, the local lab-proxy host or any name without a dot; the card then warns "muse.ai runs in the cloud and cannot reach this address. Use the hosted URL."

The card shows the MCP URL, client ID, "Client secret: none", PKCE S256, scope `mcp` and the redirect URI, each with a Copy button, then four steps:

1. **Ask muse.ai to add it**: a copy-paste prompt filled with the real URL ("Set up an MCP connector for me. Name: <airline> Airline Connector. URL: <MCP URL>. It uses OAuth. If you can register yourself automatically, do that. If registration fails or asks for a client ID, use client ID <id>: it is a public client with no client secret, PKCE S256, scope mcp. ... list the tools you got."). The airline name comes from `MUSE_CONNECTOR_AIRLINE` (SkyHigh when unset); the client-ID sentence is left out when no `MUSE_CONNECTOR_CLIENT_ID` is set.
2. **Sign in**: PingOne, as the demo user, then accept the "Allow the Airline Connector to act for you" screen.
3. **Check you have four tools**: `loyalty_balance`, `get_loyalty_status`, `list_flights`, `book_flight`. Only two means muse.ai is on an old connector: remove it and add it again.
4. **Try these prompts**: "Book me a flight for $620", "Book me a flight to London", "Book me a flight to Denver for $450", "List the flights I can book", "How many points do I have?"

Below the steps, "How the prompts work" explains in plain words: a stated price is what the rules judge; a destination uses the airline's price (`list_flights` shows them); with both, your price wins and the answer says what the airline lists; your own limit (default $500) blocks an AI agent's booking over it, and the airline's rule is premium members only over $750; the outcomes are Booked (with a confirmation number), blocked (with the rule and the numbers) or held for approval; with a stated price the rules judge the price the agent states, which a real airline would price itself; and no route or date is needed.

### Booking from muse.ai (or any connected agent)

`book_flight {destination?, amount?, flightId?}` books one flight, and at least one of the three is required. Say it the way a person does: "Book me a flight for $620", "Book me a flight to London", "Book me a flight to Denver for $450". Muse calls the gateway tool `book_airline_flight` with the user's delegated token (same sign-in, same audience handling and one retry on a dropped connection before the call as `get_loyalty_status`).

- `amount` (US dollars, above 0, at most 100000, at most 2 decimals) is the price the user wants to pay. It takes precedence: Muse books the open-fare flight `SH000` at that stated price, `{flight_number: 'SH000', amount: <stated>}`. If a `destination` or `flightId` also names a catalogue flight it only supplies the wording, and when the airline lists a different price the answer says so ("You asked for $450; the airline lists Denver at $180; booked at your price.").
- `destination` (at most 40 characters) matches a catalogue city, 3-letter airport code or route string, case-insensitive, trimmed and with repeated spaces collapsed (London, LHR, AUS-LHR; Denver, Seattle, Boston, Los Angeles, Honolulu, London, Tokyo, Maui, San Francisco). Nothing fuzzier. With no `amount`, Muse sends that flight and its catalogue fare, `{flight_number: 'SH106', amount: 620}`, and the gateway also sets the fare from its own catalogue.
- `flightId` (at most 16 characters) is a flight id from `list_flights`, as before. A `destination` and a `flightId` that name different flights are refused.
- Nothing usable (no field, a bad price such as 0, negative, NaN, 100000.01, 1.005 or a string, an unknown destination without a price, a destination or flight id of the wrong type or length) is a tool error that lists the destinations and says how to give a price. No gateway call is made. An unknown destination *with* a price is booked at the price and says the airline does not list it.

A booked answer says what was booked in plain words: "Booked a flight to London for $620 (price as you stated it)." or "... (airline price).", followed by the booking reference and the airline server's own text. A booking call that was sent is never repeated, so a timeout cannot double-book. Every other result says nothing was booked.

**Security note, said plainly.** With a stated price the rules judge the price the *agent states*. That is accepted only from this trusted connector (the gateway checks the `x-internal-gateway-secret`); an untrusted caller cannot use the open fare, and the gateway refuses it with HTTP 403 (`open_fare_untrusted`, or `open_fare_bad_amount` for a missing or invalid price). The catalogue flights still use the airline's own fare and ignore any amount a caller sends. A real airline would price the ticket itself; here the open fare `SH000` exists so a person can say "for $450" and have the limit and premium rules judge that number.

Try it from muse.ai once the connector is added and signed in:

1. Ask: "List the flights I can book." (`list_flights`: nine invented flights, SH101 to SH109, with route, city and fare.)
2. Ask: "Book me a flight for $620" or "Book me a flight to London" (or "Book SH106"). $620 is over your limit when the limit is the default $500. The result is an error: an AI agent cannot buy a ticket over your limit, with the fare and the limit. Nothing is booked, and it is never offered for approval.
3. Ask: "Book me a flight for $940" (or "to Tokyo", or "Book SH107"). $940 Over your limit, so your rule fires; the airline rule (premium members only over $750) fires too when the PingOne user's `airlineMemberTier` is not premium, and then both rules are named.
4. Ask: "Book me a flight to Denver" ($180) or "Book me a flight for $450", both within your limit. They pass both rules. "Book me a flight to Denver for $450" books at $450 and says the airline lists Denver at $180. With the consent bridge and the pre-approval below configured, the gateway skips its human approval hold and the airline MCP server answers: muse.ai gets that answer back (`Booked a flight to Denver for $180 (airline price). Booking reference ...` followed by the server's own text). Without them the gateway holds it at its approval step (HTTP 428) and the result says the booking is held and nothing was booked yet; this connector has no way to approve it. `Booked ...` only appears if the airline server's answer says `booked: true`.
5. Change the PingOne user's `airlineMemberTier` (Premier Gold or Premier Silver) or the agent limit (the *Test controls* card does it) and ask again: the decision changes with the rule inputs, not with anything the agent sends. Raise the limit to $1000 and "Book me a flight for $620" now goes straight through; lower it to $300 and "Book me a flight to Boston" ($480) is blocked, with $300 in the message.

What each result means (`isError` is true for everything except Booked):

| Gateway answered | muse.ai is told |
|---|---|
| 200 and the airline server's answer says `booked: true` | The one-line summary first (`Booked a flight to <city> for $<amount> (price as you stated it | airline price). Booking reference: <ref>.`), then the airline server's own text, unchanged apart from the scrubbing below. Not an error. |
| 200 with content that does not say `booked: true` (booked false, no flag, plain text) | `The airline system answered (not a confirmed booking):` then the server's own text. `isError` is whatever the server's result says (false when absent). Never described as booked. |
| 200 with `isError: true` | The same, with `isError: true`; even `booked: true` is then not called booked. |
| 200 with no readable text (empty, not text, a JSON-RPC error, over 64 KB) | No booking was confirmed. |
| 403 with `mcp-airline-agent-spend-limit` and/or `mcp-airline-premium-only` in `X-Gw-Audit-Trail` | The rule in plain words (agent over your limit, with the fare and your limit; fares over $750 are for premium members, with the member tier), both if both fired. The limit number comes from the deny statement itself if it carries one, else from what PingOne holds for you (read in that call), else the message says the limit was not reported. It is never taken from the audit trail's `AgentSpendLimit` parameter, which can differ from the limit that denied the booking. Nothing was booked, and no approval is offered. |
| 403 with `no_user_consent` or `may_act_mismatch` | `Booking denied: you have not authorized this agent to act for you on bookings.` When the consent bridge below is not configured it adds that the bridge is not configured, so the connector cannot pass on the consent given at sign-in. If a booking rule fired too, it is named after that. Nothing was booked. |
| 403 `open_fare_untrusted`, `open_fare_bad_amount` (or `unknown_flight_fare` from a gateway without the open-fare rule) on a stated price | A plain message: the gateway takes a stated price only from the trusted connector (check the trusted-caller setting), did not accept the price, or does not support a stated price yet. Nothing was booked. |
| 403, another or no code | The gateway did not allow this booking (plus the code when it sent one). Nothing was booked. |
| 428 `consent_pending` | Held for the member's approval. Nothing was booked yet. Without the consent bridge it adds that the connector's trusted-caller setting must be configured for a booking within your limit to skip the hold. |
| 401 from the gateway | The gateway did not accept the connector's sign-in. Nothing was booked. Reconnect. |
| timeout or dropped connection on the booking call | No answer. No booking was confirmed; do not assume it was booked. |
| 5xx, unreadable body, JSON-RPC error | No booking was confirmed. |

Nothing is reported as booked unless the gateway answered 200 and the airline server's answer says `booked: true`. The airline server's text is passed on at most 5 items of 4000 characters; the bridge secret, bearer values, JWT-shaped values and URLs that carry an id or a query are replaced before it reaches muse.ai. A denial, hold or error never carries the gateway's raw body or headers. The log has one line per booking (`book_flight <id> -> booked|denied|consent_pending|error (HTTP n)`).

### Consent bridge for book_flight (exception #2, owner-approved 2026-11-09)

**Why.** Booking is judged by PingOne Authorize, and its first check is that the signed-in user has authorized this agent to act for them (the user's `may_act`). The delegated token this connector holds carries no `may_act` claim, so without help every booking is denied with `no_user_consent` before the two booking rules run. The main AI-DEMO2 app supplies the consent in a header (`X-May-Act-Sub`) that the gateway honours only from a trusted internal caller (a request that also carries `x-internal-gateway-secret`, equal to the gateway's own secret). The connector is not such a caller by default. The sign-in already includes an "Allow the Airline Connector to act for you" screen, and a session that holds a delegated token means the user accepted it, so the connector can pass that consent on.

**Setup (owner-run, optional).** Set `MUSE_GATEWAY_INTERNAL_SECRET` in Muse's own `.env` (beside `docker-compose.yml`) to the gateway's trusted-caller secret, and restart. Name only in `.env.example`; the value is never committed. `docker-compose.yml` passes it through empty by default. With it unset, nothing changes: the booking call is exactly as before and a consent denial is explained honestly (see the table above).

**What it does.** For `book_flight` only, the `tools/call` request to the configured gateway URL carries two extra headers: `x-internal-gateway-secret: <the secret>` and `X-May-Act-Sub: <the actor app's client id>`. The client id is the PingOne app this session signed in with (the same id the delegated token's `act` claim carries: Muse's app, or the assistant's own app from `MUSE_CONNECTOR_AGENTS`), taken from configuration, never from any field the agent sends. `initialize` and `tools/list` do not carry them: the decision is made at `tools/call`, so the secret travels no further than that. Nothing else trusted is ever sent (no `X-Authz-Simulated`, `X-Act-Client-Id` or `X-Demo-Force-Actor`).

**Limits (the exception is this and nothing more).** The secret is write-only: never returned, logged (a log line that would echo it is redacted), put in an error, result, trace, the page or any file in the repo. It is never sent on `loyalty_balance`, `get_loyalty_status`, `list_flights`, the web page's own booking path, the sign-in or any other request, and only to the gateway URL. A value that is not a plain header value is ignored. Tested against stubs only (`server/test/connector-consent-bridge.test.js`, including a stub gateway that applies the trusted-caller rule); the first real use is the owner's. The rulebook keeps trusted secrets out of standalone apps; this is a labelled, owner-approved exception.


### Pre-approval: a booking within your limit skips the approval hold (rides on exception #2)

**What the owner wants.** In muse.ai you ask to book a flight. If the booking is within your dollar limit it goes straight through the gateway to the airline MCP server and muse.ai gets the server's answer back. If it is over your limit it is blocked, and muse.ai is told so with the right numbers.

**How.** The gateway (AI-DEMO2 PR #3538) skips its human-approval hold for a *trusted* caller (the correct `x-internal-gateway-secret`) whose request carries `X-Hitl-Preapproved: user-limit`, when the authoritative fare is at or under the user's limit. It takes that limit from the trusted header `X-Agent-Spend-Limit` (digits with an optional decimal point, at most 7 characters, above zero), else its own default of $500. The gateway compares the fare with the limit; Muse only presents the headers.

For `book_flight` only, and only when `MUSE_GATEWAY_INTERNAL_SECRET` is set (the same condition that sends `x-internal-gateway-secret` and `X-May-Act-Sub`), the `tools/call` request to the configured gateway URL also carries:

- `X-Hitl-Preapproved: user-limit` (a fixed value, never derived from anything the agent sends);
- `X-Agent-Spend-Limit: <your limit as plain digits>`, only when Muse knows it. The limit comes only from PingOne: for each booking call Muse reads your `agentSpendLimit` through the Test-controls switch (`tier.js readUserFacts`) for the PingOne user id of the signed-in session (the `sub` of the delegated token), and only if that id is on the `MUSE_TIER_USER_IDS` allow-list. The read has a 2.5 second timeout and never blocks the booking: if it fails, is slow, is rate limited, or returns anything that is not whole dollars from 1 to 9999999, no limit header is sent and the gateway's default of $500 applies. Muse never invents a limit.

`initialize` and `tools/list` do not carry these headers, and neither do the loyalty tools, `list_flights`, the web page's own booking path, the sign-in or the PingOne reads. This adds no new exception: it rides on exception #2 (the same trusted-caller secret, the same `tools/call`-only, gateway-URL-only rule, the same scrubbing). The secret rules above are unchanged.

**Honest degradation.**

| Configured | What happens to a booking within the limit |
|---|---|
| Bridge secret + Test-controls worker credential (`MUSE_TIER_*`) | Goes straight through, up to the limit PingOne holds (any amount you set). |
| Bridge secret only | The marker is sent, no limit header: the gateway's default $500 applies. A fare above $500 is held (428) even if PingOne holds a higher limit. To let a raised PingOne limit skip the hold, configure the worker credential. |
| No bridge secret | Exactly as before: no pre-approval headers; the gateway denies for missing consent (or holds). The messages say what to configure. |

**Environment variables involved** (names only; values live in Muse's own `.env`, see `.env.example`): `MUSE_GATEWAY_INTERNAL_SECRET`, `MUSE_TIER_ENABLE` (`1` writes and reads, also in Docker; `read` only reads, for a public URL), `MUSE_TIER_WORKER_CLIENT_ID`, `MUSE_TIER_WORKER_CLIENT_SECRET`, `MUSE_TIER_USER_IDS`, `MUSE_TIER_ENV_ID` (or `MUSE_P1_ENV_ID`), `MUSE_TIER_REGION` (or `MUSE_P1_REGION`).

**Owner-run end to end (Real, agents never run it).**

1. In `.env`: the bridge secret, `MUSE_TIER_ENABLE=1`, the worker app and your demo user's id in `MUSE_TIER_USER_IDS`. Restart Muse.
2. The gateway must be the build with the pre-approval rule (AI-DEMO2 #3538) and the same trusted-caller secret. For a stated price ("for $450") it must also carry the open-fare rule, and the airline MCP server must know the open-fare flight `SH000`; an older gateway answers with a message saying it does not support booking at a stated price yet.
3. In the *Test controls* card set the limit to $500 (or Default). In muse.ai sign in to the connector, then "Book me a flight for $620": blocked, "your limit is $500".
4. Press $1000 in the card. "Book me a flight for $620" again: it goes straight through and muse.ai receives the airline server's answer.
5. Press $250. "Book me a flight to Denver" ($180) still passes; "Book me a flight to Boston" ($480) is blocked with "your limit is $250".
6. If a booking within your limit is still held: check the secret matches the gateway's, the user id is on the allow-list, and (for a limit above $500) the worker credential is configured.

Tested against stubs only (`server/test/connector-preapprove.test.js`, with a stub gateway that applies the trusted-caller, consent, limit, pre-approval and hold rules); the first real use is the owner's.
