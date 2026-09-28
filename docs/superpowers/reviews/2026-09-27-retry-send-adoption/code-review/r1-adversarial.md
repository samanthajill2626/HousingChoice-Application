# retry-send-adoption - code review round 1 - adversarial (plan-blind)

Branch `feat/retry-send-adoption` @ 6c82058c, merge base 3dbb5740. Inputs: the
r1 diff package and the repository only (no spec, plan or prior review read).
Probes were throwaway vitest files over the harness fakes (`createFakeWorld`,
the real `send.reconcile`, the real send wrapper, the real manual Retry route
via `buildApp`); every one FAILED on HEAD as described below and was deleted.
Their byte-exact source is kept in the gitignored
`.superpowers/review/r1-adversarial-reference.md`.

## Verdict

No BLOCKING and no HIGH finding. The core machinery holds up under the
interleavings walked here: the claim replaces the run-once marker safely at
every SQS redelivery point, two deliveries converge on one send, the re-drive,
the re-driven job and a redelivered original contend on one claim, the promise
writes are conditional and converge in both orders, and the new pointer family
does not disturb the append's positional dedupe attribution or any scanner.

One MED: the branch's own promise REFRESHES outlive the no-send ends it also
introduced (a window-refused re-drive, a failed re-drive enqueue, a re-driven
run that is refused), so staff see "will retry" and a 409 `retry_pending` for
minutes after the system knows nothing will retry - contrary to the code's own
comment. Two LOWs (a confirmed residual of a FILED double-text window; an
unconditional log downgrade plus a per-receipt sleep in the broadcast rollup),
one LOW crash-strand consequence in a filed class, and three NOTEs.

## Findings

### A-1 - MED - CONFIRMED - the refreshed retry promise outlives every no-send close after a hand-off or re-drive

Surface: `app/src/jobs/sendReconcile.ts:1308-1321` (closeSlot, retry_send arm:
only `SEND_UNCONFIRMED_CODE` writes; comment: "redrive_refused and
enqueue_failed write NOTHING: nothing went out, the promise expires on RSW's
clock and Retry stays available"); the refreshes that set that clock:
`app/src/jobs/retrySend.ts:784-790` (hand-off: attemptedAt + last check +
RETRY_PROMISE_GRACE_MS) and `app/src/jobs/sendReconcile.ts:1620-1631` (re-drive:
now + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS); the no-send ends:
`sendReconcile.ts:1565-1585` (closeRedriveRefused), `sendReconcile.ts:1437-1454`
(re-drive enqueue failed), and the re-driven run's refuse / rejected / decline
arms in `retrySend.ts:669-689`; the readers: `app/src/routes/api.ts:1626` (409
`retry_pending`) and `dashboard/src/routes/contact/Timeline.tsx:798-801`.

Failure: the refreshed `retry_due_at` already carries one promise grace, and
`isRetryPromiseLive` adds another. Production timing, attempt start A:
- the unknown hand-off refreshes to A+360 s, so the promise is live until
  A+480 s; the reconcile's last check (A+240 s) that ends never_sent with the
  window closed (the normal fate of an unknown attempt 3, or a late attempt 2)
  closes `redrive_refused`, and a failed re-drive enqueue closes
  `enqueue_failed` - both write nothing, so for about 4 more minutes (plus up
  to one 60 s ticker tick) the bubble reads "Phone unreachable - will retry",
  Retry is not rendered, and a press gets 409 `retry_pending` ("A retry is
  already scheduled for this message.");
- a re-drive refreshes to now+180 s (live to now+300 s); a re-driven run that
  is then refused (the member texted STOP during the reconcile, the kill
  switch, manual mode, the breaker, consent), rejected, or declined leaves
  "will retry" and the 409 for about 5 minutes.

Evidence (probes, all red on HEAD):
- `A1 ... redrive_refused (window)`: record `done/redrive_refused` cause
  `retry_window_closed`, `world.sent` = 0; then `isRetryPromiseLive(row.retry_due_at)`
  = true and the route answered 409 `retry_pending` (expected: not live, 201).
- `A2 ... re-drive whose enqueue fails`: record `done/enqueue_failed`, nothing
  sent; `{ promiseLive: true, status: 409 }` vs expected `{ false, 201 }`.
- `A3 ... re-driven run REFUSED (opted out)`: record `done/refused` cause
  `contact_opted_out`, `redriveCount` 1, nothing sent; the route answered 409
  `retry_pending` (it never reached the send's own `contact_opted_out`).

Registry: the RSW-era `one-to-one-retry-promise-outlives-job-decline` is the
same class for JOB declines (about 3 minutes; status wontfix, accepted by
Cameron). These exits are new with this branch, their tail is set by this
branch's refreshes, and the new comment asserts the opposite; rate it LOW if
the accepted class is meant to cover them.

Fix: on those no-send ends, EXPIRE the promise the way RSW's D7 does -
`annotateRetryPromise` to `RETRY_PROMISE_WITHDRAWN_AT` WITHOUT `retry_outcome`,
conditioned on the value read, plus the `message.persisted` emit - so "will
retry" drops and Retry returns at once (the dashboard already reads the bare
sentinel as a plain failure with Retry). One helper next to
`withdrawRetryPromise`, called from closeSlot's retry_send arm for
`REDRIVE_REFUSED_CODE` / `ENQUEUE_FAILED_CODE` and from the job's terminal
no-send arms when the claim came from `redriven`. At minimum, correct the
closeSlot comment and record the extended tail on the accepted issue.

### A-2 - LOW - CONFIRMED - a late automatic retry and a staff press whose provider call is in flight both text the member (filed gap 1, narrowed, not closed)

Surface: `app/src/routes/api.ts:1638-1690` (the route READS the child pointers
and the attempt record but never writes anything the job contends on) against
`app/src/jobs/retrySend.ts:457-462` (the job's supersession check) and `:493`
(its claim).

Failure (interleaving): the promise has lapsed because the job runs late. The
press passes every guard (no child, no record) and enters its provider call.
The job then runs: gate absent, `listRetryChildrenConsistent` sees no child
(the press has not appended yet), window open, claim, send. The press appends
after. Two texts, and the retried row gets two children (a fork).

Evidence: probe `B ... both text the member` - the press's provider call held
open while the job ran: `{ texts: 2, children: 2 }` vs expected `{ 1, 1 }`;
the press answered 201.

Registry: `manual-retry-double-send-residual-windows` (open, low), gap 1.
This branch closes gaps 2-5 there (superseded, the open-record guard, the
unresolved refusal, and - via the job's supersession check - gap 5's
withdrawn-promise press), so the issue should be updated to say what remains:
this in-flight overlap only. Related residue: the route treats `done/retryable`
(a pending deferral) as closed (`api.ts:1683-1690`) and relies on the
deferral's refresh; if that refresh throws, the same overlap applies to the
deferred run.

Fix: the issue's own suggestion, now cheap: before its provider call the route
takes a conditional write on the SAME record key
(`retry#<conv>#<row>#<(retry_attempt ?? 0)+1>`) - create it `done/refused`
cause `manual_retry_superseded` when absent, close it from `done/retryable`,
409 when it is open - so whichever side writes second loses (the job's create
claim fails as `refused`). Trade-off to decide: a press whose own send is then
refused has also ended the automatic attempt.

### A-3 - LOW - CONFIRMED - the broadcast rollup's miss path now runs on every share-retry receipt, and its WARN is gone for genuine misses too

Surface: `app/src/routes/webhooks/twilio.ts:3903-3905` (the level change is
unconditional), `:3898` (the sleep), `:322` (2500 ms), `:3529-3545` (the
rollup runs for any row carrying `broadcast_id`, before the 30003 arm).

Failure: since R7 every retry row of a share text carries `broadcast_id`, but
no slot can match it (`matchesSlot` compares the slot's own tsMsgId). So every
transition callback of such a row (sent, delivered, failed) reads the
broadcast twice and sleeps 2.5 s before answering Twilio. Separately, the
downgrade to INFO also applies to a share's OWN row (no `retry_of`) whose slot
genuinely failed to match - a lost or mis-keyed slot write - which was the
only signal for that fault (WARN feeds the dev log tail and Recent Errors).

Evidence: probe `C ... GENUINE rollup miss on a share's OWN row` - a share row
with no `retry_of` whose slot names another row: the miss logged at level 30,
expected 40. The branch's own test "a receipt for a share-RETRY row ...
gives up at INFO after the one re-load" pins `reads === 2`, i.e. the sleep
path runs.

Fix: pass `message.retry_of` into `rollIntoBroadcast` and return before any
read or sleep for a retry row (INFO, one line) until Branch B teaches the
rollup; keep WARN for a genuine miss on a share's own row.

### A-4 - LOW - PLAUSIBLE - crash strands in the retry path block the manual Retry for up to 15 minutes while the bubble offers it

Surface: `app/src/jobs/retrySend.ts:803-807` then `:766` (the hand-off write,
then the check-0 enqueue), `app/src/jobs/sendReconcile.ts:1607-1619`
(markRedriven, then the re-drive enqueue), `app/src/lib/sendAttemptGate.ts:38`
(a `reconciling` or fresh `attempting` record DEFERS), `app/src/routes/api.ts:1683-1690`.

Failure (interleaving): a process death between the record write and its
enqueue leaves `reconciling` (or `redriven`) with no chain. Every redelivery of
the job defers on it and is deleted; nothing ever resolves the attempt. Once
the promise lapses (at most A+480 s) the bubble shows Retry, but the route
answers 409 `retry_pending` until A+15 min, and after that it lets a press
through - a second text if the stranded attempt had in fact been accepted.
The same "Retry shown, refused" flicker happens without a crash when the
reconcile checks run late (backlog): the promise ends at A+480 s, the record
stays open until the late last check.

Registry: the strand class is `send-attempt-sweeper` (open, med); the retry
owner's specific consequence (a 15-minute refusal window under a visible
Retry, then an unguarded press) is not recorded there. Fix: list the
`retry_send` owner in the sweeper's scope and record this consequence; no
change needed on this branch.

### A-5 - NOTE - deploy, rollback and mixed-fleet behavior

- Rollback to main: a queued `send.reconcile` with `owner.kind: 'retry_send'`
  throws in main's parser ("owner.kind is not a send-attempt owner",
  main `sendReconcile.ts:196`), is received five times and dead-letters, which
  pages `jobs-dlq-depth`; its record stays `reconciling`. A deferral payload's
  `deferred: true` is dropped by main's parser and the retry runs under main's
  marker (harmless).
- Mixed fleet (old worker, new app): retry rows an old instance appends carry
  no `retrychild#` pointer, so the new route's `superseded` check cannot see
  them (the comment's "no backfill" covers pre-deploy rows only).
- Forward deploy is covered by the read-only marker belt.
Recommend one deploy note: drain or expect DLQ pages on rollback.

### A-6 - NOTE - two hand-kept copies of rules that must agree

- The attempt record key is assembled twice: the job
  (`retrySend.ts:404-411`, attempt from the payload, i.e. the webhook's
  `priorAttempt + 1` at `services/oneToOneRetryDecision.ts:129`) and the route
  (`api.ts:1652-1666`, attempt recomputed as `(retry_attempt ?? 0) + 1`). If
  either drifts, the route reads an empty key and its `retry_unresolved` and
  open-record guards pass silently. One helper in `services/retryChain.ts`
  returning the owner for a retried row, used by both, plus a test pinning key
  equality, would lock it.
- `adoptRetry` (`sendReconcile.ts:882-903`) restates the retry row's append
  shape field by field; a lineage field later added to the send wrapper's
  append would be silently missing from adopted rows (the
  `adoptBroadcastRecipient` precedent has the same shape).

### A-7 - NOTE - the pre-adoption belt is a time-limited guard with a permanent cost

`retrySend.ts:444-450` can only ever fire for a redelivery of an envelope the
pre-deploy code ran (about 5 x 120 s visibility timeout after the deploy, plus
the at most 240 s backoff). After that it is dead code that adds one GetItem
to every first run. Recommend filing its removal for the next release.

## Swept and clean

- Append transaction: the `retrychild#` Put sits after the email pointer and
  the due row and is unconditioned; index 1 (SID pointer) and index 2 (email
  pointer, email rows only - retry rows are never email) attribution intact; a
  dedupe cancels the pointer with the row; no item-key collision with media
  pointers; no GSI on the messages table; its stream has no consumer.
- Scanners and resets of the messages table: the media backfills filter on
  media attributes, devReset deletes everything, import rollback and the
  performance seed write no retry lineage, the seeds carry none.
- `retry_due_at` writers: the webhook's transition write (once, terminal), its
  D7 withdrawal (same request, before any job can run), `annotateRetryPromise`;
  `retry_outcome` only by the withdraw; no path refreshes a withdrawn row;
  real and fake `annotateRetryPromise` / `listRetryChildrenConsistent` held
  equal by the parity suite.
- Promise races: the withdraw's retry-once converges with the reconcile's
  re-drive refresh in both orders; a stale refresh loses to a withdraw.
- SQS redelivery at every point of the job: before the claim (reruns); claim
  or re-arm then death (redelivery at +120 s exceeds the 30 s TTL, takeover,
  reconcile); sent but not appended (lookup adopts); appended but not closed
  (heldBy mine, adoption skipped); closed (gate skip); after a deferral (one
  claim from retryable, the deferred run then skips); after a hand-off (defer).
- Two concurrent deliveries: the create claim is conditional, the loser is
  refused; a TransactionConflict throws before any send.
- Re-drive vs the re-driven job vs a redelivered original: one claim from
  `redriven` wins; markRedriven fenced on redrive_count 0; a second unknown
  closes unresolved (D13a). Hop count of the longest chain stays within 10.
- Exhaustiveness: every owner switch in `sendReconcile.ts` ends in
  `unhandledOwner(never)`; `ownerKey` / `recipientKeyOf` and the harness fake
  are exhaustive; the payload parser throws on an unknown kind.
- Lineage exclusion: every predecessor's SID has a row, so dropping it from
  the sibling SID skip cannot mis-adopt (heldBy answers `other`).
- `isBroadcastRowFor` retry exclusion and `rowHolder`: consistent with every
  caller; the rollup can never match a retry row to a slot.
- Pre-adoption belt: markers are keyed by envelope UUIDs; no collision with
  other jobs' markers or the missed-call `callSid` marker.
- Media plan: `planRetryMedia`'s mediaCount equals the send wrapper's
  `facts.mediaCount` in all three branches; adoption replays media only when
  the attempt sent media, never a stored presigned URL.
- Import cycle `retrySend` <-> `sendReconcile`: neither side reads a cycle
  binding at module evaluation.
- Route: auth unchanged (session gate plus the manual-send limiter); the new
  reads are bounded (one pointer partition, one Get, at most three root hops);
  guard order pinned by tests; a stale tab gets the two new sentences.
- Dashboard: `retry_outcome` mirrored and pinned; "retry not confirmed"
  outranks the promise, hides Retry, 30003 only, relay legs unaffected.
- Logs and payloads: job payloads carry ids only; log lines use
  `safeRecipientKey`; the rejected arm omits `err`; the reconcile payload's
  unkeyed recipient hash is the filed `send-attempt-recipient-hash-unkeyed`.
