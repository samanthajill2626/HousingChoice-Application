---
id: retry-counter-in-envelope-makes-caps-unreachable
title: Retry counters live in the enqueued envelope, so a failing enqueue freezes the count and makes the cap-and-close branch unreachable
type: bug
severity: high
status: open
area: jobs
refs: app/src/jobs/broadcastFanOut.ts:484, app/src/jobs/relayFanOut.ts:563, app/src/jobs/retrySend.ts:74, app/src/jobs/groupRail.ts:101
---

**Problem.** Every capped retry loop in `app/src/jobs` advances its attempt
counter by putting `attempt + 1` into the envelope it enqueues:

```ts
if (nextAttempt > MAX_ATTEMPTS) { ...mark failed / finalize...; return; }  // the close
await enqueue(JOB, { ...payload, attempt: nextAttempt }, { runAt: backoff });
```

If that `enqueue` throws, the counter never advances. The handler throws, SQS
redelivers the ORIGINAL envelope with the ORIGINAL `attempt`, the same
`nextAttempt` is recomputed, and the same enqueue throws again. The
cap-and-close branch above - the code written specifically to stop a stuck
state - is therefore unreachable for as long as enqueueing is broken. The
mechanism that advances the counter IS the mechanism that failed.

This is not hypothetical: it is exactly how a 1-second prod voicemail hung on
"Transcribing..." indefinitely on 2026-08-16. `voice.reconcileTranscript` could
not enqueue (the worker had no OutboundQueueAdapter - fixed in a755c6f8), so
`attempt` sat at 1 forever and the "exhausted -> stamp failed" backstop never
ran. The voice legs were patched in a755c6f8 to close the lifecycle when the
enqueue itself fails; the SAME SHAPE remains unpatched elsewhere.

Sites still carrying the shape, worst first:

- `broadcastFanOut.ts:484` - the continuation returns WITHOUT calling
  `finalize()` ("a continuation is still pending"). A throwing enqueue means
  finalize is never reached on any path, so the broadcast stays **"Sending"
  forever** in the dashboard and its recipients stay `queued`. Same
  user-visible signature as the voicemail. SQS does bound the looping (DLQ
  after maxReceiveCount) but nothing ever repairs the broadcast row.
- `relayFanOut.ts:563` - the cap branch at :557 is what marks the remaining
  transient recipients failed. Unreachable the same way, so those recipients
  are left unresolved.
- `retrySend.ts:74` - `enqueueSendRetry` is producer-side, called from the
  status webhook in the APP process, so its exposure is lower; the shape is
  still there.

`groupRail.ts:101` already does it correctly and is the in-repo precedent: it
wraps the enqueue in try/catch and returns a degraded `{ status: 'failed' }`
the caller can act on, instead of letting the throw escape.

**Suggested fix.** Preferred: keep the attempt count in the DURABLE record
(DynamoDB) rather than the message, incrementing it BEFORE the enqueue. The
counter then advances even when the queue is unavailable, so the cap is always
reachable and the close always runs. Cheaper stop-gap, matching what a755c6f8
did for voice: wrap each re-enqueue and, on failure, run the cap/close branch
immediately (finalize the broadcast, mark the recipients failed) rather than
letting the throw escape.

The general invariant worth adopting for any retry loop here: **if the enqueue
mechanism fails permanently, does this loop still reach a terminal state?** If
the answer is no, the counter is in the wrong place.

**Related.** Detection of a loop like this is the separate gap in
`error-log-alarm-blind-to-slow-failures.md` - the DLQ alarm only fires because
a job eventually stops, so a loop that never terminates pages nobody.

**Also worth auditing (not yet done).** The voice half of a755c6f8 fixed a
second, independent trap in the same incident: a provider status the code did
not enumerate (`error`) fell into a catch-all "not finished yet, keep waiting"
branch instead of being treated as terminal. Any other place that branches on a
raw provider status string with a `!== 'success'` fallthrough has the same
exposure. That sweep has NOT been done.
