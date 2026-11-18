# Real mode setup for Book a flight (owner-run)

Status: **UNVERIFIED.** Everything below was written from this lab's own code and tests, which use stubs only. No
PingOne tenant, PingOne Authorize policy or gateway was called while writing it. Agents never run these steps; the
first real run is yours. Mock needs none of this and is unchanged.

Muse's Real mode needs three things that you provide. Nothing comes from another demo project, and this lab does not
ship any of them:

| You provide | Used for |
|---|---|
| A PingOne environment (apps, scopes, demo users) | Sign-in, the delegated (on-behalf-of) token, the user attributes the rules read |
| PingOne Authorize with the two booking rules | The decision: `PERMIT` or `DENY` with a statement code |
| A gateway at `MUSE_LIVE_GATEWAY_URL` in front of an airline MCP server | Calls Authorize and reports its answer back |

The PingGateway that `ping-shared` can run (AI-DEMO-Standalone `shared/ping-shared`) is **not enough for this**: it only
checks a bearer token and proxies `/mcp`. It makes no PingOne Authorize decisions, does no token exchange and has no
trusted-caller headers. So Real needs a gateway you operate that does what "The gateway contract" below lists. If you
have none, stay on Mock.

The PingOne apps, resources and scopes are listed in the README ("Use your own PingOne and PingFederate"); the
settings are in `.env.example`. This page covers the Authorize rules, the user attributes and the gateway contract.

## 1. PingOne user attributes

In your environment's user schema, add two custom attributes (type STRING):

- `airlineMemberTier`: the member tier. Premium is the explicit list `Premier Gold` (`PREMIUM_TIERS` in
  `server/src/fares.js`). `Premier Silver`, any other value, an empty value and a missing attribute are **not premium**.
- `agentSpendLimit`: the user's own cap, in whole dollars as text (for example `"500"`). Empty means the default of 500.

Give the demo user `airlineMemberTier = Premier Gold`. To flip the tier or limit while demonstrating, use the *Test
controls* card on the Book a flight page (README, "Test controls"), or edit the user in the PingOne console.

## 2. PingOne Authorize: attributes, rules and publish

In the Authorize console (Trust Framework), create what the two rules read. Names must match what the gateway sends:

| Attribute | Type | Source |
|---|---|---|
| `ToolName` | STRING | request (the gateway sends the MCP tool name; the booking tool is `book_airline_flight`) |
| `Amount` | NUMBER or STRING | request (the **gateway's catalogue fare**, never the caller's amount) |
| `ActClientId` | STRING | request (the `act` client id of the delegated token; absent when no agent acts) |
| `UserId` | STRING | request (the token `sub`) |
| `AgentSpendLimit` | NUMBER | the PingOne user attribute `agentSpendLimit` (PingOne User resolver, keyed on `UserId`), default 500 |
| `MemberTier` | STRING | the PingOne user attribute `airlineMemberTier` (PingOne User resolver, keyed on `UserId`), default `none` |

Whether the PingOne User resolver and its defaults behave as described is **UNVERIFIED** here: check the attribute in
the console after you create it. A user with no `airlineMemberTier` may produce an evaluation error (INDETERMINATE)
rather than a plain "not premium"; under deny-overrides that denies, which is the intended fail-closed result, but
measure it on a booking under $750 too before you rely on it.

Then add two deny rules to the policy that governs the booking tool, ahead of any catch-all permit:

| | Rule A: your preference | Rule B: the airline's control |
|---|---|---|
| Name | `MCP Deny — Agent Booking Over User Limit` | `MCP Deny — Airline Premium-Only Over $750` |
| Statement code | `mcp-airline-agent-spend-limit` | `mcp-airline-premium-only` |
| Denies when | `ToolName` is the booking tool **and** `ActClientId` is present **and** `Amount` > `AgentSpendLimit` | `ToolName` is the booking tool **and** `Amount` > 750 **and** `MemberTier` is not in the premium list |
| Applies to | only when an agent acts | every caller |

Both comparisons are strictly "over": exactly 500 and exactly 750 pass. When both fail, both statements are returned.
Put a human-readable message in each deny payload (Muse shows it). Publish the policy, then restart the gateway if it
caches anything. The Mock rules in `server/src/fares.js` are the executable form of this table.

Also keep the actor list your Authorize policy uses (a closed list of allowed `act` clients) in step with the PingOne
apps: Muse's own app, and each assistant app from `MUSE_CONNECTOR_AGENTS`. An actor missing from it is denied as an
invalid actor chain before the two booking rules run.

## 3. The gateway contract

`MUSE_LIVE_GATEWAY_URL` (ending in `/mcp`) must be an MCP streamable-HTTP endpoint that, for Muse's calls:

1. **Accepts the delegated PingOne token**: validates it against PingOne's JWKS (Muse sends `X-Token-Validation: jwks` and
   `MCP-Protocol-Version`), accepts the gateway's audience and the scope in `MUSE_P1_GATEWAY_SCOPE`, and accepts an
   `act` claim naming the calling app.
2. **Judges the catalogue fare, not the caller's.** For `tools/call` of `book_airline_flight` it looks up `flight_number` in
   its own read-only catalogue (the same flights and fares as this lab's `server/src/fares.json`: `SH101` to `SH109`) and
   sends **that** fare to Authorize as `Amount`. An unknown or missing flight is refused with 403 before Authorize is asked.
3. **Asks Authorize and enforces the answer.** It sends the attributes in the table above (`UserId` = the token `sub`,
   `ActClientId` = the `act` client). `DENY` becomes HTTP 403 and the tool does not run. A `PERMIT` that carries an
   unfulfilled approval obligation becomes HTTP 428 (a person must approve; Muse never approves it).
4. **Reports the decision in an `X-Gw-Audit-Trail` response header**: one JSON object (at most 32 KB) such as
   `{"authorize":{"decision":"DENY","tool":"book_airline_flight","parameters":{"ToolName":"book_airline_flight","Amount":"940","ActClientId":"<app id>","MemberTier":"Premier Silver","AgentSpendLimit":"500"},"reason":"...","statements":[{"code":"mcp-airline-premium-only","payload":{"message":"..."}}]},"fareOverride":{"claimed":1,"authoritative":940}}`.
   Muse reads only these fields; the rule names on the page come from `statements[].code`. Every field is optional, and
   a missing header just means less evidence is shown.
5. **Returns the MCP result** for a permitted booking as JSON text `{"booked":true,"confirmationNumber":"...","fare":620}`
   (or `{"booked":false,"reason":"..."}`), from an airline MCP server behind it that knows flights `SH101` to `SH109`.

### Optional: consent bridge, pre-approval and open fare (README exceptions #2 and the pre-approval)

These are only needed for the Airline Connector's `book_flight`; skip them if you do not connect an assistant.

- **Trusted caller.** The gateway has its own secret. A request carrying it as `x-internal-gateway-secret` is a trusted
  caller; every trusted-only header below is ignored and stripped from any other caller. Muse sends the secret (from
  `MUSE_GATEWAY_INTERNAL_SECRET`) only on the `book_flight` `tools/call`.
- **Consent.** The delegated token carries no `may_act`, so Authorize's "the user authorized this agent" check would deny
  every booking with `no_user_consent`. From a trusted caller the gateway honours `X-May-Act-Sub: <actor client id>` as
  that consent.
- **Pre-approval.** From a trusted caller, `X-Hitl-Preapproved: user-limit` (exactly that value) makes the gateway skip
  the human-approval hold (the 428) when the **catalogue** fare is at or under the user's limit. The limit is
  `X-Agent-Spend-Limit` (digits and at most one decimal point, at most 7 characters, above zero) when valid, else the
  gateway's own default of 500. Missing fare or limit fails closed. The header can skip the hold, never widen what
  Authorize allows: Rule A still denies a booking over the PingOne limit.
- **Open fare.** A person can say "book me a flight for $620", which has no catalogue fare. Flight `SH000` (route
  `AUS-ANY`) is the open fare: only a trusted caller, with `arguments.amount` a JSON number above 0, at most 100000, at
  most two decimals, is judged at that amount; an untrusted caller or a bad amount is refused with 403 before Authorize.
  The airline MCP server must know `SH000` and book it at the quoted amount. A gateway without this answers that it does
  not support booking at a stated price yet.

## 4. Run it

1. Fill in `.env` from `.env.example` (PingOne environment, app, `MUSE_LIVE_GATEWAY_URL`, and `ALLOW_LIVE=1`).
2. `npm start`, switch to Real, press **Premier Silver** in the Test controls card (needs the tier switch in the README),
   run rows 7 and 9, then **Premier Gold** and row 8. Row 10 needs **No tier set**.
3. Real reads the gateway's answer; rule names come from the audit trail. If something fails, the page says which
   hop and why. Nothing here is proven until you have run it.
