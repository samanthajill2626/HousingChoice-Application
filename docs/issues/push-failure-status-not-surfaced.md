---
id: push-failure-status-not-surfaced
title: A non-Gone push failure carries no HTTP status anywhere, so an oversize-payload rejection is indistinguishable from a vendor blip
type: bug
severity: low
status: open
area: app/push
created: 2026-08-17
refs: app/src/adapters/webPush.ts:28, app/src/adapters/webPush.ts:157, app/src/services/pushService.ts:207, app/src/lib/pushText.ts, docs/superpowers/specs/2026-08-16-inbound-message-push-design.md
---

PRE-EXISTING - not introduced by the inbound-message-push feature, and no code
was changed for this filing. Filed here because the feature makes it matter far
more.

**Problem.** No HTTP status survives a non-Gone push failure, so the one
failure mode `capPushText` exists to prevent cannot be observed.

`SendOutcome` (`app/src/adapters/webPush.ts:28`) has no failure variant:
`{ result: 'sent'; statusCode: number } | { result: 'gone' }`. Anything that is
not Gone is rethrown raw at `:157-161`, and every `WebPushError` the library
raises carries the same constant message, `'Received unexpected response
code'`. The status rides a separate `statusCode` property. `pushService`
consumes the error at `:207-211` and logs `(err as Error).message` only:

    push: send to one device failed (transient) - kept subscription

So a 413 (payload too large) is byte-identical in the logs to a 500 (vendor
blip) and to a 429 (rate limited). That matters because `app/src/lib/pushText.ts`
states the whole rationale for the D12 caps: a payload over ~4KB is REJECTED
with a non-Gone status, counted `failed`, the subscription is KEPT, and the
notification is silently lost - and would be lost again on every send. A cap
regression is therefore invisible in production, and so is a vendor rate limit,
which is the exact outcome
[inbound-push-fanout-unthrottled](./inbound-push-fanout-unthrottled.md) is
about.

Why it matters more now: the message path is the first push whose payload
length is user- and attacker-variable, and the highest-volume push producer in
the app. There is no PII cost to fixing it - `statusCode` is an integer.

**Suggested fix.** Carry the status through the adapter outcome into the warn's
fields: either add `{ result: 'failed'; statusCode?: number }` to `SendOutcome`,
or simply include `statusCode: (err as { statusCode?: number }).statusCode` in
the existing WARN. NOTE the reason this is filed rather than fixed on the
inbound-message-push branch: that log line is on the SHARED per-device loop, and
the current spec (section 3.1) freezes sendToUser's log lines for the voice
paths. Changing the line's fields is a voice-path change and needs its own
review, however benign.
