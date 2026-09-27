---
id: one-to-one-retry-promise-outlives-job-decline
title: When the one-to-one 30003 retry job gives up, the bubble keeps its retry promise and hides Retry until the promise expires
type: improvement
severity: low
status: wontfix
area: app/messaging
created: 2026-09-26
resolved: 2026-09-26
refs: app/src/jobs/retrySend.ts, app/src/routes/webhooks/twilio.ts, app/src/lib/retrySendWindow.ts, dashboard/src/routes/contact/Timeline.tsx, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
---

**ACCEPTED as-is (Cameron, 2026-09-26): "accepted."** Asked whether the stale
promise after a during-backoff refusal - group (b) below, 170 s measured - should
be withdrawn at once, he accepted the behavior. Group (a) was already accepted by
the spec. Nothing below is scheduled; this record stays so the trade-off is
findable if it is ever revisited.

**Problem.** Since `feat/retry-send-window` (spec D7, D8, D10), a one-to-one
30003 failure that will be retried carries `retry_due_at` - the retry's run
time, written in the same conditional write as the failure. While
`retry_due_at + RETRY_PROMISE_GRACE_MS` is ahead on the server's clock the
bubble reads "Phone unreachable - will retry (error 30003)", its Retry button is
not rendered, and the manual retry route answers 409 `retry_pending`.

When the retry JOB (`messaging.retrySend`, `app/src/jobs/retrySend.ts`) then
gives up at send time, nothing withdraws that promise:

- `sendMessage` refuses with a `SendRefusedError` - the member texted STOP
  during the backoff, texting was turned off (the kill switch), the breaker
  refuses an automated original, or manual mode refuses an automated original;
- the job's window check closes because the job ran late (`window_closed`,
  spec D4);
- the original is gone, or is not outbound.

Each exit logs and returns. None rewrites `retry_due_at` or emits
`message.persisted`, so "will retry", the hidden Retry button and the 409
`retry_pending` all last until `retry_due_at + RETRY_PROMISE_GRACE_MS` (2
minutes), plus up to one 60-second tick of the Timeline's ticker - about 3
minutes at most after the job gave up. For that time the screen promises a
retry the system has already abandoned, and staff cannot retry by hand.

The build's adversarial review reproduced it (F2 in
`docs/superpowers/reviews/2026-09-24-retry-send-window/build-review-adversarial.md`):
a throwaway probe drove the real webhook and the real job over the harness
fakes, and both cases failed after their no-send pre-assertion passed:

```
x ... withdraws the promise when the job does not send (opted_out)
x ... withdraws the promise when the job does not send (window_closed)
- "liveAfterGivingUp": false,  "refreshed": true
+ "liveAfterGivingUp": true,   "refreshed": false
```

**What the spec accepts, and what it does not.** The spec's section 9 residual
"A promise with nothing behind it" accepts only PART of this class (re-review
F1 in `docs/superpowers/reviews/2026-09-24-retry-send-window/build-rereview.md`,
adjudicated in `build-rereview-adjudications.md` in the same folder). The exits
fall into two groups:

- **(a) Accepted by section 9, on purpose.** An automated retry the breaker
  refuses at send time (live state the webhook's decision cannot preview,
  D3a); a retry the decision let through on a failed conversation or contact
  read, which the job then refuses; a retry the job declines at send time
  because it ran late (the D4 window); and a retry whose own send fails at the
  provider. Section 9 says these "each keep 'will retry', and hide the Retry
  button, until the promise expires". (It also accepts two webhook-side cases
  that are not job exits: an enqueue failure whose correction write failed
  too, and a crash or throw between the stamped status write and the enqueue.)
- **(b) Newly found by the build review - not covered by the spec, and not yet
  ruled.** A refusal whose cause arose DURING the 60-240 s backoff, after the
  decision's reads succeeded: the member texts STOP, texting is turned off (the
  kill switch), manual mode is set on the thread of an automated original, the
  contact is soft-deleted, or a person's original loses its consent. The
  decision previews each of these at the moment of the failure (D3a, which
  calls the breaker "the one refusal the arm cannot preview" - true only at
  that moment), and section 9 lists none of them. The adversarial review found
  these exits (its F2). Also in this group: the job's two exits on the original
  itself - it is missing, or it is not outbound. Group (b) is Cameron's call.
  His spec-gate answer 3 bears on it - the spec records it as "'will retry'
  appears only when a retry will actually be attempted" (spec section 0; his
  own words are answer 3 in `rulings.md`, same folder) - and at the job's
  refusal the system knows no retry will be attempted, yet the promise stays
  up for up to about 3 minutes.

For both groups the build's recommendation is to keep this FILED, not to change
code on `feat/retry-send-window`: the fix is new worker writes and emits after
the job's execution marker, beyond the approved spec, to end a stale promise at
most about 3 minutes sooner, on rare exits only. That is the outcome of
adjudication A2 in `build-review-adjudications.md` (same folder); its recorded
reason - that section 9 accepts exactly this class - is corrected by row 4.2 of
`build-rereview-adjudications.md`.

The relay side already does the opposite: the relay retry job announces every
terminal close at once (`announceRootClose` in
`app/src/jobs/relayRetryLeg.ts`, which emits for the root after each close it
writes), and the one-to-one webhook itself withdraws a promise with no retry
behind it the moment the retry's enqueue fails (spec D7).

**Suggested fix.** On every no-send exit after the job's execution marker,
withdraw the promise best-effort: annotate the original with
`retry_due_at = RETRY_PROMISE_WITHDRAWN_AT` (the primitive the webhook's D7
withdrawal already uses, `annotateMessage`'s `retryDueAt`) and emit
`message.persisted` for it, which the worker's event bridge forwards to the
app's SSE clients. A failed withdrawal only logs and is never rethrown, so it
cannot turn a by-design decline into a job failure. Withdrawing a promise
changes only what the screen says, never whether anything is sent, so it leaves
the reverse-guard question that Cameron's ruling 4 settled untouched (see
[manual-retry-double-send-residual-windows](./manual-retry-double-send-residual-windows.md),
gap 5).
