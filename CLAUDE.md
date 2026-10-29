# Agent Connect (Muse)

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
