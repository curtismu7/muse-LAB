# Muse: packaging and deployment handoff

Written for: an agent who will package Muse (zip, image or both) and deploy it. Status as of 2026-10-29, muse `main` at `1e14802` (the live Real pod runs `f66bdca`; the mock-only pod runs `0cdad69`). Repo: `cmuir_pingcorp/muse` (private). Nothing in this doc has been run as a packaging job: the facts below are from the repo, the live site, and the checks named.

## What Muse is now

A personal-agent demo with two modes. Pick the mode before you package.

| | Mock-only (`MODE=mock`, the default) | Real (`MODE=live`) |
|---|---|---|
| Talks to | nothing outside the pod: a simulated PingOne flow, stub gateway | a real PingOne tenant (DaVinci, Protect, MFA), the Privilege/Agent Gateway, the OBO token exchanges |
| Needs | nothing | a Kubernetes Secret named `muse-real` (owner-made, never committed) |
| Pages | `/`, `/diagram`, `/how-agent-connect-works.html`, `/cimd.html`, `/clients.html` | the same, plus a working **Sign in live** on `/clients.html` and "Connect from your assistant" on `/` |
| Right for a zip? | **Yes.** No tenant, no secrets | **No.** It would carry tenant identifiers |

**Update 2026-10-29 (late):** the site is renamed **Agent Connect** (the personal agent inside it is still Muse; the repo keeps its name). Hosts: real `https://agent-connect.ai-demo.ping-devops.com/` (Real mode) and mock-only `https://agent-connect-mock.ai-demo.ping-devops.com/`; the old `muse` and `muse-mock` hosts answer 301 to them. Both run `sha-17e5dea` (conformance #43 and the dark-mode diagram fix #44). Everything below that names the old hosts or older images is kept as written but is out of date on those two points.

Live today at `https://agent-connect.ai-demo.ping-devops.com/` (Real mode; pod image `ghcr.io/cmuir_pingcorp/muse:sha-f66bdca1afe08ec672326928f832f9494ff627de`).

**Update 2026-10-29 (after #26, by United's session):** the mock-only SE build now exists and is live at `https://agent-connect-mock.ai-demo.ping-devops.com/` (`APP_NAME=muse-mock`, `MODE=mock`, image `sha-0cdad69`). Checked by content: `/api/health` is `demo-health/1`, `/api/session` shows `mode: mock`, live unavailable, no connector. A zip exists at `~/Downloads/demo-rollout/muse-1e14802.zip`. United rebuilt it to follow the include/leave-out lists below (76 files; per United, 110 tests pass from a fresh unzip; I have not re-run that). The connector is off on the mock host (`POST /mcp` is 404, per United). `README.md` has a "Hosted builds" section from #26; it is current for `MODE` and `APP_NAME`. The owner decision that no separate stub connector or gateway is built still stands: the mock build is Muse's existing offline mock (simulated sign-in, Protect and gateway), not a new stub.

Owner decision 2026-10-29: `/clients.html` with its scripted run is the mock-only version. Do not build a separate stub connector or gateway.

## Stack and commands

Node 26, npm workspaces (`server`, `web`). React 19 + Vite for the web, Express for the server, no database (workspaces are per visitor, in memory, capped).

```
npm ci
npm test            # server suite, node:test: 106 tests, all pass on main
npm run build       # web bundle into web/dist
npm start           # http://127.0.0.1:5100/  (loopback only unless MUSE_HOSTED=1)
```

Docker (`Dockerfile`, two stage, runs as `node`, healthcheck on `/api/health`, no secrets baked in):

```
docker build -t muse .
docker run --rm -p 127.0.0.1:5100:5100 muse      # publish on loopback only
```

Orb Stack is the Docker runtime on this machine, not Docker Desktop. For the cluster the image must be `linux/arm64`.

Environment (all optional for mock-only): `MODE` (mock|live, default mock in the image), `PORT` (5100), `MUSE_BIND` (0.0.0.0 in the image), `MUSE_HOSTED=1`, `MUSE_ALLOWED_HOSTS` (the host the browser uses; must match the Origin), `MUSE_MAX_WORKSPACES` (60).

Check it by content, not by a 200:
- `GET /api/health` must return `{"schema":"demo-health/1","state":"ready",...}`.
- `node scripts/doctor.mjs http://127.0.0.1:5100` runs the doctor.
- Open `/clients.html?client=codex` and press **Next step** eight times: the last line says 52,000 points. With no connector, **Sign in live** is disabled with a reason.

## What goes in a zip (mock-only)

Include (from `git ls-files`): `package.json`, `package-lock.json`, `server/` (src + package.json), `web/` (src, public, index.html, vite config, package.json), `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `k8s/`, `scripts/doctor.mjs`, `content-pack.json`, `docs/shelf-entry.json`, `docs/talk-track.md`, `README.md`.

Leave out:
- `node_modules/`, `web/dist/`, `.git/`, `.env*`: rebuilt or private.
- **Everything outside the repo that the owner keeps for the real deployment:** `~/.claude/muse-priv/` (Secret builder, deploy and rollback scripts, `connector.env`, the PingOne recipe scripts), and the AI-DEMO2 vault. These hold or read tenant settings and secrets.
- `docs/handoff-*.md`, `docs/HANDOFF.md`, `docs/plan-agent-clients.md`, `docs/protect-davinci.md`, `docs/mocks/`: internal notes that name the SE host, the PingOne setup, and peer sessions. Not for a customer-facing zip.

Never put in a zip or an image: any value from the `muse-real` Secret, PingOne client secrets, tenant or environment ids, app client ids, gateway addresses.

## Known problems to fix before calling a zip portable

1. **(Fixed in #35, pinned by the portable guard test from #38/#39.)** Hard-coded SE host. `muse.ai-demo.ping-devops.com` appears in `web/public/cimd.html` (2), `web/public/clients.html` (1), `web/src/diagrams/muse-config.json` (3), `muse-runtime-d.json` (2), `muse-runtime-f.json` (2), and `README.md` (1). The standalone rules allow only `.example` / `.invalid` hosts. Decide: replace with `https://muse.example` or drive from `MUSE_PUBLIC_URL`. The hostname is public, not a secret, but the zip would point at our site.
2. **Stale docs in the repo.** `README.md`, `CLAUDE.md` and `docs/HANDOFF.md` say "mock only, no tenant, no OBO". The code now has Real mode. Do not trust those three for behaviour; this file is current.
3. **(Fixed in #43: the gate now shows 0 failed, 0 warnings; the list below is the state before.)** Conformance gate (`node ~/Development/demo-kit-base/scripts/conformance.mjs <repo>`, run 2026-10-29): 15 pass, **4 FAIL**, 1 warn.
   - FAIL rule 1: netguard (zero outbound by default).
   - FAIL rule 12: `customer.config`.
   - FAIL rule 13: workspace id.
   - FAIL rule 10: stories use `{{cast}}` tokens.
   - WARN rule 18: MODE switch for the mock-only build (the `MODE` env exists in the image and `k8s/deploy.sh`, but the checker does not see it as a switch).
   Muse predates these rules. Fix or get the owner to waive each before shipping as a standalone.
4. **Real-only code is in the same image.** The code is present in every build. Since #26, `MODE=mock` refuses live even when `ALLOW_LIVE` and the Secret are present (per United's description of #26; I have not tested that refusal myself), and `k8s/deploy.sh` with `MODE=mock` does not wire the Secret.
5. **Vendor names and logos.** The `/clients.html` skins use real Claude/OpenAI colours and logos by owner decision (logo SVGs under `web/public/brands/`, public-domain/CC0 from Wikimedia Commons, unchanged). Keep the "Simulated" badge and ribbon.

## Deploying to the SE cluster

Rules: the owner approves the first deploy of anything new. Verify by content, then hand over the full `https://` URL. Use `kubectl` against namespace `ping-devops-cmuir`, deployment `muse`.

Mock-only build, from the repo (`k8s/deploy.sh`; refuses without `OWNER_APPROVED=1`, an immutable image tag, and a plain host name; `--dry-run` renders and applies nothing):

```
OWNER_APPROVED=1 NAMESPACE=<ns> IMAGE=ghcr.io/cmuir_pingcorp/muse:sha-<full sha> SE_HOST=<host> MODE=mock bash k8s/deploy.sh
```

The real site is deployed with the owner's private scripts (not in the repo, not for a zip):
1. `MUSE_WT=<worktree> bash ~/.claude/muse-priv/muse-hosted-2-image.sh`: builds `linux/arm64` and pushes `ghcr.io/cmuir_pingcorp/muse:sha-<sha>`. It refuses a dirty worktree.
2. `IMAGE=<that tag> bash ~/.claude/muse-priv/muse-hosted-3-deploy.sh`: applies the manifests with `MODE=live` and verifies.

Before any deploy, prove the live image is an ancestor of yours, or you will roll someone's change back:
```
LIVE=$(kubectl -n ping-devops-cmuir get deploy muse -o jsonpath='{.spec.template.spec.containers[0].image}')
git merge-base --is-ancestor ${LIVE##*sha-} HEAD && echo safe
```
Other sessions deploy this app too. Say what you are about to deploy to the peer sessions (United owns the PingOne/Privilege tenant steps) and wait if one is mid-deploy. There is one replica and it cannot surge.

The `muse-real` Secret holds these keys (names only): `ALLOW_LIVE`, `MUSE_ALLOW_LIVE_HOSTED`, `MUSE_CONNECTOR`, `MUSE_CONNECTOR_AGENTS`, `MUSE_CONNECTOR_AIRLINE`, `MUSE_CONNECTOR_CLIENT_ID`, `MUSE_CONNECTOR_REDIRECT_HOSTS`, `MUSE_CONNECTOR_REDIRECT_URIS`, `MUSE_LIVE_GATEWAY_URL`, `MUSE_P1_CLIENT_ID`, `MUSE_P1_CLIENT_SECRET`, `MUSE_P1_ENV_ID`, `MUSE_P1_LANE`, `MUSE_PUBLIC_URL`, `MUSE_USER_CLIENT_ID`. The owner writes the Secret (`muse-hosted-1-secret.sh`); the classifier blocks agents from writing vault secrets. A running pod reads the Secret only at start, so a Secret change needs `kubectl -n ping-devops-cmuir rollout restart deployment/muse`.

## What lives in the tenant, not in the zip

Real mode depends on setup in the PingOne tenant and Privilege. None of it is in this repo, so a zip cannot reproduce it:
- PingOne apps: "Muse agent login", "Muse user login", and one agent login app each for ChatGPT, Claude and Codex.
- The DaVinci parent flow (v79) and its "Read login hint" function that maps each app to an agent name, an agreement and the "AI agent detected" screen.
- Protect: the `museAgentClient` predictor (all four app ids in its HIGH list) in the default risk policy.
- Agreements: Airline Connector Consent, ChatGPT Consent, Claude Consent, Codex Consent.
- PingOne Authorize snapshot (`~/Downloads/Muse_4agents_audience_P1AZ.snapshot.json`, the owner imports it).
- Privilege: the grant rule `muse-ig` with `act.sub` any-of the four app ids.
A mock-only zip needs none of this.

## Who knows what

- This session (CIMD): the `/clients.html`, `/cimd.html` and Codex PingOne work, and this doc.
- United: the PingOne and Privilege tenant steps, the Secret builder, contrast and look of the main app. Ask it before changing anything in the tenant.
- agents-fc / agents-30 / agents-be / agents-e0: not Muse.

## Rules that apply

Load the `standalone-demo` skill and read `~/Development/STANDALONE-RULES.md` (changes often; it wins over this doc). Repo creation, first deploy and any Secret or vault write need the owner. Commits end with the Co-Authored-By line from the session's attribution reminder. Never edit `~/Development/AI-DEMO2` (use a worktree). Never print the forbidden-strings list.

## Not verified

- I have not built a zip or standalone image from this repo; the existing zip and the `muse-mock` deploy are United's and I have not inspected the zip's contents beyond its file count.
- A full local mock-only run (`npm start` with no Secret) was not started in this session. The page behaviour with the connector off was checked in a browser against a stubbed session.
- The four conformance failures above are unfixed.
