# Plan review R3 - reviewer B (re-review charge)

Plan: `docs/superpowers/plans/2026-09-27-retry-send-adoption.md` revision 3 (cddc0505);
diff read against revision 2 (bb664f32). Adjudications: `adjudications.md` "Plan
round 2". Repo read-only (code identical to main@3dbb5740); nothing run.

## Verdict

This round finds NOTHING that changes what gets built in code. Every
revision-3 edit I was charged with holds against the real in-process queue
(`app/src/adapters/scheduler.ts`) and the real fake
(`app/test/helpers/twilioWebhookHarness.ts`). That covers:
- the const bindings of the lazy deps;
- `finish()`'s three-way answer and `deferOrEnd`'s 'failed' branch;
- the T4 helper block;
- the rewritten tests 1, 6b, 4d, 4-lost and 11 (second half);
- the adoption's raw-`mediaUrls` branch;
- the Task 1 sketch fixes.

The fresh sweep found one spec obligation the plan does not carry: a
handback/issue line, not code. Two test-sketch precision items remain. All
three are LOW. I do not contest either round-2 decision change. By the
charge's own rule this is the terminal round.

## 1. [LOW] Spec section 6's "the hosted-dev checks cover this owner too" is not carried anywhere

What: spec section 6 (Post-merge obligations) says "The hosted-dev checks SOR
owes (`send-reconcile-hosted-dev-checks`) cover this owner too." Nothing in
the plan carries that sentence:
- T9's issue list names six files (plan :1365-1371), and
  `send-reconcile-hosted-dev-checks` is not one of
  them.
- The handback's post-merge line reads "post-merge: NONE infra; the human sets
  `retry-send-lost-under-job-marker` resolved at merge; share-skip Branch B
  starts after this merges" (T9 Step 5, plan :1396).

That issue's item 1 is the open double-text risk: a message still queued at
Twilio may be absent from the list at all three checks. It would then be
ruled `never_sent` and re-driven (`docs/issues/send-reconcile-hosted-dev-checks.md`,
item 1; status `open`). The one-to-one retry's reconcile now takes exactly
that path: never_sent, then a re-driven `messaging.retrySend`.

Implies: a merge reader of the handback is told nothing is owed, while an
unverified provider fact now also gates whether a 30003 retry double-texts a
tenant.

Fix: T9 adds a dated note to `send-reconcile-hosted-dev-checks.md` saying that
the `retry_send` owner inherits items 1-5, with the re-drive at
`enqueueRedrive`'s `retry_send` arm. The handback's post-merge section names
the owed checks beside "NONE infra".

## 2. [LOW] The multi-sub-case job tests must use a fresh row per sub-case; the fake keeps records across them

What: each case below runs two sub-cases inside ONE `it`, and the fake world
persists the attempt record between them (the Map at
`twilioWebhookHarness.ts:4405`).

- **4-lost** (plan :1086):
  - Sub-case 1 mocks `finishAttempt` to resolve `false`, so the release is
    never written and the record stays `attempting` on the run's fresh re-arm.
  - If sub-case 2 reuses that row, the step-4 gate sees a FRESH `attempting`
    record and answers `defer` (`sendAttemptGate.ts:35-38`).
  - Sub-case 2 then never reaches the provider or the release. Its "deferred
    envelope, refreshed promise, two ERRORs" assertions fail for a fixture
    reason.
- **4d:** sub-case 1 leaves the record `reconciling` (the takeover). A
  sub-case 2 that seeds `done/retryable` on the same owner needs a new row.
  The two seeds cannot share one record.

Fix: say "a fresh row (a new SID) per sub-case" in both sketches. Also create
`providerCalls()` per sub-case, or reset it with `mockClear()`.

## 3. [LOW] The thrown-release ERROR claims more than it knows

What: `deferOrEnd`'s new 'failed' branch logs
`retry re-scheduled but its record release threw - the record stays
attempting ...` (plan :939). `finish()` returns 'failed' for
ANY throw out of `guardWrite` (`guardWrite.ts:22-28`). The repo's `transition`
recovers only a REPLAYED ConditionalCheckFailed through its op token
(`sendAttemptsRepo.ts:468-481`). A request that committed and then lost its
response to a timeout or 5xx on every SDK retry therefore still throws. In
that case the record is `done/retryable`, and the deferred run simply claims
from it (`sendAttemptsRepo.ts:428-433`).

Implies: the REFRESH decision is right either way: the deferred job is live in
both readings. Only the sentence overstates.

Fix: "the record may still be attempting".

## Round-2 decision changes, re-examined (not contested)

- **A thrown release refreshes the promise.** RIGHT. The deferred job was
  enqueued first and is live.
  - Prod: backoff is 60/120/240 s (`retrySend.ts:54-56`), past the 30 s claim
    TTL (`sendOutcome.ts:29`). The deferred run meets the record stale; the
    gate takes it over (`sendAttemptGate.ts:35-36`); the takeover's `handOff`
    refreshes again to `attemptedAt + 240 s + 120 s`. The reconcile then
    re-drives, and that refresh covers the re-drive. So the promise stays
    live along the whole path, and the bubble and the route's record guard
    agree.
  - Lane: the 10 s backoff is under the TTL, the gate defers, and the record
    strands. The ERROR says so ("else a strand for the sweeper").
  - A LOST release still refreshes nothing. That is also right: the takeover
    owns the record and its `handOff` refreshes.
- **The adopted row replays raw `mediaUrls`.** RIGHT. It fires only when the
  record says media went (`record.mediaCount > 0`) AND the retried row has no
  durable attachments. That is exactly the case `planRetryMedia` sends raw
  `mediaUrls` for (rev 3 T1 Step 7), and `sendMessage` persists that input
  verbatim (`sendMessage.ts:635`, `:644`).
  - A normal MMS row carries both presigned `mediaUrls` and
    `media_attachments` (`sendMessage.ts:644`, `:648`); it takes the
    attachments branch, so no presigned URL is ever copied (spec R4).
  - A legacy `media_s3_keys` row is covered by `mediaAttachmentsOf`'s
    fallback (`messagesRepo.ts:1251-1259`) on both the job side and the
    adoption side.

## Revision-3 edits checked and holding

- **The lazy const bindings.**
  - `const attemptsRepo = (attempts ??= createSendAttemptsRepo(...))`:
    TypeScript types a `??=` expression as the non-nullish left operand or the
    right operand, so each const has its repo type. The `??=` constructs only
    when the `let` is unset, inside the handler, so creation stays lazy on the
    first run and is reused afterwards (the existing `retrySend.ts:167-168`
    pattern).
  - Two handler-body calls still pass the `let`s: `resolveRetryRoot(messages,
    ...)` and `gateFor(attempts, ...)`. Both compile. The narrowing after
    `??=` holds within the same function across awaits, exactly as today's
    `retrySend.ts:168-212` does. This is cosmetic only; the nested helpers
    all read the consts.
- **`finish()`** answers 'won' | 'lost' | 'failed' correctly off `guardWrite`'s
  resolved flag and the captured fence. `refuse`, the rejected arm and the
  terminal deferral closes ignore the answer, which is correct: each logs its
  own outcome line.
- **Test 1.** A fresh attempt's check 0 is delayed about 5 s:
  `reconcileDelayMs` (`sendReconcile.ts:156-158`) is about 4990 ms, so
  `enqueue`'s `ceil` gives 5 (`jobs.ts:112-114`). The envelope lands in
  `outbound.delayed` (`scheduler.ts:179`) and `reconcileHandOffs` finds it.
  No swallowed ERROR, so `atLevel(50)` stays empty.
- **Test 6b and 4d sub-case 1.**
  - A 31 s-old attempt's check 0 has delay 0, so the adapter dispatches it on
    a macrotask (`scheduler.ts:168-176`).
  - `run()`'s `settle()` drains in-flight work, including dispatches enqueued
    during draining (`scheduler.ts:212-216`), so the `recordJobs` stub
    catches the payload.
  - The takeover's `handOff` refreshes the promise to `now - 31 s + 360 s`,
    which satisfies "refreshed".
- **Test 11 (second half).**
  - Check 0 is spliced from `delayed` and dispatched once. Checks 1 and 2 are
    delayed about 30 s and 240 s off a fresh `attemptedAt`, so no duplicate
    check runs.
  - The re-drive is an immediate `enqueueSendRetry(..., new Date())`, drained
    by the `settle()` inside `runReconcileChain`.
  - The re-driven job claims from `redriven` with attemptNo 2
    (`sendAttemptsRepo.ts:434-438`) and sends through the restored
    `originalSend`.
- **Test 4-lost sub-case 2.** `mockRejectedValueOnce` hits the release (the
  429 throws before any other close). `guardWrite` logs one ERROR; the branch
  logs the second. The record stays `attempting` in the fake, because the
  mock prevented the write.
- **`recordJobs` / `registerReconcile`.** No case registers both on
  `SEND_RECONCILE_JOB`: 6b, 1 and 4d use the recorder, 11 uses the real
  reconcile. A second `defineJobHandler` on the same name would throw
  (`jobs.ts:199-204`).
- **Task 1 sketch.**
  - `appendOutbound(fields)` over the file's `messages`
    (`messagesRepoRetryLineage.integration.test.ts:35`), with one argument at
    every call.
  - `ONE_CONV` avoids shadowing the file's own `CONV` (`:40`).
  - `randomUUID` is already imported (`:9`). `vi`, `MessageItem`,
    `RETRY_PROMISE_WITHDRAWN_AT` and `retryChildPk` are ordinary import
    additions.
- **The fresh sweep's other checks.**
  - No test helper registers the retry job, so no webhook suite reaches the
    new handler with lazy real repos. Only `registerHandlers.ts:59` and the
    18 sites in `twilioStatusWebhook.test.ts` register it.
  - The 409 codes `superseded` and `retry_unresolved` collide with no
    existing `sendFailureMessage` case (`Timeline.tsx:88-139`).
  - A claim that loses a `TransactionConflict` throws before any send
    (`sendAttemptsRepo.ts:367-376`), which is a clean redelivery under R2.
