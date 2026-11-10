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

Both are strict "over": exactly $500 and exactly $750 pass. When both fail, both are listed ("2 rules denied this booking"). The fare that is judged always comes from the catalogue by flight id (`SH101`-`SH109`), never from what the caller says. The panel has ten scenario rows (the nine contract scenarios plus row 10, a user with no `airlineMemberTier`: $940 direct is denied by the airline rule), a free flight picker and a "try to lie" button; the banner reads "Authorize rule applied: booking stopped", the five-hop trace shows the attributes Authorize was given and the rule that fired, and the ledger ("Bookings made this session") stays at "Nothing booked." on a deny.

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
- **Opt-in, and off unless configured.** The controls work in Real only when `MUSE_TIER_ENABLE=1` **and** the worker credential and user ids are set. The Docker container always runs with `MUSE_HOSTED=1` (it must bind a non-loopback address), so the flag is what lets the owner's container use them; a build with `MUSE_HOSTED=1` and no `MUSE_TIER_ENABLE` refuses and the card says so. The SE deployment never sets the flag. With anything missing the card is disabled and lists the variable names to set.
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
- **Sign-in:** `/connector/authorize` sends the user to the same PingOne flow as the app (login, Protect, agent-detected screen, consent). `/connector/callback` does the on-behalf-of exchanges. `/connector/token` gives the agent its own opaque token (PKCE S256, one-use code, no refresh token, at most an hour). The agent never receives the delegated token.
- **Clients:** dynamic registration (`/connector/register`) is offered only for redirect hosts you list in `MUSE_CONNECTOR_REDIRECT_HOSTS` (comma separated, https only). For an agent that asks you to type a client id, set `MUSE_CONNECTOR_CLIENT_ID` and `MUSE_CONNECTOR_REDIRECT_URIS`. With neither set, nothing can be issued.
- **Assistants with their own PingOne app:** `MUSE_CONNECTOR_AGENTS` is a JSON list of `{ name, hosts, clientId, clientSecret }` (for example ChatGPT on `chatgpt.com`, Claude on `claude.ai`). The agent's callback host picks the app, so Protect and the PingOne screens name the agent and the token's `act` is that agent. Their hosts may register. Agents not listed use Muse's app.
- **Connect from your assistant:** the page's customer path. A stand-in directory card per assistant (the listed ones plus Meta AI, which uses Muse's app). Connect (`POST /api/sim/start {platform}`) then does what that platform does as an MCP client, against Muse's real connector (`server/src/platforms.js`): `/mcp` without a token (401), the protected-resource and authorization-server metadata, then CIMD if the server advertises it or dynamic registration otherwise (Muse's connector has no CIMD, so today it is registration), authorization code with PKCE S256 and `resource`, the PingOne sign-in with that assistant's own app, the token, `initialize`, `tools/list` and `tools/call`. Each request and response is shown. Stand-ins, labelled on the page: the callback (`/sim/<platform>/callback` instead of chatgpt.com or the customer's loopback) and the model's choice of tool. The older `POST /api/live/signin` with `as: 'assistant'` still works for `/clients.html`.
- **PingOne:** the Muse app needs `<public address>/connector/callback` as a redirect URI; each assistant's app needs both `<public address>/connector/callback` and `<public address>/api/callback`.
- Refused registrations and authorizations log the redirect host only, so you can see what an agent asked for.

### Booking from muse.ai (or any connected agent)

`book_flight {flightId}` books one flight from `list_flights`. Muse calls the gateway tool `book_airline_flight` with the user's delegated token (same sign-in, same audience handling and one retry on a dropped connection before the call as `get_loyalty_status`). Only the flight id goes to the gateway (as `flight_number`); there is no price argument, and a `fare`, `amount` or `flight_number` the agent adds is ignored. The gateway looks the fare up in its own catalogue, so the two Authorize rules judge the real fare. A booking call that was sent is never repeated, so a timeout cannot double-book. The unknown-flight, missing, non-string or longer-than-16-character `flightId` is refused as a tool error with no gateway call.

Try it from muse.ai once the connector is added and signed in:

1. Ask: "List the flights I can book." (`list_flights`: nine invented flights, SH101 to SH109, with route and fare.)
2. Ask: "Book SH106." ($620, over your limit when the limit is the default $500) The result is an error: an AI agent cannot buy a ticket over your limit, with the fare and the limit. Nothing is booked, and it is never offered for approval.
3. Ask: "Book SH107." ($940) Over your limit, so your rule fires; the airline rule (premium members only over $750) fires too when the PingOne user's `airlineMemberTier` is not premium, and then both rules are named.
4. Ask: "Book SH101." ($180, within your limit) It passes both rules. With the consent bridge and the pre-approval below configured, the gateway skips its human approval hold and the airline MCP server answers: muse.ai gets that answer back (`Booked SH101 for $180. Booking reference ...` followed by the server's own text). Without them the gateway holds it at its approval step (HTTP 428) and the result says the booking is held and nothing was booked yet; this connector has no way to approve it. `Booked ...` only appears if the airline server's answer says `booked: true`.
5. Change the PingOne user's `airlineMemberTier` (Premier Gold or Premier Silver) or the agent limit (the *Test controls* card does it) and ask again: the decision changes with the rule inputs, not with anything the agent sends. Raise the limit to $1000 and "Book SH106" ($620) now goes straight through; lower it to $300 and "Book SH103" ($480) is blocked, with $300 in the message.

What each result means (`isError` is true for everything except Booked):

| Gateway answered | muse.ai is told |
|---|---|
| 200 and the airline server's answer says `booked: true` | The one-line summary first (`Booked <flight> for $<fare>. Booking reference: <ref>.`), then the airline server's own text, unchanged apart from the scrubbing below. Not an error. |
| 200 with content that does not say `booked: true` (booked false, no flag, plain text) | `The airline system answered (not a confirmed booking):` then the server's own text. `isError` is whatever the server's result says (false when absent). Never described as booked. |
| 200 with `isError: true` | The same, with `isError: true`; even `booked: true` is then not called booked. |
| 200 with no readable text (empty, not text, a JSON-RPC error, over 64 KB) | No booking was confirmed. |
| 403 with `mcp-airline-agent-spend-limit` and/or `mcp-airline-premium-only` in `X-Gw-Audit-Trail` | The rule in plain words (agent over your limit, with the fare and your limit; fares over $750 are for premium members, with the member tier), both if both fired. The limit number comes from the deny statement itself if it carries one, else from what PingOne holds for you (read in that call), else the message says the limit was not reported. It is never taken from the audit trail's `AgentSpendLimit` parameter, which can differ from the limit that denied the booking. Nothing was booked, and no approval is offered. |
| 403 with `no_user_consent` or `may_act_mismatch` | `Booking denied: you have not authorized this agent to act for you on bookings.` When the consent bridge below is not configured it adds that the bridge is not configured, so the connector cannot pass on the consent given at sign-in. If a booking rule fired too, it is named after that. Nothing was booked. |
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

**Environment variables involved** (names only; values live in Muse's own `.env`, see `.env.example`): `MUSE_GATEWAY_INTERNAL_SECRET`, `MUSE_TIER_ENABLE` (must be 1, also in Docker), `MUSE_TIER_WORKER_CLIENT_ID`, `MUSE_TIER_WORKER_CLIENT_SECRET`, `MUSE_TIER_USER_IDS`, `MUSE_TIER_ENV_ID` (or `MUSE_P1_ENV_ID`), `MUSE_TIER_REGION` (or `MUSE_P1_REGION`).

**Owner-run end to end (Real, agents never run it).**

1. In `.env`: the bridge secret, `MUSE_TIER_ENABLE=1`, the worker app and your demo user's id in `MUSE_TIER_USER_IDS`. Restart Muse.
2. The gateway must be the build with the pre-approval rule (AI-DEMO2 #3538) and the same trusted-caller secret.
3. In the *Test controls* card set the limit to $500 (or Default). In muse.ai sign in to the connector, then "Book SH106" ($620): blocked, "your limit is $500".
4. Press $1000 in the card. "Book SH106" again: it goes straight through and muse.ai receives the airline server's answer.
5. Press $250. "Book SH101" ($180) still passes; "Book SH103" ($480) is blocked with "your limit is $250".
6. If a booking within your limit is still held: check the secret matches the gateway's, the user id is on the allow-list, and (for a limit above $500) the worker credential is configured.

Tested against stubs only (`server/test/connector-preapprove.test.js`, with a stub gateway that applies the trusted-caller, consent, limit, pre-approval and hold rules); the first real use is the owner's.
