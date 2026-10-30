# Connect an agent to Agent Connect: setup for each agent type

Written for: colleagues who run or demo Agent Connect and need to connect an agent to it.

Two things are called "Muse" or "the connector" here, so to be exact:

- **The scripted run** (`/clients.html`) shows each client's connect flow with look-alike screens. It needs nothing but the app. It does not connect a real agent.
- **The Airline Connector** is an MCP server (tools `loyalty_balance`, `get_loyalty_status`) on `<host>/mcp`. Real agents connect to it. It exists only in **real mode**; in mock mode `/mcp` answers 404. PingOne signs the user in; the connector brokers the redirect and the agent never sees the PingOne token.

What was measured against a real connector (2026-10-30), per agent:

| Agent | Registers by | Sign-in | Tool call | Status |
|---|---|---|---|---|
| Claude Code (CLI) | dynamic registration (DCR) | works | `tools/list` works | balance call not proven |
| Codex (CLI) | DCR | works | `tools/call` reaches the connector; the gateway answer was failing on the last run | in progress |
| Claude web / Desktop | not tested | not tested | not tested | needs a public https host |
| ChatGPT | not tested | not tested | not tested | needs a public https host |

Muse's connector does not use CIMD, because it sits in front of PingOne, which has no CIMD. CIMD is a PingFederate feature (see `/cimd.html`).

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
- After the connector restarts, it forgets every registered client: `claude mcp remove skyhigh`, add it again, authenticate again.

## 3. Codex (terminal)

```
codex mcp add skyhigh --url http://127.0.0.1:5102/mcp
codex mcp login skyhigh
codex exec --approve-for-me "Use the skyhigh tools: what is my SkyHigh points balance?"
```
Sign in as the demo user in the browser.

Traps:
- Plain `codex exec` refuses MCP tool calls because approvals are off, and the call never leaves your machine. Use `--approve-for-me`, or ask inside interactive `codex` and approve.
- After the connector restarts: `codex mcp remove skyhigh`, add and log in again.
- If PingOne shows `userSessionMismatch`, an old PingOne session in the browser is the usual cause. The connector can sign out of PingOne first (`MUSE_CONNECTOR_SIGNOUT_FIRST=1`), or use a private window.

## 4. Claude web / Desktop and ChatGPT (not verified)

Both connect from the vendor's cloud, so they cannot reach `127.0.0.1`. They need the connector on a public https address and that address set as `MUSE_PUBLIC_URL`. Add it as a custom connector (Claude: Settings, Connectors; ChatGPT: developer mode, Connectors) with `<public https host>/mcp`. Their callbacks are `https://claude.ai/api/mcp/auth_callback` and `https://chatgpt.com/connector_platform_oauth_redirect`; the callback host picks the agent's own PingOne app, so the sign-in screens name that agent. Menu names change, and this path has not been run end to end.

## 5. What to look at while it runs

The connector logs one `[connector]` line per request: status, auth method, redirect host, PKCE, and whether the client id is a URL. It never logs codes, tokens, verifiers or secrets. In Docker: `docker logs agentconnect-local`. A good run shows, in order: `/mcp` 401, `/connector/register` 201, `/connector/authorize` 302, `/connector/resume` 302 (sign-out step, if on), `/connector/token` 200, then `/mcp` `initialize`, `tools/list`, `tools/call`. The line `[connector] gateway steps` shows the gateway status for each step of a tool call.
