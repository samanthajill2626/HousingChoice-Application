---
id: throw-for-redelivery-defeated-by-job-marker
title: Both fan-outs throw to force an SQS redelivery that the job-execution marker then suppresses
type: bug
severity: high
status: open
area: jobs
created: 2026-09-01
refs: app/src/jobs/broadcastFanOut.ts:456, app/src/jobs/relayFanOut.ts:531, app/src/jobs/jobs.ts:188, app/src/jobs/jobs.ts:262, app/src/repos/messagesRepo.ts:2630, app/src/jobs/retrySend.ts:122
---

**Problem.** `broadcastFanOut` and `relayFanOut` both handle an unrecognised
per-recipient send error by deliberately throwing, so that SQS redelivers the
envelope and the work is retried. Both say so in a comment:

```
// Unknown error: leave the recipient queued and let the job FAIL so SQS
// redelivers the whole envelope (a fresh jobId via the visibility
// timeout; the marker is per-jobId).
throw err;
```

**The parenthetical is false.** A redelivery carries the SAME `jobId`:

- `buildEnvelope` mints `jobId: randomUUID()` ONCE, at enqueue time
  (`jobs.ts:188`), and the envelope travels inside the SQS message body.
- `dispatchJob` uses a complete envelope VERBATIM (`jobs.ts:262`). The fresh
  `randomUUID()` a few lines below is only for the synthesized,
  envelope-less path. The function's own docblock says it re-hydrates "the new
  jobRunId + **the stable jobId**" (`jobs.ts:286`).
- `putJobExecutionMarker` is a conditional PUT with **no TTL**
  (`messagesRepo.ts:2630-2649`), so its suppression never expires.

So the redelivered envelope reaches the handler, `putJobExecutionMarker` returns
`false`, and the handler **returns immediately having done nothing**. The
deliberate throw does not retry the work. It burns one `maxReceiveCount` rung
per delivery until the envelope lands in the DLQ, and the broadcast row is left
`sending` with its recipients `queued` - permanently, because nothing repairs
it.

`retrySend.ts:122-128` documents the correct semantics for the same marker and
does not rely on redelivery. The two fan-outs are the outliers.

**Why it matters.** This is the same "stuck forever" class as
[retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md),
reached by a different door: there the counter could not advance, here the
retry cannot happen at all. A broadcast that hits one unrecognised send error
hangs on "Sending" in the dashboard exactly as the 2026-08-16 prod voicemail
hung on "Transcribing...".

Discovered during M5's design review (`feat/retry-counter-durable`), while
verifying whether a post-throw redelivery could advance a durable pass counter.
It cannot. M5's fix therefore closes the ENQUEUE-failure path by running the
cap-and-close branch immediately, and does not touch this path.

**Suggested fix.** Decide what an unrecognised per-recipient send error should
DO, then make the code do it:

- if it is retryable, the retry must be a NEW enqueue (fresh `jobId`), not a
  throw - a throw cannot retry under the marker;
- if it is not retryable, mark the recipient failed and let the job complete, so
  the row reaches a terminal state and the DLQ is reserved for genuine
  poison-envelope cases;
- either way, correct the two false comments.

Note the interaction with the marker's purpose: it exists so a redelivery cannot
TEXT SOMEONE TWICE. Any fix must keep that guarantee. The per-recipient
terminal-status skip already provides it independently, which is worth
confirming before relying on it.

**Also worth checking.** Any other handler that throws expecting a redelivery to
re-run its work has the same defect. This sweep has not been done.
