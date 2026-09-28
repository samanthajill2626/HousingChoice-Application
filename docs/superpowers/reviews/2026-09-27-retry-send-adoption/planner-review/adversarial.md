# Adversarial review (blind) - feat/retry-send-adoption @ 95edb0b6 vs main@3dbb5740

Reviewer: plan-blind adversarial pass. Inputs: the diff package
(.superpowers/review/planner-package.txt) and the repository only. Nothing was
executed (a gate e2e was running on the worktree); every claim below is from
reading code, and each interleaving is walked by hand. Line numbers are the
worktree's files at 95edb0b6.

Verdict in one line: no BLOCKING and no HIGH that the branch introduces. The
claim/re-arm/fence machinery, the promise CAS, the pointer family and the route
guards hold under every interleaving I walked except the two MEDIUMs below; the
rest are LOW and named residuals.

---

## Findings

### 1. [MEDIUM] The job and the reconcile both ignore the retrychild# proof that THIS attempt already produced a text - a re-driven attempt sends again beside its own row, and a test pins that

What is wrong. For one retried row there is exactly one automatic attempt
number: the webhook schedules `(row.retry_attempt ?? 0) + 1`
(app/src/services/oneToOneRetryDecision.ts:125-129), and the deferral and the
re-drive reuse the payload's attempt (app/src/jobs/retrySend.ts:732-735,
app/src/jobs/sendReconcile.ts:1513-1525). So a retrychild# pointer under the
retried row carrying `retryAttempt === payload.attempt` can only have been
appended by THIS attempt (sendMessage's append, or the reconcile's adoption) -
it is consistent, local proof that the attempt already went out, and it even
carries the provider SID (app/src/repos/messagesRepo.ts:2785-2798). The code
reads that partition and throws the proof away:

- the job's step 4a declines only on a MANUAL child and explicitly proceeds on
  an automatic one (app/src/jobs/retrySend.ts:461-466: `children.some((child)
  => child.retryAttempt === undefined)`), then claims from `redriven`
  (app/src/repos/sendAttemptsRepo.ts:471-476) and sends;
- the reconcile's lookup only ever learns about the attempt's own row through
  a SID the provider LISTS inside the window (sendReconcile.ts:1184-1236); it
  never consults the pointer before ruling `never_sent`
  (sendReconcile.ts:1260) and re-driving (sendReconcile.ts:1607-1631).

Test app/test/retrySendAttempt.test.ts:688-693 ("an AUTOMATIC child alone does
not decline") seeds an automatic child of row3 WITH retryAttempt 1, runs
attempt 1 on row3, and asserts the provider is called and the record reads
done/sent - i.e. it pins a second attempt-1 text beside an existing attempt-1
row as the intended behavior.

Failure scenario (no list anomaly needed):
1. Run A claims (X,1), re-arms at T1 (`beforeProviderSend`,
   retrySend.ts:545), and its provider request is slow to leave the process
   (event-loop stall / socket backpressure) - Twilio creates the message at
   T1 + 100 s.
2. At T1 + 120 s (the SQS visibility timeout, infra/modules/jobs/main.tf:36)
   the envelope is redelivered as run B. B's gate sees `attempting` older than
   SEND_CLAIM_TTL_MS and takes it over (lib/sendAttemptGate.ts:35-37) -> the
   reconcile chain for T1.
3. A's call returns; sendMessage appends R1 (retry_of X, retry_attempt 1) and
   its retrychild# pointer; A's finishAttempt loses its fence (WARN,
   retrySend.ts:567-570).
4. The reconcile's window is [T1 - 60 s, T1 + 90 s]
   (lib/sendOutcome.ts:32,41; sendReconcile.ts:1123-1125). m.createdAt =
   T1 + 100 s is outside it, so the last check finds nothing and rules
   `never_sent` -> markRedriven -> re-drive.
5. The re-driven job: gate `redriven` -> proceed; 4a sees R1 but R1 is
   automatic -> ignored; window OK; claim from redriven; sends. The tenant gets
   the attempt-1 retry twice.
The same second text follows from any list omission while R1 exists (the list
ordering/completeness is marked UNVERIFIED in sendReconcile.ts:1156-1171).

Consequence class is a double text (HIGH by the charter's definition); ranked
MEDIUM because every path needs a takeover whose original call later succeeds
plus a window/list miss. The point is that the branch already holds the one
cheap, strongly consistent belt that closes the whole class and discards it.

Fix (small): in the job's 4a, treat `children.some((c) => c.retryAttempt ===
payload.attempt)` as "this attempt already sent" - decline before the claim
(closing a `redriven` record as the 4a/4b declines do, with its own cause) and
WARN. Optionally, in the reconcile, before `never_sent` for a retry_send owner,
read the pointer and, if one names this attempt, take the known-SID path with
its `providerSid`. Flip test 4c(4) to assert no provider call.

### 2. [MEDIUM] broadcast_id on every share-retry row routes all of its receipts through the rollup's genuine-miss path: a 2.5 s sleep and two broadcast reads per callback, the next rung's enqueue held behind the sleep, and the WARN->INFO downgrade now also hides real rollup losses

What is wrong. Since this branch every one-to-one retry of a share text carries
the share's broadcast_id (retrySend.ts:544; sendReconcile.ts:902 adoption;
routes/api.ts:1769 manual). The status webhook rolls ANY row with a
broadcast_id into the broadcast on every transition, awaited
(app/src/routes/webhooks/twilio.ts:3529-3545), for `sent` as well as the
terminal statuses (twilio.ts:3872-3878). The slot is matched by
conversationId + tsMsgId (twilio.ts:3887-3889) - the share's OWN row - so a
retry row never matches; the rollup then sleeps statusRetryDelayMs
(2_500 ms by default, twilio.ts:322, 702), re-reads the broadcast, misses again
and returns (twilio.ts:3890-3906). Before this branch retry rows had no
broadcast_id and never entered this function.

Consequences:
- Every sent/delivered/undelivered callback for a share retry now holds the
  webhook request ~2.5 s and costs two broadcast reads. The comment above the
  sleep ("only on the genuine-miss path", twilio.ts:3891-3897) is no longer
  true.
- On a 30003 for a share-retry row, the status write has already published the
  next rung's promise (retry_due_at rides updateDeliveryStatus,
  twilio.ts:3462-3467) but the enqueue of that rung (twilio.ts:3622-3631) now
  runs only after the 2.5 s sleep. A process stop inside that sleep (deploy,
  scale-in) loses the rung: a Twilio redelivery finds `transitioned` false and
  enqueues nothing, and the promise simply lapses. The window existed before
  for milliseconds; the sleep makes it ~2.5 s for exactly these rows.
- The "one fenced line" (twilio.ts:3904) downgrades the give-up to INFO for
  ALL rows, including a share's own row whose slot genuinely never landed - the
  one signal that a share's stats went stale is now invisible at WARN.

Evidence the tests cannot see it: the new rollup test runs with
`statusUnknownSidRetryDelayMs: 5` (app/test/twilioStatusWebhook.test.ts:379),
so the production sleep never appears.

Fix (small): skip the rollup at the call site when `message.retry_of` is set
(twilio.ts:3529, one condition) and restore the WARN on the genuine miss. That
removes the sleep, the reads and the masking together, and leaves Branch B free
to teach the rollup retry_root later.

### 3. [LOW] Residual double text (pre-existing, narrowed, not introduced): the manual Retry route and a late automatic job still race inside a sub-second window

What is wrong. The route reads the attempt record (routes/api.ts:1652-1690)
and only then makes its provider call and append (api.ts:1755-1772); it writes
nothing the job can see before it sends. The job checks for a manual child
(retrySend.ts:461) and only then claims (retrySend.ts:497).

Failure scenario: the automatic job for (X,1) runs more than
RETRY_PROMISE_GRACE_MS past its (possibly refreshed) due time - a worker
backlog or outage - so the route's first guard (api.ts:1626) no longer
refuses. Staff press Retry: the route reads no record (absent) and starts its
Twilio call. The job starts in that same instant: its 4a Query sees no child
(the route has not appended yet), it claims and sends. Both texts go out. The
route did not see the claim (read before it), the job did not see the pointer
(appended after). The width is the route's provider-call latency.

The api.ts comment already names the filed class
(manual-retry-double-send-residual-windows, api.ts:1623-1625); this branch
narrows it considerably (4a catches every press appended before the job
starts). Named here because the charter asks for every double-text path.

Fix (if wanted): make the route CLAIM before it sends - a conditional write on
the same attempt record key (absent / done-retryable / redriven -> done/refused
cause `manual_retry`), so exactly one of the two conditional writes wins.

### 4. [LOW] The hand-off and re-drive REFRESHes add the promise grace to the stored due time, so the grace is applied twice

What is wrong. `retry_due_at` means "when the retry runs": the webhook stores
runAt (twilio.ts:3466) and the deferral stores runAt (retrySend.ts:747), and
`isRetryPromiseLive` adds RETRY_PROMISE_GRACE_MS on top
(lib/retrySendWindow.ts:99-104). The unknown hand-off stores attemptedAt +
last check + RETRY_PROMISE_GRACE_MS (retrySend.ts:795-800) and the re-drive
stores now + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS
(sendReconcile.ts:1636-1642) - so the promise lives a second grace past the
schedule.

Scenario: a re-driven retry that is refused or rejected at once writes no
promise; the bubble still reads "will retry" and the route answers 409
retry_pending for about 5 minutes (60 + 120 + 120 s) instead of about 3; after
an unknown hand-off whose chain ends redrive_refused / enqueue_failed the
button stays hidden ~2 minutes longer than the reconcile's own schedule needs.
This lengthens the accepted class the closeSlot comment names
(sendReconcile.ts:1308-1326) rather than creating a new one.

Fix: store the schedule (attemptedAt + last check; now + RETRY_JOB_GRACE_MS)
and let isRetryPromiseLive apply the grace once.

### 5. [LOW] resolveRetryRoot's legacy walk is bounded at MAX_SEND_RETRY_ATTEMPTS hops, but a manual Retry extends a chain past three rows - a pre-deploy mixed chain resolves a non-root row, persisted forever as retry_root

What is wrong. services/retryChain.ts:23-33 walks retry_of for a row with no
retry_root at most MAX_SEND_RETRY_ATTEMPTS (3) hops and returns whatever row it
reached. The automatic cap bounds automatic hops only; a manual Retry row
(retry_of, no retry_attempt) starts a new automatic run under the same root, so
a legacy chain can be deeper than 3.

Scenario: pre-deploy X -> R1 (auto) -> R2 (auto) -> M (manual retry of R2) ->
M1 (auto retry of M), none with retry_root. After the deploy M1 fails 30003:
the job resolves root = R1 (hops M1->M->R2->R1, then stops) and stamps
retry_root = R1 on the new row (retrySend.ts:367, 543); a press on M1 does the
same (api.ts:1654, 1768). If X was a share text, R1 carries no broadcast_id,
so the key Branch B is meant to route by points at the wrong row. Legacy rows
only - every post-deploy retry row carries retry_root, so the walk ends at hop
0 or 1.

Fix: bound the walk by a visited set or a larger constant (it is there to stop
a cycle, not to model the cap).

### 6. [LOW] The attempt facts have two sources of truth - the job's claim and sendMessage's own - and only the sender was unified

What is wrong. The job computes the record's facts itself (retrySend.ts:487-496:
its own conversation read for the digest, bodyFingerprint of the row,
plan.mediaCount), while the message actually sent is shaped inside sendMessage
(services/sendMessage.ts:601-626: its own conversation read, `from`, the
mediaUrls it was handed). lib/outboundSender.ts unified the sender pin; the
digest input and the media count are still computed twice by parallel rules
(planRetryMedia vs `mediaUrls?.length ?? attachments?.length ?? 0`).

Consequence: any future divergence (a per-thread sender, media batching or
transcoding in the send path) makes the reconcile fail the digest or the
fingerprint for every unknown retry - `digest_mismatch` or
`unidentified_candidate` -> unresolved -> "retry not confirmed" with Retry
withheld for good, although the provider holds the text. Safe direction (never
a re-send), silent in effect. Maintainability, not a live bug.

Fix: have the job take the facts from the wrapper (e.g. pass them out of the
pre-send hook) rather than recomputing them.

### 7. [LOW] Stranded records of the new owner inherit the unbuilt sweeper, and the route turns a stranded unknown retry into a misleading "already scheduled" and then a permitted re-send

What is wrong. Several failure-arm writes leave the record `attempting` with
nothing scheduled: a thrown handToReconcile (retrySend.ts:814-823, the unknown
arm), a thrown finish in refuse/rejected (retrySend.ts:651-670), and the
record-phase throw after a send (retrySend.ts:576-579). A reconcile check that
reaches the DLQ leaves `reconciling`. No sweeper exists yet (only references;
grep "sweeper" finds no implementation).

Scenario (unknown arm): the provider call times out (the text may have gone
out), handToReconcile's write throws -> no reconcile, no refresh, no
retry_outcome. The promise lapses at due + 2 min, so the bubble shows a plain
failure with Retry; a press gets 409 retry_pending "A retry is already
scheduled for this message." (api.ts:1683-1690; Timeline.tsx sentence) for up
to 15 minutes, then the route lets it through - a possible second text if the
unknown one was delivered. Only guardWrite's ERROR records it. Needs a
DynamoDB write failure on top of an unknown outcome; the same residual the
other three owners carry. Named because the charter asks for stranded paths.

### 8. [LOW] Two tests assert less than they appear to

- dashboard/src/routes/contact/Timeline.test.tsx:974 `expect(sentence).toMatch(/^[ -~]+$/)`
  checks the test's own table literal, not anything the component rendered
  (the rendered text is checked by the line above it, so the ASCII claim about
  the product copy is pinned only by the literal's authorship).
- app/test/twilioStatusWebhook.test.ts:379 exercises the share-retry rollup
  with a 5 ms delay seam; it proves the level and the no-op, but it cannot
  show the 2.5 s production cost that finding 2 is about.

---

## Swept and holding

Races and idempotency (walked as interleavings):
- Duplicate SQS delivery of one envelope, sequential and concurrent: the gate
  skips a done record, defers a fresh attempting one, and a claim race loses
  with `refused fresh` (sendAttemptsRepo.ts:459-483; retrySend.ts:421-440,
  497-505). A TransactionConflict on the claim rethrows before any send and the
  redelivery defers. Holds.
- Two webhook transitions for one retried row (new jobIds, same attempt): the
  record keys on (retried row, attempt), so the second job meets the first's
  record - an improvement over the per-jobId marker. Holds.
- Stale attempt takeover vs a still-alive original: the re-arm is fenced on
  attemptNo + attemptedAt, so a taken-over run cannot reach the provider
  (sendAttemptsRepo.ts:416-457; sendMessage.ts:627-629), and a run already
  inside its call loses every later fence; the reconcile adopts its row as
  `mine` via isRetryRowOf (sendReconcile.ts:776-778). Holds (see finding 1 for
  the one gap).
- Rearm committed but reported failed: SendNotAttemptedError -> deferral whose
  release loses its fence; the deferred job (backoff >= 60 s > 30 s TTL) takes
  the stale record over into reconcile, never_sent, one re-drive. No double.
- Deferral enqueue-before-release, process death in between: the deferred run
  takes the stale record over. Deferral after a takeover: the deferred job and
  the reconcile's re-drive race for the `redriven` claim; one wins. Holds.
- Reconcile duplicate checks: recordCheck from n-1 or n; both duplicates may
  run a lookup, and the adoption dedupe (append on the SID pointer, then
  isRetryRowOf on the read-back) makes the second `skipped`. Holds.
- Promise writes: every job/reconcile write goes through annotateRetryPromise
  conditioned on the value read (messagesRepo.ts annotateRetryPromise); the
  WITHDRAW retries once from a fresh consistent read and is idempotent on
  sentinel + outcome; a failed/lost WITHDRAW in the reconcile fails the check so
  the superseded exit re-applies it (sendReconcile.ts:1327-1333, 528-532).
  Hand-off refresh vs reconcile WITHDRAW/refresh in either order converge.
- A second 30003 transition on a row already WITHDRAWN rewrites retry_due_at,
  but retry_outcome outranks it on screen and the new job's gate skips the
  terminal record. Holds.
- MAX_HOP_COUNT: the longest chain (webhook -> job -> deferral -> checks 0-2 ->
  re-drive -> deferral -> sent_unrecorded hand-off -> checks 0-2) reaches hop
  10 exactly; a would-be 11th enqueue cannot occur (redriveCount fence). Holds,
  with no headroom, as the code says.

Readers and writers of the new state:
- sendattempt# retry_send records: written by the job and the reconcile, read
  by the route by key (api.ts:1656-1666) and by listByRecipient siblings; the
  key excludes retryRoot on every side (sendAttemptsRepo.ts:177-179); the route,
  job and reconcile derive the same recipient key from immutable data
  (services/retryChain.ts retryRecipientKey). Payloads carry only the hashed
  key (sendReconcile.ts toOwnerRef). Holds.
- retrychild# pointers: written only inside the append transaction, after the
  SID pointer and the email pointer so the positional dedupe attribution is
  unchanged (messagesRepo.ts:2776-2799, 2835-2877); unconditioned, cancelled
  with the transaction on a dedupe; own partition, so listByConversation and the
  timeline never see it. No seed or importer writes retry_of rows. Only the job
  and the route read them. Holds.
- retry_root: written at append by the job, the adoption and the route; read by
  resolveRetryRoot only (and Branch B later). See finding 5.
- retry_outcome: written only by the WITHDRAW; projected only for the one value
  (contactTimeline.ts:462); the dashboard hides Retry and changes the chip
  (Timeline.tsx:1056, 1071, 1441; deliveryStatus.ts); the route refuses on it or
  on the record. The live re-render reaches the app through the worker event
  bridge (lib/events.ts header). Holds.
- retry_due_at: see Promise writes above.
- broadcast_id on retry rows: the broadcast reconcile never claims a share-retry
  row (isBroadcastRowFor retry_of guard, broadcastFanOut.ts:1299-1309), and
  adoptBroadcastRecipient uses the same predicate, so a slot never points at a
  retry row; the only other reader is the webhook rollup - finding 2.
- The run-once marker: no longer written by this job; read only by the
  pre-adoption belt for a record-less delivery. Holds.

DynamoDB expressions: annotateRetryPromise lists exactly the aliases each of
its four shapes uses; listRetryChildrenConsistent uses one value; the new
retry_send ownerKey/recordKey are opaque strings. The retry append adds one
item to the transaction (well under the item limit even with ten media
pointers). No table scan in app code meets the new partitions (only the dev
wipe/reset scans, which delete everything).

Architecture: the retrySend <-> sendReconcile import cycle uses imported
bindings only inside functions; no module-level const reads a cycle member
(checked the module-level bindings of both files, oneToOneRetryDecision,
retryChain, retryPromiseWrites). MAX_SEND_RETRY_ATTEMPTS moved to the leaf with
a live re-export. sendReconcile now threads a fourth owner through ~12
exhaustive switches with `never` guards - growing, but typecheck-enforced.
Function declarations inside the retry handler close over consts that are all
bound before their first call (promise and originMs before the gate).

A redriven record can strand if the re-drive job declines in steps 1-3 (row
gone, thread no longer one-to-one) before the gate; theoretical - the reconcile
resolved the same row and thread moments earlier.

PII: payloads carry ids and the hashed key; job and reconcile lines carry the
owner ids and the redacted key; the rejected arm omits `err`. The retryable and
unknown arms log `err` (a Twilio error) the same way the other SOR sites do,
through the safe serializer - not new.

UI: one projector feeds the contact timeline and its SSE refetch; the only
Retry surface is ContactCommsPane -> Timeline; the collapse hides any row with
a loaded child, so the route's new `superseded` refusal is reachable only from a
stale tab or a direct call. The two new 409 sentences are ASCII.

Tests: the route tests use a hand stub that turns any unexpected read into a
500, so the guard-order and "no thread scan" cases would go red on a
regression; the A-6 cases drive the real job, reconcile and route over one
world; the integration suites pin the four annotateRetryPromise shapes and the
pointer order against DynamoDB Local and the fake. UNVERIFIED: real Twilio
list completeness and ordering (the code itself says so), and whether a rolling
deploy lets an old worker receive a retry_send reconcile check (it would fail
to parse and retry).
