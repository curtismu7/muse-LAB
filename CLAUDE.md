# Muse

Mock-only personal-agent demo. Browser front end (Muse) signs in through a simulated PingOne flow, then calls tools
through a Privilege-shaped gateway. Tier: Demo.

## Run and test
- `npm install`
- `npm test` (server suite, node:test)
- `npm run build` (web bundle)
- `npm start` (http://127.0.0.1:5100/)

## Rules that bite
- Mock only. No tenant is contacted; the DaVinci flow, PingOne sign-in and Privilege are stubs.
- Loopback bind unless `MUSE_HOSTED=1`. Host check and same-origin writes on every API call.
- Persona picker only with `IDP=mock` and `ALLOW_MOCK_SIGNIN=1`, never hosted.
- Login is pi.flow only (simulated). No redirect login.
- No OBO. Privilege here is the coarse and fine check only.
