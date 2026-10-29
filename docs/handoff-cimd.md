# CIMD handoff (Muse + PingFederate)

Status as of 2026-10-29. Covers only Client ID Metadata Documents. The wider Muse agent-clients work (Claude/ChatGPT/Codex skins, app-per-agent) is in `docs/plan-agent-clients.md`.

## Where things stand

| Item | State |
|---|---|
| Explainer section `#cimd` in `web/public/how-muse-works.html` | In PR #20, not merged, not deployed |
| Dedicated page `web/public/cimd.html` (Real tab, Mock tab) | In PR #20, not merged, not deployed |
| Muse connector supporting CIMD | **Not built.** `server/src/connector.js` lists `none` in `token_endpoint_auth_methods_supported` but has no `client_id_metadata_document_supported`, and `/connector/register` issues a new client per connection (DCR) |
| PingFederate CIMD policy for client.dev | **Not created.** The accepted path is not captured |
| Live CIMD demo (client.dev port with PF as the server) | Planned in the PingFederate standalone by another session. Not started here |

Branch `docs/cimd-explainer`, PR https://github.com/cmuir_pingcorp/muse/pull/20. Live URLs after deploy: `https://muse.ai-demo.ping-devops.com/cimd.html` and `https://muse.ai-demo.ping-devops.com/how-muse-works.html#cimd`.

## What was verified

Captured 2026-10-29, shown on the Real tab:
- `GET https://client.dev/oauth/metadata.json` returns 200 with `client_id` = its own URL, `redirect_uris` `["https://client.dev/oauth/callback"]`, `token_endpoint_auth_method` `none`.
- Local PingFederate `pingidentity/pingfederate:13.1.3` (container `ai-demo-pingfederate`, `https://localhost:9031`, issuer `https://local.ping-devops.com:9031`) advertises `client_id_metadata_document_supported: true`, lists `none`, and also lists a DCR endpoint `/as/clients.oauth2`.
- `GET /as/authorization.oauth2?client_id=https://client.dev/oauth/metadata.json&response_type=code&redirect_uri=https://client.dev/oauth/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=x` returns `400 - Invalid client_id`.

**Not confirmed:** why that 400. PingFederate's docs say it rejects a CIMD request when no enabled CIMD policy matches, which is the likely cause, but this server's policies were not read. The page words it as unconfirmed. Check the policies before repeating the claim.

## Vendor facts (from docs, October 2026)

- **Claude:** `oauth_cimd` is supported by default. Claude uses it only when the server's metadata has `client_id_metadata_document_supported: true` AND `none` in `token_endpoint_auth_methods_supported`; otherwise DCR. Anthropic recommends CIMD over DCR for busy servers. Claude Code's document: `https://claude.ai/oauth/claude-code-client-metadata`. Hosted callback: `https://claude.ai/api/mcp/auth_callback`. **Not confirmed:** the document URL for Claude web/Desktop/mobile.
- **ChatGPT:** prefers CIMD. `client_id` is `https://chatgpt.com/oauth/client.json` or `https://chatgpt.com/oauth/{callback_id}/client.json`. Read from a summary of OpenAI's page.
- **Codex:** supports CIMD and DCR, picks CIMD when advertised, hosted document `https://chatgpt.com/oauth/codex/client.json`, `--oauth-client-id` overrides. Read from a summary.
- **Meta's Muse:** CIMD support not researched.
- **PingFederate:** 13.1 added CIMD. With it on, PF reads `client_id` as an address, checks enabled CIMD policies, fetches and validates the document, and creates an ephemeral client. It rejects the request if no policy matches or the document is inconsistent. 13.1.1 fixed rejecting `http://` loopback `client_id` URLs; 13.1.3 made CIMD fetches honour the forward proxy. The docs warn the spec is an evolving draft. A CIMD client gets no authorization detail types (RAR) in 13.1.

Sources:
- https://claude.com/docs/connectors/building/authentication.md
- https://developers.openai.com/apps-sdk/build/auth
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://docs.pingidentity.com/pingfederate/13.1/administrators_reference_guide/pf_cimd.html
- https://modelcontextprotocol.io/specification/draft/basic/authorization/client-registration.md
- https://client.dev/ (source: github.com/stytchauth/client.dev, MIT, keep the notice if ported)

## Related work that already exists

- AI-DEMO2 `/pingfederate-ai-agent` page exercises PF CIMD behind `PF_AI_CIMD_ENABLED`. Our public document and callback are served at `/api/pf-ai-agent/cimd/client-metadata.json` and `/api/pf-ai-agent/cimd/callback` (see `docs/ENV.md`, section "PingFederate AI Agent feature demos"). Worktree: `~/Development/AI-DEMO2-pf-nav`.
- `docs/2026-10-07-cimd-privilege-client-documents.md` (AI-DEMO2): our agents publish CIMD documents for PingOne Privilege's MCP Client Documents list. Privilege accepting our documents was not yet proven when written.
- Owner rule (2026-10-28): PingFederate demos use real PingFederate only, never a mock. The CIMD demo is a port of client.dev with PF as the server and PF fetching our document. The Mock tab on `cimd.html` is about Muse's own not-yet-built connector, not PF.

## What building CIMD in Muse's connector would take

Nothing here is started. Owner decision needed first: build it in Muse, or leave Muse as the explainer and put the live demo in the PF standalone.

1. Advertise `client_id_metadata_document_supported: true` in the connector's authorization-server metadata.
2. In `/connector/authorize`, when `client_id` is an HTTPS URL: fetch the document, then check (a) HTTPS and a public host, resolved IP not private/loopback/cluster (SSRF), (b) small body, short timeout, JSON, (c) document `client_id` equals the URL, (d) request `redirect_uri` exactly matches one of `redirect_uris`, (e) `token_endpoint_auth_method` is `none`, (f) host on a Muse allow-list.
3. Keep the static client (`airline-connector`) and the host allow-list working. Map accepted documents to the right PingOne app per agent (`MUSE_CONNECTOR_AGENTS`, PR #17). That variable is not yet set in the `muse-real` Secret (owner's vault step).
4. Tests in `server/test/connector.test.js`: advertises the flag, accepts a valid document, refuses each failure in the table on `cimd.html` (mismatch, unlisted callback, non-HTTPS, private host).
5. Diagrams Runtime D/E/F, `docs/mocks/agent-clients.html` and `docs/plan-agent-clients.md`: replace "registers itself / gets a client ID" with "presents its client_id URL" for Claude, ChatGPT, Codex.
6. Directory-only rule (PR #18) still applies; CIMD removes the registration step and fits it.

## Open items

1. Add a PF CIMD policy for `https://client.dev/` on the local PF, then recapture step 3 to get the accepted path (fetch, sign-in, code to client.dev callback). Shared local PF, so the owner or the PF-lab session should do it.
2. Read the PF's existing CIMD policies to confirm the cause of the 400.
3. Confirm the CIMD document URL for Claude web/Desktop and check Meta's Muse.
4. Merge and deploy PR #20 (merge commit, CI green first; deploy with `~/.claude/muse-priv/muse-hosted-2-image.sh` and `muse-hosted-3-deploy.sh`, verify by content).
5. Decide where the live demo lives (Muse vs PF standalone) so it is not built twice.

## Traps

- Do not rebase pushed branches; merge main in (force-push is blocked).
- `main` is checked out in `~/Development/muse`; work from this worktree on a branch.
- Verify deploys by content, not a 200 (a restart gives a 503 for a moment).
- The how-it-works page was also edited by PR #18 (United's session); expect merge conflicts around `#connect` and `#publish`.
