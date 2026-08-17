---
id: e2e-push-seam-missing
title: Push notifications have no e2e seam - every push path is unit-harness-tested only
type: improvement
severity: low
status: open
area: e2e
created: 2026-08-16
refs: app/src/services/pushService.ts, app/src/routes/dev.ts, e2e/README.md
---

**Problem.** There is no end-to-end seam for push notifications. Unlike SMS and
email - which the hermetic lane can observe through the dev outbox
(`GET /__dev/outbox`) and the fake Twilio/SES adapters - a push send has no dev
outbox, no fake push service, and no control API. The e2e suite therefore
cannot assert that any user-visible action results in a push, that the payload
carries the right `kind`/`conversationId`, or that a dead subscription gets
pruned.

Both push features are consequently covered by unit + route-harness tests only:
the voice pushes (pre_ring / missed_call / voicemail) and now the
inbound-message pushes (message / unmatched_email). Those tests inject a fake
`PushService` at the deps boundary, which pins the CALL but not the wiring
underneath it - exactly the class of gap that produced the worker
queue-wiring incident, where every construction site compiled and the runtime
adapter was simply absent. A missing or mis-constructed push adapter in a
deployed environment would look identical to today's green suites.

**Suggested fix.** Add a dev-only, hermetic-local-only seam mirroring the SMS
outbox: behind the same dev flag that gates `/__dev/outbox`, have the push
adapter record each send (userId, kind, tag, payload, endpoint id - never the
endpoint URL itself) into an in-memory ring the lane can read via
`GET /__dev/push-outbox`, plus a control call to plant a subscription and one
to make an endpoint return 410 so the prune path is exercisable. The heavier
alternative is a fake web-push receiver process in the hermetic lane that the
real adapter posts to, which additionally proves VAPID signing and the real
HTTP client. The outbox variant is cheaper and covers the wiring question,
which is the one that has actually bitten.
