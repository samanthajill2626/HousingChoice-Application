# Adversarial plan review - tour reminder ladder (plan v2, r1, reviewer B)

Plan: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md`
Spec: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`
Repo read at worktree `W:/tmp/tour-reminder-ladder` (read-only; nothing modified).

Question answered: if a builder with NO context executes this plan LITERALLY, do
they produce the spec?

Mostly yes. The timing derivations are unusually well checked - I re-derived
`computeDueAt` for Test 1, 1c, 1d, 1f, 1g, Test 5, seedLive TOUR-A/TOUR-B, the
three DST fixtures and every Task 7 skip-rule fixture, and every value in the
plan is arithmetically correct. What follows is what is wrong.

---

## 1. [HIGH] Spec 6.3a's "never a different ENTRY" is not delivered; the `failed`
flag the plan plumbs has no reader

Spec 6.3a, on the contact-timeline memo:

> Threaded through the new resolution that would make a FAILED read compose the
> SELF-GUIDED entry for a landlord-led tour - a preview silently disagreeing with
> what the send would produce, which is the one outcome the composer's
> single-source rule exists to prevent. The memo must carry the failure
> distinctly, or the preview must degrade on a failed read the way 6.3b says
> (absence fallbacks, never a different ENTRY).

Task 4 Step 9 rewrites `unitOnce` into a `UnitRead { unit, failed }` memo and
Task 5 threads `failed: r.failed || read.failed` through `namesOnce`. Then Task 4
Step 9's tour-walk line reads `const { names } = await namesOnce(tour.unitId);`
and **discards `failed`**. Nothing anywhere in the plan consumes it. The plumbing
is dead code, and the preview does exactly the thing the spec names as the one
outcome to prevent: on a failed property-contact read a landlord-led tour renders
the SELF-GUIDED entry, while Task 5 makes the same rung REFUSE on the send path
(`names_unavailable`). Preview and send now disagree by construction, which is
worse than the pre-change state where they agreed.

This is not hypothetical on this surface (see finding 5): the timeline's Upcoming
walk carries non-`self_guided` tours.

The plan's own SPEC CONCERNS item 1 spots the tension and resolves it in the
direction the spec forbids ("The plan does BOTH halves of 6.3a's 'or' ... AND read
paths render the absence fallbacks on a failed read - including the entry
degrade"). Doing both halves does not satisfy an "or" whose second branch is
explicitly qualified `never a different ENTRY`. Either the read paths must not
switch ENTRY on a failed read (e.g. keep the landlord-led entry and fall back, or
return `body: ''` the way `UncomposableReminderError` already does at
`routes/contactTimeline.ts:730-736`), or the spec needs an amendment before the
build - not a note in the plan.

Implication: a builder executing literally ships a dead struct field and a
preview/send divergence, and every downstream plan-anchored reviewer inherits
the omission because the plan reads as if 6.3a were satisfied.

## 2. [HIGH] Task 5 reverses a documented invariant for rungs that use neither
the address nor the property name

Task 5 Step 3:

```ts
if (unitReadFailed || resolved.failed) {
  throw new ReminderNamesUnavailableError(...);
}
```

Spec 6.3b scopes the send-path deferral to *"the contacts read threw"*. The plan
widens it to the UNIT read, which contradicts two live docblocks it does not
mention:

- `app/src/jobs/tourReminders.ts:525-526` - "A unit-read failure degrades to no
  address rather than propagating - **a reminder must never be lost over a
  missing street.**"
- `app/src/jobs/tourReminders.ts:371-374` - "A missing unit or a read failure
  degrades to the no-address variant - **never blocks a send.**"

It is also over-broad on the contacts side: `resolved.failed` is true when the
PROPERTY-contact read throws, and it then defers `confirmation`, `day_before`
and `no_show_checkin` - none of whose copy interpolates
`{propertyContactFirstName}` at all. Under the new copy only
`tour.en_route_landlord_led` uses that name, so a transient landlord-row read
failure now blocks a `day_before` that would have composed byte-identically.

In Phase A the poll is paused, so the observable path is force-send: the founder
presses Send now on a `day_before` and gets *"Could not look up the names this
message uses, so nothing was sent"* for a message that uses no such name.

The plan says only "re-derive any test that pinned 'unit read failed - composing
without an address' on a SEND path". I grepped `app/test/` and `e2e/`: **no test
pins it.** So the reversal ships with zero coverage and zero red state.

Minimum fix: gate the throw on the reads the composed ENTRY actually needs, or
keep the unit-read degrade and defer only on `resolved.failed`, and update both
docblocks in the same change.

## 3. [MEDIUM] Task 4 breaks `app/test/toursApi.test.ts` and does not stage it

`app/test/toursApi.test.ts:1494-1508` asserts the no-show draft route answers
exactly:

```ts
expect(res.body).toEqual({ body: 'Hi! Do you need to reschedule?' });
```

Task 4 Step 8 reroutes that handler through the composer, so the body becomes
`Hi <first>! ...` (or `Hi there! ...`). Task 4's **Files** block does not list
`app/test/toursApi.test.ts`, and its Step 16 `git add` line does not include it
either - the file first appears in Task 6's paths. Step 15 ("run the app suite -
green") would force the builder to edit it, and the plan's explicit-paths-only
commit rule then leaves that edit **unstaged and uncommitted** at the end of
Task 4. Task 6 would sweep it up by accident, mixing a copy change into a
retiming commit.

Related: Task 4 Step 13 case 1 adds a *new* draft test in
`app/test/tourRemindersApi.test.ts` without noticing the existing one in
`toursApi.test.ts` covering the same route.

## 4. [MEDIUM] Task 4 Step 8 orphans the `resolveMessage` import - the exact
gate-5 trap AGENTS.md documents

`app/src/routes/tourReminders.ts:43` imports `resolveMessage`; its ONLY use is
`:548` (`res.json({ body: resolveMessage('tour.no_show_checkin') })`). Task 4
Step 8 replaces that line and never says to remove the import, leaving a
`no-unused-vars` error on line 43 - a line the branch's diff never touches.

AGENTS.md calls this shape out by name: *"delete the last USE of an import and
`no-unused-vars` fires on the IMPORT line, which your diff never touched. By line
number that reads as pre-existing and ships."* Gate 5 attribution is by baseline,
so it would be caught - but only after a full-repo baseline diff, and only if the
reviewer follows the rule rather than the line number.

## 5. [MEDIUM] Task 5 case 5's premise is factually wrong; per-unit name
CORRECTNESS is left untested on the one surface that memoizes by unitId

Task 5, case 5:

> (The Upcoming walk includes only 1:1-routed tours, whose copy does not render
> the property name, so this surface can prove the READ-COUNT half only.)

`app/src/routes/contactTimeline.ts:883-895` says otherwise:

```ts
let routes1to1 = tour.tourType === 'self_guided';
if (!routes1to1) {
  ...
  const group = await resolveUsableGroup(tour, upcomingRows[0]!, groupDeps, log);
  routes1to1 = group === undefined;
}
if (!routes1to1) return [];
```

A `landlord_led` or `pm_team` tour with an UNUSABLE group routes 1:1 and IS
included - and its `en_route` rung composes `tour.en_route_landlord_led`, which
interpolates `{propertyContactFirstName}`. The property name is rendered on this
surface.

Consequence: the plan deliberately weakens the only test that could catch a
wrong memo key on the memoizing surface, and moves correctness coverage to
`tourRemindersApi` (case 6), which does not memoize at all (one tour per
request). The `namesOnce(unitId)` cache therefore ships with its keying
untested where the keying matters. This is the surface the spec singled out:
*"Resolve once per request, keyed by `unitId` for the PROPERTY contact (it varies
per tour, so a single per-request value would stamp one name onto every row)."*

## 6. [MEDIUM] After Task 7, nothing pins the silent past-dueAt drop, while the
plan asserts other tests do

Task 7's CRITICAL note: *"Leave the past-dueAt branch itself untouched for every
other rung - it is unchanged behaviour other tests pin."*

The past-dueAt branch (`jobs/tourReminders.ts:266-269`, a bare `continue`) has
exactly four assertions in the repo, and the plan flips all four:

| Site | What it pins | Plan |
| --- | --- | --- |
| `app/test/tourReminders.test.ts:356-359` (Test 1d) | `day_before` dropped, no row | Task 6 Step 5: inverts to ARMED |
| `app/test/tourReminders.test.ts:437-463` (Test 1g) | `day_before` dropped, no row | Task 6 Step 5: `:459` inverts to ARMED |
| `app/test/tourReminders.test.ts:1211-1213` (Test 5) | `day_before` dropped, no row | Task 7 Step 4: becomes `booked_too_late` |
| `app/test/seedLive.test.ts:192,207` (TOUR-A) | `day_before` dropped, no row | Task 7 Step 4: becomes `booked_too_late` |

Test 1g's TITLE is "a rung whose clamped dueAt is still in the past is skipped
(past-dueAt rule)" and after the plan it demonstrates nothing of the kind - its
other two rungs are `past_event`, a different branch. The plan notices the
consequence in a comment ("the past-dueAt drop for day_before becomes
effectively unreachable once Task 7 lands") but never re-points a test at a rung
that still reaches the branch (`morning_of`/`en_route` still can, for a booking
inside their raw lead time on a different local date). Net: a live production
branch loses 100% of its coverage in this change.

## 7. [MEDIUM] Task 4 specifies an import that cannot resolve

Task 4 Step 11:

```
import type { TourContactNames } from '../../app/src/messages/tourCopy.js';
```

`TourContactNames` is declared in `app/src/lib/tourContacts.ts` (Task 2), and
Task 4's own IMPORT LAYERING WARNING tells the builder that `tourCopy.ts` may
only `import type { TourContactNames } from '../lib/tourContacts.js'`. A type-only
import is **not** a re-export, so `steps.ts` importing the name from
`tourCopy.js` fails to compile. The plan never specifies
`export type { TourContactNames }` in `tourCopy.ts`.

Same gap, unstated, in Task 4 Step 12: `app/test/tourReminders.test.ts`'s new
`rungBody` signature uses `TourContactNames` and `TourType` with no import named.

Typecheck catches it, but the obvious "fix" a builder reaches for - a value
import of `tourContacts.ts` from `steps.ts` - is the one the plan warns drags the
AWS SDK into the Playwright bundle.

## 8. [MEDIUM] Task 7 test 8's negative assertion is vacuous

Task 7, Step 1, case 8:

> Also assert the warn does NOT fire under `quietOffSettingsRepo()` (isQuietTime
> gates on `enabled` - a disabled org with a stored 19:00 start must not warn).

`app/test/helpers/settingsStub.ts:31-33`:

```ts
export function quietOffSettingsRepo(): SettingsReadRepo {
  return stubSettingsRepo({ quietHoursEnabled: false });
}
```

It stores the DEFAULT `quietHoursStart: '21:00'`, not `'19:00'`. With a
21:00-08:00 window, 19:30 is outside it regardless of `enabled`
(`isQuietTime` at `lib/quietHours.ts:137-146`), so the assertion passes whether
or not the `enabled` gate exists. It proves nothing. It needs
`stubSettingsRepo({ quietHoursEnabled: false, quietHoursStart: '19:00' })`.

## 9. [MEDIUM] Task 10 Step 1 can make the demo seed violate its own reminder
coherence invariant, and the guarding test cannot see it

`app/src/lib/seed/matrix.ts:995-999`, the `canceled` branch:

```ts
const canceledAt = iso(scheduledMs - 6 * HOUR_MS);
```

Invariant (`app/test/seedMatrixCoherence.test.ts:443-450`):
`createdAt <= dueAt <= (sentAt ?? canceledAt ?? Infinity)`.

Past tours derive `scheduledMs = nowMs - N * DAY_MS`, so a past tour inherits the
reseed clock's local time-of-day. Task 10 moves `dayBeforeDueAt` from
`scheduledAt - 24h` to 19:30 org-local on the previous local date. For any tour
whose local time-of-day is earlier than 01:30, `19:30 D-1 > scheduledAt - 6h`, so
`dueAt > canceledAt` and the invariant breaks.

The suite never sees it: `seedMatrixCoherence.test.ts:29` pins
`NOW = 2026-07-03T12:00:00.000Z` (08:00 EDT), comfortably clear. The real demo
reseed uses the wall clock (`matrixItems(now: Date = new Date())`,
`matrix.ts:1353`). The plan's only mitigation is "Check `grep -n "dayBefore"
app/test` for any matrix-pinning test and re-derive it" - which finds the pinned
values, not the invariant.

## 10. [MEDIUM] The unbounded re-list hazard Task 5 creates is not written into
the Phase B ledger

Task 5's `ReminderNamesUnavailableError` branch is deliberately the
quiet-backstop shape: warn and `return`, no claim, no skip stamp. Unlike the
quiet-hours backstop it has NO self-clearing condition - a persistently failing
contact/unit read re-lists and re-warns the same row every tick forever. The plan
accepts this in SPEC CONCERNS item 2 on the grounds that "the production poll
sits behind the manual-only filter" - which is true only while Phase A holds.

Task 10 Step 5 creates `docs/issues/tour-reminder-ladder-phase-b.md` with six
enumerated items; none of them is this. So the hazard is created in Phase A,
justified by Phase A's pause, and recorded nowhere Phase B will look. Add it as
item (7), or bound the retry the way `rosterWaitExpired` bounds its twin.

## 11. [LOW] Task 8 Step 1's red-test list omits the second aria template's pins

Step 2 changes BOTH aria templates (`RemindersPanel.tsx:347` and `:358`), but
Step 1 only lists the "Send ... reminder now" sites
(`RemindersPanel.test.tsx:261, 516, 540, 562, 571, 586, 603`). It misses
`:418` (`'Cancel Day before reminder'`), `:424` (`'Restore Day before
reminder'`) and `:433` (`'Cancel Day before reminder'`), which Step 2 also
breaks. Step 3 ("Dashboard tests green") would fail; only Step 4's loose grep
mentions them, and it runs after.

## 12. [LOW] Task 9 Step 5's derivation for `tour-no-show-checkin.spec.ts` is wrong

> `:64` comment: the past-time PATCH now arms `confirmation` pending plus VISIBLE
> `booked_too_late` rows for day_before ... the wall-clock tick still fires only
> `confirmation`.

The spec PATCHes `scheduledAt` to 26 hours in the past
(`e2e/tests/tour-no-show-checkin.spec.ts:63-70`). `confirmation`'s dueAt is the
arm instant, so `dueAt >= scheduledIso` at `jobs/tourReminders.ts:270` is TRUE
and the rung is born a VISIBLE `past_event` row, not pending. Nothing is pending
and the wall-clock tick fires nothing - which is also why the spec's Half 1
passes today. A builder pasting the plan's sentence writes a comment that is
false in both directions.

## 13. [LOW] Task 4 Step 11 mis-states which specs have `tenant` in scope

> `e2e/tests/scenarios/scheduled-visibility.spec.ts:129,148,221` -
> `tourReminderContext(unit, times, { ... names: { tenantFirstName: tenant.firstName } })`.
> (At `:129` the tenant is in scope from the shared helper's return.)

At `:101` Part A destructures `const { unit, times } = await
bookedSelfGuidedTour(flow, 'Ladder');` - `tenant` is NOT in scope. `:148` and
`:221` do destructure it. Typecheck catches this; it is noted only because the
plan asserts it as verified.

## 14. [LOW] Several Task 9 "safe at any wall clock" claims depend on the CI
host's zone equalling `ORG_TIMEZONE`

`timesFor` builds instants from a HOST-local `datetime-local` string
(`e2e/scenarios/steps.ts:262-281`) and `tourScheduleFullLadder` sets
`sched.setHours(14, 0, 0, 0)` in HOST local time (`:265`). `day_before` is now
anchored to 19:30 **org**-local. Task 9 Step 3's margin argument for
`tours.spec.ts:134` ("at least 20:00 D-1 - 30 minutes clear at the worst wall
clock") and Step 4's "still before morning_of at 10:00 on tour day" both assume
host zone == `America/New_York`. The repo already leans on that
(`scheduled-visibility.spec.ts:126-128` says so explicitly), so this is not new -
but the plan presents these as unconditional, and the worst-case margin is 30
minutes.

## 15. [LOW] Task 3's "omitting the dashboard half fails no build" is only half true

Task 3 (echoing spec 8.2) says omitting the dashboard change "fails no build -
the chip degrades silently to a reason-less 'Skipped'". That is true only if you
omit the dashboard UNION entirely. `REMINDER_SKIP_REASON_LABELS` is typed
`Readonly<Record<NonNullable<TourReminderView['skipReason']>, string>>`
(`dashboard/src/api/types.ts:1261-1263`), so adding the union member and
forgetting the label is a hard typecheck failure. Worth stating so nobody
concludes the label test is the only guard.

---

## SPEC CONCERNS - evaluation

1. **6.3a's parenthetical vs 6.3's own fallback.** REAL, and planning-as-written
   is the WRONG call. See finding 1. The concern is stated as a documentation
   tension; it is actually a delivered-behaviour gap - the plan builds the
   `failed` carrier the spec asks for and then never reads it, and ships the
   preview/send divergence 6.3a exists to forbid. This should be resolved before
   the build, not recorded.
2. **6.3b's "roster_unavailable idiom" scope.** REAL, and planning-as-written is
   RIGHT: the spec's literal instruction is "leave the rung UNCLAIMED", 8.2 grants
   no token, and inventing one mid-build would be exactly the drive-by the spec
   refuses elsewhere. But the mitigation offered is Phase-A-only and the plan
   does not carry it forward - see finding 10.
3. **6.3b's "or it degrades to a blank error".** REAL and correctly diagnosed as
   a factual nit. `sendNowErrorMessage` (`dashboard/src/api/types.ts:1322-1324`)
   returns `"Couldn't send that just now - please try again."` on an unknown
   code. No action needed.
4. **8.1 precedence is same-rung only; cross-rung supersession untouched.**
   REAL but MIS-SCOPED as new. The plan presents "a rung retired by rule 2 can
   still claim an earlier rung's slot" as something the change introduces. It
   does not: `supersededBySlot` (`jobs/tourReminders.ts:288-293`) already
   consults `dues` for rungs the past-dueAt branch dropped silently, and
   `app/test/seedLive.test.ts:204` already pins `confirmation` as
   `quiet_hours_superseded` by a `morning_of` that is itself dropped. The plan's
   own Task 7 Step 4 derivation ("confirmation STAYS `quiet_hours_superseded`")
   confirms the behaviour is unchanged. Planning-as-written is right; the
   framing overstates the plan's responsibility for it.
5. **Two Phase-B-era leftovers inside spec 13.** REAL, correct, and correctly
   dispositioned. (a) With `confirmation` kept armed, the ~40 structural sites do
   not break structurally - they break for timing reasons, which the plan
   handles. (b) "A pending confirmation row still composes after the rung stops
   arming" genuinely belongs to Phase B; the composability half IS delivered by
   the Task 4 matrix (which iterates all five kinds x both address states x all
   three tour types x named/anon, so both `tour.confirmation` entries are
   covered). No action.

---

## What I verified and found CORRECT (so nobody re-does it)

- Every `computeDueAt` expected value in Task 6 Step 1, including the two DST
  fixtures (2026 US spring-forward is Mar 8; `2026-03-09T16:00Z` -> 19:30 EDT
  Mar 8 = `2026-03-08T23:30Z`; `2026-03-06T16:00Z` -> 19:30 EST Mar 5 =
  `2026-03-06T00:30Z`) and the January EST crossing.
- Every re-derivation in Task 6 Step 5 (Tests 1, 1c, 1d, 1f, 1g, 5) and Task 7
  Step 4 (Test 5, seedLive TOUR-A pending = `['en_route']` with `confirmation`
  still `quiet_hours_superseded` via the retained `dues` entry; TOUR-B
  unaffected).
- Every Task 7 skip-rule fixture, including the strict-`>` boundaries (cases 2
  and 5) and the midnight-crossing guard (case 6, where `morning_of`'s raw
  equals `now` exactly and survives because the past-dueAt test is `<`).
- Task 2's seven resolver cases against `unitContacts`
  (`app/src/repos/unitsRepo.ts:295-303`) and the zero-primary rule
  (`app/src/lib/rosterResolution.ts:273-275`), including the empty-string guard
  and the `nonEmpty` module-privacy claim (`rosterResolution.ts:151`).
- `shiftLocalDate`'s malformed-input test: `'2026-ab-23'` yields `NaN` (caught by
  `Number.isFinite`) and `'nonsense'` yields `[NaN]` (caught by the `undefined`
  checks). Both throw the named error.
- The catalog/token-declaration test: 7 `tour.*` ids post-change; unused declared
  tokens are legal because `catalog.test.ts:43-53` scopes the no-dead-tokens rule
  to non-editable entries; the `{addressLine}` + `.trim()` scheme cannot leak a
  literal `{where}` because `interpolate` iterates DECLARED vars only
  (`messages/resolve.ts:31-33`).
- `TourItem.tourType` is REQUIRED (`repos/toursRepo.ts:80`), so
  `tourType: tour.tourType` typechecks at every send/preview site.
- `app/src/lib/toursModel.ts` has zero imports, so the composer's `TourType`
  import cannot drag the AWS SDK into the harness bundle.
- `tourReminders.test.ts`, `tourRemindersApi.test.ts` and
  `contactTimeline.test.ts` contain ZERO occurrences of `firstName`, so Task 4
  Step 12's `names: {}` default is value-safe as claimed.
- Task 9 Step 4's quiet-hours rework. I initially read the file-header contract
  bullet ("computed against the SERVER'S WALL CLOCK") as fatal to a rung-anchored
  window, but `routes/tourReminders.ts:458-461` evaluates quiet-ness per row as
  `(dueAt > now && isQuietTime(dueAt)) || (wallClockQuiet && dueAt <= now)`.
  `day_before`'s dueAt is ~1.5 days out and inside `[17:30, 21:30)` org-local at
  any wall clock, so disjunct 1 fires and the PAUSED/QUIET precedence assertion
  is non-vacuous. The plan's claim holds and the header rewrite it orders is the
  right repair.
- `routes/relayGroups.ts:147` and `routes/tourReminders.ts:141` both already hold
  a `contacts` repo, so the two hoists need no new dep threading (only
  `gatherUpcoming` does, which the plan calls out).
- `e2e/scenarios/steps.ts` has exactly ONE `this.activeTour =` site (`:1720`,
  inside `teamCreatesTourFromInterest`), so Task 4 Step 11's threading
  instruction is complete.
- `tourCopyCallSites.test.ts` deletion of `ALLOWED_DIRECT` (`:33`, `:49`) is
  sound - the whitelist is the only exemption and the route is the only user.
