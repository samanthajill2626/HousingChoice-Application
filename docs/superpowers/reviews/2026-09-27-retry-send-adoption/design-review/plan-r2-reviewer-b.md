# Plan review R2 - reviewer B (re-review charge)

Plan: `docs/superpowers/plans/2026-09-27-retry-send-adoption.md` revision 2 (bb664f32);
diff read against revision 1 (38526a44). Adjudications: `adjudications.md`
"Plan round 1". Reviewer A's round-1 report read. Repo read-only at main@3dbb5740
code; nothing run.

## Verdict in one paragraph

The revision-2 edits are, with one exception, correct against the real code: I
checked `finish()`, the WITHDRAW short-circuit, the four new job tests, the
12a/12a2 split, the decline vocabulary, the adoption touch block, the re-pinned
exact matches and the two typecheck surfaces line by line and they hold. The
largest problem this round is one BOTH reviewers missed in round 1 and the
revision kept: tests 6b and 4d observe the stale-attempt takeover's reconcile
hand-off in `outbound.delayed`, where it never lands. The rest are LOW: a new
arity slip in T1's helper, placeholder residue the self-review says is gone, a
"no refresh" rule whose reachable case is not the one it was written for,
citation drift, and an imprecise deviation 9. No BLOCKING or HIGH finding. I
concede both contested adjudications.

## 1. [MEDIUM] Tests 6b and 4d look for the takeover's reconcile hand-off where the in-process queue never puts it

What: T4's helper `reconcileEnvelopes = () => outbound.delayed.filter(...)`
(plan :998). Test 6b seeds `claim(ownerOf(row, 1))` at `now - 31 s` and asserts
"one reconcile envelope whose owner.recipientKeyHash is 'c-real'" (plan :1080);
test 4d's first sub-case is the same takeover shape with the window closed
(plan :1076). On the takeover path the handler calls
`handOff(owner, gate.record.attemptedAt, ...)` with the STALE `attemptedAt`
(plan :788), and `handOff` enqueues check 0 with
`reconcileDelayMs(attemptedAt, 0, now())` (plan :932) =
`max(0, attemptedAt + 5 s - now)` (`sendReconcile.ts:156-158`) = 0 for a 31 s
old attempt. `enqueueSendReconcile` turns that into `runAt = Date.now()`
(`sendReconcile.ts:161-163`), `enqueue` computes `delaySeconds` 0
(`jobs.ts:112-114`), and the in-process adapter dispatches a delay-0 job on a
macrotask and does NOT record it in `delayed[]` (`scheduler.ts:165-176`). So
`reconcileEnvelopes()` is empty. Worse, neither case registers a
`send.reconcile` handler, so the deferred dispatch throws "no handler
registered" (`jobs.ts:257-261`); the adapter swallows it and logs ERROR
`in-process deferred dispatch failed` on its injected logger
(`scheduler.ts:198-202`), which in this file is the capture logger (the
`sendReconcile.test.ts:89` setup it copies). Any "no ERROR" assertion in 4d
("not logged window_closed", if written as `atLevel(50)` empty) then fails too.

Test 1 and test 5 are unaffected: their `attemptedAt` is the fresh re-arm, so
the delay is about 5 s and the envelope IS recorded.

Related: T4 "11 (second half)" (plan :1088) hands the job's own recorded check 0
to `runChain(payload)`, which dispatches a NEW check-0 envelope and then
`runNextCheck` picks the ORIGINAL one still sitting in `delayed[]`
(`sendReconcile.test.ts:249-262`). Checks 0-2 each run twice. It converges (the
`recordCheck` fence tolerates its own duplicate, `sendAttemptsRepo.ts:542-548`,
and the late check 2 is superseded after the re-drive claims), so it passes,
but it is not the chain the test claims to drive.

Implies: two red tests against a correct handler, at the task that rewrites the
riskiest code. The tempting "fix" is to give `handOff` a minimum delay, which
would change production timing for exactly the crash-redelivery case the
takeover exists for.

Fix: in 6b and 4d register `recordJobs(SEND_RECONCILE_JOB)` (the
`sendReconcile.test.ts:116-122` stub) before `run(row)` and assert on the
captured payload after `outbound.settle()`. State in the helper's comment that
a takeover's check 0 (and check 1, for an attempt older than 30 s) is
IMMEDIATE. In "11 (second half)", splice the job's own envelope out of
`delayed[]` and run it, instead of rebuilding a payload.

## 2. [LOW] T1's new `appendOutbound` helper does not fit its own call sites or the file

What: revision 2 defines
`async function appendOutbound(fields: {...}): Promise<MessageItem>`, one
parameter, over "`repo` (the real `MessagesRepo` it builds)" (plan :184,
:193-196). Every call site in the same step passes two arguments,
`appendOutbound(repo, { providerSid: ..., providerTs: ... })` (plan :203, :204,
:212). The file's repo is named `messages`, not `repo`
(`messagesRepoRetryLineage.integration.test.ts:35`).

Implies: TS2554 at every call and TS2304 on `repo`. This was introduced by the
revision-2 fix for round-1 finding 16.

Fix: `appendOutbound(fields)` over the file's `messages`, and drop the first
argument at the call sites.

## 3. [LOW] "Every helper is defined" is still not true; the typed-const rule is stated but not shown

What: the self-review's placeholder line (plan :1400) says every file-local
helper a sketch uses is defined in its task.
- `retrySendAttempt.test.ts` (T4) uses `iso` (6e), a facts builder (6e: "facts
  as the job computes them"), `register` / `runChain` / `recordJobs` for the
  reconcile ("11 (second half)"), and `TENANT_PHONE`. None is in T4's helper
  block (plan :988-1010); they exist only in `sendReconcile.test.ts` or T2's
  block.
- T2 test 10 still reads `expect(root.retry_due_at).toBe(iso(...the value set
  above...))` (plan :501).
- The prose says the job's nested helpers bind "the NARROWED consts `const
  attemptsRepo = attempts!` ... and use those" and are typed (plan :882). Only
  `finish` and `refuse` are shown that way. `declineBeforeClaim`, `handOff`,
  `handToReconcile` and `onUnknown` (plan :900-962) are still untyped and use
  the `let attempts`. Pasted literally they give TS7006 (implicit any) and
  TS18048 (possibly undefined), because narrowing of an outer `let` does not
  reach a nested function. Round-1 finding 16's adjudication says this was
  fixed.

Fix: add the missing helpers to T4's block, replace the T2-10 placeholder with
a captured const, and show the four helpers typed over `attemptsRepo`.

## 4. [LOW] `deferOrEnd`'s "no refresh after a lost release" fits the unreachable case and misfits the reachable one

What: revision 2 skips the REFRESH and the "re-scheduled" WARN whenever
`finish(retryable)` returns false (plan :925). `finish` returns false for two
different events (plan :886-891): a LOST fence and a THROWN write.

- **Lost fence:** needs another delivery to take the record over, which needs
  the record stale, i.e. more than 30 s since the re-arm
  (`sendAttemptsRepo.ts:440-443`). A 429 / 20429 comes back well inside the
  30 s provider timeout, so on this path the lost fence is practically
  unreachable. Test 4-lost manufactures it with a mock.
- **Thrown write (the reachable case):** the deferred job was already enqueued
  (ENQUEUE FIRST) and the record is still `attempting` on this run's ref.
  Skipping the REFRESH leaves the webhook's promise. That promise expires
  before a 120 s or 240 s deferred run (attempts 2 and 3), so the bubble offers
  Retry while the route answers 409 `retry_pending` (open record, up to
  15 min).
- **In the lane:** the 10 s backoff is below the 30 s claim TTL. The deferred
  run meets a FRESH `attempting` record, the gate defers it
  (`sendAttemptGate.ts:38`), and the chain strands silently until the sweeper.

Implies: no double send. The screen and the route disagree for a few minutes,
and a lane-only strand goes unnamed.

Fix (either is fine):
- skip the REFRESH only when the write resolved with a lost fence, and refresh
  after a THROW, because the deferred run is real; or
- keep the rule and add the thrown-release strand to T9's
  `send-attempt-sweeper` note.

## 5. [LOW] Citation drift after the relabel

- Review Focus 5 (plan :56) and the self-review (plan :1400) cite "T4 4c/4d" for
  "a `redriven` record whose re-driven job finds the window closed ... closes
  `refused`". Test 4d's second sub-case is a DEFERRAL re-run (`done/retryable`,
  plan :1076), which writes nothing. The re-driven window-closed close is pinned
  in T4 "11 (second half)" (plan :1088).
- The self-review's wontfix row still cites "T4 tests 2, 3, 4a, 7" (plan
  :1382). Test 4a no longer exists; it is 4-cap.

## 6. [LOW] Deviation 9 says "same rule"; for the raw-media seam it is not

What: the adoption attaches the retried row's `media_attachments` when
`record.mediaCount > 0` (plan :593-595). `planRetryMedia` also yields
`mediaCount > 0` for a row with raw `mediaUrls` and no attachments (plan
:397). The job then sends and `sendMessage` persists those raw `mediaUrls`
(`sendMessage.ts:644`). The adoption's row for the same attempt is typed `mms`
(from the provider's count, plan :599) but carries neither `media_attachments`
nor `mediaUrls`. The raw seam is internal/e2e only, so this is harmless, but
the deviation's "same rule, one source of truth" wording overstates it.

Fix: one clause in deviation 9 naming the raw-`mediaUrls` case.

## Contested adjudications

- **A12c (adoption reads `record.mediaCount`, declared as deviation 9)** -
  CONCEDE. The record holds the answer the job actually acted on, and
  re-planning in the reconcile would need the job process's `hasStore`, which
  the reconcile cannot know. Only the wording point in finding 6 remains.
- **B12 (pre-gate strand of a redriven record filed, not fixed)** - CONCEDE. At
  step 1 there is no row to build the owner key from. At step 3 a phone-keyed
  owner has no key without the phone the decline just found missing. The
  reconcile read both a moment earlier, so the case is unreachable in
  practice.

## Revision-2 edits checked and holding

- **`finish()` (plan :886-891):** `wrote && won` is the right predicate;
  `refuse`, the rejected arm and the three terminal `deferOrEnd` closes now
  capture the fence. The rejected arm's ERROR still logs on a lost fence, which
  is correct (the provider did reject).
- **WITHDRAW short-circuit (plan :363-382):** safe. It rests on deviation 1:
  exactly one attempt number exists per retried row
  (`oneToOneRetryDecision.ts:125-129`), and that attempt's record is terminal
  after `unresolved`. So no writer can re-promise a withdrawn row, and a row
  that reads withdrawn IS withdrawn. The four test sub-cases match the code
  path by path.
- **Tests 6e and 6f against the fake:**
  - 6e: `gateFor` defers a 5 s `attempting` record (`sendAttemptGate.ts:38`).
  - 6f: `vi.spyOn(world.sendAttemptsRepo, 'get')` intercepts the gate because
    the job calls the property (`sendAttemptGate.ts:31`). The fake `claim`
    reads its private Map, not `get` (`twilioWebhookHarness.ts:4431`), so it
    still answers `refused, fresh: true` (`:4458-4462`).
- **Test 4-cap:** `throttle()` then `providerCalls()`, in that order, so the
  spy wraps the throwing stub and counts the call `world.sent` cannot. The
  second run is skipped by the gate on `done/refused`.
- **Test 4-lost:** the mocked `finishAttempt` is the first `finishAttempt` of
  that run, because the 429 throws before any other close.
- **12a / 12a2:** match `resolve` and `lookup`.
  - Contact key, phone gone: `retryRecipientKey` returns the contact id,
    `currentPhone` is undefined, and the check closes `digest_mismatch` at
    check 0 (`sendReconcile.ts:769-772`).
  - Phone key, phone gone: the key is undefined, so resolve returns undefined
    and logs INFO (`:387-396`).
  - `seedRow({ recipientContactId: undefined })` does drop the field, because
    the fake `append` writes only defined values (`twilioWebhookHarness.ts:1241-1243`).
- **`conversationRetryDecline`:** reproduces `oneToOneRetryDecision.ts:88-97`
  exactly for every `ConversationType` (`conversationsRepo.ts:44-50`).
- **Adoption touch block:** matches `adoptBroadcastRecipient`'s
  (`broadcastFanOut.ts:1437-1455`). `touchLastActivityPreservingStatus` exists
  on the fake (`twilioWebhookHarness.ts:635`).
- **Re-pinned exact matches:** the only exact `calls` pins are
  `twilioStatusWebhook.test.ts:1706` and `apiRoutes.test.ts:485` and `:614`
  (`:76` is the send route); all three are named.
- **Typecheck surfaces:** exactly four full `MessagesRepo` literals exist (the
  real repo, the harness, `sendMessage.test.ts:256`,
  `scheduledSendSuppression.test.ts:273`), and no test switches on an owner or
  ref kind beyond the four ternaries T2 names.
- **The 1800 s budget:** SOR's 23.2 / 23.7 min runs plus three slow specs
  project to roughly 26 min. That is thin headroom but not a false red. The
  timeout recovery (`e2e:stop`, prove the ports free, re-run once) follows
  AGENTS.md, and `npm run e2e -- <spec path>` is the README's own single-spec
  form.
- **Other paths re-checked:**
  - Import cycle: still reads no binding at module evaluation, under
    `twilio.ts`'s import order (`twilio.ts:120` retrySend before `:140-141`
    the relay jobs).
  - The IAM policy already grants every DynamoDB action the new reads and
    writes use (`infra/modules/ec2/main.tf:44-61`).
  - The dashboard's `.js`-extension import convention keeps `types.ts`'s new
    import resolvable under the app's NodeNext test typecheck.
