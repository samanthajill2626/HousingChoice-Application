# Spec round 1 - adjudications

Two independent adversarial reviewers, plan-blind, opus, read-only.
Reports: `spec-r1-reviewer-a.md` (19 findings), `spec-r1-reviewer-b.md` (22).

Counts: **17 ACCEPT, 6 REJECT, 2 DEFER.** The two reviewers converged
independently on the four defects that mattered most, which is why they are
treated as settled rather than as claims.

## Blocking - accepted, and they change the design

### A1 / B1 - the counter is erased every pass. ACCEPT.

**Verified.** `setRecipientDelivery` writes `SET delivery_recipients.#mk = :d`
(messagesRepo.ts:2777-2785) - a blind WHOLE-SLOT set. `setRecipient`
(broadcastsRepo.ts:584-605) does the same for the broadcast slot. The fan-out
calls these on every pass, so an `attempt` field living inside the slot is
overwritten with every status write. The fix as specified would have been a
**no-op that looked correct** - the counter would read 1 forever, which is the
exact failure mode the branch exists to remove.

Both reviewers found this independently. It is the single most valuable finding
of the round.

**Resolution.** The counter moves OUT of the slot into a **sibling top-level
map** on the same item (`fanout_attempts.<key>`, `retry_attempts.<key>`), which
no whole-slot writer touches. This also avoids editing two shared writers whose
child-field discipline was itself the subject of a prior fix wave.

### A2 / B2 - "a delivered attempt wins permanently" is undeliverable. ACCEPT.

**Verified.** `ALLOWED_PRIOR.delivered = ['queued', 'sent']`
(messagesRepo.ts:120-129). There is no `undelivered` predecessor. Once attempt 1
writes `undelivered`, attempt 2's `delivered` callback is rejected as a
regression by the very machine Sec 4.7 said it was keeping. The spec asserted a
guarantee its own mechanism forbids.

**Resolution.** A scoped, explicit lineage transition rather than a blanket
loosening of `ALLOWED_PRIOR` (which would let ANY caller regress a terminal).
A new repo method resolves `undelivered -> delivered` conditionally, and ONLY
when a lineage attempt records a delivered result. Forward-only stays intact for
every other caller.

### A3 / B3 - broadcastFanOut already finalizes. ACCEPT.

**Verified.** The cap branch calls `await finalize(...)` before returning
(broadcastFanOut.ts, cap branch ~:493). My Sec 3.5 called the missing finalize
"the single most user-visible defect in the bundle". **That was wrong**, and as
written it would have produced a double-finalize regression.

What is actually true and stays: if `enqueue` throws, NO path reaches finalize,
so the broadcast stays "Sending". The fix is to route an enqueue failure into
the EXISTING cap-close, not to add a second finalize.

### A4 / B4 - one field, two retry budgets. ACCEPT.

The fan-out continuation ladder and the 30003 retry ladder are different ladders
with different caps and different backoffs. Sharing one `attempt` field lets
continuations silently consume the 30003 chain's retries.

**Resolution.** Two separate counters, two separate caps.

### A5 - "changed destination - refuse" has nothing to compare against. ACCEPT.

The slot carries no destination phone. `relayMemberKey` is `contactId` OR
`phone#<E164>` (messagesRepo.ts:152-158), so the destination is recoverable only
for phone-keyed members - precisely the members whose phone cannot have changed.
For contactId-keyed members, the case the rule exists for, there is nothing
stored.

**Resolution.** The lineage attempt record stores `sentTo` (E164). The rule
becomes checkable.

### A6 / B14 - atomic ADD prevents a duplicate NUMBER, not a duplicate TEXT. ACCEPT.

The 1:1 path gates its retry on `if (transitioned && ErrorCode)` - the
forward-only transition is what makes a duplicate callback a no-op. The relay
branch has no such gate in the spec, so a redelivered 30003 callback could claim
a second attempt.

**Resolution.** The relay retry claim is gated on the slot transition having
actually happened, mirroring the 1:1 path.

### A7 / B6 - the 1:1 site is in scope with no defined change, and Sec 1 misdescribes it. ACCEPT.

**Verified.** The 1:1 count is ALREADY durable: the webhook reads
`message.retry_attempt` (twilio.ts 30003 branch) and the handler stamps it onto
the new message. Sec 1's blanket "every capped retry loop puts the count in the
envelope" is false for this site.

**Resolution.** Sec 1's claim is scoped to the two fan-outs. `retrySend`'s real
and much smaller gap - a throwing `enqueueSendRetry` leaves a chain that never
retries behind a chip that promises one - is stated as its own item, fixed by
the honest chip plus a guarded producer-side enqueue. No counter move there.

### B5 - the "immediate close" contradicts a deliberate policy. ACCEPT.

Sharp, and unique to B. I called the structural guarantee and the immediate
close "complementary"; they are in tension. If the counter already advanced
durably, closing on the first enqueue blip **discards remaining retries** the
design just made reachable.

**Resolution** - the split the spec should have made:

- **Consumer-side** (inside a job: fan-out continuations): let the handler
  THROW. SQS redelivers, the durable counter is already advanced, the cap is
  reachable. Do not close early.
- **Producer-side** (inside the webhook: no redelivery exists): close
  immediately, because nothing will ever come back.

### B16 - the rail ladder sits in a staff HTTP request. ACCEPT.

**Verified.** `ensureGroupRail` is called INLINE from `groupSend`
(groupSend.ts:381, and healRail at :425), which is reached from the send route
(api.ts:1361). A ladder of delayed re-reads would sit inside a staff send.

**Resolution.** The inline backstop does NOT ladder and does NOT repair: a
member Twilio did not refuse is treated as attached. The ladder applies on the
job and import paths only.

### A11 / B8 - Sec 5.2 contradicts Sec 5.3. ACCEPT.

5.2 says a still-unbound member is logged and we proceed; 5.3 says a rail still
short after the ladder "is still a failure". Both cannot hold.

**Resolution.** 5.2 wins and is stated once: a member the create did not refuse
is attached on Twilio's 200. Unbound-after-ladder is logged, never
`rail_failed`. `rail_failed` requires a repair refusal.

## Accepted, non-blocking

- **A8 / B7** - the context-aware 30003 copy has no wire field and no per-leg
  render site. ACCEPT, and it simplifies the fence: the chip stops promising a
  retry **unconditionally** (`Phone unreachable`, code exposed). The
  retry-aware variant needs lineage on the wire, which is T-DELIVERY-CHIPS'
  job. This both honors the fence and stops the lie today.
- **A9 / B9** - E2E test 11 would have to wait out a 60s module constant.
  ACCEPT. The hermetic flow drives job execution directly and asserts lineage
  transitions; it does not wait on wall-clock backoff.
- **A10** - `senderNameOverride` is team-only, so it cannot carry a
  member-authored sender label. ACCEPT: the retry stores the resolved sender
  label on the lineage attempt at first send and replays that.
- **B10 / A14** - `attempts` as an indexed LIST cannot be created by nested
  child-field updates and defeats the child-write race argument. ACCEPT:
  lineage is a MAP keyed by attempt number, so each attempt is an independent
  child path.
- **B11** - the pointer's new `n` needs a read-compat rule. ACCEPT: an absent
  `n` means attempt 1.
- **B12** - `missing` decided by an eventually-consistent follow-up read, and
  `missing` skips the close. ACCEPT: the disambiguating read is strongly
  consistent, and `missing` is logged and treated as nothing-to-advance only
  when the slot genuinely does not exist.
- **B13** - the new job is never registered or metered. ACCEPT: it registers in
  `registerHandlers.ts` and goes through the same breaker/token-bucket metering
  as the fan-out.
- **B15** - Sec 8's message-catalog sentence collides with the convention of the
  file it edits. ACCEPT: `ERROR_CODE_REASONS` is dashboard presentation, not
  automated send copy; the catalog rule does not apply. Sentence removed.
- **A12** - relayFanOut's existing off-by-one continuation backoff sits inside
  the edit. ACCEPT as a stated watch item: preserve current timing exactly, do
  not silently "fix" it in this branch.
- **A15 / A16 / B19 / B22** - factual corrections to the spec text (the em-dash
  quote, the `(error 30003)` tail, the omitted slot fields, Sec 10 vs Sec 6).
  ACCEPT, all precision edits.

## Rejected

- **A13** - "relayFanOut's cap-close emits no refresh event, against Sec 4.7".
  REJECT. Sec 4.7's rule governs the RETRY lineage's effective status, not the
  pre-existing fan-out cap path. Adding an event there is a behavior change this
  branch was not asked for and would land in T-DELIVERY-CHIPS' surface.
- **A17** - use `RELAY_PRESIGN_TTL_SECONDS` rather than `retrySend`'s constant.
  REJECT as stated - no such constant exists to point at; the relay legs presign
  inline. The spec will name the value explicitly instead.
- **A18 / B21** - `ReturnValues: 'UPDATED_NEW'` on a nested path. REJECT as a
  finding, ACCEPT as a note: B marked it UNVERIFIED and it is an implementation
  detail, not a design decision. The revision drops the counter to a top-level
  map anyway (A1), which moots it.
- **A19 / B20** - the slot type is shared with native group text and mirrored in
  `dashboard/src/api/types.ts`. REJECT as a fence violation: the sibling-map
  resolution (A1) means the slot type does not change, so neither surface is
  touched. Retained as a watch item.
- **B17** - "the new rail authority is vacuous on the bulk create path". REJECT.
  The create path returns per-member `failures`
  (groupConversations.ts:539-569); that is exactly the authority the revision
  relies on, and it is not vacuous. B did not show a create path that returns no
  failures list.
- **B18** - Sec 6's audit is unbounded and collides with the fences. REJECT the
  collision claim: the spec already says findings outside the anchor files are
  FILED, not fixed. Bounding accepted as a precision edit (the audit enumerates
  provider-status branches; it does not re-audit the whole app).

## Deferred to the issue registry

- **B5's second half** - whether a transient enqueue blip should ever be able to
  fail a recipient permanently anywhere in the codebase. Beyond M5.
- **A19/B20's mirrored dashboard type** - the hand-mirrored
  `dashboard/src/api/types.ts` is a drift hazard independent of this branch.

## What changed as a result

Four decisions moved, not merely precision edits:

1. The counter's home moved from inside the slot to a sibling map (A1/B1).
2. "Delivered wins" gained an explicit scoped transition instead of relying on
   a machine that forbids it (A2/B2).
3. The immediate-close rule split into consumer-side (throw) and producer-side
   (close) (B5).
4. The dashboard fix became unconditional rather than context-aware, which is
   both smaller and more honest (A8/B7).

Round 2 is warranted.

---

# Spec round 2 - adjudications

Continued reviewer A (same agent, holding round 1's context), given the revised
spec, this file, and reviewer B's report. Report: `spec-r2-reviewer-a.md`,
18 findings plus a contest of six adjudications.

Counts: **16 ACCEPT, 2 partial, 0 outright reject.** Five blocking, and
**three of them were defects the ROUND-1 REVISION introduced.** That is the
re-review charge earning its keep: a round that only re-checked round 1's
findings would have shipped all three.

## My two rejections that were WRONG

Both verified against the code. I was wrong on the facts, not on judgment.

- **A17 - `RELAY_PRESIGN_TTL_SECONDS`.** I rejected it as "no such constant
  exists to point at". It exists, exported, at relayFanOut.ts:65 and in use at
  :498. **Reversed to ACCEPT**; the spec now names it.
- **B17 - the rail authority is vacuous on the bulk create path.** I rejected
  this saying B "did not show a create path that returns no failures list". B
  did: groupConversations.ts:486 returns `failures: []` **unconditionally**.
  **Reversed to ACCEPT.** The rule survives - the bulk API is all-or-nothing, so
  a 200 does mean every participant was accepted - but that premise was exactly
  what B said the spec never stated, and it was right. Now stated, with a test
  pinning it.

Also partially conceded: **A18** (the revision deleted the `ReturnValues`
clause, leaving `claim.attempt`'s source unspecified - a real gap I created
while mooting the original finding) and **B18** (the "anchor files" disposition
rule is by filename while Sec 2's fences are by REGION; the collision survived
my rewrite). Both fixed. **A13 and A19/B20 were conceded by the reviewer**, and
B20 verified fully moot.

## Blocking - and three are mine

### F1 - my own idempotency gate capped the ladder at ONE retry. ACCEPT.

The round-1 fix for A6/B14 gated the retry claim on the slot having
transitioned, copying the 1:1 path. But `ALLOWED_PRIOR.undelivered` is
`['queued','sent']`, so attempt 2's 30003 cannot transition an already-
`undelivered` slot: transitioned is false and **nothing is ever claimed again**.
The relay ladder would silently stop after one retry.

The 1:1 gate works only because each 1:1 retry creates a NEW row with a fresh
`delivery_status`. The relay slot is reused, so it cannot carry per-attempt
idempotency. **The gate moves to the attempt record**, conditional on attempt
`n` not already being resolved.

Worth noting how this would have escaped: every natural test of "a 30003
schedules a retry" passes against the broken gate. Only a test driving three
consecutive callbacks catches it - now test 11b.

### F2 - the new sibling maps are never seeded. ACCEPT.

A nested `ADD` on an absent parent throws `ValidationException`, and under my
own consumer-side THROW rule that loops the envelope to the DLQ on the FIRST
claim. The round-1 revision moved the counters out of the slot to dodge the
whole-slot writers and forgot they now need seeding. Seeded at create, plus a
defensive seed-if-absent in the claim, which doubles as the read-compat story
for pre-branch items (F6/F17).

### F3 - a stale duplicate section survived the revision. ACCEPT.

Two `### 3.4 Read-compat` sections, the second still asserting the slot-resident
counter the revision exists to remove. A builder reading top-to-bottom would
have hit the contradiction. Deleted. Pure editing failure on my part.

### F4 - B's cap off-by-one was never adjudicated. ACCEPT.

I folded B4 into A4 in round 1; they are different findings. A4 is "two ladders
sharing one field"; B4 is "the durable claim counts enqueues where the envelope
counted passes, so the budget grows by one". The second went unanswered. Cap
semantics are now stated numerically - **4 provider sends maximum per
recipient** - with a test pinning the total, because an off-by-one here is one
extra real text to a real person.

### F5 - the retry path reaches into a fenced file. ACCEPT.

`relayAnnouncements.ts:289` writes relaysid pointers for intro, member-added and
**tour-reminder rung** sends. A retry keyed on "the pointer resolved" therefore
reaches `jobs/tourReminders.ts` - a Sec 2 hard fence owned by another live
branch - and would re-prefix an app-authored announcement with a sender name.
Now fenced structurally: only legs with a replayable source message retry, with
a test on the tour-reminder rung case.

## Accepted, non-blocking

- **F7** - the 1:1 producer-side close ALREADY SHIPS (twilio.ts:2727-2731).
  **The third time this spec proposed a fix for existing behavior**, after
  `finalize()` and `retry_attempt`. The 1:1 path leaves the code scope entirely.
- **F11** - and the justification I gave for closing there ("nothing redelivers
  a webhook") is contradicted by the file's own comments. Twilio DOES redeliver;
  the redelivery no-ops at the status transition. Same conclusion, wrong reason,
  now corrected.
- **F9** - `resolveRetryDelivered` as two writes strands the guarantee on a
  crash. Now a single conditional update, legal because lineage and slot are on
  one item.
- **F14** - the promotion bypassed the `transitioned` flag that gates the SSE
  emit, so a successful retry would update nothing on screen. Emits on its own
  write now.
- **F10** - the inline no-ladder rule would finalize a SHORT map as coverage,
  making receipt drops reachable by design. Split: the inline backstop may send,
  but may not declare roster coverage settled.
- **F12** - `ERROR_CODE_REASONS` is shared with the 1:1 bubble and broadcast
  badge, where a 30003 retry IS scheduled. A blanket edit would make 1:1 copy
  less accurate and violate Sec 2's own shared-presenter fence. Scoped to relay
  legs.
- **F6 / F17** - no lineage and no read-compat for legs sent before the branch;
  no test claimed against a pre-branch item. Both closed (Sec 3.5, test 11e).
- **F8** - the consumer-side rule covers only enqueue failure; the pre-existing
  unknown-error throw never reaches the claim. Accepted as a stated limit rather
  than a silent gap.
- **F13, F15, F16, F18** - precision: the em-dash/tail instruction, the
  `isTerminal` decision B asked for, the unscoped 50386/50437 rule colliding
  with adopt-path authority, and the 400KB item budget under a 1500-recipient
  cap.

## Loop status

Round 2 changed decisions materially (the gate, the seeding, the fence, the cap
semantics, the dashboard scoping), so the stop rule is not met. **Round 3 is
warranted.** Hard cap is 4.

The pattern worth naming for round 3: **every blocking finding in this round was
in material written to close the previous round's blocking findings.** Round 3's
sharpest question is therefore the same one again - not "are round 2's findings
closed" but "what did the round-2 rewrite break".

---

# Spec round 3 - adjudications, and the scope decision

Report: `spec-r3-reviewer-a.md`, 16 findings. Six blocking, **all six in
round-3 material**, and the reviewer answered "no" to all three questions I
flagged as my least confident.

Verified before acting on them:

- **R3-1** - the single-write promotion condition reads the lineage value the
  same write must set. A genuine catch-22 I created while fixing R2-F9's
  two-write race: either two writes (stranding on a crash) or one write whose
  condition reads its own effect. Fixable by setting BOTH paths in one update,
  but my text was wrong.
- **R3-3** - the inline rail path leaks the `rail_creating` claim. VERIFIED:
  released only by `setTwilioConversation` or `recordRailFailure`
  (conversationsRepo.ts:1001-1008). Every variant of my "send but do not
  finalize coverage" split either leaks the claim or requires editing
  `conversationsRepo.ts`, **a Sec 2 hard fence owned by M1**.
- **R3-2, R3-6** - missing cap/outcome clauses on the new gate, and a second
  duplicated section number. Drafting failures, the second one a repeat.
- **R3-7, R3-10** - the dashboard scoping as written named a surface that
  renders no reason. Investigated: `deliveryReason` already swaps reason maps
  from an `opts.media` flag (deliveryStatus.ts:628-640), and
  `presentRelayDelivery` (:387-416) already passes opts - so the scoping IS
  expressible, and better than I had it, because relay legs and native
  group-text legs both lack a retry and both want the corrected copy.

**On my adjudications:** B18 confirmed completely closed; A18 half closed (the
payload-size question is now answered explicitly in Sec 3.3); A17, B17, R2-3 and
R2-5 all closed.

## The decision: SPLIT the bundle

Put to Cameron with the open findings, per the review loop's rule about a design
that is not converging. **Cameron chose to split.**

The evidence for splitting, three rounds of it:

| round | decisions moved | blocking findings in the PREVIOUS round's fixes |
|---|---|---|
| 1 | 4 | - |
| 2 | 5 | 3 of 5 |
| 3 | 6 | **6 of 6** |

The findings clustered almost entirely in `relay-30003-retry-lineage`'s state
machine. The anchor issue converged after round 1 and produced no blocking
finding in rounds 2 or 3. That is a scope signal, not a drafting signal: the
lineage work is a mission (nine acceptance criteria, a new job, a new store, a
webhook change and dashboard rendering), and pairing it with the anchor was
holding a converged high-severity fix hostage to an unconverged medium one.

**Resolution.** This branch closes the high and the low. `relay-30003` stays
OPEN and is re-bundled as its own mission, starting from the durable attempt
substrate this branch lands - which is the exact dependency M5 cited when it
paired them, so nothing is lost by sequencing them instead.

Two things got SIMPLER as a direct result, both worth noting because they
removed whole classes of the findings above:

1. `routes/webhooks/twilio.ts` leaves the branch entirely. No reason to touch a
   file three other bundles own.
2. The producer/consumer close split collapses - both remaining sites are
   consumer-side, so the rule is just "throw and let the redelivery reach the
   cap".

The rail fix also narrowed to the job and import paths, which is where the
measured harm actually occurred (the 2026-08-13 migration), leaving the request
path and the claim lifecycle untouched.

## Round 4

The spec was REWRITTEN at the reduced scope rather than patched - three layers
of "an earlier revision said X" annotations had become archaeology a builder
would have to read past. The corrections that PREVENT a builder from re-making a
mistake were kept (the counter cannot live in the slot; the cap branch already
finalizes; do not touch the inline rail path or the backoff); the rest was cut.

A rewrite is new unreviewed material, so round 4 runs on it - the last permitted
round, and the stop rule applies: if it changes no decision, the design is done.

---

# Spec round 4 - adjudications (final round)

Report: `spec-r4-reviewer-a.md`, 12 findings, 4 blocking. **All 12 accepted.**
The rescope itself broke two things, which is exactly what round 4 was for.

Verified before acting:

- **R4-1** - my `if_not_exists` seed in the same update as the `ADD` is the ONE
  shape this repo documents as rejected (overlapping document paths), stated in
  both files being edited. Replaced with a lazy cold-path seed: try the `ADD`,
  and only on the parent-absent failure seed and retry. Two writes on first
  claim, one thereafter.
- **R4-4** - and the creation-site seed I proposed instead would have sent the
  builder into `twilio.ts` (`deliveryRecipients: {}`), the file the rescope had
  just fenced entirely. The lazy seed removes the need for ANY creation-site
  edit, closing R4-1 and R4-4 together.
- **R4-2** - "inline path UNCHANGED" was not expressible: `ensureGroupRail` has
  no caller identity and the rules are shared code. Now an explicit opt-in flag
  on `GroupRailRequest` that only the job and import callers pass, and the test
  pins it by construction rather than by the untestable phrase "byte-identical"
  (R4-12).
- **R4-3** - VERIFIED and serious. `deliveryReason` has four call sites, not
  one: `Timeline.tsx:582`, `:849`, `:1045`, `:1390`. The `:1045` per-recipient
  row sits directly beneath the rollup, and the file's own comment at
  :1035-1042 states the invariant my partial fix would break: "One `isMms` feeds
  the rollup, this row and the accessible name, so the three cannot disagree."
- **R4-6** - VERIFIED, and it corrected a false premise of mine. The
  30005/30006 arm (twilio.ts:2633) and the 21610 arm (:2691) each carry a
  `group_text` guard; **the 30003 arm carries none**, so native group text DOES
  get a retry. My widening of the copy fix to every leg `presentRelayDelivery`
  renders was wrong. Scoped to relay legs only.

**The scope decision this round produced.** R4-3 meant a coherent chip fix spans
`Timeline.tsx`, which `_CLUSTERS.md` assigns to T-DELIVERY-CHIPS. Put to
Cameron. He established that T-DELIVERY-CHIPS is **Tier 2** - unscheduled
backlog, not the ordered queue - and no live worktree touches `Timeline.tsx` or
`deliveryStatus.ts` (verified across all ten). **Ruling: touch it.** A partial
fix that makes two adjacent surfaces contradict each other is worse than none.

Remaining accepted findings, all folded in: the cap literal is now named as
`MAX_* - 1` with a test asserting the send count equals `main`'s (R4-5); Sec 9's
obligation now carries the deferred mission's four hard-won traps and the copy
debt this branch creates (R4-7); Sec 2.1 no longer claims the lineage inherits a
reusable counter, only the pattern (R4-8); the broadcast dead-queue e2e is
dropped for lack of an injection seam and covered at integration level where
`enqueue` is stubbable, with the relay copy fix taking the e2e slot (R4-9); the
item-size budget is answered with a measurement the builder must record, and a
fallback if the margin is thin (R4-10); the `recordRailFailure` citation is
corrected (R4-11).

## Loop status: CONVERGED

Round 4 was the hard cap. Its findings were **corrections and one scope ruling**
- no finding overturned a design decision made in round 3. The four-round arc:

| round | blocking | in the PREVIOUS round's fixes | decisions moved |
|---|---|---|---|
| 1 | 7 | - | 4 |
| 2 | 5 | 3 of 5 | 5 |
| 3 | 6 | 6 of 6 | scope split |
| 4 | 4 | 2 of 4 | 1 (Cameron's Timeline ruling) |

The design is done. What broke the self-inflicted cycle was not another round of
fixes - it was removing the scope that was generating them.

---

# Post-gate simplification - the scalar pass counter

Not a review round. Cameron asked at the spec gate whether "any enqueue failure
is terminal, and it won't be requeued at all". Answering it precisely exposed
that the answer was fine but the DESIGN AROUND IT was carrying weight it no
longer needed.

**The answer to the question:** no. An enqueue failure throws, SQS redelivers,
the job re-runs and re-attempts the remaining recipients. The count advances per
pass, so a persistently broken queue walks to the cap and only THEN closes.
Terminal comes from exhausting the cap, never from a single failure.

**What the question exposed.** The spec's "known limit" - that the pre-existing
unknown-error `throw` (broadcastFanOut.ts:459, relayFanOut.ts:535) never reaches
a claim placed at the continuation point, leaving that path's counter frozen and
its row stuck after the DLQ - was described as needing an error-taxonomy rework.
It does not. **Moving the claim to the top of the pass** covers every exit from
the handler, including that throw.

And once the claim counts PASSES rather than enqueues, per-recipient granularity
buys nothing: recipients in a continuation are attempted together and success is
terminal, so the counts were always in lockstep. Round 1's rule was that the two
LADDERS must not share a field; with the lineage ladder deferred (Sec 2.1), one
ladder remains and a **scalar** is the honest shape.

**Cameron approved folding it in.** The change is strictly a simplification, and
it REMOVES rather than answers four findings the map version had to carry:

| finding | map version | scalar version |
|---|---|---|
| R4-1 `if_not_exists` is a rejected UpdateExpression shape | needed a cold-path seed | **no parent path exists**; `ADD` creates the attribute |
| R4-4 the seed site is in fenced `twilio.ts` | avoided via lazy seeding | **no seeding step at all** |
| R4-10 400KB item budget at 1500 recipients | measurement + fallback owed | **no map stored** |
| R4-5 cap off-by-one (`MAX - 1`) | literal had to be named | **counts passes, one-for-one with the envelope** |

Plus it closes the limit that prompted the question, which the map version left
open regardless of placement.

New material to review: Sec 3 in full, and test 7a - the regression test for the
unknown-error path, which fails against a design that claims at the continuation
point. Two watch items added so a later refactor cannot quietly undo the
placement, since "move the claim next to where it is used" is exactly the tidy a
reviewer would suggest.
