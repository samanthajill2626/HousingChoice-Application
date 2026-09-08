# Plan review R1-B (adversarial) - relay 30003 retry lineage

Plan: `docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md`
Spec: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 6, approved)
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

Question answered: **if a builder with no context executes this LITERALLY, do they
produce the spec?** Not quite. Two gaps stop the build outright (1, 2), one breaks
a required gate (3), one leaves a user-visible regression window between commits
(4), and three spec test intentions have no test at all (5, 6, and half of 9).

The plan is strong on the parts that took three review rounds to settle - the two
halves of `unconfirmed`, the projection's two lifetimes, the slot-code-ABSENT
clause and the ticker's termination are all present, correctly reasoned, and each
carries the counter-argument in a comment. The failures are elsewhere.

---

## 1. [BLOCKING] D12's "leg copy stored separately" has no field, in any task

**What is wrong.** D12 requires the retry row to store the RAW body AND, as a
separate stored value, the exact composed leg copy to send verbatim. Task 1 is the
only task that touches `NewMessage`/`MessageItem`, and its Interfaces block
declares exactly five additions - `relayRetryOf`, `relayRetryMemberKey`,
`relayRetryAttempt`, `relayRetryDestDigest`, `relayRetryOriginDirection` - none of
which is the leg copy.

**Evidence.** Plan `:125-131` (the five fields). Task 6 Step 3 item 7 says to
append "the five lineage values, the raw body, the leg copy and the seeded slot" -
naming a sixth stored value that no task creates. Task 5's test at plan `:624-628`
asserts the SEND carries `'Sam: the original text'` after a rename, which is only
possible if the copy was stored. No existing field can carry it: `body` is the row
body (`messagesRepo.ts:2121`), and `composeRelayBody` output is never persisted
today (`relayFanOut.ts:998` composes per leg, the source row keeps the raw text -
`twilio.ts:648`, `api.ts:1820`).

**What it implies.** A literal builder reaches Task 6 with nowhere to put the leg
copy and either invents a field name (breaking the plan's own type-consistency
claim) or recomposes at send time - which is precisely what D12 exists to forbid,
and the failure is silent: it only shows when a sender's display name changed
between attempts, which is what Task 5's test covers, so the test would then fail
with no field to fix it. Add a sixth stored value in Task 1 and name it.

Related, same decision: **spec intention 10 requires the ROW to store the RAW
body** and no test asserts it. Task 5 asserts only the leg copy on the wire.

## 2. [BLOCKING] `EffectiveRelayLeg` cannot be the parameter type Tasks 10 and 11 pass it as

**What is wrong.** Task 9 declares `EffectiveRelayLeg` as `{ status, errorCode?,
retryState? }` (plan `:1007-1012`). Task 10 then says `presentRelayDelivery`
accepts `EffectiveRelayLeg[]` and `presentLegDelivery` accepts an
`EffectiveRelayLeg` (plan `:1148-1149`). Those functions read fields that type
does not have.

**Evidence.**

- `presentRelayDelivery` calls `includedRecipientEntries(slots)`
  (`dashboard/src/routes/contact/deliveryStatus.ts:407`), whose filter reads
  `transportAggregationState` (`dashboard/src/lib/messageTransport.ts:43-46`), and
  `isStaleLeg(s, messageAtMs, nowMs)` (`:415`), which routes to
  `stalenessClockMs` and reads `slot.sentAt` (`:206-233`).
- `presentLegDelivery` takes a `RelayDeliverySlot` (`:508-513`) and calls the same
  two.
- The per-recipient row renders `presentRecipientTransport(row.slot)`
  (`Timeline.tsx:1118-1119`), which reads `requestedTransport`, `actualTransport`
  and `transportAggregationState` (`messageTransport.ts:59-77`).
- `RelayDeliverySlot` (`deliveryStatus.ts:151-157`) carries all of those.

**What it implies.** If Task 11 replaces `row.slot` with the projected leg, the
transport chip on every per-recipient row silently becomes `'Unknown'`
(`messageTransport.ts:76`) and the whole staleness path goes dark - on a shared
presenter that also serves native group text, which Sec 2 fences. The type must be
`interface EffectiveRelayLeg extends RelayDeliverySlot { retryState?: ... }`,
i.e. the projection OVERRIDES `status`/`errorCode` on a copy of the slot and
carries everything else through. Task 9's declaration and Task 10's signature
sentence both have to say so, and Task 11's "Point all four reason sites at the
projected legs" has to be explicit that the TRANSPORT site keeps reading the same
object rather than a stripped one.

## 3. [HIGH] Task 13 renames the e2e spec but never stages the deletion, so both specs ship and `npm run e2e` goes red

**What is wrong.** Task 13 says "**Rename the file to `relay-30003-retry.spec.ts`**"
(plan `:1411`) while the plan's File Structure says the same file is "UPDATED,
never deleted" (`:102-104`). Task 13's commit stages only the new path.

**Evidence.** Plan `:1472`:
`git add e2e/tests/dashboard-next/relay-30003-retry.spec.ts app/src/routes/dev.ts`.
The Global Constraints forbid `git add -A` (`:34`), so nothing stages the removal
of `relay-30003-no-retry-promise.spec.ts`. That file's surviving assertions are
positive, not just negative: it asserts the rollup contains
`delivered 1/2 - 1 failed - Phone unreachable (error 30003)`
(`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts:158-160`) and that
the failed row contains `Undelivered - Phone unreachable (error 30003)` (`:183`).
After this branch the leg retries and delivers, so both fail.

**What it implies.** Gate 4 (`npm run e2e`) fails on the branch's own leftover
file, at the end of the build, after every other gate has passed. Either use
`git mv` and stage both paths, or - matching File Structure and the spec's own
wording ("`relay-30003-no-retry-promise.spec.ts` is UPDATED, not replaced") - do
not rename at all. The two halves of the plan currently instruct opposite things.

## 4. [HIGH] The ordering claim is false: between Task 6 and Task 11 every retry row renders as a raw duplicate bubble

**What is wrong.** The self-review states: "No task leaves a stated guarantee
violated between commits: until Task 6 nothing claims, and until Task 11 nothing
renders a retry state - **the display simply reads as it does on `main`**"
(plan `:1532-1534`). It does not. On `main` retry rows do not exist; after Task 6
they do, and nothing filters them until Task 11.

**Evidence.** `buildRelayItems` maps EVERY returned message row into an item
(`dashboard/src/routes/conversation/useRelayThread.ts:139-151`). The only
item-level filter in the render path is the `visible` memo
(`Timeline.tsx:1787-1799`), which today filters `retry_of` supersession and
`commsOnly` only - and D20's predicate lands in Task 11 (plan `:1340`). A retry
row carries the same raw body as its original (D12), and on an outbound original
it carries a single-entry `delivery_recipients` map, so it renders a full bubble
WITH a rollup chip (`Timeline.tsx:934-940`). On an inbound original it renders a
second inbound bubble attributed to the same member (`:973`) - the duplicate
member message D20 exists to prevent.

**What it implies.** Tasks 6-10 are five commits during which the relay thread
shows every message twice. That is a demoable branch state and a reviewer-visible
regression, and the self-review asserts the opposite. Fix by ordering (land Task
11's `visible` predicate before Task 6) or by stating the window honestly. The
parallelism claim is otherwise sound - I checked Task 9/10/11's dependencies and
they only need Task 1's field NAMES, as claimed - so this is the one ordering
defect, not a general one.

## 5. [HIGH] Test intention 18 (legacy original) has no test and no step

**What is wrong.** Spec intention 18 requires proof that a LEGACY original
produces a legacy retry row and slot and that its send does not take the versioned
path, and says explicitly that this is "the ordinary case for an old message, not
an edge one". The plan mentions the mode once, in half a clause.

**Evidence.** Task 6 Step 3 item 7: "mirroring `direction`, `author`,
`relay_sender_key`, `type` and the transport MODE from the ROOT (D2)" (plan
`:831-833`). No test in any task drives a legacy original. Task 1's only
transport-shape test is the INBOUND VERSIONED case (plan `:266-272`). Task 5's
tests never vary the mode.

**What it implies.** The failure is a hard throw, not a soft wrong answer:
`applyRecipientSendResult` returns `legacy_noop` when
`transport_schema_version !== 1` (`app/src/repos/messagesRepo.ts:3240`) and
`persistRelayRecipientResult` throws on it (`app/src/jobs/relayFanOut.ts:1436-1439`).
Every relay source written before the 2026-09-02 merge is legacy
(`relayFanOut.ts:791-795` is where the mode is resolved), so the first production
retry of an older message dies in the job. This is the single item the coordinator
flagged as most likely to be lost, and it was.

## 6. [HIGH] Test intention 6 (enqueue failure) has no test, and the self-review maps D14 to the wrong task

**What is wrong.** Intention 6: "An enqueue failure still reaches a terminal state,
with a close code distinct from cap-exhausted, and both codes render as prose."
Nothing tests the first two clauses.

**Evidence.** The self-review maps "D9-D14 to Task 5" (plan `:1516-1517`), but the
enqueue is in the WEBHOOK: Task 6 Step 3 item 8, "On throw, close the retry leg
`enqueue_failed` and log the terminal ERROR (D14)" (plan `:835-836`). Task 6's
test block (plan `:722-810`) has no enqueue-failure case; Task 5's (plan
`:566-663`) has `transient_cap` but not `enqueue_failed`. Task 10 tests prose for
the four `retry_*` codes only (plan `:1183-1190`) - `enqueue_failed` and
`transient_cap` already exist in `INTERNAL_CODE_REASONS`
(`dashboard/src/routes/contact/deliveryStatus.ts:688-692`), so that clause is
satisfied, but the terminal-state clause is not tested at all.

**What it implies.** The one path where a claim exists and NOTHING will ever run
it ships unproven, and it is the path D14 exists for. One test in Task 6: make
`enqueueRelayRetryLeg` throw, assert the retry row's slot reads
`failed`/`enqueue_failed` and that an ERROR carries a `retryClaim` value.

## 7. [HIGH] The ticker tests invent `tickerArmed()` when the repo already has the harness they need

**What is wrong.** Task 11 Step 3 asserts `expect(tickerArmed()).toBe(true)` and
`.toBe(false)` (plan `:1311`, `:1325`). `tickerArmed` is an internal `useMemo`
inside `Timeline` (`Timeline.tsx:1851-1854`) with no export and no rendered
consequence a test can read. As written, spec intentions 15 and 20 have no
writable observable.

**Evidence, and the fix is in-repo.** `dashboard/src/routes/contact/Timeline.ticker.test.tsx`
already exists and already solves exactly this. Its header documents why
`vi.getTimerCount()` is unusable (polluted by `CallCard`'s own `setTimeout` and RTL
internals) and establishes the working observable: spy on `window.setInterval` /
`window.clearInterval`, capture the returned `tickerId`, and assert
`spies.set` call counts plus `spies.clear` called with that id (`:98-119`,
`:157-203`, `:435-451`). It also carries the timer discipline this plan will need
(`startFakeClock()` releasing the shared Date pin before installing fake timers)
and derives every instant from the fake clock rather than a literal.

**What it implies.** The plan should name that file and its pattern rather than
inventing two helpers. Of the six helpers the plan invents, this is the only one a
builder could not write from the existing suites: `runHandler` follows
`app/test/relayFanOut.test.ts`'s `dispatchJob(JSON.parse(JSON.stringify(envelope)))`
shape (`:853`, `:973`); `retryRows`/`writeSlotTerminal` follow the webhook harness's
`world.messages` (`app/test/helpers/twilioWebhookHarness.ts:1096`);
`renderRelayThread` follows the `renderTimeline` helper that both
`Timeline.test.tsx:21` and `Timeline.delivery.test.tsx:24` already define;
`exhaustFanoutPasses` is three `claimFanoutPass` calls; `mediaPointerCount` needs
`mediaPointerPk`, which IS exported (`app/src/repos/messagesRepo.ts:235`).
`advance` is writable only inside the fake-timer discipline above.

## 8. [MEDIUM] Nothing asserts the retry job uses the status-preserving bump

**What is wrong.** Task 4 builds and proves `touchLastActivityPreservingStatus` at
the repo level. Task 5 asserts only `expect(bumpSpy).toHaveBeenCalledTimes(1)`
(plan `:619`). A `bumpSpy` on the wrong method passes.

**Evidence.** Plan `:615-620` and `:687`. Spec intention 13 states the proof as "a
group closed mid-backoff staying closed" - but D9's gate refuses on a closed group
BEFORE any send (plan `:679-681`), so in that scenario no bump happens at all and
the test cannot distinguish `touchLastActivity` from its status-preserving twin.
The only window where the two differ is a close landing between the gate check and
the bump.

**What it implies.** The decision D16 exists for is unprovable as specified. The
honest assertion is direct: assert the job calls
`touchLastActivityPreservingStatus`, or assert on a conversation whose status is
flipped to `closed` between the gate and the bump.

## 9. [MEDIUM] Two spec intentions are proven once where they say "every rung", and one `retryClaim` value is never asserted

**What is wrong.** Two coverage holes the self-review's "all twenty appear as named
steps" (plan `:1518-1519`) does not survive.

- **Intention 7** - "Other members receive no duplicate send, **on every rung**".
  The only proof is the e2e's `reachableMsgs ... toHaveLength(1)` (plan `:1460-1461`),
  on a ladder that runs a SINGLE rung, because the fake's arming is one-shot per
  destination and the retry therefore lands clean
  (`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts:34-37`). Rungs 2
  and 3 are never walked with another member on the roster. Task 6's "stops at the
  cap" (plan `:797-800`) walks the rungs but asserts only the retry count.
- **Intention 19** - "Every decline path stamps its own `retryClaim` value". The
  spec enumerates seven values (`claimed`, `cap_exhausted`, `gate_refused`,
  `fenced_announcement`, `to_missing`, `to_malformed`, `source_unreadable`). The
  plan asserts six: `source_unreadable`, `to_missing`, `to_malformed` (Task 6),
  `gate_refused`, `cap_exhausted` (Task 5), `claimed` (Task 7).
  **`fenced_announcement` is asserted nowhere** - Task 6's announcement test checks
  only `retryRows()` length (plan `:773-776`) and Task 7's checks only that
  `errorLogs()` is empty (plan `:883-886`), which is the WARN assertion, not the
  cause field.

## 10. [MEDIUM] Two readers of the same failure event are unenumerated

**What is wrong.** The plan enumerates writers of `delivery_recipients` well. Two
READERS of the failure the retry now repeats are not mentioned in any task.

- **`flagPlacementAttention`.** The relay branch raises the placement attention
  flag on every undelivered/failed leg (`app/src/routes/webhooks/twilio.ts:2526`).
  A retry leg's DLR resolves through its own `relaysid#` pointer into the SAME
  handler, so a three-rung ladder raises it four times where today it raises once,
  and it raises it while a retry is still live - i.e. it escalates to a human at
  the moment the design has just decided the machine will handle it. Whether the
  escalation should wait for the chain to be terminal is a real question the spec
  does not answer and the plan does not raise.
- **The retry row's message-level transport meta.** `presentMessageTransport`
  reads `input.recipients` and aggregates
  (`dashboard/src/lib/messageTransport.ts:82`, `:78-96`); a retry row carries a
  single-entry map, and in the legacy branch of finding 5 that slot has no
  `transportAggregationState` at all, so `expected` is empty. The plan lists
  `messageTransport.ts:43-56` in scope but only as "the funnel every projected
  entry passes through" (plan `:929`) - the aggregate at `:78-96` is a different
  reader of the same map.

UNVERIFIED, checked and probably safe: AI fact extraction reads a transcript window
by `listByConversation` (`app/src/jobs/extraction.ts:456`) and would see retry rows
as duplicated bodies, but it exits on contact type before that
(`:443-450`) and I did not establish that a relay-group conversation can reach it.
Worth one grep during the build rather than a task.

## 11. [MEDIUM] Task 5 never says what preview text the bump writes

D12 fixes the ROW body as raw and the LEG copy as prefixed. The bump writes
`last_message_preview` (`app/src/repos/conversationsRepo.ts:1541`). Task 5 Step 5
says only "then `touchLastActivityPreservingStatus` (D16)" (plan `:687`), and Task
4's test passes a literal `'retry landed'` (plan `:475-476`). If the builder passes
the leg copy, the inbox row for a group is rewritten to `Sam: ...` for a message
the operator already read as `...` - which is the exact defect D12 was written to
prevent, arriving through the bump instead of the row. Name the argument: the raw
body, or nothing.

## 12. [MEDIUM] Task 9's tests hardcode the staleness budget the spec says must not be duplicated

Plan `:1041`: `const BUDGET = 15 * 60 * 1000;   // STALE_SENT_AFTER_MS`. D18 reuses
that constant explicitly "so two horizons cannot drift", and it is exported
(`dashboard/src/routes/contact/deliveryStatus.ts:58`). A commented copy in the test
is the drift the decision names. `Timeline.ticker.test.tsx` makes the opposite
choice deliberately and says why in its header ("No hardcoded clock literal
anywhere: every fixture instant is derived from the fake clock's own `Date.now()`").
Import it.

## 13. [LOW] Task 3's extracted signature needs a type the file does not export

`sendOneRelayLeg`'s declared argument list takes `transport: RelayTransportMode`
(plan `:409`), which is a non-exported type alias
(`app/src/jobs/relayFanOut.ts:957`). Task 3's "only permitted edits are mechanical"
instruction (plan `:434-437`) does not include exporting it, so Task 5 cannot type
its call. Same for `MediaAttachment` and `MessageItem`, which ARE exported from
`messagesRepo.ts`. One line in Task 3's step.

## 14. [LOW] Two smaller plan-vs-repo mismatches

- **Task 14 Step 3** treats `relay-inbound-source-has-no-delivery-rollup` as
  already filed. It is (`docs/issues/relay-inbound-source-has-no-delivery-rollup.md`
  exists), so Sec 8 obligation 3 is met - but the plan should say "verify it names
  the three hosts" rather than implying a step that files it, since obligation 3
  specifies that detail.
- **Task 7 Step 1** asserts `expect(errorLogs()).toHaveLength(0)` for the
  1:1/group-text control (plan `:889-892`). That control is a 30003 on a 1:1, which
  is WARN today by `isTerminalDeliveryFailure` (`app/src/routes/webhooks/twilio.ts:310-314`) -
  correct - but `toHaveLength(0)` on a shared log collector will also pass if the
  relay assertions in the same suite have not run yet and fail if they have.
  Assert the absence of a matching object, as the other tests in the same block do.

---

## Coverage walk - what I checked

**Decisions.** D1-D11, D13, D15-D23 all reach a task with a test. The exceptions
are D12 (finding 1 - no field for the leg copy, no assertion on the raw body),
D14 (finding 6 - mapped to Task 5, implemented in Task 6, tested nowhere), and
D2's legacy-mirroring paragraph (finding 5). The self-review's decision map is
accurate except for D14.

**Test intentions.** 1, 2, 3, 4, 5, 8, 9, 11, 12, 13(SSE half), 14, 15, 16, 17, 20
are covered by named steps with a statable red. 6 and 18 have none (findings 5, 6).
7 and 19 are partial (finding 9). 10 is partial (finding 1). 13's bump half is
untestable as specified (finding 8). So the self-review's "All twenty test
intentions in Sec 7 appear as named steps" is false for two and thin for four.

**Sec 8 obligations.** All four map to Task 14, and Task 14's steps match them. The
spec's rev-6 addition - "The only environment touch is the e2e lane's backoff
override ... which is lane-local and never set in dev or prod" - is covered by Task
13 Step 1's lane-only assertion.

**What the plan got right that I expected it to lose.** Both halves of
`unconfirmed`, with a comment naming why half one alone was wrong three times (plan
`:1078-1093`). The ticker's TERMINATION as its own test, distinct from
`unconfirmed` appearing (plan `:1321-1326`). The projection's two lifetimes, split
into two exported functions with the reason stated (plan `:1014-1031`). The
slot-code-ABSENT clause with its `canceled` reachability citation (plan
`:757-763`). `retryState` as a separate field with the exact failure mode of
overloading `status` written out (plan `:1033-1036`). Fenced-legs-keep-WARN (plan
`:882-886`). The consistent read as its own task, with the correct refusal to make
`getByTsMsgId` consistent (plan `:355-361`). Five of the six the coordinator named
survived intact; the sixth is finding 5.
