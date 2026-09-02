# Plan review R1 - reviewer A (adversarial, plan-vs-spec)

Plan: `docs/superpowers/plans/2026-09-01-retry-counter-durable.md`
Spec: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Worktree read at `67cafbd8` (docs-only ahead of `main@5ce9912f`); all code
citations are from that tree.

Question answered: **if a builder with no context executes this literally, do
they produce the spec?** Not yet. Two blocking gaps, four high.

## Anchors I verified (so the rest of this review can be trusted)

Every line number the plan cites was read. All of these are CORRECT:

- recipient-set derivation `const keys = ...` at `app/src/jobs/broadcastFanOut.ts:252-256`;
  send loop opens at `:263`. Plan 2a's anchor is real.
- continuation block `app/src/jobs/broadcastFanOut.ts:478-513`; cap-branch body
  `:481-495`. Plan 2b/2c anchors are real.
- relay recipient derivation `app/src/jobs/relayFanOut.ts:434-438`; send loop at
  `:443`; continuation at `:569-597`. Plan 3a/3b anchors are real.
- `fanOutBackoffMs(payload.attempt ?? 1)` at `app/src/jobs/relayFanOut.ts:595`
  vs `broadcastBackoffMs(nextAttempt)` at `app/src/jobs/broadcastFanOut.ts:506`.
  D7/D11's "one waits the next step, the other the current one" is real, and the
  plan's substitution (`claim.attempt` for relay, `nextAttempt` for broadcast)
  reproduces both delays exactly. Verified by hand for passes 1-3 on both ladders.
- D2's premise: both slot writes are CHILD-ONLY updates
  (`app/src/repos/broadcastsRepo.ts:615` `SET recipients.#ck = :rec`;
  `app/src/repos/messagesRepo.ts:2781` `SET delivery_recipients.#mk = :d`), so
  the whole slot object is replaced on every pass and a top-level scalar
  survives. A slot-resident counter would indeed read 1 forever.
- Broadcast table key is single-attribute `{ broadcastId }`
  (`app/src/repos/broadcastsRepo.ts:614`), so `ADD fanout_attempt :one` is
  well-formed.
- Slice 4's subtlest claim - "the post-create participant list arrives INSIDE
  the adapter's return, so this is a NEW `fetchParticipants` call" - is CORRECT:
  `app/src/services/groupRail.ts:492` is `participants ??= await
  port.fetchParticipants(...)` and `participants` is already assigned at `:462`
  on the create path, so that read never runs for a freshly created rail. The
  plan correctly refuses to credit an existing call.
- Post-repair read at `app/src/services/groupRail.ts:538`. Correct.
- Exactly five `ensureGroupRail` call sites, at exactly the cited lines:
  `app/src/jobs/groupRail.ts:59`, `app/src/lib/import/convertGroups.ts:598`,
  `app/scripts/rail-verify.ts:198`, `app/src/services/groupSend.ts:381` and
  `:425`. No sixth.
- All six `deliveryReason` call sites, at exactly the cited lines:
  `dashboard/src/routes/contact/deliveryStatus.ts:416`,
  `dashboard/src/routes/contact/Timeline.tsx:582`, `:849`, `:1045`, `:1390`,
  `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`. No seventh anywhere in
  `dashboard/src`.
- `ERROR_CODE_REASONS['30003'] = 'Phone unreachable - will retry'` at
  `dashboard/src/routes/contact/deliveryStatus.ts:544` and it does carry an em
  dash. `INTERNAL_CODE_REASONS` at `:609` returns early with no code tail
  (`:633-634`). `presentLegDelivery` already takes `rosterKind` (`:502`).
- `rosterKind` really does default to `'relay'` in two places
  (`Timeline.tsx:796`, `:1519`) and exactly ONE production caller opts out:
  `dashboard/src/routes/conversation/GroupTextView.tsx:461`. The plan's warning
  is accurate and if anything understates it (two defaults, not one).
- D19 traced from the call site, not by name: the status webhook returns at
  `app/src/routes/webhooks/twilio.ts:2432-2436` (`if (relayPtr) { await
  handleRelayRecipientStatus(relayPtr); res.status(200).end(); return; }`)
  BEFORE the 30003 arm at `:2553`. No relay retry exists. D19 holds.
- D20 traced the same way: the `30005/30006` arm carries a `group_text` guard
  (`app/src/routes/webhooks/twilio.ts:2633`) and the `21610` arm carries one
  (`:2691`), while the `30003` arm at `:2553-2571` carries none. A group-text
  30003 does reach `enqueueSendRetry`. D20 holds.
- D9's premise, which the two edited files' own comments contradict: `jobId` is
  minted once at enqueue (`app/src/jobs/jobs.ts:189`) and travels in the
  envelope body, so an SQS redelivery reuses it and the marker suppresses it.
  D9/D12 are right; see finding 18 for the stale comments.
- `setDeliveryOutcome` exists with a `{ kind: 'fail', errorCode }` profile at
  `e2e/fixtures/fakeTwilio.ts:287-296`, and no seed carries a
  `delivery_recipients` map (`grep delivery_recipients app/src/lib/seed` is
  empty). Slice 7's e2e arming instruction is correct.
- No re-send surface for a broadcast: the sole producer
  (`app/src/routes/broadcasts.ts:757`) is gated on the conditional draft flip at
  `:742-754`, so a broadcast's ladder runs once and the counter's permanence is
  safe. No zod parse in `dashboard/src`, so the new attribute cannot break a
  response parse. Both are non-findings, recorded so nobody re-checks them.

---

## Findings

### 1. [BLOCKING] Slice 1 adds a repo-interface method and enumerates none of the four implementations that must gain it

**What is wrong.** The plan says "Add to each repo" and names only
`app/src/repos/broadcastsRepo.ts` and `app/src/repos/messagesRepo.ts`. Adding
`claimFanoutPass` to the exported `BroadcastsRepo` / `MessagesRepo` INTERFACES
breaks every other object typed as one. There are four:

- `app/test/helpers/twilioWebhookHarness.ts:1054` (`const messagesRepo: MessagesRepo = {`)
- `app/test/helpers/twilioWebhookHarness.ts:2663` (`const broadcastsRepo: BroadcastsRepo = {`)
- `app/test/scheduledSendSuppression.test.ts:261`
- `app/test/sendMessage.test.ts:210`

**Evidence.** `grep -rn ": MessagesRepo =\|: BroadcastsRepo =" app/test` returns
exactly those four. `app/test/broadcastFanOut.test.ts:130-143` and
`app/test/relayFanOut.test.ts` wire the handlers with
`world.broadcastsRepo` / `world.messagesRepo` from `createFakeWorld()`, so
EVERY slice-2 and slice-3 test runs against the harness fake, not DynamoDB.

**What it implies.** Two things, and the second is the dangerous one. (a) Gate 1
(`npm run typecheck`) fails until all four are implemented - a stop the plan
does not budget. (b) The FAKE's `claimFanoutPass` semantics silently decide
whether every ladder test in slices 2 and 3 means anything. A fake that returns
`{ outcome: 'claimed', attempt: 1 }` unconditionally makes "send count and runAt
identical to main", "close A", and "a pass that enqueues leaves the broadcast
sending" all pass while the durable ladder never advances. The plan must name
the four files and specify that the harness fake stores and increments the
counter on the in-memory item.

### 2. [BLOCKING] Slice 4's ladder is placed outside every try/catch in `ensureGroupRail`, so a transient read failure escapes the function and leaks the `rail_creating` claim

**What is wrong.** Plan 4b's ladder point 1 is a NEW `port.fetchParticipants`
call between the validation read and the repair decision - i.e. between
`app/src/services/groupRail.ts:507` (`missing = missingFromMap(...)`) and `:517`
(`if (missing.length > 0)`). That gap is the one stretch of this function with
no error handling: the read above it is wrapped (`:491-501`) and the repair
below it is wrapped (`:522-549`), and each wrapper calls
`conversations.recordRailFailure(..., token)` before returning `failed`.

**Evidence.** `app/src/services/groupRail.ts:491-501`, `:522-549`, the claim
taken at `:367-371`, and the function's own written contract at `:149-151`: "It
must not throw for an ordinary rail failure (return `failed` with a reason)."
The job caller does not catch either - `app/src/jobs/groupRail.ts:59` awaits
`ensureGroupRail` bare and branches on `result.status`.

**What it implies.** A 429 or 5xx on a ladder rung throws out of
`ensureGroupRail`, `recordRailFailure` never runs, and the `rail_creating` claim
is never released - the thread is refused (`'another rail creation is already in
flight'`, `:384`) for up to `RAIL_CLAIM_EXPIRY_MS` (5 minutes, `:198`). Leaking
that claim is the exact failure D16 cites as the reason the two `groupSend`
variants were rejected; the plan reintroduces it on the path it does change.
The ladder must be inside a try/catch that records the rail failure under the
token, or inside the existing `:522-549` block's shape.

### 3. [HIGH] The prescribed `vi.mock` seam for the enqueue-failure test is wrong, and a better seam already exists

**What is wrong.** Plan 2c: "Seam: `enqueue` is a module import from
`./jobs.js`, NOT a dep on the handler's deps bag - use `vi.mock`."
`app/src/jobs/broadcastFanOut.ts:74` imports `defineJobHandler` AND `enqueue`
from that same module, and `app/test/broadcastFanOut.test.ts:14-21` imports
`_resetForTests`, `configureJobsLogger`, `configureOutboundQueue`,
`configureScheduler`, `dispatchJob` and `enqueueImmediate` from it too. A
`vi.mock` of that module takes out the registration path and the test file's own
driver. A partial `importActual` mock is file-scoped, so making `enqueue` throw
also breaks the other ~25 tests in the file.

**Evidence.** `app/src/jobs/jobs.ts:118-124`: `enqueue` delegates to
`outboundQueue.enqueue(envelope, { delaySeconds })` and has no other side
effect on that path. `app/test/broadcastFanOut.test.ts:161` already calls
`configureOutboundQueue(outbound)` with a real adapter instance.

**What it implies.** The builder is steered toward a fragile seam that will
produce either a broken file or a green run that proves nothing - precisely what
the plan's own hedge ("confirm the mock actually intercepts") cannot catch,
because the failure mode is collateral, not silent interception. The correct
seam is an `OutboundQueueAdapter` whose `enqueue` throws on the Nth call (or on
a flag flipped after the initial dispatch). Same for relay.

### 4. [HIGH] Slice 1 never says where its tests live, and spec 7.2 is vacuous anywhere but DynamoDB Local

**What is wrong.** Slice 1's test list includes "concurrent claims yield distinct
numbers (fire N in parallel, assert the set of returned attempts has no
duplicates)". That is spec 7.2 (D5, atomicity). Fired against an in-memory fake
- or against any implementation whose increments are awaited in sequence - the
assertion passes on a naive read-modify-write. The plan specifies no suite.

**Evidence.** `app/test/broadcastsRepo.integration.test.ts` exists (the
DynamoDB Local convention for this repo), alongside
`contactsRepo.integration.test.ts`, `groupSendRepo.integration.test.ts` and
others. The plan names none of them.

**What it implies.** The one test that proves the design's central atomicity
claim will be trusted while proving nothing. Slice 1 must state that its tests
are integration tests against DynamoDB Local, and that the concurrency case
issues N genuinely un-awaited `claimFanoutPass` calls before the first resolves.

### 5. [HIGH] An existing test drives the cap through the envelope and will go red, with no instruction for the builder

**What is wrong.** `app/test/broadcastFanOut.test.ts:383-400` -
`'429 capped at MAX_BROADCAST_ATTEMPTS -> remaining marked failed, finalized'` -
drives the cap by enqueueing `{ broadcastId: 'bcast-1', attempt: 3 }` and
asserting `errorCode === 'transient_cap'` and `status === 'failed'`. After slice
2 the envelope's `attempt` is advisory (plan 2b) and the claim starts at 1, so
no close fires, a continuation is enqueued, and the assertions fail.

**Evidence.** `app/test/broadcastFanOut.test.ts:393` (`attempt: 3`), `:398`
(`toBe('transient_cap')`), against plan 2b's "cap test ... deleted" and D4's "an
item without the attribute claims at 1". Relay has no equivalent - its cap is
not envelope-driven in `app/test/relayFanOut.test.ts`.

**What it implies.** A red test with no plan entry is where a builder weakens the
one assertion that pins the cap-close shape. The plan must say explicitly: this
test is rewritten to pre-seed `fanout_attempt` at the cap (or to run the ladder
through three real passes), and the `transient_cap` / finalized assertions are
preserved verbatim.

### 6. [HIGH] Slice 5b is a prerequisite for shipping slices 2 and 3, not an independent slice

**What is wrong.** The plan's Ordering section says "4 and 5 are independent of
1-3". In the 5-before-3 direction that is true. In the other direction it is
false: slices 2 and 3 INTRODUCE `enqueue_failed`, and until 5b registers it,
`deliveryReason` falls through to
`` `Delivery failed (error ${errorCode})` `` (`deliveryStatus.ts:639-640`) and
prints an app-invented token as a carrier error number - the exact defect D22
names. `transient_cap` already has that defect today (it is written at
`broadcastFanOut.ts:482` and `relayFanOut.ts:575`), but slices 2/3 make it
newly reachable on two more paths (close B and close C).

**Evidence.** Plan Ordering line; `deliveryStatus.ts:628-641`; D22.

**What it implies.** "Stoppable between them" is violated: stopping after slice 3
ships a state D22 forbids. Ordering must read 5b before (or with) 2 and 3, or
say plainly that 2/3 do not ship without 5b.

### 7. [MEDIUM] The claim anchor does not deliver D6's first property, and the plan asserts that it does

**What is wrong.** Plan 2a: "That position is below every existing early return
by construction, which is what satisfies D6's 'a job that attempts no send
consumes no pass' without enumerating guards." It is below the early returns
(`broadcastFanOut.ts:228`, `:239`) but ABOVE the per-recipient skips. A pass
whose keys are all terminal (`:265`), all opted out (`:284`), or all without
consent (`:300`) attempts zero sends and still consumes a pass.

**Evidence.** `app/src/jobs/broadcastFanOut.ts:263-310` against spec D6 bullet 1.

**What it implies.** The consequence is benign (such a pass finalizes anyway), but
the plan states a guarantee the code does not provide, and it is the guarantee
the spec calls "a real constraint, not a preference" with "a failing case". Say
what the anchor actually buys - the early returns and the duplicate guard - and
record that an all-skip pass does consume a pass, deliberately.

### 8. [MEDIUM] "An early return claims nothing" is a vacuous test on the broadcast side

**What is wrong.** Plan 2c's test list ends "a same-`jobId` redelivery claims
nothing; an early return claims nothing." On broadcast the only non-duplicate
early return above the anchor is "broadcast not found"
(`app/src/jobs/broadcastFanOut.ts:236-240`) - there is no item, so there is no
counter to assert about. The assertion cannot fail.

**Evidence.** `app/src/jobs/broadcastFanOut.ts:218-240` is the complete set of
returns above `:252`. Relay has five testable ones
(`app/src/jobs/relayFanOut.ts:358-361`, `:368-374`, `:376-379`, `:386-390`,
`:417-424`), all of which leave the source message present.

**What it implies.** Spec 7.7's second half is only provable on relay. The plan
should name the relay case (a closed group, or a group with no pool number) as
the one that carries it.

### 9. [MEDIUM] Slice 3 never states which item carries the relay counter, and the wrong guess is catastrophic

**What is wrong.** Slice 1 declares `claimFanoutPass(<pk args>, cap)` and slice 3
says only "Same shape as slice 2, three differences", none of which is the key.
The relay ladder is per SOURCE MESSAGE, so the key is
`(relayConversationId, sourceTsMsgId)` - the same pair `markRecipient` uses
(`app/src/jobs/relayFanOut.ts:702-714`).

**Evidence.** Plan slice 1's `<pk args>` placeholder; plan slice 3's three named
differences (anchor, backoff argument, close helper).

**What it implies.** A builder keying it on `relayConversationId` alone gives an
entire relay group a single 3-pass budget for its whole life: after three
relayed messages, every subsequent fan-out claims `capped` and closes every
member's leg as failed before sending anything. Given the design's own warning
about counters, the key must be stated, not inferred.

### 10. [MEDIUM] Slice 4 specifies a delay with no seam to control it, so its four tests cannot be written as described

**What is wrong.** 4b: "re-read up to 2 more times at 500ms then 1500ms". Nothing
in `GroupRailServiceDeps` can shorten or pin that.

**Evidence.** `app/src/services/groupRail.ts:207-221` exposes
`conversationsRepo`, `groupConversations`, `config`, `logger`, `businessNumber`,
`now`, `newToken`, `claimExpiryMs` - no delay/sleep injection. `now` is a clock
READ, not a timer.

**What it implies.** Spec 7.9's four cases either add 2s of real wall time each to
`app/test/groupRailService.test.ts` (which has ~30 cases) or need fake timers the
plan never mentions - and fake timers interleaved with awaited promises are the
class of test that silently hangs. Add a `delayMs?: (ms: number) => Promise<void>`
seam (or a `ladderDelaysMs?: number[]`) to the deps bag and say so.

### 11. [MEDIUM] "Nothing else changes" is false: the ladder re-points two downstream consumers of `participants`

**What is wrong.** Plan 4b closes with "Nothing else changes". A ladder rung at
point 1 reassigns `participants`, and that variable is read twice more:
`app/src/services/groupRail.ts:578-584` derives `projectedParticipants`,
`staleAuthors` and `authorPresent` from it, and `participantMap` built from it is
what `setTwilioConversation` persists (`:619-625`).

**Evidence.** `app/src/services/groupRail.ts:506-507`, `:578-584`, `:619-625`,
and the comment at `:574-577` which explicitly reasons about which list the
author check runs against.

**What it implies.** The change is probably desirable (a later read is a better
map), but it is a change to the author-verification input on the create path, in
the exact area of a prod incident the file documents at `:562-577`. State it, and
make one slice-4 test assert that the STORED participant map is the ladder's
final read.

### 12. [MEDIUM] "6 any time" is false independence

**What is wrong.** Slice 6 is described as a "read-only audit" and then told to
"Fix in-region findings". Its region, per spec Sec 9's "by region, not by
filename" rule, includes `broadcastFanOut.ts` and `relayFanOut.ts` - the two
files slices 2 and 3 rewrite, including the exact `errorCodeOf`/status-branching
neighbourhoods (`broadcastFanOut.ts:408-459`, `relayFanOut.ts:517-535`).

**Evidence.** Plan slice 6 and Ordering line; spec Sec 9.

**What it implies.** Running slice 6 before 2/3 either conflicts or produces fixes
the later slices overwrite. Ordering must be "6 after 3".

### 13. [MEDIUM] Spec 7.5's backoff-equality proof has no stated values and no comparison method

**What is wrong.** The plan's test is "send count and `runAt` values per pass
identical to `main`." There is no main-comparison harness in this repo, so in
practice this becomes absolute assertions - which the plan does not supply.

**Evidence.** Existing pins are `app/test/broadcastFanOut.test.ts:531`
(`delaySeconds === 10` for pass 1->2) and `app/test/relayFanOut.test.ts:499`
(`delaySeconds === 5` for pass 1->2). Nothing pins pass 2->3 on either ladder.

**What it implies.** D7 says timing is unchanged and spec 7.5 says "counting sends
alone would not catch a ladder shifted a step" - but the step that would shift is
exactly the unpinned one. The plan should name the four numbers: broadcast 10s
then 20s, relay 5s then 10s, three passes each.

### 14. [MEDIUM] Close B cannot be driven through the ladder, and the plan's test description implies it can

**What is wrong.** Plan 2c: "close B driven on a first-pass envelope (no
`recipientKeys`)". Under the new control flow, close A returns before the
enqueue whenever `claim.attempt >= MAX`, so no envelope is ever produced after
the counter is spent; and the sole broadcast producer is gated on the draft flip
(`app/src/routes/broadcasts.ts:742-757`). Close B is reachable only from a
pre-existing spent counter or a concurrent-claim race.

**Evidence.** Plan 2a/2b control flow; `app/src/routes/broadcasts.ts:742-754`.

**What it implies.** A test that "drives close B on a first-pass envelope" without
pre-seeding `fanout_attempt` at the cap exercises close A, or nothing at all, and
passes. The plan must say the test pre-seeds the counter at `MAX` on the item and
then dispatches a first-pass envelope.

### 15. [LOW] Slice 2c/3c drop the cap branch's operator log

**What is wrong.** The extraction enumerates `recordRecipient`, `bumpStats`,
`emitBroadcastProgress` and `finalize` and omits the `log.error` that today
announces the cap. Close C's log line is specified in the plan; closes A and B
have none.

**Evidence.** `app/src/jobs/broadcastFanOut.ts:489-492`,
`app/src/jobs/relayFanOut.ts:577-580`.

**What it implies.** The only operator signal that a broadcast closed on the cap
disappears, and the two new close reasons arrive with no log at all. Specify one
log line per close, carrying the reason code.

### 16. [LOW] Slice 5a does not say whether the relay 30003 override keeps the `(error 30003)` tail

**What is wrong.** 5a says relay legs get "`Phone unreachable` with no retry
promise". `deliveryReason` appends `` ` (error ${errorCode})` `` to every mapped
code (`dashboard/src/routes/contact/deliveryStatus.ts:638-640`), and 5b
explicitly suppresses that tail for the internal codes - which reads, by
contrast, as though the relay override keeps it. But it is never said.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:628-641`; plan 5a
vs 5b.

**What it implies.** 30003 is a real carrier code an operator can look up, so the
tail should stay; either way the exact expected string belongs in the plan so the
test asserts one thing.

### 17. [LOW] ASCII gate risk in slice 5a

**What is wrong.** The plan tells the builder the live 30003 string contains an em
dash and to leave the 1:1 entry byte-identical, while adding a sibling relay
entry beside it. The obvious implementation is copy-and-edit, which carries the
em dash onto a NEW line.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:544`; AGENTS.md
"Editing and commit discipline" - on a pre-existing non-ASCII file, only ADDED
lines must be ASCII.

**What it implies.** One clause in the plan ("the new relay copy is ASCII") costs
nothing and removes a gate stumble.

### 18. [LOW] Slice 7 stamps the anchor issue without reconciling its third named site

**What is wrong.** `docs/issues/retry-counter-in-envelope-makes-caps-unreachable.md`
lists three sites in its body and four in `refs:`, including
`app/src/jobs/retrySend.ts:74`. This branch fixes two. The spec's Sec 1 table
adjudicates `retrySend` as already-handled; the plan's slice 7 says only "Stamp
Resolutions".

**Evidence.** Issue front-matter line 8 and body lines 44-46. I verified the
spec's adjudication independently: the `enqueueSendRetry` call at
`app/src/routes/webhooks/twilio.ts:2567-2571` sits inside a `try` whose `catch`
(`~:2727-2731`) logs ERROR and lets the callback 200 with the message already
terminal. The spec is right and the issue is stale.

**What it implies.** A Resolution that closes the issue without saying "the
`retrySend` site was traced and is not the shape" reads as a silently dropped
site. The stamping instruction should name it.

### 19. [LOW] Two in-file comments contradict D9 and sit inside the edited regions

**What is wrong.** `app/src/jobs/broadcastFanOut.ts:456-458` and
`app/src/jobs/relayFanOut.ts:532-534` both state that an SQS redelivery arrives
with "a fresh jobId via the visibility timeout". It does not:
`app/src/jobs/jobs.ts:189` mints `jobId` once at enqueue and it travels in the
envelope body, which is precisely why D9's immediate close and D12's filed defect
are correct.

**Evidence.** `app/src/jobs/jobs.ts:186-195`; `app/src/jobs/jobs.ts:222-236`
(`isCompleteEnvelope` accepts the redelivered envelope as-is at `:262`).

**What it implies.** The next reader of these two files - including whoever picks
up `throw-for-redelivery-defeated-by-job-marker` - is told the opposite of the
truth by the code adjacent to the throw. The plan edits both blocks; correcting
two comments is in-region and free.

### 20. [LOW] `closeRelay` leaves the hub message's own `delivery_status`, so a relay team message can still render mid-flight after a close

**What is wrong.** 3c: "No `finalize()`, no `bumpStats`, no progress emit - none
exist in this file." True. But a TEAM-authored relay message is persisted with
its own `delivery_status` (`app/src/services/relayQueuedMessages.ts:89` sets it
to `'queued'`), and nothing in the fan-out or in `closeRelay` moves it. Only the
per-leg receipts do, and after a close there are no receipts.

**Evidence.** `app/src/services/relayQueuedMessages.ts:86-99`;
`app/src/jobs/relayFanOut.ts:702-714` (the only message write the fan-out makes
is the recipient slot).

**What it implies.** Spec 7.3 asks that "the entity reaches a terminal state". On
relay the SLOTS do and the message-level field does not. The rollup at
`Timeline.tsx:894` should mask it (PARTLY UNVERIFIED - I did not trace every
render path that reads `msg.delivery_status`), but the plan should either say the
message-level field is deliberately untouched or add the assertion that the
rendered rollup is terminal.
