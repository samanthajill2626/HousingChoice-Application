# Plan review R1 - reviewer B (adversarial, builder's seat)

Plan: `docs/superpowers/plans/2026-09-01-retry-counter-durable.md`
Spec: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Repo read at worktree `W:\tmp\retry-counter-durable` @ `67cafbd8` (docs-only
commit on top of `main@5ce9912f`; all source anchors below are that tree).

Question answered: **if a builder with no context executes this literally, do
they produce the spec?** Not yet. Five findings will produce wrong or vacuous
work; the rest cost the builder a guess.

## Anchors verified (so the misses below are not noise)

Every line number the plan cites was read. All correct:

- `broadcastFanOut.ts:252-256` recipient-set derivation; `:263` send loop;
  `:478-513` continuation block; `:481-495` cap-branch body; `:508-509` the
  "continuation is still pending" comment + `return`.
- `relayFanOut.ts:434-438` recipient derivation + `recipientKeys` narrowing;
  `:569-597` continuation block; `:595`
  `fanOutBackoffMs(payload.attempt ?? 1)`; `:571` `nextAttempt > MAX`.
- `groupRail.ts:538` post-repair `fetchParticipants`; `:492`
  `participants ??= await port.fetchParticipants(...)`; `:399/:454`
  `wasAdopted`; `:462` `participants = created.participants`.
- `jobs/groupRail.ts:59`, `rail-verify.ts:198`, `groupSend.ts:381`,
  `groupSend.ts:425` (healRail).
- `deliveryStatus.ts:416`, `Timeline.tsx:582` (this is the ACCESSIBLE NAME
  recital, `recipientSummaryName`, `Timeline.tsx:565-585` - the plan labels it
  "per-leg reason", which is the right site under a slightly wrong name),
  `Timeline.tsx:849`, `:1045`, `:1390`, `DeliveryBadge.tsx:31`,
  `Timeline.tsx:796` `rosterKind = 'relay'` (there is a SECOND identical default
  at `:1519`).

Two of the plan's own load-bearing empirical claims also check out:

- 30003's live string is `'Phone unreachable — will retry'` with a U+2014 EM
  DASH (`deliveryStatus.ts:544`).
- A relay INBOUND source message really does seed `delivery_recipients: {}`
  (`routes/webhooks/twilio.ts:598`, contract stated at
  `messagesRepo.ts:650-659`), so the plan's warning at 3a is correct and
  `closeRelay`'s child-only `SET delivery_recipients.#mk` has a parent to write
  into.
- Spec 7.3 genuinely fails on `main`: `enqueue` throwing at
  `broadcastFanOut.ts:496` propagates out of the handler, so the broadcast stays
  `sending` with `queued` recipients. The one "must fail on main" the plan marks
  is real.

---

## 1. [HIGH] D6's first property is violated by the anchor the plan chooses, and its test has two fixtures with opposite results

**What is wrong.** D6 requires "a job that returns without attempting any send
does NOT consume a pass". Plan 2a justifies its anchor as "below every existing
early return by construction". That is true and it is not sufficient: the anchor
is also ABOVE the per-recipient skips, which is where "no send attempted"
actually happens.

**Evidence.** In `broadcastFanOut.ts` the only returns between the duplicate
guard (`:227`) and the claim anchor (`:257`) are the duplicate guard itself and
`broadcast not found` (`:237-240`). Every other reason a pass sends nothing is
INSIDE the loop and below the claim: already-terminal slot (`:265`),
unresolvable contact (`:270`), `sms_opt_out`/`sms_unreachable` (`:284`), no
recorded consent (`:300`). A pass in which all of `keys` are opted out attempts
zero sends and, under this plan, consumes a pass.

**Implication.** The plan's own test line "a job that attempts no send consumes
no pass" (slice 2 test list) has two available fixtures with opposite outcomes:

- fixture A, `broadcasts.getById` returns undefined - the job returns at `:239`,
  no claim happens, test passes. It is also VACUOUS: there is no item to assert
  a counter on, only a spy on a repo the test injected.
- fixture B, every recipient opted out - the claim fires, the counter advances,
  test FAILS.

A builder picks one, and one of the two picks is a false green forever. Decide
which property is actually being bought and write it: either the claim moves
below a "will any send be attempted" determination (which requires a pre-pass
over `keys`, a real design change), or D6's first property is narrowed in the
spec to "an early return" and the test names fixture A and admits it is a spy
assertion.

Note the asymmetry the plan does not mention: `relayFanOut` CAN write this test
meaningfully (`status !== 'open'` at `:368-374`, no pool number at `:376`,
source message missing at `:388`, nothing to relay at `:417-424` are all real
early returns above the anchor with a live item to read the counter off).
`broadcastFanOut` cannot.

## 2. [HIGH] The enqueue-failure test seam is the wrong one and will break the existing suite

**What is wrong.** Plan slice 2 tests: "Seam: `enqueue` is a module import from
`./jobs.js`, NOT a dep on the handler's deps bag - use `vi.mock`."

**Evidence.** `app/test/broadcastFanOut.test.ts:8-27` imports SIX symbols from
`../src/jobs/jobs.js` - `_resetForTests`, `configureJobsLogger`,
`configureOutboundQueue`, `configureScheduler`, `dispatchJob`,
`enqueueImmediate` - and its header comment (`:5-7`) says it drives the fan-out
"through the real jobs envelope machinery ... so the jobId-marker idempotency
guard is exercised for real". A bare `vi.mock('../src/jobs/jobs.js')` auto-mocks
all six and destroys the file.

More importantly, the premise is false. `jobs.ts:107-124`:

```
export async function enqueue(...) {
  const delaySeconds = opts?.runAt ? Math.max(0, Math.ceil(...)) : ...
  ...
    await outboundQueue.enqueue(envelope, { delaySeconds });
```

A `runAt` continuation routes through the CONFIGURED `OutboundQueueAdapter`, not
past it. The seam is `configureOutboundQueue({ enqueue: async () => { throw ... } })`
- a first-class module-level configuration seam the existing test file already
calls. It is exact, it needs no module mocking, and it leaves
`dispatchJob`/`enqueueImmediate` real so the marker guard still runs.

**Implication.** As written the builder either breaks the suite or spends the
slice fighting a partial-`importOriginal` mock for a behavior that has a
supported injection point. Replace the seam instruction. The plan's own hedge
("confirm the mock actually intercepts") is not a substitute for naming the
right seam.

## 3. [HIGH] Slice 4's ladder has no time seam, and the plan never says to add one

**What is wrong.** 4b: "re-read up to **2** more times at **500ms** then
**1500ms**". Nothing in the plan says how the test controls that clock.

**Evidence.** `GroupRailServiceDeps` (`groupRail.ts:207-221`) carries
`now?: () => Date`, `newToken?`, `claimExpiryMs?` and NO sleep/delay. The repo's
own convention for exactly this is an injected sleep with a default -
`convertGroups.ts:242` (`const sleep = opts.sleep ?? ((ms) => new Promise(...))`),
`mediaMirror.ts:96`, `performanceSeed.ts:195`, `groupIdentityFingerprint.ts:92`.

**Implication.** Two readings with different outcomes. (a) real `setTimeout`:
each of spec 7.9's four lettered cases pays up to 2s, and the "post-repair read
ladders" case pays it twice - and `vi.useFakeTimers` against awaited promises
inside a service is the classic way to get a hanging test. (b) a new
`sleep?: (ms: number) => Promise<void>` dep. (b) is right and matches four
existing precedents, but the plan does not say it, so the flag is not the only
new field on the deps bag a builder has to invent. Name it.

## 4. [HIGH] Spec 7.5 (backoff equals main's) is specified as a formula, so the obvious test is vacuous - and this is the one D11 exists to protect

**What is wrong.** Plan 2b/3b give the backoff as expressions
(`broadcastBackoffMs(nextAttempt)`, `fanOutBackoffMs(claim.attempt)`) and the
test as "send count and `runAt` values per pass identical to `main`". There is no
`main` inside a test run, and the plan supplies no CONCRETE expected values.

**Evidence.** `broadcastBackoffMs`/`fanOutBackoffMs` are `5_000 * 2 ** (attempt - 1)`
(`broadcastFanOut.ts:82-84`, `relayFanOut.ts:68-70`). A builder writes
`expect(runAt).toBe(base + broadcastBackoffMs(nextAttempt))` - re-deriving the
expectation from the expression under test. That assertion holds no matter which
argument the production code passes, which is precisely the mistake D7/D11 warn
about (broadcast waits the NEXT step, relay the CURRENT one). The existing test
at `broadcastFanOut.test.ts:522` already exercises this region, so the builder
has a template that may already be formula-shaped.

**Implication.** Pin the numbers literally in the plan: broadcast waits **10s**
after pass 1 and **20s** after pass 2; relay waits **5s** after pass 1 and
**10s** after pass 2. A test that asserts those four integers catches a
normalised ladder. A test that calls the backoff helper does not. The plan warns
about two vacuous-test shapes; this is a third and it guards the decision the
spec calls out as most easily "corrected" by accident.

## 5. [HIGH] Slice 4's headline case passes vacuously unless the fixture makes the CREATE's return short - which the plan never says

**What is wrong.** 4b correctly notes the post-create participant list "arrives
INSIDE the adapter's return, so this is a NEW `fetchParticipants` call". It does
not follow that observation through to the fixture.

**Evidence.** On the create path `participants = created.participants`
(`groupRail.ts:462`) and `participants ??= await port.fetchParticipants(...)`
(`:492`) is therefore SKIPPED. `missing` at `:507` is computed from the create's
return. In the real adapter that return is itself a Twilio read
(`groupConversations.ts:480`, `const attached = await this.fetchParticipants(created.sid)`),
so the propagation window is real - but in a test the port is a stub with two
independent methods.

**Implication.** A builder who stubs `fetchParticipants` to return
incomplete-then-complete and leaves `createConversationWithParticipants`
returning the COMPLETE roster gets `missing.length === 0` at `:507`, the ladder
never engages, no repair happens, and the test goes green **against a completely
absent implementation**. The plan must state: the port stub's
`createConversationWithParticipants` must return the SHORT participant list, and
`fetchParticipants` returns short on call 1 and complete on call 2; assert
`addParticipants` was never called and `recordRailFailure` was never called.

## 6. [MEDIUM] `convertGroups.ts:598` is a pass-through wrapper, not a construction site

**What is wrong.** 4a: "Pass it from ... `lib/import/convertGroups.ts:598`".

**Evidence.** `convertGroups.ts:593-602` is
`async function ensureRail(rail: GroupRailEnsurer, request: GroupRailRequest)`
whose body is `return await rail.ensureGroupRail(request)` - it forwards an
argument. The `GroupRailRequest` is BUILT at `:429-432`
(`const outcome = await ensureRail(rail, { conversationId..., members: converted.members })`).

**Implication.** A builder editing `:598` literally writes
`rail.ensureGroupRail({ ...request, <flag>: true })` inside a generic helper,
which silently forces the flag for any future caller of `ensureRail` and puts
the opt-in in the wrong layer - the opposite of D16's "opted in explicitly rather
than inferred". Retarget the anchor to `:429`. This is the exact class of miss
the plan's own preamble warns about.

## 7. [MEDIUM] Close B has no production trigger once close A exists, and the plan does not say how to seed the state it needs

**What is wrong.** D8 presents three closing situations as peers and 7.4 demands
all three be proven. Under the plan's own close A they are not peers.

**Evidence.** Trace the ladder with `MAX_BROADCAST_ATTEMPTS = 3`
(`broadcastFanOut.ts:79`). Pass 1 claims 1, pass 2 claims 2, pass 3 claims 3;
close A fires at `claim.attempt >= MAX` on pass 3 and returns without enqueuing.
No pass 4 is ever produced. Close C also terminates the chain. The unknown-error
`throw` (`:459`) terminates it too (D12: the redelivery is suppressed at the
marker). So `claimFanoutPass` can only return `capped` if a fan-out job for the
same item arrives after the budget is spent, which nothing in the design
produces. The one residual path is the no-`jobId` branch at `:229-234`, where the
duplicate guard is skipped entirely. Same reasoning for `relayFanOut`.

**Implication.** Two things. (a) The plan should say close B is defence in depth
with no reachable production trigger, or a later reader (or fix-wave agent) will
"simplify" one of A or B away. (b) The 7.4 test needs `fanout_attempt` pre-set to
the cap and there is no repo method that sets it - `claimFanoutPass` only
increments. The builder must either call it `MAX` times in the fixture or write a
raw `UpdateCommand` in the test. Say which.

## 8. [MEDIUM] `closeBroadcast(recipientKeys, code)` cannot have that signature, and as a closure it will not typecheck

**What is wrong.** 2c specifies a 2-argument helper. Its body needs
`broadcasts`, `events`, `log`, `audit` and `payload.broadcastId`; 3c's
`closeRelay` needs `messages` and `payload`.

**Evidence.** This file's convention is module-level helpers with explicit repo
arguments - `recordRecipient(broadcasts, broadcastId, contactKey, recipient)`
(`broadcastFanOut.ts:535-542`), `finalize(broadcasts, events, broadcastId, log, audit)`
(`:549-555`), `markRecipient(messages, payload, memberKey, delivery)`
(`relayFanOut.ts:702-714`). A module-level `closeBroadcast` therefore takes
seven or eight parameters, not two.

The inner-closure alternative does not typecheck. `broadcasts` is
`let broadcasts = deps.broadcastsRepo;` at `:188` (type `BroadcastsRepo | undefined`),
narrowed only by `broadcasts ??= createBroadcastsRepo(...)` at `:198`.
TypeScript does not carry control-flow narrowing of a mutable `let` into a nested
function body, so `broadcasts.setRecipient(...)` inside a closure declared in the
handler is `possibly undefined` and gate 1 fails. Identical shape for
`let messages` / `let adapter` in `relayFanOut.ts:319-325`.

**Implication.** The builder hits a typecheck error the plan did not anticipate
and resolves it by guessing - most likely a `!` non-null assertion, which is the
kind of thing a reviewer then flags. State the real signature.

## 9. [MEDIUM] "the slice-2 list" does not transfer to relay - three of its assertions have no relay analogue

**What is wrong.** Slice 3's tests are "the slice-2 list, plus close B on a relay
INBOUND source message".

**Evidence.** Slice 2's list asserts "broadcast finalized", "row not `sending`",
"a pass that enqueues successfully leaves the broadcast `sending`", and its 2b
snippet ends with a trailing `await finalize(...)`. None of these exist in
`relayFanOut.ts`: there is no finalize, no `bumpStats`, no progress emit, no
entity status (3c says so itself), and the continuation block simply ends after
`enqueue` at `:596` with no trailing call and no third `return`.

**Implication.** A builder copying the 2b snippet into relay writes a
`finalize(...)` that does not exist, and copying the test list writes assertions
about a `sending` state relay never had. Spell out relay's terminal shape
explicitly: every member key in the derived `recipients` has a
`delivery_recipients[key].status === 'failed'` with the close code, and no slot
is left `queued`. That is the whole of 7.3/7.6 for this file.

## 10. [MEDIUM] "the same terminal shape" is never enumerated

**What is wrong.** The slice-2 test line "close A, close B and close C each leave
the same terminal shape" does not say what the shape is.

**Evidence.** Only spec 7.3 enumerates it ("no recipient left `queued` - and the
broadcast stops showing 'Sending'"), and only for the enqueue-failure case.

**Implication.** A builder who asserts only `recipients[k].status === 'failed'`
gets a green suite against an implementation that forgot `finalize()` in one of
the three branches, leaving the broadcast row `sending` forever - which is the
exact user-visible symptom the anchor issue is about. Restate the three-part
assertion (each non-terminal key `failed` with the right code; `stats.queued`
back to zero for those keys; row `sent`/`failed`, never `sending`) on the shared
test line.

## 11. [MEDIUM] The opt-in flag is unnamed, and "both `groupSend` callers pass no flag" is a shape test that a wrong gate also passes

**What is wrong.** 4a says "add an optional boolean" without naming it, and the
test list ends with "both `groupSend` callers pass no flag".

**Evidence.** `groupSend.ts:381` and `:425` construct
`{ conversationId, members }` inline. Asserting they pass no flag is an
assertion about the CALLER's literal, on a mocked ensurer.

**Implication.** That assertion is satisfied by an implementation that ladders on
`!wasAdopted` alone and ignores the flag entirely - i.e. by exactly the
implementation D16 forbids, where the defect is silently fixed on the two
`groupSend` paths too. The real test is the one the plan lists just before it
("with the flag absent neither read ladders"), driven THROUGH the real
`createGroupRailService` with a stub port, counting `fetchParticipants` calls.
Keep that one; drop or downgrade the caller-literal one, and name the field so
three call sites and four tests agree on it.

## 12. [MEDIUM] The counter is per-ITEM where the envelope counter was per-CHAIN; the third relay enqueuer is not enumerated

**What is wrong.** D7 promises "same number of send passes per recipient".
`payload.attempt` was scoped to one continuation chain; `fanout_attempt` is
scoped to the item and never resets.

**Evidence.** `RELAY_FANOUT_JOB` is enqueued from three places, not two:
`routes/webhooks/twilio.ts:695` (inbound), `routes/api.ts:1805` (team send), and
`services/relayQueuedMessages.ts:93` (`flushQueuedMessages`, released
`queued_pending` messages). The third loops over pending messages and enqueues
one fan-out per `m.tsMsgId` after `messages.updateDeliveryStatus(m.provider_sid, 'queued')`
at `:89`. Two concurrent flushes, or a flush re-entered before that status write
is visible, produce two fan-out chains against the SAME `sourceTsMsgId` - and
therefore the same durable counter. The second chain inherits a partly-spent
budget and gets fewer passes than it would on `main`.

**Implication.** Narrow, but it is a D7 divergence and it is the kind of thing the
plan asks to be enumerated by grep rather than by the files it names. Either
state that a second chain sharing a budget is accepted (with the reason), or add
it to the sweep. `BROADCAST_SEND_JOB` is clean by comparison: one enqueue at
`routes/broadcasts.ts:757`, and `markSending` is draft-gated
(`broadcastsRepo.ts:546`), so a broadcast has exactly one chain.

## 13. [MEDIUM] The post-create ladder rebinds `participants`, which also feeds the author-verification block

**What is wrong.** 4b says "Nothing else changes". The ladder at the post-create
read necessarily reassigns `participants`, and `participants` has a second reader
downstream.

**Evidence.** `groupRail.ts:578-584` derives `projectedParticipants`,
`staleAuthors` and `authorPresent` from `participants`. The comment immediately
above (`:573-577`) reasons explicitly about WHICH list that is: "The bulk-create
path is trusted for the participant it was asked to create (all-or-nothing) and
only checked against the read-back when that read-back happens to include it -
the async binding propagation ... applies to the projected one too."

**Implication.** After the ladder, the create path's author check runs against a
fresh `fetchParticipants` result instead of the adapter's return. The outcome is
probably benign (`authorPresent` on the create path is `!authorRefusedOnCreate`
since `wasAdopted` is false, and unpropagated entries carry no `projectedAddress`
so `staleAuthors` stays empty) - but the plan asserts "nothing else changes" and
that is not true by inspection. Either state the coupling and why it is safe, or
have the ladder recompute only `participantMap`/`missing` from a local and leave
`participants` bound to the create's return.

## 14. [LOW] `outcome: 'missing'` is dead on the broadcast path, so the `ConsistentRead` disambiguation buys nothing there

`broadcastFanOut.ts:236-240` already returned if `getById` found nothing, and the
claim anchor is at `:257`. `missing` is then reachable only via a delete race
inside a few microseconds. The `ConsistentRead: true` GetItem in slice 1 is still
correct for `messagesRepo` (relay reads its source message through a windowed
`listByConversation` at `:382-390`, which is a different read), but the plan
should not present the `missing` arm as load-bearing for broadcast, or the
builder writes a test for a branch they cannot reach.

## 15. [LOW] Slice 1 leaves `<pk args>` unresolved and messagesRepo has no single-item getter

`claimFanoutPass(<pk args>, cap)` is a placeholder. For `messagesRepo` the key is
`(conversationId, tsMsgId)`. There is no `getById`-style single-message read in
`messagesRepo.ts` (grep for `getByKey|getMessage|async getById` returns nothing),
so the CCF disambiguation GetItem is a raw `GetCommand` the builder must write.
Say so, or the disambiguation quietly becomes another `listByConversation` window
- which is an eventually-consistent Query and defeats the reason `ConsistentRead`
was specified.

## 16. [LOW] The plan over-claims its own fail-on-main discipline

Preamble: "slices 1-4 must each have a test that **fails on `main`** where the
spec says so." The spec says so exactly once, in 7.3. Slice 1's tests fail on
`main` only trivially (the method does not exist); slice 4's ladder test does
fail on `main` but the spec never asked for that framing; slice 3 never restates
the marker at all even though its relay analogue of 7.3 is the second-most
valuable regression test on the branch. Mark slice 3's enqueue-failure test
"must fail on main" explicitly - it does, for the same reason slice 2's does
(`relayFanOut.ts:583` throws out of the handler today).

## 17. [LOW] Slice 5 does not say whether the relay 30003 copy carries the `(error 30003)` tail

`deliveryReason` appends `` `${mapped} (error ${errorCode})` `` at
`deliveryStatus.ts:638-640` for anything resolved through the mapped path.
"Selected the way the existing `media` option already selects
`MMS_ERROR_CODE_REASONS`" (i.e. inside `mapped` at `:636`) implies the tail IS
appended; "Relay legs get `Phone unreachable`" read literally implies it is not.
Those render differently on screen and a test asserting the wrong one is a
one-line rework. State the exact expected string.

(Not a finding, for the record: there is no precedence collision with
`MMS_ERROR_CODE_REASONS`, which holds only `30005`/`30006`
(`deliveryStatus.ts:581-584`), and none with `INTERNAL_CODE_REASONS`, checked
first at `:633`. `DeliveryBadge.tsx:31` passes no options bag, so a relay-scoped
option on `DeliveryReasonOptions` leaves the broadcast badge's 30003 untouched
as 5a requires. `RosterKind` in `Timeline.tsx:211` and `LegRosterKind` at
`deliveryStatus.ts:457` are the same union, so threading it needs no new type.)

## 18. [LOW] Slice 6's disposition rule depends on slices 2-3 having landed, contradicting "6 any time"

Sec 9 disposes "by region, not by filename - inside a region this branch already
edits, fix it". Run slice 6 first and the regions do not exist yet. Sequence it
after 3, or restate the rule as a fixed file list.

## 19. [LOW] The new attribute is never declared on either item interface

`BroadcastItem` (`broadcastsRepo.ts:139`) and `MessageItem`
(`messagesRepo.ts:846`) are the shapes every reader types against - including
the tests that will assert `fanout_attempt` survives a status write. Slice 1
says "top-level scalar" but never says to add `fanout_attempt?: number` to both
interfaces. Note the near-neighbour `retry_attempt?: number` at
`messagesRepo.ts:873`, which is the 1:1 retry ladder's counter - spec 2.1 forbids
sharing it, and having the two sit adjacent on the same item makes naming
discipline load-bearing. Both interfaces are returned wholesale to callers
(`getById` at `broadcastsRepo.ts:385-388`, `listByConversation`), so declare it
once, deliberately.

---

## Ordering claim - verdict

- **1 -> 2 -> 3 sequential: CONFIRMED.** 2 and 3 both call `claimFanoutPass`; 3's
  shape is 2's minus finalize/stats/emit.
- **4 independent of 1-3: CONFIRMED.** Disjoint files, disjoint tests.
- **5 independent of 1-3: TECHNICALLY yes, semantically no.** 5b registers copy
  for `enqueue_failed`, a code that only slice 2/3 emit. The dashboard test can
  hardcode the string, so 5 can be built and merged first - but if 2/3 were cut,
  5 would ship copy for a code nothing writes. Worth one sentence.
- **6 "any time": NO** - see finding 18.
- **Stoppable between slices: YES for every boundary**, with one caveat. After 1
  the repos carry an uncalled exported method (no lint or typecheck consequence).
  After 2, broadcast is durable and relay is not - both self-consistent. After 4
  or 5 alone, no behavior depends on the others. The one intermediate state that
  is NOT safe is INSIDE slice 2: deleting the `nextAttempt > MAX` cap test
  (`broadcastFanOut.ts:480`) before close A is in place removes the only cap on
  the ladder. 2a and 2b must land in one commit; the plan's table presents the
  deletion and the replacement as separate rows and should say they are atomic.
