---
id: one-to-one-retry-promise-outlives-job-decline
title: When the one-to-one 30003 retry job gives up, the bubble keeps its retry promise and hides Retry until the promise expires
type: improvement
severity: low
status: open
area: app/messaging
created: 2026-09-26
refs: app/src/jobs/retrySend.ts, app/src/routes/webhooks/twilio.ts, app/src/lib/retrySendWindow.ts, dashboard/src/routes/contact/Timeline.tsx, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
---

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

**Accepted for `feat/retry-send-window`, on purpose.** The spec's section 9
residual "A promise with nothing behind it" accepts exactly this class - an
automated retry the breaker refuses at send time, one the job declines at send
time (D4), and the rest of that list "each keep 'will retry', and hide the
Retry button, until the promise expires". Changing it there would have been a
spec deviation (new writes and emits from the worker after the job's execution
marker) for a bounded benefit (about 3 minutes at most, on rare exits only), so
the build review filed it instead of fixing it (adjudication A2 in
`docs/superpowers/reviews/2026-09-24-retry-send-window/build-review-adjudications.md`).

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
