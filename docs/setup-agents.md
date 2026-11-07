# Connect an agent to Personal Agent: setup for each agent type

Written for: colleagues who run or demo Personal Agent and need to connect an agent to it.

Two things are called "Muse" or "the connector" here, so to be exact:

- **The scripted run** (`/clients.html`) shows each client's connect flow with look-alike screens. It needs nothing but the app. It does not connect a real agent.
- **The Airline Connector** is an MCP server (tools `loyalty_balance`, `get_loyalty_status`) on `<host>/mcp`. Real agents connect to it. It exists only in **real mode**; in mock mode `/mcp` answers 404. PingOne signs the user in; the connector brokers the redirect and the agent never sees the PingOne token.

What was measured against a real connector (2026-10-30), per agent:

| Agent | Registers by | Sign-in | Tool list | Tool call (points balance) |
|---|---|---|---|---|
| Claude Code (CLI) | dynamic registration (DCR) | works | works | not run (same connector path as Codex) |
| Codex (CLI) | DCR | works | works | works: returned the points balance and tier through the local gateway chain, see section 6 |
| Claude web / Desktop | not tested | not tested | not tested | needs a public https host |
| ChatGPT | not tested | not tested | not tested | needs a public https host |

**Registration here is between the agent and the connector, not PingOne.** PingOne has no dynamic client registration (DCR) and no CIMD. The connector works around that by ending the registration itself. See "Who registers with whom" below. CIMD is a PingFederate feature (see `/cimd.html`).

## Who registers with whom

Two separate relationships, with different client ids:

```
Agent  --- registers (DCR) --->  Connector  --- signs the user in, with its OWN client id --->  PingOne
        client_id "muse-..."                       the connector's PingOne app
```

1. **Agent and connector.** The agent calls the connector's `/connector/register` (dynamic client registration, RFC 7591) and gets a client id that starts `muse-`. That id exists only in the connector's memory. The connector checks the agent's redirect address and PKCE against it. This is the DCR we measured for Claude Code and Codex.
2. **Connector and PingOne.** To sign the user in, the connector redirects to PingOne with **its own** PingOne client id: Muse's app, or the agent's own PingOne app when the callback host is `claude.ai` or `chatgpt.com`. It returns to the connector's callback, with the login hint marked `.conn`. The agent's `muse-` id, its redirect address and its registration are never sent to PingOne, so PingOne never needs to know the agent.

Both flows are also drawn on the `/diagram` page (tabs "Who registers with whom" and "A real connect, as logged"), with Simulate, Reset and draggable boxes.

What follows from that:
- PingOne does not register the agent, and it does not accept the agent's client id. If an agent used the `muse-` id directly at PingOne, PingOne would reject it as unknown.
- The token the agent receives is the connector's own opaque token. The connector holds the PingOne token and the delegated token behind it.
- The registration lives in memory unless `MUSE_CLIENTS_FILE` points at a writable file. Without it, a connector restart forgets every agent and each one must register again.
- CIMD needs an authorization server that supports it. In this stack that is PingFederate 13.1, used directly. It is not part of this connector's path.

## 1. Run it

**Mock (no tenant, no secrets):** `npm install && npm start`, then open `http://127.0.0.1:5100/clients.html`. This is the scripted run only.

**Real, local Docker (owner-run):** needs the PingOne tenant settings and secrets, which are not in the repo or the zip. The owner starts the container on `http://127.0.0.1:5102` (see "Real mode in local Docker" in `README.md`: `MUSE_ALLOW_LIVE_LOOPBACK=1`, port published on `127.0.0.1` only). The PingOne apps need `http://127.0.0.1:5102/connector/callback` as a redirect URI, and `.../connector/resume` as a post-logout redirect URI when `MUSE_CONNECTOR_SIGNOUT_FIRST=1`.

Check it is up: `curl http://127.0.0.1:5102/api/health` returns `demo-health/1`, and `/.well-known/oauth-authorization-server` lists the authorize, token and registration endpoints.

## 2. Claude Code (terminal)

```
claude mcp add --scope user --transport http skyhigh http://127.0.0.1:5102/mcp
claude
```
In `claude`, type `/mcp`, choose `skyhigh`, then **Authenticate**. Sign in as the demo user in the browser. Then ask: "Use the skyhigh tools: what is my SkyHigh points balance?" and approve the tool call.

Traps:
- Use `--scope user`. Without it the server is saved only for the folder you ran the command in.
- `claude -p` does not use the sign-in saved by `/mcp`. Ask in the interactive session.
- Unless `MUSE_CLIENTS_FILE` is set, a connector restart forgets every registered client: `claude mcp remove skyhigh`, add it again, authenticate again.

## 3. Codex (terminal)

```
codex mcp add skyhigh --url http://127.0.0.1:5102/mcp
codex mcp login skyhigh
codex exec --approve-for-me "Use the skyhigh tools: what is my SkyHigh points balance?"
```
Sign in as the demo user in the browser.

Traps:
- Plain `codex exec` refuses MCP tool calls because approvals are off, and the call never leaves your machine. Use `--approve-for-me`, or ask inside interactive `codex` and approve.
- Unless `MUSE_CLIENTS_FILE` is set, after a connector restart: `codex mcp remove skyhigh`, add and log in again.
- If PingOne shows `userSessionMismatch`, an old PingOne session in the browser is the usual cause. The connector can sign out of PingOne first (`MUSE_CONNECTOR_SIGNOUT_FIRST=1`), or use a private window.

## 4. Claude web / Desktop and ChatGPT (not verified)

Both connect from the vendor's cloud, so they cannot reach `127.0.0.1`. They need the connector on a public https address and that address set as `MUSE_PUBLIC_URL`. Add it as a custom connector (Claude: Settings, Connectors; ChatGPT: developer mode, Connectors) with `<public https host>/mcp`. Their callbacks are `https://claude.ai/api/mcp/auth_callback` and `https://chatgpt.com/connector_platform_oauth_redirect`; the callback host picks the agent's own PingOne app, so the sign-in screens name that agent. Menu names change, and this path has not been run end to end.

## 5. What to look at while it runs

The connector logs one `[connector]` line per request: status, auth method, redirect host, PKCE, and whether the client id is a URL. It never logs codes, tokens, verifiers or secrets. In Docker: `docker logs agentconnect-local`. A good run shows, in order: `/mcp` 401, `/connector/register` 201, `/connector/authorize` 302, `/connector/resume` 302 (sign-out step, if on), `/connector/token` 200, then `/mcp` `initialize`, `tools/list`, `tools/call`. The line `[connector] gateway steps` shows the gateway status for each step of a tool call.

## 6. Getting the points balance (measured 2026-10-30)

After sign-in the connector asks a gateway for the passenger record. With the right setup, Codex returned the balance and tier, and every gateway step answered 200 (`[connector] gateway steps [[7,200],[8,200],[9,200]]`). What had to be true, in the order the checks run:

1. **The connector sends the gateway the gateway's own scope.** Set `MUSE_P1_GATEWAY_SCOPE=gateway:mcp:invoke`. PingOne then issues a token for the gateway's own resource, which the gateway accepts natively. The default for the Privilege route, `mcp:invoke`, is addressed to a Privilege app and fails further in.
2. **The gateway's per-tool scope check is skipped for tokens with that scope.** A token without it must already carry the tool's own scope (`airlines:read`) and is refused with `insufficient_scope`. The gateway's exchange adds `airlines:read` afterwards.
3. **The PingOne Authorize policy accepts the token's actor.** The connector's own PingOne app is the actor (`act`) in the delegation chain, and the policy keeps a closed list of actors. An actor missing from it is denied as `invalid-actor-chain`.
4. **The backends are running** (the airline backends behind the gateway). With them scaled to zero the gateway answers 502.

Using a local gateway: the connector can call the AI-DEMO2 PingGateway on the local Docker network instead of the hosted chain (owner-run script, `LOCAL_GATEWAY`). Hosting the connector behind the Privilege gateway needs the Privilege audience added in three places (the gateway's accepted audiences, the Authorize policy's audience rule, and the `mcp:invoke` scope), and was not completed.

The signs of each failure, all in the connector log:
- `gateway step 7 refused: invalid_token`: the token is not accepted (audience or scope at the gateway).
- `gateway step 7 refused: access_denied`: the Authorize policy refused (audience or actor); the gateway's own log names the rule.
- `gateway step 9 refused: insufficient_scope`: step 2 above.
- Step 7 is the gateway's `initialize`, 8 the tool list, 9 the tool call.
