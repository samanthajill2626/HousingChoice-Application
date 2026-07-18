---
id: fake-phones-no-twiml-replies
title: Fake-phones UI never renders webhook TwiML replies - keyword confirmations invisible in manual QA
type: improvement
severity: low
area: tooling
status: open
created: 2026-07-17
refs: fake-twilio/src/routes/control.ts:69
---

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
