# Adversarial plan review - tour reminder ladder (v2, reviewer A)

Plan: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md`
Spec: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`
Question answered: if a builder with NO context executes this LITERALLY, do they
produce the spec?

Mostly yes. The arithmetic is unusually good - I re-derived every timing value
the plan states (Task 6 Step 5, Task 7 Steps 1/4, seedLive TOUR-A/TOUR-B, cast.ts,
matrix.ts, devGating, toursApi 1411/1449) against the real fixtures and found no
wrong expected value. The surface enumeration is also good: I grepped
`composeTourReminderBody` (4 in `app/src` + the harness), every reminder-row
writer, every `skipReason` reader, every `tour.*` catalog reference, and every
test that composes a body - the plan names all of them.

What is wrong is concentrated in three places: the e2e timing-contract rework
(Task 9), the failure-path posture (Task 5), and a handful of tests that would
be green-but-vacuous.

---

## 1. [HIGH] Task 9 Step 4 silently guts what quiet-hours test (3) proves

`e2e/tests/scenarios/quiet-hours.spec.ts:20-27` states the reason
`windowAroundNow()` exists:

> The panel's suppression estimate is computed against the SERVER'S WALL CLOCK
> ... So the "Will wait" chip can only be produced by storing a REAL window that
> contains the wall clock - which is what windowAroundNow() does.

Test (3) (`quiet-hours.spec.ts:325-352`) is titled "Send now: a human send goes
out immediately, **even inside the quiet window**". Its whole content is: the
wall clock is inside a real stored window, and the force-send goes out anyway.

The plan replaces `windowAroundNow()` with a FIXED constant
`QUIET_AROUND_DAY_BEFORE = { start: '17:30', end: '21:30' }` and applies it to
test (3) too ("Test (3) 'Send now' (`:325+`): same window constant"). That
window is anchored to the RUNG, not the clock. At any wall clock outside
17:30-21:30 org-local - i.e. most of the day - the wall clock is NOT inside the
stored window, so the force-send has no quiet window to bypass and test (3)
becomes vacuous as a bypass proof. `forceSendReminder`
(`app/src/jobs/tourReminders.ts:1136-1152`) bypasses quiet hours unconditionally,
so nothing else catches the loss.

The plan then asserts "The contract's PROMISE - deterministic at any wall clock -
is unchanged; say so explicitly." That is false for test (3): the test becomes
deterministic *and meaningless*.

Test (3) never ticks and never needs the day_before dueAt inside the window, so
it can keep `windowAroundNow()` unchanged. The plan's blanket substitution is an
unforced regression. (Consequently the plan's "Delete `orgLocalHhMm` if nothing
else uses it" is also wrong.)

Test (2)'s panel assertions survive the change - `paused` outranks
`quiet_hours` (`routes/tourReminders.ts:481-489`) and the quietNow disjunct 1
(`dueAt > now && isQuietTime(dueAt, window)`, `:461`) is satisfied by the rung's
19:30 dueAt at any hour - so that half of the plan's reasoning is correct.

## 2. [HIGH] Nothing pins name resolution on the relay-group scheduled bucket - the one preview that carries `en_route_landlord_led`

Spec 6.3a: "Three hand-mirrored compose blocks now each need identical name
resolution and identical fallbacks. Any one of them drifting makes a PREVIEW
disagree with the SEND ... Extend that guard, or accept that three copies will
drift."

`names` is REQUIRED on `ComposeTourReminderInput`, so a builder cannot omit it -
but passing `names: {}` compiles and silently renders "Hey there," previews.
Coverage as planned:

- `routes/tourReminders.ts` - Task 5 case 6 (two `landlord_led` tours on
  different units render their OWN landlord's first name). Good.
- `routes/contactTimeline.ts` - Task 5 case 5, which the plan itself scopes:
  "this surface can prove the READ-COUNT half only". No name assertion.
- `routes/relayGroups.ts` - **nothing at all.** No new test; `relayApi.test.ts`
  asserts counts, order and `body: ''` containment (`:1469-1502`, `:1565-1579`)
  and never a positive body.

`routes/relayGroups.ts:216-218` serves ONLY non-`self_guided` tours - it is the
exact surface where a missing `propertyContactFirstName` flips the preview to
`tour.en_route_self_guided` while the group SEND
(`jobs/tourReminders.ts:992-1017`, which reads the unit and resolves names) sends
`tour.en_route_landlord_led`. That is the single highest-value instance of the
drift 6.3a names, and the plan leaves it untested.

Ask for one test in `relayApi.test.ts`: a `landlord_led` tour whose landlord has
a first name -> `GET /api/conversations/:id/scheduled` renders the `en_route`
card containing "<Landlord> will be headed that way".

## 3. [HIGH] Task 5 ships an UNBOUNDED re-list, which this codebase has already ruled unacceptable - and does not record the debt anywhere that outlives the plan

Task 5 Step 3 makes the poll `return` without claiming on
`ReminderNamesUnavailableError`, and the plan's own SPEC CONCERNS #2 accepts
that "a PERMANENTLY failing read re-lists each tick".

`app/src/repos/tourRemindersRepo.ts:56-64` states the opposite rule for the
directly analogous case:

> Inside that window the poll leaves the rung unclaimed and retries; past it the
> state is treated as permanent and the rung is retired VISIBLY - a rung that
> re-lists forever is never sent and never says so.

and `jobs/tourReminders.ts:796-810` implements the bound (`rosterWaitExpired` ->
`roster_unavailable`). The plan adopts the "quiet-backstop shape" while skipping
the grace bound the roster idiom added *specifically because* the unbounded shape
was wrong.

Two things make this worse than the plan's write-up suggests:

- In Phase A the branch is UNREACHABLE in production (the manual-only filter at
  `jobs/tourReminders.ts:470-471` drops every armed kind before
  `processReminderRow`), so the only thing exercising it is the dev tick with an
  empty manual-only set. The regression lands the day Phase B lifts the pause.
- Task 10 Step 5's Phase B ledger lists six items and this is not one of them.
  The acceptance lives only in the plan's SPEC CONCERNS section, which is not a
  registry entry and will not be read at unpause.

Either bound it (needs a reason-token ruling, which the plan is right that 8.2
does not grant) or file it. Do not leave it in a plan appendix.

## 4. [HIGH] `TourContactNames` cannot be imported from where the plan says, and the obvious fix is the one the plan forbids

Task 4 Step 11: `import type { TourContactNames } from '../../app/src/messages/tourCopy.js';`
Task 4's IMPORT LAYERING WARNING tells the composer to write
`import type { TourContactNames } from '../lib/tourContacts.js';`.

A type-only import is not a re-export. `messages/tourCopy.ts` will not export
`TourContactNames`, so the harness import fails to compile, and so does Task 4
Step 12's `TourContactNames` default parameter in `app/test/tourReminders.test.ts`
(whose import source the plan never states).

The plan never says to add `export type { TourContactNames } from '../lib/tourContacts.js';`
to `tourCopy.ts`. A builder hitting the error will reach for
`import { ... } from '../../app/src/lib/tourContacts.js'` - and
`app/src/lib/tourContacts.ts` value-imports `unitContacts` from
`repos/unitsRepo.js` (per the plan's own Step 3 source), which is exactly the
AWS-SDK drag the warning exists to prevent. State the re-export.

## 5. [MEDIUM] Task 7 case 8's negative half is vacuous as written

Plan: "Also assert the warn does NOT fire under `quietOffSettingsRepo()`
(isQuietTime gates on `enabled` - a disabled org with a stored 19:00 start must
not warn)."

`app/test/helpers/settingsStub.ts:32-34`: `quietOffSettingsRepo()` is
`stubSettingsRepo({ quietHoursEnabled: false })` - it keeps
`DEFAULT_ORG_SETTINGS.quietHoursStart` of `'21:00'`. 19:30 is outside
[21:00, 08:00) regardless of `enabled`, so the assertion passes whether or not
`isQuietTime`'s `enabled` guard exists. It proves nothing.

The parenthetical describes the right fixture; the code does not.
Use `stubSettingsRepo({ quietHoursEnabled: false, quietHoursStart: '19:00' })`.

## 6. [MEDIUM] The declared e2e red window (T6-T9) hides any e2e breakage Task 4 introduces

Global Constraints: "the e2e suite is expected RED from the end of Task 6
(retiming) until Task 9 closes it - do not run the full e2e gate between those
tasks".

Task 4 is the task that rewrites all the copy, changes the composer signature,
rewrites `REMINDER_BODY_MARKERS`, adds `tourType`/`names` to
`TourReminderContext`/`ActiveTour`, and threads two spec files. Its verification
is `npm run typecheck` (Step 14) and the app suite (Step 15). Neither can see a
harness/server body mismatch - `expectReminderTo1to1`
(`e2e/scenarios/steps.ts:1974-1976`) compares the SERVER's sent body against a
harness-composed string, and the two only agree if `tenantFirstName` is threaded
correctly at every `this.activeTour = ...` site.

By the plan's own schedule the next e2e run is Task 9 Step 6, after two more
tasks of churn, and any Task 4 breakage will present as indistinguishable from
the retiming red. Add an e2e run at the end of Task 4 (it should be green there
by the plan's own claim), or fold the red-window start back to Task 4 and say so.

## 7. [MEDIUM] Task 6 destroys the only coverage of the past-dueAt rule and does not replace it

`app/test/tourReminders.test.ts:437-463` (Test 1g) is titled "(a) a clamp that
still lands before `now` is dropped (past-dueAt rule)" and its entire mechanism
is a `day_before` whose clamped dueAt (Jan 19 13:00Z) is before `now`
(Jan 19 15:00Z). After the retime the raw is Jan 20 00:30Z - in the FUTURE - so
`:459`'s `toBeUndefined` inverts and the test no longer touches the branch at
`jobs/tourReminders.ts:266`.

The plan correctly derives the inversion but only asks for a comment
("Note in the test comment that the past-dueAt drop for day_before becomes
effectively unreachable"). The branch is NOT dead - a non-same-day `morning_of`,
a clamped `en_route`, or a `confirmation` can still hit it - it is simply
uncovered afterwards. Test 1f's preamble (`:396-398`) also cites Test 1g as the
place that interaction "is pinned", so the cross-reference goes stale too.

Re-point Test 1g at a rung that still reaches the branch, or add one.

## 8. [MEDIUM] The send path now defers on a unit-read failure even where the unit contributes nothing to the copy

Task 5 Step 3: `if (unitReadFailed || resolved.failed) throw new ReminderNamesUnavailableError(...)`.

Today `composeBodyForRow` (`jobs/tourReminders.ts:539-548`) degrades a failed unit
read to "no address" and SENDS. After Task 5 a transient unit-read blip defers
the send - including for `day_before` (`Hey {tenantFirstName}, confirming your
tour tomorrow at {time}...`) and `en_route_self_guided`, whose copy contains no
address and no property-contact name, so the composed body would have been
byte-identical either way.

Spec 6.3b's "SEND paths leave the rung UNCLAIMED on a read failure" does not
distinguish, so this is a defensible reading - but it is a behaviour change the
plan buries in a parenthetical ("re-derive any test that pinned 'unit read
failed - composing without an address' on a SEND path"). Fold the unit-read
failure in only when the tour type or the rung actually needs the property
contact, or state the widening as a deliberate choice in the handback.

## 9. [MEDIUM] `ActiveTour.propertyContactFirstName` is a contract with no way to satisfy it

Task 4 Step 11 adds `propertyContactFirstName?: string` to `ActiveTour` and adds
a docblock saying "a spec that ever asserts an exact `en_route`-landlord-led body
must set `propertyContactFirstName` on the active tour first". There is exactly
one assignment site (`e2e/scenarios/steps.ts:1720`,
`this.activeTour = { tourId, addressLine1: unit.addressLine1 }`), the field is
`private` (`:357`), and the plan adds no setter, no verb, and no wiring from
`seedAvailableUnit`'s landlord.

No current spec asserts a landlord-led `en_route` body (`tours.spec.ts:131-135`
asserts `confirmation` and `day_before` in-group only; `:241` is `en_route` on a
`self_guided` 1:1), so nothing breaks today. But the docblock instructs
something the code cannot do, which is worse than saying nothing. Either add the
setter or write the docblock as "this is not supported; see
`tour-reminder-zero-primary-e2e-gap`".

## 10. [MEDIUM] SPEC CONCERNS #1 is resolved correctly but creates a preview/send disagreement the plan never names

The plan is right that 6.3a's "(absence fallbacks, never a different ENTRY)"
contradicts 6.3's own property-contact fallback (which IS a different entry), and
right to take the 6.3b reading (read paths must not throw and must not 500).

But the combination it ships is: on a failed property-contact read, the PREVIEW
renders `tour.en_route_self_guided` while the SEND raises
`ReminderNamesUnavailableError` and refuses/defers. The panel therefore shows a
body that will never be sent, next to a rung that is stuck. That is a NEW
preview/send divergence introduced by splitting failure and absence differently
on the two sides, and it is exactly the class of thing
`tourCopyCallSites.test.ts` was written to prevent
(`app/test/tourCopyCallSites.test.ts:1-8`). It is probably the right trade, but
it belongs in the handback, not discovered in the panel.

## 11. [LOW] Test 1c's row-count assertions are not enumerated in the re-derivation

`app/test/tourReminders.test.ts:322-323`:
`expect(rows).toHaveLength(4)` and
`expect(rows.filter((r) => r.skippedAt === undefined)).toHaveLength(2)`.

After Task 6, `confirmation` + `day_before` (Jan 20 00:30Z) + `morning_of`
(Jan 20 23:00Z) are all unskipped, so the second assertion becomes 3. The plan's
Task 6 Step 5 lists the new dueAts and says "RETITLE the test" but never names
`:323`. Same class of omission for Test 1d/1g's implicit row counts. A builder
will hit these as failures and could "fix" them by editing the assertion rather
than deriving it - the plan's own stated hazard.

## 12. [LOW] `seed/matrix.ts` canceled rows lose their stated ordering invariant at some seed wall clocks

`app/src/lib/seed/matrix.ts:997-1002` writes `canceledAt = scheduledMs - 6h` with
the comment "canceledAt sits between its dueAt and scheduledAt". Under the old
`dueAt = scheduled - 24h` that held unconditionally. Under the plan's
`dueAt = 19:30 org-local on (tour local date - 1)`, `canceledAt > dueAt` requires
the tour's local time-of-day to be later than 01:30 - and matrix tours inherit
the SEED's time-of-day (`scheduledMs = nowMs - off * DAY_MS`). A demo reseed run
between 00:00 and 01:30 local produces canceled rows whose `canceledAt` precedes
their `dueAt`. Nothing asserts it today; the comment simply becomes false. Task
10 Step 1 rewrites the parity comment but not this one.

(The plan's live-fire claim IS correct: `UPCOMING_TOUR_DAYS.scheduled = [3, 5]`
(`matrix.ts:902-904`), so the new `day_before` instant is 2-4 days out and
`listDue(now)` can never return it.)

## 13. [LOW] `docs/issues/tour-reminders-panel-e2e-flake.md:112` quotes the "Morning of" label

Task 8 relabels `morning_of`. The closed flake issue reproduces the step name
`"App: Reminders panel shows 'Morning of' as upcoming"` verbatim. Not a reader
that breaks, but the plan's Task 10 registry list does not touch it and AGENTS.md
treats that issue as a live reopen trigger, so its reproduction instructions
should not name a label that no longer exists.

## 14. [LOW] The `en_route` marker gets weaker, and 'on the way' now collides with tenant-authored text

`REMINDER_BODY_MARKERS.en_route` goes from
`"let me know when you're on the way"` (`e2e/scenarios/steps.ts:194`) to
`'on the way'`. It is still present in both type variants (correct - I checked
both new strings), but markers are used for ABSENCE assertions
(`expectNoOutboxMessageContaining`), and `tours.spec.ts:139` has the tenant send
an on-my-way message that gets relayed. A three-word marker is a much larger
collision target than the old ten-word one. The spec blesses `on the way`, so
this is a note, not a change request - but prefer
`"when you're on the way"` (present in both variants, and not something a tenant
types).

## 15. [LOW] Two spec asks are restated rather than delivered

- Spec 13: seeded "already sent" demo rows re-render in the NEW copy, and "it is
  worth a deliberate decision rather than a discovery." The plan's only response
  is Task 11's handback bullet restating the fact. No decision is made.
- Spec 9.1's closing paragraph instructs "Remove `confirmation` from
  `REMINDER_KINDS` only", which section 2's ruling forbids in Phase A. The plan's
  Global Constraints protect the builder, but SPEC CONCERNS #5 catches only the
  two OTHER Phase-B leftovers in section 13 and misses this one - and the plan
  tells the builder to "Read it fully before Task 1".

---

## SPEC CONCERNS - evaluation

1. **6.3a "never a different ENTRY" vs 6.3's entry degrade.** Real contradiction;
   the plan takes the right half (6.3b's "READ paths degrade to the absence
   fallbacks and MUST NOT throw" is the load-bearing sentence, and rendering
   `body: ''` on a name-read failure would be strictly worse). Planning-as-written
   is correct. Incomplete: see finding 10 - the resolution manufactures a
   preview/send disagreement that must be stated.
2. **`roster_unavailable` idiom scope.** Real, and planning-as-written is the
   WRONG call. See finding 3: the repo has already ruled that the unbounded
   re-list is not acceptable, and the plan neither bounds it nor files it.
3. **"degrades to a blank error".** Correct factual nit;
   `sendNowErrorMessage` (`dashboard/src/api/types.ts:1320-1322`) falls back to a
   generic sentence. No action needed.
4. **8.1 precedence is same-rung only.** Real and correctly reasoned - the
   supersession check at `jobs/tourReminders.ts:288-293` already requires the
   later rung to be armable (`otherDue < scheduledIso`) but not to be UNSKIPPED
   by the new rules, so seedLive TOUR-A's `confirmation` really will read
   "superseded by a later reminder" pointing at a `booked_too_late`
   `morning_of`. Planning-as-written is right (the spec forbids touching that
   machinery). But this is now REACHABLE in the demo/dev world, not theoretical,
   and it is recorded only in a plan appendix - it belongs in
   `docs/issues/`, alongside the Phase B ledger Task 10 already creates.
5. **Two Phase-B-era leftovers in spec 13.** Both correct, and the composable-
   confirmation guarantee really is delivered by the Task 4 matrix. No action.

---

## What I verified and found CORRECT (so a later reviewer does not redo it)

- Every `computeDueAt` expectation in Task 6 Step 1 (incl. both DST fixtures -
  US DST 2026 starts Mar 8, and 19:30 is never in the skipped hour).
- Every re-derivation in Task 6 Step 5 (Tests 1, 1c, 1d, 1f, 1g, 5) and Task 7
  Step 4 (Test 5, seedLive TOUR-A and TOUR-B) against the real fixtures.
- Task 7 Step 1 cases 1-8 boundary instants, including that case 3 and case 4 are
  genuine ordering discriminators and case 5's `>` boundary.
- `unitContacts` (`app/src/repos/unitsRepo.ts:295-303`) does synthesize
  `primaryContact: true` from `landlordId`, so Task 2's "NO roster at all" test is
  right; `memberFromContact` (`lib/rosterResolution.ts:162-181`) catches its own
  read throw, so Task 5 case 1's throwing `c-boom` cannot escape via
  `tenantRosterGate` and land in the generic per-row catch.
- `formatStreet` (`lib/address.ts:90-104`) handles `null`, plain strings and
  structured addresses exactly as Task 4's address-shape tests expect.
- `interpolate` (`messages/resolve.ts:24-45`) skips declared-but-absent tokens, so
  the "declare all six on every entry" contract does not throw; `catalog.test.ts:43`
  applies the no-dead-tokens rule to NON-editable entries only.
- The dashboard line numbers (`types.ts:1216/1239/1242/1262/1273/1284`),
  `RemindersPanel.tsx:99-108/347/358`, `RemindersPanel.test.tsx:134-148/182-183/
  261/516-517`, `tourRemindersRepo.ts` union ending at `:71`.
- No `Record<ReminderSkipReason, ...>` exists in `app/src`, so Task 3's app-side
  union addition alone is typecheck-clean.
- All four `app/src` compose sites plus the harness; all five reminder-row
  writers; `matrix.ts`'s three `day_before` writers all read one
  `dayBeforeDueAt` variable, so Task 10 Step 1's single edit covers them.
- `tourReminders.test.ts` really does carry NO `firstName` anywhere, so Task 4
  Step 12's `names: {}` default is value-safe; `devGating`'s tick fixture contact
  has no `firstName` either.
- `tour-comms-pane.spec.ts:204` books 48h out, so its `day_before` is 19:30 on
  D-1 = tomorrow and the new rule-1 cutoff (15:30 tomorrow) can never fire at
  arm time - no new time-of-day dependency there.
- Task 9's `tours.spec.ts:134` safety margin (worst case tod=00:00 gives
  morning_of at 20:00 D-1, 30 minutes clear of the 19:30 tick).
