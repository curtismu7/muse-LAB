# Muse handoff (2026-10-27)

Muse is a mock-only personal-agent demo. Sam asks Muse (an agent) for things; PingOne Protect decides agent or person; an agent needs Sam's consent; then the gateway checks the call. Tier: Demo. Repo: `cmuir_pingcorp/muse` (private). Local only: `~/Development/muse`.

## State

- Local HEAD `ef22619`. **Not pushed**: origin has up to `cf477cc`. Two commits wait: live Protect mode, and the authorization flow.
- Server tests: 49 pass, 0 fail (Node 22 only). The web build compiles.
- **No browser check has been done.** The Chrome extension stayed disconnected. The consent modal, in-chat steps, new diagram and composer are untested in a browser. The 401 → authorize → consent → retry sequence is verified over HTTP only.
- Local server: `npm start` on `http://127.0.0.1:5100/` (PID may have changed; check `lsof -ti tcp:5100`).
- Explainer page (private): https://claude.ai/artifact/XEqcbPfYPGtftra4cu7gvj, Version 3. Source: the scratchpad copy `how-muse-works.html` of the session that built it; republish from there or rewrite.

## The flow (as built)

1. Muse calls `POST /api/request` with no token → **401** `invalid_token`.
2. Muse calls `POST /api/authorize {client}`. Protect assesses the caller (`server/src/protect.js`).
3. Person (`browser`): token issued. Agent (`muse`): `consent_required`, and the UI shows the modal ("This is a bot. Do you consent...").
4. `POST /api/consent {client, approve}`: yes issues the token; no gives 403 and no token.
5. Retry. The gateway (`server/src/gateway.js`) runs Muse-detect (burst: 7 calls in 60 s held; injected instruction blocked), Privilege coarse (persona allowlist), fine (payments over 500 held, exports over 100 rows denied, drafts over 2000 characters denied). Most restrictive wins: blocked > held > allowed.

Tokens live per workspace per channel (`ws.tokens`); sign-out and reset clear them. Workspaces are per visitor (cookie `muse_ws`), capped at `MUSE_MAX_WORKSPACES`.

## Where things are

| Area | File |
|---|---|
| Routes, host and same-origin checks | `server/src/index.js` |
| Protect (mock and live) | `server/src/protect.js` |
| Gateway decisions | `server/src/gateway.js` |
| UI, callTool 401 loop, consent modal | `web/src/App.jsx` |
| Flow diagram player | `web/src/PersonalAgentFlow.jsx` |
| Diagram data (diagram-studio/1) | `web/src/diagrams/personal-agent-flow.json` |
| Live Protect setup | `docs/protect-davinci.md` |
| Talk track, shelf entry | `docs/talk-track.md`, `docs/shelf-entry.json` |

## Live Protect (owner-run, not run yet)

`PROTECT_MODE=live` with `PROTECT_FLOW_URL`, `PROTECT_API_KEY`, `PROTECT_RISK_POLICY_ID`. Refused when `MUSE_HOSTED=1`. Fails closed (HTTP error, timeout, missing risk level, or HIGH risk blocks). Tested against an in-process stub only; the header name and body shape are unverified against a real flow. Starter: the "CIAM Plus With Protect - Threat Detection - Subflow" DaVinci export in `~/Downloads` (keep it out of the repo: it carries tenant ids). That subflow scores risk; it does not say agent or person. A parent flow attached to a dedicated Muse PingOne application has to branch on `applicationId` and return `caller`. That reading of PingOne is from memory, not tested in a tenant.

## Open items

1. **Browser check** of the UI once the Chrome extension connects (composer, Muse vs Sam caller switch, consent modal both answers, approve in place, diagram replay).
2. **Push** the two local commits (owner decision).
3. **Tenant work** (needs owner approval): parent DaVinci flow, Muse PingOne application, Protect risk policy; then one live run, recorded in `docs/protect-davinci.md`.
4. **CI**: no self-hosted runner registered for this repo, so checks queue. Node 20 run not done.
5. **SE deploy** of the mock build: needs owner approval (`k8s/deploy.sh` has `--dry-run` and gates).
6. **Catalog id** `D21` in `content-pack.json` is provisional and may clash with `personal-agent-demo`. Learning Hub validator not run.
7. **Diagram authoring** belongs in diagram-studio (another agent's repo); Muse only loads the JSON by id.
8. Independent review passes (rulebook step 3) not done. The shelf doctor fails on another entry (`personal-agent-demo`), not Muse.

## Gotchas

- `curl` examples in zsh need quoting care; use `bash -c`.
- Port 5100 gets stolen by stale processes; kill by port before restarting.
- `node --test test/*.test.js` with a glob, from `server/`.
- OBO is not supported by Privilege yet; Muse acts as itself.
- Mock only: no tenant ids, secrets or real outbound calls in the image or manifests.
