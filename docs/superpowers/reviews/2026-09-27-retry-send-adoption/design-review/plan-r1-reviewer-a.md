# Plan review round 1 - reviewer A (adversarial) - retry-send adoption

Plan: `docs/superpowers/plans/2026-09-27-retry-send-adoption.md` (revision 1, @38526a44)
Spec: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` (revision 5)
Code: main@3dbb5740 (read only; nothing run that touches DynamoDB or the e2e harness)

Question asked: if a builder with no context executes this plan LITERALLY, do
they produce the spec? Short answer: yes for the production code - I found no
design defect in the handler, the reconcile's fourth owner, the pointer family,
the route or the dashboard that would ship wrong behavior. The failures are in
the plan's TEST sketches and gate recipe: several sketches are red against a
correct implementation, one existing pin the plan says stays unchanged goes
red, and the e2e gate's hard timeout is very likely too short for the grown
suite. Twelve findings, none blocking.

Severity = consequence if the plan ships unfixed.

---

## 1. [MEDIUM] The e2e gate's `timeout 1500` is almost certainly too short for the grown suite

**What is wrong.** Global Constraints (plan :44), Task 8 Step 2 (plan :1252)
and Task 9 Step 4 (plan :1290) all run `timeout 1500 npm run e2e` (25 min).
SOR's own passing gate runs on this suite at 289 specs took **23.2 m and 23.7 m**
under that same timeout
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handback.md:41`,
`:43`). This plan adds three `test.slow()` specs, each of which pays a lean
reseed, a dev-login, a tenant create, the lane's 10 s backoff, up to 8 s of
reconcile checks and polls of 30-45 s (plan :1206-1249). A realistic cost is
30-50 s each: the suite lands at roughly 25-26 min, i.e. at or past the kill.

**What it implies.** `timeout` kills the run (exit 124) - a false red gate - and
AGENTS.md is explicit that a killed suite orphans its stack and that
`reuseExistingServer` then adopts the orphan on a commit match alone, silently
contaminating the next run. A literal builder retrying the gate repeats the
kill.

**Fix.** Raise the bound (e.g. `timeout 2400 npm run e2e`) in all three places,
and add the AGENTS.md post-abort step: after any killed run, prove the lane's
ports are free before the next one.

---

## 2. [MEDIUM] An existing exact pin goes red at Task 4, while the plan says "Every other site: unchanged assertions"

**What is wrong.** Plan :930 says every `twilioStatusWebhook.test.ts`
registration site other than the five it lists keeps its assertions. But
`app/test/twilioStatusWebhook.test.ts:1706-1716` pins the job's send input
with an EXACT `toEqual`:
`{ conversationId, body, automated, author, retryOf, retryAttempt, retryWindowStart }`.
After Task 4 the job passes `retryRoot` (always) and `beforeProviderSend` (a
function) into `sendMessage` (plan :797-803), so the exact match fails.

**What it implies.** The builder meets an unexplained red in a file the plan
said was mechanically safe, at the task that rewrites the risky handler. The
tempting "fix" is to loosen an assertion without understanding it.

**Fix.** Name the case in Task 4 Step 1: keep the exact field pin with
`retryRoot: seeded.tsMsgId` added and assert
`typeof calls[0].beforeProviderSend === 'function'` separately (toMatchObject
plus the function check), so the pin still proves nothing else leaked in.

---

## 3. [MEDIUM] The rewritten DUPLICATE GUARD case asserts a log line the planned handler never reaches

**What is wrong.** Plan :925 rewrites the marker case to expect, on the second
dispatch of the same envelope, "a `claim refused` INFO line carries
`fresh: false` (the record is `done/sent` - terminal)"; test 6a (plan :1006)
and 4a (plan :985, "claim refused") say the same. But the plan's own handler
resolves the existing attempt BEFORE the claim (step 4, plan :744-747) through
`gateFor`, which returns `skip` for `done` with any outcome but `retryable`
(`app/src/lib/sendAttemptGate.ts:33`). The second dispatch logs
`retrySend: this attempt is already resolved` and returns; `attempts.claim` is
never called, so no `claim refused` line exists.

**What it implies.** A correct implementation fails the test. The builder must
either change the test (fine) or "fix" the handler to reach the claim (wrong:
it would remove step 4, the round-3 HIGH fix recorded in adjudications r3#1).

**Fix.** Assert the gate's line (`this attempt is already resolved`, with
`gate: 'skip'`), and assert that `world.sendAttemptsRepo.claim` was called
once across both dispatches (spy). Keep the `claim refused fresh: true` path
for a genuinely concurrent claim (6a as two overlapping dispatches, or a
pre-seeded fresh `attempting` record, which gateFor answers `defer`).

---

## 4. [LOW] The R9 logging test cannot pass: every line in the job's context carries `conversationId`

**What is wrong.** Plan :1014: "every captured line with conversationId has
retryRoot/retriedTsMsgId/attempt". The logger's mixin injects the live ALS
context into EVERY line (`app/src/lib/logger.ts:245-249`), and `sendMessage`
calls `mergeContext({ conversationId })` (`app/src/services/sendMessage.ts:450`),
which mutates the store in place (`app/src/lib/context.ts:67-70`). From then
on, `jobs.ts`'s own `job enqueued (SQS)` (`app/src/jobs/jobs.ts:125-128`, from
the reconcile hand-off) and `job succeeded` (`:326-329`) lines carry
`conversationId` without `retryRoot` - and the test file configures the jobs
logger onto the same capture (the `sendReconcile.test.ts:83-90` setup it copies).

**Fix.** Scope the assertion to the job's own lines (`msg` starting
`retrySend:`), and keep the no-phone / no-body sweep over ALL lines.

---

## 5. [LOW] Task 2's reconcile sketches pin a conversation id the fake never mints

**What is wrong.** Plan :438 declares `const RETRY_CONV = 'conv-retry-1'`, and
tests 10 (:464) and 11 (:490) assert against it. But `seedOneToOne` (plan :441)
creates the thread through `world.conversationsRepo.createOrGetByParticipantPhone`,
whose fake mints `conv-${++convCounter}`
(`app/test/helpers/twilioWebhookHarness.ts:606`), so the thread is `conv-1`.
`seedRow` never says which conversation id it appends into.

**Fix.** Drop the constant; thread `conversation.conversationId` from
`seedOneToOne` through `seedRow`, `rOwner` and the assertions.

---

## 6. [LOW] Test 12a's second half expects the wrong outcome for the fixture it uses

**What is wrong.** Plan :515: "participant_phone deleted -> resolve returns
undefined -> INFO owner recipient not found, record untouched". With the plan's
fixture (`seedRow` defaults `recipientContactId: 'c-retry'`, plan :443) the
owner's key is the CONTACT id, and the planned `resolve` (plan :531-539) derives
it with `retryRecipientKey(row, conversation)`, which needs no phone
(plan :304-307). Resolve succeeds; `lookup` then gets `currentPhone ===
undefined` and returns `unresolved digest_mismatch`
(`app/src/jobs/sendReconcile.ts:769-772`), which WITHDRAWS. Only a phone-keyed
owner becomes unaddressable. The case is also mislabeled "Review Focus 5"
(RF5 is the redriven closes, plan :54).

**Fix.** Split it: a contact-keyed owner with the phone removed is
`digest_mismatch` + withdrawal; a phone-keyed owner (row without
`recipient_contact_id`) is unaddressable (INFO, record untouched).

---

## 7. [LOW] Test 4a cannot detect the regression it pins

**What is wrong.** Plan :985 proves "a redelivery ... is refused by the record
and sends nothing" with "then run again (still throttled) -> ... world.sent 0".
The `throttle()` stub (plan :948) throws BEFORE the fake would record a send,
so `world.sent` is 0 whether or not the second run reached the provider. A
broken guard that re-claimed and called the provider again still passes.

**Fix.** Count calls on the throttle stub (or assert `claim` was not called /
the record's `attemptNo` is still 1 after the second run).

---

## 8. [LOW] Task 1's re-export leaves `retrySend.ts`'s own uses of the moved constant unbound

**What is wrong.** Plan :165 replaces `export const MAX_SEND_RETRY_ATTEMPTS = 3;`
with `export { MAX_SEND_RETRY_ATTEMPTS } from '../lib/retrySendWindow.js';`.
A re-export declaration creates no local binding, and `parseRetrySendPayload`
uses the name at `app/src/jobs/retrySend.ts:80-81`. Typecheck goes red at
Task 1 Step 1 (TS2304) until the builder also imports it.

**Fix.** Say both: `import { MAX_SEND_RETRY_ATTEMPTS } from '../lib/retrySendWindow.js';`
and `export { MAX_SEND_RETRY_ATTEMPTS };` (the fenced
`app/src/services/oneToOneRetryDecision.ts` imports it from `jobs/retrySend.js`
and must keep resolving).

---

## 9. [LOW] Declared deviation 6 is not what the plan's own code does

**What is wrong.** Deviation 6 (plan :27) says "Every fenced write in this plan
captures the fence answer inside the callback and logs the loss itself". The
job's `refuse` (plan :843), the rejected arm (:829) and all three
`finishAttempt` calls in `deferOrEnd` (:858, :862, :868, :871) pass the write
straight to `guardWrite` and discard the fence answer. `guardWrite` returns
`true` on a resolved-but-lost write (`app/src/lib/guardWrite.ts:8-10`), so a
lost fence there is silent; worse, `deferOrEnd` then REFRESHES the promise and
logs `retry deferred - re-scheduled` for a release that did not land.

**What it implies.** No double send (the record still serializes the
enqueued deferral against a takeover's re-drive), but the log contradicts the
record and the spec's "every guardWrite loss is logged" is not met.

**Fix.** Capture the fence in those five sites; on a lost release in
`deferOrEnd`, skip the REFRESH and log at INFO that the takeover owns the
record.

---

## 10. [LOW] The "no time bound" unresolved guard is proven only against a fake; production reaps the record at 30 days

**What is wrong.** Spec item 15 and plan :1073 test `retry_unresolved` on a
45-day-old record. Attempt records carry a 30-day `expires_at` set at claim and
re-arm (`app/src/repos/sendAttemptsRepo.ts:48`, `:290`, `:399`); no transition
extends it (`:489-584`), and the messages table's TTL is on
(`app/src/lib/tables.ts:236`). In production the record is gone about 30 days
after its last re-arm; the fake world has no TTL, so the 45-day case passes
vacuously.

**What it implies.** After ~30 days the route's refusal rests on the row's
`retry_outcome` belt alone; if the WITHDRAW was lost (`lost` / `failed`,
plan :346-360), a Retry is then allowed on an unresolved row.

**Fix.** No new mechanism (the TTL is SOR's, out of fence). State it: the
test's name should say it proves the route's read has no bound of its own, and
the `send-attempt-sweeper` / `send-reconcile-job-residues` note (Task 9) should
record that the belt is the only guard after the record's cleanup horizon.

---

## 11. [LOW] Task 9's issue mapping mislabels gap 5 and understates the pre-deploy pointer gap

**What is wrong.** (a) Plan :1266 writes that gap 5 of
`manual-retry-double-send-residual-windows` ("An enqueue that THROWS after SQS
actually accepted the job") "stays as ruled". Spec R6 (:464-469) says the
opposite: a job "enqueued by a webhook whose enqueue threw after SQS accepted"
declines at step 4a when a manual retry row exists. The Retry the webhook's
withdrawal exposes appends a manual child; the late job then declines. Only the
in-flight race the spec names stays open. (b) Plan :1269 says pre-deploy
children are missed "for the 15 minutes a chain can straddle the deploy" - true
for step 4a, but the ROUTE's `superseded` check misses a pre-deploy child
forever (a stale tab on a pre-deploy superseded row is unbounded in time).

**Fix.** Map gap 5 as closed by step 4a except the in-flight race; state the
route's pre-deploy gap as unbounded in time (RSW's old behavior, not a
regression).

---

## 12. [LOW] Small spec-conformance gaps a literal build would ship undeclared

(a) **Spec item 15 vs R6.** Spec item 15 (:692) asks for 200 "on a stale
`attempting` (31 s)"; R6 (:453-458) defines stale as older than
`RETRY_SEND_WINDOW_MS` (adjudication r3#5). Plan :1076 silently follows R6. A
31 s record gets 409 `retry_pending` under the plan. R6 is the right reading,
but the plan should declare it as an eighth deviation so the handback's
conformance table does not show an unexplained miss.

(b) **Withdraw re-apply is not a no-op.** Spec R4 (:400-402): the re-apply is
"a no-op when `retry_due_at` is already the sentinel". `withdrawRetryPromise`
(plan :349) conditions on the value read, so on an already-withdrawn row the
first write MATCHES the sentinel and re-writes and re-emits. The plan's own test
(plan :363, "a row already withdrawn -> 'already', no write, spy called once")
is red if the row passed in is current. Short-circuit when the row already
holds both fields, and say which snapshot the test passes.

(c) **Media rule not shared with the adoption.** Spec R1 (:170-175): the media
resolution is "factored into one function the job, the facts and the adoption
all call". `adoptRetry` (plan :558-560) derives from `record.mediaCount`
instead. It is equivalent in effect, but undeclared.

(d) **Decline vocabulary.** Spec R2 step 3 says reuse
`oneToOneRetryDecision.ts`'s vocabulary (`conversation_missing` / `group_text` /
`not_one_to_one`, `app/src/services/oneToOneRetryDecision.ts:57-63`). The plan
invents `no_participant_phone` and folds `group_text` into `not_one_to_one`
(plan :310-316).

(e) **Named helpers that do not exist.** Task 1 Step 2 (plan :181-207) names
`appendOutbound`, `repo`, `T0/T1`, `DUE_1/2` in
`messagesRepoRetryLineage.integration.test.ts`. That file is the RELAY-retry
lineage suite, and its only append helper (`retryRow`, :44-61) builds relay rows
with delivery maps. Task 4's sketch uses `originalSend` and `outboundRow`, and
Task 4's helper closures (plan :842-908) are untyped and close over the `let`
repos, which TS does not narrow inside nested functions. None of this is wrong
in intent, but "every code block a task needs is IN that task" (plan :5) does
not hold. The builder writes these.

---

## Deviations - verdicts

1. R6 reads one record, not three - LEGITIMATE TIGHTENING. Only the webhook
   schedules against a row, always at `(retry_attempt ?? 0) + 1`
   (`app/src/services/oneToOneRetryDecision.ts:125-129`); a deferral and a
   re-drive keep the payload's attempt; a manual row has no `retry_attempt`.
   Same answer.
2. The adapter kill switch is recorded refused - LEGITIMATE. The adapter's
   `SmsSendingDisabledError` is not a `SendRefusedError`
   (`app/src/adapters/messagingErrors.ts:19`) and classifies `rejected`
   (`app/src/lib/sendOutcome.ts:95`); treating it like the service kill switch
   matches the table's intent. It changes only the record label and the log
   level for the backstop path.
3. Consistent read of the retried row - LEGITIMATE (the R3 condition's
   expectation comes from it).
4. The ASCII rewording of the fenced line - LEGITIMATE. The spec's own quoted
   string (spec :525) is already the ASCII form, and nothing matches the old
   string (grep of app/src, dashboard/src, scripts, infra: only
   `twilio.ts:3904`).
5. The WITHDRAW lives in `closeSlot` - LEGITIMATE, observably identical
   (`slotCloseOf` has no owner, `sendReconcile.ts:922`; the superseded exit
   routes through `closeSlot`, `:415-418`).
6. Fence answers captured - LEGITIMATE as stated, NOT IMPLEMENTED by the plan's
   own code (finding 9).
7. `isBroadcastRowFor` ignores retry rows - LEGITIMATE AND NECESSARY. Without it
   a share-RETRY row, which now carries the share's `broadcast_id` and the
   contact's `recipient_contact_id`, would read as `mine` for a pending share
   reconcile's `heldBy` (`sendReconcile.ts:595-602`) and satisfy the dedupe
   check in `adoptBroadcastRecipient` (`broadcastFanOut.ts:1382-1392`). No row
   on main carries both `broadcast_id` and `retry_of` (`retrySend.ts` and the
   Retry route never passed `broadcastId`), so nothing existing moves.

## Checked and found sound (so the next round need not redo it)

- **Test 1 is red on main.** Main's job rethrows the unknown error
  (`retrySend.ts:339`); the in-process adapter swallows it; no record or
  reconcile envelope exists. The TypeScript union also lacks `retry_send`.
- **The deferral `delaySeconds` pin holds.** `enqueue` computes
  `ceil((runAt - now()) / 1000)` (`jobs.ts:112-114`). `runAt` is taken from the
  job's wall clock milliseconds earlier, so the value is 60 unless 1 s or more
  elapses. No test in this setup calls `configureJobsClock`.
- **The hop arithmetic** on plan :38 checks out at exactly 10 on the longest
  path. Exceeding it throws inside `buildEnvelope` (`jobs.ts:166-171`), which
  every planned enqueue treats as an enqueue failure.
- **The import cycle is safe.** No module in `retrySend` <-> `sendReconcile`
  (or the fenced `oneToOneRetryDecision` -> `retrySend`) reads an imported
  binding at evaluation time in the planned code. `npm run smoke` runs only at
  Task 9. Running it at Task 4, which creates the cycle, costs a second.
- **Mutation surfaces for the new state are complete.** `retry_of` is appended
  only through `sendMessage` (the job and the Retry route), so the pointer is
  written for every child. Seeds (`app/src/lib/seed`), dev seams
  (`app/src/routes/dev.ts`), the importer (`app/src/lib/import/apply.ts`) and
  fake-twilio write no retry fields. No message-row PutCommand exists outside
  `append`, so no wholesale write erases `retry_outcome` (all the other
  `messagesRepo.ts` Puts target pointer partitions). The messages table has no
  GSI and no stream consumer (`infra/envs/dev/tables.auto.tfvars.json`; no
  `event_source_mapping` in infra), so the pointer items are invisible outside
  their partition.
- **Readers.** `onRetry` is wired only in `ContactCommsPane.tsx:304-338`, so the
  one-to-one bubble is the only Retry surface. `retry_due_at` readers are the
  route's time guard, the projection and the Timeline. `broadcast_id` readers
  are the webhook rollup (fenced, INFO), `isBroadcastRowFor` and the reconcile
  holder label. The owner-kind branches in app/src are all in
  `sendAttemptsRepo.ts` / `sendReconcile.ts`, all named in Task 2. The four
  test ternaries are the four the plan names.
