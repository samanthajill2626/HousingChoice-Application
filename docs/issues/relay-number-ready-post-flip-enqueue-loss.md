---
id: relay-number-ready-post-flip-enqueue-loss
title: relay.numberReady loses the group intro, and a queued team message, when an enqueue fails after the group has flipped to open
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-09-25
refs: app/src/jobs/relayNumberReady.ts:97, app/src/jobs/relayNumberReady.ts:112, app/src/jobs/relayNumberReady.ts:149, app/src/jobs/relayNumberReady.ts:176, app/src/jobs/relayNumberReady.ts:183, app/src/services/relayQueuedMessages.ts:89, app/src/services/relayQueuedMessages.ts:93, app/src/services/poolNumbers.ts:484, app/src/services/poolNumbers.ts:663, app/src/services/relayProvisioning.ts:198
---

**Problem.** `relay.numberReady` opens a connect-when-ready relay group once its
dedicated number has registered. Its run-once "marker" is not a job marker but
the group's STATUS: the conditional flip `connecting -> open`
(`app/src/jobs/relayNumberReady.ts:149`), guarded by a read-check that only
proceeds while the group is still `connecting` (`:97-125`). Because the key is
the status, any later run - an SQS redelivery OR a fresh enqueue - sees `open`
and takes the re-flush branch (`:112-118`), which never enqueues the intro.

Two unguarded enqueues run AFTER that flip, and neither sends anything itself:

1. **The intro.** `enqueueImmediate(RELAY_INTRO_JOB)` at `:176`. If it throws,
   the job fails and SQS redelivers it (this handler has no job marker, so the
   redelivery does run) - but the group is already `open`, so the redelivery
   re-flushes queued messages and skips the intro for good. The members are
   never introduced to the group.
2. **Each queued team message.** `flushQueuedMessages`
   (`app/src/services/relayQueuedMessages.ts`) flips each held message from
   `queued_pending` to `queued` (`:89`) and THEN enqueues its fan-out (`:93`).
   If that enqueue throws, the message is already `queued`, so the re-flush on
   redelivery (which collects only `queued_pending`) skips it. That message is
   never sent and reads a neutral "Queued" forever. Messages after it in the
   loop were not flipped, so the redelivery does release those.

Nothing surfaces either loss. The stuck-connecting sweep
(`app/src/services/poolNumbers.ts:484-500`) lists only `connecting` groups, and
this group is `open`. The code's own comments say the opposite of what happens:
"A queued message must never be lost" (`relayNumberReady.ts:182`). The sibling
enqueues elsewhere are guarded (`relayProvisioning.ts:198-205` for the intro on
the normal provisioning path, `poolNumbers.ts:663-675` for this job's own
enqueue).

**Suggested fix.** Group: not a send - local error handling; no reconcile
involved (see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9). Options: guard both enqueues and log at ERROR the way the siblings do
(honest, but still loses the work); or make the work recoverable - for example
re-enqueue a message whose flip landed but whose enqueue failed, or record
"intro owed" durably so the re-flush branch can send it. Note the
interaction with
[relay-fanout-active-pass-cap-close-race](./relay-fanout-active-pass-cap-close-race.md),
which already names overlapping flushes as a duplicate fan-out producer: any
reordering must not add a second one.

**Related.**
[relay-intro-lost-under-job-marker](./relay-intro-lost-under-job-marker.md),
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md)
(the stranded message's legs never age to "not confirmed"). Sweep finding F1 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
