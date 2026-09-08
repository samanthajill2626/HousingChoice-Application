---
id: relay-retry-stranded-claim-window
title: A crash between the relay retry claim and its enqueue strands the ladder permanently
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-09-03
refs: app/src/routes/webhooks/twilio.ts:2742, app/src/routes/webhooks/twilio.ts:2795, app/src/routes/webhooks/twilio.ts:2803, app/src/repos/messagesRepo.ts:714, app/src/repos/messagesRepo.ts:2342
---

**Problem.** The 30003 retry claim commits the retry ROW and its
`sid#relayretry-<digest>-<n>` pointer in one transaction (`twilio.ts:2742`), and
only then hands the rung to the queue (`twilio.ts:2803`). Those are two separate
writes, and the process can die between them - a deploy, a SIGTERM, an OOM. The
claim is durable; the rung was never scheduled; no close code is written and no
line is logged.

That window does not heal. Twilio redelivers the status callback, the consistent
re-read succeeds, the slot still reads `undelivered`/30003 so D8's gate passes,
the root's `relay_retry_attempt` is still absent so the attempt arithmetic
computes rung 1 again, and the digest and provider SID come out identical. The
`append` then cancels on the SID pointer and returns `{deduped: true}`, so the
claim returns `already_claimed` at `twilio.ts:2795` - BEFORE the enqueue. No
rung 2 is reachable either: the only site that claims rung N+1 is a status
callback resolving through rung N's own `relaysid#` pointer, and rung 1 was
never sent, so no such callback will ever exist.

The resulting state is durable and quiet. The retry row sits at `queued`
forever, nothing is ever sent to that member, the surface reads `Retrying` for
15 minutes and then `Queued - not confirmed` permanently (`isRetryRungLive` /
`STALE_SENT_AFTER_MS`), and the only record is a WARN carrying
`retryClaim: 'already_claimed'` - correctly, since that outcome means a ladder
is running, which here it is not.

Note the asymmetry this leaves behind. The NEIGHBOURING window - a crash between
the slot write and the claim - was deliberately made recoverable, and the code
says so at length: D8 gates on the slot's post-write state rather than on this
callback's transition, precisely so a redelivered callback can still claim. The
window one `await` later was not.

**Why this is filed and not fixed.** The spec records it explicitly (Sec 9,
paragraph 1: "A crash between the claim and the enqueue strands a retry ...
Closing this needs the reconciliation sweep the issue puts out of scope.
Recorded, not fixed."), and the closed anchor
[`relay-30003-retry-lineage`](./relay-30003-retry-lineage.md) excludes any
reconciliation mechanism from its scope. Code review R1 adjudicated the finding
FILE rather than FIX for that reason: the fix is a new mechanism, not a defect
inside the delivered one.

**Suggested fix (from the adversarial review).** Make the rung durable in the
SAME transaction as the claim. `NewMessage.dueRow` already exists for exactly
this shape (`messagesRepo.ts:714`, written at `:2342`): native group text writes
a deadline row inside the append transaction because "a post-append enqueue
would leave a crash window in which a send exists with nothing watching its
receipts". Write the rung the same way and let a due sweeper dispatch it. That
sweeper is the reconciliation mechanism the anchor put out of scope, so this is
a piece of work in its own right rather than a patch.

**WARNING - do not fix it by re-enqueueing on `already_claimed`.** It looks like
a one-line fix and it is a duplicate-send bug. The claim's SID pointer defeats
duplicate CALLBACKS; what defeats a duplicate DELIVERY is the job's own
execution marker, which is keyed PER JOB (`relayRetryLeg.ts`, the
`putJobExecutionMarker` guard) - so a rung that is merely delayed in the queue,
not lost, would be enqueued a second time under a new job id, clear its own
marker, find the slot still non-terminal, and text the member twice.
`sendOneRelayLeg` skips only a TERMINAL slot, so nothing downstream catches it
either.
