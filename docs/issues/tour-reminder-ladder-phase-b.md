---
id: tour-reminder-ladder-phase-b
title: Phase B unpause ledger for the tour reminder ladder - the nine things owed before MANUAL_ONLY_REMINDER_KINDS is emptied
type: improvement
severity: med
status: open
area: app/jobs
created: 2026-08-26
refs: app/src/jobs/tourReminders.ts, app/src/messages/tourCopy.ts, app/src/repos/tourRemindersRepo.ts, docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md
---

**Problem.** The tour reminder ladder has been PAUSED since 2026-08-20 (founder
decision): every rung still arms and displays, but
`MANUAL_ONLY_REMINDER_KINDS` (`app/src/jobs/tourReminders.ts`) keeps the poll off
all of them, so nothing sends without a human pressing Send now. Phase A
(`feat/tour-reminder-ladder`, 2026-08-26 - the copy rewrite, name resolution, the
retiming and the booked-too-late rules) deliberately did not lift that pause, and
in doing so it accepted a set of obligations that only come due at unpause. This
file is the ledger of them, so they are FINDABLE when Phase B starts rather than
scattered across a spec, a plan and three code comments. Design source
throughout: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`.

The nine items, in the order Phase B should meet them:

1. **THE FIRST TASK IS A ONE-TIME RETIREMENT SWEEP of stale pending rows (spec
   9.6).** A manual-only rung is left PENDING, not claim-skipped, so Send now
   keeps working - which means every rung armed during the pause is still
   sitting there, due, waiting. `confirmation` arms with `dueAt = now`, so it is
   past-due the instant it is written and EVERY tour booked during Phase A has
   left one behind. The moment the manual-only set is emptied the next poll tick
   sees the lot and sends it, and those rows carry OLD dueAts, so what fires is a
   burst of reminders for tours that are long past. TWO THINGS THE SWEEP MUST
   GET RIGHT: (a) THE CRITERION IS THE TOUR BEING PAST, NOT THE dueAt -
   "anything past-due" would retire a `confirmation` for a tour NEXT WEEK, which
   is past-due from birth; (b) DO NOT STAMP THEM `past_event` - spec 8.2 calls
   that reuse a lie for this shape of row and it is false on the merits, so
   Phase B owes a reason token of its own and deciding it is part of this work.
   Prove the sweep on real dev data, not only in a test. Write it as Phase B's
   FIRST task, not its last.

2. **Empty `MANUAL_ONLY_REMINDER_KINDS` and, in the SAME change, stop arming
   `confirmation` (spec 9.5).** Remove `confirmation` from `REMINDER_KINDS`
   ONLY - the `no_show_checkin` pattern - leaving the kind valid in the union,
   in `computeDueAt`, in `LADDER_ORDER` and in the catalog so in-flight rows
   still compose. At that point `confirmation`'s `MANUAL_ONLY_REMINDER_KINDS`
   entry becomes dead state and its comment becomes false; correct both then.
   Spec 9.1's closing paragraph asks for this removal and Phase A's global
   constraints forbade it - this is where it belongs.

3. **The harness needs a replacement immediate-send vehicle BEFORE item 2.**
   `confirmation` is the suites' only immediate-send vehicle: roughly 40 sites
   in `app/test/tourReminders.test.ts` and roughly 14 across
   `e2e/tests/scenarios/scheduled-visibility.spec.ts`,
   `e2e/tests/tour-roster.spec.ts` and `e2e/tests/scenarios/tours.spec.ts` ride
   its `dueAt = now`. No armed rung can substitute, because a rung already due
   at arm time writes no row. Most likely a dev seam that arms a row with an
   arbitrary dueAt. Budget for it rather than discovering it.

4. **The quiet-hours exemption hook (spec 7.3) was CUT from Phase A and still
   needs designing at BOTH sites** - the arm-time clamp AND the fire-time
   backstop. A design that covers only one of the two re-opens the hole it
   exists to close.

5. **The founder's open `en_route`-exemption question (spec 12.1).** Whether to
   exempt `en_route` from quiet hours for 8-9am tours. Moot while the pause
   holds, so it is a Phase B product question; this entry is the registry record
   of the deferral that spec 12 asks for rather than relying on a spec line.

6. **In-flight rows are NOT re-armed, so they begin firing on unpause under the
   OLD timings (spec 9.3).** Rows armed before 2026-08-26 keep their stored
   dueAts and gain the NEW copy, for one booking horizon. Nothing re-arms them
   and nothing should; the consequence just has to be expected rather than
   diagnosed as a bug when the first `day_before` fires at the old
   `scheduledAt - 24h`.

7. **THE UNBOUNDED NAMES-READ RE-LIST - the one item that is a real hazard, not
   a chore.** When name resolution keeps failing for a rung whose copy needs the
   name, the poll leaves that rung UNCLAIMED and returns (the
   `ReminderNamesUnavailableError` backstop in `app/src/jobs/tourReminders.ts`).
   There is NO self-clearing bound: a permanently failing read re-lists every
   tick forever. Its nearest twin, `roster_unavailable`, was bounded PRECISELY
   because the repo's own comment says a rung that re-lists forever "is never
   sent and never says so"
   (`app/src/repos/tourRemindersRepo.ts`, the `roster_unavailable` docblock).
   This is acceptable ONLY while the manual-only filter keeps the production
   poll off those rows - and THAT ACCEPTANCE EXPIRES WITH THE PAUSE. Before
   lifting it, either bound the re-list (which needs a new skip-reason ruling -
   spec 8.2 granted exactly one token, `booked_too_late`, and it is not this)
   or re-accept the unbounded shape explicitly, in writing. Do not let this one
   ride through unpause by default.

8. **NEW IN PHASE A, NOT INHERITED - a `confirmation` retired citing a rung
   that never armed.** Read this item as a consequence PHASE A INTRODUCED. An
   earlier draft of this ledger (and the plan it came from) called it
   PRE-EXISTING, justified by "`app/test/seedLive.test.ts` already pinned a
   `confirmation` superseded by a silently-dropped `morning_of`". That
   justification was checked at the merge base and is FALSE; it is corrected
   here so Phase B does not file this under old news.

   THE DEFECT. `supersededBySlot` (`app/src/jobs/tourReminders.ts`) asks only
   whether a LATER rung's CLAMPED dueAt equals mine and lands before the tour
   start. It cannot see that the later rung was itself retired by the new rule
   (e), so the earlier rung is retired `quiet_hours_superseded` - the panel chip
   "superseded by a later reminder" - while the rung it names sits beside it
   reading "booked too late for this reminder".

   WHY IT COULD NOT ARISE AT THE MERGE BASE `440dc75e`, so nobody re-derives it:
   `git show 440dc75e:app/test/seedLive.test.ts` pins TOUR-A's pending set as
   `['en_route', 'morning_of']` and asserts `morningOf.skippedAt` is
   `toBeUndefined()` - that superseder was ALIVE and would have fired. Nor could
   the general case happen there: `confirmation`'s raw dueAt is `now` and
   clamping only moves it FORWARD, so its clamped dueAt is always `>= now`,
   while the base's only silent drop (the past-dueAt branch) always has
   `dueAt < now` - the two can never be equal - and `supersededBySlot` already
   excludes `past_event` rungs. So before rule (e), a confirmation retired
   `quiet_hours_superseded` ALWAYS cited a rung that really armed.

   REACHABLE BAND - MEASURED, not reasoned. An earlier revision of this
   paragraph reasoned the band out from `morning_of` alone and got three things
   wrong; it was replaced with the results of an exhaustive sweep of
   `armTourReminders` (every tour local hour 00..23, arm instants walked back
   minute by minute over 12 hours, EDT and EST, quiet window ON / OFF /
   `start:'19:00'`), classifying every rung retired `quiet_hours_superseded` by
   whether its same-slot superseder was itself retired.

   - Arming inside the quiet window is NOT required. Corpses occur with
     `quietHoursEnabled: false`: clamping is only one route to a slot
     collision, and `confirmation.dueAt` is literally `now`, so it collides
     with any rung whose RAW dueAt equals the arm instant.
   - There are TWO corpse families, not one. Besides
     `confirmation <- morning_of:booked_too_late`, rule (e) also retires
     `day_before`, which has a FIXED 19:30 org-local anchor - giving
     `confirmation <- day_before:booked_too_late` on the EVENING side, at every
     tour hour, window disabled included.
   - Under the DEFAULT window the wide contiguous band is tours 10:00-12:00
     local, not "roughly 08:00-12:00": 10:00 tours corpse for arm instants
     04:01-08:00 local (240 min), 11:00 for 05:01-08:00 (180 min), 12:00 for
     06:01-08:00 (120 min). 08:00 and 09:00 tours produce NO corpse - both
     rungs clamp at/after the tour start and go `past_event`, which
     `supersededBySlot` already excludes. Every other tour hour collides only
     on a millisecond-exact instant.
   - THE PART THAT MATTERS: `quietHoursStart: '19:00'` is a SUPPORTED setting
     that this very branch deliberately refuses to validate (spec 7.1 - "quiet
     hours are a general setting and must not be constrained by one rung"), and
     it is the config `tourReminders.test.ts` case 8 exercises. Under it 19:30
     is inside the window, so EVERY `day_before` clamps onto the 08:00
     tour-morning slot - the same slot a pre-08:00 arm instant clamps the
     confirmation to. Measured band: tour 13:00 local corpses for arm
     01:00-08:00 (about SEVEN HOURS), tour 14:00 for 02:00-08:00, and so on
     across tour hours 10:00-20:00, taking the confirmation down with every
     `day_before`. So for such an org this is a daily occurrence, not an edge.

   A millisecond-exact collision still matters in practice: `armTourReminders`
   takes `now` as a parameter and `routes/tours.ts` threads `deps.now`, so
   seeds, fixtures and any injected clock land on round instants routinely.

   A FIX MUST COVER BOTH PREDICATES, not just the one named above.
   `supersededInBatch` (the RELEASE-time twin) has the identical blind spot and
   is weaker still - it carries no armability check at all. A Phase B fix scoped
   to `supersededBySlot` alone fixes half the problem.

   WHY IT SHIPPED UNFIXED: spec 8.1 puts the cross-rung supersession machinery
   OUT OF SCOPE for Phase A in terms, and the fix - requiring a superseder to be
   genuinely armable - reorders rule evaluation, which is exactly the change
   spec 8.1 warns reopens the vanishing-row problem the precedence exists to
   solve. That belongs in a Phase B design with its own review, not bolted on at
   a Phase A handback.

   PHASE A IMPACT IS BOUNDED BY THE PAUSE. Nothing auto-sends, so what is lost
   today is a chip naming the wrong cause plus the Send now button on that
   confirmation (a skipped row is terminal: `forceSendReminder` returns
   `not_pending`). Note the interaction with item 2 - removing `confirmation`
   from `REMINDER_KINDS` at unpause retires THIS case, because a rung that never
   arms cannot be superseded. That is not a fix to the machinery, and Phase B
   should say which of the two it is doing rather than let the symptom
   disappear and the predicate stay wrong.

9. **The failure-scope derivation reads catalog DEFAULTS only.**
   `reminderNamesUsed` in `app/src/messages/tourCopy.ts` derives which name
   reads a rung's copy actually renders by inspecting the catalog TEMPLATES -
   and it inspects the DEFAULT template, not an effective one. The matching
   `TODO(tour-reminder-ladder-phase-b)` marker sits on its docblock. Safe today
   because no `tour.*` override can exist (`settingsToOverrides` maps two
   non-tour ids, and no tour compose site passes `overrides`), but
   `ComposeTourReminderInput.overrides` already exists on the signature. The day
   a generic override map lands, the derivation must widen to the EFFECTIVE
   template, or an operator override could add a name token that the failure
   semantics never learn about - and the send/preview posture would silently
   stop matching the copy it is protecting.

   SAME CLASS OF HAZARD, filed separately and worth taking in the same pass:
   [`tour-copy-where-token-declared-not-passed`](./tour-copy-where-token-declared-not-passed.md).
   There the mismatch runs the other way - `{where}` is DECLARED on the four
   twin-less tour entries but the composer passes it only when a street exists,
   so putting `{where}` back into one of those defaults throws a bare `Error`
   past every containment block for an addressless unit. Both items are a
   declaration the surrounding code does not honor for every input.

**Suggested fix.** Phase B is its own feature mission. Order matters at the
front: item 1 before item 2, item 3 before item 2, and item 7 decided (bounded
or re-accepted in writing) before the pause lifts. Item 8 is the one entry here
that Phase A INTRODUCED rather than inherited, and it must be DECIDED alongside
item 2 - not left to be silenced by it - so give it a real slot rather than
leaving it in the tail. Items 4, 5 and 9 can land in any order but should each
be closed or explicitly re-deferred in the Phase B handback rather than silently
inherited a third time.
