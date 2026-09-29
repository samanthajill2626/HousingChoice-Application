---
id: send-time-21610-skips-suppression-bookkeeping
title: A 21610 (unsubscribed recipient) returned at send time gets no suppression bookkeeping - only the status-callback path flags the contact opted out
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-25
refs: app/src/adapters/messaging.ts:676, app/src/adapters/messaging.ts:695, app/src/routes/webhooks/twilio.ts:3470, app/src/routes/webhooks/twilio.ts:3500, app/src/services/sendMessage.ts:307, app/src/jobs/broadcastFanOut.ts:381
---

**Problem.** Twilio error 21610 means the recipient has opted out (sent STOP)
and Twilio will not deliver to them. When it arrives in a STATUS CALLBACK, the
one-to-one webhook arm records it: it sets `sms_opt_out` on the contact whose
primary number it is and writes an `sms_opt_out_recorded` audit row with source
`twilio_21610` (`app/src/routes/webhooks/twilio.ts:3470-3515`). From then on our
own gates refuse sends to that contact (`app/src/services/sendMessage.ts:307-318`,
the broadcast first fence at `app/src/jobs/broadcastFanOut.ts:381`), and staff
see the contact as opted out.

Twilio can also refuse the CREATE itself with 21610 (the send-outcome design's
D1 lists it among send-time 4xx rejections). That error goes nowhere near the
webhook: the adapter rethrows it unchanged (`app/src/adapters/messaging.ts:676-708`),
there is no message SID and so no status callback, and no send path records the
opt-out. Before the send-outcome core, the fan-outs did not recognise the code
(it took the unknown-error throw of
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md)).
Since `feat/send-outcome-reconcile` merged at `79b9479e`, it is classified `rejected` and the
recipient is marked `failed` with 21610 - honest for that one send, but the
contact is still not flagged.

Consequence: our state disagrees with Twilio's. The contact keeps appearing as
textable, broadcasts keep including them, every automated and staff send to
them is attempted and rejected, and the "opted out" state staff rely on never
appears. Low severity because Twilio itself blocks delivery, so no text reaches
a person who opted out; the harm is wrong state and repeated failed sends.

A likely way to get here is a STOP our own inbound handling never recorded -
for example one sent to a different number in the Messaging Service.

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9); send-shaped - extend the send-outcome core, now merged at `79b9479e`:
a `rejected` outcome carrying 21610 runs
the same number-scoped bookkeeping the webhook arm runs (flag the contact only
when the refused number is its primary; audit with a distinct source such as
`twilio_21610_send`), shared rather than copied. Relay legs need the
per-member, number-scoped variant, as the native group receipts path already
has (`app/src/services/groupReceipts.ts`, spec 15.8).

**Related.**
[status-callback-passive-match-for-pending-reconcile](./status-callback-passive-match-for-pending-reconcile.md)
(the other way webhook-only side effects are skipped).
