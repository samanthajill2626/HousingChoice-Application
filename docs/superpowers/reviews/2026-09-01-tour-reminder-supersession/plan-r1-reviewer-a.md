# Plan review R1 - reviewer A (adversarial, plan-only)

Date: 2026-09-01
Plan: `docs/superpowers/plans/2026-09-01-tour-reminder-supersession.md`
Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Method: read the plan and spec, then read every file and line they cite plus a
grep sweep of the app for unenumerated writers/readers. Prior-round reports were
NOT read before writing these findings. Every claim below cites a file:line I
opened; anything I could not confirm is marked UNVERIFIED.

Question answered: if a builder with NO context executes this plan LITERALLY, do
they produce the spec?

---

## 1. [BLOCKING] `superseded` is never added to `ScheduledSuppressionReason`, so S6 and acceptance 4 cannot be built

**What is wrong.** Spec 3.3 requires the three preview surfaces to render a
pointer-mismatched pending rung "as suppressed `superseded`", and acceptance 4
repeats it. "Suppressed" on all three surfaces means the wire field
`suppression: { reason }`, whose type is a CLOSED union:

- `app/src/services/scheduledSendSuppression.ts:9-12`:
  `export type ScheduledSuppressionReason = 'sms_sending_disabled' |
  'contact_opted_out' | 'manual_mode' | 'stale_stage' | 'quiet_hours' |
  'paused' | 'discontinued';`
- `:12` `export interface ScheduledSuppression { reason: ScheduledSuppressionReason; }`
- Dashboard mirror: `dashboard/src/api/types.ts:1147-1157` (same seven tokens).

The only type task in the whole plan is **T5.1**, which adds `superseded` to
`ReminderSkipReason` in `tourRemindersRepo.ts`. That is a DIFFERENT union
(`app/src/repos/tourRemindersRepo.ts:38-92`) - the stamp the poll writes on a
retired row. **No task anywhere widens `ScheduledSuppressionReason`.**

S6 (T6.1-T6.3) says each surface "renders a pointer-mismatched pending rung as
suppressed `superseded`" and stops there. A builder executing literally hits a
type error at the first `{ reason: 'superseded' }` and has to invent the type
change, the precedence position inside `evaluateScheduledSendSuppression`
(`:38-70`, an ordered ladder whose ordering is argued line by line), and the
lead phrase.

**What it implies.** The single most likely wrong turn is to reuse the token the
plan DID give them - `skipReason: 'superseded'` - on a row with no `skippedAt`.
That renders as `state: 'upcoming'` (`routes/tourReminders.ts:166-171`) carrying
a skipReason, which `RemindersPanel.tsx:123` will label while the row still
shows a live **Send now** button (`:396`). That is the exact "live button that
force-sends a superseded reminder" spec 3.3 exists to close.

---

## 2. [BLOCKING] "The in-memory fake needs no change" is false three ways, and its `create` will silently drop `ladderId`

**What is wrong.** The plan states this twice as a hard instruction:

- T1.3: "Leave the fake exactly as it is; **it needs no change in this whole plan**."
- Watch items: "**The in-memory fake needs no change** and must not be 'fixed'."

That is correct ONLY about the claim guards. The fake at
`app/test/helpers/twilioWebhookHarness.ts:2930` is typed
`const tourRemindersRepo: TourRemindersRepo` and must change three times:

1. **`create` drops `ladderId` silently.** `:2931-2953` hand-builds the item
   field by field. T1.1 adds `ladderId` as an OPTIONAL input, so an ignored
   input is not a type error. Every fake-backed suite would then arm rows with
   no `ladderId` onto tours that S3 gives a pointer - a mismatch on every row,
   refused by T5.3 and sorted into `earlier[]` by T7.1.
   The file itself carries the scar tissue for exactly this mistake, at
   `:2939-2946`: "This fake used to drop input.skipped on the floor, which made
   every arm-time skip look like a live rung to route-level suites."
2. **`deleteSupersededForTour` must be added.** T1.4 widens
   `TourRemindersRepo` (`app/src/repos/tourRemindersRepo.ts:123-184`), so the
   fake fails typecheck without it - and S8/S9's behaviour is unobservable in
   every fake-backed suite until it exists.
3. **`cancelForTour` must be removed.** T9.2 deletes it from the interface; the
   fake implements it at `:3011`.

**What it implies.** (1) is the dangerous one: it is not typecheck-forced, and
its symptom (mass suite failure with `superseded` everywhere) reads as a bug in
T5.3 rather than in the double. The plan's own watch item actively instructs the
builder not to look there.

---

## 3. [BLOCKING] T3.3's conditional pointer write has no repo capability, and no task creates one

**What is wrong.** T3.3: "the step-4 write is CONDITIONAL on `currentLadderId`
still equalling the rotation value from T3.2." Spec 3.2 step 4 says the same and
makes it the guard against two concurrent reschedules (acceptance 8).

`ToursRepo` has no such API. `patch` (`app/src/repos/toursRepo.ts:319-361`)
writes with `ConditionExpression: 'attribute_exists(tourId)'` (`:354`) and takes
no caller condition. The value-guarded precedent exists but only as two
purpose-built methods - `releaseGroupThreadClaim` (`:380-405`, `'#gt = :v'`) and
`releaseConversionClaim` (`:421-446`, `'#cp = :v'`).

S1 is titled "Repo foundations" and contains T1.1-T1.4. **None of them adds a
value-conditional tour write.** T1.2 adds only the `currentLadderId` field to
`TourItem`. T3.3 is written as a route-level TDD step ("simulate two interleaved
reschedules"), so nothing tells the builder a repo method is owed, nor that the
fake needs the same guard for the RED test to be meaningful.

**What it implies.** The obvious improvisation is a read-then-write check in the
route, which is the same TOCTOU the condition exists to close - and the same
class of error R1 warns about on the DELETE ("never a read-then-delete check").
It would pass T3.3's own test if the test drives the interleave with awaits,
which is precisely how a "simulate two interleaved reschedules" test gets
written. Untestable-step and missing-task at once.

---

## 4. [HIGH] T5.2's copy-surface census is wrong: two of the three "typecheck will catch" surfaces cannot be forced, and a fourth forced map is missing

The plan flags T5.2 as the one place where "green is not evidence", then gets
the census wrong in both directions.

**Claimed forced, actually unforceable by any change the plan names:**

- **"the placement-nudge card's reason map"** -
  `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:48`:
  `const NUDGE_SKIP_REASON_LABELS: Readonly<Record<NudgeSkipReason, string>>`.
  `NudgeSkipReason` is the PLACEMENT NUDGE union
  (`app/src/repos/placementNudgesRepo.ts:39`, mirrored at
  `dashboard/src/api/types.ts:1535`) - `placement_missing`, `stage_moved`,
  `unknown_kind`, `unit_missing`, `no_landlord`, ... It shares no token with
  `ReminderSkipReason` and can never be forced by adding one. `superseded` does
  not belong in it.
- **"`ScheduledCard`'s `SUPPRESSION_COPY`"** -
  `dashboard/src/routes/contact/ScheduledCard.tsx:19-21`:
  `Record<NonNullable<TimelineScheduled['suppression']>['reason'], string>`,
  i.e. keyed on `ScheduledSuppressionReason`, not on any skip-reason union. It
  is forced only by finding 1 above, which no task performs.

**Claimed forced, actually forced only at one remove:**

- `REMINDER_SKIP_REASON_LABELS` (`dashboard/src/api/types.ts:1301-1303`) is
  `Record<NonNullable<TourReminderView['skipReason']>, string>` over the
  DASHBOARD's hand-mirrored union (`:1223-1246`). T5.1's app-side addition
  forces nothing here. It becomes forced only after the builder widens the
  mirror - which the plan correctly calls an UNFORCED surface. So on a literal
  execution where the mirror is forgotten, **all five surfaces compile green**,
  not two.

**Forced and entirely missing from the plan:**

- `NUDGE_SUPPRESSION_LABELS`
  (`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64`),
  `Record<ScheduledSuppressionReason, string>` - a FOURTH exhaustive map that
  WILL break the moment finding 1 is done correctly, on a placement surface
  where `superseded` can never apply. Its `discontinued` entry (`:73-79`) is the
  in-repo precedent for the "compile completeness only" comment this new entry
  needs.
- `suppressionLead` (`dashboard/src/api/types.ts:1182-1187`) is an if-chain with
  a `return 'Will be skipped'` default. A new token compiles green and silently
  reads "Will be skipped - ...". That is a THIRD unforced surface the plan's
  "two not" count omits, and it is the sentence a navigator actually reads.

**What it implies.** The one task the plan singles out as needing manual
vigilance points the builder's vigilance at the wrong files.

---

## 5. [HIGH] There is a SIXTH scroll writer - the pill's own click handler - and T10.5 does not list it

**What is wrong.** T10.5 says "convert ALL FIVE scroll writers" and warns
"Converting only the growth pin is the single most likely way to get this
wrong." Its table lists `:1911`, `:1890`, `:1976`, `:1853`, `:1900`. Grep of
every scroll write in the file:

```
dashboard/src/routes/contact/Timeline.tsx
1843:    el.scrollTop = el.scrollHeight;        <- scrollToBottom (NOT LISTED)
1844:    atBottomRef.current = true;            <- (NOT LISTED)
1890:    el.scrollTop = el.scrollHeight;        <- conversation-switch reset
1900:    el.scrollTop += el.scrollHeight - anchor;  <- prepend restore
1912:    el.scrollTop = el.scrollHeight;        <- growth pin
```

`scrollToBottom` is defined at `:1840-1845` and is the "New messages" pill's
`onClick` at `:2094`. It both jumps to `scrollHeight` and writes the very
`atBottomRef` the spec says is REPLACED by the three-valued anchor.

**What it implies.** Left unconverted, clicking the pill scrolls PAST the last
message onto the Upcoming block - the exact failure acceptance 13/14 forbid - on
the one control whose entire purpose is "take me to the newest message". It also
strands a write to a ref the rest of the refactor has retired, so the anchor and
the ref disagree from the next scroll event onward. Spec 3.6 enumerates the same
five, so the plan inherited the hole; the plan is where it had to be caught.

---

## 6. [HIGH] T5.4's conversion deferral is unbounded and its predicate is undefined - both against this file's own established pattern

**What is wrong.** T5.4: "A rung whose tour carries a conversion claim sentinel
is left unclaimed with NO stamp, and retried next tick." Two gaps.

**(a) No bound.** Every other "leave unclaimed" branch in `processReminderRow`
is time-bounded, and the code says why in as many words:

- `app/src/jobs/tourReminders.ts:1193-1198`: "'unavailable' is not always
  transient: a pointer at a conversation that no longer exists (or a
  provisioning sentinel a crash left behind) never resolves, and an unbounded
  wait means this rung re-lists every tick FOREVER - never sent, never visibly
  skipped, nothing on the panel to say why." Bounded by `rosterWaitExpired`
  (`:1199`), retiring as `roster_unavailable`.
- `:1253-1265`: the identical bound for `names_unavailable`.

The conversion sentinel is `convertedPlacementId = 'pending:<uuid>'`
(`routes/placements.ts:699-701`). It has **no TTL and no recovery route**: a
crash between `claimConversion` (`:701`) and finalize (`:758`) leaves it
permanently, and the fast-path at `:669` (`typeof tour['convertedPlacementId']
=== 'string'`) makes every retry 409 `tour_already_converted`. Spec 3.2 asserts
"The deferral is bounded - the claim either finalizes ... or is released ... so
nothing re-lists forever." That is true only if the process never dies. The plan
adds no grace window and no test for a stuck sentinel.

**(b) No predicate.** "carries a conversion claim sentinel" is not defined. The
nearest in-repo model is `:669`'s `typeof ... === 'string'`, which deliberately
matches BOTH the sentinel and a finalized placement id. Copying it makes every
CONVERTED tour defer forever. Distinguishing them requires the
`pending:` prefix, which the plan never states.

**What it implies.** A new permanent-relist path in the exact job whose comments
document that failure mode twice, with no gate, no token, and no test. Even if
the practical exposure is small (a convertible tour has passed through `toured`,
whose terminal branch rotates and sweeps), the predicate ambiguity alone decides
between "defers forever" and "sends a reminder for a converted tour", and the
plan picks neither.

---

## 7. [HIGH] Acceptance 16 - the pill regression, including the relay-group path - has no task

**What is wrong.** Acceptance 16: "The pill still appears on an inbound message
while scrolled up and dismisses on scroll to bottom, in a contact thread AND in
a relay-group thread through `ConversationDetail` (`GroupTextView` passes
`upcoming={[]}` and cannot exercise it)."

This is the regression guard for the riskiest refactor in the plan - replacing
`atBottomRef` (one boolean gating both pin and pill, `Timeline.tsx:1830`,
`:1911`, `:1914`) with a three-valued anchor. T10.7's e2e list covers
acceptances 13/14/15 only: "at rest the stream shows more messages than `main`
and no block; scroll down reveals it; scroll up removes it; an operator standing
on the block is not yanked and gets no pill when a message arrives; opening a
thread lands on the newest message." Nothing about the pill APPEARING, nothing
about dismissal, nothing about a relay-group thread.

Confirmed the render sites: `upcoming` is passed at `ContactCommsPane.tsx:322`,
`ConversationDetail.tsx:483`, `GroupTextView.tsx:451` (`[]`),
`PlacementConversation.tsx:323`, `TourConversation.tsx:470`.

**What it implies.** The one acceptance written to catch "you broke the pill
while rewiring its flag" is delivered by no task, and S11 (which re-points
`Timeline.test.tsx:1375-1481`, `describe('Timeline stick-to-bottom')` at
`:1374`) is a re-point instruction, not a coverage instruction.

---

## 8. [HIGH] T6.1 and T7.1/T7.4 contradict each other: after the partition, the panel's `superseded` annotation has no rows left to annotate

**What is wrong.** T6.1 makes `routes/tourReminders.ts`'s GET render a
pointer-mismatched pending rung as suppressed `superseded`. T7.1, one slice
later, partitions that same GET: CURRENT (pointer match) into `reminders[]`,
"everything else" into `earlier[]`. A pointer-mismatched rung is by definition
"everything else", so after T7.1 **no row in `reminders[]` can ever carry the
`superseded` annotation T6.1 added.**

The plan never says whether `earlier[]` views carry `suppression` at all.
T7.4's action table (`sent`/`upcoming`/`canceled`/`skipped` -> actions) says
nothing about the chip, and it explicitly forbids reusing the current-ladder
renderer - which is where the chip lives (`RemindersPanel.tsx:355-362`).

**What it implies.** Executed literally, T6.1's work is dead on arrival and the
panel half of acceptance 4 ("all three preview surfaces render it suppressed
`superseded`") fails: the earlier disclosure shows a bare `upcoming` row with a
Cancel button and no explanation of why it is there. The reconciliation is
one sentence of specification the plan does not contain.

---

## 9. [MEDIUM] T5.3 does not say WHERE in `processReminderRow` the pointer check goes, in a function whose own comment says position is behaviour

**What is wrong.** T5.3 gives the rule but not the insertion point.
`processReminderRow` opens with `app/src/jobs/tourReminders.ts:1034-1048`:
"PAST-TOUR GATE (Phase B 6.1a) - FIRST, above supersededInBatch and above the
quiet-hours backstop. **POSITION IS BEHAVIOUR here**", followed by two worked
examples of what each wrong position produces.

The four candidate positions produce four different outcomes for one superseded
rung:

- below `tour_missing` / `retiredByTourStart` (`:1049-1065`) -> a superseded
  rung on a started tour reads `tour_already_passed`;
- below `supersededInBatch` (`:1085-1099`) -> reads `quiet_hours_superseded`,
  the wrong one of two same-named concepts;
- below the quiet-hours backstop (`:1116-1122`) -> a superseded rung due inside
  the window returns UNCLAIMED and re-lists every tick until quiet-end instead
  of retiring once - the exact defect `:1041-1042` names;
- below target resolution -> pays four reads to retire a row nothing will send.

**What it implies.** Acceptance 4 asserts the rung is "claim-skipped
`superseded`" and will pass or fail on a coin flip the plan leaves to the
builder, in a function that documents that this is not a matter of taste.

---

## 10. [MEDIUM] S11's list of old-contract tests is closed and incomplete

**What is wrong.** S11 lists three files plus "four e2e sites". The four e2e
sites check out (`e2e/scenarios/steps.ts:3595`, `:3677`,
`e2e/tests/dashboard-next/placements-page.spec.ts:205`,
`e2e/tests/dashboard-next/tour-comms-pane.spec.ts:226`). The three named files
check out too. But R3 ("any test asserting a canceled row survives a reschedule
encodes the OLD contract") has more victims that no task names:

- `app/test/tourReminders.test.ts:49` imports `cancelTourReminders`, which T9.2
  DELETES; `:1371` is titled "cancelTourReminders marks all pending rows
  canceled"; further asserting call sites at `:1339`, `:1396`, `:1753`, `:1890`.
- `app/test/toursApi.test.ts:1229-1240`: the `pendingRows` helper's comment
  states the dying contract outright - "cancelForTour deliberately leaves
  skipped rows alone (they are already terminal), so a cancel can never drive
  their count to zero" - and `skippedByKind` (`:1246+`) asserts arm-time skipped
  rows PERSIST, which the sweep now deletes.
- `app/test/placementConvert.test.ts:78-79`: "Two pending reminder rows for the
  tour (to prove cancel-on-convert)" - the assertion S8 inverts.
- `app/test/relayApi.test.ts:1454` and ~20 sites in
  `app/test/tourReminders.test.ts` destructure `armTourReminders`' return as an
  array, which T2.3 changes. (These ARE typecheck-caught:
  `app/package.json:13` runs `tsc -p tsconfig.test.json`. Good - but the plan
  should say so rather than leave a builder to discover a wall of errors.)

**What it implies.** A closed list read as exhaustive turns a predictable
re-point into a mid-slice surprise, and `app/test/toursApi.test.ts`'s skipped-row
assertions are the ones most likely to be "fixed" by weakening the assertion
rather than re-pointing it.

---

## 11. [MEDIUM] The sentinel is placed before a CONDITIONALLY RENDERED block, and no task defines the anchor when there is no block

**What is wrong.** T10.4: "a sentinel element after the last cluster, before the
Upcoming section." The Upcoming section is conditional:
`Timeline.tsx:2102` `{upcoming && upcoming.length > 0 ? (`. So "before the
Upcoming section" describes a position that does not exist most of the time -
and never exists for `GroupTextView`, which passes `upcoming={[]}`
(`GroupTextView.tsx:451`).

The whole of T10.3/T10.5 derives every anchor value from "the sentinel's
bottom". Nothing states that the sentinel is rendered unconditionally, and
nothing gives the anchor's value when the sentinel is absent. The natural
degradation of a missing element through the T10.3 table is `null` (the "cannot
measure" case), and `null` is defined as "the pin never fires" - which would
silently disable auto-scroll on every thread with no upcoming messages, i.e.
most threads and all group threads.

**What it implies.** Acceptance 16's relay-group half and acceptance 13's
"opening a conversation lands on the newest MESSAGE" both run on threads with no
block. One sentence ("the sentinel renders unconditionally, outside the
`upcoming &&` guard") closes it; the plan does not contain it.

---

## 12. [MEDIUM] R4's interruption posture and the CREATE-path pointer-write failure have no task

**What is wrong.** Spec 3.2 "Interruption posture" is explicit: "A failure at
step 3 or 4 leaves a live `scheduled` tour whose pointer matches nothing -
disarmed, not merely unsent. ... **It must be logged at error with the tourId.**"
R4 repeats it ("a real state needing a loud log").

The plan delivers only the CONCURRENCY half: T3.3's "the loser logged at error".
No task covers a step-3 (arm throws) or step-4 (write throws) failure, its log,
or a test for it. Note that today's arm at `routes/tours.ts:1191` is unguarded -
a throw there becomes a 500 after the patch has already landed - so the
disarmed-with-no-log state is reachable on `main`'s own error path.

The CREATE path has the same unanswered question and is worse. T3.1 tests only
the happy 201. If the pointer write after `armTourReminders` (`tours.ts:350`)
fails, the tour has STAMPED rows and NO pointer - which is NOT the pre-migration
exemption T5.3 defines ("a rung with NO `ladderId` on a tour with NO pointer
attribute"), so the entire freshly created ladder is silently refused from birth
with a 201 returned to the operator. Spec 3.5's "ABSENT means pre-migration,
permanently and only" is violated by this one path, and no task addresses it.

---

## 13. [MEDIUM] R6 demands hand QA on a phone viewport and the plan schedules none

**What is wrong.** R6: "Passes unit tests, fails in the hand. **Live QA on a
phone viewport is required**, and the three-anchor model across all five scroll
writers is the part to drive by hand first." T10.7 is an e2e task ("In a real
browser at 390px"), and the Gates section is the standard five. There is no
task, gate, or checklist item for the hand pass the risk names as required.

**What it implies.** The one risk in the spec that explicitly says automation is
insufficient is answered only with automation - and it is the risk attached to
the slice (S10) the plan itself calls "independent of all of it", i.e. the one
most likely to be handed to a parallel builder who never reads section 7.

---

## 14. [LOW] "Mirrors `cancelForTour`'s shape" invites copying the one filter that would defeat D1

**What is wrong.** T1.4: "`deleteSupersededForTour(tourId)`. Mirrors
`cancelForTour`'s shape (`listByTour`, then `Promise.allSettled` over the rows)".
`cancelForTour`'s shape includes a filter that is the OPPOSITE of what D1 wants:
`app/src/repos/tourRemindersRepo.ts:412-414` narrows to `pending` -
`sentAt === undefined && canceledAt === undefined && skippedAt === undefined`.
D1 requires deleting "pending, operator-canceled and skipped alike".

T1.4's own test list catches it ("an operator-canceled row goes; a skipped row
goes"), so this is caught if the tests are written first. Worth one clause
anyway: "mirrors the shape but NOT the `pending` filter - the sweep's only
exclusion is `sentAt`, enforced on the DELETE condition."

Related, same task: `cancelForTour` also swallows unexpected (non-CCFE) errors
at `log.error` without rethrowing (`:445-447`). T1.4 says only "A lost condition
logs at debug and does not reject the batch" and is silent on the non-CCFE case,
which for a DELETE means silent partial supersession.

---

## 15. [LOW] Two small surface omissions: `seed/cast.ts`'s raw reminder rows, and the block's own box model inside `.stream`

**(a) `cast.ts`.** Spec section 4 names `lib/seed/live.ts` and
`lib/seed/matrix.ts` as the seed writers. There is a third:
`app/src/lib/seed/cast.ts:780-808` writes three RAW reminder rows for
`TOUR_TOURED` (`reminderId` builder at `:67`, collected at `:1513`). All three
carry `sentAt`, and the owning tour gets no pointer, so under spec 3.4 they read
as pre-migration/CURRENT and nothing breaks - which is why this is LOW. T4.3's
catch-all ("Sweep the other builders under `app/src/lib/seed/`") does reach it,
but with no named file, no RED test, and no acceptance criterion, whereas
`live.ts` gets acceptance 17. Also worth noting for whoever reads section 4:
`cast`/`matrix`/`live` are all FULL-profile only (`app/src/lib/seed/index.ts:125-166`);
the `lean` e2e world seeds no reminder rows at all.

**(b) The block's box model.** T10.2 says drop `max-height`, `overflow-y` and
`flex` and the mobile override. Verified: `.upcoming` at
`Timeline.module.css:644-654` (`flex: none`, `max-height: 12rem`,
`overflow-y: auto`) and `:661-667` (the `767.98px` override with
`min-height: 2.5rem; max-height: 7rem`). Note there is a SECOND
`@media (max-width: 767.98px)` block at `:156-159` on `.stream` itself
(`min-height: 4rem`) which must NOT be dropped - T10.2 says "the
`@media (max-width: 767.98px)` override" without saying which.
Separately, `.stream` carries `padding: var(--sp-3)` and `gap: var(--sp-2)`
(`:143-147`), so the block moved inside it becomes inset rather than a
full-bleed divider across the pane, and inherits a gap above and below. That is
a visible change T10.2 does not mention and no acceptance criterion pins.

---

## Verified-good (recorded so a later reviewer does not re-derive it)

- T1.3's RED claim is real. `claimSend`'s conditions are all
  `attribute_not_exists` (`tourRemindersRepo.ts:291-292`); `claimSkip` `:328-329`;
  `cancel` `:360-361`. Against a missing item every one holds, so `UpdateItem`
  creates a stub. `uncancel` (`:390-391`) already requires
  `attribute_exists(canceledAt)` - correctly excluded. The precedent cited,
  `app/scripts/retire-paused-tour-reminders.ts:205-207`, is UNVERIFIED (not
  opened).
- The in-memory fake DOES return `false` on a missing row
  (`twilioWebhookHarness.ts:2971-2974`), so T1.3's "cannot live in the fake" is
  correct.
- `toursRepo.patch` maps explicit `null` to REMOVE
  (`toursRepo.ts:331-334`) - T1.2's NOTE and D3's whole argument stand.
- T3.1/T3.5's stale-response claims are real: CREATE returns the pre-arm tour
  (`tours.ts:338` create, `:350` arm, `:369` respond); PATCH captures at `:1164`
  and responds at `:1284`.
- "FIVE sites in `routes/tourReminders.ts`" for `listByTour` is exact: `:383`,
  `:395`, `:447`, `:462`, `:499`. The two `.find(...)!` at `:395` and `:462` are
  real, and `scheduled.updated` is emitted at `:416` as T7.6 says.
- `RemindersPanel.tsx` line references are accurate: empty short-circuit ~`:345`,
  Send now gate `:396`, Cancel/Restore gate `:410`.
- `GroupTextView.tsx:451` really does pass a fresh `[]` literal - T10.6's
  dep-array warning is correct.
- `.stream`'s `overflow-anchor: none` is at `Timeline.module.css:142` as cited,
  with a long comment forbidding its removal without removing the manual
  correction.
- `armTourReminders` has exactly two route call sites (`tours.ts:350`, `:1191`)
  and three seed call sites (`live.ts:514`, `:528`, `:538`).
  `app/src/routes/api.ts:912` is a comment, not a call.
- Test files ARE typechecked (`app/package.json:13` runs `tsconfig.test.json`),
  so S2's return-shape change is caught by gate 1 across the suites.
</content>
</invoke>
