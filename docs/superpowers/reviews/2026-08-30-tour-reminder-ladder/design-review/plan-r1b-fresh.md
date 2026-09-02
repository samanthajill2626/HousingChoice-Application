# Adversarial plan review - tour reminder ladder (fresh pass, r1b)

Reviewed: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md` against
`docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md` and the
worktree at `W:/tmp/tour-reminder-ladder` (read-only).

Question answered: if a builder with NO context executes this plan LITERALLY, do
they produce the spec? Answer: no. Four defects stop the build outright; a
further six leave a stated spec guarantee unbuilt or silently wrong.

What the plan gets RIGHT and I verified, so nobody re-litigates it: the composer
call-site list in Task 4 is COMPLETE and every line number is accurate (13 sites,
`grep -rn "composeTourReminderBody("` over `app/src`, `app/test`, `e2e`);
`quietHoursWindowOf`'s field names match Task 6's fixture
(`app/src/lib/quietHours.ts:18-29`); `analyzeSms` exists
(`app/src/lib/smsEncoding.ts:42`); every arm-loop line reference in Tasks 6/7
(`:89`, `:197`, `:248`, `:266`, `:270`, `:294`) is correct; `catalog.test.ts:35`
and `:43` say what both documents claim; the `ALLOWED_DIRECT` deletion in Task 4
Step 5 is safe (`app/test/tourCopyCallSites.test.ts:33` whitelists exactly one
id); `settingsToOverrides` maps only `welcome.sms` and `missed_call.autotext`
(`app/src/messages/resolve.ts:74-79`), so deleting three `tour.*` catalog ids
cannot orphan an operator override. The routers already hold `contactsRepo` and
`unitsRepo` (`app/src/routes/tourReminders.ts:87-95,159-163`), so Task 4 Step 5's
"that router must reach unitsRepo and contactsRepo" is already satisfied.

---

## 1. BLOCKING - Task 4 Step 1 sources the founder's copy from a document the builder does not have

**What is wrong.** Task 4 Step 1 reads: "Include, verbatim from the previous plan
revision, the day_before/morning_of/en_route/pm_team/degrade/there/no_show
cases". The builder is handed the plan, the spec and the repo. There is no
previous plan revision. Task 4 is the ONE task that pins the founder's rewritten
copy - the entire point of the branch - and its assertions have no source.

The two tests the plan does spell out are also unexecutable: the matrix test
references `base`, `NAMES` and `TOUR_TYPES` and defines none of them. `base` and
`NAMES` exist nowhere; `TOUR_TYPES` is real (`app/src/lib/toursModel.ts:92`) but
is never imported in the snippet. Task 9 Step 1 then compounds it by saying the
compose-survives case "needs `base`/`NAMES` from that file" - inheriting an
identifier that was never created.

**Evidence.** Plan Task 4 Step 1 and Task 9 Step 1; `app/test/tourCopy.test.ts`
has a `base` fixture today but no `NAMES`, and spec section 5's table is the only
copy of record.

**Implies.** The builder either invents copy or stops. Both are worse than being
told. Task 4 Step 1 must inline the spec section 5 table as concrete
`expect(...).toBe('...')` assertions and define `base`/`NAMES`/`TOUR_TYPES`.

---

## 2. BLOCKING - Task 9's confirmation removal breaks three e2e specs; one of them is named nowhere in the plan

**What is wrong.** Task 9 removes `confirmation` from `REMINDER_KINDS`. Task 11 -
the only task that touches e2e - names `quiet-hours.spec.ts:293,318`,
`scheduled-visibility.spec.ts:163,228` and `tours.spec.ts:134`. That list misses
every confirmation dependency:

- `e2e/tests/tour-roster.spec.ts:498-503` reads the armed ladder, then
  `if (confirmation === undefined) throw new Error('the booking armed no confirmation rung');`
  and derives the tick instant from `confirmation.dueAt`. The whole
  roster-suppression assertion at `:518-523` rides that rung. This FILE is named
  in no task, in no file table, and in no test list in either document.
- `e2e/tests/scenarios/tours.spec.ts:130-132` -
  `flow.expectReminderInGroup('confirmation', [tenant, owner])` and
  `flow.expectReminderVisibleInGroupThread('confirmation')`, driven by a bare
  `flow.tickTourReminders()` at `:129` whose whole purpose is that
  `confirmation`'s dueAt is arm-time `now`. Task 11 names `:134` only.
- `e2e/tests/scenarios/scheduled-visibility.spec.ts:131,175` fire the
  confirmation rung to prove the panel flips to SENT.

`app/test/seedLive.test.ts:205-206` also asserts
`confirmation?.['skipReason'] === 'quiet_hours_superseded'` and `:241` lists it
in a rung array - see finding 4.

**Evidence.** `e2e/tests/tour-roster.spec.ts:495-523`;
`e2e/tests/scenarios/tours.spec.ts:125-135`;
`e2e/tests/scenarios/scheduled-visibility.spec.ts:107-180`.

**Implies.** Gate 4 in Task 12 discovers this after eleven tasks are committed,
and the fix is not mechanical: the natural replacement rung (`day_before`) is
exactly the one Task 11 declares un-mirrorable. `tour-roster.spec.ts` already
demonstrates the correct pattern (read the armed dueAt back from
`GET /api/tours/:id/reminders`, `:495-499`) and the plan should say so.

---

## 3. BLOCKING - the 19:30 org-local anchor destroys quiet-hours.spec.ts's determinism contract, and Task 11 misreads the problem as arithmetic

**What is wrong.** `e2e/tests/scenarios/quiet-hours.spec.ts:20-38` states a
TIMING CONTRACT: the panel's suppression estimate runs against the SERVER'S WALL
CLOCK, so the spec stores a real window with `windowAroundNow()` (a 4-hour window
centred on now, org-local), and it relies on `day_before` being "~24h out = the
same local time of day" as the booking so the DEFER tick lands INSIDE that
window.

After Task 6, `day_before` is 19:30 org-local - a FIXED time of day, wholly
decoupled from the wall clock. `windowAroundNow()` contains 19:30 only when the
suite happens to run between roughly 17:30 and 21:30 org-local. The spec becomes
green for four hours a day and red for twenty.

This is the same defect class the harness already root-caused once and documented
at `e2e/scenarios/steps.ts:247-257` (the 00:00-08:00 `tourScheduleFullLadder`
flake, root-caused 2026-08-04).

Task 11 Step 2 says only: "Each needs either the org-local 19:30 instant computed
a different way, or to drive that rung by a different means." That frames the
problem as "how do I compute the instant". The instant is the easy half; the hard
half is that a wall-clock-centred window can no longer contain a fixed-clock rung.

**Evidence.** `e2e/tests/scenarios/quiet-hours.spec.ts:20-38, 279-300`; plan Task
6 Step 4; `e2e/scenarios/steps.ts:247-257`.

**Implies.** The plan ships a wall-clock flake into the suite that AGENTS.md
declares has no named-flake re-run list, so the next failure is triaged as a
regression. Either the spec must switch to a rung whose offset is still relative
(`morning_of`, now `-4h`), or `windowAroundNow()` must be replaced with a window
built around the rung's own org-local instant. The plan must decide which.

---

## 4. BLOCKING - Task 6 pre-applies a Task 9 change to seedLive.test.ts, then orders the builder to prove that file green

**What is wrong.** Task 6 Step 6: "Update `app/test/seedLive.test.ts`'s DELIBERATE
twin ... AND its local `REMINDER_KINDS` copy at `:84` and the rung-count assertion
at `:219` - Task 9 removes `confirmation` from arming, so re-derive rather than
guess." Step 7: "Run `cd app && npx vitest run test/seedLive.test.ts` and confirm
it did NOT skip."

At the end of Task 6 the product still arms `confirmation`
(`app/src/jobs/tourReminders.ts:197-202` is untouched until Task 9). A
seedLive.test.ts whose local `REMINDER_KINDS` and rung count have been
re-derived for a four-rung ladder will FAIL against a five-rung product. Step 7
orders the builder to confirm a green run that cannot happen, so the builder will
either revert a correct change or "fix" the product early - i.e. do Task 9 inside
Task 6, which is the ordering the plan drew the boundary to prevent.

Task 6 Step 6 also misses two more confirmation dependencies in the same file:
`:205-206` (`expect(confirmation?.['skipReason']).toBe('quiet_hours_superseded')`)
and `:241`.

The plan's own Self-Review claims "Type consistency ... `booked_too_late` (T5) ->
T7, so T7 must not run before T5" - it applied that reasoning to T5/T7 and not to
T6/T9, where the dependency runs BACKWARDS.

**Evidence.** `app/test/seedLive.test.ts:49-88, 200-208, 219-241`;
`app/src/jobs/tourReminders.ts:197-202`; plan Task 6 Steps 6-7, Task 9.

**Implies.** Move the whole seedLive re-baseline into Task 9 (or after it), and
enumerate `:205-206` and `:241`.

---

## 5. HIGH - Task 8 never names `forceSendReminder`; "return without claiming" has no representable outcome on the human send path

**What is wrong.** Spec 6.3: "SEND paths leave the rung UNCLAIMED on a read
failure". Task 8 Step 3: "Send paths: on `failed`, return without claiming."

There are THREE send paths through `composeBodyForRow`, and the plan's own spec
section 10 says so: `processReminderRow` (1:1), `sendGroupReminder` (group), and
`forceSendReminder`. Task 8's Files list names `jobs/tourReminders.ts`
("`composeBodyForRow` `:547` and its caller" - singular) and its tests cover only
the 1:1 poll rig.

`forceSendReminder` cannot "return without claiming". Its return type is
`ForceSendResult` (`app/src/jobs/tourReminders.ts:1123-1131`): `sent`,
`not_pending`, `refused` + a `ForceSendRefusal`, or `refused_post_claim`. There
is no token in `ForceSendRefusal` (`:1098-1121`) for "the names could not be
read", and the route echoes `result.reason` straight out as the 409 `error` code
(`app/src/routes/tourReminders.ts:394-399`). A builder following Task 8 literally
either invents a token with no guidance, or - more likely, since the plan never
mentions the function - leaves `forceSendReminder` composing fallback copy under
a name it could not read. That is precisely the failure spec 6.3 exists to
prevent, and Phase A's ONLY observable send path is the human force-send, because
the ladder is paused.

**Evidence.** `app/src/jobs/tourReminders.ts:1098-1131, 1215-1232`;
`app/src/routes/tourReminders.ts:394-399`; spec section 2 (pause), 6.3, 10; plan
Task 8.

**Implies.** The single spec guarantee that matters in Phase A is unbuilt and
untested. Task 8 must name the third caller, decide its refusal token, and note
that `sendNowErrorMessage` (`dashboard/src/api/types.ts:1321`) already falls back
gracefully for an unknown code so no dashboard copy entry is strictly required.

---

## 6. HIGH - skip rule 2 has no stated position relative to the past-dueAt branch, so a short-notice `morning_of` still vanishes

**What is wrong.** Spec 8.1 DECIDES that BOTH new rules write a VISIBLE skipped
row, and explains that the past-dueAt branch at `:266` writes no row at all, so
rule 1 must be evaluated first. Task 7 carries that forward for rule 1 only:
"Rule 1 must be evaluated BEFORE the existing past-dueAt branch at `:266`".
Nothing in the plan says where rule 2 goes.

Rule 2 hits the same collision. For a tour booked 3h out, `morning_of`'s raw dueAt
is `scheduledAt - 4h`, already in the past, so the past-dueAt branch fires first
and writes NOTHING - the founder sees a gap, not `booked too late for this
reminder`. Task 7's own fixtures never reach this: `SAMEDAY_INSIDE` is
`13:00:00.001Z` against a `19:00:00Z` tour, so `morning_of` raw = `15:00Z` is
still in the future and the collision is never exercised.

**Evidence.** `app/src/jobs/tourReminders.ts:262-269`; spec 8.1; plan Task 7
"CRITICAL" note and Step 1 fixtures.

**Implies.** Half of spec 8.1's decision ships unbuilt, and the plan's own test
suite certifies it as done.

---

## 7. HIGH - the ordering constraint Task 7 labels CRITICAL has no test

**What is wrong.** Same section, separate defect. Task 7's rule-1 fixtures use
`BOOKED_JUST_INSIDE = '2026-07-22T19:30:00.001Z'` against a
`'2026-07-23T19:00:00.000Z'` tour. At that `now`, `day_before`'s raw dueAt
(`2026-07-22T23:30:00.000Z`) is still four hours in the FUTURE, so the past-dueAt
branch would never have fired anyway. Both boundary tests pass identically
whether rule 1 is placed before or after `:266`.

The case that discriminates is spec 8.1's stated one - a SAME-DAY booking, where
`day_before`'s raw dueAt is already past - and no fixture in the plan produces it.

**Evidence.** Plan Task 7 Step 1; `app/src/jobs/tourReminders.ts:266-269`.

**Implies.** A TDD step whose red state is not red for the property it exists to
pin. Add a same-day booking fixture asserting a visible `booked_too_late`
`day_before` row.

---

## 8. HIGH - "resolve contacts once per request" is the wrong batching key for the property contact

**What is wrong.** Spec section 10 and Task 8 Step 4 both say: resolve contacts
once per REQUEST for the contact timeline's Upcoming bucket, not per rung.

The tenant is indeed constant across that walk - walk 1 is "tenant tours" for the
contact whose timeline it is (`app/src/routes/contactTimeline.ts:748-756`). The
PROPERTY CONTACT is not: it is derived per TOUR from that tour's `unitId`. A
builder following the instruction literally resolves ONE property contact and
stamps it onto every tour's rungs, so a tenant with two upcoming landlord-led
tours at different properties sees the wrong person's name on one of them - in a
PREVIEW surface whose entire justification (`tourCopyCallSites.test.ts:1-19`) is
that the preview must equal the send.

The correct unit of work is per-TOUR (dedup by `unitId`), with the tenant hoisted
once.

**Evidence.** `app/src/routes/contactTimeline.ts:716-740, 748-760`; spec section
10; plan Task 8 Step 4; `app/test/tourCopyCallSites.test.ts:1-19`.

**Implies.** A named-wrong-person bug on a preview surface, produced by following
the instruction exactly. Task 8 Step 4's read-count assertion would PASS on the
wrong implementation.

---

## 9. HIGH - Task 11 Step 2 is a non-instruction for the step the plan itself calls the hardest

**What is wrong.** Task 11 opens "THIS IS THE HARDEST TASK IN THE PLAN. Do not
treat it as part of the sweep." Step 2 then reads, in full: "Rework the five specs
that tick off `times.dayBefore`. Each needs either the org-local 19:30 instant
computed a different way, or to drive that rung by a different means. Do NOT
invent a host-local approximation."

That is a restatement of the constraint, not a method. It leaves the single
riskiest decision in the branch to a builder with no context, and the plan
elsewhere insists (correctly) that every task with novel logic carries concrete
instants.

A correct method exists in the repo and the plan does not point at it: read the
armed `dueAt` back from `GET /api/tours/:tourId/reminders`, exactly as
`e2e/tests/tour-roster.spec.ts:495-499` already does.

**Evidence.** Plan Task 11 Steps 1-2; `e2e/scenarios/steps.ts:211-280`;
`e2e/tests/tour-roster.spec.ts:495-499`.

**Implies.** The builder guesses, and the most available guess is the host-local
approximation the docblock at `steps.ts:234-241` warns against.

---

## 10. HIGH - a required `tourType` + names on `TourReminderContext` breaks e2e call sites no task enumerates

**What is wrong.** Task 4 makes `tourType` REQUIRED on `ComposeTourReminderInput`
and modifies `e2e/scenarios/steps.ts:174`. Task 11 Step 5 additionally threads the
seeded tenant's first name through `TourReminderContext`. Both changes ripple:

- `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:230-238` calls
  `tourReminderBody('day_before', { ...inline object literal... })`. Named in NO
  task, NO file table, and NOT in spec section 13's break list.
- `tourReminderContext(unit, times)` (`e2e/scenarios/steps.ts:163-165`) has no
  `tourType` parameter and is called at
  `scheduled-visibility.spec.ts:129,148,221`. The plan never says the helper's
  signature changes.

The e2e workspace HAS a typecheck script (`e2e/package.json` -> `tsc -p
tsconfig.json`) and root `npm run typecheck` runs `--workspaces --if-present`, so
Task 4 Step 8 does catch this - but Task 4 Step 9's commit path list is "the src
files, the e2e helper, the six test files, and the two test suites", which
excludes every e2e SPEC. Under the repo's explicit-paths-only commit rule, the
builder commits a half-fixed tree.

**Evidence.** `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:50,230-238`;
`e2e/scenarios/steps.ts:163-178`; `e2e/package.json`; plan Task 4 Steps 8-9, Task
11 Step 5.

---

## 11. MEDIUM - relayGroups composes inside a synchronous `.map()`; no task says how the async resolve gets in front of it

**What is wrong.** `app/src/routes/relayGroups.ts:243-275` builds each scheduled
card inside `.map((row) => ({ ... body: ((): string => { ... })() }))` - a SYNC
IIFE inside a sync map. Task 4 Step 5 says "update the five call sites"; Task 8
says the read paths must degrade rather than throw. Neither notes that this one
cannot simply `await` a resolver where it stands; the names must be resolved
above the map (once - there is a single `tour` per thread here).

**Evidence.** `app/src/routes/relayGroups.ts:236-278`; plan Task 4 Step 5, Task 8.

**Implies.** The likely literal outcome is `.map(async ...)` yielding
`Promise<string>` in a `body: string` field, or an `await` that does not compile.
Recoverable, but it is the kind of restructure the plan calls out everywhere else
and omits here.

---

## 12. MEDIUM - Task 5's red state is not red

**What is wrong.** Task 5 Step 1: "Write the failing tests - the union accepts it,
and the panel renders the exact label string." Step 2: "Run and watch them fail."

The app half is a TypeScript union addition in
`app/src/repos/tourRemindersRepo.ts:38-71`. Vitest runs through esbuild, which
STRIPS types without checking them - the plan states this itself in its Global
Constraints. A repo test that writes a row with
`skipped: { reason: 'booked_too_late' }` compiles away and PASSES green before the
union exists. Only `npm run typecheck` sees it, and Task 5 has no typecheck step.

The dashboard half (`RemindersPanel.test.tsx` asserting the label string) IS
genuinely red, because `REMINDER_SKIP_REASON_LABELS`
(`dashboard/src/api/types.ts:1262-1274`) is runtime data.

**Evidence.** `app/src/repos/tourRemindersRepo.ts:38-71`; plan Global Constraints
("`npm run typecheck` TYPECHECKS TESTS") vs Task 5 Steps 1-4.

---

## 13. MEDIUM - two documented readers of the changed invariants are unenumerated

**What is wrong.**

- `app/src/lib/seed/live.ts:9` documents "Full 5-rung reminder ladder armed via
  armTourReminders"; `:25`, `:433`, `:478-530` describe the arm strategy. Task 9
  makes that four kinds (three auto-armed rungs plus skip rows). No task touches
  the seeder or its docblock, and the plan's File Structure table has no seed
  entry. The lean/demo world's shape changes with no note.
- `e2e/support/selectors.md:72` is the PINNED accessible-name contract for the
  Send-now button and enumerates the kind labels verbatim, "Morning of" among
  them. Task 10 relabels `morning_of` to `4 hours before`, which changes the
  button's `aria-label` (`dashboard/src/routes/tours/RemindersPanel.tsx:347`
  builds it from `kindLabel`). Neither Task 10 nor Task 11 names selectors.md.

**Evidence.** `app/src/lib/seed/live.ts:7-33, 478-530`;
`e2e/support/selectors.md:72`;
`dashboard/src/routes/tours/RemindersPanel.tsx:310,347`.

---

## 14. MEDIUM - the landlord-led degrade is split across two tasks and joined by nothing

**What is wrong.** Spec section 13 owes: "the property-contact fallback degrading
to the self-guided entry - covering BOTH zero-roster and zero-primary." Task 3
tests the RESOLVER (zero-roster and zero-primary both resolve to `landlordId`).
Task 4 tests the COMPOSER (`!hasContactName` picks `tour.en_route_self_guided`).
No task tests the JOIN: a `landlord_led` tour whose unit has a roster with zero
primaries and a nameless landlord composes the self-guided entry end to end.

That join is where the real defect would live, because `unitContacts`
(`app/src/repos/unitsRepo.ts:295-303`) already synthesizes a
`primaryContact: true` row from `landlordId` when `contacts[]` is empty - so the
two "fallback" cases the spec names take DIFFERENT code paths and only one of
them exercises `primary?.contactId ?? unit.landlordId`.

**Evidence.** `app/src/repos/unitsRepo.ts:295-303`;
`app/src/lib/rosterResolution.ts:269-281`; spec section 13; plan Tasks 3, 4.

---

## 15. MEDIUM - Task 8 optimizes the unit read and ignores the tenant contact already in hand

**What is wrong.** Task 8: "Note `composeBodyForRow` already reads the unit for the
address ... Widen the deps, and resolve the unit ONCE - do not read it twice."
Correct, and it stops one read short. On the 1:1 route `resolveReminderTarget`
has ALREADY read the tenant contact
(`app/src/jobs/tourReminders.ts:647-654`) and returns it as `target.contact`. A
builder following Task 8 adds a second `contactsRepo.getById(tour.tenantId)`
inside `composeBodyForRow`.

Worse than the extra read: on that route a missing tenant contact is already a
`contact_missing` claim-skip, so the new "absence -> greet with 'there'" branch is
UNREACHABLE from the 1:1 poll path - which is where Task 8 Step 1's second test
("genuine ABSENCE still sends, greeting with 'there'") points its rig. That test
as written may not be able to reach the state it claims to assert.

**Evidence.** `app/src/jobs/tourReminders.ts:532-555, 621-678, 741-754`; plan Task
8 Steps 1 and 3.

---

## 16. MEDIUM - Task 3's resolver is not the rule it says it reuses

**What is wrong.** Task 3 and spec 6.1 both instruct "use the ESTABLISHED rule
(`lib/rosterResolution.ts:274`)" and then write:

```ts
const propertyContactId = primary?.contactId ?? unit.landlordId;
```

The established rule is `primary?.contactId ?? nonEmpty(unit.landlordId)`, guarded
on the next line by `if (propertyContactId === undefined || propertyContactId.length === 0) return ...`
(`app/src/lib/rosterResolution.ts:274-277`). The plan's version passes an empty
string through to `contactsRepo.getById('')`. None of Task 3's five listed cases
covers an empty-string `landlordId`.

Writing a subtly different second resolver is the exact drift both documents cite
`seedLive`'s `computeDueAt` twin as a warning about.

**Evidence.** `app/src/lib/rosterResolution.ts:269-281`; plan Task 3.

---

## 17. LOW - the spec contradicts itself on the quiet-hours exemption hook, and the plan asks for an amendment that already landed

**What is wrong.** Spec 7.3 is titled "CUT FROM PHASE A (amended 2026-08-26)" and
says the hook is NOT built. Spec section 12 item 1, unamended, still says "The
hook is built here but stays empty". The plan's Self-Review says "Spec 7.3 should
be amended to say so" - it already is, which means the plan's Self-Review was
written against an earlier spec.

**Evidence.** Spec lines 237-244 vs 425-427; plan Self-Review "Deferred with
reason".

**Implies.** A literal builder reading spec section 12 builds the hook the plan
cut. Cheap to fix; leave it and someone builds dead code.

---

## 18. LOW - "the eight existing reasons" is nine

**What is wrong.** Spec 8.2 and Task 5 both enumerate eight `ReminderSkipReason`
tokens. There are nine: `invalid_schedule`
(`app/src/repos/tourRemindersRepo.ts:64-71`), mirrored at
`dashboard/src/api/types.ts:1216` and labelled at `:1273`. The plan's insertion
points ("wire union ~`:1213`, label map ~`:1273`") land on `roster_unavailable`
and `invalid_schedule` respectively, so they are usable but off by one entry.

`invalid_schedule` is also the reason the plan's own claim "None of the eight
existing reasons means this" needs re-checking - it does not, but the count being
wrong in both documents suggests neither was re-derived from the file.

---

## 19. LOW - Task 2's error branch is untested and misfires on a partially numeric date

**What is wrong.** `shiftLocalDate('20x6-07-23', -1)` yields `y = NaN` - defined,
not undefined - so the guard passes, `Date.UTC(NaN, ...)` yields NaN, and
`.toISOString()` throws a bare `RangeError`, not the intended
`shiftLocalDate: unparseable local date` message. Task 2's four tests are all
happy-path; the throw branch has no coverage.

**Evidence.** Plan Task 2 Steps 1 and 3.

---

## 20. LOW - Task 6's DST test does not sit near a transition, and Task 12 Step 1 does not flip issue status

**What is wrong.** Task 6's "DST-transition day" case anchors 19:30 on
2026-03-08. The America/New_York transition is at 02:00; 19:30 is fourteen hours
clear of it and unambiguous in both offsets. The test is a useful regression pin
against a naive `-24h` shift, but it is not a DST test and should not be reported
as discharging spec 7's "owes a DST-transition test".

Separately, Task 12 Step 1 says to add `resolved: 2026-08-26` and a Resolution
line. `docs/issues/_TEMPLATE.md:24` requires ALSO setting `status: open` ->
`status: resolved`; `npm run issues` indexes on `status`.

---

## 21. LOW - Task 7 Step 4's warn has no stated mechanism, so a hand-rolled version fires for orgs with quiet hours OFF

**What is wrong.** "When 19:30 local falls inside the configured window, log a
WARN". `QuietHoursWindow` carries `start`/`end` regardless of `enabled`
(`app/src/lib/quietHours.ts:10-29`). A builder comparing HH:MM strings by hand
warns on every arm for any org that has quiet hours DISABLED with a 19:00 start
still stored. `isQuietTime` gates on `enabled` first
(`app/src/lib/quietHours.ts:137-138`), so naming it in the plan makes the gate
free. Task 7 does not name it, and its test stub sets only `quietHoursStart`.
