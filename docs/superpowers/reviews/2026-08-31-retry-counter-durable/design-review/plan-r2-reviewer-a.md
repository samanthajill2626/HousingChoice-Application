# Plan review R2 - reviewer A (adversarial, rewritten plan)

Plan: `docs/superpowers/plans/2026-09-01-retry-counter-durable.md` (rewritten)
Spec: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Read cold and in full. All code citations read at the current worktree tip
(`67cafbd8` + the plan rewrite); anchors are `main@5ce9912f`.

## Verdict up front

The rewrite is a real improvement and most of it is sound. Sixteen of my
nineteen R1 findings are closed properly, several with better instructions than I
proposed (the RED-ON-MAIN labelling, the literal-millisecond rule with its
explicit "do not assert `broadcastBackoffMs(n)`" reason, the close-B
constructed-directly note, the `convertGroups` `~:429` anchor, and the fixture
warning in slice 4 are all correct and all check out against the code). D1-D23
and spec 7.1-7.11 now map to a task or a test with two exceptions, both listed
below.

But the rewrite did introduce defects, and three of them are in the very
instructions that were added to close my R1 findings - slice 0's enumeration,
slice 1's disambiguation read, and slice 2c's closure rationale. One of them
(2c) is a mechanism credited by name that does not work the way the plan says,
which is the failure mode this design's own risk section names.

### Re-verified from the code, and CORRECT

- `pending` guard (2a) resolves R1-A7/A8 substantively: an all-terminal pass now
  claims nothing, and because `keys` can legitimately be all-terminal on a raced
  continuation, spec 7.7's second half is finally testable on the broadcast side.
- Relay counter keyed `conversationId` + `sourceTsMsgId` (3b). Correct - that is
  the pair `markRecipient` already uses (`app/src/jobs/relayFanOut.ts:702-714`).
- `services/relayQueuedMessages.ts:93` is real, enqueues with no `recipientKeys`
  and no `attempt` (`:93-98`), and its messages genuinely have never been fanned
  out (they are held `queued_pending` for want of a pool number, `:64`, `:89`).
  The plan's "confirm by reading" instruction is the right posture.
- `convertGroups.ts:598` IS a pass-through wrapper (`async function ensureRail`,
  `:592-600`, which also catches a throw) and the request literal IS built at the
  `ensureRail(rail, {...})` call at `~:429-432`. Both halves of 4b verified.
- `retrySend.ts:122-128` does state the jobId rule correctly ("stable across
  redeliveries; dispatchJob stamps it into the context"), so slice 6's
  comment-correction citation is right.
- 5b is safe to run first: no existing test enumerates `INTERNAL_CODE_REASONS`
  exhaustively. `dashboard/src/routes/contact/deliveryStatus.test.ts:613-618`
  asserts only the `contact_opted_out` string, and `:626-632` asserts the
  `Object.prototype` fallthrough - adding two keys breaks neither.
- Ordering `0 -> 1 -> 5b -> 2 -> 3 -> 6 -> 7` holds as a stopping sequence, with
  the one exception in finding 8. Slice 4 is genuinely independent of 0/1/2/3/5/7
  by file (`services/groupRail.ts` + three callers, no repo and no dashboard
  overlap) - again with the exception in finding 8.
- The 30003 tail decision (5a) is right: `deliveryReason` appends the tail to
  every mapped code (`deliveryStatus.ts:638-640`) and 30003 is a lookup-able
  carrier code.

---

## Findings

### 1. [HIGH] "`messagesRepo` has no single-item getter" is false, and the warning that replaces it is scoped to the wrong mechanism

**What is wrong.** Slice 1: "`messagesRepo` has no single-item getter - add one
or use a consistent `GetCommand` directly; do not reuse a query helper that reads
eventually-consistently." It has one. `getByTsMsgId(conversationId, tsMsgId)` is
on the interface at `app/src/repos/messagesRepo.ts:1236` and implemented at
`:2740-2745` as a plain `GetCommand` with **no `ConsistentRead`**. The same trap
exists on the other side: `broadcastsRepo.getById` at
`app/src/repos/broadcastsRepo.ts:385-388` is also a bare `GetCommand`.

**Evidence.** `messagesRepo.ts:1236`, `:2740-2745`; `broadcastsRepo.ts:385-388`.
`grep -rn ConsistentRead app/src/repos` shows neither file sets it (only
`aiRunsRepo`, `contactsRepo`, `extractionRepo` and one messages Query do).

**What it implies.** The builder greps, finds two ready-made, interface-exposed,
fake-implemented single-item getters, and reuses them - which the plan's warning
does not forbid, because it forbids reusing "a query helper" and these are GET
helpers. An eventually consistent read on the `ConditionalCheckFailedException`
path reports `missing` for an item that exists, the handler `return`s, and the
close never runs - the exact stuck state this branch exists to remove, now
reachable through the fix. Replace the false premise with the true one: both
repos HAVE a single-item getter, NEITHER is consistent, and the claim's
disambiguation read must issue its own `GetCommand` with `ConsistentRead: true`.

### 2. [HIGH] Slice 2c's closure rationale is wrong: position is not what governs TypeScript narrowing, and the prescribed placement still fails gate 1

**What is wrong.** 2c: "Define it INSIDE the handler closure, after the lazily-
initialised repos are narrowed. ... a closure declared above the `??=`
initialisation loses TS's narrowing on the `let` bindings and fails gate 1."
That implies declaring it BELOW the `??=` preserves narrowing. It does not.
TypeScript resets control-flow narrowing for a captured variable inside a nested
function whenever that variable is a `let` that is reassigned anywhere in its
scope - which these are.

**Evidence.** `app/src/jobs/broadcastFanOut.ts:189` (`let broadcasts =
deps.broadcastsRepo;`, declared type `BroadcastsRepo | undefined`) reassigned at
`:198` (`broadcasts ??= createBroadcastsRepo(...)`). Relay is identical:
`app/src/jobs/relayFanOut.ts:321` (`let messages = deps.messagesRepo;`)
reassigned at `:332`. Note what the file already does with the bindings that DO
work in a nested position: `const events` (`:193`), `const messages: MessagesRepo`
(`:202`), `const audit` (`:208`) - all `const`, all fine. And note the existing
helpers `recordRecipient` and `finalize` are module-level with explicit repo
parameters (`:535-542`, `:549-583`), which is this codebase's own answer.

**What it implies.** Executed literally, `closeBroadcast` referencing
`broadcasts` (and `closeRelay` referencing `messages`) errors as possibly
undefined, and the builder debugs a gate-1 failure the plan claims to have
pre-solved. The instruction should be: pin a local `const broadcastsRepo =
broadcasts;` (respectively `const messagesRepo = messages;`) immediately after
the `??=` block and have the closure capture THAT. Exactly one binding per file
needs it.

### 3. [HIGH] Slice 0's enumeration of interface implementations is still incomplete - and slice 0's own gate is what fails

**What is wrong.** Slice 0 item 3 says "Enumerate them by grepping for the
interface name before writing code; as of `main` they are:" and then lists the
two real factories plus "the hand-written fake at
`app/test/helpers/twilioWebhookHarness.ts:2663` ... and any messages-repo fake in
the same harness". Two more full implementations live outside that harness.

**Evidence.** `app/test/scheduledSendSuppression.test.ts:261` -
`const messagesRepo: MessagesRepo = {` - and `app/test/sendMessage.test.ts:210` -
`const messagesRepo: MessagesRepo = {`. Both are complete object literals
implementing the interface, not `Pick<>` slices. The harness fakes are at
`twilioWebhookHarness.ts:1054` (messages) and `:2663` (broadcasts), so the total
is four, not two.

**What it implies.** The list is presented as authoritative ("as of `main` they
are"), and its scoping phrase - "in the same harness" - actively points the
builder away from the two it misses. Slice 0's stated exit condition is
`npm run typecheck` green, so the omission fails the gate the slice exists to
protect. Name all four. (The grep that finds them is
`grep -rn ": MessagesRepo =\|: BroadcastsRepo =" app/test`.)

### 4. [HIGH] Slice 2a's snippet does not compile: `claim` is block-scoped to the `else`, and slice 2b uses it outside

**What is wrong.** 2a declares `const claim = await broadcasts.claimFanoutPass(...)`
inside `else { ... }`. 2b then writes `if (claim.attempt >= MAX_BROADCAST_ATTEMPTS)`
and `const nextAttempt = claim.attempt + 1` in the continuation block ~200 lines
later, outside that block.

**Evidence.** Plan 2a lines 105-113 against plan 2b lines 121-143.

**What it implies.** Literal execution is `TS2304: Cannot find name 'claim'`. The
semantics are recoverable - when `pending` is empty, `transientRemaining` is
necessarily empty too, so 2b is unreachable - but the plan must show the shape
that expresses that: a `let claim: ClaimOutcome | undefined` hoisted above the
guard, with 2b either narrowing it or asserting it. Given that this plan's whole
premise is "a builder with no context executes it literally", a snippet that does
not compile is worth fixing rather than leaving to be discovered.

### 5. [MEDIUM] Close A - the only close with a production trigger - can end up with no dedicated test

**What is wrong.** 2d offers a disjunction: rewrite the cap test "to reach the cap
the real way - drive three passes, **or** seed `fanout_attempt` at the cap via
slice 0's test hook". It then says "The seeded-at-cap variant IS the close-B
test". If the builder takes the seeded branch, one test serves as both the
rewritten cap test and close B, and close A - the cap reached on pass 3 with
recipients still deferred, the only one of the three that fires in production -
is covered only by the generic bullet "closes A, B and C each leave the same
terminal shape".

**Evidence.** Plan 2d lines 169-176. The existing test's four assertions
(`app/test/broadcastFanOut.test.ts:396-400`: slot `failed`, `transient_cap`,
`stats.failed` 1, status `failed`) all hold under close B as well as close A, so
nothing in the assertion set forces the distinction. Under the new control flow
close B is reachable only by construction, so the two cannot share a driver.

**What it implies.** Say it as two tests: the rewritten cap test drives three
real passes (or seeds at `cap - 1`) and lands on close A; a separate test seeds
at `cap` and lands on close B. Close C is already separate.

### 6. [MEDIUM] Spec 7.5's send-COUNT half was dropped in the rewrite

**What is wrong.** Spec 7.5: "Total send count per recipient AND the backoff
delays both equal `main`'s, on both ladders. Counting sends alone would not catch
a ladder shifted a step." The R1 plan carried both halves ("send count and `runAt`
values per pass identical to `main`"). The rewrite fixed the delay half properly
- literal milliseconds, with the correct reason for not re-deriving from
`broadcastBackoffMs` - and the send-count half is now in no test bullet in slice
2 or slice 3.

**Evidence.** Plan slice 2 test list (lines 177-191) and slice 3's "slice 2's list
adapted"; spec Sec 7 item 5.

**What it implies.** The delay assertions catch a shifted ladder; nothing now
catches a ladder that runs two passes or four. That is the half the durable
counter is most likely to get wrong, because the rung is now claimed in a
different place from where it was consumed. Add: a deferred recipient is
attempted exactly three times across the ladder, on both files.

### 7. [MEDIUM] Spec Sec 8 obligation 5 has no task anywhere in the plan

**What is wrong.** Spec Sec 8 item 5 (lines 270-278) requires that
`relay-30003-retry-lineage` "carries its design knowledge forward so the
follow-on mission does not re-buy it", and names five specific facts: the
forward-only status machine's scoped-transition rule; that gating a retry claim
on the slot transition caps the ladder at ONE retry invisibly, so the gate belongs
on the attempt record; that the relay announcement path writes the same SID
pointers, so a pointer-keyed retry reaches fenced `tourReminders.ts`; that a
two-level lineage map will hit the parent-path seeding problem this branch's
scalar avoids; and that the relay chip copy set here must be revisited when a
retry becomes real.

**Evidence.** Plan slice 7 (lines 362-378) lists the e2e spec, two Resolutions,
three follow-up filings, the `_CLUSTERS.md` amendment and `npm run issues`. It
does not mention `relay-30003-retry-lineage` at all. (This was also absent from
the R1 plan and I missed it there - it is not a regression, it is an
unclosed gap.)

**What it implies.** The one deliberately deferred issue in this bundle loses the
five findings three review rounds paid for, and the follow-on mission re-buys
them. Add it to slice 7 as a named edit to that issue file.

### 8. [MEDIUM] Slice 6's region depends on slice 4, which the ordering declares free

**What is wrong.** The ordering says slice 6 runs after 2 and 3 because "its
in-region fixes land in the two files slices 2 and 3 rewrite", and separately
that slice 4 "may run any time after 0". But slice 4 makes
`services/groupRail.ts` an edited region too, and that file contains a live
sweep hit.

**Evidence.** `app/src/services/groupRail.ts:259-262`:

```
function isDeadRailState(state: string | undefined): boolean {
  const value = state ?? 'active';
  return value === 'closed' || value === 'failed';
}
```

`state` is a Twilio Conversation state (`ref.state`, consumed at `:483-489`), and
the unenumerated default is NON-TERMINAL - the comment at `:256-258` says so
outright ("Anything else - including `initializing` and `inactive` - is a rail
that still works or is about to"). That is exactly the shape spec Sec 9 defines:
"a branch on a raw provider status whose unenumerated default is NON-TERMINAL
('keep waiting')".

**What it implies.** Whether this finding is FIXED (in-region) or FILED
(out-of-region) depends on whether slice 4 ran before slice 6 - and spec Sec 9
mandates disposition "by region, not by filename". Either sequence 6 after 4 as
well, or state in slice 6 that `groupRail.ts` counts as in-region for this branch
regardless of order.

### 9. [MEDIUM] 4d requires a wrapper but does not say what its catch must do

**What is wrong.** 4d: "The ladder MUST sit inside the enclosing try/catch. ...
Verify the placement lands inside the existing handler, **or wrap it**." For
ladder point 2 (the post-repair read, `~:538`) the placement genuinely is inside
an existing handler (`app/src/services/groupRail.ts:522-549`). For ladder point 1
it is not: the insertion sits between `:507` (`missing = missingFromMap(...)`)
and `:517` (`if (missing.length > 0)`), and the nearest handler above closes at
`:501`. So the builder will be writing a NEW catch, and the plan does not say
what goes in it.

**Evidence.** The file's four existing catches all do the same three things -
`log.warn({ err: summarizeError(err), event: 'group_rail_ensure_failed', ... })`,
`await conversations.recordRailFailure(conversationId, reason, now().toISOString(), token)`,
`return { status: 'failed', reason }` - at `:465-473`, `:493-501`, `:541-549`,
`:608-616`.

**What it implies.** A bare `catch {}` satisfies the letter of 4d, releases no
claim, writes no `rail_failed`, and lets execution continue with a stale
`participants` list into the repair decision and the author check - which
silently substitutes the create's own return value for the authoritative re-read,
the exact substitution D15 forbids. Say that the new catch matches the file's
existing shape.

### 10. [LOW] The `pending` guard is a real improvement but still does not deliver D6 as stated

**What is wrong.** 2a: "The `pending` guard is what delivers D6." It delivers
D6's first bullet for already-terminal recipients. A pass whose pending
recipients are all opted out, all unreachable, or all without recorded consent
attempts no send and still claims a rung.

**Evidence.** `app/src/jobs/broadcastFanOut.ts:284-293` (opt-out / unreachable
skip), `:300-310` (no-consent skip) - both `continue` before any send, and both
are below the claim anchor. `isTerminal` (`:123-127`) tests the SLOT status, not
whether the recipient is sendable.

**What it implies.** Harmless in effect - such a pass finalizes anyway - but this
is the second revision to assert D6 is fully satisfied by a mechanism that
satisfies part of it. Better to say what the guard buys (already-terminal passes)
and record that a pass in which every recipient is fenced out does consume a
rung, deliberately.

### 11. [LOW] `retry_attempt` does not exist on `BroadcastItem`

**What is wrong.** Slice 0 item 1: "Declare the attribute on both item types,
beside the 1:1 ladder's existing `retry_attempt` so the two ladders are visibly
siblings" - for both `BroadcastItem` and `MessageItem`.

**Evidence.** `MessageItem.retry_attempt?: number` at
`app/src/repos/messagesRepo.ts:873`. `grep -n retry_attempt
app/src/repos/broadcastsRepo.ts` returns nothing.

**What it implies.** Trivial, but a builder looking for the neighbour in
`broadcastsRepo.ts` will not find it and may hunt. Scope the "beside
`retry_attempt`" instruction to `MessageItem`.

### 12. [LOW] Slice 0 and slice 1 overlap on the real implementation

**What is wrong.** Slice 0 item 2 adds the method to the interfaces "(signature in
slice 1)" and item 3 says "Implement it in every implementation ... as of `main`
they are: `createBroadcastsRepo` / `createMessagesRepo` (the real ones)". Slice 1
then specifies the real implementation in full (expression, condition, return
values, disambiguation read).

**What it implies.** It is unclear whether slice 0 ships a stub in the production
repos - which would typecheck and be dangerous if slice 1 slipped - or the real
body, which makes slice 1 a re-statement. Say plainly: slice 0 is types,
interface signatures and every FAKE; slice 1 is the two real bodies plus their
integration tests.

### 13. [LOW] Slice 6 does not restate the twilio.ts fence

**What is wrong.** Slice 6 sweeps "every `app/src` site branching on a provider
status string" and says "Fix in-region; file the rest as one issue". Spec Sec 2
fences `routes/webhooks/twilio.ts` "in its entirety", and that file is the
densest provider-status site in the repo (the `MessageStatus` / `ErrorCode`
switch at `app/src/routes/webhooks/twilio.ts:2547-2726`, plus the call-status
handling).

**What it implies.** The sweep's biggest yield is behind a hard fence, and the
slice does not say so. One line ("twilio.ts is fenced entirely - its hits are
FILED, never fixed") removes the ambiguity.

### 14. [LOW] The `sleep?:` precedent count is overstated

**What is wrong.** 4a: "matching the eight existing `sleep?:` injection points in
this repo".

**Evidence.** `grep -rn "sleep?:" app/src` returns six:
`lib/tokenBucket.ts:23`, `jobs/mediaMirror.ts:105`, `services/mediaMirror.ts:48`,
`services/groupIdentityFingerprint.ts:85`, `lib/import/convertGroups.ts:236`,
`lib/performanceSeed.ts:184` (the last as `sleep?: Sleep`). All four the plan
NAMES are real. Whether other spellings elsewhere reach eight is UNVERIFIED.

**What it implies.** Nothing functional - the seam is well precedented and the
instruction is right. Drop the number or say "several".
