# Code review round 1 - spec conformance (retry-send adoption)

Reviewer: the spec-conformance reviewer (round 1), Claude Opus 5.5 (1M context),
2026-09-28. Branch `feat/retry-send-adoption`, worktree
`W:\tmp\retry-send-adoption`, HEAD `6c82058c`, merge base `3dbb5740` (main has
not moved). Read-only on source: every mutation below was restored
byte-identical (`cmp` against a backup, then `git diff --stat` empty).

Contract read: spec revision 5 (sections 0-7) on SOR revision 12 section 12;
plan revision 4 (its nine declared deviations, Global Constraints, Review
Focus, Tasks 1-8); the build worklist (27 items, item 24 = deviation 10); the
S1-S5 slice reports (treated as claims and checked against the code).

## Verdict

The build conforms to the approved contract on every decision's main path. Every
spec section 0 ruling is in the code: the two names, the root walk, Q1, the Q2
fence (twilio.ts 1+/1-), Branch B's `retry_root` + `broadcast_id` on all three
appends, and no early withdrawal. The same holds for R1-R12 and for every spec
section 4 item, each proven by a named test. Of 31 mutation runs (section 3),
28 went red. The other 3 were diagnostic and stayed green as expected: M3a
exposes the test gap C-3, and M7b and M7d show one of two redundant belts
removed on its own (C-8). The ten declared deviations match the code, are
justified, and are the least surprising choices.

No BLOCKING or HIGH finding. Two MED findings, both on fault paths (a thrown
DynamoDB write). Neither can cause a double text or a lost send:

- C-1: a re-driven attempt's pre-claim decline swallows a thrown close. This
  breaks R2's pre-claim throw rule and Review Focus 5.
- C-2: a failed WITHDRAW is never re-applied. Q1's display half and R4's crash
  safety do not hold under a write fault.

There are also three LOW findings (one test gap, two log-line texts) and five
NOTEs for the handback. Task 9 items (issue notes, self-QA, drift, gates,
handback; worklist 25-27) are PENDING, not failed.

Environment note: another reviewer worked in this worktree at the same time.

- Its untracked `app/test/zzAdvThrowaway.test.ts` was present mid-review, left
  untouched by this reviewer, and later removed by its owner.
- Its report `code-review/r1-adversarial.md` is its own.
- Once the other reviewer was spotted, the mutation wrapper refused to start
  while any tracked file was modified (from M15 on). Every run, before and
  after that, ended with `git diff --stat` empty.
- This reviewer's two throwaway tests were deleted.

## 1. Findings (most severe first)

### C-1 (MED) - a re-driven attempt's pre-claim decline swallows a thrown close; the record strands `redriven`

- Contract:
  - R2: "Steps 1-4 run BEFORE the claim: a throw in any of them fails the
    delivery and SQS redelivers it".
  - R2 step 4: "A decline here on a `redriven` record closes it
    `closeRedriven(refused, <cause>)` (SOR D8 rev 11 - else it strands)".
  - Review Focus 5: "never left `redriven` for the sweeper".
- What the code does:
  - `declineBeforeClaim` wraps `closeRedriven` in `guardWrite`
    (`app/src/jobs/retrySend.ts:680-689`). A thrown close is logged at ERROR
    and swallowed (`app/src/lib/guardWrite.ts:17-24`).
  - The handler then logs its 4a INFO or 4b ERROR and returns normally
    (`retrySend.ts:459-461`, `:471-476`). SQS deletes the message and the
    record stays `redriven` until the sweeper (D14, not built).
  - For a 4b decline (no child), once the re-drive's refreshed promise expires,
    the route answers 409 `retry_pending` ("A retry is already scheduled for
    this message.") for up to `RETRY_SEND_WINDOW_MS` from the attempt's
    `attemptedAt` (`app/src/routes/api.ts:1683-1690`). Nothing is scheduled at
    that point. For a 4a decline, `superseded` answers first.
  - Nothing is sent either way: no double text, no lost send.
  - The code follows the plan's Task 4 sketch, and S3 flagged it for review. It
    is not among the ten declared deviations.
- Fix:
  - Call `attemptsRepo.closeRedriven` directly in `declineBeforeClaim`, so a
    throw fails the delivery as R2 says. The redelivery is idempotent: the gate
    skips a closed record or re-declines a still-`redriven` one. Keep the
    lost-fence INFO.
  - Add a case: `closeRedriven` rejects once, `dispatchJob` rejects, and the
    redelivery closes the record `done/refused`.
  - Or declare it as deviation 11 and name the strand in `send-attempt-sweeper`.
- Proof: a throwaway test, since deleted. Setup: a `redriven` record plus a
  manual child, with `closeRedriven.mockRejectedValueOnce`, and the envelope
  dispatched directly. Observed: `threw=false`, record `state: redriven`, one
  ERROR `failure-arm write failed (best-effort); the attempt record decides`.

### C-2 (MED) - a WITHDRAW that fails is never re-applied (Q1's display half, R4 crash safety)

- Contract:
  - Q1: the retried row reads "retry not confirmed", with no promise and NO
    Retry button.
  - R4 crash safety: "a redelivered check that finds the record `done` for its
    own attempt re-applies it".
  - SOR D8 as built (FW1-4): a close that dies at its slot write is completed
    by the redelivery.
- What the code does:
  - `withdrawRetryPromise` never throws. A write that throws answers `'failed'`
    (`app/src/services/retryPromiseWrites.ts:100-105`); a second lost condition
    answers `'lost'` (`:98-99`).
  - The reconcile's `closeSlot` retry arm discards that answer
    (`app/src/jobs/sendReconcile.ts:1318-1320`). `closeUnresolved` then
    completes (`:1409-1410`) and the check job succeeds, so no redelivery ever
    reaches the superseded exit's re-apply (`:528-532`).
  - Every other owner's slot close rethrows a non-conditional error
    (`app/src/repos/broadcastsRepo.ts:575-577`), so its redelivery completes it.
  - The job's own `unresolved` closes have no re-apply path either
    (`retrySend.ts:775`, `:825`). Nothing may throw after the claim, and a crash
    between the record close and the WITHDRAW meets the gate's `skip` on
    redelivery (`app/src/lib/sendAttemptGate.ts:33`).
- Impact:
  - The record is `done/unresolved`, but the row keeps its refreshed promise
    and then reads the plain 30003 failure WITH a Retry button.
  - A press is refused 409 `retry_unresolved` (the right sentence) for the
    record's 30-day life.
  - After that the row carries no belt, and a press sends the text Q1 says must
    never go.
  - This is a staff-visible wrong state under a DynamoDB fault that outlasts
    the SDK's own retries.
- Fix:
  - In `closeSlot`'s `retry_send` arm, throw when the WITHDRAW answers
    `'failed'` (arguably `'lost'` too), after the ERROR is logged. The check
    then fails, and SQS redelivers into the superseded exit, which re-applies
    idempotently (the FW1-4 shape).
  - For the job's two arms, re-apply the WITHDRAW in the gate's `skip` branch
    when the record is `done/unresolved` and the row lacks `retry_outcome`, or
    name the residue in `send-attempt-sweeper` and the handback.
- Proof: a throwaway test, since deleted. Setup: an unknown retry, then the
  real reconcile with the list failing on all three checks, and
  `annotateRetryPromise` throwing only on the WITHDRAW call. Observed:
  - `checkThrew: 0`;
  - record `done/unresolved/provider_unreachable`;
  - row `retry_outcome` absent, and `retry_due_at` is not the sentinel;
  - ERRORs: the unresolved verdict, then `failure-arm write failed (best-effort)`.

### C-3 (LOW) - test gap: the gate's `defer` exit is unpinned

- Contract: Review Focus 1 ("deferred by the gate on a fresh attempting record
  (test 6e)"). R2 step 4: `reconciling` -> INFO, return, BEFORE the window
  check (the principle of spec item 4d).
- What the code does: the code is correct (`retrySend.ts:427-430`) but no test
  pins that exit. With the `return` removed:
  - `retrySendAttempt.test.ts` stays 34/34 green;
  - `twilioStatusWebhook.test.ts` stays 81/81 green;
  - the claim's fresh refusal (`retrySend.ts:494-501`) still stops the send,
    so no assertion notices;
  - a `reconciling` record on a row past the window would log a spurious
    `retry window closed` ERROR (`:472-475`) before the claim refuses.
- Fix: add a case with a `reconciling` record (and a fresh `attempting` one) on
  a row past the window. Expect:
  - one INFO with `gate: 'defer'`;
  - no ERROR;
  - no `claim refused` line;
  - no `listRetryChildrenConsistent` call.
- Proof: mutation M3a stays green; M3b goes red.

### C-4 (LOW) - the window-terminal deferral line does not say `retry window closed`

- Contract: R3 table, deferred row. A terminal deferral logs
  "ERROR `retry deferred twice - chain ended` / `retry window closed`".
- What the code does:
  - The line reads `retrySend: a deferred re-run would land past the window -
    chain ended` (`retrySend.ts:719-725`).
  - The text comes from the plan's Task 4 sketch and was not declared.
  - A search for `retry window closed` finds the step-4b line
    (`retrySend.ts:474`) and misses this terminal close.
- Fix: reword the line to contain `retry window closed` and update the message
  pin at `app/test/retrySendAttempt.test.ts:528-534`, or declare the wording in
  the handback.
- Proof: read.

### C-5 (LOW) - two ERROR lines claim "the retry promise is withdrawn" without checking the WITHDRAW's answer

- Contract: R9 (one ERROR per unresolved close; the lines state the outcome).
- What the code does:
  - The second-unknown ERROR (`retrySend.ts:825-831`) and the hand-off
    enqueue-failure ERROR (`:775-781`) say the promise is withdrawn whenever the
    record close won.
  - On a `'lost'` or `'failed'` WITHDRAW that is false, and the helper's own
    ERROR follows it.
- Fix: branch the message on the WITHDRAW's answer, as S3 already does for the
  close.
- Proof: read.

### C-6 (NOTE) - an extra step-1 decline, declared only in the S3 report

- Contract: R2 step 1 lists two declines: not found, and not outbound.
- What the code does:
  - A third designed decline: the payload's `conversationId` differs from the
    retried row's. It logs a WARN and writes no record
    (`retrySend.ts:358-366`).
  - It is declared only as S3's D-a, not among the plan's ten deviations.
  - The webhook, the deferral and the re-drive all pass the row's own
    conversationId, so none of them can reach it.
  - It is justified: it keeps the owner addressable.
- Fix: carry it into the handback's deviation list as deviation 11.

### C-7 (NOTE) - R1 and R4 disagree for a phone-keyed attempt whose thread number changed

- What the code does:
  - The code follows R1: resolve's hash check fails
    (`sendReconcile.ts:629-630`). The result is INFO `owner recipient not
    found`, the record stays `reconciling`, and the promise is untouched (test
    `app/test/sendReconcile.test.ts:3577`).
  - R4's digest bullet instead expects `unresolved digest_mismatch` plus the
    WITHDRAW. A contact-keyed attempt does get that (test `:3554`).
  - The case lies outside R1's stated assumption that a one-to-one thread's
    number never changes.
- Fix: the handback names which rule governs; `send-attempt-sweeper` names the
  strand.

### C-8 (NOTE) - spec item 13's "attempt === retry_attempt match" is proven only jointly

- What the code does:
  - The matcher clause (`sendReconcile.ts:1088`) is unreachable by valid data,
    because the walk already stops at a manual row (`retryChain.ts:40`).
  - Removing the clause alone leaves `sendReconcile.test.ts` green (M7d).
  - Removing it together with the walk stop turns 13b and 13e red (M7e).
  - The walk stop alone is pinned by `app/test/retryChain.test.ts:122`, `:138`
    (M7c).
- Fix: acceptable defense in depth, which S2 already named. The handback
  should state that item 13 is proven jointly.

### C-9 (NOTE) - worklist item 26's "(the route allows it at once)" is inaccurate

After a `redrive_refused` close, or a re-drive `enqueue_failed` close, the
refreshed promise is still live. RSW's time guard (`api.ts:1626-1629`) answers
409 `retry_pending` first, so the screen and the route agree until the promise
expires. Correct the wording in the Task 9 handback.

### C-10 (NOTE) - the deviation 10 belt is permanent code for a one-time window

The belt (`retrySend.ts:436-450`) guards roughly 10 minutes of SQS redeliveries
across the deploy. It stays in the code, and every first run pays one eventual
Get for it. Add a dated `TODO(retry-send-lost-under-job-marker)` or an issue
line to remove it after the first deploy (Task 9).

## 2. Conformance table

Verdicts: CONFORMS / PARTIAL / MISSING / DEVIATES, where DEVIATES (D-n) means
declared deviation n. PENDING marks a Task 9 item, not a failure. Code is cited
at HEAD.

### Spec section 0

| id | clause | verdict | evidence |
|---|---|---|---|
| S0-1 | Two names: the RETRIED ROW (read by `payload.providerSid`) and the ROOT | CONFORMS | `retrySend.ts:349`, `:367`; `sendReconcile.ts:626`; `api.ts:1653` |
| S0-2 | Root rule: `retry_root`, else the pre-deploy `retry_of` walk (at most 3 consistent hops, stopping at a broken link), else the row's own tsMsgId | CONFORMS | `app/src/services/retryChain.ts:23-34`; `retryChain.test.ts:49-99`; `retrySendAttempt.test.ts:956`; `apiRoutes.test.ts:1150` |
| S0-3 | Q1: unresolved -> "retry not confirmed" + WITHDRAWN + no Retry | PARTIAL | Main path: `sendReconcile.ts:1308-1321`, `retryPromiseWrites.ts:76-106`, `Timeline.tsx:1056`, `:1441`, `api.ts:1670-1676`. Under a write fault the WITHDRAW is never re-applied (C-2). |
| S0-4 | Q2: twilio.ts fenced except one line | CONFORMS | `git diff --stat main...HEAD`: `twilio.ts` 1+/1- at `:3904` |
| S0-5 | Branch B: `broadcast_id` + `retry_root` on every retry row (automatic, adopted, manual) | CONFORMS | `retrySend.ts:539-540`; `sendReconcile.ts:901-902`; `api.ts:1768-1769`; tests: `retrySendAttempt.test.ts:905`, `sendReconcile.test.ts:3095`, `:3154`, `apiRoutes.test.ts:1125`, `:1167` |
| S0-6 | 1b writes nothing to the share slot | CONFORMS | No slot write in `closeSlot`'s retry arm (`sendReconcile.ts:1308-1321`); the rollup matches only conversationId + tsMsgId (`twilio.ts:3887-3888`) |
| S0-7 | Wontfix kept: no early withdrawal on a refusal, rejection, window close or success | CONFORMS | Only the unresolved arms call the WITHDRAW (`retrySend.ts:775`, `:825`; `sendReconcile.ts:1319`); promise untouched in tests 2, 3, 4-cap, 4-window, 4-enqueue and 7 (`retrySendAttempt.test.ts:415-551`, `:905`) and 11a, 11c (`sendReconcile.test.ts:3424`, `:3473`) |

### R1 - the owner kind

| id | clause | verdict | evidence |
|---|---|---|---|
| R1-1 | Owner union member, all six fields | CONFORMS | `sendAttemptsRepo.ts:64-70` |
| R1-2 | `ownerKey = retry#conv#retried#attempt`; the root is a fact, never part of the key | CONFORMS | `sendAttemptsRepo.ts:177-179`; `sendAttemptsRepo.integration.test.ts:92` |
| R1-3 | `recipientKey` from immutable data, never from a live check | CONFORMS | `retryChain.ts:48-55`; `retrySend.ts:399`; `sendReconcile.ts:629` |
| R1-4 | Key not in the job payload; ref carries the hash; mismatch -> INFO, sweeper | CONFORMS | `retrySend.ts:117-155`; `sendReconcile.ts:630`, `:500-509`; `retrySendAttempt.test.ts:314`, `:352`; `sendReconcile.test.ts:3068`, `:3577` |
| R1-5 | Facts: sender from one shared helper, digest, body hash, `mediaCount` from the single media function the job, facts and adoption all call | DEVIATES (D-9) | Job: `retrySend.ts:483-492`, `lib/outboundSender.ts:7`, `sendMessage.ts:601`. The adoption reads the record's `mediaCount` instead (`sendReconcile.ts:860-865`). |
| R1-6 | OwnerRef, `toOwnerRef`, parser, `ownerRefLog` / `ownerLog` arms | CONFORMS | `sendReconcile.ts:147-154`, `:195-203`, `:257-272`, `:463-471`, `:486-493`; `sendReconcile.test.ts:3872`, `:3898` |
| R1-7 | `deferred: true` carried by the parser, set only by the deferral | CONFORMS | `retrySend.ts:129`, `:153`, `:729-732`; `twilioStatusWebhook.test.ts:1296-1306` |

### R2 - the job's order and phases

| id | clause | verdict | evidence |
|---|---|---|---|
| R2-1 | Step 1: retried row; not found or not outbound -> WARN; root; origin fail-open | DEVIATES (D-3) | Consistent read at `retrySend.ts:349`; declines at `:350-357`; root and origin at `:367-371`, `:468-469`; test 9c |
| R2-1b | Step 1 has only the two declines above | DEVIATES (undeclared, C-6) | `retrySend.ts:358-366` |
| R2-2 | Step 2: the recorded recipient read | CONFORMS | `retrySend.ts:379-390` |
| R2-3 | Step 3: conversation decline (never a throw), in the decision's vocabulary | CONFORMS | `retrySend.ts:395-403`; `retryChain.ts:61-74`; test 4e (`retrySendAttempt.test.ts:719`) |
| R2-4 | Step 4: existing attempt first - stale -> takeover + hand-off; fresh or reconciling -> INFO; terminal -> INFO; absent, retryable or redriven -> the gates | CONFORMS | `retrySend.ts:421-435`; `sendAttemptGate.ts:30-39`; tests 4d, 6a, 6b, 6e. Test gap: C-3. |
| R2-5 | 4a: a manual child supersedes; ONE `retrychild#` Query | CONFORMS | `retrySend.ts:457-462`; test 4c (`:649`); M13, M13b |
| R2-6 | 4b: strict window, ERROR | CONFORMS | `retrySend.ts:468-477`; tests 9a, 4d |
| R2-7 | A decline on a redriven record closes it (`closeRedriven(refused)`); nothing written on retryable or absent | PARTIAL | Main path: `retrySend.ts:680-689`, tests 4c(3), 11 (second half). A thrown close strands the record (C-1). |
| R2-8 | Step 5: claim; refused (fresh or not) -> INFO; takeover; the two flags | CONFORMS | `retrySend.ts:493-510`, `:714`; tests 6f, 6g, 4-cap |
| R2-9 | Step 6: prepare; a throw -> deferral | CONFORMS | `retrySend.ts:515`, `:576-580`; test 4-prepare |
| R2-10 | Step 7: send with `retryRoot`, `broadcastId` and the re-arm hook; a lost re-arm sends nothing | CONFORMS | `retrySend.ts:528-550`, `:588-593`; tests 6c, 7 |
| R2-11 | Step 8: `finishAttempt(sent)` via guardWrite; lost fence -> WARN; INFO re-sent; no promise write | CONFORMS | `retrySend.ts:559-567`; tests 7, 7b |
| R2-12a | A throw in steps 1-4 fails the delivery | PARTIAL | Steps 1-3 and the gate propagate (test 9b). Step 4's decline close is swallowed (C-1). |
| R2-12b | One try/catch with prepare, sending and record phases; nothing throws after the claim | CONFORMS | `retrySend.ts:511-637`; every arm helper uses guardWrite or never throws (`:647-836`) |
| R2-13 | The run-once marker is gone | DEVIATES (D-10) | Registration at `retrySend.ts:330-331` writes no marker; test 6d. Plus the read-only belt at `:444-450`. |

### R3 - the arms

| id | clause | verdict | evidence |
|---|---|---|---|
| R3-1 | `annotateRetryPromise` signature and condition | CONFORMS | `messagesRepo.ts:1554-1559`, `:3388-3426`; `messagesRepoRetryLineage.integration.test.ts:487`, `:524` |
| R3-2 | REFRESH = the write + `message.persisted`; a losing REFRESH is dropped | CONFORMS | `retryPromiseWrites.ts:44-68`; `retryPromiseWrites.test.ts:72-92` |
| R3-3 | WITHDRAW = sentinel + outcome in one write, retried once | CONFORMS | `retryPromiseWrites.ts:76-99`; `retryPromiseWrites.test.ts:105-181` |
| R3-4 | Every guardWrite loss logged at ERROR | DEVIATES (D-6) | A throw -> guardWrite ERROR; a lost fence -> the site's own INFO or WARN (`retrySend.ts:658-664`, `:564-566`, `:810`) |
| R3-5 | Refused (incl. the wrapper's kill switch) -> `done/refused`, WARN | DEVIATES (D-2) | `retrySend.ts:582-587`, `:669-672`, adapter kill switch at `:611-614`; tests 3, 2a |
| R3-6 | Rejected -> `done/rejected`, cause = code or status, ERROR, no retry row | CONFORMS | `retrySend.ts:610-631`; test 2 |
| R3-7 | Deferred: one deferral, enqueue first, release retryable, REFRESH; terminal on deferral_cap or a closed window; enqueue failure -> refused | CONFORMS | `retrySend.ts:704-756`; tests 4, 4-cap, 4-window, 4-enqueue, 4-lost, 4-redriven, 4-prepare |
| R3-8 | The terminal window deferral's log line reads `retry window closed` | DEVIATES (undeclared, C-4) | `retrySend.ts:719-725` |
| R3-9 | Unknown: `handToReconcile` first, check-0 enqueue, REFRESH; second unknown -> unresolved + WITHDRAW; enqueue failure -> `closeFromReconcile(unresolved)` + WITHDRAW | CONFORMS | `retrySend.ts:764-836`; tests 1, 1b, 1c, 1d; M1 |
| R3-10 | Accepted-not-recorded: reconciling WITH the SID, enqueue, REFRESH, ERROR | CONFORMS | `retrySend.ts:598-606`; test 5 |
| R3-11 | Taken over before the send: nothing written, INFO | CONFORMS | `retrySend.ts:541-546`, `:588-593`; test 6c |
| R3-12 | A step-5 takeover takes the unknown path, including the REFRESH | CONFORMS | `retrySend.ts:502-507`; test 6g |

### R4 - the reconcile's `retry_send` owner

| id | clause | verdict | evidence |
|---|---|---|---|
| R4-1 | Every dispatch site has the arm and a `never` default | CONFORMS | 11 switches ending in `unhandledOwner` (`sendReconcile.ts:165-167`): `:178`, `:456`, `:479`, `:587`, `:654`, `:756`, `:800`, `:1291`, `:1339`, `:1466`, `:1529`. `relayRowKey` and `adoptRelay` narrowed (`:369-374`, `:963`). Repo: `sendAttemptsRepo.ts:170-201`. HEAD sweep re-run: no missed site. |
| R4-2 | Resolve: consistent retried row, eventual conversation; missing row -> INFO, sweeper | CONFORMS | `sendReconcile.ts:619-640`; tests 12b, 12a2 |
| R4-3 | Digest check -> `digest_mismatch` | CONFORMS | `sendReconcile.ts:1114-1118`, `:671-677`; test 12a (phone-keyed: C-7) |
| R4-4 | Lookup lineage exclusion: exact producing attempt; the share root's own record; the same root is not lineage | CONFORMS | `sendReconcile.ts:1080-1095`, `:1135-1149`; `retryChain.ts:36-46`; tests 13-13e; M7, M7e (C-8) |
| R4-5 | `heldBy` / mine = the retry row this exact attempt produced | CONFORMS | `sendReconcile.ts:739-778`; tests 10c, 10c2, 10e, 10f; M5, M5b |
| R4-6 | Adopt: full field set; dedupe -> skipped or other; audit once; touch; emit; no promise write; terminal failure WARN | DEVIATES (D-9) | Media per the record's facts. `sendReconcile.ts:850-947`; tests 10, 10a, 10b, 10b2, 10d, 10g, 10h |
| R4-7 | never_sent: window first, `markRedriven`, immediate enqueue without `deferred`, REFRESH; outside the window -> `redrive_refused` ERROR; enqueue throws -> `enqueue_failed`, no outcome | CONFORMS | `sendReconcile.ts:1539-1549`, `:1595-1632`, `:1501-1514`, `:1565-1585`, `:1434-1455`; tests 11, 11a, 11b, 11c |
| R4-8 | unresolved: record first, WITHDRAW, emit, one ERROR | CONFORMS | `sendReconcile.ts:1390-1411`; test 12 (call order pinned at `sendReconcile.test.ts:3528`) |
| R4-9 | Crash safety: the superseded exit re-applies; only `unresolved` maps to the WITHDRAW; `afterClose` = the retried row's emit | PARTIAL | D-5 location: `sendReconcile.ts:528-532`, `:1308-1321`, `:1363-1376`; test 12 re-apply. A failed WITHDRAW never triggers a redelivery (C-2). |

### R5 - "retry not confirmed"

| id | clause | verdict | evidence |
|---|---|---|---|
| R5-1 | `retry_outcome` written only by the WITHDRAW, together with the sentinel | CONFORMS | `messagesRepo.ts:1077`; `append` never writes it (harness pin in `twilioWebhookHarnessRetryFields.test.ts`) |
| R5-2 | Projection and dashboard mirror | CONFORMS | `contactTimeline.ts:188`, `:462`; `types.ts:2527`, `:2562`; `retryPromise.ts:33`; `retryPromiseMirror.test.ts`; M10 |
| R5-3 | `deliveryReason` copy; unconfirmed outranks scheduled; relay outranks both | CONFORMS | `deliveryStatus.ts:965-967`, `:1192-1198`; `deliveryStatus.test.ts:842`; M9b |
| R5-4 | Retry hidden on the outcome | CONFORMS | `Timeline.tsx:1056`, `:1441`; `Timeline.delivery.test.tsx:681-713`; M9a, M15 |
| R5-5 | Readers: the one-to-one bubble only | CONFORMS | `Timeline.tsx:1071` is the only caller that passes `retryUnconfirmed` |

### R6 - the manual Retry route

| id | clause | verdict | evidence |
|---|---|---|---|
| R6-1 | Any child -> 409 `superseded`; one Query | CONFORMS | `api.ts:1638-1642`; `apiRoutes.test.ts:901`, `:913`, `:1167`; M8b |
| R6-2 | Record read by key (three gets) under the R1 key; row belt | DEVIATES (D-1) | One get: `api.ts:1650-1667` |
| R6-3 | 409 `retry_unresolved` on `done/unresolved` or the belt; no time bound | CONFORMS | `api.ts:1670-1676`; `apiRoutes.test.ts:927`, `:947`; M8a, M8d |
| R6-4 | 409 `retry_pending` on an open record younger than `RETRY_SEND_WINDOW_MS` | CONFORMS | `api.ts:1683-1690`; `apiRoutes.test.ts:963`, `:980`; M8c |
| R6-5 | The other `done` outcomes never block | CONFORMS | `apiRoutes.test.ts:980` (all seven, plus stale open records) |
| R6-6 | The append carries `retryRoot` and `broadcastId` | CONFORMS | `api.ts:1768-1769`; `apiRoutes.test.ts:1125`, `:1150`, `:1167` |
| R6-7 | Dashboard copy for 409 `superseded` and 409 `retry_unresolved` | CONFORMS | `Timeline.tsx:139-142`; `Timeline.test.tsx:954-976`; M9d |
| R6-8 | The residual windows mapped in a dated issue note | PENDING | Task 9 |

### R7 - attribution, the root pointer, the fenced line

| id | clause | verdict | evidence |
|---|---|---|---|
| R7-1 | `retryRoot` / `retry_root`; sendMessage passes it | CONFORMS | `messagesRepo.ts:760`, `:1057`, `:2619`; `sendMessage.ts:370`, `:458`, `:680` |
| R7-2 | `retrychild#` pointer in the append transaction; one consistent Query; written by all three appends | CONFORMS | `messagesRepo.ts:2776-2799`, `:3359-3386`; `messagesRepoRetryLineage.integration.test.ts:334-459`; M11 |
| R7-3 | `send-attempt-sweeper` records the family | PENDING | Task 9 |
| R7-4 | `retry_root` + `broadcast_id` on every retry row | CONFORMS | As S0-5 |
| R7-5 | `isBroadcastRowFor` read, and the handback states what it does | DEVIATES (D-7) | Code: `broadcastFanOut.ts:1303`; tests `sendReconcile.test.ts:3792`, `:3800`. The handback line is PENDING. |
| R7-6 | The one fenced line: WARN -> INFO, with `broadcastId` | DEVIATES (D-4) | `twilio.ts:3904`; `twilioStatusWebhook.test.ts:374`; M12 |

### R8-R12

| id | clause | verdict | evidence |
|---|---|---|---|
| R8 | The 30003 decision is unchanged | CONFORMS | `oneToOneRetryDecision.ts` has no diff; the decision at `twilio.ts:3452-3461` does not read `broadcast_id`; lineage at append (tests 8, 10) |
| R9 | Log levels and fields; no phone or body | CONFORMS | Test R9 (`retrySendAttempt.test.ts:1023`); e2e contract (`retry-send-adoption.spec.ts:295-317`). Text findings C-4, C-5. |
| R10 | What Branch B reads | CONFORMS | Tests 7 and 10 (field sets), 12 (withdrawal shape); `sendAttemptsRepo.integration.test.ts:368` (`listByRecipient` across kinds) |
| R11 | No new seam | CONFORMS | No diff under `scripts/`, `fake-twilio/`, `fake-twilio-web/`, `e2e/fixtures/` |
| R12 | Declared deviations from SOR | CONFORMS | Takeover by its own job's redelivery (test 6b); record first (test 12); `afterClose` = the retried row's emit (`sendReconcile.ts:1363-1376`) |

### Spec section 4 - is each item proven by a test that fails without the code?

| item | test | verdict |
|---|---|---|
| 1 | `retrySendAttempt.test.ts:314` (1), `:352` (1b) | CONFORMS (M1 red) |
| 2 | `:415` | CONFORMS |
| 3 | `:456` | CONFORMS |
| 4 | `:475`, `:497` (cap + redelivery), `:518`, `:579`; parser `twilioStatusWebhook.test.ts:1296` | CONFORMS |
| 4b | `:625` | CONFORMS |
| 4c | `:649` | CONFORMS (M13, M13b red) |
| 4d | `:693` | CONFORMS |
| 4e | `:719` | CONFORMS |
| 5 | `:751` | CONFORMS |
| 6 | 6a `:774`, 6b `:791`, 6c `:825`, 6d `:842`, 6e `:856`, 6f `:871`, 6g `:888` | CONFORMS (M2a, M2b, M3b, M4 red; the gate path is C-3) |
| 7 | `:905`; existing pin `twilioStatusWebhook.test.ts:1937-1959` | CONFORMS |
| 8 | `:956` | CONFORMS |
| 9 | `:973` | CONFORMS |
| 10 | `sendReconcile.test.ts:3095`, `:3154`, `:3182`, `:3203`, `:3266` | CONFORMS |
| 11 | `:3393`, `:3424`, `:3460`, `:3473`; `retrySendAttempt.test.ts:999`; `apiRoutes.test.ts:980` (the route allows after `enqueue_failed`) | CONFORMS |
| 12 | `:3505` | CONFORMS (M6, M6b red) |
| 13 | `:3641`, `:3670`, `:3683`, `:3697`, `:3711`, `:3729`, `:3761`, `:3774` | CONFORMS (M7, M7e red; C-8) |
| 14 | `:3285` (10e) | CONFORMS |
| 15 | `apiRoutes.test.ts:901-1284` | DEVIATES (D-8): the 31 s `attempting` case answers 409, by R6. M8a-d red. |
| 16 | `deliveryStatus.test.ts:842`; `Timeline.delivery.test.tsx:674-713`; `Timeline.test.tsx:950-977`; `contactTimeline.test.ts:405`; `retryPromiseMirror.test.ts:62` | CONFORMS (M9a-d, M10, M15 red) |
| repo | `sendAttemptsRepo.integration.test.ts:92`, `:368`; `messagesRepoRetryLineage.integration.test.ts:334-524`; parity `twilioWebhookHarnessRepoAdditions` and `twilioWebhookHarnessSendAttempts` (all run green here against DynamoDB Local, none skipped) | CONFORMS (M11 red) |
| 17 | `e2e/tests/dashboard-next/retry-send-adoption.spec.ts:353` | CONFORMS (read; not run) |
| 18 | `:441` | CONFORMS (read; not run) |
| 19 | `:522` | CONFORMS (read; not run - see section 3) |

Note on the section 4 preamble: it counts 19 handler registrations in
`twilioStatusWebhook.test.ts`. There are 18, on main and at HEAD, and all 18
now go through `retryDeps` with the world's attempts repo
(`twilioStatusWebhook.test.ts:1637`).

### The ten declared deviations - (a) is it what the code does, (b) is it justified, (c) is it the least-surprising choice

| dev | (a) code | (b) justified | (c) least surprise | assessment |
|---|---|---|---|---|
| D-1 one record read | yes, `api.ts:1655-1667` | yes: the webhook schedules `(retry_attempt ?? 0) + 1` (`oneToOneRetryDecision.ts:125-129`), and the deferral and re-drive keep `payload.attempt` (`retrySend.ts:729-732`, `sendReconcile.ts:1509-1512`) | yes | ACCEPTED. The job does not itself assert that `payload.attempt` matches the row; unreachable from any producer. |
| D-2 adapter kill switch -> refused | yes, `retrySend.ts:611-614` | yes | yes | ACCEPTED |
| D-3 consistent retried-row read | yes, `retrySend.ts:349` | yes (the R3 condition value) | yes | ACCEPTED |
| D-4 the fenced line reworded in ASCII | yes, `twilio.ts:3904` | yes | yes | ACCEPTED |
| D-5 the WITHDRAW map lives in `closeSlot` | yes, `sendReconcile.ts:1308-1321` | yes | yes | ACCEPTED (the re-apply gap is C-2, not D-5) |
| D-6 fence answer captured; lost fence logged by the site | yes, `retrySend.ts:647-666` and siblings | yes | yes (the broadcast idiom, at INFO) | ACCEPTED |
| D-7 `isBroadcastRowFor` ignores retry rows | yes, `broadcastFanOut.ts:1303` | yes: retry rows now carry `broadcast_id` | yes | ACCEPTED; handback line PENDING |
| D-8 staleness = `RETRY_SEND_WINDOW_MS` for every open state | yes, `api.ts:1683-1690` | yes: R6 is normative, item 15 lists proofs | yes | ACCEPTED |
| D-9 adoption media from the record | yes, `sendReconcile.ts:860-865` (the record's facts are threaded in, S2 D4) | yes | yes | ACCEPTED |
| D-10 read-only marker belt | yes, `retrySend.ts:436-450`; tests `:1048`, `:1068`; M14, M14b | yes (the planner's ruling) | yes | ACCEPTED (C-10: plan its removal) |

### Review Focus

| rf | verdict | evidence |
|---|---|---|
| RF1 redelivery before, during and after the claim | PARTIAL | Behavior proven: tests 9, 6a, 6e, 6f; M2b, M3b, M4 red. "Deferred by the gate" is not pinned: M3a stays green (C-3). |
| RF2 the original message is `other` | CONFORMS | Tests 10c and 10c2 together (M5 red; M5b red on 10c2) |
| RF3 sentinel without outcome keeps Retry | CONFORMS | `Timeline.delivery.test.tsx:708-713` plus the existing WITHDRAWN pin; M15 red |
| RF4 a manual row's chain claims | CONFORMS | Test 4b (`retrySendAttempt.test.ts:625`) |
| RF5 a redriven record never left for the sweeper | PARTIAL | Main path: 4c(3), 11 (second half). A thrown close strands it (C-1). |

### Global Constraints

| gc | verdict | evidence |
|---|---|---|
| ASCII on every added line | CONFORMS | `git diff -U0 main...HEAD` added lines: 0 non-ASCII bytes (code and docs) |
| Fences | CONFORMS | `jobs.ts`, `sqsJobConsumer.ts`, `oneToOneRetryDecision.ts` have no diff; `twilio.ts` 1+/1-; `putJobExecutionMarker` appears only as the removed call; `getJobExecutionMarker` read-only (belt) |
| No run-once marker at registration | CONFORMS | `retrySend.ts:330-331`; `registerHandlers.ts:61` |
| DynamoDB aliases exactly used | CONFORMS | `messagesRepo.ts:3398-3413` (four shapes); `:3369-3376`; DynamoDB Local cases |
| Consistent coordination reads | CONFORMS | `retrySend.ts:349`, `:457`; gate `get`; `retryChain.ts` point-gets; `api.ts:1638`, `:1658`; conversation reads eventual, as allowed |
| Record keyed on the retried row and the attempt; recipient key immutable | CONFORMS | R1-2, R1-3 |
| Zero added hop | CONFORMS | The only self-enqueue is the deferral (`retrySend.ts:729`); the re-drive is inside the budget (`sendReconcile.ts:1509`) |
| Import cycle used only inside functions | CONFORMS | `retrySend.ts:90-96` used in the handler only; `sendReconcile.ts:134` used only at `:1509` |
| Promise writes only through the two helpers | CONFORMS | Call sites `retrySend.ts:744`, `:775`, `:785`, `:825`; `sendReconcile.ts:1319`, `:1625`; no `annotateMessage` change |
| Log fields and levels; no phone or body | CONFORMS | R9 row (C-4, C-5 are text-only) |
| Dashboard copy exact and ASCII | CONFORMS | `deliveryStatus.ts:966`; `Timeline.tsx:139-142` |
| E2E constraints | CONFORMS | uid starts at 90; fresh tenants; no `0002` (`retry-send-adoption.spec.ts:61`, `:96`) |

### Worklist

| item | verdict | evidence |
|---|---|---|
| 1 fake list in `utf8Order` | CONFORMS | `twilioWebhookHarness.ts` fake `listRetryChildrenConsistent` |
| 2 imports | CONFORMS | typecheck green per the reports; imports at `retrySend.ts:34-96` |
| 3 doc comments reworded | CONFORMS | `sendMessage.ts:329-339`; `messagesRepo.ts:722-729`, `:1151-1158` |
| 4 Task 2 steps 2 and 4 together | CONFORMS | S2 commit split |
| 5 no unused `conversation` in test 10 | CONFORMS | `sendReconcile.test.ts:3097` |
| 6 `sendReconcile` imports (the cap from the leaf) | CONFORMS | `sendReconcile.ts:59-134` |
| 7 anchors | CONFORMS | informational |
| 8 test 12c recipe | CONFORMS | `sendReconcile.test.ts:3617-3637` |
| 9 test imports | CONFORMS | `sendReconcile.test.ts` header |
| 10 holder label for retry rows | CONFORMS | `sendReconcile.ts:787-791`; `sendReconcile.test.ts:3800` |
| 11 live-object note | CONFORMS | Spies and copies in 10g, 4-lost |
| 12 both thread reads spied | CONFORMS | `retrySendAttempt.test.ts:658-659` |
| 13 `providerCalls` bound before the run | CONFORMS | test cases |
| 14 one registration per job | CONFORMS | `retrySendAttempt.test.ts:140-146` |
| 15 webhook suite rewires | CONFORMS | `twilioStatusWebhook.test.ts:1637` and 18 sites |
| 16 `seedRedriven` recipe | CONFORMS | `retrySendAttempt.test.ts:227-231` |
| 17 harness constants | CONFORMS | `retrySendAttempt.test.ts:50` |
| 18 stub parameter types | CONFORMS | `apiRoutes.test.ts:472-480` |
| 19 `apiRoutes` imports | CONFORMS | file header |
| 20 dashboard `import type` with `.js` | CONFORMS | `types.ts:8` |
| 21 rollup case placement | CONFORMS | `twilioStatusWebhook.test.ts:374` |
| 22 e2e API shapes | CONFORMS | `retry-send-adoption.spec.ts:163-192` |
| 23 `StoredMessage` and `stamp` | CONFORMS | spec file `:103-121` |
| 24 the belt | CONFORMS | `retrySend.ts:436-450`; tests `:1048`, `:1068` |
| 25 rollback note | PENDING | Task 9 / handback |
| 26 REFRESH-race wording | PENDING | Task 9 / handback (see C-9) |
| 27 `retry_outcome` on a share root | PENDING | Task 9 / handback |

### Task 9 (sections 5-6)

| id | verdict |
|---|---|
| Section 5 issue notes (7 files; the wontfix untouched) | PENDING |
| Section 6 handback (deviations, gates, hosted-dev precondition, UNMERGED) | PENDING |

Tally, 144 rows:

| verdict | count | detail |
|---|---|---|
| CONFORMS | 119 | |
| PARTIAL | 6 | S0-3, R2-7, R2-12a, R4-9, RF1, RF5 (C-1, C-2, C-3) |
| MISSING | 0 | |
| DEVIATES | 12 | 10 cite a declared deviation; 2 undeclared (R2-1b = C-6, R3-8 = C-4) |
| PENDING | 7 | Task 9 |

## 3. Mutation checks

Each run followed the same sequence:

1. Back up the file to the scratchpad.
2. Apply one exact edit (a node script).
3. Run ONE test file with vitest from the workspace.
4. Restore from the backup.
5. Confirm with `cmp` identical and `git diff --stat` empty.

All runs were restored. Line numbers are the production lines broken.

| id | production line broken | test file | result |
|---|---|---|---|
| M1 | `retrySend.ts:636` `onUnknown(...)` -> `throw err` (main's rethrow) | `retrySendAttempt.test.ts` | RED 6 (1, 1b, 1c, 1d, 6d, 11) |
| M2a | `retrySend.ts:431-434` gate `skip` no longer returns | same | RED 1 (6a) |
| M2b | M2a + `:494` claim refusal ignored + `:543-546` lost re-arm proceeds | same | RED 4; 6a fails on 2 provider calls |
| M3a | `retrySend.ts:427-430` gate `defer` no longer returns | same, and `twilioStatusWebhook.test.ts` | GREEN 34/34 and 81/81 (C-3) |
| M3b | M3a + `:494` claim refusal ignored | `retrySendAttempt.test.ts` | RED 2 (6e, 6f send) |
| M4 | `retrySend.ts:494` claim refusal ignored | same | RED 1 (6f: provider called) |
| M5 | `sendReconcile.ts:777` `isRetryRowOf` = same thread only | `sendReconcile.test.ts` | RED 4 (10c, 10c2, 10f, 10g) |
| M5b | `sendReconcile.ts:741-742` another row's SID reads `free` for this owner | same | RED 2 (10c2, 10f); 10c alone stays green |
| M6 | `sendReconcile.ts:1318` WITHDRAW disabled | same | RED 5 (10f, 12, 12a, 12c, 13b) |
| M6b | `retryPromiseWrites.ts:81` patch without `retryOutcome` | same | RED 5 |
| M7 | `sendReconcile.ts:1090` a "same root is lineage" matcher added | same | RED 2 (13b, 13e) |
| M7b | `retryChain.ts:40` the walk no longer stops at a manual row | same | GREEN 151 (the attempt clause still holds) |
| M7c | as M7b | `retryChain.test.ts` | RED 2 (`:122`, `:138`) |
| M7d | `sendReconcile.ts:1087-1088` attempt clause dropped | `sendReconcile.test.ts` | GREEN 151 (C-8) |
| M7e | M7b + M7d | same | RED 2 (13b, 13e) |
| M8a | `api.ts:1672` record-unresolved clause -> false | `apiRoutes.test.ts` | RED 4 |
| M8b | `api.ts:1639` only a manual child supersedes | same | RED 2 |
| M8c | `api.ts:1685` only `attempting` counts as open | same | RED 1 |
| M8d | `api.ts:1671` row belt removed | same | RED 2 |
| M9a | `Timeline.tsx:1441` `!retryUnconfirmed` dropped | `Timeline.delivery.test.tsx` | RED 2 |
| M9b | `deliveryStatus.ts:1192-1198` the promise outranks unconfirmed | `deliveryStatus.test.ts` | RED 1 |
| M9c | as M9b | `Timeline.delivery.test.tsx` | RED 1 |
| M9d | `Timeline.tsx:141-142` `retry_unresolved` copy dropped | `Timeline.test.tsx` | RED 1 |
| M10 | `contactTimeline.ts:462` projection dropped | `contactTimeline.test.ts` | RED 1 |
| M11 | `messagesRepo.ts:2787` `retrychild#` Put disabled | `messagesRepoRetryLineage.integration.test.ts` (DynamoDB Local) | RED 5 |
| M12 | `twilio.ts:3904` back to `log.warn` | `twilioStatusWebhook.test.ts` | RED 1 |
| M13 | `retrySend.ts:458` any child supersedes | `retrySendAttempt.test.ts` | RED 1 (4c) |
| M13b | `retrySend.ts:458` 4a disabled | same | RED 1 (4c) |
| M14 | `retrySend.ts:446` belt read -> false | same | RED 1 (belt case a) |
| M14b | `retrySend.ts:444` belt read on every run | same | RED 1 (belt case b) |
| M15 | `Timeline.tsx:1056` also keyed on the sentinel | `Timeline.delivery.test.tsx` | RED 2 (the WITHDRAWN pin and the RF3 negative) |

Throwaway probes, both deleted:

- T-1 proves C-1.
- T-2 proves C-2.

Item 19 (e2e) was not run: the brief forbids `npm run e2e` and an e2e session.
Its production lines are covered at unit level:

- the hand-off: M1;
- the WITHDRAW: M6, M6b;
- the row belt the e2e press meets: M8d;
- the chip and the hidden Retry: M9a, M9b;
- the projection: M10.

By read, `retry-send-adoption.spec.ts:554-561` would time out without
`retry_outcome`, and `:588-592` would fail on the 409 body.

Baseline before the mutations: `retrySendAttempt`, `sendReconcile` and
`apiRoutes` passed 244/244. The repo, parity and helper suites passed 146/146
against DynamoDB Local, with none skipped.
