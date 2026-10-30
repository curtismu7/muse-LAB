# Real connection test: Claude, ChatGPT, Codex

Written for: the owner running the test, and any agent recording the results.

Goal: connect each real client to the live Agent Connect connector and record what each one actually sends. This settles the two open questions: Claude's client document URL, and whether ChatGPT falls back to `none` when `private_key_jwt` is unavailable.

Target: `https://agent-connect.ai-demo.ping-devops.com/mcp` (the real host; the mock host has no connector).
Discovery, already checked live on 2026-10-30:
- `/.well-known/oauth-protected-resource` returns 200.
- `/.well-known/oauth-authorization-server` returns 200 and advertises `/connector/register` (DCR).
- `POST /mcp` without a token returns 401 with `WWW-Authenticate` pointing at the resource metadata.

## Before any client

1. Confirm the connector is on: `GET /api/session` shows a `connector` block (it does today).
2. Start a log watch on the pod so each client's requests are captured: `kubectl -n ping-devops-cmuir logs -f deploy/muse` (watch for `/connector/register`, `/connector/authorize`, `/connector/token`, `/mcp`).
3. Use the demo user (the one used for the live sign-in on `/clients.html`). Do not paste its password into any chat.

## Per client

For each: add the connector, sign in, ask the agent "What's my SkyHigh points balance?", then record the table below.

| Client | Where to add it | Callback it should use |
|---|---|---|
| Claude (web or Desktop) | Settings > Connectors > Add custom connector, URL above | `https://claude.ai/api/mcp/auth_callback` |
| ChatGPT | Settings > Connectors (developer mode) > Create, URL above, auth OAuth | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Codex CLI | `codex mcp add skyhigh --url <URL above>` then `codex mcp login skyhigh` | `http://127.0.0.1:<port>/callback` |

Exact menu names change; if one differs, note the real path.

## What to record (per client)

- Did it call `/connector/register` (DCR) or present a `client_id` URL (CIMD)? If a URL: that URL is the answer to the Claude question.
- Request body of the registration: `token_endpoint_auth_method`, `redirect_uris`, `grant_types`.
- At `/connector/token`: `client_assertion_type` present? (ChatGPT: `private_key_jwt`, or none.)
- Whether PKCE (`code_challenge`, S256) was sent.
- Whether the PingOne screen named the right agent (Claude, ChatGPT or Codex) and SkyHigh Airlines.
- Whether the tool call returned the points balance, and the `act` claim in the token.
- Any error and its exact text.

## Pass / fail

- Pass: sign-in completes, `/mcp` returns data for the demo user, and the screen names the right agent.
- Fail: stop and capture the log lines; do not retry more than twice.

## Ground rules

- Real host only; nothing here touches the mock.
- No tenant ids, secrets or the demo password in notes or screenshots that get committed.
- A client that registers with an unlisted callback should be refused (400); that refusal is a pass for that check.

## After

I turn the results into a short table in `docs/handoff-cimd.md` and `cimd.html` (the open Claude URL and the ChatGPT fallback), through a normal PR.
