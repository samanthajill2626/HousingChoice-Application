# R7 - cold adversarial review of the retry-counter-durable design spec

Reviewer brought in cold: spec + repo only, no review history, no brainstorm, no
adjudications. Every claim below cites a line I opened. Anything I could not
establish is marked UNVERIFIED.

Spec under review:
`docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`.

## What I verified and found CORRECT

Stated up front so the findings below are not read as a blanket rejection.

- `jobId` is stable across redeliveries. `buildEnvelope` mints it once
  (`app/src/jobs/jobs.ts:188`); `dispatchJob` uses a complete envelope verbatim
  (`jobs.ts:262`) and its docblock says "the stable jobId" (`jobs.ts:286-287`);
  `putJobExecutionMarker` is a conditional PUT whose item carries `executed_at`
  and no `expires_at` (`app/src/repos/messagesRepo.ts:2630-2649`), so the
  suppression never expires. The filed issue is right, and so is Sec 3.4's
  factual chain.
- The recipient slot IS written wholesale on every pass:
  `SET delivery_recipients.#mk = :d` (`messagesRepo.ts:2781-2790`) and
  `SET recipients.#ck = :rec` (`app/src/repos/broadcastsRepo.ts:615`). Sec 3.1's
  "a counter in the slot reads 1 forever" is correct.
- `broadcastFanOut`'s cap branch DOES call `finalize()`
  (`app/src/jobs/broadcastFanOut.ts:493`). Sec 3.6's correction stands.
- `relayFanOut` really does select its delay with
  `fanOutBackoffMs(payload.attempt ?? 1)` (`app/src/jobs/relayFanOut.ts:595`)
  against `broadcastFanOut`'s commented next-step choice
  (`broadcastFanOut.ts:503-506`). Sec 3.7's "do not touch it" is right.
- `retrySend` (1:1) reads the count off the persisted row
  (`app/src/routes/webhooks/twilio.ts:2556`), and its enqueue failure is caught
  by the switch-wide try/catch (`twilio.ts:2727-2731`). `enqueueSendRetry` has
  exactly one caller (`twilio.ts:2567`), so Sec 1's "already handled" holds.
- A literal `!== 'success'` returns zero hits in `app/src`. Sec 5 is right.
- The 30003 arm at `twilio.ts:2553-2571` carries no `group_text` guard while
  30005/30006 (`:2633`) and 21610 (`:2691`) do, and the relay-pointer branch
  returns before the retry branch (`twilio.ts:2433-2437`). Sec 6's scoping
  correction is right.
- `MessageItem` and `BroadcastItem` both carry an index signature
  (`messagesRepo.ts:1016`, `broadcastsRepo.ts:172`); no zod, no snapshot, no
  `toStrictEqual`, no top-level key iteration over either item. Sec 3.2's
  "no migration" is safe on the type side.
- `rail_creating` really is released only by `setTwilioConversation` and
  `recordRailFailure` (`app/src/repos/conversationsRepo.ts:979`, `:1008`,
  `:2436`, `:2484`), with re-claim-on-expiry at `:2418-2420` and
  `RAIL_CLAIM_EXPIRY_MS = 5 * 60 * 1000` (`app/src/services/groupRail.ts:198`).
  Sec 4.2's second reason is sound and its line cites are exact.

---

## BLOCKING

### 1. Sec 3.4's code block and its own prose specify OPPOSITE orderings

**What is wrong.** The pseudo-code puts the marker FIRST and the claim second,
with the comment `// true duplicate: no claim`. Two paragraphs later the prose
says "**The claim sits BEFORE the marker, and this is forced**", and "A true
duplicate delivery now consumes a retry rung". Test 7a (Sec 7) pins the prose
version. These cannot both ship.

**Evidence.** Spec Sec 3.4, the block at lines 184-195 vs the prose at 208-227;
Sec 7 test 7a.

**Implies.** This is the single most load-bearing decision in the document and
the builder is handed both answers. A builder who copies the code block - the
natural thing to do - ships the ordering the spec argues against and fails its
own test 7a. Fix the block or delete it; do not leave the reader to adjudicate.

### 2. The "forced" justification for claim-before-marker is false, and the spec refutes it itself

**What is wrong.** Sec 3.4 argues the ordering is forced because "With the claim
after the marker, `fanout_attempt` would freeze at 1 forever - the exact
frozen-counter bug this branch exists to remove." That is not true. A legitimate
continuation is a NEW `enqueue`, so it carries a fresh `jobId`
(`jobs.ts:188` mints one per envelope), passes the marker, and its claim
advances the counter. The only deliveries a post-marker claim skips are
same-`jobId` REDELIVERIES, which by the spec's own Sec 3.4a "do no work" and
therefore need no rung.

Sec 3.4a says exactly this, one page later: "the durable counter ... makes the
cap reachable across the LEGITIMATE continuations, each of which is a new
enqueue with a fresh `jobId`". Sec 3.4 and Sec 3.4a cannot both be right.

**Evidence.** Spec Sec 3.4 lines 208-227 vs Sec 3.4a lines 266-268;
`app/src/jobs/jobs.ts:188`, `:262`.

**Implies.** The ordering is a free choice, not a forced one - and the spec
accepts a stated real cost ("the ladder is shortened by one" on every duplicate
delivery) to buy nothing. Worse, it is not a neutral choice: see finding 3.

### 3. Claim-before-marker makes the close branch reachable on a duplicate, and the close is not idempotent

**What is wrong.** With the claim above the marker, a duplicate delivery of a
pass whose chain already reached the cap gets `outcome: 'capped'` and, per Sec
3.4, runs `close()` - on a broadcast that already closed. The existing close is
not idempotent:

- it does `bumpStats({ failed: 1, queued: -1 })` per recipient
  (`broadcastFanOut.ts:482-487`) - a cumulative `ADD` on `stats.failed`
  (`broadcastsRepo.ts:632-673`), so a second run inflates the counter;
- `finalize` decides markSent vs markFailed from that PERSISTED counter:
  `allFailed = total > 0 && fresh.stats.failed >= total`
  (`broadcastFanOut.ts:572`), not from the derived map;
- `flipStatus` has no terminal-status guard (`broadcastsRepo.ts:441-451`), so
  it will happily move an already-`sent` broadcast to `failed`.

**Evidence.** Spec Sec 3.4; `broadcastFanOut.ts:478-494`, `:572-575`;
`broadcastsRepo.ts:441-451`, `:632-673`.

**Implies.** A duplicate SQS delivery - the exact event the marker exists to
neutralise - can flip a fully successful broadcast to "Failed" in the dashboard.
The spec's cost analysis names only "the ladder is shortened by one"; this is a
second, larger cost it does not name.

### 4. "The close branches are the EXISTING ones" is not implementable at the claim site

**What is wrong.** Both existing cap branches close over `transientRemaining` -
a list built by the pass's send loop (`broadcastFanOut.ts:478-494`,
`relayFanOut.ts:569-582`). At the TOP of the handler, where Sec 3.4 puts the
claim, that list is empty. So the capped-claim path cannot "run the EXISTING cap
branch"; it needs a recipient set derived from something else
(`payload.recipientKeys`? every non-terminal slot?). Sec 3.6 asserts the fix
"never add[s] a new [close]" and the spec never states the set.

Concretely, if the envelope guard is replaced by the claim (see finding 5), the
final pass enqueues a continuation whose only job is to close. That close marks
NOTHING failed, and for broadcast then calls `finalize()` with recipients still
`queued` and `stats.failed < total`, so `allFailed` is false and the broadcast is
marked **sent** with dangling `queued` recipients - strictly worse than `main`,
which marks them `failed`/`transient_cap`.

**Evidence.** Spec Sec 3.4, Sec 3.6 (table and "never adding a new one");
`broadcastFanOut.ts:478-494`, `:561-575`; `relayFanOut.ts:569-582`.

**Implies.** The one branch the whole feature exists to make reachable is
unspecified at its new call site, and the obvious literal reading produces a
silent regression. Sec 7 test 3 would not catch it: it stubs `enqueue` to throw,
which exercises Sec 3.4a's close (where `transientRemaining` IS populated), not
the capped-claim close.

### 5. The spec never says whether the existing `nextAttempt > MAX_*` guard survives, and the two readings behave differently

**What is wrong.** Sec 3.5 says "The old code closed when `nextAttempt > MAX`;
the claim refuses when `fanout_attempt` has reached `MAX`", implying
replacement. Sec 3.6 says the close is "the EXISTING cap branch", implying the
branch stays where it is. Both readings are defensible and they differ:

- **Guard kept:** the envelope counter still governs the cap in every normal
  flow and the claim's `capped` outcome is dead code. The anchor bug is then
  closed entirely by Sec 3.4a's immediate close - which means the durable
  counter, the whole subject of the branch, is decorative.
- **Guard deleted:** an extra, no-send pass must be enqueued to reach the
  capped claim, exercising backoff steps `main` never used -
  `broadcastBackoffMs(4)` = 40s (`broadcastFanOut.ts:82-84`) and relay's
  `fanOutBackoffMs(3)` = 20s (`relayFanOut.ts:68-70`) - so a capped broadcast
  sits in "Sending" ~40s longer than today.

**Evidence.** Spec Sec 3.5, Sec 3.6; `broadcastFanOut.ts:478-495`,
`relayFanOut.ts:569-582`.

**Implies.** Sec 3.5's guarantee ("unchanged in value and in meaning ... The
total number of send passes per recipient is identical to `main`") is unproven
under either reading, and test 6 counts provider sends only, so it passes for
both. The wall-clock-to-terminal change is user-visible and unmentioned.

### 6. Sec 6 never names the relay discriminator, and the obvious candidate is booby-trapped

**What is wrong.** Sec 6 says "the presenter is told which it is rather than
inferring it" but never says WHAT signal. The only existing in-scope candidate
is `RosterKind` (`'relay' | 'group_text'`,
`dashboard/src/routes/contact/Timeline.tsx:212`), which already travels to the
per-leg presenter. It **defaults to `'relay'`** at
`Timeline.tsx:796` (`MessageBubble`) and `Timeline.tsx:1519` (the Timeline
itself). Every 1:1 contact thread therefore renders with
`rosterKind === 'relay'`.

Site `Timeline.tsx:849` is the message-level bubble reason
(`deliveryReason(msg.error_code, { media: isMms })`) and fires on ordinary 1:1
bubbles. Wiring the override off `rosterKind` flips the 1:1 30003 copy to
`Phone unreachable` - the exact row Sec 6's own table marks "unchanged,
correct: a retry is scheduled".

**Evidence.** Spec Sec 6 (table + "told which it is");
`Timeline.tsx:212`, `:796`, `:808`, `:849`, `:1519`.

**Implies.** The spec's stated guarantee (1:1 and native group text unchanged)
is not delivered by any mechanism it names, and the nearest mechanism actively
breaks it. Name the discriminator, and say explicitly that it must NOT default
to relay.

---

## HIGH

### 7. `Timeline.tsx:1390` is an EMAIL card, not a relay leg

**What is wrong.** Sec 6 lists `Timeline.tsx:1390` among the sites that must
receive "the same relay discriminator its `media` flag already travels beside",
justified by the three-must-agree invariant at `Timeline.tsx:1035-1042`. Line
1390 is inside `EmailCard` (declared `:1385`): `deliveryReason(msg.error_code)`
on an email delivery status. It has no `media` flag, no recipient legs, and no
relation to that invariant.

The enumeration is also arithmetically wrong: it says "All FOUR `deliveryReason`
call sites" then names five locations (`:582`, `:849`, `:1045`, `:1390`, plus
`deliveryStatus.ts:416`), and it misses a sixth -
`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`.

**Evidence.** Spec Sec 6 lines 470-477; `Timeline.tsx:1385-1390`, `:1035-1042`;
`DeliveryBadge.tsx:31`.

**Implies.** A builder following Sec 6 literally edits the email-rendering path
for no reason, and the spec's "all four, so the three cannot disagree" argument
is not the set of sites it actually enumerated.

### 8. `enqueue_failed` reintroduces the exact defect `INTERNAL_CODE_REASONS` exists to fix

**What is wrong.** Sec 3.4a introduces a new app-invented error code and argues
that rendering it through `deliveryReason`'s unmapped fallback -
`Delivery failed (error enqueue_failed)` - is "free and honest". The file the
spec is editing says otherwise. `INTERNAL_CODE_REASONS`
(`dashboard/src/routes/contact/deliveryStatus.ts:590-611`) exists for exactly
this class, and its docblock reads: "Codes THIS APP invents, which no carrier
ever emits and no operator can look up ... printing `contact_opted_out` as if it
were a carrier error number is the defect this map exists to fix (A16)."

The spec cites `transient_cap`'s ugly fallback rendering as EVIDENCE for why a
distinct code is needed, without noticing that the ugly rendering is itself the
already-diagnosed bug, and then adds a second instance of it. It never mentions
`INTERNAL_CODE_REASONS` at all.

**Evidence.** Spec Sec 3.4a lines 255-261, Sec 7 test 7d;
`deliveryStatus.ts:590-611`, `:628-641`.

**Implies.** Staff read a raw internal token formatted as a carrier error
number. `enqueue_failed` (and arguably `transient_cap`) belongs in
`INTERNAL_CODE_REASONS` with operator copy and no `(error ...)` tail. This is a
one-line addition in a file already in scope.

### 9. `enqueue_failed` also lands on the broadcast results surface, which Sec 6 marked "unchanged"

**What is wrong.** Sec 3.4a's close writes the new code onto BROADCAST recipient
slots (`errorCode: 'enqueue_failed'`). `DeliveryBadge` renders a broadcast
recipient's failure reason with `deliveryReason(errorCode)`
(`DeliveryBadge.tsx:31`, rendered as a title and appended text at `:32-36`).
Sec 6's table says "broadcast badge | unchanged", which is true for 30003 and
false for the code this branch invents.

**Evidence.** Spec Sec 3.4a, Sec 6 table; `DeliveryBadge.tsx:19-37`.

**Implies.** A reader the spec never enumerated shows the new code. If finding 8
is fixed, this surface is fixed with it - which is the argument for fixing it
there rather than at each renderer.

### 10. Sec 4.1's central claim about the read-back is FALSE

**What is wrong.** Sec 4.1: "The read-back is **not** verifying that Twilio
performed the add. It harvests `messagingBinding.address`, the
receipt-attribution key." The code says the opposite, in its own comment at
`app/src/services/groupRail.ts:536-537`: "The re-read is authoritative: an add
can 'succeed' and still leave a shape Twilio will not bind, and a repair that
trusted its own return value would store a map that does not describe the rail."

The read-back (`groupRail.ts:492`, re-read at `:538`) feeds BOTH
`buildParticipantMap` (`:506`, `:539`) and `missingFromMap` (`:507`, `:540`),
and drives `group_rail_participants_incomplete` (`:519`), the
`recordRailFailure` / `{status:'failed'}` path (`:552-559`), and the author
verification (`:578-584`).

**Evidence.** Spec Sec 4.1; `groupRail.ts:492`, `:506-507`, `:519`, `:536-540`,
`:552-559`, `:578-584`.

**Implies.** The spec's framing invites a build that treats a short map as
always-benign. The address skip IS a real cause of false negatives (finding 20),
but it is not the read-back's only job, and a rule written on the false premise
would remove a deliberate guarantee. Restate the premise as "one of the
read-back's inputs propagates asynchronously", not "the read-back is not
verification".

### 11. E2E test 11's premise is explicitly refuted in the repo

**What is wrong.** Sec 7 test 11 says the relay 30003 chip "is reachable through
the existing seeded world". No seed profile writes `delivery_recipients` at all
- zero hits across `app/src/lib/seed/` - and the repo states this in the very
suite the spec would extend:
`e2e/tests/dashboard-next/group-text-per-recipient-delivery.spec.ts:31-34`
("No seed row in any profile carries a `delivery_recipients` map, so seed data
cannot produce a mixed state at all"). That file also records
(`:25-29`) that native group text was chosen precisely because a relay leg is
the harder one to arm end to end.

**Evidence.** Spec Sec 7 test 11; `group-text-per-recipient-delivery.spec.ts:25-34`;
no `delivery_recipients` writer under `app/src/lib/seed/`.

**Implies.** The branch's ONLY e2e and its only user-facing verification rests on
a false premise. The spec must say how the leg is created and how the 30003
receipt is armed (a driven relay send plus `setDeliveryOutcome` from
`e2e/fixtures/fakeTwilio.js`), or state that a new fixture is needed - and if a
seed fixture is the answer, `lean.ts` is a scope surface Sec 2 does not list.

### 12. `ensureGroupRail` has a FIFTH caller the spec's table omits

**What is wrong.** Sec 4.2's table enumerates three callers (plus `healRail`).
There is a fifth production caller: `app/scripts/rail-verify.ts:198`, an
operator repair/verify script that builds the real service with an injected
repo (`rail-verify.ts:192`). Because Sec 4.2 makes the fix opt-in per caller, the
verify script keeps today's behavior - the false `group_rail_participant_add_failed`
refusals and the false `rail_failed` records.

**Evidence.** Spec Sec 4.2 table; `app/scripts/rail-verify.ts:192`, `:198`;
`jobs/groupRail.ts:59`; `lib/import/convertGroups.ts:598` (called from `:429`);
`services/groupSend.ts:381` and `healRail` at `:412`/`:425`, invoked `:548`.

**Implies.** The issue's measured harm (`rail-binding-propagation-retry.md:17-24`)
was a cutover report - the exact context `rail-verify` serves. Leaving it out is
the difference between fixing the alarm and moving it. Also note
`app/test/groupRailService.test.ts` drives the real service ~25 times
(`:188-744`); test 8's "assert the flag is absent" must cover those or the
default silently changes meaning.

### 13. Sec 4.3's "premise, stated explicitly" is wrong on both halves - and test 9 would pin the wrong thing

**What is wrong.** Sec 4.3 asserts the bulk create "returns `failures: []`
**unconditionally** (groupConversations.ts:486) ... a refusal throws instead".

`app/src/adapters/groupConversations.ts:486` is the bulk-**success** return
only. Its enclosing `catch` (`:487-515`) rethrows only a UniqueName
50353 / HTTP 409 (`:496-502`) and otherwise falls through to
`createWithIndividualAdds` (`:518`), which returns POPULATED `failures`
(`:539-541`). The whole bulk block is additionally gated on
`total <= MAX_RAIL_PARTICIPANTS` (`:472`). So from `ensureGroupRail`'s vantage
an ordinary per-member refusal does NOT throw - it is silently converted into
the individual-add path.

Separately: on the bulk path `participants` come from a read-back performed
immediately after create (`:480`), so a bulk 200 can itself return a short list -
which is the confound Sec 4.3 is trying to rule out, not a case it excludes.

And "per-member `failures` are real only on the individual-add fallback
(`attach`, groupConversations.ts:539-569)" mis-cites twice: `attach` is declared
at `:545-570` (`:539` is a call site), and `attach` is ALSO the body of
`addParticipants` (`:572-583`) - the REPAIR path called from `groupRail.ts:523`.

**Evidence.** Spec Sec 4.3 lines 373-384, Sec 7 test 9;
`groupConversations.ts:472`, `:480`, `:486`, `:487-518`, `:539-541`, `:545-583`.

**Implies.** Test 9 ("the bulk-create premise is pinned ... all-or-nothing")
would assert something the adapter does not promise, and would pass while the
rule it guards is unsound. The rule may still be safe - but the spec's stated
reason for believing it is not the code's behavior.

---

## MEDIUM

### 14. Sec 4.3's rule needs a `failures` list that does not survive to the decision point

**What is wrong.** "Repair is entered only for members the create actually
refused" requires knowing which members the create refused. `created.failures` is
consumed into a single boolean - `authorRefusedOnCreate` (`groupRail.ts:463`,
declared `:397`, used `:584`) - and the per-member entries are never assigned to
anything that survives line 464. By `missing = missingFromMap(...)` at `:507`,
nothing in scope distinguishes a create-refused member from a still-propagating
one from an address-less skip.

**Evidence.** Spec Sec 4.3; `groupRail.ts:397`, `:456-464`, `:507`, `:584`.

**Implies.** Sec 4.3 says "Everything follows from that one sentence." It does
not: it also requires a new data flow the spec never mentions, in the one file it
does put in scope.

### 15. 50386/50437 appear NOWHERE in source

**What is wrong.** Sec 4.3 states "**50386/50437 during repair** are
success-pending-re-read, not refusals", phrased as a change to existing
handling. A repo-wide grep for `50386|50437` returns zero hits in any source
file - every occurrence is in this spec, its review artifacts, and
`docs/issues/rail-binding-propagation-retry.md`. Today `attach` records whatever
`errorCode` came back (`groupConversations.ts:554-566`) and `ensureGroupRail`
ignores the failure list entirely (`groupRail.ts:524-534`), so an "already
exists" refusal is indistinguishable from a genuine one.

**Evidence.** Spec Sec 4.3; `groupConversations.ts:554-566`;
`groupRail.ts:523-534`.

**Implies.** These are new provider-code literals, not an adjustment. The spec
should say where they live and why hard-coding them is acceptable.

### 16. Sec 2's "In" list omits three files Sec 4 and Sec 6 require editing

**What is wrong.** Sec 2 is the document's scope authority and the section this
review was told to treat as the fence. It does not list:

- `dashboard/src/routes/contact/Timeline.tsx` - four call sites, mandated by
  Sec 6 ("All FOUR ... are updated");
- `app/src/jobs/groupRail.ts` - must pass the new opt-in flag (Sec 4.2);
- `app/src/lib/import/convertGroups.ts` - same, and specifically at `:429`,
  which builds the `GroupRailRequest` that `:598` forwards.

**Evidence.** Spec Sec 2 lines 52-62 vs Sec 4.2 and Sec 6;
`jobs/groupRail.ts:59`; `convertGroups.ts:429`, `:595`, `:598`;
`GroupRailRequest` at `services/groupRail.ts:118-122`.

**Implies.** A builder reading Sec 2 as authoritative either skips the work or
asks. Sec 6 spends a paragraph justifying the `Timeline.tsx` edit but never adds
it to the fence list, so the two sections disagree about what is in scope.

### 17. Sec 6 reverses an explicit routing instruction in the cluster that defines this mission

**What is wrong.** `docs/issues/_CLUSTERS.md` M5's conflicts line says of the
30003 issue: "the 30003 issue has a dashboard half in `deliveryStatus.ts` -
**land the backend lineage here and let T-DELIVERY-CHIPS render it**". Sec 6 does
the exact reverse: it defers the backend lineage (Sec 2.1) and lands a dashboard
copy change here, editing `Timeline.tsx` too. The justification is a human
authorization a builder cannot verify and an assertion about ten other worktrees
that is true only at a moment in time.

**Evidence.** `docs/issues/_CLUSTERS.md` M5 conflicts paragraph; spec Sec 2.1,
Sec 6 lines 479-483.

**Implies.** The reversal may be right, but the cluster file and the spec now
contradict each other in the repo and the spec does not reconcile them. Either
update `_CLUSTERS.md` in the same change or say plainly that the routing was
overridden and why.

### 18. The spec says the low issue "closes"; the fix leaves the defect live on three call paths

**What is wrong.** The Sec 1 table marks `rail-binding-propagation-retry` as
**closes**. Sec 4.2's opt-in design deliberately leaves `groupSend.ts:381` (the
inline send backstop) and `healRail` (`groupSend.ts:412`, invoked `:548`)
unchanged, and finding 12 adds `rail-verify.ts:198`. The issue's own suggested
fix (`rail-binding-propagation-retry.md:26-32`) is not scoped by caller.

**Evidence.** Spec Sec 1 table, Sec 4.2; `docs/issues/rail-binding-propagation-retry.md:26-32`;
`groupSend.ts:381`, `:412`, `:425`, `:548`; `rail-verify.ts:198`.

**Implies.** "Closes" is overstated. The issue should be updated in place with
what was and was not fixed, the way Sec 9 obliges for `relay-30003-retry-lineage`.

### 19. `fanout_attempt` ships to the browser, and Sec 8's framing implies it does not

**What is wrong.** `GET /api/conversations/:conversationId/messages` returns raw
`MessageItem`s: `app/src/routes/api.ts:2147` builds `page` from
`listByConversation` (`:2134`), the only transform is a preserving spread at
`:2162`, and it is returned at `:2165`/`:2171`. So the relay source message's new
top-level `fanout_attempt` is on the wire. Sec 8's risk item frames the
slot-vs-top-level choice as keeping the dashboard out of it ("A later change that
moves a field back into the slot re-opens `dashboard/src/api/types.ts`"), which
is only half the picture.

**Evidence.** Spec Sec 8; `app/src/routes/api.ts:2134`, `:2147`, `:2162`,
`:2165`, `:2171`.

**Implies.** Functionally harmless - `MessageItem` has an index signature
(`messagesRepo.ts:1016`), nothing enumerates keys, no snapshots. But it should be
an accepted decision recorded in the spec, not an accident, and it is a reader
the "enumerate every reader" pass missed.

---

## LOW

### 20. Citation drift on three claims the spec asks the builder to trust

`setRecipient` is `broadcastsRepo.ts:584-630` and its wholesale
`SET recipients.#ck = :rec` is at `:615`, outside the cited `:584-605`.
`setRecipientDelivery` is `messagesRepo.ts:2766-2790`; the cited `:2777-2785`
lands inside its comment. `attach` is `groupConversations.ts:545-570`, not
`:539-569`. The underlying claims are TRUE - I verified both wholesale writes -
but a document whose whole method is "check the line I cite" should have them
right.

### 21. Sec 4.1 understates the address skip

`buildParticipantMap`'s guard (`groupRail.ts:227`) skips on `undefined` OR
empty, and the projected business-number participant carries only
`projectedAddress` with no `address` (`groupConversations.ts:8-11`, `:468`), so
it is skipped on EVERY rail by design. "Skips any participant whose `address` is
empty" reads as an anomaly; a short map is partly the normal state.

### 22. Unconditional whole-item seed Puts would erase the counter

`app/src/lib/seed/index.ts:153`, `app/src/lib/seed/live.ts:462` and `:562`, and
`app/src/lib/performanceSeed.ts:208` are unconditional whole-item Puts over the
messages/broadcasts tables. Nominal - they run against a reset world - but Sec
3.2's "No backfill, no migration, no exception handling" is a completeness claim
and should name them. (I checked every other write path: no read-modify-write
reconstructs either item; the only real message-item Put is the
`attribute_not_exists`-guarded create in `append`, `messagesRepo.ts:1995-2001`.)

### 23. The claim's `ADD` is not idempotent under an SDK-level retry

AWS SDK v3 retries `UpdateCommand` on transient errors, and `ADD` is not
idempotent, so one logical claim can consume two rungs. Pre-existing pattern
(`bumpStats`, `broadcastsRepo.ts:632-673`), so not a redesign - but Sec 3.3
presents atomicity as settling the correctness question and this is the one hole
in it.

### 24. `ReturnValues: 'UPDATED_NEW'` does not return "a single number"

It returns `Attributes: { fanout_attempt: N }`. Sec 3.3's sentence is what a
builder implements against.

### 25. Sec 3.4's pseudo-code assumes the marker always runs

Both handlers SKIP the marker entirely when `jobId` is absent from context, with
a warn and a continue (`broadcastFanOut.ts:229-234`,
`relayFanOut.ts:350-354`). Immaterial to the ordering argument, but the
duplicate-cost analysis has a third case the spec does not enumerate.

### 26. The spec does not stand alone where it matters most

Sec 3.1, 3.4, 3.4a, 3.6 and 3.7 are written as rebuttals of "an earlier
revision" and point at `design-review/adjudications.md`, which a builder does not
have in front of them. That style is what produced finding 1: where the argument
and the instruction diverge, the reader has no way to tell which is current.
(Minor: the filed issue is stamped `created: 2026-09-01` against a spec dated
2026-08-31.)
