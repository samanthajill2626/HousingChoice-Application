# Plan review R3-B (confirmation pass) - relay 30003 retry lineage, plan revision 3

Plan: `docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md` (rev 3)
Spec: `.../specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 6, approved)
Adjudications read: `plan-r2-adjudications.md`.
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

**One finding changes a decision (1). The other six are wording, three of which
are unbuildable-as-written rather than cosmetic (2, 3, 4).** The three things the
coordinator flagged as new prose: the reorder's coherence argument HOLDS and I
could not break it; the transport-mode change is CORRECT and nothing else in the
job needed the root row; leaving `flagPlacementAttention` untouched is the right
call on the question it was asked, but it is not "unchanged behavior" - finding 1.

---

## 1. [MEDIUM] [CHANGES-DECISION] `flagPlacementAttention` is unchanged in CODE but not in BEHAVIOR - it now fires once per rung, and each firing resets the triage clock

**What is wrong.** Task 12's comment states the function "is UNCHANGED by this
branch, and that is a decision rather than an oversight" (plan `:1540-1547`), and
pins it with a test that posts ONE callback and asserts one call (`:1548-1551`).
The code is unchanged; the number of times it runs per failed leg is not.

**Evidence.** A retry leg's own delivery callback resolves through its own
`relaysid#` pointer into the SAME handler, and the escalation sits on the generic
failure branch: `app/src/routes/webhooks/twilio.ts:2522-2528`, gated only on
`transitioned` and a failed/undelivered mapping. Each rung's slot is fresh and
always transitions (spec D8's own argument), so a three-rung ladder reaches
`:2526` four times where today it reaches it once.

Each call is a write with visible side effects, not an idempotent flag set
(`twilio.ts:412-434`):

- `placements.update(placementId, { attention: { reason, at: new Date().toISOString() } })`
  (`:420`) - **`attention.at` is rewritten with a fresh timestamp every time.**
- `events.emit('placement.updated', ...)` (`:427`) - a live SSE to every open
  dashboard.
- `log.warn({ event: 'placement_escalation', ... })` (`:428-431`) - a countable
  marker line.

**What it implies.** `attention.at` is the "how long has this been waiting" clock
a human triages by. Under this branch it resets at +60s, +180s and +420s after the
original failure, so a placement that failed seven minutes ago presents as flagged
seconds ago - and it does so precisely while the machine is still handling it. Plus
three extra SSE broadcasts and three extra `placement_escalation` markers per
failed leg.

The deferral decision the comment defends is correct and I am not reopening it:
deferring to terminal WOULD lose three escalations, exactly as the comment says.
What has not been decided is the multiplication, because nobody knew about it. Two
honest resolutions:

- **Record it.** Extend the comment and the risks section to say the escalation
  now fires per rung and that `attention.at` therefore tracks the last rung rather
  than the first failure. One paragraph, no code.
- **Scope it.** Raise only on the ROOT leg's callback (`source.relay_retry_of ===
  undefined`), which preserves today's first-30003 escalation exactly and loses
  nothing, because a rung's failure escalates nothing a human did not already
  learn from rung zero.

Either is fine. The pinning test cannot distinguish them - it posts one callback -
so whichever is chosen needs an assertion after `postFailureForLatestAttempt()`
runs the ladder, next to the "never sends to any other member, on any rung" test
that already does exactly that walk (`:1516-1523`).

## 2. [MEDIUM] [WORDING] Task 4's harness citation is wrong; the right one exists and the mediaPointers citation is right only for Task 1

**What is wrong.** Task 4 says "Neither `conversationsRepo.integration.test.ts` nor
`messagesRepo.integration.test.ts` exists - follow
`app/test/mediaPointers.integration.test.ts` for the harness" (plan `:513-515`).
The first half is now correct. The second sends a conversations-repo task to a
messages-repo suite.

**Evidence, and the answer to the question you asked.**

- For **Task 1** the citation is RIGHT and I verified what it needs: the repo
  exposes `listMediaPointers` on the interface
  (`app/src/repos/messagesRepo.ts:1354`, implementation `:2824`), and
  `mediaPointers.integration.test.ts:161` already makes exactly the assertion
  Task 1's `mediaPointerCount` needs -
  `expect(await messages.listMediaPointers(CONV, { limit: 10 })).toHaveLength(4)`.
  Table setup/teardown is at `:7-12` (`createDocumentClient`, `ensureTable`,
  `deleteTableIfExists`). Nothing invented.
- For **Task 4** it is WRONG. That file builds a messages repo and never
  constructs a conversations repo or a conversation, so it demonstrates nothing
  Task 4 needs. The conversations-repo integration harness is
  `app/test/relayRepos.integration.test.ts` - it creates relay groups and already
  drives the exact method Task 4's test calls (`:97`, `:222`, `:389`). Ten
  integration suites build a conversations repo; `relayRepos` is the one whose
  fixtures are relay groups.

## 3. [MEDIUM] [WORDING] Task 4's test calls `setRelayStatus` with two arguments; it takes three, all required

**What is wrong.** Plan `:527`: `await conversations.setRelayStatus(conversationId, 'closed');`

**Evidence.** The interface is
`setRelayStatus(conversationId: string, status: 'open' | 'closed', expectedCurrent: 'open' | 'closed'): Promise<ConversationItem>`
(`app/src/repos/conversationsRepo.ts:850-854`) - `expectedCurrent` is required and
is the conditional precondition; the docblock above it (`:845-849`) says an
unmet precondition throws `ConditionalCheckFailedException`. Every call site in
the repo's own suite passes three: `relayRepos.integration.test.ts:97`, `:222`,
`:389`.

**What it implies.** Task 4 Step 2 expects the red to be "method missing"
(`touchLastActivityPreservingStatus`). The builder instead gets a typecheck error
on the ARRANGE line, which is a different red on a different symbol - the exact
shape that sends someone editing the wrong thing. Write
`setRelayStatus(conversationId, 'closed', 'open')`.

## 4. [MEDIUM] [WORDING] "Resolve the transport MODE from the RETRY ROW ITSELF" conflates the kind with the versioned intent, which cannot be read off any row

**What is wrong.** Task 11 Step 5 item 3 (plan `:1372-1376`) is right about WHICH
row decides, and I verified the reasoning: `sendOneRelayLeg` writes the retry row,
and `applyRecipientSendResult` returns `legacy_noop` on that row's own
`transport_schema_version` (`app/src/repos/messagesRepo.ts:3240`). But
`RelayTransportMode` is not a boolean.

**Evidence.** `type RelayTransportMode = { kind: 'legacy' } | { kind: 'versioned'; intent: MessageTransportIntent }`
(`app/src/jobs/relayFanOut.ts:957-959`). The row supplies the KIND. The `intent` is
COMPUTED, never stored: `runVersionedRelayFanOut` builds it with
`adapter.classifyMessageTransport({ hasForwardableMedia: durableMedia.length > 0 && mediaStore !== undefined })`
(`:974-978`). The obvious wrong move - reconstructing it from
`row.requested_transport` - yields `undefined` on an inbound retry row, which
spec D2 forbids from carrying one.

**What it implies.** Two sentences: the kind comes from the retry row's
`transport_schema_version`; the versioned intent comes from
`adapter.classifyMessageTransport` over the retry row's own
`media_attachments`, exactly as the fan-out builds it at `:974-978`. Task 11's two
mode tests (`:1021-1031` in the rev-2 numbering, unchanged in rev 3) assert
`toMatchObject({ kind: ... })` and pass either way, so this needs stating rather
than testing.

## 5. [MEDIUM] [WORDING] Four stale "Task N" cross-references survived the renumber - all four in the direction the coordinator predicted

The renumber moved blocks and left hand-fixed references pointing at the old
slots. Every one of these resolves to a task that exists, which is why they are
easy to miss:

- **`:1136`** - Task 10 says "Task 7's filter and **Task 12's** join must be
  correct against a MIXED list". The join is Task 6, wired into the Timeline in
  Task 9; Task 12 is the claim, which has no join. (Old numbering: Timeline was
  12.)
- **`:1816`** - "the two tasks with no new production code - Task 3 ... and
  **Task 13** (host verification)". Host verification is Task 10; Task 13 is the
  severity taxonomy, which very much has production code.
- **`:1820`** - "`RelayRetryState`, `RelayRetryRow` and `EffectiveRelayLeg` ...
  consumed by name in **Tasks 11 and 12**". Those are the retry job and the claim,
  which are server-side and never see them. The consumers are Tasks 8 and 9.
- **`:1823`** - "`RelayLegSendOutcome` and the re-exported `RelayTransportMode`
  are defined in Task 3 and consumed in **Task 8**". Task 8 is the presenter; the
  consumer is Task 11, and Task 11's own Consumes block (`:1186`) says so.

Everything else checked out: `:75`, `:553`, `:828`, `:887`, `:913`, `:1104`,
`:1133`, `:1135`, `:1186-1188`, `:1374`, `:1565`, `:1802-1813`, `:1829`, `:1836`
all resolve to the right task under the new numbering.

## 6. [MEDIUM] [WORDING] The `flagPlacementAttention` reversal is not propagated to the two places that still list it as a change

Task 12 now decides to leave the function alone (`:1540-1551`). Two earlier
statements still say it is being modified:

- **File Structure `:96-98`** lists `app/src/routes/webhooks/twilio.ts` as changed
  for "the claim, the SSE on claim, the `retryClaim` log field, the relay severity
  predicate, **the `flagPlacementAttention` scoping**".
- **Task 12 Files `:1412-1414`** lists "Modify: `app/src/routes/webhooks/twilio.ts`
  (inside `handleRelayRecipientStatus` `:2442-2561`, **and `flagPlacementAttention`
  `:2526`**)".

A builder reading the Files block before the tests will scope the escalation, which
the tests then contradict. The File Structure block is also the input to worktree
conflict checks, so it should describe what actually changes.

## 7. [LOW] [WORDING] The coherence claim is stated absolutely, but the branch's own e2e is red for two commits

The self-review says "Between any two commits the product is coherent, and now for
a reason that does not depend on reading the task list carefully: before Task 12
no retry row exists anywhere" (plan `:1835-1839`). The first clause is broader
than the second supports.

After Task 12 lands, a lane 30003 claims and the (already-landed) presenter renders
`delivered 2/2 - 1 on retry`, while the un-renamed
`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` still asserts
`delivered 1/2 - 1 failed - Phone unreachable (error 30003)` (`:158-160`) and
`Undelivered - Phone unreachable (error 30003)` (`:183`). Gate 4 is red across
Tasks 12 and 13 until Task 14 renames and rewrites it.

This one is not fixable by ordering - Task 14 needs a working retry to assert
against - so the sentence should say what it means: no PRODUCT surface is
incoherent between commits, and the branch's own e2e is expected red from Task 12
until Task 14.

---

## The three new things, reviewed cold

**The reorder's coherence argument HOLDS, and I tried to break it.** Rows are
created only by the claim, which is Task 12. Task 11 creates the job but registers
a handler nothing enqueues (`registerHandlers.ts`), so it is inert. Task 1's
media-pointer suppression is gated on `message.relayRetryOf !== undefined`, which
no existing caller sets. Task 2 adds an interface method; Task 4 adds a repo method
with no caller; Task 3 is behaviour-preserving by construction and proved by
unchanged test counts. Tasks 5-10 construct their fixtures by hand. So every
display task is provably inert in production before Task 12, exactly as claimed -
subject only to finding 7, which is about the branch's own test suite rather than
the product.

**The transport-mode change is correct, and nothing else needed the root row.** I
walked Task 11 Step 5 line by line against `sendOneRelayLeg`'s argument list
(plan `:1245-1261`): `body` and the leg copy come from `row.relay_retry_leg_body`,
`sourceMedia` from the retry row's `media_attachments`, `currentSource` and
`sourceTsMsgId` from the retry row, `poolNumber` from the conversation, `member`
from the live roster, and the digest gate needs `relay_retry_of` only as a STRING.
The root ROW is genuinely unnecessary, and dropping its readability requirement
removes a close path for a row nothing reads. Subject to finding 4, which is about
the intent half of the mode rather than the row it comes from.

**Leaving `flagPlacementAttention` untouched is right on the question it answers**
- deferring would lose three escalations, and the comment's reasoning about the
router closure at `:412` is exactly right. Finding 1 is a different question that
the reversal surfaced rather than caused.

## Harness citations - full re-verification

A phantom slipped through twice, so I checked every cited path with `ls` and every
cited helper by opening the file.

| Cited | Verdict |
|---|---|
| `app/test/mediaPointers.integration.test.ts` (Task 1) | EXISTS and supports it - `listMediaPointers` on the interface (`messagesRepo.ts:1354`), count assertion at `:161`, table setup at `:7-12` |
| `app/test/mediaPointers.integration.test.ts` (Task 4) | EXISTS but does NOT support it - finding 2 |
| `app/test/messagesRepo.transport.test.ts` (Task 2) | EXISTS |
| `app/test/twilioStatusWebhook.test.ts` (Tasks 12, 13) | EXISTS; `createLogCapture` handle kept at `:861` |
| `app/test/relayFanOut.test.ts` (`runHandler`, `claimFanoutPass`) | EXISTS; `dispatchJob` at `:853`, `:973`; `claimFanoutPass` present |
| `Timeline.ticker.test.tsx:98-119,157-203` (ticker spies) | EXISTS as described |
| `Timeline.test.tsx:21`, `Timeline.delivery.test.tsx:24` (`renderTimeline`) | EXIST |
| `TourConversation.test.tsx:178` (`renderConvo`) | EXISTS - round-2 finding 7 correctly closed |
| `dashboard/.../useRelayThread.test.tsx`, `deliveryStatus.test.ts`, `PlacementConversation.test.tsx`, `ConversationDetail.test.tsx` | ALL EXIST |
| `conversationsRepo.integration.test.ts`, `messagesRepo.integration.test.ts` | Correctly stated as NOT existing |

## Round-2 findings, confirmed closed

1 (escalation) - closed by reversal, superseded by finding 1 here. 2 (phantom
harness) - closed for Task 1, reopened for Task 4 as finding 2. 3 (window) -
closed by the full reorder. 4 (mode from the root) - closed, subject to finding 4.
5 (filter's delivered-ness source) - closed at `:887`, which now also warns against
routing the filter through the join. 6 (`hasTickableLeg` input) - closed at
`:1104`. 7 (`renderTourConversation`) - closed at `:1144`. 8
(`presentLegDeliveryOnMain`) - closed. 9 (every-rung duplicate send) - closed by
the new test at `:1516-1523`, which is the assertion I asked for. 10, 11, 12 -
closed.

## Disagreements

None. Every round-2 adjudication is applied as reasoned, including the two where
you chose a different remedy from mine (leaving the escalation alone rather than
extracting it; recording the e2e window rather than reordering around it - though
finding 7 says the recording is not yet in the text).

## Verdict

**One finding changes a decision: finding 1**, and it may resolve to a paragraph
rather than code. Findings 2, 3 and 4 are wording but block a literal builder at
the first step of Task 4 and at the first send of Task 11, so they are not
cosmetic. Findings 5, 6 and 7 are documentation consistency.
