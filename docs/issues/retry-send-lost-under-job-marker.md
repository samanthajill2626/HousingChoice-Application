---
id: retry-send-lost-under-job-marker
title: An automatic 30003 retry (retrySend) that errors after its job marker is claimed is silently lost; its adoption into the send-outcome core is that mission's Stage 1b, with stated requirements
type: bug
severity: med
status: open
area: app/messaging
created: 2026-09-25
updated: 2026-09-28
refs: app/src/jobs/retrySend.ts:203, app/src/jobs/retrySend.ts:212, app/src/jobs/retrySend.ts:274, app/src/jobs/retrySend.ts:317, app/src/jobs/retrySend.ts:339, app/src/routes/webhooks/twilio.ts:3581, app/src/routes/webhooks/twilio.ts:3624, app/src/services/sendMessage.ts:442, app/src/services/sendMessage.ts:608, app/src/services/sendMessage.ts:661, app/src/repos/sendAttemptsRepo.ts:329, app/src/jobs/sendReconcile.ts:369, docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
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

**Owner (Cameron's ruling, 2026-09-25): the send-outcome-reconcile mission,
as its Stage 1b** - its own worktree, cut after Stage 1 (`feat/send-outcome-
reconcile`) lands and after `feat/retry-send-window` has merged. Not
share-skip-fix's Branch B, which waits for this and consumes the finished
record.

**Suggested fix.** Group: send-shaped - adopt the send-outcome core (the D1-D3
classifier and typed `sendMessage` errors) and the send-attempt record (D8a)
on the record as Stage 1 built it. See the
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
(from the merged `feat/retry-send-window` branch),
[send-attempt-sweeper](./send-attempt-sweeper.md). Sweep finding F4 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

Stage 1 landed the core this Stage 1b adoption builds on, and nothing more:
the classifier (`app/src/lib/sendOutcome.ts:69`); `sendMessage`'s typed errors
(`app/src/services/sendMessage.ts:217-287`), thrown from the pre-provider
steps (`:442`, `:471`, `:541-554`, `:580-594`), the provider call (`:611`)
and the append (`:663-669`); the send-attempt record and its index
(`app/src/repos/sendAttemptsRepo.ts`, the shapes as built in
[send-attempt-sweeper](./send-attempt-sweeper.md)'s 2026-09-27 section);
`guardWrite` (`app/src/lib/guardWrite.ts`); and the `send.reconcile` job
(`app/src/jobs/sendReconcile.ts`), whose owner kinds are a broadcast
recipient, a relay leg and a relay retry rung only. `retrySend` itself is
unchanged on the branch (no diff against `main`): it still claims its marker
(`app/src/jobs/retrySend.ts:203-212`) and rethrows every error that is not a
refusal (`:339`), which now arrives as one of the typed errors - so a
one-to-one retry that errors under the marker is still lost exactly as
described above.

Anchors at HEAD, since the body's predate the `feat/retry-send-window` merge:
the re-presign is `retrySend.ts:274` and the send `:317`; RSW D6 moved the
lineage into the append itself (`:314-327`), so the post-append annotate the
body lists no longer exists; the webhook logs the exhausted chain at
`app/src/routes/webhooks/twilio.ts:3581` and schedules the retry at `:3624`;
the post-append steps D3 made best-effort are `sendMessage.ts:672-698`.

**retry-send-adoption (2026-09-28).** Built on `feat/retry-send-adoption`
(code final `1b5ddb01`, UNMERGED; anchors at `5a03e20b`) to the design
`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` (revision
5); records under `docs/superpowers/reviews/2026-09-27-retry-send-adoption/`.
`status` stays `open`: the human sets it resolved at merge.

- **The marker write is gone from the job.** `messaging.retrySend` registers
  without the run-once marker (`app/src/jobs/retrySend.ts:330-331`). Its
  duplicate guard is the claim on a send-attempt record keyed on the retried
  row and the attempt (the owner `:404-411`, the claim `:497-511`), re-armed
  as the last step before the provider call (`:545-553`).
- **Before the claim a throw is a real SQS redelivery, and nothing is
  sent:** the retried row, read consistently, and its declines
  (`:349-366`); the thread (`:395-403`); the shared gate (`:421-434` - a
  stale `attempting` record is taken over and handed off, a fresh one or a
  `reconciling` one defers, a terminal one skips); a manual child supersedes
  (step 4a, `:457-466`); the strict window (step 4b, `:468-481`).
- **After the claim nothing throws** (`:572-641`): sent (`:563-571`),
  refused (`:673-676`), rejected (`:614-635`), deferred once (`:707-759`);
  an unknown outcome goes to reconcile - `handToReconcile`, then the check-0
  enqueue and a promise REFRESH over the check schedule (`:806-823`,
  `:767-803`); a second unknown after a re-drive closes unresolved and
  WITHDRAWS the promise (`:834-852`); accepted-not-recorded goes to
  reconcile WITH its SID (`:602-610`).
- **The reconcile's fourth owner, `retry_send`**
  (`app/src/jobs/sendReconcile.ts`): the ref and its parser (`:147-154`,
  `:257-272`); resolve from the retried row and the thread (`:619-640`); the
  lineage exclusion from the sibling rule (`:1080-1095`, applied at
  `:1136-1149`); the owner's own row (`:768-778`); the adoption as the retry
  row with its lineage, `retry_root` and share stamp at append (`adoptRetry`,
  `:850-947`); one re-drive through the job's own producer (`:1513-1526`)
  only while the window fits (`:1551-1561`), with a REFRESH (`:1636-1643`);
  the unresolved close's WITHDRAW - "retry not confirmed", no Retry
  (`closeSlot`, `:1308-1333`) - and the retried row's emit (`afterClose`,
  `:1375-1388`). The joint gap is closed by Cameron's Q1 ruling: the manual
  Retry route answers 409 `retry_unresolved` from the record
  (`app/src/routes/api.ts:1670-1676`).

**Deploy note (build worklist item 24, kept beside the belt).** A retry job
that threw under the pre-adoption code within about 10 minutes before the
deploy (the 120 s visibility timeout x 5 receives) is redelivered to the new
code, which no longer claims the marker and finds no record: it would claim
and send - a possible second text after an unknown first attempt, a certain
one after an accepted-not-recorded one. Deploy when the worker log shows no
`retrySend` failure in the preceding ~10 minutes. The read-only pre-adoption
belt covers the same window in code (plan deviation 10,
`retrySend.ts:436-454`: with no record, a jobId whose marker exists is not
re-sent - INFO `retrySend: pre-adoption delivery already ran this job - not
re-sent`); its dated `TODO(retry-send-lost-under-job-marker)` (`:444-447`)
says to remove it after the first production deploy plus one SQS redelivery
window.

**Rollback note (worklist item 25; code review round 1 A-5).** Pre-branch
code cannot read a `retry_send` owner: its reconcile parser rejects the kind
("owner.kind is not a send-attempt owner") and its attempt repo has no
`retry_send` arm, so keying such an owner throws. A rollback while fresh
`retry_send` records exist dead-letters their queued `send.reconcile` checks
(five receives; pages `jobs-dlq-depth`), strands those records open, and can
break OTHER owners' reconciles to the same recipient for about 5 minutes
(their sibling read meets the retry's index items). Drain `send.reconcile`
before rolling back.
