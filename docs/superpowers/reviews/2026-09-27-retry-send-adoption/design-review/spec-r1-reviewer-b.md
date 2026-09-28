# Retry-send adoption (Stage 1b) - design review round 1, reviewer B (adversarial)

Spec under review: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`
(revision 1, commit 034912bb). Read on top of SOR revision 12 (section 12 errata,
D1-D23) and RSW sections 2-5, against the tree at main@3dbb5740 in
`W:\tmp\retry-send-adoption`. Read-only review: no tests were run. Every claim
about existing behavior cites a file:line that was read; anything not verified
is marked UNVERIFIED.

Severity is the consequence if the spec ships unfixed.

---

## 1. [BLOCKING] `retry_outcome` "never on a retry row" contradicts the chain the job actually runs

**What is wrong.** R5 says the new field lives "on the FAILED one-to-one
original ... Never on a retry row", and R10 promises Branch B that "On the
original after the chain ends" it will find `retry_due_at` withdrawn and
`retry_outcome: 'unconfirmed'`. But for rungs 2 and 3 the row the job calls "the
original" IS a retry row:

- The 30003 arm enqueues the job with the SID of the row that just failed:
  `providerSid: MessageSid` (`app/src/routes/webhooks/twilio.ts:3624-3631`),
  with `attempt = (message.retry_attempt ?? 0) + 1`
  (`app/src/services/oneToOneRetryDecision.ts:125-129`).
- The job reads that row as `original` (`app/src/jobs/retrySend.ts:174`).
- So for attempt 2, "the original" is retry row 1; R1's `originalTsMsgId`,
  R3's WITHDRAW/REFRESH, R3's second-unknown `retry_outcome` write and R4's
  `unresolved` write all land on retry row 1.
- The dashboard's retry collapse hides every row that some later row names in
  `retry_of` (`dashboard/src/routes/contact/Timeline.tsx:2062-2075`), so in an
  attempt-2 chain the only visible bubble IS retry row 1. That is exactly where
  "retry not confirmed" has to render.

**Evidence of internal contradiction.** R3 (second unknown) and R4
(`unresolved`) write the field on the row the job/reconcile resolved; R5 forbids
it on a retry row; R10 tells Branch B to read it on "the original" (for a share,
the slot's own row). R5 also says the field is "written only by R3's
second-unknown arm and R4's `unresolved` close", while R3's enqueue-failure
paragraph is a third writer ("`retry_outcome: 'unconfirmed'` only when a send
may have happened").

**What it implies.** A builder cannot satisfy both texts. Following R5 (skip
retry rows, or write on the chain's first message) leaves an unresolved attempt
2 or 3 with a plain 30003 and a live Retry button on the visible bubble after
the promise is withdrawn - precisely the joint gap Cameron's Q1 ruling closed,
with a possible double text. Following R3/R4 makes R5 and R10 false, and Branch
B reads the wrong row for rungs 2-3. The spec must define "original" as "the row
this rung retries (the chain's tail)" everywhere, drop "never on a retry row",
fix R10's contract for rungs 2-3, and list every writer.

---

## 2. [HIGH] R6 reads the record but claims the closures only a CLAIM would deliver; its gap numbers do not match the issue

**What is wrong.** R6 is titled "the manual Retry route claims the same record",
but its body only READS records (three `get`s) and refuses on
`attempting`/`reconciling`/`redriven`; section 2's fence says "a staff Retry is
... no attempt record". It then claims to close
`manual-retry-double-send-residual-windows` gaps 1, 2 and 5 "for the automatic
retry", and section 5 closes gaps 1, 2, 4, 5 with "gap 3 stays".

- The issue's own suggested fix is that "the manual retry route claim against
  the same record, so whichever of the two sends second finds the claim taken"
  (`docs/issues/manual-retry-double-send-residual-windows.md`, Suggested fix).
  A read does not do that: the job's later claim still finds the record ABSENT
  and sends.
- Gap 1 (a late job, promise expired while the job is still QUEUED): a queued
  job has no record yet (the claim is R2 step 5), so the guard passes, staff
  send, then the job claims "absent" and sends. Only the post-claim slice of
  gap 1 is covered.
- Gap 5 (enqueue throws after SQS accepted): the webhook withdraws the promise
  at once (`twilio.ts:3638-3647`), the job is queued with no record, the guard
  passes, and both send. Not closed at all.
- The spec's "gap 2 (a deferral)": during a deferral the record is
  `done`/`retryable` (R3), which R6 does not refuse; only the time-based
  refresh covers it, so a late re-run reopens it.
- Numbering: in the issue, gap 2 is "A stale browser tab retrying ... an
  original that an automatic retry has already replaced", and gap 3 is "A
  one-to-one retry whose outcome is still pending past `retry_due_at` ... unless
  the path that leaves it pending refreshes `retry_due_at`" - which is what R3's
  refresh closes. The spec's list closes the stale-tab gap (which it widens -
  finding 3) and leaves open the pending-outcome gap (which it closes).

**What it implies.** Section 5 would mark closed, in the registry, double-send
windows that remain open; the "Retry is safe" belief then rests on nothing.
Either R6 becomes a real claim contended by both sides (and the section 2 fence
changes), or the closure claims shrink to "post-claim window only" and the gap
numbers are corrected.

---

## 3. [HIGH] Withdrawing the original's promise on success reopens the stale-tab double send immediately, for no on-screen gain

**What is wrong.** R2 step 8 (and R4's adoption) withdraw the original's
`retry_due_at` the moment the retry row exists, justified as "the original's
'will retry' copy must stop".

- The copy is already gone: the retry row is appended with `retry_of`
  (`app/src/services/sendMessage.ts:663`), and the Timeline hides any row a
  later row names in `retry_of` (`Timeline.tsx:2062-2075`). The original bubble
  is not on screen.
- What the withdrawal DOES change is the server guard: today a stale tab that
  presses Retry on the replaced original is refused with 409 `retry_pending`
  until `retry_due_at + RETRY_PROMISE_GRACE_MS` (`app/src/routes/api.ts:1608-1611`;
  the issue's gap 2 text says exactly this). After the withdrawal that guard is
  off; R6's record guard passes because the record is `done`/`sent` (not in its
  refused set); the original is still `undelivered` (terminal, so the
  `not_failed` check at `api.ts:1595` passes); `sendMessage` sends a second
  text.

**What it implies.** The spec makes the stale-tab double send reachable the
instant the automatic retry succeeds, where today it is refused for about two
minutes - while section 5 claims to close that gap. Either do not withdraw on
success (the collapse already handles the screen), or make R6 refuse when a
`retry_send` record for this row is `done` with `sent`/`adopted`.

---

## 4. [HIGH] Keeping the run-once marker defeats the record's only crash recovery for this job

**What is wrong.** Section 2 keeps the marker: "it is cheap and the record makes
it redundant, not wrong." R12 adds that "a stranded retry attempt IS taken over
by the re-driven or re-scheduled rung's claim when one runs".

- The only later claimant for the SAME owner (same original, same attempt) after
  a crash is the SQS redelivery of the same envelope. The job's own comment says
  a SIGTERM or visibility overrun redelivers it (`retrySend.ts:203-209`), and
  the redelivery carries the same `jobId`, so the marker suppresses it
  (`retrySend.ts:210-219`) before it can reach the claim.
- Without the marker, that redelivery (SQS visibility 120 s, SOR D13a) would
  meet an `attempting` record older than the 30 s TTL and take it over into
  reconcile (`app/src/repos/sendAttemptsRepo.ts:440-444`) - the D8a recovery.
  With the marker, the record stays `attempting` forever (no sweeper: SOR D14,
  errata 6).
- R12's "re-driven or re-scheduled rung" does not exist for a strand: rung N+1 is
  a different record (the owner key includes the attempt, R1); a re-drive only
  follows `markRedriven` from `reconciling` (`sendAttemptsRepo.ts:550-556`); a
  re-schedule follows only a completed deferral arm. In the lane (10 s backoff,
  below the 30 s TTL) even a deferral whose `finishAttempt` write failed is
  refused fresh, not taken over.
- `guardWrite` documents lost writes as "left to the stale-claim takeover"
  (`app/src/lib/guardWrite.ts:1-6`), which the marker makes unreachable here.

**What it implies.** Guarantee 2 ("every retry rung reaches a terminal state
that staff can see") fails for every deploy-time or crash interruption after the
claim, and finding 5 turns each such strand into a permanent refusal. The marker
is not redundant; it is the thing that removes the recovery. Drop it (the claim
dedupes a redelivery: fresh -> refused, done -> refused, stale -> takeover) or
state the strand as a residue and bound R6.

---

## 5. [HIGH] R6's record guard has no staleness bound: every strand becomes a permanent, false "already scheduled"

**What is wrong.** R6 refuses 409 `retry_pending` while ANY `retry_send` record
for the row is `attempting`, `reconciling` or `redriven`, with no age limit. The
spec itself names several ways a record strands in those states:

- R3 record-phase row: "a lost hand-off leaves `attempting` (stranded)".
- R4 resolve: "Not found -> INFO, the record is left for the sweeper" (stays
  `reconciling`); finding 6 makes "not found" reachable by a contact edit.
- A crash after the claim, made permanent by the marker (finding 4).
- A pre-claim decline on a re-driven job leaves `redriven` (finding 9).
- The sweeper is not built (SOR D14; errata 6).

Records carry a 30-day cleanup TTL only (`sendAttemptsRepo.ts:48`). Meanwhile
the promise expires or is withdrawn, so the bubble shows the Retry button
(`Timeline.tsx:1426`), and every press answers 409 `retry_pending`, which the
dashboard renders as "A retry is already scheduled for this message."
(`Timeline.tsx:134-135`) - false.

Section 1's "No third state" (live or withdrawn) is also false by the spec's own
R3 rows: "taken over ... untouched", "record-phase throw ... untouched", and
every strand leave `retry_due_at` merely expired.

**What it implies.** The failure cases this addendum exists for end in a thread
staff cannot retry for 30 days, with copy that lies. The guard needs a bound (for
example the record's own clock: refuse only while an attempt is fresher than a
horizon covering the reconcile schedule), or a named, visible "not confirmed"
outcome for a stale record.

---

## 6. [HIGH] R1's recipient key is missing from the owner type and derived from a live predicate at five read sites

**What is wrong.** R1 gives the owner as
`{ kind: 'retry_send'; conversationId; originalTsMsgId; attempt }` - no recipient
field - yet the record's sort key, `attemptKey` and the harness twin all take the
recipient from the owner (`sendAttemptsRepo.ts:163-181`;
`app/test/helpers/twilioWebhookHarness.ts:4409-4410`). R1 then defines the
recipient key as "the original's `recipient_contact_id` when that contact still
holds the thread's number (`contactHoldsPhone`), otherwise
`phone#<participantPhone>`". `contactHoldsPhone` is a live check of the
contact's current primary/secondary phones (`app/src/repos/contactsRepo.ts:376-378`).

That key is recomputed independently by: the first run's claim, a deferral
re-run's claim, a re-driven run's claim, the reconcile's resolve (R4), and the
manual route's `get` (R6, "one `get` per attempt number" - which cannot be
issued without re-deriving it, requiring conversation and contact reads R6 does
not mention). A contact edit inside the 15-minute window flips it:

- A re-run computes a new key, finds the record ABSENT and claims afresh
  (`attemptNo` 1, `redriveCount` 0): the single-deferral and single-re-drive
  bounds (`secondDeferralWouldClose`, `secondUnknownWouldClose`) reset, and the
  old record strands.
- The reconcile's hash no longer matches, so resolve is "not found" and the
  record stays `reconciling` (finding 5).
- The manual guard reads a different record and misses a live attempt.

The anchor issue states the record "keys on the ORIGINAL message and the retry
rung (not on a recipient of an owner)" (`docs/issues/retry-send-lost-under-job-marker.md`,
Suggested fix).

**What it implies.** Key the record on facts frozen when the chain started (the
original row's own fields, or a constant discriminator - a one-to-one thread has
one participant), so every reader derives the same key with no live read, and
put the field in the owner type.

---

## 7. [HIGH] "Forward-only" is specified as compare-to-the-read-value, so a terminal write can lose to a refresh

**What is wrong.** R3 defines WITHDRAW/REFRESH as ONE write "forward-only: never
over a `retry_due_at` that a LATER chain wrote - the write is conditioned on the
value the job read".

- There is no "later chain" for a row: a message fails once (`failed` and
  `undelivered` follow only `queued`/`sent`, `app/src/repos/messagesRepo.ts:133-142`),
  and only its own chain writes its `retry_due_at`. The real concurrency is
  between the job, a re-driven job and the reconcile on ONE row.
- Value-equality is not forward-only: a terminal write (WITHDRAW, or WITHDRAW +
  `unconfirmed`) LOSES to any refresh that landed after its writer's read.
- Concrete interleaving: R4 `never_sent` does "markRedriven, then
  `enqueueSendRetry(payload, runAt = now)` ..., REFRESH the promise to `runAt`"
  - the refresh AFTER the enqueue. The re-driven job reads the original at step 1
  with an EVENTUALLY consistent read (`retrySend.ts:174` ->
  `messagesRepo.ts:2164-2166`), possibly before or stale relative to that
  refresh. It claims, sends, the call times out (up to 30 s), and its
  second-unknown arm writes WITHDRAW + `unconfirmed` conditioned on the pre-
  refresh value: the condition fails. The record is `done`/`unresolved`, the
  promise stays live until `runAt + 2 min` then expires, and the bubble shows a
  live Retry on a text that may have gone out - the Q1 joint gap.
- `annotateMessage` is unconditional today (only `attribute_exists(tsMsgId)`,
  `messagesRepo.ts:3210-3232`), as is its harness twin
  (`twilioWebhookHarness.ts:1469-1474`). A conditional variant is a new repo
  method, interface member and twin that section 2 does not list. Nor does the
  spec say what a failed condition does (skip the emit? log?).

**What it implies.** State the order on promise STATES (live < withdrawn;
`unconfirmed` is terminal and always wins), not on read values; refresh before
enqueueing; read consistently (`getByProviderSidConsistent`,
`messagesRepo.ts:2462-2464`); and add the new write to scope.

---

## 8. [MEDIUM] The "unconfirmed" marking has no recovery from a crash or a failed write

**What is wrong.** SOR moved crash safety for the reconcile's own closes to the
superseded exit: a redelivered check that finds its record `done` re-applies the
close its outcome implies (`app/src/jobs/sendReconcile.ts:410-419`, via
`slotCloseOf`/`closeSlot`, `:921-955`; SOR errata 2). R4 defines no `retry_send`
arm for that re-application, so a reconcile that closes the record `unresolved`
and then fails its annotate (a genuine retry, D11) finds the record `done` on
redelivery and re-applies nothing: no WITHDRAW, no `unconfirmed`.

In the job, R3's second-unknown arm does not order its two writes. Record first
+ annotate through `guardWrite` (which swallows, `guardWrite.ts:16-29`) loses the
marking permanently: no reconcile will ever revisit a `done` record. The
broadcast analog writes the SLOT first and leaves the attempt open when that
fails (`app/src/jobs/broadcastFanOut.ts:782-811`).

**What it implies.** Specify the `retry_send` re-application in the superseded
exit, and "annotate first, record second" in the job's terminal arms.

---

## 9. [MEDIUM] Pre-claim declines on a re-driven job leave the record `redriven` forever

**What is wrong.** A re-driven job runs R2 from step 1. Its window check (step 4)
can decline (the re-drive was scheduled with 60 s grace; a queue backlog past
that fails the strict check), and step 1 can return (original gone / not
outbound). Both return BEFORE the claim, and the spec closes nothing. SOR D8's
rule - "A pre-claim decline ... that finds the record `redriven` ... moves the
record `redriven` -> `done` with the outcome `refused`" (SOR spec, D8,
lines 378-389; `closeRedriven`, `sendAttemptsRepo.ts:577-584`) - is not carried
into R2.

**What it implies.** The record strands in `redriven`; with R6 (finding 5) that
row is permanently un-retryable while R2 step 4 simultaneously WITHDRAWS the
promise "so the bubble stops promising" and shows Retry. R2 steps 1 and 4 must
close a `redriven` record `done`/`refused`.

---

## 10. [MEDIUM] `secondDeferralWouldClose = record.attemptNo >= 2` counts claims, not deferrals

**What is wrong.** Every claim increments `attemptNo`, including a claim from
`redriven` (`sendAttemptsRepo.ts:288`, `:434-436`). A rung whose first try went
unknown and was re-driven claims with `attemptNo` 2; if that re-driven send gets
a 429 - its FIRST deferral - R3 ends the chain with ERROR "retry deferred twice -
chain ended".

**What it implies.** A re-driven rung can never use its single deferral, and the
log line is false. The deferral count needs its own signal (for example a cause
or counter written by the deferral arm), not `attemptNo`.

---

## 11. [MEDIUM] The chain's own predecessors are same-fingerprint siblings

**What is wrong.** R4 says siblings include "a share to the same tenant inside the
window", as if that were the only case. But every rung of a chain resends the
same body with the same media count, from the same sender, to the same number,
so every earlier rung's record - and a share original's broadcast record - has
the same fingerprint and index partition. The lookup turns `never_sent` into
`unresolved same_fingerprint_sibling` when any same-fingerprint sibling within
`RECONCILE_SIBLING_SPAN_MS` (150 s, `app/src/lib/sendOutcome.ts:47`) is open or
`adopted` (`sendReconcile.ts:900-905`).

So an adopted rung N-1 (or an adopted share original) within 150 s makes rung
N's clean `never_sent` read "retry not confirmed" with Retry hidden, although
nothing went out. In the lane the backoff is 10 s for every rung
(`scripts/e2e-session.mjs:283`), so ANY multi-rung scenario is inside the span.

**What it implies.** Either state this as an accepted residue (a lost retry with
the Q1 marking), or exclude the chain's own lineage from the sibling set.

---

## 12. [MEDIUM] R7's `broadcast_id` on retry rows is not "as today": every retry-row receipt now runs the rollup's delayed miss path

**What is wrong.** R7 says a retry receipt "finds no slot ... and is ignored - as
today, but now once per retried share text".

- Today a retry row carries no `broadcast_id`, so the rollup never runs for it
  (`twilio.ts:3529`). After R7 it runs on every TRANSITIONED receipt: `sent`
  and the terminal one (`twilio.ts:3872-3878`) - per receipt, not per text.
- Each miss waits `statusRetryDelayMs` (2.5 s, `twilio.ts:322`) and re-reads
  the broadcast (`twilio.ts:3890-3906`) inside the webhook request, BEFORE the
  30003 arm runs (`twilio.ts:3560`).
- An unenumerated READER of `broadcast_id` is `isBroadcastRowFor`
  (`broadcastFanOut.ts:1296-1306`), used by the broadcast reconcile's `heldBy`
  (`sendReconcile.ts:595-603`) and by `adoptBroadcastRecipient`'s dedupe check
  (`broadcastFanOut.ts:1382-1393`). A retry row stamped with the share's id and
  no `recipient_contact_id` (the recipient moved off the number) now reads as
  "mine" for any recipient of that share on that thread.

**What it implies.** State the added latency and the rollup load, and walk
`isBroadcastRowFor` under retry rows (at minimum: a retry row is never a
broadcast recipient's own send), or narrow the stamp.

---

## 13. [MEDIUM] The claim's facts need reads R2 never lists, and their failure placement is unspecified

**What is wrong.** R1's facts and key need the conversation's
`participant_phone`, the configured business number (`sendMessage` derives
`from ?? config.businessPhoneNumber`, `sendMessage.ts:589`), and
`contactHoldsPhone` against that phone. R2 steps 1-4 read only the original, the
recorded recipient, the marker and a pure window check; the job has no
conversation read or config today (`retrySend.ts:131-150`). The spec does not
say where the conversation read goes: after the marker, a throw is lost (the
marker stands) with the promise left to expire. Nor does it say what happens
when the conversation is gone, is a group/relay thread, or has no participant
phone (the webhook decision fails OPEN on read errors, so these rows can reach
the job).

R2 also claims "steps 3-4 are one read and one pure check" - step 3 is a
conditional WRITE - and adds a NEW write to step 4 (the window-close withdrawal)
that is after the marker and outside `guardWrite`, so its throw is a lost job.

**What it implies.** List every pre-claim read with its placement relative to the
marker and its failure mode, and guard the step-4 withdrawal.

---

## 14. [MEDIUM] R3's enqueue-failure close contradicts SOR as built and is unwritable after a deferral

**What is wrong.** R3: an enqueue that throws closes the record "`done` /
`enqueue_failed` (`closeFromReconcile` with that outcome, or `finishAttempt` when
still attempting)".

- For a hand-off to reconcile (unknown / accepted), SOR as built closes
  `unresolved` with CAUSE `enqueue_failed` (`broadcastFanOut.ts:571-574`;
  `sendReconcile.ts:1047-1048`); SOR D13a reserves the `enqueue_failed`
  outcome for the post-`never_sent` case where "we know nothing went out". R3
  records a may-have-sent attempt as `enqueue_failed`, which Branch B consumes
  (R10) with the opposite meaning.
- For a deferral, R3's table already moved the record to `done`/`retryable`;
  `finishAttempt` needs `attempting` and `closeFromReconcile` needs
  `reconciling` (`sendAttemptsRepo.ts:489-510`, `:557-576`), so neither can
  write it unless the enqueue precedes `finishAttempt` - an order R3 never
  states.

**What it implies.** Use SOR's vocabulary (unresolved + cause for a may-have-
sent attempt), and order the deferral arm (enqueue, then release) explicitly.

---

## 15. [MEDIUM] Test and wiring surfaces are misnamed or missing

**What is wrong.**

- Section 4 puts the unit tests in `app/test/retrySend.test.ts` "the file's real
  fixtures". That file does not exist. The job's tests live in
  `app/test/twilioStatusWebhook.test.ts` (19 `registerRetrySendJobHandler`
  registrations, e.g. `:1271`, `:1330`, `:1371`, `:1459`) and
  `app/test/retrySendBackoff.test.ts`.
- Those registrations inject no send-attempt repo. With a lazy default (the
  job's pattern, `retrySend.ts:152-172`) each would construct the REAL
  DynamoDB-backed repo inside a fake-world unit test. `RetrySendJobDeps` needs
  `sendAttemptsRepo` (and config for the sender), and every existing
  registration must pass the harness's.
- The manual route needs a send-attempt repo in the API router's deps (today:
  `app/src/routes/api.ts` deps block around `:291-312`, repos built at
  `:565-592`) and in its tests.
- Harness twins: `attemptRecipientKey` (`twilioWebhookHarness.ts:4409-4410`),
  `annotateMessage` (`:1469-1474`), and the harness append allowlist
  (`:1225-1242`) for any new append-time field.
- The dashboard maps 409 codes in `sendFailureMessage`
  (`Timeline.tsx:88-139`); `retry_unresolved` has no arm, so a stale tab reads
  "Couldn't send - please try again." - an invitation to press again on the one
  message Q1 says to compose fresh for. The spec names no copy.
- `e2e/support/selectors.md` documents the 30003 prose family (RSW D12); the
  new copy is not listed.

**What it implies.** The plan will be written against a file that does not
exist and will miss the fake-world wiring that keeps these tests hermetic.

---

## 16. [LOW] The record-phase row contradicts its own order

R2 step 8 orders "`finishAttempt(sent, sid)`; withdraw". R3's record-phase row
says a throw of "the `finishAttempt` or the withdrawal" moves the record to
`reconciling` WITH the SID. After `finishAttempt(sent)` wins, `handToReconcile`'s
fence (`state = attempting`, `sendAttemptsRepo.ts:512-531`) fails, so a
withdrawal throw cannot be handed off, and "a lost hand-off leaves
`attempting`" is wrong for that case. A failed withdrawal is also cosmetic (the
collapse hides the original) and should not raise a `sent_unrecorded` ERROR.

---

## 17. [LOW] `one-to-one-retry-promise-outlives-job-decline` is already closed as accepted

R3 and section 5 "close" it, but its frontmatter is `status: wontfix`,
`resolved: 2026-09-26`, with Cameron's "accepted." as the ruling
(`docs/issues/one-to-one-retry-promise-outlives-job-decline.md:5-17`). Changing
the behavior he accepted as-is may be fine, but the spec should say it reverses
that ruling rather than describe the issue as open.

---

## 18. [LOW] Dangling references and imprecise field lists

- "SOR's `statusFor`" (R4): no such function exists; the mapping is
  `mapTwilioStatus` (`sendReconcile.ts:661`).
- `retryFitsSendWindow({ originMs, runAt })` (R3, R4): the helper takes
  `{ originMs, nowMs, backoffMs }` and adds `RETRY_JOB_GRACE_MS`
  (`app/src/lib/retrySendWindow.ts:74-80`). The spec also never says what a
  deferral or re-drive does when the origin is missing (RSW D5 fails OPEN).
- "RSW B4" / "RSW B5" exist only in
  `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handoffs/rsw-relay-2026-09-26.md`,
  which the spec never names; the RSW spec has no B-numbered items.
- R4's adopted-row field list omits `type`, `transportSchemaVersion` and
  `requestedTransport`, which the broadcast adoption writes
  (`broadcastFanOut.ts:1363-1377`) and the webhook's transport path reads
  (`twilio.ts:3430-3476`); "`author` = the original's" diverges from the job's
  own mapping `original.author === 'ai' ? 'ai' : 'teammate'`
  (`retrySend.ts:323`; `MessageAuthor` includes `system`, `messagesRepo.ts:110`).
- R6 reads "attempts 1..3" for a row, but only `(row.retry_attempt ?? 0) + 1`
  can key on it (finding 1's chain).
- Test 15's "mirror test pins ... the copy to the app constants": the copy is
  dashboard-only; there is no app constant to pin it to (the value to mirror is
  `'unconfirmed'`).
- Section 1 guarantee 1 says a redelivered job "meet[s] the record"; it meets
  the marker (test 6 says so).
