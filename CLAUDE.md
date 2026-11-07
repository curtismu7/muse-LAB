# Personal Agent (Muse)

Personal-agent demo, tier Demo. A browser front end (Muse, the agent) signs in through PingOne, then calls tools through a Privilege-shaped gateway. By default (`MODE=mock`) everything is simulated and offline; `MODE=live` (with `ALLOW_LIVE=1`) is the owner's real build with their own PingOne and gateway. `/clients.html` shows Claude, ChatGPT, Codex and Muse as look-alike clients on the same back end.

## Run and test
- `npm install`
- `npm test` (server suite, node:test; `node --test server/test/*.test.js` also works)
- `npm run build` (web bundle)
- `npm start` (http://127.0.0.1:5100/); `node scripts/doctor.mjs` checks a running app.

## Rules that bite
- Mock mode contacts nothing: the netguard (`server/src/netguard.js`) refuses every non-loopback outbound call and counts them (`GET /api/netguard`; the doctor and a test assert zero attempts). In live mode it only counts origins.
- Branding is data: `server/src/customer.config.json` (brandName, agentName, tagline, default vertical); `MUSE_CUSTOMER_CONFIG` points at another file. Bad values fall back to the defaults.
- Stories are data: `server/src/stories.json`, three vertical packs (airline, bank, hotel) with `{{cast.x}}` tokens and the runtime tokens `{{points}}` and `{{tier}}`. An undefined token fails the load and the tests. Live sign-in runs the airline back end only.
- Each browser gets its own workspace; `workspaceId` (a hash, never the cookie) labels it. Nothing is written to disk.
- Loopback bind unless `MUSE_HOSTED=1`. Host check and same-origin writes on every API call.
- Persona picker only with `IDP=mock` and `ALLOW_MOCK_SIGNIN=1`, never hosted.
- No SE host names, tenant or client ids in shipped files (a test pins it). Real settings live in `.env` (see `.env.example`) or the owner's Secret, never in the repo.
- Live sign-in is pi.flow, not a redirect: the page opens the Sign in dialog (`web/src/SignInModal.jsx`), which runs PingOne's DaVinci flow with Ping's DaVinci client SDK (`@forgerock/davinci-client`, plus `@forgerock/protect` for the Protect screen). `POST /api/live/signin` with `piflow: true` returns the SDK's config (state, challenge, hint; never the verifier) and `POST /api/live/signin/complete` swaps the code on the server. The PingOne app must list the page's origin in its CORS settings (without it the browser blocks the flow). The connector's `/connector/authorize` (real assistants and the simulated ones from `/api/sim/start` and `clients.html`) sends the browser to Personal Agent's own `/connector/signin` page, which runs the same dialog (`/connector/signin/config`, `/connector/signin/complete`); the only redirect left is back to the assistant's own redirect address. Each PingOne app a sign-in uses (the base app and the per-assistant apps) needs the page's origin in its CORS settings and `<public url>/connector/callback` in its redirect URIs. The one lane still redirecting is gateway discovery with no PingOne app configured (a generic authorization server).
