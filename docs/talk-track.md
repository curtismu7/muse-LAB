# Talk track: Muse (about 6 minutes)

Audience: an SE showing how a personal agent stays inside what it may do. Everything here is simulated.

1. **Set the scene (30 s).** "Muse is a personal agent. It acts for Sam, a finance lead. Every tool call goes through a gateway."
2. **Sign in (30 s).** Click sign in. Point at the trace: PingOne starts the flow, a DaVinci step checks the risk, then the session is issued. Say that this is simulated.
3. **Allowed call (45 s).** Read the calendar. The call is allowed, and the decision log shows why.
4. **Coarse check (60 s).** Switch to staff (local build only) and try a payment. "The tool itself is closed to staff. The amount is never looked at."
5. **Fine check (60 s).** As Sam, send 120: allowed. Send 800: held. "Big payments wait for a person." Approve it, and point out that the approval is simulated CIBA.
6. **Muse-detect (90 s).** Press the burst button: seven calls in a row. The seventh is held. Then press the injected instruction button. "This one is blocked, not held. An instruction hidden in a draft never reaches a tool."
7. **Close (30 s).** "The decision order is detect, coarse, fine. The most restrictive answer wins. No OBO here: Privilege does not do on-behalf-of yet."

Reset clears the visitor's session and decision log between runs. Presenter mode keeps the simulation banner on.
