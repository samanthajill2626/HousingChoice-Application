---
id: manual-retry-double-send-residual-windows
title: A staff Retry can still double-send a one-to-one text in the gaps the automatic-retry guard does not cover
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-24
refs: app/src/routes/api.ts:1564, app/src/routes/webhooks/twilio.ts:3350, app/src/jobs/retrySend.ts:112, dashboard/src/routes/contact/Timeline.tsx:1341, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
---

**Problem.** `feat/retry-send-window` (spec D7, D10) hides the manual Retry button
and makes the retry route refuse (409 `retry_pending`) while an automatic 30003
retry is scheduled: the failed message carries `retry_due_at`, and the guard
holds until `retry_due_at + RETRY_PROMISE_GRACE_MS`. Before that branch, pressing
Retry during the automatic retry's 60-240 second wait always texted the member
twice. The guard is time-based, and these gaps remain:

1. The second or so between the delivery-status update reaching the screen and
   the `retry_due_at` stamp reaching it.
2. A lost stamp: the enqueue succeeded but the `annotateMessage` write failed, so
   there is no promise, no hidden button and no 409 for the whole wait, while the
   automatic retry is still coming.
3. A late job: the promise expired while the automatic job is still queued or
   running, and a press lands before it sends.
4. A stale browser tab retrying an original that an automatic retry has already
   replaced (the live screen hides replaced bubbles).
5. A one-to-one retry whose outcome is still pending past `retry_due_at` (for
   example an `unknown` send outcome awaiting reconcile checks), unless the path
   that leaves it pending refreshes `retry_due_at` as the retry-send-window spec's
   section 5 requires.

A robust fix needs a claim both sides contend on: a conditional write on the
original that the route and the job each take before sending, plus consistent
reads. The retry-send-window spec deliberately did not build it (Cameron's option
1 was the time-based guard).

**Suggested fix.** If double sends are observed, give the original message a
conditional "retry claimed" attribute that the manual route and `retrySend` each
set before sending (the loser refuses or skips), released only by an explicit
failure path. Related: `send-idempotency-key`, `accepted-send-lost-when-append-fails`.
