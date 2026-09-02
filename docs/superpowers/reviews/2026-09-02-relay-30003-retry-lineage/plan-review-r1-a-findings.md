# Plan review r1-a - relay 30003 retry lineage

Adversarial review of
`docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md` against
`docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`
(revision 6) and the code in `W:\tmp\relay-30003-retry-lineage` at
`38cb3a75`.

Question answered: if a builder with no context executes the plan LITERALLY,
do they produce the spec? Every claim about existing behavior below cites a
file:line I opened in this worktree. Anything I could not confirm is marked
UNVERIFIED.

---

## BLOCKING

### B1. D12's "exact leg copy stored separately" has no storage field anywhere in the plan

D12 (spec :386-394) requires the retry row to store the RAW body AND, in a
SEPARATE place, the exact composed leg copy, so a sender rename between
attempts cannot change what the member receives.

Task 1's Interfaces block fixes exactly FIVE new stored fields
(`relayRetryOf`, `relayRetryMemberKey`, `relayRetryAttempt`,
`relayRetryDestDigest`, `relayRetryOriginDirection`) plus their snake_case
twins (plan :123-131). None is the leg copy. Task 8 then closes the door on
adding a sixth by asserting "Four fields, not five: the destination DIGEST
stays server-side" (plan :937) - i.e. exactly five are stored.

But Task 5's test asserts the composed copy survives a rename
(plan :624-628), Task 5 step 5.4 says to call `sendOneRelayLeg` "with the
row's stored leg copy" (plan :682), and Task 6 step 7 says to append
"the five lineage values, the raw body, the leg copy and the seeded slot"
(plan :833). Three steps consume a field the plan never creates.

This is not cosmetic. The leg copy is what `sendOneRelayLeg` sends as `body`,
and the fan-out composes that value OUTSIDE the extracted range
(`app/src/jobs/relayFanOut.ts:996-1007`, `composeRelayBody` applied at
`:998`). A builder with no context has exactly two literal options: store the
composed body ON the row - which D12 explicitly forbids because it rewrites
the inbox preview and shows two strings for one logical message - or
re-compose at send time from the live roster, which is the sender-rename bug
the decision exists to prevent. Sec 7 intention 10 ("preserve the original leg
copy byte for byte when the sender's display name has changed between
attempts") is undeliverable as written.

### B2. D2's legacy-vs-versioned retry row and slot seeding is entirely absent; Sec 7 intention 18 has no step

The word "legacy" appears ZERO times in the plan (verified by grep over the
plan file). D2 spends four paragraphs (spec :138-164) on this and the spec
calls it "the ordinary case for an old message, not an edge one":

- a VERSIONED original seeds `{status:'queued', requestedTransport:<intent>,
  transportAggregationState:'planned'}`;
- a LEGACY original seeds `{status:'queued'}` with no transport fields;
- `planned` is load-bearing because `setVersionedAggregationState` can only
  reach `attempted` from `planned` and throws otherwise
  (`app/src/jobs/relayFanOut.ts:1406-1426` - the throw is at `:1425`,
  reached from the extracted body at `:1180`);
- a versioned slot on a legacy original drives `markRecipient`'s blind
  whole-slot write (`relayFanOut.ts:1451-1463`, reached through
  `persistRelayRecipientResult`'s legacy branch at `:1435-1437`).

The plan's ONLY persistence fixture for the retry row seeds the VERSIONED
shape - `transportSchemaVersion: 1` with `requestedTransport: 'sms',
transportAggregationState: 'planned'` (plan :266-272). Task 6 step 7 mentions
"the transport MODE from the ROOT (D2)" in a subordinate clause (plan :832)
and nothing else. Sec 7 intention 18 - "A LEGACY original produces a legacy
retry row and slot, and its send does not take the versioned path" - maps to
no step, no test and no assertion.

Compounding it: Task 5 never says how the `transport: RelayTransportMode`
argument to `sendOneRelayLeg` is derived for the retry job. In the fan-out it
comes from the source's `transport_schema_version` at
`relayFanOut.ts:791-795` and, for the versioned arm, from
`adapter.classifyMessageTransport(...)` at `:975-978` - both outside the
extracted range. A builder has to invent that derivation, and the obvious
guess (always versioned) is precisely the one D2 says throws on the first
retry send.

### B3. `EffectiveRelayLeg` as typed cannot be substituted at the consumers Tasks 10 and 11 point at it

Task 9 fixes `EffectiveRelayLeg` to three fields: `status`, `errorCode?`,
`retryState?` (plan :1007-1012). Task 10 then says `presentRelayDelivery`
accepts `EffectiveRelayLeg[]` and `presentLegDelivery` accepts an
`EffectiveRelayLeg` (plan :1148-1150), and Task 11 says "Point all four reason
sites at the projected legs" (plan :1339).

Those consumers read five fields the type drops:

- `includedRecipientEntries` / `isRecipientExcludedFromPresentation` need
  `transportAggregationState`
  (`dashboard/src/lib/messageTransport.ts:17-20`, `:43-47`, `:49-57`), and
  `presentRelayDelivery` calls it first thing
  (`dashboard/src/routes/contact/deliveryStatus.ts:407`).
- `stalenessClockMs` reads `slot.sentAt` and switches on `slot.status`
  (`deliveryStatus.ts:206-233`); `isStaleLeg` (`:247-255`) and
  `canEverGoStale` (`:329-342`) are built on it, and both are called from
  `presentRelayDelivery` (`:415`), `presentLegDelivery` (`:541`) and
  `hasTickableLeg` (`Timeline.tsx:806-811`).
- `recipientRowTime` reads `slot.deliveredAt` and `slot.sentAt`
  (`Timeline.tsx:499-503`), and it is what fills `row.when` in
  `orderRecipientRows` (`:529`), which is typed
  `Array<[string, RelayRecipientDelivery]>` (`:520-522`).
- `presentRecipientTransport` reads `requestedTransport` / `actualTransport` /
  `transportAggregationState` (`messageTransport.ts:59-77`) and is called on
  `row.slot` at `Timeline.tsx:591` and `:1119`.

So the projected type must CARRY the slot, not replace it. As written, a
literal build either (a) fails typecheck at every one of those sites, or
(b) "fixes" it by widening the projection until the staleness and transport
data survive - a design decision the plan does not make and no reviewer
downstream will re-derive.

Worse, `Timeline.tsx` is the SHARED renderer: `rosterKind` selects between
relay and native group text (`:826-830`, `:1095`, `:587`), and native group
text is a hard fence in spec Sec 2. Routing group-text legs through a
three-field projection strips their `sentAt` and aggregation state and moves
the fenced product's "not confirmed" and transport rendering.

### B4. The "no task leaves a stated guarantee violated between commits" claim is false, and the parallelism claim makes it worse

Self-Review (plan :1530-1534): "Tasks 1-7 are server and stand alone; 8-12 are
dashboard ... the two halves can proceed in parallel after Task 1 ... until
Task 11 nothing renders a retry state - the display simply reads as it does on
`main`."

It does not. After Task 6 the webhook appends a real message row to the relay
conversation, and after Task 5 the job sends it. That row is returned by
`GET /api/conversations/:id/messages` as-is
(`app/src/routes/api.ts:2160-2174` - `res.json({ messages: page })`), mapped
by `toTimelineMessage` (`useRelayThread.ts:102-134`) and rendered, because the
D20 filter does not exist until Task 11 (`visible` memo at
`Timeline.tsx:1788-1800` today only hides `retry_of` predecessors, and D20
forbids stamping `retry_of`).

So between commit 6 and commit 11 every relay thread renders each retry
attempt as a SECOND bubble carrying the same raw body, the same
`relay_sender_key` and the same author - including retries of INBOUND
originals, which is the exact "duplicate member message" D20 says the
predicate exists to prevent (spec :627-633). An MMS retry additionally renders
its own `AttachmentGallery` (`Timeline.tsx:1036`). Up to three such rows per
failed leg.

This is a real, user-visible regression on a shipped surface, present for as
long as the two halves are out of step - which the plan explicitly authorises
by declaring them parallel.

---

## HIGH

### H1. The e2e backoff seam is placed in the wrong process, and no mechanism is specified

Plan Task 13 step 1 and the File Structure list name
`app/src/routes/dev.ts` as "the lane-local backoff override seam"
(plan :78, :1407-1418). Spec Sec 7 says the value is "injected through the
retry job's existing deps object with the lane supplying the value"
(spec :809-814).

`routes/dev.ts` is mounted by the APP process. The retry job runs in the
WORKER: `scripts/e2e-session.mjs:381` spawns
`app/src/worker.ts` as its own `node` child, and `app/src/worker.ts:15-29`
imports `registerAllJobHandlers` and the poll loop and mounts no Express
router at all. An HTTP call into `routes/dev.ts` cannot mutate the worker's
registered handler deps.

The plan supplies no env var name, no read site, no wiring in
`registerHandlers.ts`, and step 1 is only "prove it is lane-only". A literal
build therefore leaves the first rung at the real 60s, against Task 13's
`{ timeout: 60_000 }` assertion (plan :1446) - which sits exactly on the
boundary before the send, the callback and the job dispatch are counted.

### H2. Task 13's own e2e snippet is self-contradictory and would throw on strict mode

The existing spec binds `const bubbleBody = page.getByText(token)` and treats
it as a single element: `expect(bubbleBody).toBeVisible()`, then
`bubbleBody.locator('xpath=..')` to get the bubble, then `bubbleBody.click()`
(`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts:146-148`,
`:178`).

Task 13 step 2 adds `const bubbles = page.getByText(token); await
expect(bubbles).toHaveCount(2);` (plan :1449-1450) and then still calls
`await bubbleBody.click();` (plan :1455). Once the delivered retry renders its
own bubble with the same body, `page.getByText(token)` resolves two nodes and
every single-element operation on it is a Playwright strict-mode violation.
The plan never says to re-scope `bubbleBody`, `bubble`, `rollup`, `list` or
`failedRow` to the original bubble. Its instruction is the opposite - "Keep
its `createGroupOpen` arrangement and its intro-settle barriers verbatim".

### H3. Task 13 renames the spec but never removes the old file

Plan Task 13: "Rename the file to `relay-30003-retry.spec.ts`" (plan :1411);
the commit stages only
`e2e/tests/dashboard-next/relay-30003-retry.spec.ts` and
`app/src/routes/dev.ts` (plan :1472). Nothing deletes or `git rm`s
`relay-30003-no-retry-promise.spec.ts`. Under a literal execution the old spec
stays on disk and tracked, Playwright runs both, and the old one fails: its
assertion 1 pins `delivered 1/2 - 1 failed - Phone unreachable (error 30003)`
(that file :158-160) and its accessible-name assertion pins
`Undelivered, Phone unreachable (error 30003)` (`:167-169`), both of which the
new copy replaces.

### H4. `relay_retry_of` chaining for rungs 2 and 3 is never specified, and nothing pins it

Rung 2's claim runs when the RETRY LEG's callback resolves through its own
`relaysid#` pointer, so `source` in `handleRelayRecipientStatus` is the RETRY
ROW, not the original. Task 6 step 6 handles only the attempt number
("`source.relay_retry_attempt ?? 0`, next = +1", plan :829-830). Step 7 says
"storing the five lineage values" (plan :833) and never says that
`relay_retry_of` must remain the ORIGINAL root rather than the row just read.

Both consumers assume the root:

- Task 9's `indexRelayRetries` buckets by
  `${relay_retry_of}|${relay_retry_member_key}` and `projectRelayLegs` looks
  up `${rootTsMsgId}|${memberKey}` (plan :1015-1025, :1116-1117). Chaining to
  the previous row orphans rungs 2 and 3 from the original bubble entirely -
  the chip would read "1 retrying" for ever and never reach `terminal`.
- Task 5's changed-number gate hashes `relayRetryDigest(rootTsMsgId,
  member.phone)` (plan :678-680); a per-rung root mints a new ladder identity
  each rung, which silently defeats D3's determinism argument.

No test asserts rung 2's `relay_retry_of`. Task 6's cap test only counts
`retryRows()` (plan :797-800), and `retryRows()` is undefined (see M8), so it
may or may not filter on the root.

### H5. `hasTickableLeg`'s new clause has no defined input, and the plan gives no signature

D18 is explicit that the retry state must arm the ticker itself
(spec :509-519). `hasTickableLeg` is called as `hasTickableLeg(i, tickNow)`
over `visible` inside `tickerArmed`'s memo
(`Timeline.tsx:1850-1853`), and D20 removes the retry rows from `visible`. So
the new clause cannot read anything from `i` - it needs the thread-level
projection.

Task 11 step 5 says only "extend ... `hasTickableLeg` with the retry clause"
(plan :1341-1342). It never states the new signature, never says what
`tickerArmed`'s memo deps become, and never says which clock the hidden retry
row is judged against - `bubbleClocks` yields one clock per RENDERED message
(`Timeline.tsx:734-742`) and the retry row is not rendered. This is the exact
failure D18 says would reintroduce M5's permanent "retrying", and the plan
leaves the builder to design the fix.

### H6. Two interface additions break typed fakes the plan never names, failing gate 1

Task 2 adds `getByTsMsgIdConsistent` to the `MessagesRepo` interface
(`app/src/repos/messagesRepo.ts:1339` is the sibling) and stages two files
(plan :371). Four fully-typed `MessagesRepo` object literals exist and will
stop compiling:
`app/test/helpers/twilioWebhookHarness.ts:1061`,
`app/test/scheduledSendSuppression.test.ts:265`,
`app/test/sendMessage.test.ts:223`
(plus `app/test/messagesRepo.callStatus.test.ts:51` and
`app/test/systemSidMarker.test.ts:24`, which are typed references -
UNVERIFIED whether those two construct literals).

Task 4 adds `touchLastActivityPreservingStatus` to `ConversationsRepo` and
stages two files (plan :516). Four typed `ConversationsRepo` literals exist:
`app/test/contactCapture.test.ts:146`,
`app/test/helpers/twilioWebhookHarness.ts:507`,
`app/test/scheduledSendSuppression.test.ts:154`,
`app/test/sendMessage.test.ts:102`.

None is listed in either task's Files block. `npm run typecheck` (required
gate 1) fails at both commits. The harness update is also a PREREQUISITE for
Task 6's `consistentReadSpy` test (plan :778-785), which spies on a method the
relay webhook harness's fake repo does not have.

---

## MEDIUM

### M1. Task 12 is a no-op with a fake red state

All three hosts already pass their item list into the SAME shared
`<Timeline>`: `ConversationDetail.tsx:480-482`,
`TourConversation.tsx:467-469`, `PlacementConversation.tsx:319-321`. Task 11
puts `indexRelayRetries`, `projectRelayLegs`, the D20 `visible` filter and the
ticker clause INSIDE `Timeline.tsx` (plan :1336-1342). Nothing in the hosts
needs to change.

So Task 12's premise - "A build that threads the retry rows through
`ConversationDetail` alone leaves the tour and placement transcripts rendering
the pre-change copy" (plan :1368-1370) - is wrong, its step 2 red
("Expected: FAIL on the tour and placement hosts", plan :1388) would already
be green after Task 11, and its step 3 ("Implement, then re-run") has nothing
to implement. Its commit stages three unmodified files (plan :1398).

The host regression TESTS are worth keeping. The task should say so instead of
claiming a change.

### M2. `app/test/conversationsRepo.integration.test.ts` does not exist

Task 4 lists it under "Test:" with the parenthetical "(follow the existing
file's harness)" (plan :459-460) and step 2 runs it expecting
"FAIL - method missing" (plan :491-492). The file is absent from `app/test/`;
the nearest siblings are `conversationsRepo.email.test.ts` and
`relayRepos.integration.test.ts`. Vitest answers "no test files found", which
is not the red the step describes, and there is no "existing file's harness"
to follow.

### M3. Sec 7 intention 6's server half is untested

D14's `enqueue_failed` close is stated in Task 5's `RelayRetryCloseCode` union
(plan :549) and in Task 6 step 8 (plan :835-836), but no test in Task 5, Task
6 or Task 10 exercises an enqueue failure reaching a terminal state. Task 10's
`it.each` for internal-code prose covers only D15's FOUR gate codes
(plan :1183-1190); `enqueue_failed` and `transient_cap` already exist in
`INTERNAL_CODE_REASONS` (`deliveryStatus.ts:688-692`, verified) so the copy
half is fine, but "an enqueue failure still reaches a terminal state, with a
close code distinct from cap-exhausted" has no proof.

### M4. Task 3's extraction and Task 5's consumer contradict each other about who writes the slot and the pointer

Task 3 is declared "a behavior-preserving extraction" of
`relayFanOut.ts:1118-1269`, "without changing a line of logic"
(plan :414, :432). That range ENDS with `persistRelayRecipientResult(...)` and
`putRelaySidPointer(...)` on the success branch
(`relayFanOut.ts:1250-1267`, verified). So `sendOneRelayLeg` already writes
both.

Task 5 step 5 then instructs, on the `sent` branch: "write the slot and a
`relaysid#` pointer for the NEW SID pointing at the RETRY row and its member
key" (plan :685-687). Either the extraction is not verbatim, or the retry job
duplicates two writes. The plan's `RelayLegSendOutcome.providerSid`
(plan :391) implies the caller is expected to do it, which contradicts the
verbatim-move instruction.

Related: the extracted range's own opted-out arm writes `contact_opted_out`
and calls `conversations.setRelayMemberOptedOut`
(`relayFanOut.ts:1123-1157`), while D9/D15 require the retry's opt-out refusal
to be `retry_opted_out`. Task 5's gate order makes that arm unreachable for
the retry path, but the plan never says so, and Task 5 step 5 lists a
`suppressed` outcome kind it then has to map to a different code.

### M5. Sec 7 intention 11's server half is missing

"A retry row does not carry `retry_of`" has no assertion anywhere. Task 6
step 7's field list never mentions omitting it, and `retry_of` is the natural
field to reach for - D20 says stamping it adds the ORIGINAL to
`supersededIds` and deletes the original bubble
(`Timeline.tsx:1789-1797`, verified). The only coverage is Task 11's
`never hides the original` (plan :1290-1293), which is a client test that
would still pass on a server that stamps the field, as long as the client
fixture does not.

### M6. One of D23's seven `retryClaim` values is never asserted, and the message-string half is not tested

Task 6 asserts `retryClaim` for `source_unreadable`, `to_missing`,
`to_malformed` (plan :782-795); Task 5 for `gate_refused` and `cap_exhausted`
(plan :598-600, :659-661); Task 7 for `claimed` and `cap_exhausted`
(plan :867-873). `fenced_announcement` is never asserted - Task 6's
announcement test checks only `retryRows()).toHaveLength(0)`
(plan :773-776). Sec 7 intention 19 also requires "an unreadable source takes
its own message rather than the carrier-shaped one"; Task 7 step 3 says to add
it (plan :904-906) but no test asserts the differing string.

### M7. Sec 7 intention 13's status-preservation proof does not run through the job

The spec's phrasing is "the post-send bump does not write `status`, proven by
a group closed mid-backoff staying closed". Task 4 proves the REPO METHOD in
isolation (plan :472-486). Task 5's send test asserts only
`expect(bumpSpy).toHaveBeenCalledTimes(1)` (plan :619). A `bumpSpy` cannot
distinguish `touchLastActivityPreservingStatus` from `touchLastActivity`, so
a build that wires the wrong one passes every test in the plan.

### M8. About thirty test helpers are used and never defined; the Timeline ones have no analogue in the repo

Server-side (`runHandler`, `retryRows`, `postStatus`, `writeSlotTerminal`,
`consistentReadSpy`, `listMessages`, `postFailureForLatestAttempt`,
`exhaustLadder`, `exhaustFanoutPasses`, `slotOf`, `closeGroup`,
`removeMember`, `changeMemberPhone`, `suppressMember`, `renameSender`,
`presignSpy`, `bumpSpy`, `enqueueSpy`, `sendSpy`, `emitSpy`,
`mediaPointerCount`, `announcementLegSid`, `postDirectStatus`) mostly map onto
real harnesses a builder can find: `signedTwilioPost(app,
'/webhooks/twilio/status', ...)` at `app/test/relayWebhook.test.ts:209`,
`createLogCapture` imported at `:30`, and the `world.messagesRepo` fake at
`app/test/helpers/twilioWebhookHarness.ts:1061`. That is discoverable work,
though `consistentReadSpy` additionally requires the fake to gain the method
(see H6).

The DASHBOARD ones do not. Task 11 and Task 12 call `renderRelayThread({...})`,
`tickerArmed()` and a destructured `{ advance }` (plan :1251, :1264, :1311,
:1315, :1325, :1380). The existing ticker suite uses a completely different
idiom: `renderTimeline(props)` at
`dashboard/src/routes/contact/Timeline.ticker.test.tsx:50`, a fake clock via
`startFakeClock()` at `:96-100`, `vi.advanceTimersByTime(...)` at `:144` and
so on, and arming is observed by spying on `window.setInterval` /
`window.clearInterval` (`spyOnIntervals` at `:104-110`). There is no
`tickerArmed` observable in the component - the plan's Task 11 step 3 asks the
builder to invent one. `Timeline.delivery.test.tsx:24` likewise exposes
`renderTimeline`, not `renderRelayThread`.

Task 9's fixtures (`project`, `queuedRetry`, `sentRetry`, `failedRetry`,
`deliveredRetry`, `refusedRetry`, `memberKey`, `now`) and Task 10's
(`legsWith`, `mixedLegs`, `allDelivered`, `relayOpts`, `rowTextOf`) are
likewise undefined but are ordinary fixtures for a new file.

### M9. `RelayRetryRow` is consumed in a public signature and never defined

Task 9's `indexRelayRetries` returns `Map<string, RelayRetryRow[]>` and
`projectRelayLegs` takes `retries: Map<string, RelayRetryRow[]>`
(plan :1015-1025). `RelayRetryRow` is defined nowhere in the plan and does not
exist in the dashboard today. The Self-Review's "Type consistency ...
`EffectiveRelayLeg` and `RelayRetryState` are defined once in Task 9"
(plan :1525-1528) does not cover it.

### M10. Task 8 lists and stages `messageTransport.ts` with no instruction and no test

Task 8's Files block names `dashboard/src/lib/messageTransport.ts:43-56`
(plan :929) and its commit stages that file (plan :985), but step 3 is only
"Add the type fields and project them" and neither test touches it
(plan :944-980). Spec Sec 2 calls those lines "the funnel every projected
entry passes through" (spec :73-74), which is
`isRecipientExcludedFromPresentation` / `includedRecipientEntries`
(`messageTransport.ts:43-57`, verified). A builder is told to change a file
and not told what to change - and the real change it needs is the one B3
identifies, which is assigned to no task at all.

### M11. The docblock instruction is factually wrong against this worktree

Task 11 step 5: "extend its docblock from four non-terminations to five"
(plan :1342); D18 says the same (spec :532-535). `hasTickableLeg`'s docblock
in THIS worktree already enumerates FIVE numbered non-terminations -
`Timeline.tsx:752-772`, item 5 being the futurity bound added with the
browser-clock-skew fix. The retry clause is the SIXTH. A builder following the
instruction literally will either renumber an existing entry away or write a
second "5".

The cited line range is also wrong: the plan and spec both cite
`Timeline.tsx:788-812` for the docblock (plan :1240, spec :534); the docblock
runs `:744-797` and the function body is `:798-812`.

### M12. Task 13 step 3's run command is wrong twice

"Run: `npm run e2e -- --grep "relay-30003"` from the e2e workspace ... Never
run Playwright from the repo root" (plan :1466-1467). `npm run e2e` IS the
root script (`package.json:41` delegates to `-w @housingchoice/e2e`), so the
command and its own caveat contradict each other. Separately, Playwright's
`--grep` filters TEST TITLES, and no title in that file contains
"relay-30003" - the title is
`'a relay leg that failed 30003 promises no retry: chip, accessible name and
row'` (`relay-30003-no-retry-promise.spec.ts:103`). The step as written
selects zero tests.

---

## LOW

### L1. Task 1 step 7's snippet drops the `Put` wrapper

The snippet splices `mediaPointerItems(...)` directly into the transaction
(plan :293). The existing code maps each pointer into `{ Put: { TableName,
Item: ptr } }` (`messagesRepo.ts:2286-2290`). Caught by typecheck, but the
snippet is what a builder copies.

### L2. The retry's inbox preview is unspecified

Task 5 step 5 calls `touchLastActivityPreservingStatus` with no stated preview
argument (plan :686-687); Task 4's fixture passes the literal
`'retry landed'` (plan :475). D12 warns explicitly that the composed body must
not rewrite the inbox preview (spec :386-394). Nothing in the plan says the
preview must be the retry row's RAW body (i.e. unchanged from the original).

### L3. `flagPlacementAttention` is an unenumerated reader of the same failure

`twilio.ts:2522-2528` escalates the placement with `'send_failed'` on any
transitioned relay leg failure. After this change that fires on the FIRST
30003 even though a retry has just been claimed and may deliver. Neither the
spec nor the plan names it. Not in scope to change - but it is a reader of the
invariant the feature moves, and it is unlisted.

### L4. `unconfirmed` and the pre-existing staleness "not confirmed" share one label slot

`presentRelayDelivery` already emits `... - K failed, J not confirmed` from
`isStaleLeg` (`deliveryStatus.ts:415`, `:433-436`). D19's `unconfirmed` retry
state produces the same phrase (plan :1158). Task 10 step 4 says to subtract
the three new states from `failed` (plan :1213-1218) but never says whether a
retry-`unconfirmed` leg and a staleness-stale leg sum into one count or are
counted twice. The plan's own note that "K and J are DISJOINT by construction"
(`deliveryStatus.ts:376-378`) no longer holds automatically.

### L5. Sec 7 intention 7 is proven once, not "on every rung"

"Other members receive no duplicate send, on every rung" appears only as the
e2e's step-5 assertion for the reachable member after ONE rung
(plan :1458-1461). No unit test covers rungs 2 and 3.

### L6. D19's "four reason sites" omits a fifth

The spec enumerates the rollup reason, the rollup accessible name, the inbound
recital and the per-recipient row (spec :578-586), and Task 11 repeats "all
four reason sites" (plan :1339). There is a FIFTH `recipientSummaryName` call
at `Timeline.tsx:978-989` (`messageChipName`, the all-opted-out branch-0
case). It cannot carry a retry state today because it fires only when every
leg opted out, so leaving it is probably right - but a builder pointing "all
four" at the projection will find five call sites and have to decide alone.

### L7. Line-number drift in cited anchors

- `visible` memo is `Timeline.tsx:1788-1800`; plan cites `:1787-1799`
  (plan :1240, :1287).
- `tickerArmed` is `Timeline.tsx:1850-1853`; plan cites `:1851-1854`
  (spec :511).
- `handleRelayRecipientStatus` ends at `twilio.ts:2529`; plan cites
  `:2442-2561` (plan :713).
- `retrySend.ts`'s cap constant is at `:37` and `retryBackoffMs` at `:39-42`;
  cited correctly.

All minor, but Task 6 and Task 11 are the two tasks whose instructions are
"edit at line N".

---

## What I verified and found CORRECT

Recorded so a later reviewer does not re-derive them:

- D3's claim mechanism holds. `append`'s transaction puts the row at index 0
  and the `sid#` pointer at index 1, attributes a dedupe to index 1 ONLY, and
  rethrows any other condition failure
  (`messagesRepo.ts:2210-2233`, `:2294-2306`, `:2374-2388`). A duplicate
  callback with a fresh wall-clock `providerTs` passes index 0 and loses index
  1, so it returns `{deduped:true}` with the winner's key - exactly as Task 1's
  fixture expects. Media pointers are LAST (`:2280-2290`) so the suppression
  does not move index 1.
- D3's `bumpKey` argument holds: the fan-out's five-row source window bounds on
  `bumpKey(sourceTsMsgId)` (`relayFanOut.ts:771-774`, `:1471-1473`), which
  excludes any later timestamp, so wall-clock retry rows cannot displace the
  source.
- D8's reachability argument holds: `mapTwilioStatus` maps `canceled` to
  `failed` with no code (`app/src/adapters/messaging.ts`, the switch just above
  the `default`), and `updateRecipientDeliveryStatus` returns a bare boolean
  after an eventually-consistent GET (`messagesRepo.ts:3443-3517`, GET at
  `:3447-3449`, return at `:3516`).
- D7's premise holds: `getMessageConsistent` is a private closure above the
  factory's `return {` at `messagesRepo.ts:2085` (defined `:1885-1897`), not on
  the interface; `getByTsMsgId` at `:2960` has no `ConsistentRead`.
- D11's premise holds: `GET /api/conversations/:id/messages` returns stored
  rows as-is (`api.ts:2160-2174`).
- D16's premise holds: `touchLastActivity` writes `#s = :open` in its primary
  branch and its status-free variant is the CATCH fallback
  (`conversationsRepo.ts:1531-1589`).
- D15's premise holds: `deliveryReason` falls through to
  `Delivery failed (error <code>)` (`deliveryStatus.ts:731-733`) and
  `INTERNAL_CODE_REASONS` already carries `transient_cap` and `enqueue_failed`
  (`:688-692`).
- The retry rows CANNOT leak into the contact-file timeline: the server
  timeline skips `relay_group` and `group_text` conversations
  (`app/src/routes/contactTimeline.ts:1232`) and the client fallback filters
  the same two types (`useContactTimeline.ts:191-196`). So `contactTimeline.ts`
  and `buildTimelineFallback.ts` - both named as projectors in D17 - genuinely
  need no change, and Task 8's single-projector scope is right.
- `groupSendStaleness` is driven by due rows (`listDueRows`), which the retry
  append does not write, so the server-side staleness sweep is not a reader of
  retry rows.
- `presentRelayDelivery` and `presentLegDelivery` have exactly one importer
  outside their own module (`Timeline.tsx:42-44`), so the signature change in
  Task 10 has no third-party caller - but Timeline serves native group text
  too (see B3).
- `Message` in `dashboard/src/api/types.ts` carries
  `[key: string]: unknown` (`:2343`), so reading `relay_retry_*` off a raw wire
  row needs no type change there.
