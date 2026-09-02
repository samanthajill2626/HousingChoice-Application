---
id: retry-counter-in-envelope-makes-caps-unreachable
title: Retry counters live in the enqueued envelope, so a failing enqueue freezes the count and makes the cap-and-close branch unreachable
type: bug
severity: high
status: resolved
area: jobs
resolved: 2026-09-01
refs: app/src/jobs/broadcastFanOut.ts:318, app/src/jobs/relayFanOut.ts:876, app/src/repos/fanoutClaim.ts, app/src/jobs/retrySend.ts:74, app/src/jobs/groupRail.ts:101
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

Sites still carrying the shape, worst first. **The line numbers in this section
are as-filed and are now stale** - both fan-outs were rewritten by the fix; the
Resolution below carries the current anchors.

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

**Also worth auditing - DONE 2026-09-01.** The voice half of a755c6f8 fixed a
second, independent trap in the same incident: a provider status the code did
not enumerate (`error`) fell into a catch-all "not finished yet, keep waiting"
branch instead of being treated as terminal. Any other place that branches on a
raw provider status string with a `!== 'success'` fallthrough has the same
exposure.

That sweep ran on `feat/retry-counter-durable`. Read
`docs/superpowers/reviews/2026-08-31-retry-counter-durable/provider-status-sweep.md`
for the methodology and the per-site disposition of all 52 sites; the residue is
filed as [`provider-status-unenumerated-defaults`](./provider-status-unenumerated-defaults.md)
(med). **Do not re-run the `!== 'success'` grep suggested above and conclude the
sweep found nothing**: that literal grep has ZERO hits in `app/src` and never
could have found the shape - the real shape is a branch on a raw provider status
whose UNENUMERATED default is non-terminal, which is what the sweep enumerated
instead.

**Resolution (2026-09-01).** Fixed on `feat/retry-counter-durable` (design
`docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`, D1-D11),
taking the PREFERRED remedy above rather than the stop-gap.

The count now lives in the durable record and is claimed BEFORE the work it
authorises. `fanout_attempt` is a TOP-LEVEL scalar on `MessageItem`
(`repos/messagesRepo.ts:878`) and `BroadcastItem` (`repos/broadcastsRepo.ts:172`)
- deliberately not a field inside a recipient slot, because both per-recipient
slots are rewritten wholesale on every status write and a counter inside one
would read 1 forever, reproducing this bug in a shape that looks fixed.
`claimFanoutPass` (`repos/messagesRepo.ts:2789`, `repos/broadcastsRepo.ts:650`)
is a conditional atomic `ADD`, so concurrent deliveries cannot take the same
pass number; its three outcomes are the shared type in `repos/fanoutClaim.ts`.
No migration and no backfill: an item written before the branch has no attribute
and claims at 1.

Both envelope-counted sites now claim durably:

- `jobs/broadcastFanOut.ts:318` (commit `c7d3b5f0`)
- `jobs/relayFanOut.ts:876` (commit `58764d87`)

Each claim sits after the duplicate-delivery marker and after the job has
determined it will attempt sends, so a redelivered envelope and a pass with
nothing to send both consume no rung.

All three ways out now reach a terminal state with no recipient left `queued`:

- cap already spent when the pass begins - `broadcastFanOut.ts:329`,
  `relayFanOut.ts:891`;
- cap reached with legs still deferred - `broadcastFanOut.ts:580`,
  `relayFanOut.ts:1053`;
- the continuation enqueue throwing - `broadcastFanOut.ts:601`,
  `relayFanOut.ts:1080`. This one closes IMMEDIATELY rather than rethrowing:
  a redelivered envelope is suppressed by the job-execution marker, so nothing
  would come back to close it later.

The close reasons are distinct app-invented codes - `transient_cap` (retries
exhausted) and `enqueue_failed` (never scheduled) - so an operator is never told
retries ran when none did. Both render as operator prose rather than a raw
token (`dashboard/src/routes/contact/deliveryStatus.ts`, INTERNAL_CODE_REASONS)
in all four positions they can reach, including the broadcast results badge.
Send counts and backoff delays are unchanged from `main` on both ladders.

**The third site named above, `retrySend.ts:74`, needed NO change and was not
touched.** Its enqueue failure was already handled at
`routes/webhooks/twilio.ts:2727-2731`, which catches, logs ERROR and leaves the
message terminal - traced from the call site, not credited by name. Do not read
this Resolution as having fixed it. `groupRail.ts:101` is likewise untouched; it
was already the correct precedent this fix generalises.

**Still open, deliberately.** The unknown-send-error `throw` in both loops -
`broadcastFanOut.ts:545`, `relayFanOut.ts:1002` - is a fourth exit and is NOT
closed here. It is
[`throw-for-redelivery-defeated-by-job-marker`](./throw-for-redelivery-defeated-by-job-marker.md)
(high): fixing it means deciding what such an error should DO while preserving
the never-text-twice guarantee the job marker provides.
