---
id: retry-send-lost-under-job-marker
title: An automatic 30003 retry (retrySend) that errors after its job marker is claimed is silently lost; its adoption into the send-outcome core is deferred work with stated requirements
type: bug
severity: med
status: open
area: app/messaging
created: 2026-09-25
refs: app/src/jobs/retrySend.ts:122, app/src/jobs/retrySend.ts:131, app/src/jobs/retrySend.ts:164, app/src/jobs/retrySend.ts:200, app/src/jobs/retrySend.ts:218, app/src/jobs/retrySend.ts:226, app/src/routes/webhooks/twilio.ts:3358, app/src/routes/webhooks/twilio.ts:3364, app/src/services/sendMessage.ts:278, app/src/services/sendMessage.ts:394, app/src/services/sendMessage.ts:398, docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
---

**Problem.** `messaging.retrySend` is the one automatic retry for a one-to-one
text that failed with 30003 (handset unreachable). The status webhook schedules
it (`app/src/routes/webhooks/twilio.ts:3364`) with a backoff of 60, 120 or 240
seconds.

The handler claims the per-job execution marker BEFORE it does any work
(`app/src/jobs/retrySend.ts:131`), which is right: a redelivered job must not
text the member twice. But every error from the send that is not a refusal is
then rethrown (`retrySend.ts:218`) so that "the job fails". That throw asks SQS
for a redelivery, and the redelivery carries the same `jobId`, finds the marker
taken, logs `duplicate delivery suppressed` and returns successfully, so the
consumer deletes the message. This is exactly the shape
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md)
describes for the two fan-outs; that issue's claim that `retrySend` "does not
rely on redelivery" was wrong (corrected there on 2026-09-25). The docblock at
`retrySend.ts:122-128` describes the duplicate suppression correctly; nothing in
the handler actually retries.

What reaches the rethrow, in order:

- Before anything is sent: the attachment presign (`retrySend.ts:164-166`);
  `sendMessage`'s own reads before the provider call (the conversation read at
  `sendMessage.ts:278`, the contact read at `:307`, the breaker increment at
  `:350`); and a Twilio create that answers 4xx or 429, which is a definite
  non-send. The retry is lost with nothing sent.
- An ambiguous create (a timeout or dropped socket at `sendMessage.ts:394`):
  the text may or may not have gone out, and nothing ever finds out.
- After Twilio accepted: the row append (`sendMessage.ts:398`, the
  [accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md)
  shape) - suppressing a re-send is correct there, but the SID is dropped.
- After the row is written: the lineage annotate (`retrySend.ts:226`). If it
  throws, the retry went out but carries no `retry_attempt`, so the next 30003
  on it restarts the chain at attempt 1.

What the member and staff see: the original bubble keeps its 30003 failure
(today with the "Phone unreachable - will retry" copy), no retry row appears,
and the "transient delivery failure exhausted retries" ERROR
(`twilio.ts:3358`) never fires because the chain never advanced. The only
trace is one `job failed` line. Staff cannot tell the retry never ran.

**Why this is its own item.** `feat/send-outcome-reconcile` (SOR) fixes this
shape for both fan-outs and the relay retry rung, but its Sec 2a moved the
`retrySend` adoption AFTER `feat/retry-send-window` (RSW) merges, because RSW
rewrites this same job (the retry window, lineage at append, `retry_due_at`).
Until the adoption lands, a one-to-one retry that errors under the marker is
lost exactly as described above. Note that SOR Stage 1 does change one piece
for every `sendMessage` caller including this one: its D3 stops failures AFTER
the row is written (the inbox touch and audit at `sendMessage.ts:432-433`) from
failing the send.

**Suggested fix.** Group: send-shaped - adopt the send-outcome core (the D1-D3
classifier and typed `sendMessage` errors) and the send-attempt record (D8a)
once `feat/send-outcome-reconcile` lands, AFTER `feat/retry-send-window` has
merged. See the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 2a item 4, the D16 note and Sec 9. What SOR states for this adoption:

- the attempt record keys on the ORIGINAL message and the retry rung (not on a
  recipient of an owner), and the rung's single deferral is recorded on it;
- an `unknown` outcome goes to the reconcile job; adoption of a found message
  writes the retry row with RSW's lineage (below);
- `retry_due_at` is kept truthful while an outcome is pending.

Requirements RSW places on this path (retry-send-window design, Sec 5,
requirements on `feat/send-outcome-reconcile`), in substance:

- **RSW #2 - lineage at append.** Any path that appends a one-to-one retry row
  (including a reconcile "adopt") writes `retry_of`, `retry_attempt` and
  `retry_window_start` with the append (RSW D2, D6), never as a later annotate.
- **RSW #3 - the promise stays up while the outcome is pending.** Any path that
  DEFERS a one-to-one retry, or leaves its outcome pending past `retry_due_at` (a
  deferral, or an `unknown` outcome awaiting reconcile checks at about 5
  seconds, 30 seconds and 4 minutes), applies RSW D3a's window check to any
  re-schedule, and keeps the retry promise and the manual Retry guard (RSW D10)
  up until the retry resolves - by refreshing `retry_due_at` to cover the
  pending schedule and emitting `message.persisted` after each refresh (RSW
  D7). Otherwise the Retry button comes back while an automatic text may
  already be out.
- **RSW #4 - the copy follows `retry_due_at`.** After RSW D8 the "will retry"
  copy is derived from a live `retry_due_at`, not from the retry count, so an
  unresolved one-to-one retry no longer leaves that copy standing by count;
  requirement 3 is what keeps it truthful.
- **RSW #1 (applies here too).** A rung this adoption re-enqueues runs the same
  job handler, so RSW D4's job-time window check bounds it; RSW #6 adds that the
  window checks run BEFORE the claim, so a window decline never holds a claim.
- **The joint gap.** When the reconcile rules a one-to-one retry `unresolved`,
  SOR D16 leaves the original visibly undelivered with the Retry button live,
  while SOR D20 hides Retry for the same verdict on relay and broadcast slots
  because the text may have gone out. RSW's time-based guard has expired by then
  (`retry_due_at` plus its grace), so a staff press can double-send. RSW
  records it as item 6 of `manual-retry-double-send-residual-windows` (filed on
  `feat/retry-send-window`); this adoption owns the decision, and that issue's
  suggested fix (the manual Retry route claims the same attempt record) is the
  natural one.

Also closes with this adoption, or is decided alongside it:
[broadcast-30003-retry-never-updates-slot](./broadcast-30003-retry-never-updates-slot.md)
(`retrySend` drops the broadcast id; share-skip-fix's Branch B names it as an
issue to close).

**Related.**
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md)
(anchor),
[accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md)
(piece 2 for this caller is this adoption),
[exactly-once-send-intent](./exactly-once-send-intent.md),
[manual-retry-double-send-residual-windows](./manual-retry-double-send-residual-windows.md)
(on `feat/retry-send-window` until it merges),
[send-attempt-sweeper](./send-attempt-sweeper.md). Sweep finding F4 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
