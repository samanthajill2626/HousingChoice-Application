# Plan review R4-B (final confirmation pass) - relay 30003 retry lineage, plan revision 4

Plan: `docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md` (rev 4)
Spec: `.../specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 6, approved)
Adjudications read: `plan-r3-adjudications.md`.
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

**Two findings change a decision (1, 2). Three are wording.** The escalation
discriminator you asked me to attack is CORRECT, and stronger than the plan claims
- see "The escalation condition, attacked" below. The hazard I found next to it is
not in the discriminator but in the claim block's control flow, which no round has
placed.

---

## 1. [MEDIUM] [CHANGES-DECISION] The claim block's early `return`s can bypass the failure log, the SSE and the escalation, and the plan never says where the block goes

**What is wrong.** Task 12 Step 3 says to insert the claim "Inside
`handleRelayRecipientStatus`, after the existing slot write and before the
`return`" (plan `:1584-1585`), and four of its ten items exit with a bare
`return`: `source_unreadable` (item 2), `fenced_announcement` (item 3),
`to_missing`/`to_malformed` (item 4), `cap_exhausted` (item 6). "After the slot
write" spans lines 2473 to 2529, and three existing behaviours live in that range.

**Evidence.** `app/src/routes/webhooks/twilio.ts`, in order after the slot write at
`:2466-2472`:

- `:2500-2511` - the `delivery_failed` marker, WARN or ERROR by
  `isTerminalDeliveryFailure`. This is the line Task 13 adds `retryClaim` to.
- `:2512-2521` - `events.emit('message.persisted', ...)` on
  `transitioned || transportUpdated`.
- `:2522-2528` - `flagPlacementAttention(ptr.conversationId, 'send_failed')`.

A `return` from the handler placed before those skips all three. The most damaging
case is the fence: an announcement leg reaching `retryClaim: 'fenced_announcement'`
and returning would stop escalating a failed tour-reminder or intro leg on a
placement-linked relay thread - something it does today, because
`handleRelayRecipientStatus` runs for every relaysid-resolved callback and `:2526`
is not fenced. `source_unreadable` is the same shape: spec D23 requires that leg to
log ERROR, and an early return takes the log with it.

Task 12's own tests cannot see any of this. The announcement test asserts
`retryRows()` length 0 and the WARN (plan `:1490-1496`); nothing asserts the
escalation or the marker still fire on a fenced leg.

**What it implies.** One instruction fixes it, and it also makes finding 3 moot:
**put the claim block AFTER `:2528`**, at the tail of the handler, so every early
exit is harmless by construction. The escalation's own condition still works there
- it reads `source` from `:2449`, which is in scope throughout. The alternative -
extract the claim into a helper whose returns exit the helper - works too, but the
plan should pick one, because "after the slot write and before the return" permits
the wrong one.

## 2. [MEDIUM] [CHANGES-DECISION] "Gate 4 is red from Task 8" is wrong - it is red from Task 12, and deferring the gate six tasks early blanks e2e coverage over the whole display rewrite

**What is wrong.** The scoped coherence paragraph says "the pinning e2e still
asserts `delivered 1/2 - 1 failed` until Task 14 renames and rewrites it, so gate 4
is red **from Task 8** until then ... so run gate 4 at Task 14 and at the end, not
between" (plan `:1872-1877`).

**Evidence.** Nothing in Tasks 8-11 makes that spec fail, because no retry row
exists to change any string:

- Task 6's own contract is that a leg with no retry rows is untouched - its test
  "leaves a leg with no retry rows completely untouched" asserts
  `legs.get(memberKey)` EQUALS the original slot with `retryState` undefined (plan
  `:760-764`).
- With `retryState` undefined the presenter's subtraction is a no-op, so
  `failed = 1` and `presentRelayDelivery` returns today's
  `delivered N/M - K failed` (`dashboard/src/routes/contact/deliveryStatus.ts:433-436`),
  and `deliveryReason('30003', { relay: true })` still yields
  `Phone unreachable (error 30003)` (`:634-636`).
- Task 7's filter has no rows to filter. Task 11 registers a handler nothing
  enqueues.

So the spec's assertions at `relay-30003-no-retry-promise.spec.ts:158-160`,
`:167-169`, `:183` and `:190` all still hold. It goes red at **Task 12**, when the
claim first creates a retry in the lane, and stays red through Task 13.

**What it implies.** As written the plan tells a builder to stop running gate 4
across Tasks 8, 9, 10 and 11 - which is the entire display rewrite, including the
one file (`deliveryStatus.ts`) shared with two products Sec 2 fences off. A real
e2e regression introduced there would be invisible until Task 14 and then
indistinguishable from the expected red. Correct instruction: run gate 4 normally
through Task 11; expect it red at Tasks 12 and 13 for this one spec; green again at
Task 14.

## 3. [MEDIUM] [WORDING] The escalation condition does not say which `source` it reads, and only one of the two is in scope where it fires

**What is wrong.** Item 10 says to skip "when the source row is itself a retry row
(`relay_retry_of !== undefined`)" (plan `:1611-1615`). After this branch the
handler has two source values.

**Evidence.** The pre-existing plain read is `const source = await messages.getByTsMsgId(ptr.conversationId, ptr.tsMsgId)`
at `twilio.ts:2449` - eventually consistent, and in scope for the whole handler
including `:2526`. Item 2 adds a second, consistent read via
`getByTsMsgIdConsistent`, but it lives inside the claim block, which item 1 gates
on `ErrorCode === '30003'` and a failure mapping. The escalation at `:2522-2528` is
gated only on `transitioned` and a failed/undelivered mapping, so it also fires for
30005, 30007, 21610 and code-less `canceled` callbacks - paths on which the
consistent value does not exist.

**What it implies.** The condition must read the `:2449` value; say so. Two
properties are worth stating with it, because both are load-bearing and neither is
obvious:

- A read miss FAILS OPEN toward escalating: `source` is `undefined`, so
  `source?.relay_retry_of !== undefined` is false, the skip does not apply, and the
  escalation fires. That is today's behaviour, which is the right direction for a
  path whose whole job is putting a human on a failed send.
- The field is safe to read from an eventually-consistent get: `relay_retry_of` is
  written once at append time, long before the leg is sent, so a stale read cannot
  lose it - the row is either absent or has it.

## 4. [MEDIUM] [WORDING] The two escalation tests cannot separate the correct discriminator from a plausible wrong one

**What is wrong.** The pin (`:1571-1574`) posts one callback; the ladder test
(`:1578-1581`) walks one member's ladder. A mis-implementation as "skip when a
retry was claimed in this request" or "skip when any retry row exists for this
conversation" passes both.

**Evidence.** The case that separates them is the normal shape of a relay group:
two members, staggered DLRs. Member A's leg fails 30003 -> escalate, claim rung 1.
Sixty seconds later member B's leg on the SAME fan-out fails 30003. Under the
correct discriminator, B's callback resolves through B's pointer to the ORIGINAL
row (`relay_retry_of` undefined) -> escalates. Under either wrong version, a retry
row already exists in that conversation -> skipped, and B's failure never reaches a
human at all. `flagPlacementAttention` is the only path in this handler that does
(`twilio.ts:2522-2528`), so that is a silently lost escalation, not a cosmetic one.

**What it implies.** One test: a second member's leg failing mid-ladder still
escalates, and the count is 2. Three lines, on the path you correctly identified as
deserving specific attack.

## 5. [LOW] [WORDING] `classifyMessageTransport` takes only `hasForwardableMedia`

The new intent paragraph says the retry job "classifies afresh from the retry row's
own **type and media**" (plan `:1384-1385`). `classifyMessageTransport` takes one
input: `{ hasForwardableMedia }`, computed by the fan-out as
`durableMedia.length > 0 && deps.mediaStore !== undefined`
(`app/src/jobs/relayFanOut.ts:974-978`). `type` is not an input. The paragraph
cites `:974-978` directly, so a builder who opens it gets this right; the sentence
should match.

---

## The escalation condition, attacked

You asked two specific questions. Both answers are favourable, and the second is
stronger than the plan states.

**Is "the source row is a retry row" the right discriminator at that call site?**
Yes. I walked every shape that reaches `:2526`:

| Case | `source` | Result | Correct? |
|---|---|---|---|
| Original leg fails 30003 | the original | escalate | yes - identical to today |
| Rung 1/2/3 leg fails 30003 | that rung's retry row | skip | yes - the human was told at rung zero |
| A SECOND member's leg fails on the same original | the original | escalate | yes - and this is finding 4 |
| Original leg fails 30005 / 30007 / 21610 / no code | the original | escalate | yes - unchanged |
| A retry leg fails a NON-30003 code | that retry row | skip | yes - the chain is dead but the root already escalated |
| Announcement leg fails | the announcement row | escalate | yes - unchanged, subject to finding 1 |
| 1:1 path at `:2700` | n/a | unreachable for retry rows | the synthetic `relayretry-` SID is never given to a carrier, and the real SID's `relaysid#` pointer (`relayFanOut.ts:1263-1267`) routes its DLR to the relay branch |

**Does the root's own callback still reach it in every case it reaches it today?**
Yes, and structurally rather than empirically - which is the argument the plan
should make. `relay_retry_of` is a field Task 1 creates. No row that exists today
carries it, so `source?.relay_retry_of !== undefined` is false for every
pre-existing row, and the condition is a strict no-op on all current traffic. The
plan says "at exactly the moment it does today" (`:1613-1614`); the reason it is
true is that the discriminator cannot be true of anything that predates the branch.
That is worth one sentence, because it is what makes a condition on a live
escalation path cheap to review.

The one hazard adjacent to it is not the discriminator - it is where the claim
block sits relative to `:2522-2528`. That is finding 1.

## New material verified line by line

- **`relayRepos.integration.test.ts` as Task 4's harness** - CORRECT and complete.
  It self-skips on an unreachable endpoint (`:20-36`), does the throwaway-prefix
  table setup (`:39-53`), builds `createConversationsRepo` (`:46`), creates relay
  groups (`:67`, `:87`, `:91`), reads them back with `getById` (`:98`, `:141`,
  `:145`), and drives `setRelayStatus` at exactly the three lines cited (`:97`,
  `:222`, `:389`). Everything Task 4's two tests need.
- **The three-argument `setRelayStatus`** - CORRECT. Plan `:533` now passes
  `(conversationId, 'closed', 'open')`, matching
  `conversationsRepo.ts:850-854`, and the comment above it explains why the
  two-argument version produced a red on the wrong symbol.
- **The transport-INTENT paragraph** - CORRECT on the substance (plan `:1379-1385`),
  subject to finding 5. It names the right function, the right citation, and the
  right reason `row.requested_transport` is not the answer.
- **The four repaired cross-references** - ALL FOUR correct now: `:1143` "Task 6's
  join", `:1848` "Task 10 (host verification)", `:1852` "Tasks 8 and 9", `:1855`
  "Task 11". I re-walked every `Task N` reference in the document and found no
  remaining mismatch.
- **The escalation reversal propagated** - File Structure `:97` and Task 12's Files
  block `:1428` both now describe one condition on the call site with the function
  itself unchanged. Round-3 finding 6 closed.
- **The worker-side backoff seam** - the citation holds: `startWorker()` spawns
  `app/src/worker.ts` at `scripts/e2e-session.mjs:380-382`, so `app/src/routes/dev.ts`
  genuinely cannot reach the job, and `registerHandlers.ts` is the right home
  (`registerAllJobHandlers` at `:44`, nine sibling registrars at `:15-23`).

## Buildable by a stranger?

**Yes, with findings 1-4 applied.** I walked the plan as a builder with no context
and stopped at exactly two places: Task 12 Step 3, where "after the existing slot
write and before the `return`" does not tell me where to put a block whose early
exits can skip three existing behaviours (finding 1); and the gate cadence, where I
would have stopped running gate 4 four tasks earlier than necessary (finding 2).
Every citation I checked this round resolves - and after three rounds in which a
harness citation stopped a builder each time, this is the first round where none
does. Findings 3 and 4 are about a live escalation path being under-specified and
under-tested rather than unbuildable.

## Disagreements

None. Every round-3 adjudication is applied as reasoned, and the third answer on
the escalation - escalate on the root's callback only - is better than either
option I put in front of you.

## Verdict

**Two findings change a decision: 1 and 2.** Finding 1 is a control-flow placement
the plan never fixed and which can silently drop an existing escalation and an
existing alarm line for fenced legs. Finding 2 buys back e2e coverage across the
four riskiest tasks in the branch. Both are one-instruction fixes; neither reopens
anything architectural.
