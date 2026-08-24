---
id: fake-phones-no-twiml-replies
title: Fake-phones UI never renders webhook TwiML replies - keyword confirmations invisible in manual QA
type: improvement
severity: low
area: tooling
status: resolved
created: 2026-07-17
resolved: 2026-08-24
refs: fake-twilio/src/routes/control.ts:69
---

**Resolution (2026-08-24, `fix/test-suite-wave3`).** Took the suggested fix at
the one choke point every keyword path rides: `sendAsParty` now dispatches the
inbound webhook via `postForResponse` (the real WebhookDispatcher always had
it; the engine interface only asked for the status), parses the response's
TwiML `<Message>` verbs (`fake-twilio/src/engine/twimlSms.ts` - inline text,
nested Body/Media, entities; attributes accepted and ignored since the app
never overrides reply addressing), and delivers each reply through
`recordOutboundFromApp` - to the SENDER, from the number they texted, exactly
Twilio's default. That gives the reply the full outbound treatment: thread
append, live events, auto-persona, and for a pool-number send a
single-recipient leg in the group transcript, where the operator is looking
when a group member texts a keyword.

`postForResponse` is optional on the engine's Dispatcher interface so bare
status-only stubs keep compiling; without it, replies are simply unrendered
(pinned by a test).

8 new tests (parser shapes + the engine round-trip: STOP in, confirmation out,
correct addressing); 240/240 across the fake-twilio workspace.


**Problem.** When a fake phone texts a keyword (STOP/HELP/START) to any
app number, the app's confirmation reply rides the webhook's TwiML
response - which real Twilio would render as an SMS back to the phone.
The fake's inbound dispatch discards the webhook response body, so the
fake-phones UI shows the member's STOP with no reply, and a manual QA
walk of keyword flows is half-blind (the confirmation must be verified
at the HTTP/unit/e2e layer instead). Applies to every TwiML-reply path:
1:1 keywords, closed-group intercept, and the new open-path keywords
(relay-open-path-stop). Discovered during that feature's live self-QA.

**Suggested fix.** In the fake's inbound-SMS dispatch, parse the webhook
response body for TwiML `<Message>` elements and deliver each as an
inbound message to the originating phone (from the number it texted),
so fake phones see exactly what a real handset would.
