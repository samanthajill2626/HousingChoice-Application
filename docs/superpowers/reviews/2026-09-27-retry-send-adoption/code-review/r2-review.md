# Code review round 2 - retry-send adoption

Reviewer: the round-2 code reviewer, Claude Opus 5.5 (1M context),
2026-09-28. Branch `feat/retry-send-adoption`, worktree
`W:\tmp\retry-send-adoption`, HEAD `1b5ddb01` (fix wave FW1 =
`3b05dec3..HEAD`), merge base `3dbb5740`. Read-only on source.

Inputs: the round-2 package (`.superpowers/review/r2-package.txt`),
`r1-conformance.md`, `r1-adversarial.md`, `r1-adjudications.md`,
`fw1-report.md`, spec revision 5, plan revision 4, and the repository.

Evidence:
- The five retry suites at HEAD: 286 passed, exit 0 (section 4).
- Three throwaway probes (P1-P3), run as one file and deleted. Byte-exact
  sources are in the gitignored `.superpowers/review/r2-reference.md`.
- No source mutation. The FW1 revert-red claims were checked by reading the
  tests against the fixes, not by re-running the reverts.

## Verdict

FW1's fixes are real and correctly placed. There is no BLOCKING, HIGH or MED
finding, new or residual. Neither the fix diff nor a fresh sweep of the
branch finds a double text, a lost send or a stranded send on a non-fault
path.

New in this round:
- R2-1 (LOW, CONFIRMED): the job's promise writes can lose their dashboard
  re-render.
- R2-3 (LOW): a test gap in the C-1 rewrite.
- R2-2, R2-4, R2-6: three NOTEs.

Two rulings are challenged at LOW:
- R2-5: A-1's documentation action contradicts spec section 5 and plan
  Task 9.
- R2-7: A-3's rejection rests on a false premise. A one-line alternative
  exists; choosing it is Cameron's call.

Conformance after FW1:
- C-1 closes R2-7, R2-12a and RF5.
- C-2's reconcile half closes R4-9.
- S0-3 stays PARTIAL only through the filed job half of C-2.

From code review, the branch can proceed to Task 9 and the handback. R2-1 is
a small fix-now-or-file decision.

## 1. What round 1 missed

### R2-1 - LOW - CONFIRMED - a replayed promise write loses its re-render

**Surface.**
- `app/src/services/retryPromiseWrites.ts:93`: the WITHDRAW's fresh-read
  branch answers 'already' and returns with no emit.
- `app/src/services/retryPromiseWrites.ts:57-59`: a REFRESH whose condition
  failed is "dropped", also with no emit.
- `app/src/repos/messagesRepo.ts:3388-3426`: `annotateRetryPromise` is a
  plain conditional UpdateItem with no op token. A condition failure comes
  back as false (`:3413`).
- The callers that have no other emit:
  - `app/src/jobs/retrySend.ts:786-792`: the hand-off enqueue-failure close.
  - `:844-850`: the second-unknown close.
  - `:796-801`: the hand-off REFRESH.
  - `:747`: the deferral REFRESH.

**Failure.** The AWS SDK retries an UpdateItem whose first try committed but
whose response was lost. The replay then fails its own condition.
`sendAttemptsRepo.ts:19-29` names this exact case and guards against it with
its `last_op` token (`:490-519`). The promise writes have no such guard.

WITHDRAW, in the job's two unresolved closes:
- The retry-once re-reads the row and finds the sentinel and the outcome this
  call wrote itself. It answers 'already'.
- The close line says "withdrawn", which is correct.
- But no `message.persisted` is emitted for the retried row. The reconcile's
  unresolved close does not have this problem, because `afterClose` emits
  anyway (`app/src/jobs/sendReconcile.ts:1422`). The job's closes have no
  afterClose.
- Result on screen: the open bubble keeps "will retry" until its old promise
  lapses on the client ticker. It then shows the plain 30003 failure WITH
  Retry. A press answers 409 `retry_unresolved` (the right sentence), but the
  screen is wrong until the next refetch.

REFRESH, in the hand-off and the deferral:
- The new promise lands, but the helper logs "retry promise refresh dropped
  - a newer promise stands" and emits nothing.
- The client keeps the webhook's older promise. Once that lapses, the bubble
  offers Retry while the server's refreshed promise answers 409
  `retry_pending`. This lasts about 2 minutes: from the old promise's expiry
  until the reconcile's close, or the deferred run, emits. This is A-4's
  flicker without a crash.

The server state and the route stay correct; only the live render lags. It
needs an SDK replay, hence LOW rather than MED.

**Evidence.**
- Probe P1 (job second-unknown; the WITHDRAW's first write commits, then
  answers false):
  - the record is `done/unresolved/second_unknown`;
  - the row holds the sentinel and `retry_outcome`;
  - there is ONE close ERROR, "... the retry promise is withdrawn";
  - there are zero `message.persisted` events for the row.
- Probe P3 (hand-off REFRESH; commits, then answers false):
  - the record is `reconciling`;
  - `retry_due_at` moved;
  - there is one INFO "refresh dropped";
  - there are zero emits.
- Both probes pass, which means the gap is present.

**Fix (small).** Emit `message.persisted` for the retried row on every exit
of both helpers. The event carries ids only and the client refetches the
stored value, so an extra emit can never show a wrong state. A narrower
option: emit on the fresh-read 'already' branch, and have the job's
unresolved close emit the way `afterClose` does. If not fixed, file it
beside the A-4 note in `send-attempt-sweeper`.

## 2. The FW1 diff, reviewed cold

### C-1 (`retrySend.ts:687-692`)

- **Placement.** Both callers run before the claim (`:497`) and outside the
  try (`:517`): 4a at `:461-466`, 4b at `:468-481`. Within one delivery
  nothing is sent before `:497`, so the new throw can never follow a send.
- **No earlier send by another delivery.** A `redriven` record means no claim
  of this attempt has happened since the re-drive, because a claim moves the
  record to `attempting`. So no other delivery's send precedes the throw
  either.
- **What a redelivery finds, by record state:**
  - still `redriven`: the idempotent decline re-runs;
  - `done/refused` (the close committed and then threw): the gate skips
    (R2-2);
  - `attempting` (another delivery re-claimed it in between): defer or
    taken_over, as for any delivery.
- **Fence.** `closeRedriven` is fenced on `redriven` alone
  (`sendAttemptsRepo.ts:615-621`). There is no ABA: `markRedriven` needs
  redriveCount 0 (`:587-593`), so a re-driven record can never become
  `redriven` again.
- **Persistent fault.** Five receives, then the DLQ page. This is intended
  (FW1 report item 2). The hermetic lane never redelivers, so there the
  record strands, as before FW1.

### C-2 (`sendReconcile.ts:1308-1333`)

**Every caller of `closeSlot` with `SEND_UNCONFIRMED_CODE`:**
- (a) `closeUnresolved` (`:1402-1423`), reached from three places:
  - the unresolved verdict (`:579-581`);
  - `enqueueOrClose`'s reconciling branch (`:1446-1448`);
  - `redrive`'s second_unknown (`:1619-1622`).
- (b) The superseded exit (`:528-532`).

**What a throw skips, and what the redelivery sees.**
- A throw skips `afterClose` and therefore its emit. The WITHDRAW itself
  emits only on 'written'.
- The failed delivery has already logged the verdict once, because the ERROR
  precedes `closeSlot` (`:1417-1421`).
- The redelivery finds `done/unresolved` for its own attemptedAt. It logs the
  superseded INFO, re-applies the WITHDRAW, then runs `afterClose`. It logs
  no second verdict.

**Paths that cannot throw.**
- `ENQUEUE_FAILED_CODE` (`:1464`) and `REDRIVE_REFUSED_CODE` (`:1595`) are
  no-ops for this owner, so the never-sent closes cannot throw.
- The 'already' path does not throw. This is pinned: `sendReconcile.test.ts`
  test 12 re-delivers the check after a successful WITHDRAW (`:3548-3550`).

**No deterministic DLQ loop.**
- 'failed' on a vanished row (`retryPromiseWrites.ts:89-92`): on
  redelivery, `resolve` returns undefined (`sendReconcile.ts:626-627`), so
  the check logs INFO and does not throw.
- 'lost' needs a writer that moves the promise AFTER an unresolved close.
  None exists:
  - the retried row's transition is terminal and forward-only
    (`messagesRepo.ts:134-143`);
  - every refresh is conditioned on a read taken before the close;
  - a `done/unresolved` record is never claimed again.

**The job's rule still holds.** The job never calls `closeSlot`, so "nothing
throws after the claim" is intact.

### C-5 (`retrySend.ts:778-792`, `:836-850`)

- Each close logs exactly one close line.
- A faulted close or WITHDRAW adds the fault's own ERROR (guardWrite's or the
  helper's). That count is the same as before FW1.

### C-3, C-4, C-10, the A-1 comment, A-6

Correct as written.

### The FW1 tests

- Each fails on its own revert by construction, matching the FW1 report's
  revert runs:
  - C-1, C-2: `rejects` against a dispatch that would resolve;
  - C-4, C-5: the pinned message text;
  - A-6: the record key.
- The harness fake returns LIVE rows (`twilioWebhookHarness.ts:1339-1348`,
  `:1486-1488`), so a stale snapshot can never arise there. The FW1 tests
  handle this correctly:
  - the lost-condition cases use spies (`sendReconcile.test.ts:3662`; the
    C-5 cases at `retrySendAttempt.test.ts:1165`, `:1212`);
  - the C-5 'already' case seeds the live row, which is fine for a test of
    the message branch.

### R2-2 - NOTE - CONFIRMED - a C-1 close that commits and then throws loses its decline line

**Surface.** `retrySend.ts:474-480` (the 4b ERROR is logged after the
close); `:431-434` (the redelivery's gate skip).

**Failure.**
- `closeRedriven` commits, yet its SDK call still throws: every retry after
  the commit failed on a non-condition error. The op-token re-read only
  covers a condition failure (`sendAttemptsRepo.ts:505-517`).
- The delivery fails and logs "job failed".
- The redelivery meets `done/refused` and skips at INFO. The ONE "retry
  window closed" ERROR that R9 asks for is never logged. The same applies to
  4a's INFO.

**Evidence.** Probe P2: the ERRORs are exactly
`['job failed: messaging.retrySend']`, plus one gate-skip INFO.

**Fix.** None required. Name it in the handback beside FW1 report item 2.

### R2-3 - LOW - PLAUSIBLE - the C-1 rewrite's "lost" branch is untested

**Surface.** Three untested branches:
- `retrySend.ts:689-691`: `closeRedriven` resolves false, INFO "decline not
  recorded";
- `:509`: takeover lost;
- `:821`: hand-off fence lost.

No retry-job test asserts any of these lines (grep). The same strings in
`broadcastFanOut.test.ts` and `relayFanOut.test.ts` belong to those jobs'
own lines. The two C-1 tests cover only a true close and a throw.

**Failure.** A regression that treats a false close as closed, or throws on
it, stays green.

**Fix.** One case per branch, using a spy that resolves false. Or name the
three branches as untested in the handback.

### R2-4 - NOTE - the WITHDRAW's ERROR line in the reconcile is now misworded and misses the reconcile's fields

**Surface.** `retryPromiseWrites.ts:101-104`, reached through
`sendReconcile.ts:1328`.

**Failure.**
- Since C-2, the line still reads "failure-arm write failed (best-effort);
  the attempt record decides". But the failure now FAILS the check, so it is
  no longer best-effort.
- Its context is `ownerLog(r.owner)` only. It carries no
  `event: 'send_reconcile'`, `recipientKey` or `checkNo` (R9's field set).
- So a filter on the reconcile's event misses this line. The e2e item-19
  filter counts only the verdict.

**Fix.** Pass the check's `base` as the context at `:1328`. Optionally, give
the reconcile caller its own message.

## 3. Round-1 rulings

### A-1 (REJECT the code change): AGREE

Three sections of the spec decide this: section 0 (lines 68-72), R4 (lines
377-390) and section 7 (lines 751-755). Writing the sentinel on those exits
would be the early withdrawal Cameron ruled wontfix.

### R2-5 - LOW - A-1's documentation action contradicts the approved contract

**Surface.** The ruling at `r1-adjudications.md:42` says "Task 9 adds a
dated note to one-to-one-retry-promise-outlives-job-decline". That
contradicts:
- spec section 5 (lines 738-739): "stays wontfix, untouched";
- plan Task 9 (line 1372): "UNTOUCHED (wontfix respected)".

**Failure.** Task 9 would edit a file that the approved spec and plan
freeze, with no declared deviation.

**Fix.** Record the longer tails without touching the wontfix file:
- hand-off REFRESH: live up to attemptedAt + 480 s;
- re-drive REFRESH: live up to now + 300 s.

Put them in the handback's Cameron-eye list and in
`send-reconcile-job-residues`. Alternatively, declare the edit as a
deviation for Cameron.

### A-2 (REJECT; ACCEPT-DOC): AGREE

Spec R6 names this residual (lines 464-482).

### R2-6 - NOTE - A-2's residual is wider than "the manual send's duration"

**Surface.** `api.ts:1774-1780` answers only `SendRefusedError`. An unknown
provider outcome, or `SendAcceptedNotRecordedError`, is rethrown as a 500
and leaves no row. Meanwhile the job's step 4a sees only appended rows
(`retrySend.ts:461-466`).

**Failure.**
- A late job (its promise has lapsed) meets a manual press whose own outcome
  is unknown, or was accepted but never recorded.
- No manual row ever appears, so the job claims and sends. A second text is
  possible.
- The overlap has no time bound. Spec R6 bounds it by the manual send's
  duration, which does not hold here.

**Fix.** The dated note in `manual-retry-double-send-residual-windows`
should say so. The work that closes it is the manual route's own adoption
(SOR Stage 2).

### A-3 (REJECT; the fence): the premise is wrong

### R2-7 - LOW - A-3's rejection premise is false: one fenced line can remove both costs

**Surface.** `twilio.ts:3529` (the rollup's call site), `:3898`, `:3904`;
the ruling at `r1-adjudications.md:44`.

**Failure.**
- The ruling says (2) "cannot be split inside one line", because
  `rollIntoBroadcast` does not receive `retry_of`. But the CALL SITE holds
  the row. Adding `&& message.retry_of === undefined` to `:3529` is one line.
- That guard skips the rollup for every retry row. No slot can ever match a
  retry row (`:3887-3888`), and before this branch no row with `retry_of`
  carried `broadcast_id`. So the guard exactly restores main's rollup
  behavior for retry rows.
- It removes cost (1): two broadcast reads and a 2.5 s sleep on every sent,
  delivered or failed receipt of a share-retry row.
- It also removes cost (2): the give-up line stays at WARN for a genuine miss
  on a share's own row.
- It is a different line from the log-level change Cameron named (spec lines
  60-61), so it needs his decision.

**Fix.** Put the two one-liners side by side in the handback's Cameron-eye
item. No code change without his yes.

### ACCEPT-DOC rulings

- **C-2 job half: AGREE.** A gate-skip re-apply would be the only way back
  in, because the job returns normally and SQS deletes the message. The tail
  is 30 days of a refused Retry, then a pressable row once TTL reaps the
  record. The Task 9 sweeper note already names it. R2-1 touches the same
  two closes.
- **C-6: AGREE.**
- **C-7: AGREE, and the case is unreachable, not just rare.** A one-to-one
  thread's `participant_phone` is never rewritten; the only rewrite is the
  relay open (`conversationsRepo.ts:2158`).
- **C-8, C-9: AGREE.**
- **A-4, A-5: AGREE.**
- **A-6, the refactor half: AGREE.** The job and the route call the same
  `retryRecipientKey` on the same inputs, and the route's phone-keyed key is
  pinned at `apiRoutes.test.ts:1034`.

## 4. Are the FW1 fixes real?

Yes.

- **HEAD suites:** `retrySendAttempt` 41, `sendReconcile` 153, `apiRoutes`
  59, `retryPromiseWrites` 11, `retryChain` 22. That is 286 passed, exit 0.
- **C-1:** the throw propagates (both C-1 tests reject), and the redelivery
  closes the record `done/refused` with its cause. P2 covers the
  commit-then-throw state.
- **C-2:** the check fails, and the redelivery re-applies the WITHDRAW
  through the superseded exit with one verdict ERROR in total. A duplicate
  delivery answering 'already' does not throw.
- **C-3, C-4, C-5, A-6:** as pinned.
- **ASCII:** 0 non-ASCII bytes on added lines, branch-wide.
- **Scope:** FW1 touched only the four files it names.

## Swept and clean

**The job (`retrySend.ts:331-855`):**
- Every exit before the claim and every arm after it. Nothing throws after
  the claim; every failure-arm write goes through guardWrite or a
  never-throwing helper.
- SQS redelivery at every point, including the new pre-claim throw.
- The takeover, both in the gate and at step 5.
- The deferral's enqueue-first ordering with a lost or failed release: a
  pending envelope beside a takeover's reconcile still serializes on the
  record.

**Concurrency and budget:**
- Two envelopes on one attempt (a deferral plus a re-drive; a redelivered
  original): every claim is conditional, so there is at most one send per
  claim.
- Hop budget: the longest chain (deferral, three checks, re-drive, a
  re-driven deferral, then a crash takeover with three more checks) peaks at
  hop 10 and attempts no enqueue at hop 11.

**The reconcile's retry_send arms:**
- resolve: consistent row, eventual thread, hash check.
- heldBy and rowIsMine.
- adoptRetry: a dedupe answers skipped or other; one audit row; the touch;
  the emit; no promise write.
- The lineage exclusion: a predecessor always has a row, so heldBy answers
  "other"; in production, attempt 2 and later never overlaps a predecessor's
  window.
- closeSlot and afterClose.
- The re-drive: window check first, `markRedriven` fenced, refresh after the
  enqueue.

**The promise and the row fields:**
- Promise writers: the webhook transition (terminal, once), webhook D7 (the
  scheduling request only), and the two helpers. No refresh can land after a
  withdraw.
- `retry_outcome`: written only by the WITHDRAW; read by the route belt, the
  projection (only 'unconfirmed') and the dashboard; never on relay rows.
- `retry_root` and `broadcast_id`: every reader checked:
  - `twilio.ts:3529`;
  - `isBroadcastRowFor` and `rowHolder`;
  - `predecessorMatchers`;
  - the three appenders.

  No dashboard or script reads either field.
- `retrychild#`: written only inside the append transaction, after the SID
  pointer, so the dedupe attribution is intact. No scan, stream consumer or
  delete path over the messages table reads it, and no message-row delete
  path exists.

**The route:**
- Guard order follows R6.
- Every new read fails closed: a throw means 500 and no send.
- The key is the job's (same helper, same inputs).
- Every read is bounded.

**The dashboard:**
- Only `ContactCommsPane` passes `onRetry`; the relay, placement and tour
  timelines pass none.
- Chip precedence: unconfirmed, then promise, media, relay, base.
- Both 409 sentences are ASCII.

**Logs:** no new line carries a phone or a body; keys go through
`safeRecipientKey`.
