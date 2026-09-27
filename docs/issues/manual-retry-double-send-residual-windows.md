---
id: manual-retry-double-send-residual-windows
title: A staff Retry can still double-send a one-to-one text in the gaps the automatic-retry guard does not cover
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-24
updated: 2026-09-27
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

Gaps 3 and 4 belong to reconcile's `retrySend` adoption, planned after
`feat/retry-send-window` merges.

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
