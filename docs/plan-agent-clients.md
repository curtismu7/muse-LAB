# Plan: Claude, ChatGPT and Codex as Muse-style clients

Status: plan only (2026-10-28). Mock: `docs/mocks/agent-clients.html`. Nothing here is built yet.

## Goal

One page, `/clients`, with a picker: Muse, Claude-style, ChatGPT-style, Codex-style. Each choice shows a chat (or terminal) UI shaped like that app. Every one of them uses the same back end as Muse: the Airline Connector (`/mcp` + `/connector/*`), PingOne sign-in through the DaVinci flow (Protect, agent detected, consent), the on-behalf-of exchange, and the gateway call. The viewer sees that the airline's side does not change with the client. Only the client's look and its name on the PingOne screens change.

## Decisions (owner, 2026-10-28)

1. **Branding: decided.** The skins use each app's real colours and real logos. Logo files come from each vendor's official brand or press page into `web/public/brands/`. They are never redrawn by hand. Each skin still keeps the "Simulated" chip and the ribbon saying it is a demo client talking to Muse's back end and not the vendor's own app (the rulebook's "honest about what is simulated").
2. **A PingOne app per agent: decided (changed 2026-10-28, PR #17 merged).** Agents listed in `MUSE_CONNECTOR_AGENTS` (JSON: name, clientId, clientSecret, hosts) sign in with their own PingOne app, picked by the agent's callback host (`claude.ai`, `chatgpt.com`). The sign-in, the code swap and both token exchanges then use that app, so Protect and the PingOne screens can name the agent, and `act` is that agent. Agents that aren't listed (Codex on localhost, Meta's Muse) keep Muse's connector app, as before. This replaces the earlier login-hint-marker idea. Protect detection for each agent goes into the DaVinci flow (see "Protect detection" below).
3. **Sign-in style: decided.** MCP clients sign in through an OAuth redirect, as the spec requires. The connector is the stated exception to "pi.flow only", as it is today.
4. **Route.** `/clients?client=claude`, public like `/diagram`. The picker remembers the choice.
5. **Build order.** Claude, then ChatGPT, then Codex.
6. **Connect path (owner rule, 2026-10-28, relayed by the United session, PR #18):** customers connect ONLY from their assistant's directory. No paste-the-URL or client-ID copy anywhere. **Codex exception (owner, 2026-10-28):** Codex has no directory, so the company ships the connector in `.codex/config.toml` or through MDM. The customer never types a URL or client ID; they only run `codex mcp login airline`. No `codex mcp add` copy is shown to customers.

## How it works

```
skin (Muse | Claude | ChatGPT | Codex)  -- presentational only
   |
engine (web/src/clients/engine.js)  -- what a real MCP client does, same origin
   1. POST /mcp                       -> 401 + WWW-Authenticate resource_metadata
   2. GET  /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
   3. POST /connector/register        client_name "Claude-style (simulated)", redirect ${origin}/clients/callback
   4. GET  /connector/authorize       PKCE, client=claude  -> PingOne, login_hint sam.claude
        PingOne: DaVinci flow -> Protect -> "AI agent detected: Claude-style" -> consent
   5. GET  /connector/callback        Muse does the on-behalf-of exchange (unchanged)
   6. /clients/callback?code=...      engine posts /connector/token
   7. POST /mcp tools/list, tools/call loyalty_balance -> gateway -> points
   |
trace panel  -- every step above, raw, with the real request and response
```

The engine emits one event stream. Each skin renders the same events in its own way:
- **Claude-style:** connector menu under the composer, sign-in card, tool-use block that folds open.
- **ChatGPT-style:** left sidebar, Apps chip, "Connect" sheet, tool-call row.
- **Codex-style:** terminal, `codex mcp login airline`, browser hand-off line, `tools/call` printed.
- **Muse:** the current UI, for side-by-side comparison.

## Changes

### Web (this repo)
- `web/src/clients/engine.js`: the MCP and OAuth client above (PKCE, DCR, token, JSON-RPC). It is shared by all skins and has unit tests.
- `web/src/clients/skins/{Muse,Claude,ChatGPT,Codex}Skin.jsx`, the picker and the trace panel.
- `main.jsx`: the `/clients` and `/clients/callback` routes. Link from the band and from how-it-works `#publish`.
- A diagram-studio JSON for the clients flow, loaded by id (rule 17), with the four clients as one swimlane that switches.

### Server (this repo)
- `/connector/authorize` already picks the agent's PingOne app by callback host (#17). The simulated skins call back to our own host (`/clients/callback`), so they need one more rule: a same-origin registration may name an agent from the `MUSE_CONNECTOR_AGENTS` list (allowlisted name, never a free-form value). It then uses that agent's app. Unknown names fall back to Muse's app.
- Allow `${MUSE_PUBLIC_URL}/clients/callback` as a redirect for these simulated registrations only.
- **Mock connector.** The connector is only on in real mode today. The SE mock-only build (rule 18) needs a stub authorization server: the same `/connector/*` shapes, with a stub PingOne page that shows the same screens (agent detected naming the client, consent) and a stub gateway. Same `MODE` switch, live code refused when hosted-mock.
- Tests: an agent name off the list falls back to Muse's app, a cross-origin registration cannot claim an agent name, the redirect rule, a mock end-to-end per client.

### PingOne tenant (done 2026-10-28, by the United session)
- Apps "Claude agent login" and "ChatGPT agent login", each with redirects to `/connector/callback` and `/api/callback`.
- Both app ids are in the Protect `museAgentClient` predictor (HIGH).
- Agreements "Claude Consent" and "ChatGPT Consent".
- DaVinci parent flow v78: the "Read login hint" function takes the app id and outputs `agentName`, `isAgentApp` and `agreementId`. The connector consent node's agreement is picked dynamically from that. A v77 backup exists: back up again before any change to the flow.
- **Still open (owner):** `MUSE_CONNECTOR_AGENTS` in the `muse-real` Secret. Until it is set, Claude and ChatGPT fall back to Muse's connector app.

### Protect detection (DaVinci flow, owner-run)
With one connector app, every client's sign-in has the same `targetResource.id`. Protect can say "this is an agent" from that, but not which agent. The plan layers it:
- **Layer A (live):** the `museAgentClient` MAP predictor on `targetResource.id` lists each agent's app id, so Protect rates the sign-in an agent, HIGH, **and** says which one. The connector app stays in the list for agents without their own app.
- **Layer B (live today):** native bot detection through the "Capture Protect device data" node (headless browser and automation signals). This is what catches a real automated client.
- **Layer C (dropped):** passing a marker into Protect as a custom attribute isn't needed now that each agent has its own app id.
- **"How we know" rule:** the agent screen always names the source. Each predictor writes its reason into `museAgentReason`, for example "Protect: Claude's PingOne app (HIGH)" or "Protect bot detection: headless browser".
- New subflow claims (`agentClient`, `agentClientReason`) are added next to `museAgentLevel` and `botLevel`, through a cloned tail, never by merging into an existing EVAL.

### Real model back ends (our UI, their model)
The vendors' APIs can call a remote MCP server themselves. So each skin can be driven by the vendor's real model, not a script:
- **Claude:** the Messages API's MCP connector. `mcp_servers: [{type: "url", url: "https://muse.ai-demo.ping-devops.com/mcp", name: "airline", authorization_token: <delegated token>}]` plus `tools: [{type: "mcp_toolset", mcp_server_name: "airline"}]`, beta `mcp-client-2025-11-20`, model `claude-opus-5-5`. Checked against the Claude API docs on 2026-10-28.
- **ChatGPT:** the OpenAI Responses API's remote MCP tool (`{type: "mcp", server_url, authorization}`). From memory, **not yet checked against OpenAI's docs**.
- **Codex:** the Codex SDK or `codex exec` in the pod, with the airline in its `config.toml`. **Not yet checked.**
- **Meta's Muse:** no public API known. It stays the hand-added connector.

How it fits: our engine still runs steps 1 to 5 (401, register, PingOne with the agent's own app, consent, token), so Protect and consent stay in the flow. It then hands the access token to the vendor API as the MCP authorization. The vendor's servers call `/mcp` directly, so the host must be public (it is). Our server is the only place the API keys live. They are owner-set Secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), never sent to the browser, and refused in the hosted-mock build. A per-visitor rate limit caps the spend. Each skin gets a Scripted | Live model toggle, with Scripted the default and the only option in the mock build.

### Real clients (last phase)
- Let the real Claude, ChatGPT and Codex reach the same `/mcp`: set `MUSE_CONNECTOR_AGENTS` with Claude's and ChatGPT's apps (their hosts may then register; loopback is already allowed for Codex), and add each app's id to the Protect predictor. Then the simulated client and the real one can be shown side by side.

## Phases and done criteria

| Phase | What | Done when |
|---|---|---|
| P0 | Plan + mock HTML (this) | Owner decisions recorded (done 2026-10-28) |
| P1 | Engine, 4 skins, picker, trace, **mock** connector | `npm test` green with real counts on Node 20 and 22. Playwright drives each skin from connect to answer at 1280 and 375 px. Content check on the hosted mock: the agent screen names the client |
| P2 | Live mode on SE (real PingOne, gateway) + Protect layers A and C | A real sign-in per client on SE. The agent screen names the client and says how it is known, Protect's riskEvaluation shows the predictor, and the trace shows the final token's `act` plus the gateway 200 |
| P2b | Live model toggle: Claude API MCP connector first, then OpenAI Responses, then the Codex SDK | One answer per skin from the vendor's model. The gateway log shows the tool call arriving from the vendor's IP with our delegated token. Spend is capped. Any unchecked vendor API shape is checked first |
| P3 | Real Claude, ChatGPT and Codex against `/mcp` | One real connection each, recorded in `docs/` with screenshots. Anything not tried is marked untried |

## Risks and traps
- **Vendor marks.** Real logos on a public SE page are the owner's call (decision 1). Use the vendors' own files unchanged, and keep the Simulated chip and ribbon, so no one takes the page for the real app.
- **Protect per-agent detection** needs each agent's app id in the predictor. Agents without their own app (Codex, Meta's Muse) are only "an agent through the connector", and the screen says so.
- **Headless bot detection.** Protect rates headless Chrome as a bot HIGH, so Playwright runs hit the red "Muse Agent Detected (Bot)" path, or the blank High Risk page on other apps. Test against the mock, or run headed for live.
- **MFA on the connector path.** The live connector sign-in needs MFA unless the flow's MEDIUM compare is changed for testing. Plan tests around it and never leave the flow edited.
- **CI.** The muse repo has a self-hosted runner (`cmuir-mac-muse`). "Green" means its build, forbidden-strings and secrets checks ran on the PR head.
- **Look-alike drift.** Vendor UIs change. The skins aim at being recognisable, not exact.
