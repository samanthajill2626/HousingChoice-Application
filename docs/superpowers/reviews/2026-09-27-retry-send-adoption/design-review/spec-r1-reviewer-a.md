# Retry-send adoption spec, revision 1 - adversarial design review (reviewer A)

Spec under review: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`
(revision 1, commit 034912bb). Read on top of SOR revision 12 (section 12 errata,
D1-D23) and RSW sections 2-5. Code read at `main@3dbb5740` in
`W:\tmp\retry-send-adoption`. Every file:line below was read; anything not
verified is marked UNVERIFIED.

Summary: 15 findings - 1 BLOCKING, 3 HIGH, 6 MEDIUM, 5 LOW.

---

## 1. [BLOCKING] "The ORIGINAL" names two different rows, and the spec's decisions require both

**What is wrong.** The spec never defines "the original". The code, and the
parts of the spec that describe the job, mean the row the payload names - the
attempt that JUST failed, which is a retry row for attempts 2 and 3. Other
decisions only hold if "the original" is the chain's FIRST message (the root).
No build can satisfy both.

**Evidence - the parent reading (what the code does and R1/R2/R4 inherit):**
- The webhook enqueues `messaging.retrySend` with `providerSid: MessageSid` - the
  SID of the row whose callback just failed (`app/src/routes/webhooks/twilio.ts:3624-3631`),
  and `attempt = (message.retry_attempt ?? 0) + 1` from that same row
  (`app/src/services/oneToOneRetryDecision.ts:125-129`).
- The job reads "the original" by that SID (`app/src/jobs/retrySend.ts:174`) and
  appends `retryOf: original.tsMsgId` (`retrySend.ts:325`). RSW D2: "`retry_of`
  points only at the previous attempt".
- The existing suite drives exactly this: "The original is itself attempt 1 of a
  chain" with payload attempt 2 (`app/test/twilioStatusWebhook.test.ts:1866-1890`).
- The Timeline's retry collapse hides every row some other row names in
  `retry_of` (`dashboard/src/routes/contact/Timeline.tsx:2062-2075`): the visible
  bubble is always the chain's TAIL.
- R2 step 1 ("Read the original by provider SID (as today)"), R4 Adopt
  (`retryOf: originalTsMsgId`), and Q2's own "walking `retry_of` to the
  original's `tsMsgId`" (multi-hop) all assume the parent.

**Evidence - the root reading (what other decisions assume):**
- R5: `retry_outcome` is written on "the FAILED one-to-one original ... Never on
  a retry row". Under the parent reading, R4's `unresolved` close for attempt 2
  writes it on retry row 1 - a retry row.
- R6: "Any `retry_send` attempt record for this original (attempts 1..3)". Under
  the parent reading exactly one attempt number (parent.retry_attempt + 1) can
  exist per original; the enumeration only makes sense if all three rungs key on
  one root.
- R10 (the contract Branch B builds on): "On the original after the chain ends:
  `retry_due_at` withdrawn ... and, for an unresolved retry, `retry_outcome:
  'unconfirmed'`". Branch B starts from the broadcast slot, which names the ROOT
  (`app/src/jobs/broadcastFanOut.ts:941-947`). Under the parent reading an
  unresolved attempt 2 leaves the root with a withdrawn promise and NO
  `retry_outcome`; the marker sits on retry row 1. There is no forward pointer
  from root to child, and an unresolved retry produces no provider receipt for
  B's rollup to walk back from. B cannot learn the chain's final state from what
  R10 promises.
- Section 1: "withdrawn (the chain is over: delivered by a retry row, ...)". R2
  step 8 withdraws the parent's promise when the retry is SENT, while the chain
  may continue on the retry row. "Withdrawn" does not mean "chain over" on the
  root.
- R5 also says "never on relay or broadcast rows". A share's one-to-one message
  carries `broadcast_id` (`sendMessage.ts:658`); a builder who reads it as a
  "broadcast row" skips `retry_outcome` for exactly the share recipients Q1 and
  Branch B are about.

**What it implies.** A builder must choose before writing code. Choosing the
parent keeps today's lineage and the Timeline collapse working, but it breaks
R5's exclusion, makes R6's three gets two wasted reads, and makes R10
undeliverable for attempts 2-3. Choosing the root changes what `retry_of`
means, so the collapse would leave retry row 1 visible beside retry row 2. It
also breaks RSW D2, and the webhook payload does not carry the root. The spec
must: define "the original" as the row the payload names; restate R5 ("the
chain's tail row: the original for attempt 1, a retry row for attempts 2-3");
make R6 a single read; and give Branch B a way to find a chain's final state.
Two candidates for that last point: B reads the attempt records via
`listByRecipient`, or the final state is stamped on the root.

---

## 2. [HIGH] R6 reads the record; it does not claim it. Gaps 1 and 5 stay open, and the read needs a key the route cannot reliably derive

**What is wrong.** The decision's title is "the manual Retry route CLAIMS the
same record", but its body only reads records ("reads three records at most
(one `get` per attempt number)"). With a read-only guard nothing is mutually
exclusive. The guard refuses only a press that lands while the job sits
between its claim and its terminal write, which is seconds.

**Evidence.**
- Route today: reads the row, checks status and the time guard, sends
  (`app/src/routes/api.ts:1574-1611`, send at `:1676-1688`). R6 adds reads only.
- Gap 5 as a concrete interleaving. The webhook's enqueue throws after SQS
  accepted, and the webhook withdraws the promise at once
  (`twilio.ts:3638-3647`). Staff press Retry at t: the promise is withdrawn and
  no record exists yet (the job runs at runAt, 60 s or more later), so the route
  sends M. At runAt the job claims an absent record, gets `claimed`, and sends.
  The tenant gets two texts. Gap 1 (the promise expired before a late job
  claimed) follows the same sequence.
- TOCTOU. The route reads "no record" at t, the job claims at t+e and sends, and
  the route sends at t+2e.
- The issue's own suggested fix is a claim, not a read: "have the manual retry
  route claim against the same record, so whichever of the two sends second finds
  the claim taken and refuses" (`docs/issues/manual-retry-double-send-residual-windows.md`,
  Suggested fix).
- A `get` needs the record's full key: the partition is `sendattempt#<ownerKey>`
  and the sort key is `hashRecipientKey(recipientKeyOf(owner))`
  (`app/src/repos/sendAttemptsRepo.ts:163-181`). The route would have to
  re-derive R1's recipient key (the contact if it still holds the thread's
  number, else `phone#<participantPhone>`). It reads the contact
  (`api.ts:1619-1629`) but not the conversation's participant phone. Any
  divergence from what the job derived at claim time makes the `get` miss, and a
  miss lets the press through (see finding 7).

**What it implies.** Section 5's "closes gaps 1, 2, 4, 5" rests on this guard,
and for gaps 1 and 5 the guard covers only an incidental sliver. A fix that
closes them and stays inside Cameron's ruling 4 (a double text is preferred to
none): the route takes the rung's record itself. For attempt
`original.retry_attempt + 1` it creates or transitions the record to `done`,
outcome `refused`, cause `manual_retry`, conditional on the record being absent
or `done`/`retryable`, and refuses on attempting/reconciling/redriven. The
job's later claim is then refused and it sends nothing, while the manual text
still goes out. Alternatively the job refuses when a manual retry row
(`retry_of === original.tsMsgId`, no `retry_attempt`) exists. Either way the
lookup should Query the owner's partition rather than `get` a derived sort key.

---

## 3. [HIGH] Keeping the run-once marker ahead of the claim disables the record's only crash recovery, and leaves throw-after-marker losses in steps 3-5

**What is wrong.** Section 2 says the marker "STAYS in `retrySend` (R2) - it is
cheap and the record makes it redundant, not wrong". It is not harmless. For a
`retry_send` record, the SQS redelivery is the only later claimant that could
take over a stranded attempt, and the marker suppresses exactly that
redelivery. R12's recovery statement therefore has no mechanism behind it.

**Evidence.**
- A throwing handler is redelivered after the 120 s visibility timeout
  (`app/src/adapters/sqsJobConsumer.ts:11-17`). The redelivery carries the same
  jobId and returns at the marker (`retrySend.ts:210-219`).
- A takeover happens only when a later claim meets an `attempting` record older
  than 30 s (`sendAttemptsRepo.ts:440-444`, `SEND_CLAIM_TTL_MS`
  `app/src/lib/sendOutcome.ts:29`). The only claimants for one (original,
  attempt) record are:
  - a deferral re-run, which needs `done`/`retryable`;
  - a re-drive, which needs `redriven`;
  - the SQS redelivery, which the marker suppresses.

  A job that dies between its claim and its terminal write therefore leaves
  `attempting` forever. R12 says "a stranded retry attempt IS taken over by the
  re-driven or re-scheduled rung's claim when one runs", but no such rung is ever
  scheduled for a stranded attempt. (The next rung is a different owner:
  parent = the retry row.)
- The death case is rare but real. Graceful stop drains in-flight handlers
  (`sqsJobConsumer.ts:93-97`), so this needs a hard death: SIGKILL after the
  stop timeout during a 30 s provider call, OOM, or host loss. The consequence
  is silent (finding 5).
- R2 wraps only steps 6-8 in the outer try. For steps 1-4 it says a throw
  "keeps today's behavior ... steps 3-4 are one read and one pure check".
  Step 5 is not addressed, but the claim can throw after the marker:
  `writeClaim` rethrows TransactionConflict and throttles
  (`sendAttemptsRepo.ts:367-376`), and `mustGet` throws (`:329-335`). Step 4 now
  also writes (the new withdrawal).
- R1's facts need the participant phone and the sender. Today `sendMessage`
  computes them after its own gates (`sendMessage.ts:475`, `:589`, `:606-614`).
  The claim precedes `sendMessage`, so the job must read the conversation
  first, and R2 does not place that read. If it lands after the marker, its
  throw loses the rung. That is the anchor issue's shape
  (`retry-send-lost-under-job-marker`) re-created by the fix.
- Guarantee 1 says "a redelivered job ... meet[s] the record and stop[s]". With
  the marker kept, a redelivered job meets the marker, not the record.

**What it implies.** The addendum does not fully close its own anchor issue,
and every hard death after the claim becomes a permanent strand. Given the
claim (D8a), removing the marker from `retrySend` (or moving it after the
record's terminal write) is safe:
- A redelivery after a terminal outcome is refused `!fresh`.
- A redelivery during a live attempt is refused `fresh`.
- A redelivery after the TTL takes the attempt over into reconcile, because
  the 120 s visibility timeout exceeds the 30 s TTL.
- The in-process lane never redelivers.

The marker call is in `retrySend.ts`, so this does not touch the fenced
`jobs.ts`. If the marker stays, the spec must say so honestly: R12 must drop
its recovery claim, and the step-3-to-5 window plus the conversation read must
be named as residues.

---

## 4. [HIGH] Q1's "NO Retry button" rests on a best-effort write; the record, which is authoritative, is ignored

**What is wrong.** Cameron's Q1 ruling is enforced only by `retry_outcome:
'unconfirmed'` on the row. That write can be lost in three ways the spec does
not close:
- R6 refuses only `attempting` / `reconciling` / `redriven`, not a `done` record
  whose outcome is `unresolved`.
- R2 puts every failure-arm write through `guardWrite`, which logs and swallows
  (`app/src/lib/guardWrite.ts`). So R3's second-unknown arm (record closed
  `done`/`unresolved`, then WITHDRAW plus `retry_outcome`) can lose the annotate
  and still return.
- In the reconcile, the job closes the record FIRST (`sendReconcile.ts:1003-1017`).
  The only crash safety for the follow-up write is the superseded-exit re-apply
  (`sendReconcile.ts:405-420`, `slotCloseOf` `:922-933`, `closeSlot` `:936-955`).
  R4 never says that this owner's "slot close" is the `retry_outcome` annotate.
  `closeSlot`'s switch has no default, so a missing arm is a silent no-op. And
  on the lane a delayed in-process dispatch is never redelivered
  (`sendReconcile.ts:16-17`).

**Concrete sequence.** A re-driven rung comes back unknown. The job closes the
record `done`/`unresolved` and the annotate throws (swallowed). The promise,
last refreshed to the re-drive's run time, expires two minutes later. The
bubble reads a plain failure with Retry (`Timeline.tsx:1426`). The route finds
no `retry_outcome` and a `done` record, and answers 200. A second text goes out
after one that may already have been delivered.

**What it implies.** Make the record authoritative. R6 should also refuse a
`done` record whose outcome is `unresolved`, or `enqueue_failed` on the
unknown/accepted paths (distinguished by cause). `retry_outcome` should be the
display only. R4 must name the re-apply mapping for this owner: `unresolved`
re-writes withdraw + unconfirmed, and `redrive_refused`/`enqueue_failed`
re-write the withdrawal.

---

## 5. [MEDIUM] R6's guard has no staleness bound: a stranded or dead-lettered record locks manual Retry for up to 30 days behind a false message; section 1's "No third state" does not hold

**What is wrong.** R6 answers 409 `retry_pending` for any `attempting` /
`reconciling` / `redriven` record, however old. Several paths strand a record
in those states. Meanwhile the promise has been refreshed only to cover the
nominal schedule, so it expires.

**Evidence.**
- Strand producers the spec itself names or implies:
  - R3's record-phase row: "a lost hand-off leaves `attempting` (stranded)".
  - Finding 3's hard death.
  - R4 Resolve: "Not found -> INFO, the record is left for the sweeper" (the
    record stays `reconciling`; `sendReconcile.ts:387-397`).
  - A reconcile check that throws five times dead-letters (SOR D11) and leaves
    `reconciling`.
  - Finding 6's stuck `redriven`.
  - The sweeper is not built (`docs/issues/send-attempt-sweeper.md`, open).
- Records live until the 30-day cleanup TTL (`sendAttemptsRepo.ts:48`).
- On screen: the refresh covers `attemptedAt + delays[2] + grace` only (R3), so
  the bubble falls back to a plain failure and shows Retry
  (`Timeline.tsx:1426`). Every press gets 409, which the dashboard renders as
  "A retry is already scheduled for this message." (`Timeline.tsx:134-135`).
  That is false, and it holds for up to 30 days.
- Section 1: "its `retry_due_at` is either live ... or withdrawn ... No third
  state." The spec's own R3 rows leave the promise "untouched" (the record-phase
  throw and the taken-over path), so expired-not-withdrawn is a third state. So
  is a crash between the deferral's release (`done`/`retryable`) and its
  re-enqueue. That leaves a rung that is neither pending nor terminal, and it is
  not one of the strand classes the sweeper issue lists.

**What it implies.** Guarantee 2 ("every retry rung reaches a terminal state
that staff can see") does not hold for strands. The spec should decide what
staff see. One option: once a pending record is older than its schedule, R6
answers `retry_unresolved` and the bubble reads "retry not confirmed"
(consistent with Q1). At minimum, name the strand as a residue with its copy,
rather than claiming no third state exists.

---

## 6. [MEDIUM] R4's `never_sent` path is mis-sequenced and partly unreachable, and a re-driven run's pre-claim declines never close the `redriven` record

**Evidence.**
- R4 orders: "`markRedriven`, then `enqueueSendRetry(...)` if
  `retryFitsSendWindow(...)` ... Outside the window ...: `closeFromReconcile`
  `redrive_refused`". `markRedriven` moves `reconciling` to `redriven`
  (`sendAttemptsRepo.ts:550-556`), and `closeFromReconcile` is fenced on
  `#st = :reconciling` (`:557-560`). Read literally, the close loses its
  condition and the record strands `redriven`. As built, `redrive()` runs its
  refusal checks BEFORE `markRedriven` (`sendReconcile.ts:1177-1182`).
- `original_missing` cannot occur there: Resolve already exits on a missing
  original before any verdict (R4 Resolve; `sendReconcile.ts:387-397`).
- "the conversation closed" is not a one-to-one state: "1:1 threads only ever
  write `open`" (`app/src/repos/conversationsRepo.ts:140-141`).
- SOR D8: "A `redriven` record belongs to whichever pass reaches it ... a
  pre-claim decline ... moves the record `redriven` -> `done` / `refused`".
  R2's pre-claim exits also run on a re-driven job: step 1 (original missing or
  not outbound) and step 4 (window closed, possible if the queue delays the
  run-now re-drive past the strict check). R2 and test 8 say these exits write
  no record. The `redriven` record then stays forever, and R6 refuses for 30
  days (finding 5).

**What it implies.** Put the window check in `redriveRefusal`'s position
(before `markRedriven`). Drop `original_missing` and "conversation closed", or
say where they can be detected. Have R2's steps 1 and 4 close a `redriven`
record `done`/`refused` (`closeRedriven`).

---

## 7. [MEDIUM] The record's identity is derived from mutable state at every read; drift forks the chain or strands it, and R1's owner type cannot build the key

**What is wrong.** R1 keys the record's recipient on "the original's
`recipient_contact_id` when that contact still holds the thread's number
(`contactHoldsPhone`), otherwise `phone#<participantPhone>`". That key is
re-derived from live data by:
- the first claim;
- the deferral re-run's claim;
- the re-driven job's claim;
- the reconcile's Resolve ("the recipient = the original's
  `recipient_contact_id` while it holds the number, else the phone key");
- R6's read.

**Evidence.**
- The sort key hashes a field ON THE OWNER (`recipientKeyOf` reads
  `contactKey`/`memberKey`, `sendAttemptsRepo.ts:163-181`). R1's owner type
  `{ kind: 'retry_send'; conversationId; originalTsMsgId; attempt }` has no
  recipient field, so it cannot produce a record key as written.
- `contactHoldsPhone` depends on the contact's current phones and on the
  contact still existing (`retrySend.ts:190-201`, `sendMessage.ts:488-495`).
- Suppose the answer changes between two derivations (the contact edits their
  number, or is deleted):
  - A re-claim creates a NEW record (absent, then `claimed`, `attemptNo` 1,
    `redriveCount` 0). The "single deferral" and "one re-drive" budgets reset,
    and the old record is orphaned. A `redriven` orphan locks R6.
  - Resolve derives a key whose hash is not the payload's `recipientKeyHash`.
    It returns not-found, the chain ends without a verdict, and the record stays
    `reconciling`.
- The relay owners do not re-derive. They match candidate keys against the
  payload's hash (`sendReconcile.ts:486-494`).
- R4's "a conversation whose participant phone changed -> `unresolved`
  `digest_mismatch`" is unreachable for a phone-keyed recipient: the key changes
  with the phone, so Resolve fails first.

**What it implies.** A one-to-one thread has exactly one recipient. Key the
record on something that cannot drift: the conversation's participant phone,
or a constant. Resolve by hash-matching candidates, have R6 query the owner
partition, and add the recipient field to R1's owner type.

---

## 8. [MEDIUM] `secondDeferralWouldClose = attemptNo >= 2` counts a re-drive (and a takeover) as a deferral

**Evidence.**
- R2 step 5: `secondDeferralWouldClose = record.attemptNo >= 2` ("this claim was
  already the re-claim after a deferral").
- Every claim sets `attemptNo = prev + 1`, including the claim from `redriven`
  (`sendAttemptsRepo.ts:288`, `:309-315`). `takeOver` keeps `attemptNo`
  (`:534-540`), so the re-drive that follows a takeover is also attempt 2.
- Sequence: unknown, then `never_sent`, then a re-drive that claims `attemptNo`
  2, then the provider answers 429. The chain ends with ERROR "retry deferred
  twice - chain ended", but the rung was never deferred. Section 1 promises "a
  deferred retry re-schedules itself inside the 15-minute window". Test 4 starts
  from a deferral, so it cannot catch this.

**What it implies.** Record the deferral itself, for example by treating only a
claim from `done`/`retryable` as the re-claim after a deferral, or by adding a
deferral counter. Otherwise state that a re-drive consumes the rung's deferral.

---

## 9. [MEDIUM] R4 enumerates 8 of the reconcile's owner-dispatch sites; the unlisted ones fail silently for a fourth kind

**Evidence.** `sendReconcile.ts` dispatches on the owner kind at:
- `toOwnerRef` 126-145, `parseOwnerRef` 174-198;
- `ownerRefLog` 363-372, `ownerLog` 375-384;
- `resolve` 473-507, `currentPhone` 516-535;
- `heldBy` 577-611, whose non-broadcast branch assumes relay through
  `relayRowKey`, typed `Exclude<SendAttemptOwner, broadcast>` (280-282);
- `adopt` 614-635;
- `slotCloseOf` 922-933, `closeSlot` 936-955, `afterClose` 967-993;
- `enqueueRedrive` 1078-1115, `redriveRefusal` 1123-1130.

R4 names Resolve, the digest, Lookup, heldBy, Adopt, never_sent, unresolved and
afterClose. The strict tsconfig has no exhaustiveness check
(`tsconfig.base.json`), so some misses compile:
- `closeSlot` (void, no default) becomes a silent no-op, which breaks finding
  4's re-apply.
- `redriveRefusal` returns `undefined` only for broadcast, then applies the
  relay rules. A one-to-one conversation is `open`, but `rosterMember` finds no
  member, so it answers `member_removed`. Every `retry_send` `never_sent` would
  close `redrive_refused` and never re-drive.
- `enqueueRedrive` needs the original's `providerSid` for the
  `RetrySendPayload`, which the owner ref does not carry.

**What it implies.** List every site with its `retry_send` answer, or require a
`never` default in each switch.

---

## 10. [MEDIUM] Section 5 and R6 misstate the issue ledger: wrong gap numbers, a reversed human decision, and a false "already named"

**Evidence.**
- R6 and section 5 close "gaps 1 (the job runs later than promised), 2 (a
  deferral) and 5 ... and gap 4". Gap 3 "stays as filed". In the issue
  (`docs/issues/manual-retry-double-send-residual-windows.md:28-45`):
  - Gap 2 is "a stale browser tab retrying ... an original that an automatic
    retry has already replaced".
  - Gap 3 is "a one-to-one retry whose outcome is still pending past
    `retry_due_at` (for example an `unknown` send outcome awaiting reconcile
    checks)". R3's refresh and R6's `reconciling` guard exist exactly for gap 3,
    and the issue says "Gaps 3 and 4 belong to reconcile's `retrySend` adoption"
    (`:67`).
- R2 step 8 withdraws a replaced original's promise the moment the retry sends.
  That REMOVES the server refusal the issue credits for gap 2 ("before the
  promise expires the route refuses that press"). The record is `done`/`sent`,
  which R6 does not refuse, so gap 2 widens rather than closes. Gaps 1 and 5:
  see finding 2.
- `docs/issues/one-to-one-retry-promise-outlives-job-decline.md` is
  `status: wontfix`, `resolved: 2026-09-26`, and reads "ACCEPTED as-is (Cameron,
  2026-09-26)" (`:6`, `:9`, `:13`). The spec lists it under "Closes at merge"
  and says R3's refused row "Closes" it. That reverses an explicit human
  acceptance. The only rulings the spec cites are Q1 and Q2.
- Section 2 says the manual route's own send path is something "SOR's Stage 2
  list already names". SOR section 9's Stage 2 list (spec lines 968-975) names
  `call.missedAutoText`, the tour reminder poll, the placement nudge poll,
  `relay.intro` and `relay.memberAdded`. It does not name the manual route, and
  the SOR spec never mentions a manual/staff Retry route at all.

**What it implies.** At merge the ledger would mark as closed gaps that remain
open, and leave open the one gap the addendum targets. The R3 withdrawal on
refusal needs a cited ruling from Cameron, or it should be dropped. The manual
route's own ambiguous-send exposure currently has no owner.

---

## 11. [LOW] R3's "forward-only" withdrawal needs a conditional `annotateMessage` the spec does not scope, and its stated reason cannot occur

**Evidence.**
- `annotateMessage` is unconditional apart from `attribute_exists(tsMsgId)`
  (`app/src/repos/messagesRepo.ts:3210-3232`). The fenced webhook calls it for
  its own withdrawal (`twilio.ts:3639-3641`). The harness keeps a copy
  (`app/test/helpers/twilioWebhookHarness.ts:1469`).
- The reason given, "never over a `retry_due_at` that a LATER chain wrote",
  cannot happen. A row fails only once, because terminal statuses never
  transition again (`messagesRepo.ts:133-140`), so no second chain writes the
  same row's `retry_due_at`.
- The race that does exist is a re-driven job's step-8 withdrawal against the
  reconcile's post-enqueue refresh.
- The loser's behavior is not stated. A `ConditionalCheckFailedException` under
  `guardWrite` logs an alarm-feeding ERROR ("failure-arm write failed") for a
  benign race. In the reconcile it is a throw, which means a genuine retry.

**What it implies.** Scope an optional condition on `annotateMessage`, keep the
webhook's call unconditional, give the real race as the reason, and say that
the loser logs INFO and moves on.

---

## 12. [LOW] R3's record-phase row cannot happen for a withdrawal that throws after `finishAttempt(sent)`, and would log a false `sent_unrecorded`

**Evidence.** R2 step 8 runs `finishAttempt(sent)` and THEN the withdrawal,
inside the phase-tracked try. `handToReconcile` is fenced on `#st = :attempting`
(`sendAttemptsRepo.ts:512-531`), so after the record is `done` the stated
"`reconciling` WITH the SID" transition fails. The line would still be the
ERROR `sent_unrecorded`, about a send that was recorded. SOR D7a's record phase
covers writes that receipts depend on, with `finishAttempt` last
(`broadcastFanOut.ts:940-957`). The withdrawal is cosmetic.

**What it implies.** Move the withdrawal and its emit after the record phase,
as best-effort writes that are never classified.

---

## 13. [LOW] R7 is not "as today", and `isBroadcastRowFor` is an unenumerated reader of the new stamp

**Evidence.**
- Today the rollup runs only for rows that carry `broadcast_id`
  (`twilio.ts:3529-3545`), so it never runs for a retry row. After R7 it runs
  for every transitioned receipt of a share-retry row, including `sent`
  (`:3878`). Each run reads the broadcast, sleeps `STATUS_UNKNOWN_SID_RETRY_DELAY_MS`
  = 2.5 s (`:322`, `:3898`), and reads it again. That is not "once per retried
  share text".
- The rollup runs before the 30003 arm (`:3560`), so each next-rung enqueue for
  a share retry waits 2.5 s. The runAt is absolute, so the schedule holds.
- `isBroadcastRowFor` (`broadcastFanOut.ts:1296-1306`) calls a row "mine" when
  it carries the share's `broadcast_id` and has no `recipient_contact_id`. A
  share-retry row whose contact no longer holds the number therefore reads as
  "mine" to ANY recipient of that share in the broadcast owner's `heldBy`
  (`sendReconcile.ts:595-603`). A `mine` verdict skips the fingerprint match
  (`:866`). This is reachable only for two contacts on one phone in one share,
  inside a reconcile window.

**What it implies.** Correct R7's description, and name the rollup's cost and
the `isBroadcastRowFor` reader so Branch B and the reviewers check them.

---

## 14. [LOW] The test plan names a file that does not exist; the real suite pins a shape R2 step 8 breaks

**Evidence.**
- Section 4 says "Unit (`app/test/retrySend.test.ts`, the fake world; the
  file's real fixtures)". That file does not exist and never has (`git log
  --all` on the path is empty).
- The handler's tests are the `messaging.retrySend job (worker side)` block in
  `app/test/twilioStatusWebhook.test.ts` (`:1220` onward). One of them asserts
  `expect(annotates).toBe(0)` after a successful retry (`:1855-1897`, "nothing
  is annotated after the send"). R2 step 8's withdrawal annotate breaks it.

**What it implies.** Name the real file, and say that the D6 pin must count
lineage annotates only, not every annotate.

---

## 15. [LOW] Citation and wording errors a stand-alone builder will trip on

- R4 cites "SOR's `statusFor`"; no such function exists. Adoption maps with
  `mapTwilioStatus` (`sendReconcile.ts:629`, `:661`; `broadcastFanOut.ts:1360`).
- R3's rejected row lists "the kill switch". Through `sendMessage`, the kill
  switch is `SmsSendingDisabledError extends SendRefusedError`
  (`sendMessage.ts:107`, `:460-463`), so it lands on the refused row.
- `retryFitsSendWindow` takes `{ originMs, nowMs, backoffMs }`
  (`app/src/lib/retrySendWindow.ts:73-79`), not `{ originMs, runAt }`.
  Behavior with no usable origin (RSW D5 fail-open, `retrySend.ts:239-243`) is
  unstated for the deferral and the re-drive.
- "RSW B4" and "RSW B5" are items in a review handoff
  (`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handoffs/rsw-relay-2026-09-26.md:57-68`),
  not the RSW spec. B5 says nothing about the post-send 2-minute expiry that R2
  step 8 says it "accepts".
- Test 18 checks "exactly one ERROR in the worker log". With no
  `JOBS_QUEUE_URL`, `retrySend` and its reconcile run in-process in the APP,
  where the webhook enqueued them (`retrySend.ts:99-103`). The SOR spec reads
  the app's tail with `readLogTail`
  (`e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:225-243`).
- The new 409 `retry_unresolved` has no copy in `sendFailureMessage`
  (`Timeline.tsx:88-138`), so it reads "Couldn't send - please try again". That
  is the invitation to press again that the `retry_pending` case was written to
  avoid (`:130-135`). Section 2 does not list it.
- R5 says `retry_outcome` is "written only by R3's second-unknown arm and R4's
  `unresolved` close", which omits R3's enqueue-failure close. R3 says that
  close writes it too.
- R1's media-count rule ("re-presigned attachments, else the raw `mediaUrls`
  count") disagrees with the job on the no-MediaStore path. There the job sends
  NO media (`retrySend.ts:286-298`), but the rule yields the stored `mediaUrls`
  count, so the reconcile can never match that retry.
- When a share was ADOPTED and its 30003 arrives within about 90 s, the share's
  own broadcast record is an open-or-adopted, same-fingerprint sibling of its
  retry: the sibling span is 150 s (`sendOutcome.ts:47`, `sendReconcile.ts:903-905`).
  That retry is therefore never re-driven, only ruled `unresolved`. The lane's
  10 s backoff makes this the default there for chained adoptions. Test 12
  frames the case only as a "sibling share". This fails safe, but it is
  unstated.
