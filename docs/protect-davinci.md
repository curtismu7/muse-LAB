# Live Protect with DaVinci (owner-run)

Muse's Protect step is simulated by default. Live mode sends each request to a DaVinci flow that creates a PingOne Protect risk evaluation. It is **owner-run only**: the hosted/SE build refuses it, and nothing in this repo contains tenant ids.

## Status

The Muse side is built and tested against an in-process stub. It has **not** been run against a real tenant. The tenant side (below) still has to be built and approved.

## What the starter gives you

The starter is the "CIAM Plus With Protect - Threat Detection - Subflow" DaVinci export (kept outside this repo, because exports carry tenant ids). It:

- takes `p1UserName`, `p1UserId`, `p1ProtectRiskPolicyId`, `flowType`, `ipAddress`, `userAgent`, `SessionId`, `customAttributes`, `applicationId`, `usercookie`;
- skips the check for registration flows or an empty user id;
- calls PingOne Protect **create risk evaluation**, and on failure marks the evaluation FAILED;
- returns `protectRiskEvalId`, `protectRiskLevel` (LOW/MEDIUM/HIGH), `protectPredictor` (the recommended action), `protectDeviceStatus`.

It does **not** decide agent versus person. That is what the Muse parent flow adds.

## Where it runs

Protect runs once, at authorization, not on every tool call:

1. Muse calls the gateway with no token and gets 401.
2. Muse sends an authorization request to PingOne (its own PingOne application, so the flow can tell Muse from a browser by `applicationId`).
3. PingOne signs Sam in, and the application's DaVinci flow policy calls the Protect subflow.
4. Not Muse: PingOne assumes a person and issues the token. Muse: Sam sees "this is a bot, do you consent?" and the token is issued only on yes.
5. Muse retries the call. The gateway then runs Muse-detect and the Privilege coarse and fine checks.

One login flow is enough: attach a DaVinci flow policy to the Muse application, and have that flow call the Protect subflow (Flow Conductor), then branch on the result. pi.flow is how Muse drives that flow without a redirect; it does not call the subflow itself. This is from the PingOne documentation as recalled, not tested in a tenant.

## What to build in the tenant

1. A **parent flow** with an API trigger that calls the subflow with the inputs Muse sends (below) and returns the subflow's outputs as JSON. Turn on API key access for it and note the flow URL.
2. A **Protect risk policy** that scores Muse's declared agent client (user agent `Muse-Agent/1.0`, `customAttributes.channel`) differently from a browser. Without this, Protect only returns the generic risk level.
3. Optional: have the parent flow return `caller` (`agent` or `human`). Muse uses it when present; otherwise it trusts the channel the request declared.

## What Muse sends and reads

Request body: `flowType` (AUTHENTICATION), `p1UserName`, `p1ProtectRiskPolicyId`, `ipAddress`, `SessionId` (a hash, never the workspace cookie), `userAgent`, `customAttributes` (JSON with `channel`). Header `x-sk-api-key`.

Response: `protectRiskLevel` (required), `protectPredictor`, `protectRiskEvalId`, optional `caller`.

- HIGH risk blocks the call.
- Any failure (HTTP error, timeout, missing level) blocks the call. Protect fails closed.
- Agent callers still need Sam's consent. Person callers go straight on.

## Run it

    PROTECT_MODE=live \
    PROTECT_FLOW_URL=https://<your flow url> \
    PROTECT_API_KEY=<flow api key> \
    PROTECT_RISK_POLICY_ID=<risk policy id> \
    npm start

`GET /api/session` reports `protectMode` (`mock` or `live`). The flow URL must be https, or loopback http for a local stub. Keep the key out of git.

## Open

- Confirm the API trigger header name and body shape against the real flow.
- Build and approve the parent flow and policy; then run live once and record the result here.
- The in-app diagram and the explainer page still describe Protect as simulated until that run happens.
