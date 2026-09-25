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
holds until `retry_due_at + RETRY_PROMISE_GRACE_MS` on the server's clock. Before
that branch, pressing Retry during the automatic retry's 60-240 second wait always
texted the member twice. The guard is time-based, and these gaps remain:

1. A press that reaches the route BEFORE the `retry_due_at` stamp is written -
   while the webhook's 30003 arm is still doing its reads and the enqueue. (A
   press after the write but before the screen hears about it gets the 409; the
   gap is server-side.)
2. No stamp while a retry is coming: the enqueue succeeded but the
   `annotateMessage` write failed, or the arm's conversation or contact read failed
   and it scheduled without a stamp by design (spec D3a). Either way there is no
   promise, no hidden button and no 409 for the whole wait.
3. A late job: the promise expired while the automatic job is still queued or
   running, and a press lands before it sends.
4. A stale browser tab retrying an original that an automatic retry has already
   replaced (the live screen hides replaced bubbles).
5. A one-to-one retry whose outcome is still pending past `retry_due_at` (for
   example an `unknown` send outcome awaiting reconcile checks), unless the path
   that leaves it pending refreshes `retry_due_at` as the retry-send-window spec's
   section 5 requires.
6. A one-to-one retry that `feat/send-outcome-reconcile` rules `unresolved`: its
   D16 leaves the original visibly undelivered with the Retry button live, although
   the retry's text may have gone out (its D20 hides Retry for the same verdict on
   relay and broadcast slots).

A robust fix needs a claim both sides contend on - a conditional write taken
before sending by the manual route and the automatic job alike, with consistent
reads. The retry-send-window spec deliberately did not build it (Cameron's option
1 was the time-based guard).

**Suggested fix.** `feat/send-outcome-reconcile` (revision 4) introduces a
per-recipient send-attempt record with a conditional claim before every provider
call, and keys `retrySend`'s record on the original message and the rung. That is
most of the needed substrate: have the manual retry route claim against the same
record, so whichever of the two sends second finds the claim taken and refuses.
Related: `send-idempotency-key`, `accepted-send-lost-when-append-fails`.
