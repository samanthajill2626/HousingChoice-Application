---
id: manual-retry-double-send-residual-windows
title: A staff Retry can still double-send a one-to-one text in the gaps the automatic-retry guard does not cover
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-24
updated: 2026-09-28
refs: app/src/routes/api.ts, app/src/services/oneToOneRetryDecision.ts, app/src/routes/webhooks/twilio.ts, app/src/routes/webhooks/twilio.ts:663, app/src/jobs/relayRetryLeg.ts:395, app/src/jobs/retrySend.ts, app/src/lib/retrySendWindow.ts, app/src/adapters/scheduler.ts, dashboard/src/routes/contact/retryPromise.ts, dashboard/src/routes/contact/Timeline.tsx, docs/superpowers/specs/2026-09-24-retry-send-window-design.md, docs/superpowers/reviews/2026-09-24-retry-send-window/build-review-adversarial.md
---

**Problem.** `feat/retry-send-window` (spec D7, D10) hides the manual Retry button
and makes the retry route refuse (409 `retry_pending`) while an automatic 30003
retry is scheduled: the failed message carries `retry_due_at`, and the guard
holds until `retry_due_at + RETRY_PROMISE_GRACE_MS` on the server's clock. Before
that branch, pressing Retry during the automatic retry's 60-240 second wait always
texted the member twice.

`retry_due_at` is written in the same conditional write as the failure itself
(spec D7, draft 6), and a message fails only once (`failed` and `undelivered`
follow only `queued` or `sent`, `app/src/repos/messagesRepo.ts:133-142`), so no
press can find the failure without its promise - including when the webhook's
reads failed, which now attempts the retry AND stamps it (spec D3a). The guard is
still time-based, and it is withdrawn at once when the retry's enqueue fails
(spec D7); these five gaps remain:

1. A late job: the promise expired while the automatic job is still queued or
   running, and a press lands before it sends.
2. A stale browser tab retrying, once the promise has expired, an original that
   an automatic retry has already replaced (the live screen hides replaced
   bubbles; before the promise expires the route refuses that press, 409
   `retry_pending`).
3. A one-to-one retry whose outcome is still pending past `retry_due_at` (for
   example an `unknown` send outcome awaiting reconcile checks), unless the path
   that leaves it pending refreshes `retry_due_at` as the retry-send-window spec's
   section 5 requires.
4. A one-to-one retry that `feat/send-outcome-reconcile` rules `unresolved`: its
   D16 leaves the original visibly undelivered with the Retry button live, although
   the retry's text may have gone out (its D20 hides Retry for the same verdict on
   relay and broadcast slots).
5. An enqueue that THROWS after SQS actually accepted the job. `SendMessage` on a
   standard queue is not idempotent, so a lost response (the SDK's own retries
   timing out too) reads as a failure while the job is queued. The 30003 arm then
   withdraws the promise (`retry_due_at` is rewritten to the epoch sentinel
   `RETRY_PROMISE_WITHDRAWN_AT`, spec D7), the Retry button appears at once, a
   staff press sends, and the queued job also sends - it does not read
   `retry_due_at`. Wider than gap 1: Retry appears immediately, not after the due
   time plus the grace. Before `feat/retry-send-window` the same press was always
   a double text, so this is a residual, not a regression. Found and reproduced by
   the build's adversarial review (F1 in
   `docs/superpowers/reviews/2026-09-24-retry-send-window/build-review-adversarial.md`).

   KEPT DELIBERATELY, under Cameron's spec-gate ruling 4
   (`docs/superpowers/reviews/2026-09-24-retry-send-window/rulings.md`): "The
   dropped guard is fine, I would rather err on the side of a double-text than a
   message not delivered at all." Spec D7 withdraws the PROMISE, not the retry.
   Making the job refuse on the withdrawal sentinel would be a reverse
   double-send guard: in this ambiguous case it would drop a real retry whenever
   nobody presses Retry. What would close it is the claim-based fix under
   "Suggested fix" below: with the manual route and the job contending on one
   claim, whichever sends second refuses.

   The relay retry rung has a twin of this gap that the send-attempt record
   cannot cover - see the 2026-09-27 section at the end.

Gaps 3 and 4 were assigned to reconcile's `retrySend` adoption after
`feat/retry-send-window`, which has now merged. See the dated adoption update
below for their later disposition.

A robust fix needs a claim both sides contend on - a conditional write taken
before sending by the manual route and the automatic job alike, with consistent
reads. The retry-send-window spec deliberately did not build it (Cameron's option
1 was the time-based guard).

**Suggested fix.** `feat/send-outcome-reconcile` (revision 6, @`b93ab376`) introduces a
per-recipient send-attempt record with a conditional claim before every provider
call, and keys `retrySend`'s record on the original message and the rung. That is
most of the needed substrate: have the manual retry route claim against the same
record, so whichever of the two sends second finds the claim taken and refuses.
Related: `send-idempotency-key`, `accepted-send-lost-when-append-fails`.

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

**Beside gap 5: the relay retry rung's twin, which the send-attempt record
cannot cover.** When the status webhook's enqueue of a just-claimed relay
retry rung throws (`app/src/routes/webhooks/twilio.ts:3039-3042`), it closes
the retry leg `failed`/`enqueue_failed` through `closeRetryLegEnqueueFailed`
(`:663-694`, called at `:3058`), the transport-aware persist path - a
whole-slot write on a legacy retry row. That is a close by a writer other than
the rung's own attempt, so the send-outcome spec's D8 would put it behind the
send-attempt record gate, as the rung job gates its own six such closes
(`gateFor`, `app/src/jobs/relayRetryLeg.ts:395-404`). But
`routes/webhooks/twilio.ts` is fenced on `feat/send-outcome-reconcile` (spec
Sec 2), so this one close is not gated; spec D8 records it here. Gap 5's
ambiguity applies to it: an enqueue that throws after SQS accepted the job
closes the slot while the rung may still run. A rung that starts after the
close finds a terminal slot and sends nothing
(`app/src/jobs/relayFanOut.ts:1845`); one already past its claim can have the
close land over its attempt, so the slot can read `enqueue_failed` for a leg
that went out. At most one text either way (the rung's claim on its record);
what can be wrong is the slot. Closing it means gating that close on the
rung's record once the webhook is in scope. Pre-existing, not introduced by
the branch.

**retry-send-adoption (2026-09-28).** `feat/retry-send-adoption` (code final
`1b5ddb01`, UNMERGED; anchors at `5a03e20b`) gives the retry job a
supersession check and the manual Retry route the automatic retry's attempt
record and a child pointer (spec R6, "The two halves together"). By the gaps
above; status and severity unchanged.

- **Gap 1 (a late job) - closed but for the in-flight overlap below.** A job
  whose promise lapsed declines when a manual Retry row of the same failed
  row already exists: step 4a, one consistent Query on the row's
  `retrychild#` pointers, before the window and the claim
  (`app/src/jobs/retrySend.ts:457-466`). In the other order the route meets
  the job: 409 `retry_pending` while its attempt record is open
  (`app/src/routes/api.ts:1683-1690`), 409 `superseded` once its retry row
  exists (`:1638-1642`).
- **Gap 2 (a stale tab on a replaced original) - closed for a row whose
  child has a pointer.** Any child supersedes the press (`api.ts:1638-1642`;
  "A newer attempt already exists for this message.",
  `dashboard/src/routes/contact/Timeline.tsx:139-140`). It stays open where
  the child has none - appended before the deploy (no backfill,
  `api.ts:1636-1637`) or by an old worker in a mixed fleet (code review round
  1 A-5): there a stale tab behaves as before.
- **Gap 3 (a pending outcome) - closed.** Every path that leaves the retry
  pending refreshes the promise - the deferral (`retrySend.ts:747`), the
  unknown hand-off over the whole check schedule (`:795-801`), the re-drive
  (`app/src/jobs/sendReconcile.ts:1636-1643`) - and the route refuses 409
  `retry_pending` on an OPEN attempt record younger than
  `RETRY_SEND_WINDOW_MS` from its `attemptedAt`, whatever the promise says
  (`api.ts:1683-1690`).
- **Gap 4 (an unresolved retry) - closed (Cameron's Q1 ruling).** The
  unresolved close WITHDRAWS the promise and writes
  `retry_outcome: 'unconfirmed'`: "retry not confirmed", Retry hidden
  (`sendReconcile.ts:1308-1333`; the job's own closes
  `retrySend.ts:773-794`, `:834-852`). The route answers 409
  `retry_unresolved` from the record or the row's belt
  (`api.ts:1670-1676`). The tail past the record's 30-day cleanup is in
  [send-attempt-sweeper](./send-attempt-sweeper.md)'s 2026-09-28 note.
- **Gap 5 (an enqueue that threw after SQS accepted) - closed but for the
  in-flight overlap.** The press the withdrawn promise lets through appends a
  manual row, and the queued job then declines at step 4a; a job that runs
  first is met as in gap 1. The relay rung's twin (the 2026-09-27 section) is
  untouched: the webhook stays fenced.

**What remains** (decided in
`docs/superpowers/reviews/2026-09-27-retry-send-adoption/code-review/r1-adjudications.md`
A-2 and `r2-adjudications.md` R2-6):

1. **The in-flight overlap** (spec R6, "What stays open, by construction"): a
   staff press whose provider call is in flight while a late automatic job
   passes step 4a and claims. The route reads the pointers and the record but
   writes nothing the job contends on (`api.ts:1638-1690`, against
   `retrySend.ts:461-462` and the claim at `:497`). Reproduced by round 1
   A-2's probe: two texts and two children - a fork whose chains then run
   independently, each with its own records and 30003 ladder. A deferred run
   can meet the same overlap: the route does not block on `done` /
   `retryable` and relies on the deferral's REFRESH, so a REFRESH that fails
   reopens it.
2. **Round 2 R2-6 widens it.** The route answers only `SendRefusedError`
   (`api.ts:1774-1780`): a press whose own send ends unknown or
   accepted-not-recorded is a 500 with NO manual row, so a late automatic
   job's step 4a never sees it, and the job claims and sends. The overlap then
   lasts until the automatic chain's window closes, not the manual send's
   duration.
3. **Manual vs manual** (spec R6): two presses that both pass the guards
   before either appends.

**Suggested fix for what remains** (round 1 A-2; not built on the branch - a
new design with a product trade-off): before its provider call the route
takes a conditional write on the SAME record key it already reads
(`retry#<conversationId>#<pressedTsMsgId>#<(retry_attempt ?? 0) + 1>`,
`api.ts:1652-1666`): absent -> create it `done` / `refused` with cause
`manual_retry_superseded`; `done` / `retryable` -> close it the same way;
open -> 409. Whichever side writes second loses (the job's gate then skips
the closed record). Trade-off, Cameron's call: a press whose own send is then
refused has also ended the automatic attempt. The same write would stop the
job in R2-6's no-row case too; the press's own unknown or unrecorded outcome
would still need the route's own adoption (send-outcome Stage 2).
