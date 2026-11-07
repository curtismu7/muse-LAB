# Handoff to United: the real per-platform paths (Claude, ChatGPT, Codex)

(Status note, late 2026-10-29: United has since built the real engine in #34 and #41, the site is renamed Personal Agent, and the host names below are the new ones.)

Written for: the United agent, who now owns making the ChatGPT, Claude and Codex paths do what those platforms really do. From the CIMD session, 2026-10-29. Repo `cmuir_pingcorp/muse`, `main` at `fc2f9d5` when written. The live Real pod runs `sha-fc2f9d5…`; the mock host `agent-connect-mock.ai-demo.ping-devops.com` runs your `sha-0cdad69` and still serves the older `cimd.html` until you next deploy it.

## Owner decisions that bind you

1. **2026-10-29:** `/clients.html`'s scripted run IS the mock-only version. No stub connector, stub gateway or separate mock-only app. (The `agent-clients-demo` scaffold that planned one is archived.)
2. **2026-10-29, relayed by you:** DCR for platforms that support it, CIMD for platforms that support it, and **real PingFederate does the CIMD**. No CIMD in Muse's own connector: Muse fronts PingOne, and this tenant's PingOne has no CIMD (no `client_id_metadata_document_supported`, no registration endpoint; read live). The owner also told me directly: CIMD only where the environment supports it.
3. **2026-10-29 (via you):** the platform paths must be "real (might be mock, but does what those platforms actually do)". Today `/clients.html` and your AssistantConnect card are shells: Muse's server runs the sign-in with a per-vendor PingOne app.
4. Customers connect only from the platform's directory. **Codex is the one developer path** where a person adds the server address by hand (owner, 2026-10-29).
5. Real logos and colours are fine; keep the "Simulated" badge and ribbon. PF demos use real PingFederate only, never a mock.

## What I built and is live

- **`/clients.html`** (`web/public/clients.html`, PRs #21, #22, #24): four look-alike skins (Muse, Claude, ChatGPT, Codex), a scripted run (Next step, Play), and **Sign in live**. Live posts `POST /api/live/signin {as:'assistant', assistant:<key>, mfa, returnTo:'/clients.html?client=<name>'}`, goes to PingOne, comes back through `/api/callback`, and the page replays the chat with the real points or the gateway's real refusal. Keys come from `session.connector.assistants` (`claude`, `chatgpt`, `codex`, `meta-ai`); Codex falls back to `meta-ai` if the Secret has no Codex entry. Codex is labelled the developer path.
- **Server** (`server/src/index.js`, `connector.js`): `returnTo` is an allow-listed regex `^/clients\.html\?client=[a-z]{1,12}$`, anything else goes `/`. An entry in `MUSE_CONNECTOR_AGENTS` may omit `hosts` (Codex); it is only chosen by assistant key, never by callback host. Tests: 110 pass on main (mine plus yours).
- **Codex in PingOne:** app "Codex agent login", agreement "Codex Consent", Codex id in the Protect `museAgentClient` HIGH list, DaVinci parent flow **v79** (backup of v78 in my scratchpad copy of your recipe). Your four-agent gateway check passed afterwards.
- **`/cimd.html`** (PRs #20, #27, #31, #32) and `docs/handoff-cimd.md`: real vendor documents, real Linear/Notion exchanges, a collapsed PingFederate section.
- **Docs:** `docs/handoff-deployment.md` (packaging), `docs/plan-agent-clients.md` (status line).

## Agreed interface for the button (not built yet)

You plan `POST /api/sim/start {platform:'chatgpt'|'claude'|'codex', server:'muse'|'pf'}` returning `{authorizeUrl}`, then after the platform callback `GET /api/session.sim` returning `{platform, method:'dcr'|'cimd', steps:[{n,title,request,response}], points}`. When you confirm the exact fields I will change only `web/public/clients.html` to call it and render the steps. I will not touch it before then. I stood down on `connector.js` CIMD and on the client engine; both are yours.

## Verified facts you can build on

Real documents, fetched 2026-10-29 (exact fields in `docs/handoff-cimd.md` and on `/cimd.html`):
- **ChatGPT** `https://chatgpt.com/oauth/client.json`: `private_key_jwt` (RS256, `jwks_uri` `https://chatgpt.com/oauth/jwks.json`), also lists `none`; callback `https://chatgpt.com/connector_platform_oauth_redirect`.
- **Codex** `https://chatgpt.com/oauth/codex/client.json`: public client, `none`, callbacks `http://127.0.0.1/callback` and `http://localhost/callback`.
- **Claude Code** `https://claude.ai/oauth/claude-code-client-metadata`: public, `none`, same loopback callbacks. Claude web/Desktop/mobile callback is `https://claude.ai/api/mcp/auth_callback`.
- Loopback: any port matches (Linear accepted `http://127.0.0.1:1455/callback` against a port-less document).
- Real servers: Linear and Notion advertise CIMD, accept the ChatGPT and Codex documents (Linear: 200 consent page built from the document; Notion: 302), and refuse an unlisted callback with 400. Also advertise the flag (not tried): Sentry, Vercel, Cloudflare, Canva, Monday, Shopify, WorkOS, Stytch.
- Claude picks CIMD only if the AS advertises the flag AND lists `none`; otherwise DCR.

PingFederate (owned by agents-f5 and agents-fc, not me):
- SE PF `cmuir-pf.ping-devops.com` and local 13.1.3 advertise CIMD, `none` and `private_key_jwt`, and a DCR endpoint `/as/clients.oauth2`. Acme PF `cmuir-pf-acme.ping-devops.com` does not advertise CIMD.
- agents-fc's three CIMD policies each allow one exact metadata URL, PKCE required. agents-f5 added policy `cimdLabClientDev` (client.dev only) and an opaque-token ATM `cimdLabRefAtm`. client.dev now passes PF's fetch and validation; the sign-in then fails with `302 ... error=server_error` because `cimdLabRefAtm` has no access-token mapping for the login adapter. The fix is one additive mapping awaiting owner approval. (My first explanation, "no authn selector", was wrong and is corrected on `/cimd.html`.) agents-f5's standalone is `~/Development/cimd-lab`, local, not pushed.
- Do not edit the PF or its policies yourself; ask agents-f5 and agents-fc, and write owner-run scripts for shared config.

## Not verified

- The CIMD document URL for Claude web/Desktop/mobile (docs show only Claude Code's).
- ChatGPT's JWKS body, and whether ChatGPT falls back to `none` when a server lacks `private_key_jwt`.
- The token step with a real signed-in user on Linear or Notion (only the authorize step was captured).
- Whether the muse-mock host and the zip match current `main` (you built them; I only checked file counts).

## Traps

- Before any deploy, prove the live image is an ancestor of yours: `LIVE=$(kubectl -n ping-devops-cmuir get deploy muse -o jsonpath='{.spec.template.spec.containers[0].image}'); git merge-base --is-ancestor ${LIVE##*sha-} HEAD`. One replica, it cannot surge.
- Vault writes, shared PF/Privilege/tenant config and repo creation are classifier-blocked or owner-approved: hand the owner a script.
- Agreement language will not enable until the revision's `effectiveAt` (+8s) passes: rerun.
- Build the PingOne Authorize import from the LATEST snapshot (the audience one); `muse-rc-set.mjs` REPLACES the whole `act.sub` list, give all ids.
- Headless Chrome is rated HIGH by Protect's bot detection, so headless tests always see the agent screen.
- PingOne screens only name an agent if its app id is in the Protect list and the flow's "Read login hint" function maps it (apply-codex.mjs shows how; flow is v79, back up before any change).
- The scripted Playwright check I used for `/clients.html` lives only in my session scratchpad, not in the repo. Ask me and I will copy it somewhere you can read.
- Do not force-push or rebase pushed branches; merge main in.

## Who owns what

- You: the real per-platform engine, mock vendor documents, a possible `/mcp-pf` resource, Muse tenant steps, the muse-mock host and zip.
- agents-f5: PingFederate CIMD capture (`cimd-lab`). agents-fc: PF demo policies in AI-DEMO2. agents-9e: demo-rollout zips (and archived `agent-clients-demo`).
- Me: wire the button when you confirm the interface; update the `/cimd.html` Real tab when agents-f5 sends a capture.
