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

8. **The cosmetic superseded-by-a-skipped-rung chip.** `supersededBySlot`
   consults the clamped dueAt map without asking whether the LATER rung was
   itself retired, so a chip can read "superseded by a later reminder" while
   pointing at a `booked_too_late` row. PRE-EXISTING behaviour, not introduced
   by Phase A - `app/test/seedLive.test.ts` already pinned a `confirmation`
   superseded by a silently-dropped `morning_of` - but the new VISIBLE skip rows
   make it much easier to notice. A fix would require the later rung to be
   genuinely armable, which spec 8.1 put out of scope for Phase A.

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

**Suggested fix.** Phase B is its own feature mission. Order matters at the
front: item 1 before item 2, item 3 before item 2, and item 7 decided (bounded
or re-accepted in writing) before the pause lifts. Items 4, 5, 8 and 9 can land
in any order but should each be closed or explicitly re-deferred in the Phase B
handback rather than silently inherited a third time.
