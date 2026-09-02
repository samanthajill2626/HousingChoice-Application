# Plan review - round 1, reviewer B (adversarial, plan-only)

Plan: `docs/superpowers/plans/2026-09-01-tour-reminder-supersession.md`
Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Method: every claim below was checked against the working tree at
`W:/tmp/tour-reminder-supersession`; citations are file:line I read. Prior-round
reports were NOT read before writing this.

Verified true before the findings (so nobody re-litigates them): the T1.3 RED
premise holds (`claimSend`/`claimSkip`/`cancel` conditions are all
`attribute_not_exists`, `tourRemindersRepo.ts:291-292`, `:328-329`, `:360-361`;
DynamoDB UpdateItem creates the missing item, so the stub-resurrection defect is
real); the fake's post-guard behavior holds (`twilioWebhookHarness.ts:2971-2974`
returns false on a missing row); the stale-201/stale-PATCH-response premises
hold (`routes/tours.ts:338-369` returns the pre-arm tour; `:1164` captures,
`:1284` returns); `toursRepo.patch` maps null to REMOVE (`toursRepo.ts:333-334`);
the two non-null assertions exist (`routes/tourReminders.ts:395`, `:462`) and the
emit is at `:416`; the empty-ladder short-circuit is `RemindersPanel.tsx:346-347`
and the action lines are `:397`, `:408`; `ARM_NOW` is `toursApi.test.ts:1228`;
the five `listByTour` sites in `routes/tourReminders.ts` are `:383`, `:395`,
`:447`, `:462`, `:499`; the other readers are `contactTimeline.ts:981`,
`relayGroups.ts:226`, `jobs/tourReminders.ts:1618`; the poll already carries
`toursRepo` (`jobs/tourReminders.ts:613`); `GroupTextView.tsx:451` passes a
fresh `upcoming={[]}` literal; the four e2e sites resolving the Upcoming region
by role+name are `steps.ts:3595`, `steps.ts:3677`,
`placements-page.spec.ts:205`, `tour-comms-pane.spec.ts:226`; the S11 test
citations (`scheduled-visibility.spec.ts:268`, `steps.ts:3615-3661`,
`Timeline.test.tsx:1375-1481`) all resolve; `cancelTourReminders` has exactly
the three call sites T9.2 expects (`tours.ts:1190`, `:1208`,
`placements.ts:716`).

---

## F1 (BLOCKING) - The in-memory fake MUST change, and the plan twice orders the builder not to change it

`app/test/helpers/twilioWebhookHarness.ts:2930` declares the fake with an
explicit annotation: `const tourRemindersRepo: TourRemindersRepo = { ... }`.

- T1.4 adds `deleteSupersededForTour` to the `TourRemindersRepo` interface. The
  moment the interface grows, the fake's object literal is missing a required
  member and **S1's own gate (`npm run typecheck`) fails**.
- T9.2 deletes `cancelForTour` from the interface. The fake implements it at
  `:3011`; an object literal assigned to an annotated type gets an
  excess-property error, so **S9 breaks the fake a second time**.

Against that, the plan says - twice, in T1.3 and again in Watch items - "Leave
the fake exactly as it is; it needs no change in this whole plan" / "must not be
'fixed'". A literal builder hits an impossible instruction at the very first
gate. The dangerous resolution is the likely one: a builder who has been told
the fake is sacrosanct will widen a type or cast to get past typecheck, or -
worse - will implement the fake's `deleteSupersededForTour` in a hurry WITHOUT
the `sentAt` guard, which re-injects into the double exactly the class of bug
T1.4's real tests exist to prevent. The plan must say: the fake gains
`deleteSupersededForTour` (mirroring the post-guard semantics: delete only rows
without `sentAt`, absent row is a no-op) and loses `cancelForTour` at S9; what
must NOT change is the fake's `claimSend/claimSkip/cancel` missing-row behavior.

## F2 (HIGH) - The conversion path deletes without any refusal backstop; a failed sweep permanently arms a converted tour, and the slice-safety claim is false at S8

The plan's headline guarantee: "Stopping between any two slices leaves a system
where every armed rung either sends correctly or is refused - never one that
deletes without refusing." Test it at S8, the first deleting slice:

- Conversion does not touch the pointer (spec, and T8.1), so a superseded rung
  on a converting tour still MATCHES `currentLadderId` - T5.3's refusal never
  fires for it. This is the one retirement path with no pointer-mismatch safety
  net; spec R5's comfort ("the pointer check lowers a missed row's consequence
  from 'sends' to 'appears in earlier'") is simply not true here.
- The deferral (T5.4) is keyed on the claim sentinel, and the finalize REPLACES
  the sentinel with the real placementId (`placements.ts:758`). From that
  instant until `deleteSupersededForTour` completes, the rungs are due-eligible,
  unclaimed, undeferred, unrefused - and the poll checks NO tour status
  (`jobs/tourReminders.ts:1049-1065`: only tour-missing and past-tour-start; a
  `closed` tour with a future `scheduledAt` sails through). A poll tick in that
  window sends "your tour is tomorrow" on a converted tour - the precise defect
  the current cancel-before-finalize ordering exists to prevent
  (`placements.ts:711-714` says so in words).
- Worse than the race: **T8.1 specifies nothing for a sweep FAILURE**. If
  `deleteSupersededForTour` throws after the finalize, the conversion is
  complete (a retry 409s `tour_already_converted` on the fast path at
  `placements.ts:669`), nothing ever sweeps again, nothing refuses, and the
  ladder fires rung by rung on a closed, converted tour. On `main` the
  equivalent failure releases the claim and rethrows - retryable
  (`placements.ts:715-720`). The plan trades a retryable failure for a
  permanent, silent one and does not even ask for a log.

Minimum plan fix: T8.1 gains an explicit failure posture (at least a loud
error log naming tourId + the orphaned rungs; better, a refusal predicate the
poll can apply to a tour whose `convertedPlacementId` is a non-sentinel string),
and T8.2 gains a third case: a rung coming due between finalize and sweep, and
after a failed sweep, does not send. If the spec's adjudications already
accepted this residue, the plan must at least SAY so and demand the log; today
it says nothing.

## F3 (HIGH) - The five-writer table for S10 is short one writer: the pill's own click handler

`Timeline.tsx:1840-1846` (`scrollToBottom`, wired to the "New messages" pill at
`:2094`) sets `el.scrollTop = el.scrollHeight` and `atBottomRef.current = true`.
It is a sixth scroll writer; T10.5's table ("convert ALL FIVE scroll writers")
does not contain it, and the plan explicitly warns the builder that converting
only the listed sites is "the single most likely way to get this wrong" - then
under-lists the sites. Post-move consequences of leaving it as-is:

- The button labeled "Jump to the newest messages" lands the viewport on the
  bottom of the UPCOMING BLOCK, not the newest message - and T10.2 removes the
  block's `max-height` (`Timeline.module.css:652`, `:665`), so a long upcoming
  list can push the newest message clean out of the viewport. That is D4's
  "at the bottom means the newest MESSAGE is at the bottom" violated by the one
  control whose entire purpose is that promise.
- It also writes `atBottomRef`, the flag T10.5 replaces - a literal builder
  converting exactly the five listed sites leaves either a dangling ref or a
  contradictory writer feeding the new anchor model.

The table needs a sixth row: pill click -> scroll the SENTINEL to the bottom
edge (and set anchor `sentinel`), not `scrollHeight`.

## F4 (HIGH) - `superseded` spans TWO unions; the plan enumerates the surfaces of one and mis-counts the forced/unforced split

The claim-skip half is `ReminderSkipReason` (T5.1, correct). But "all three
preview surfaces render it suppressed `superseded`" (S6) travels as
`suppression: { reason: ... }`, whose vocabulary is a DIFFERENT union:
`ScheduledSuppressionReason` (`app/src/services/scheduledSendSuppression.ts:9-12`,
mirrored at `dashboard/src/api/types.ts:1147-1157`). The plan never instructs
adding `superseded` to either copy of it, and the "five copy/type surfaces"
accounting inherits the confusion:

- Unenumerated FORCED surface: `REMINDER_SUPPRESSION_LABELS`
  (`dashboard/src/api/types.ts:1286-1298`, an exhaustive Record over the
  suppression union).
- Unenumerated UNFORCED surface: `suppressionLead`
  (`types.ts:1181-1186`) - an if-chain whose default hands `superseded` the
  lead "Will be skipped" silently. (Possibly the right copy - but it must be a
  decision, not a fallthrough.)
- Unenumerated hand-list guard tests that WILL fail or must be extended:
  `types.test.ts:98` (`SKIP_REASONS`, exact-set assertion at `:125`) and
  `types.test.ts:157` (`SUPPRESSION_REASONS`, exact-set at `:175`). S11 does
  not name this file.
- "The dashboard's hand-mirrored copy of the reason union" (singular, T5.2) is
  actually TWO mirrored unions: skipReason (`types.ts:1223-1247`) and
  suppression (`types.ts:1147`). Miss the suppression mirror and every render
  site falls through its `?? raw-token` fallback - `ScheduledCard.tsx:93`,
  `RemindersPanel.tsx:360`, `DeadlinesNudgesCard.tsx:262` - putting the
  snake_case token in front of staff, the exact silent failure T5.2 warns about
  on surfaces it did not list.

The plan should restate T5.2 as: two tokens (or one token in two unions), then
the full surface inventory per union with its forced/unforced status.

## F5 (MEDIUM) - S6 omits the pre-migration exemption; a literal build breaks acceptance 12 on the preview surfaces

T5.3 carefully exempts "a rung with NO ladderId on a tour with NO pointer
attribute" for the POLL and demands a test. T6.1-T6.3 say only "renders a
pointer-mismatched pending rung as suppressed" - by T7.1's definition a
no-ladderId row on a no-pointer tour is NOT a mismatch, but T7.1 lands a slice
LATER and the T6 tasks never restate the rule. A builder implementing S6
literally ("row.ladderId !== tour.currentLadderId is suppressed") marks every
legacy pending rung suppressed on all three surfaces, violating acceptance 12
("renders, and polls, exactly as on main"), and no S6 test asks for the exempt
case. Each T6 task needs the exemption named and one legacy-fixture test.

## F6 (MEDIUM) - Acceptance 16's relay-group half has no delivering task

Acceptance 16 requires the pill to appear and dismiss "in a contact thread and
in a relay-group thread through `ConversationDetail`". T10.7's e2e list is
contact-side only; S11's fourth bullet is about region re-resolution, not the
pill. `ConversationDetail.tsx:480` feeds real `upcoming` from `useRelayThread`
(`useRelayThread.ts:208`), so the relay surface genuinely exercises the moved
block plus the anchor. Nothing in the plan produces that assertion; a builder
executing literally ships acceptance 16 half-untested.

## F7 (MEDIUM) - T3.3's conditional pointer write: no repo API exists for it, and its only test runs against the in-memory fake

`toursRepo.patch` supports exactly one condition - `attribute_exists(tourId)`
(`toursRepo.ts:354`). The step-4 write needs a value-equality condition on
`currentLadderId`; the builder must design a new repo method (or extend patch)
with zero guidance, and must implement it twice (real repo + the harness's fake
toursRepo). The gate named for S3 is `app/test/toursApi.test.ts`, which runs on
`makeWebhookHarness` (in-memory; `toursApi.test.ts:1255`), so the actual
DynamoDB `ConditionExpression` - the load-bearing artifact - is never exercised
against DynamoDB Local anywhere in the plan. This is the same fake-vs-real gap
T1.3 lectures about, one slice later, unaddressed. Add a repo-layer DynamoDB
Local test for the conditional write (win and lose cases).

## F8 (MEDIUM) - T5.4 never names the sentinel, and the wrong predicate is the natural one to write

The conversion claim is `convertedPlacementId = 'pending:<uuid>'`
(`placements.ts:699`), and a FINALIZED tour holds a real placementId in the
SAME attribute (`placements.ts:758`) - `typeof string` matches both, as the
fast-path comment at `:665-668` says out loud. T5.4 says only "a rung whose
tour carries a conversion claim sentinel". A builder testing
`typeof tour.convertedPlacementId === 'string'` defers every rung of every
converted-and-finalized tour FOREVER (unclaimed, re-listed every tick). The
task must name the field and the `pending:` prefix. Separately: a conversion
that crashes between claim and release leaves the sentinel permanently (the
retry 409s at `:669-671`), so "retried next tick" is an unbounded silent loop -
the deferral needs at least a log line; the plan asks for none.

## F9 (MEDIUM) - T4.3's "stamp any you find" is half an instruction, and cast.ts is the unnamed half of the seed surface

Stamping a seed ROW without setting its tour's pointer makes the row
pointer-MISMATCHED - refused and grouped EARLIER - which is strictly worse than
leaving it unstamped (unstamped rows on pointerless tours ride the 3.5
exemption and behave as today). T4.3 says "stamp any you find" without the
pointer half. And there IS one to find: `lib/seed/cast.ts` writes raw reminder
ladders (`cast.ts:780` onward, e.g. the toured tour's three rows) - the
byte-stable e2e world - yet only live.ts and matrix.ts get named tasks. T4.3
must say "stamp the ladder AND set the tour's pointer, or deliberately leave
BOTH absent" and name cast.ts. Same gloss in T4.1: live.ts arms AFTER its tour
rows are written (`live.ts:499-514`), so "set `currentLadderId` inline" is
actually a second write/patch the task should acknowledge.

## F10 (MEDIUM) - T1.3's RED test calls a method that does not exist, and the obvious substitute silently weakens the assertion

The test script says `getById(reminderId) is still undefined`.
`TourRemindersRepo` has no `getById` (interface at `tourRemindersRepo.ts:123-184`;
`GetCommand` is imported at `:14` and never used). A builder reaching for
`listByTour` instead makes the stub-absence assertion VACUOUS on main: the stub
row created by the unguarded claim has no `tourId`, so the byTour GSI never
returns it and "absent via listByTour" passes even while the stub exists. The
RED state then rests on the boolean alone. The task must say: add a
test-supporting `getById` (or use a raw GetCommand against the table) so the
stub is actually observable.

## F11 (MEDIUM) - T10.7's first clause is untestable as written, and the viewport contradicts the harness's one-definition rule

"At rest the stream shows more messages than `main`" has no observable
pass/fail inside a single-branch e2e run - there is no main baseline in the
browser. The operational assertions are the other clauses (newest message
visible, Upcoming block `not.toBeInViewport()` at rest, visible after scrolling
down); the plan should state them so the builder does not invent a fake
comparison. Also: the plan asks for 390px while
`e2e/support/viewport.ts:22` declares `NARROW_360` (360x800) as "the ONE
definition" of phone width - use it or amend it, but do not mint a third width
silently. The rest of T10.7 IS assertable in this harness (setViewportSize
precedent at `steps.ts:2760`, fake-twilio inbound injection for the
mid-test message, `toBeInViewport` for block visibility) - the plan's push of
the anchor proof to e2e is sound.

## F12 (MEDIUM) - The spec's interruption-posture log and R6's live QA have no tasks

Spec 3.2: "A failure at step 3 or 4 ... must be logged at error with the
tourId." T3.3 logs the step-4 conditional LOSER; nothing tasks the step-3 (arm
throw) case, which today would surface only as a generic 500 with no
"this tour is now disarmed" record - and the spec explicitly says the next
patch does not necessarily repair it. Spec R6: "Live QA on a phone viewport is
required" - the plan has gates and e2e but no live-QA step anywhere. Both are
one-line additions; both are currently undelivered spec text.

## F13 (MEDIUM) - T10.6 under-specifies how the ResizeObserver feeds the effect

The observer "supplies" the re-pin signal, but if a builder wires it as its own
effect that re-pins directly, it bypasses the layout effect's in-flight
prepend-anchor re-baselining (`Timeline.tsx:1905-1909`) and the pill logic,
re-splitting the writers T10.5 just unified. The task should say: the observer
bumps a state/key that is a dep of the ONE layout effect, so every growth path
runs the same decision.

## F14 (LOW) - Line-number drift in the T10.5 table

The growth pin's write is `:1912` (the `if` is `:1911`); the "post-send pin
:1976" is not a scroll write at all but `atBottomRef.current = true`
(`Timeline.tsx:1976`) whose effect is delivered by the growth-pin effect on the
next commit. The dispositions are right; the labels will cost a cold builder a
few minutes of doubt.

## F15 (LOW) - The disclosure's default state is never specified

D2 is "sent rungs survive in storage, not in the default view". T7.3 tests that
the disclosure RENDERS; nothing says it renders COLLAPSED. An expanded-by-
default earlier[] satisfies every planned test and violates D2's sentence. One
word in T7.3 fixes it.

## F16 (LOW) - Seeded terminal tours will hold pointer-matching ladders, a state production can no longer produce

T4.2 sets the matrix pointer to the seeded ladder for every tour, including
terminal-status ones; post-change, the route rotates on terminal transitions,
so a real terminal tour's ladder is always EARLIER. The seed worlds will render
sent rows of terminal tours as CURRENT. Deliberate per the spec's seed section,
but the divergence is worth one comment line in the seed so a future e2e author
does not model product behavior off the seed world.

---

### Ordering claim, tested (summary)

S1 inert (guards + unused method): safe. S2 stamps with no reader: safe. S3
pointers with no refusal, old cancel path intact: superseded rows get
`canceledAt`, nothing fires: safe. S4 before S5 is correctly forced (live.ts
rows are stamped from S2 but unpointed - refusal would kill the demo world).
S5-S7 refuse/group with the old cancel path still stamping: safe. S8 is where
the claim breaks - see F2. S9 is safe given S1+S5. S10/S11 independent as
claimed. So the guarantee holds at every boundary except the one the plan
needed it for most: the first slice that deletes.
