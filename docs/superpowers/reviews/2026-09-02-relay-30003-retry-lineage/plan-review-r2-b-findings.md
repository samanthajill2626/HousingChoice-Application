# Plan review R2-B (adversarial) - relay 30003 retry lineage, plan revision 2

Plan: `docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md` (rev 2)
Spec: `.../specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 6, approved)
Adjudications read: `plan-r1-adjudications.md`. Reviewer A's round-1 findings read.
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

Three findings change a decision (1, 3, 4). Nine are wording or harness
corrections. The reorder itself is sound and I could not break it in the direction
the coordinator expected - Task 7's filter genuinely does not depend on Task 6's
join, and Task 12 does not collide with what Task 7 touched. The reorder's real
cost is elsewhere: it moved the incoherent window instead of closing it (finding 3).

---

## 1. [HIGH] [CHANGES-DECISION] Scoping `flagPlacementAttention` to "no live retry" deletes the human escalation for three of the four terminal outcomes

**What is wrong.** Task 9 Step 3 item 10 gates `flagPlacementAttention` on no live
retry, and Task 9's tests assert it fires only "once the ladder is terminal"
(plan `:1231-1239`). Three of the four ways this design ends a ladder produce no
further delivery callback, so the webhook never runs again and nothing escalates.

**Evidence.**

- Today the relay branch escalates on the FIRST failed leg:
  `app/src/routes/webhooks/twilio.ts:2522-2528`, inside `if (transitioned)`.
- `flagPlacementAttention` is a closure declared inside
  `createTwilioWebhookRouter` (`:412`) and called only at `:2526` and `:2700`.
  Nothing outside that router can call it - the retry job cannot.
- Spec D23 states the asymmetry the plan then ignores: "Gate refusal (D9), enqueue
  failure (D14) and the transient cap (D10) generate no further callback, so the
  webhook handler that owns the severity decision never runs again - the retry JOB
  emits those."
- The plan applies that reasoning to the ERROR log (Task 8 Step 5 item 6 has the
  job logging `transient_cap`) and NOT to the escalation.

**What it implies.** A relay leg whose retry is refused because the member's number
changed, or because the queue was down, or because a rate limit exhausted the
transient budget, silently stops escalating to a human - where today it escalates
immediately. That is a REGRESSION in an existing safety path, introduced by the
remedy for round-1 finding 9, and it lands in the same commit that makes the
escalation later for every other case. Either the job must raise the same flag
(which needs `flagPlacementAttention` extracted out of the router closure - a
surface no task lists), or the gating must be narrower than "a retry was claimed":
escalate on the claim as today, and accept the earlier escalation as the price of
never losing one.

## 2. [HIGH] [WORDING] The harness the plan tells the builder to follow does not exist - twice, and it is the replacement for a phantom round 1 already caught

**What is wrong.** Task 1 Step 5 says "Follow the harness in
`app/test/messagesRepo.integration.test.ts` for table setup and teardown"
(plan `:230-231`), and Task 4's Files block repeats it (`:505-506`). There is no
such file.

**Evidence.** `ls app/test | grep messagesRepo` returns exactly four files:
`messagesRepo.callStatus.test.ts`, `messagesRepo.callTranscript.test.ts`,
`messagesRepo.email.test.ts`, `messagesRepo.transport.test.ts` - none of them an
integration suite. Round-1 finding A12 caught the same defect on
`app/test/conversationsRepo.integration.test.ts`; adjudication 19 accepted it, and
the fix substituted a second file that also does not exist.

**What it implies.** Both new integration suites start by opening a file that is
not there. The real harnesses are in the repo and one of them is exactly right for
Task 1's hardest assertion: `app/test/mediaPointers.integration.test.ts` is the
DynamoDB-Local suite for the `media#<conversationId>` partition
(`:1-12` sets up `createDocumentClient` / `ensureTable` / `deleteTableIfExists`),
which is what `mediaPointerCount` has to query. For the general shape, name
`app/test/relayRepos.integration.test.ts` or `app/test/messaging.integration.test.ts`.
Cite files you have listed.

## 3. [MEDIUM] [CHANGES-DECISION] The reorder moved the incoherent window rather than closing it

**What is wrong.** The self-review claims "Between any two commits the product is
coherent: before Task 9 no retry row exists, and the Task 7 filter is a no-op on
data that is not there yet" (plan `:1777-1779`). That covers Tasks 1-8. It does
not cover Tasks 9 through 12.

**Evidence.** Task 9 starts appending retry rows. Task 7's filter admits a
delivered retry of an outbound original (plan `:831-834`) - correctly, that is the
bubble D20 wants. But Task 11 (the arithmetic and the `on retry` suffix) and Task
12 (the three positions) have not landed. So between Task 9's commit and Task 11's:

- the retry bubble renders its own rollup from its single-entry map
  (`Timeline.tsx:934-940`), which with one delivered leg reads `Delivered 1/1` -
  capital, success-toned (`deliveryStatus.ts:453-454`), with no `on retry` suffix;
- the ORIGINAL's chip still reads `delivered N/M - 1 failed - Phone unreachable
  (error 30003)`, because the join is not wired until Task 12.

Two bubbles for one message, one claiming success and one claiming failure, for
two to three commits. Smaller than the three unfiltered duplicates the reorder
fixed, but the same class, and the self-review asserts it cannot happen.

**What it implies.** The ordering is fixable without any design change, because
the dashboard half never depends on the server half: run 1-7, then 11, 12, 13,
then 8, 9, 10, then 14, 15. Task 11 consumes only `EffectiveRelayLeg` (Task 6) and
Task 12 only Tasks 6, 7 and 11 - I checked every Consumes block. If the order is
kept as written, the self-review sentence has to name the window instead of
denying it.

## 4. [MEDIUM] [CHANGES-DECISION] Task 8 resolves the transport mode from the wrong row, and requires a row it does not need

**What is wrong.** Task 8 Step 5 item 3: "Resolve the transport MODE from the ROOT
(D2)." The mode governs writes to the RETRY row, not the root.

**Evidence.** `sendOneRelayLeg` is called with the RETRY row as `sourceTsMsgId` /
`currentSource` (Task 8 Step 5 item 5), and its versioned path routes to
`applyRecipientSendResult`, which returns `legacy_noop` when **the row it is
writing** has `transport_schema_version !== 1` (`app/src/repos/messagesRepo.ts:3240`),
and `persistRelayRecipientResult` throws on that (`app/src/jobs/relayFanOut.ts:1436-1439`).
The fan-out itself resolves the mode from the row it is fanning out
(`relayFanOut.ts:791-795`). The retry row's own schema is authoritative; it agrees
with the root only because Task 9 seeded it that way, and nothing tests the
agreement.

Second half: Task 8 Step 5 item 2 says "Re-read the retry row and its ROOT ...
Close and return if either is missing." The job needs the root's tsMsgId as a
STRING for `relayRetryDigest(rootTsMsgId, member.phone)` (item 4) - and that string
is on the retry row as `relay_retry_of`. If the mode is read from the retry row,
the root ROW is not needed at all, and requiring it introduces a new close path
that terminates a legitimate retry on an unrelated read miss.

**What it implies.** One word - ROOT to RETRY ROW - removes a point get, removes a
failure mode, and makes the mode read authoritative rather than coincidental. Task
8's two mode tests (plan `:1021-1031`) pass either way, which is why this needs
saying rather than testing.

## 5. [MEDIUM] [WORDING] Task 7 never says how the filter reads "its leg delivered"

D20's predicate has two halves. The plan supplies the source for one - "both read
from the retry row's OWN lineage" (plan `:828-830`), which is true of
`relay_retry_origin_direction` - and never says where the delivered-ness comes
from. It is the retry row's own single-entry slot:
`msg.delivery_recipients[msg.relay_retry_member_key]`, both of which Task 5 puts on
the wire (`useRelayThread.ts:125` already forwards `delivery_recipients`).

This matters because Task 6's join now lands BEFORE Task 7 and is the obvious
thing to reach for - and it is the wrong tool: `projectRelayLegs` is keyed by
`${rootTsMsgId}|${memberKey}` over the ORIGINAL's entries and returns effective
legs for the original, not a verdict on a retry row. A builder wiring the filter
through the join gets a `visible` memo that depends on the time-derived half,
which is exactly the freeze D18 exists to prevent. One sentence closes it.

## 6. [MEDIUM] [WORDING] `hasTickableLeg`'s new input has no stated shape

Task 12 Step 4: "`hasTickableLeg` needs the projected state as an input; D20
removes retry rows from `visible`, so the thread-level projection must be available
to the predicate" (plan `:1553-1554`). It does not say what the signature becomes
or where the value comes from at the call site.

`tickerArmed` maps `visible` with `(i, tickNow)` and nothing else
(`Timeline.tsx:1851-1854`); `hasTickableLeg(msg, tickNow)` is `:798`. So the
predicate needs a third argument - the thread-level `Map` keyed by
`${rootTsMsgId}|${memberKey}` - threaded from the same memo `visible` sits beside.
This is the clause three spec rounds fought over and the one whose absence
reintroduces both the frozen display and the fifth non-termination; it should not
be the one detail left to inference.

## 7. [MEDIUM] [WORDING] Task 13's snippet does not match the host's actual test harness

Task 13 writes `renderTourConversation({ items: [...] })` (plan `:1593`, `:1598`).
`dashboard/src/routes/tours/TourConversation.test.tsx` defines
`renderConvo(props: TourConversationProps, draft?)` at `:178` and drives content
through `vi.mock('../../api/index.js')` (`:44`) with mocked fetch resolutions -
there is no `items` prop, because the host owns its own `useRelayThread` call
(`TourConversation.tsx:420`). The task IS writable: mock
`getConversationMessages` to return the original plus the retry row. But as shown
it is not, and Task 13 is explicitly a verification task whose whole value is
running against the real host wiring.

## 8. [MEDIUM] [WORDING] Task 11's fenced-product test calls a helper that cannot exist

Plan `:1433-1436` asserts
`presentLegDelivery(groupTextLeg, 'group_text')` equals
`presentLegDeliveryOnMain(groupTextLeg, 'group_text')`. There is no way to import
the main-branch implementation into a working-tree test. The real proof of the
fence is already in the plan: Step 5 runs the whole `deliveryStatus.test.ts` and
expects "PASS, including every pre-existing case" (plan `:1456-1457`), and that
file's existing `group_text` cases are the assertion. Replace the snippet with a
named pre-existing case, or delete it and rely on Step 5.

## 9. [MEDIUM] [WORDING] Intention 7 is still proven once, though adjudication 23 says it was sharpened

Spec intention 7 is "Other members receive no duplicate send, **on every rung**".
Adjudication 23 records it as sharpened. In the plan I find only: the e2e's
single-rung `reachableMsgs ... toHaveLength(1)` (plan `:1685-1686`), on a ladder
that runs one rung because the fake's arming is one-shot per destination
(`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts:34-37`), and Task
8's per-run "sends exactly one leg to the failed member" (`:983-987`). Neither
walks rungs 2 and 3 with a second member on the roster. Task 9's "stops at the cap"
(`:1206-1209`) walks the rungs and asserts only the retry count. One assertion in
that test - the other member's send count is unchanged across all three rungs -
would close it.

## 10. [LOW] [WORDING] Task 8 mixes two spies for one behaviour without saying when the module is mocked

`sendSpy` (the adapter) carries `:941-946`, `:961`, `:983-987`, `:1006-1010`;
`sendOneRelayLegSpy` (the extracted module) carries `:1024`, `:1030`, `:1037`,
`:1047`. Mocking the module disables the extraction's own slot and `relaysid#`
pointer writes (`relayFanOut.ts:1250-1267`), which the plan correctly flags as the
extraction's responsibility (Task 3, plan `:470-471`) - so the transient-cap test
at `:1045-1053` is asserting a slot the mocked path never wrote, and passes only
because the JOB writes the close. That happens to be right; say so, or a builder
debugging it will "fix" it by writing the slot in the job, which Task 8 Step 5 item
5 forbids.

## 11. [LOW] [WORDING] Import-extension drift in Task 6's snippet

Plan `:698`: `import { STALE_SENT_AFTER_MS } from './deliveryStatus';`. The
dashboard uses explicit `.js` specifiers throughout - `Timeline.ticker.test.tsx:30`
imports `'./Timeline.js'`, `useRelayThread.ts:26` imports
`'../shared/threadPaging.js'`. Using the exported constant is exactly right
(round-1 finding 12); the specifier is wrong.

## 12. [LOW] [WORDING] The log-collector harness exists but every cited call site discards the handle

The plan says the log collectors "follow `app/test/twilioStatusWebhook.test.ts`"
(plan `:1058-1059`). The helper is `createLogCapture()`, and the pattern is real -
but the sites a builder will copy pass `createLogCapture().stream` inline and keep
no reference (`app/test/relayWebhook.test.ts:85`, `:345`, `:678`;
`app/test/twilioStatusWebhook.test.ts:909`), so `errorLogs()` / `warnLogs()` have
nothing to read. `twilioStatusWebhook.test.ts:861` keeps the capture and is the one
to copy. Name the line.

---

## Harness mapping - the check the coordinator asked for

I verified every helper-to-harness claim the adjudication asserted. Five hold, two
do not.

| Helper | Cited harness | Verdict |
|---|---|---|
| `runHandler` | `relayFanOut.test.ts` job invocation | HOLDS - `dispatchJob(JSON.parse(JSON.stringify(envelope)))` at `:853`, `:973` |
| `exhaustFanoutPasses`, `slotOf` | same file's `claimFanoutPass` usage | HOLDS - `claimFanoutPass` appears in `app/test/relayFanOut.test.ts` |
| `errorLogs` / `warnLogs` | `twilioStatusWebhook.test.ts` | HOLDS with a caveat - finding 12 |
| ticker spies, `capturedTickerId` | `Timeline.ticker.test.tsx:98-119,157-203` | HOLDS - and the file's header documents why `vi.getTimerCount()` is unusable |
| `renderTimeline` | `Timeline.test.tsx`, `Timeline.delivery.test.tsx` | HOLDS - `:21` and `:24` respectively (three different local helpers share the name; harmless) |
| table setup / teardown | `messagesRepo.integration.test.ts` | FAILS - finding 2, the file does not exist |
| `renderTourConversation` | `TourConversation.test.tsx` | FAILS - finding 7, the helper is `renderConvo` and takes no `items` |

Files the plan cites as existing that DO exist, checked individually:
`app/test/twilioStatusWebhook.test.ts`, `app/test/messagesRepo.transport.test.ts`,
`dashboard/src/routes/conversation/useRelayThread.test.tsx`,
`dashboard/src/routes/contact/deliveryStatus.test.ts`,
`dashboard/src/routes/tours/TourConversation.test.tsx`,
`dashboard/src/routes/placements/PlacementConversation.test.tsx`,
`dashboard/src/routes/conversation/ConversationDetail.test.tsx`.

## The reorder, attacked directly

- **Does any task depend on something later?** No. Task 7's filter needs only Task
  5's wire fields plus the retry row's own slot (finding 5 is that the plan does
  not SAY that, not that the dependency is inverted). Task 6 precedes Task 7 but
  Task 7 does not consume it. Task 11 consumes only Task 6. Task 12 consumes 6, 7
  and 11. Task 8 consumes 1, 3, 4. Task 9 consumes 1, 2, 8. I walked every
  Consumes block and found no forward reference.
- **Does Task 12 collide with what Task 7 already touched?** No. Task 7 edits the
  `visible` memo (`Timeline.tsx:1787-1799`); Task 12 edits `hasTickableLeg`
  (`:798-812`), the entries call (`:937`), the bubble props and the run-condition
  comment (`:1806`). Adjacent, not overlapping. The only shared object is the
  thread-level `indexRelayRetries` memo Task 12 adds "beside `visible`", which
  Task 7 does not use.
- **Is the parallel claim safe?** Yes for Tasks 1-4 against 5-7. Both halves touch
  disjoint files and neither changes behaviour the other observes.

## Newly-added material reviewed cold

`relay_retry_leg_body` as a sixth server-only value (Task 1) - correct, and Task 5
correctly withholds it and the digest from the wire with D11's reasoning.
`EffectiveRelayLeg extends RelayDeliverySlot` (Task 6) - correct, and the added
test "preserves every slot field it did not decide" (plan `:753-758`) is the right
proof. Rung chaining to the ROOT (Tasks 6, 9) - correct, and tested at both ends.
The worker-side backoff seam (Task 14) - correct on the process boundary, and the
`Number.isInteger && > 0` guard closes the misconfiguration risk. `git mv` plus an
explicit `git rm` (Task 14) - correct. The distinct e2e locators (Task 14 Step 2) -
correct, and the strict-mode hazard it avoids is real. Task 13's demotion to
verification with the milestone-merged list named as the reason it still earns a
gate - correct, subject to finding 7.

## Disagreements with the adjudications

None on substance. One note: adjudication 9 ("scoped to fire only when no retry
was claimed, with a test") is where finding 1 comes from - I raised the reader,
the remedy went one step further than the reader required, and the step it took
removes an escalation that exists today. That is a remedy problem, not a
disagreement about the finding.

## Verdict

**Three findings change a decision: 1, 3 and 4.** Finding 1 is the one that
matters - it removes an existing human-escalation path for the three failure modes
this design creates, and it arrived as the fix for a finding I raised.
