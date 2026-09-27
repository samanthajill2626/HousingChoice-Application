# Plan review round 1 - reviewer A (adversarial)

Plan: `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md` (HEAD df0b5353).
Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md` revision 9.
Method: every spec decision walked to its delivering task; every claim about
existing code checked against the worktree at df0b5353 (file:line cited are
ones actually read). Nothing edited except this file; no suite run.

Question asked of each task: executed LITERALLY by a builder with no context,
does it produce the spec?

Severity is consequence-if-shipped-unfixed.

---

## 1. [HIGH] A second `unknown` after a re-drive is never closed `unresolved`; the recipient strands in `reconciling` for ever

**What is wrong.** D13a: "a re-drive attempt whose outcome is `unknown` again
goes to `done` / `unresolved` directly, with no second reconcile, so a
`never_sent` verdict with `redriveCount` already 1 cannot arise." D16 names
"second unknown after a re-drive" as an `unresolved` cause. Sec 8 test 10
requires "a re-drive attempt that comes back `unknown` closes `unresolved` with
no reconcile".

No task delivers it. A grep of the plan for `redriveCount` finds only the
record type, the key shape, the repo expression and two repo tests (plan lines
147, 948, 966, 989-998, 1091, 1099, 1266). The send-site `unknown` arms hand
EVERY unknown to reconcile unconditionally:
- Task 7 behavior block: "unknown: handToReconcile(ref) ; enqueueSendReconcile(...)" (plan :1481).
- Task 8 phase block: "unknown: handToReconcile(ref); return { kind: 'handed_to_reconcile', ... }" (plan :1647).
Neither consults the claim result's `redriveCount`.

**What happens instead.** Re-drive pass -> claim (`redriven` -> `attempting`,
redriveCount stays 1) -> Twilio times out again -> `reconciling` -> reconcile
lists, finds nothing -> `never_sent` -> Task 10 broadcast handler:
"`markRedriven` (false -> a duplicate: return)" (plan :1839). `markRedriven`
is conditioned on `#rc = :zero` (plan :1217-1220), so it returns false, and the
handler returns silently. The record stays `reconciling`, the slot stays
`queued` with no code, no ERROR is logged. On a broadcast, D16a's rebuilt
finalize returns early while any slot is `queued` (plan :1495), so the share
reads "Sending" for ever. On relay the leg reads "Sending..." until D20a ages
it. A stale `attempting` record with redriveCount 1 taken over (D8a) meets the
same dead end.

**Implies.** Guarantee 2 ("reaches a terminal state") is broken on a reachable
path - a Twilio outage that outlasts one reconcile window - and Sec 8 test 10
has no test in any task (the self-review's mapping "T10(8,9,10,11)", plan
:2258, is not backed by a case in Task 10's list :1850-1868). The plan must say
where the redriveCount check sits (send-site unknown arm and takeover) and what
it writes (record `done`/`unresolved` cause `second_unknown`, slot
`send_unconfirmed`, one ERROR, finalize), and add the test.

---

## 2. [HIGH] `never_sent` followed by a failed re-drive enqueue cannot be closed `enqueue_failed` with the interface the plan defines

**What is wrong.** D11/D13a: a `never_sent` verdict moves the record to
`redriven` THEN enqueues; "Any enqueue that throws inside the reconcile job ...
closes the recipient `enqueue_failed` on the spot when the verdict was
`never_sent`". Task 10 follows that order ("never_sent: markRedriven ... ->
enqueue(...)", plan :1839) and says "any enqueue THROW inside the job -> catch
-> the verdict was never_sent ? closeEnqueueFailed : ..." (plan :1803).

But the shared interface (plan :165-166) gives only:
- `closeFromReconcile(...)` conditioned on `#st = :reconciling AND #at = :at`
  (plan :1221-1224) - false once `markRedriven` has run;
- `closeRedriven(owner, { outcome: 'refused' | 'redrive_refused' })` - the
  type excludes `enqueue_failed`.

**Implies.** As typed, the record strands in `redriven` after the slot is
closed. Task 10 case 17 ("an enqueue that throws after `never_sent` closes
`enqueue_failed`", plan :1867) cannot pass without a builder inventing an
interface change; two builders will invent different ones (widen
`closeRedriven`, reorder enqueue before `markRedriven` - which the spec
forbids - or leave the strand). A stranded `redriven` record is also exactly
what the Stage 2 sweeper is told to act on ("a `redriven` record no
continuation lists", spec Sec 9), so a sweeper built on this record would
re-drive a recipient whose slot already says `enqueue_failed`.

---

## 3. [HIGH] Task 5's `transition()` sends the full nine-alias name map to every UpdateCommand; DynamoDB rejects unused aliases, so every record transition throws

**What is wrong.** Plan :1091 defines `N` with nine aliases (`#st #no #at #rc
#ck #sid #oc #ca #exp`), and `transition(owner, update, condition, values,
names = N)` (plan :1188) is called with the default by every method
(`finishAttempt`, `handToReconcile`, `takeOver`, `recordCheck`,
`markRedriven`, `closeFromReconcile`, `closeRedriven`, plan :1201-1228). None
of those expressions uses all nine names (e.g. `recordCheck` uses only `#ck`,
`#st`, `#at`).

**Evidence that this fails.** The repo proves DynamoDB rejects an unused
ExpressionAttributeNames entry: `app/test/aiRunsRepo.integration.test.ts:302-316`
("An ExpressionAttributeNames entry that no expression references is a real
ValidationException", asserted `/unused in expressions/i`). The repo's own
writers build the name map per statement for this reason
(`app/src/repos/messagesRepo.ts:3500-3575`, `applyRecipientSendResult`).
The same trap is set for Task 6's `closeRelayRecipientIfUnsent`, whose two
statements are given one collective name list "Names: `#dr` ..., `#mk` ...,
`#st` ..., `#ec` ..., `#sid`" (plan :1373) while the second statement uses only
`#dr`/`#mk`.

**Implies.** Task 5 Step 3's "PASS (9 tests)" is false as written; every
unit test over the harness fake would still pass (the fake cannot see
expression validation - `app/test/broadcastsRepo.integration.test.ts:1-7`
says so), so only the DynamoDB Local suites catch it. The code block must
build names per call.

---

## 4. [HIGH] PREPARE-phase throws and relay failure-arm throws still exit the loop; the anchor bug survives for them, and Sec 8 test 4's first clause is untested

**What is wrong.** D7a: "Nothing in any phase throws out of the loop", and
PREPARE failures are "nothing was sent". The plan's broadcast block
(plan :1459-1486) lists PREPARE (`resolveContact`, the fence writes,
`createOrGetByParticipantPhone`, `renderBody`) and then a single `catch (err)`
without saying which try it belongs to. Today those calls sit OUTSIDE the
only try (`app/src/jobs/broadcastFanOut.ts:379-452`, try opens at :454), so a
literal builder who "keeps every existing arm" leaves a DynamoDB blip on the
contact read, the conversation create or a fence's `setRecipient`/`bumpStats`
throwing out of the loop under the job marker - the exact anchor defect.

Relay is worse: Task 8's phase block leaves the suppression arm "unchanged;
PRE-CLAIM" (plan :1630) and the unbounded acquire unchanged (plan :1631); both
can throw (`isMemberSuppressed` reads contacts, `relayFanOut.ts:1351`;
`tokenBucket.acquire` throws on its guard, cited in
`plan-send-sites-findings.md` B20). Task 8 never says the unit or the loop
(`relayFanOut.ts:1139-1161`) catches anything, and the D5/D6 failure-arm writes
inside the unit (`persistRelayRecipientResult`) have no stated catch either,
whereas D7a requires "A failure-arm write ... that itself fails is logged at
ERROR ... and the loop continues".

Sec 8 test 4 opens "a prepare-phase failure defers as `retryable` and releases
the record". No task has that test: Task 7's list (plan :1505-1588) covers the
record phase and `SendAcceptedNotRecordedError` only - not a
`SendNotAttemptedError` (the only post-claim prepare failure on broadcast) -
and Task 8's list (plan :1666-1673) has no presign/aggregation-write failure.

**Implies.** The branch would close the anchor issue for send errors while
leaving the same throw-under-marker shape for per-recipient reads and writes.
The plan must state the try boundary for each phase in both fan-outs, what a
pre-claim throw writes (spec leaves the write open; D6's `send_retryable`
deferral is the only candidate that is not a close), and add the tests.

---

## 5. [HIGH] The `sendOutcome.ts` <-> `messaging.ts` import cycle: the plan's safety argument is backwards, the leaf move is optional, and the default route also breaks the dashboard typecheck

**What is wrong.** Task 1 makes `sendOutcome.ts` import
`SmsSendingDisabledError` from `../adapters/messaging.js` (plan :276). Task 4
makes `messaging.ts` import `SEND_CLAIM_TTL_MS` from `sendOutcome.ts` and use
it at MODULE TOP LEVEL (`export const TWILIO_REQUEST_TIMEOUT_MS =
SEND_CLAIM_TTL_MS;`, plan :824). The plan says the cycle is safe because
"sendOutcome.ts uses the class only inside a function" and offers the
`messagingErrors.ts` move only "To be strict" (plan :824-831).

The hazard is the other edge: when `sendOutcome.ts` is the FIRST module of the
pair to load (e.g. `app/test/sendOutcome.test.ts`, or any graph that reaches
`sendAttemptsRepo.ts` -> `sendOutcome.ts` before `messaging.ts`), ESM evaluates
`messaging.ts` first, and its top-level read of `SEND_CLAIM_TTL_MS` hits the
TDZ (a ReferenceError under Node; an uninitialized binding under the test
runner). Load order in the worker depends on import statement order in
`registerHandlers.ts` and its fan-out modules - i.e. it can differ between
tests and production.

Second consequence: Task 13's mirror test imports the app constants from
`app/src/lib/sendOutcome.ts` (plan :2111). The dashboard compiles `src/**`
(tests included) with `types: ["vite/client", "vitest/globals",
"@testing-library/jest-dom"]` and no Node types (`dashboard/tsconfig.json`).
With the default route, the mirror test drags `adapters/messaging.ts`
(`node:crypto`, `node:stream`, `twilio`, `lib/config`, `lib/logger`,
`messaging.ts:24-33`) into the dashboard typecheck and test graph. The
precedent the plan cites is deliberately import-free
(`app/src/lib/retrySendWindow.ts:63`, "so this module stays import-free").

**Implies.** Make the leaf move mandatory (or make `sendOutcome.ts`
import-free by comparing on `err.name`), and state that `sendOutcome.ts` must
stay import-free because a cross-workspace test imports it.

---

## 6. [HIGH] Task 12's e2e specs cannot be run as written, and the relay one can go false-green

**What is wrong, item by item (all verified):**
- `createGroupOpen(request, { members: [...] })` returning `group.members[1].number`,
  `.label`, `group.poolNumber` (plan :1992-1997). The real helper is
  `createGroupOpen(page, members: RelayMember[])` returning
  `{ conversationId, status, pool_number }` (`e2e/fixtures/relayConnect.ts:162-192`).
- `createTenantWithConsent` and `createAndSendShare` exist nowhere in `e2e/`
  (grep); `devLogin`/`reseedLean` exist only as file-local functions inside
  individual specs (e.g. `e2e/tests/dashboard-next/broadcasts.spec.ts:31`,
  `comms-clickable-links.spec.ts:30`). The plan's note that these "are the
  names of the existing helpers in `e2e/support` / `e2e/fixtures`"
  (plan :2027-2030) is false.
- `page.getByRole('list', { name: 'Delivery by recipient' })` (plan :1997):
  no such accessible name exists in `dashboard/src` (grep).
- `list.getByText(/Number is invalid \(error 21211\)/)` (plan :2021): 21211 is
  not in the carrier map (`dashboard/src/routes/contact/deliveryStatus.ts:777-788`),
  so it renders through the fallback as "Delivery failed (error 21211)"
  (`deliveryStatus.ts:1045-1049`). Spec D23 says rejection codes render through
  "the existing carrier map or its `(error N)` fallback", so the expectation,
  not the copy, is wrong.
- Creating a relay group texts an intro to every member, and the repo already
  documents that the intro "must SETTLE before the arming, or the intro leg eats
  the armed profile" (`e2e/tests/dashboard-next/relay-30003-retry.spec.ts:56-58`,
  settle barrier :108-121). Task 12 arms `failNextSend` immediately after
  `createGroupOpen` (plan :1993). Either the intro consumes the
  `accept_then_drop` (the relayed leg then sends normally and the "Delivered"
  assertion passes without any reconcile - false green), or the intro lands
  first and `getOutboundTo(member1)` returns two messages (intro + leg), so
  `toHaveLength(1)` (plan :2000) fails.
- Test 3 asserts the "Not confirmed" chip (plan :2022), which Task 14 (Slice E)
  adds; Task 12 (Slice D) says "Expected: 3 passed" (plan :2035).

**Implies.** The one end-to-end proof of adoption (spec Sec 8 e2e) is either
red or vacuous as planned. The task needs the real helper signatures, a
settle barrier, the real row locator, the fallback copy, and to run after
Task 14.

---

## 7. [MEDIUM] D6 violated: the retryable arm writes the raw network code on the slot and the record

**What is wrong.** D6: the deferred slot is written "with the provider code
when there is one and with `send_retryable` when there is not (a connection
that never opened ...) - never the raw network string or HTTP status". The
plan's classifier puts the network code in `code` (shared interface doc
"else the network code ('ECONNRESET')", plan :71; `withMeta` includes it,
plan :330-334; the test asserts `code: 'ECONNREFUSED'`, plan :241). Task 7 then
writes "slot queued + (code ?? 'send_retryable')" (plan :1480) and Task 8
"persist queued + (code ?? 'send_retryable')" (plan :1646).

**Implies.** An ECONNREFUSED/ENOTFOUND/EAI_AGAIN deferral stores
`errorCode: 'ECONNREFUSED'` on the slot and as the record cause - the exact
shape `plan-send-sites-findings.md` A8 warned about and D6/D10 exclude. The
arm must write `send_retryable` unless the code is a provider code (numeric).

---

## 8. [MEDIUM] Task 8 leaves typecheck red and the retry rung broken until Task 9

**What is wrong.** Task 8 makes `sendAttempts` and `owner` ARGS of
`sendOneRelayLeg` (plan :1622) - required as written. The unit's other
production caller, `app/src/jobs/relayRetryLeg.ts:626-654`, is edited only in
Task 9. Task 8 Step 3 says "`npm run typecheck` -> 0" (plan :1679).

**Implies.** Either the typecheck gate is red between Tasks 8 and 9, or a
builder makes the args optional - and then the rung sends without a claim
while Task 9 is pending (and the unit must define a no-record path the spec
does not have). The plan should move the rung's call-site change into Task 8
or say the args are required and Task 8/9 are one commit.

---

## 9. [MEDIUM] "Slices are stoppable between" is false at B->C and A is not "no behavior change"; two tasks test against later tasks

**Evidence.**
- Slice B (Tasks 7-9) enqueues `send.reconcile`; the handler and its
  registration arrive in Task 10 (plan :1755). Stopped after Slice B, every
  `unknown` leaves a `reconciling` record and a `queued` slot that nothing
  resolves, D16a's finalize defers for ever on a broadcast, and in production
  the worker fails an unregistered job name until the DLQ.
- Slice A is labelled "no behavior change" (plan :55), but Task 3 changes
  every caller's behavior (post-append failures stop throwing; the staff route
  answers 201 where it answered 500 - the plan itself says so, plan :712-714)
  and Task 1 changes the throttle metric.
- Task 7's finalize test "does not finalize while a recipient is reconciling
  and finalizes when the verdict lands" runs "Task 10's handler" (plan :1587),
  yet Task 7 Step 3 expects the file to PASS (plan :1601).
- Task 12's test 3 depends on Task 14 (finding 6).

**Implies.** Either state that Slices B and C are one stop point, or ship a
handler stub in Task 7 that at least closes `unresolved`. Move the Task 7
cross-task test to Task 10.

---

## 10. [MEDIUM] Unenumerated test breaks: `AppendResult.conversationId` and the success-path write swap

**Evidence.**
- Task 6 makes `AppendResult.conversationId` a returned field (plan :1306). The
  interface is `app/src/repos/messagesRepo.ts:1259-1264`. Exact-shape
  assertions on append results that will fail and are not in Task 6's file
  list: `app/test/messaging.integration.test.ts:137, 141, 152, 155` and
  `app/test/groupSendRepo.integration.test.ts:240` (all `toEqual({ deduped,
  tsMsgId })`).
- Task 7 moves the success-path slot write from `setRecipient` to
  `recordRecipientOutcome` and says "all existing tests still green"
  (plan :1601). `app/test/broadcastFanOut.test.ts:1075-1109` wraps
  `world.broadcastsRepo.setRecipient` to log the `'sent'` write and asserts
  `sentIdx >= 0` and before the acquire; with the swap the index is -1.

**Implies.** `npm test` goes red at Task 17 on files no task touched. List
them in Tasks 6 and 7 (the ordering test should be re-pointed at
`recordRecipientOutcome`, not deleted - it guards the rollup race).

---

## 11. [MEDIUM] The reconcile schedule is stated two incompatible ways

**What is wrong.** Global constraint: "three checks at 5 s, 30 s, 240 s after
the attempt" (plan :32) - offsets from the attempt, matching spec D13a ("about
5 seconds, 30 seconds and 4 minutes after the attempt"). Task 10: "at
delays[next] (measured from the ATTEMPT: delay = max(0, attemptedAt +
cumulative - now))" (plan :1799) - "cumulative" reads as a running sum
(5, 35, 275 s). The e2e comment "never_sent at check 2 (8 s)" (plan :2008)
implies offsets for the lane's `2000,4000,8000`. Task 10 case 4 ("the check-1
envelope's delay measured from the attempt", plan :1854) states no expected
number, so it cannot arbitrate.

**Implies.** Two builders write different schedules and both pass their own
test. State the array's meaning (offsets) and give case 4 a number.

---

## 12. [MEDIUM] Test seams the sketches rely on do not exist, so several red steps are red for the wrong reason

**Evidence.**
- The harness adapter records only `prepared.params` in `world.sent`
  (`app/test/helpers/twilioWebhookHarness.ts:445`, `:3775-3783`; type
  `SendMessageParams[]` at :265) - no SID, no providerTs, no status. Task 4's
  harness `listMessages` "answers from `world.sent` ... with `createdAt` = the
  recorded providerTs" (plan :914-919) and Task 7's
  `sid: world.sent[0]!.sid` (plan :1560) read fields that are not recorded.
  Widening `world.sent` touches every test that reads it.
- Broadcast records carry `sender: config.businessPhoneNumber` (plan :1463-1464);
  unit-test config leaves `BUSINESS_PHONE_NUMBER` unset
  (`plan-send-sites-findings.md` C4; the sender is `from ??
  config.businessPhoneNumber`, `app/src/services/sendMessage.ts:464`). Task 10's
  lookup returns `unresolved`/`no_sender` for a sender-less record (plan :1809),
  so every broadcast adoption case (Task 10 cases 2, 3, 11; Task 7's
  verdict-lands test) fails for that reason unless the world's config is
  seeded - no task says so.
- Task 1 Step 5: `capture.lines.filter((l) => l.includes(...))` and
  `toContain('"errorCode":"20429"')` (plan :367-369), but `capture.lines` are
  parsed objects (`app/test/helpers/logCapture.ts:9`; the existing test reads
  `l['event']`, `app/test/messaging.test.ts:384`). The step's "FAIL - zero
  throttled lines" is a TypeError instead, and it stays red after the fix.
- Task 3 Step 2 uses `LIVE` (absent from `app/test/sendMessage.test.ts`),
  `f.env` (not on `Fakes`, :41-55), `f.sent[0]!.sid` (params only),
  `f.capture.atLevel('error')` with `l.includes` (atLevel takes a number and
  returns objects, `logCapture.ts:11`), and phone `'+15550001111'` where the
  fixture's participant is `'+15550100001'` (:66).

**Implies.** Several TDD steps' "run it to verify it fails" do not observe the
intended failure, and the implementer's tests will diverge from the sketches.
State the seams (what `world.sent` gains, the config seam) explicitly.

---

## 13. [MEDIUM] Relay record facts take `mediaCount` from presigned URLs that do not exist yet at claim time

**What is wrong.** Task 8's facts line uses `mediaCount: legMediaUrls?.length
?? 0` (plan :1632), but the plan's own claim placement puts the claim BEFORE
the presign (plan :30; the unit presigns at `relayFanOut.ts:1406-1412`, after
the acquire). At claim time `legMediaUrls` is undefined, so every relay record
stores `mediaCount: 0`.

**Implies.** D13's short-body rule (`matches`: media count when the
normalized body is under 3 characters, plan :1833) and the same-fingerprint
sibling rule (body hash AND media count, plan :1830) compare against 0. The
right source is `hasMedia && mediaStore ? sourceMedia.length : 0` (the unit
drops media when there is no store, `relayFanOut.ts:1030-1038`).

---

## 14. [MEDIUM] Relay adoption on a LEGACY row writes the slot blind after the pointer exists - the regression race D7a avoided

**What is wrong.** Task 10's relay adoption: `claimRelaySidPointer` wins in
the loop, THEN `persistRelayRecipientResult(...)` (plan :1841).
`persistRelayRecipientResult` on a legacy row goes through
`markRecipient` -> `setRecipientDelivery`, an unconditional wholesale SET of
the slot (`app/src/repos/messagesRepo.ts:3661-3682`). Once the pointer exists,
a receipt can advance the slot (child-field write), and the blind write that
follows regresses it (`plan-send-sites-findings.md` A4, the reason D7a keeps
the send-path pointer SECOND). D15: "Every adoption write is idempotent,
conditional or forward-only, so a status callback that raced ahead of the
adoption cannot be regressed by it."

**Implies.** On legacy rows (retry rungs of pre-2026-09-02 roots, older
sources) adoption can erase a `delivered`. Task 10 Step 2's regression test
("write the slot `delivered` ... then adopt as `sent` -> slot stays
`delivered`", plan :1870) would catch it only if run on a legacy row; the plan
does not say which shape.

---

## 15. [MEDIUM] D8's gate and conditional close are not applied to every close the spec enumerates

**Evidence.**
- D8's list includes "the relay opt-out arm (which write[s] the slot before
  that job's own claim)". Task 8 leaves the unit's suppression arm "unchanged"
  and adds only a re-drive record close (plan :1630). For a non-re-drive pass
  that carries a member deferred by a foreign fresh claim (Task 8's own
  `deferredByClaim` path), the continuation's suppression arm can write
  `failed`/`contact_opted_out` over a member whose record is `reconciling`; on
  a versioned row the first terminal code then sticks
  (`relayRetryLeg.ts:783-789` comment describes that property).
- D8: "The close's slot write is itself conditional ... No existing write
  expresses that condition; it is a new conditional write in each repo." Task 9
  gates `refuseGate` and the window close on the record (plan :1733) but keeps
  their slot write as today's `persistRelayRecipientResult`
  (`relayRetryLeg.ts:487-505`), not the new `closeRelayRecipientIfUnsent`.

**Implies.** Two of the named close sites keep the unconditional write the
spec replaces. Either extend them or record why the record gate alone
suffices for each.

---

## 16. [MEDIUM] Broadcast adoption omits the inbox touch D15 lists

**What is wrong.** D15's broadcast/1:1 write set ends: "the inbox touch uses
the status-preserving variant with no preview and never moves
`last_activity_at` backwards". Task 10's `adoptBroadcastRecipient` write list
(plan :1763) is: append, slot via `recordRecipientOutcome`, audit, emits,
milestone, listing-send - no touch. Only the relay rung's adoption gets one
(plan :1842).

**Implies.** An adopted share message is appended to the tenant's 1:1 thread
without moving the thread in the inbox, unlike every sent share. Add the
touch (with `now`, per `plan-data-layer-findings.md` L2) and state it is
conditioned on the slot move like the other side writes.

---

## 17. [MEDIUM] Sec 8 intentions with no test in any task, despite the self-review's full mapping

Checked each Sec 8 clause against the task test lists (plan :1505-1588,
:1666-1673, :1700-1724, :1850-1870):
- Test 4: "a prepare-phase failure defers as `retryable` and releases the
  record" - none (finding 4).
- Test 6: cap-close leaves a FRESH `attempting` and a `redriven` record
  untouched, TAKES OVER a stale one, "the reconcile job's own close writes the
  slot before the record and a redelivered close re-applies it" - Task 7's
  cap-close case seeds only `reconciling` + absent.
- Test 7: "three `retryable` ... do not" brake - only three `rejected` is listed.
- Test 8: the `syssid#` exclusion and "a known-SID fetch failure throws" -
  Task 10 case 5 seeds only a `sid#` pointer; no fetch-throw case.
- Test 9: "an `unresolved` delivered twice writes once" - none.
- Test 10: second unknown after re-drive - none (finding 1).
- Test 11: "verdict-then-pass" ordering - only pass-then-verdict (plan :1587).
- Test 12: "RSW's window close refuses a recipient with a FOREIGN open
  attempt" - Task 9 tests only the re-drive's own record.
- Review Focus 2 is a RELAY member whose number changed (plan :46), but Task 10
  case 13 describes a contact phone change and does not name an owner; RF2/RF4
  are attributed to Task 9 in the header (plan :46, :48) and to Task 10 in the
  self-review (plan :2261).

**Implies.** The self-review's "Sec 8 tests 1-16 map to ..." (plan :2258) is
not true; the listed gaps will not be written by a literal builder.

---

## 18. [MEDIUM] The gate block runs `timeout 1500 npm run e2e` in PowerShell, where `timeout` is `timeout.exe` and does not run the suite

**What is wrong.** Task 17 Step 2's block is fenced `powershell`
(plan :2243-2249) and contains `timeout 1500 npm run e2e` (also plan :37 and
:2034). In Windows PowerShell `timeout` resolves to `C:\Windows\System32\timeout.exe`,
which only waits and rejects that argument list. GNU `timeout` exists only in
Git Bash.

**Implies.** Gate 4 as written fails without running e2e (or a builder drops
the outer timeout the plan wants). Give the Git Bash form or a PowerShell
job-with-timeout form explicitly.

---

## 19. [LOW] `carrierSentAt` rule contradicts its own test

Task 10's `statusFor` sets `carrierSentAt` "= `m.sentAt` when the provider
status is `sent`" (plan :1844); Task 10 case 2 expects a `delivered` adoption
"with `carrierSentAt`" (plan :1852), as does spec Sec 8 test 8 and D15
("take the provider's `date_sent` when it has one"). One builder fails the
test.

## 20. [LOW] Three small drifts from the spec's wording

- Sibling rule widened: `s.outcome === 'sent'` counts as a blocking sibling
  (plan :1830); spec D13 says "open or was adopted". Safe direction, but it
  turns a genuine `never_sent` into `unresolved` whenever the same body went to
  the same recipient from the same sender inside the window.
- `20429` is in the code-first set (plan :307) while D1's code-first exception
  covers only the codes the arms already recognise; a 5xx carrying 20429 would
  be `retryable`, spec says `unknown`.
- D13 "the driver asserts the size it asked for is the size it got": Task 4's
  driver has no such assertion (plan :849-864); the hook is
  `page._payload.page_size` (`plan-data-layer-findings.md` M4).

## 21. [LOW] Interface loose ends

- A takeover returns the same `handed_to_reconcile` kind as an `unknown`
  (plan :1636), so the relay loop cannot apply D9's "streak on an unknown" rule
  it states (plan :1655).
- `deferredByClaim` (plan :1634) and `attemptRef` on `sent_unrecorded`
  (plan :1650, used at :1654) are not in Task 8's Produces list (plan :1621).
- Task 9's exhaustive-switch test "asserts the module exports the kind list
  length" (plan :1724) names no module and no export; untestable as stated.
- Task 10's Interfaces say "Task 7 exports" `finalize` and
  `adoptBroadcastRecipient` (plan :1763) while Task 10's Files and Step 3 build
  them (plan :1756, :1872); Task 7 does not list them.
- The rung's transient re-enqueue forwards the parsed payload
  (`relayRetryLeg.ts` `enqueue(RELAY_RETRY_LEG_JOB, payload, ...)`), so once the
  parser carries `redrive`, a re-driven rung's transient retry is re-flagged as
  a re-drive; the plan does not say whether that is intended.

## 22. [LOW] Records and self-QA inconsistencies

- Task 8 closes a relay fan-out re-drive's early returns (plan :1660), while
  Task 15 files "a re-drive continuation's early returns, which strand a
  `redriven` record" as open residue (plan :2208; spec Sec 9). The issue text
  will be wrong for relay.
- Task 16 scenario 3 ("kill the fake process for the three checks",
  plan :2228): with the fake down BEFORE the send, the send gets ECONNREFUSED,
  which the classifier makes `retryable`, so the scenario reaches
  `transient_cap`, not `unresolved`. It needs an `unknown` first
  (`accept_then_drop`/`drop_before_create`) and then the kill, inside a 2 s
  window. Scenario 4 (pause "the worker between the claim and the send") is
  not achievable on the one-process lane without freezing the dashboard's API.

## 23. [LOW] Console driver send log is unbounded

Task 4's module-level `consoleSent` array (plan :910) grows for the life of a
`--mock` dev server; `plan-data-layer-findings.md` M5 asked for a bounded
store.

---

## Coverage notes (no finding)

Delivered as the spec states, verified against code: D1 table and precedence
(except finding 20), D2, D3 wrapping points (match `sendMessage.ts:332, 361,
431-439, 465-474`; no refusal wrapped; `ProviderSendFailedError` message
carries the cause for the pin at `sendMessage.test.ts:461-470`), D4, D5 (relay
has no 30005/30006 arm today - `relayFanOut.ts:1454-1492` - so the generic
`rejected` arm is correct), D8a key shapes and hashing (plain SHA-256 matches
the `relayRetryClaim.ts:25-30` precedent), D10, D16a flip/won semantics, D17
seam shape, D19 fake modes and party-number keying, D20/D21/D23 presenter
edits, D22 optional bucket and `skippedTotal` exclusion, Sec 2a RSW #5/#6/#7
placement (claim after the bounded acquire keeps the pins at
`relayRetryLeg.test.ts:557-566` and `:1214-1256`), and the typed-fake lists for
`MessagingAdapter`, `MessagesRepo` and `BroadcastsRepo` (complete per grep).
