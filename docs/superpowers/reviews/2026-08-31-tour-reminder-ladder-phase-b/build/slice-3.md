# Slice 3 report - Task 5 (unit immediate-send vehicle) + Task 6 (e2e vehicle + live-worker audit)

STATUS: both tasks SHIPPED. Two commits, all required checks green. No production
code changed, as the brief requires.

## Commits

| hash | subject |
|---|---|
| `a24cfb95` | test(reminders): immediate-send vehicle replaces confirmation rides |
| `a9019764` | test(e2e): reminder specs ride the future-rung tick vehicle |

`a24cfb95` was AMENDED once, after the fact, to fold in a one-line fix its own
gate-5 run found (`DAY_BEFORE_D11` became unused; `TICK_D11` now derives from it
instead of being a hand-typed twin). The amend kept the slice at the two commits
the brief specifies rather than adding a third for one line.

## Tests / gates run (exit codes + counts)

| command | exit | result |
|---|---|---|
| `app$ npx vitest run test/tourReminders.test.ts` (T5, first green) | 0 | 91 passed |
| `app$ npx vitest run <the eight brief files>` (T5) | 0 | 481 passed (8 files) |
| root `npm run typecheck` (after T5) | 0 | clean |
| `e2e$ npx tsc --noEmit -p .` (after T6 edits) | 0 | clean |
| root `npm run typecheck` (after T6) | 0 | clean |
| `npx eslint <4 touched files>` | 1 -> **0** | 1 error (mine, `no-unused-vars`) fixed; re-run 0 errors, 2 pre-existing warnings (`tours.spec.ts:55,59` unused `no-console` disables - slice 2 recorded the same two) |
| `app$ npx vitest run test/tourReminders.test.ts` (after the lint fix) | 0 | 91 passed |
| `app$ npx vitest run <the eight brief files>` (FINAL) | 0 | 481 passed (8 files) |
| root `npm run typecheck` (FINAL) | 0 | clean |
| `e2e$ npx tsc --noEmit -p .` (FINAL) | 0 | clean |

Logs under `.superpowers/sdd/logs/s3-*.log`. No Playwright run (orchestrator owns e2e).

Per-site classification + outcomes: `.superpowers/sdd/confirmation-conversion-worklist.md`
(run state, gitignored, as the brief specifies).

## Task 5 - what shipped

- `createDueReminder(repo, tourId, kind, dueAt)` at file level in
  `app/test/tourReminders.test.ts`, exactly the plan's Interfaces block including
  its 6.1a-precondition docblock. `TourReminderItem` / `TourRemindersRepo` added
  to the existing repo import.
- Every cat-1 site in report A s4a converted. Three shapes, chosen per site:
  1. **Arm dropped, row created** - the group-routing section (11 cases), both
     concurrency cases, the idempotence case, the emit case, the no_conversation
     claim-skip. These assert where a due rung GOES or how it is claimed; the
     ladder was only ever there to manufacture one due row.
  2. **Kind swap on an existing direct `repo.create`** - the `invalid_schedule`
     case and the group quiet-hours defer. The vehicle was already in place.
  3. **Tick instant moved, arm KEPT** - the whole D11 (contact-rosters) section.
     Report A s4a's own guidance for this block ("on `day_before`: pastGrace =
     2026-08-07T00:31Z < SCHEDULED_D11 - OK") assumes the real armed ladder, and
     the section's cases are about ROSTER resolution against a genuine ladder, so
     a synthetic row would have weakened them. New `TICK_D11` (derived: day_before
     dueAt + 1s) and `MORNING_OF_D11` constants.
- Three force-send rides seed `day_before` through `seedForceTour`; both
  `rungBody('confirmation', ...)` expectations on the headline case move with it.
- `app/test/tourRemindersApi.test.ts`: `seedComposedTour`'s rung -> `morning_of`.

## Task 6 - what shipped

- Four cat-1 sites in `e2e/tests/scenarios/tours.spec.ts` on
  `justAfter(await flow.armedReminderDueAt('day_before'))` + the same expectation
  on `'day_before'`.
- The "no supersession side effect" note is at the first converted site, phrased
  as the INVARIANT rather than the accident (see divergence 2).
- R12 in `steps.ts` `expectReminderRung` + docblock.
- Docblock rewrites: `tourSchedule`, `tickTourReminders`, `teamReschedulesTour`,
  `requireTourReminderContext` (re-verified, not merely re-pointed), and the
  tick-seam comment's 60s -> 30s.
- Live-worker audit recorded per spec in the worklist file (section 4.3).

## DIVERGENCES from plan / worklist - read these

1. **`tourRemindersApi.test.ts` `seedComposedTour` -> `morning_of`, NOT
   `day_before`.** The brief's default replacement kind would have broken the
   case: it ends with an ANTI-VACUITY assertion,
   `expect(preview.body).toContain('412 Sender Way NW')`, and `tour.day_before`'s
   template carries no address token at all. Of the live kinds only
   `tour.morning_of` renders `{addressLine}` (`tour.confirmation` used `{where}`).
   Derived from the catalog, not guessed. **Generalize**: "swap the kind to
   day_before" is not mechanical wherever a body assertion is load-bearing -
   check the template first.
2. **The landlord-led test's two tick blocks were MERGED, not duplicated.** That
   test already ticked `day_before` eight lines below the confirmation block, so
   converting the first block verbatim would have left two identical
   tick-and-assert pairs. Every assertion survives - `expectReminderInGroup` for
   both members AND `expectReminderVisibleInGroupThread` - now on one rung with
   one tick. The brief anticipated the collision ("a later tick ... now finds
   `day_before` already SENT - fine"); merging is the same outcome without the
   dead assertion.
3. **R12's filter is a REGEXP, `/Skipped/`, not the string the ruling names.**
   Playwright's string `hasNotText` matches case-INSENSITIVELY, so
   `hasNotText: 'Skipped'` would ALSO have excluded a genuinely upcoming rung
   whose prediction note reads "Will be skipped - contact opted out"
   (`dashboard/src/api/types.ts` `suppressionNote`). The terminal chip is
   capital-S "Skipped - <reason>". No current spec asserts 'upcoming' on a
   "Will be skipped" row, so nothing was red either way - but T8/T12 add chips to
   these rows, and the string form would have started silently eating them.
4. **D11 section: the arm was kept and the CLOCK moved** (see Task 5 shape 3),
   where the brief's default was a created row. Consequence worth knowing: at
   `TICK_D11` the still-armed `confirmation` (dueAt = arm instant) IS in the
   batch and is claim-skipped `quiet_hours_superseded`. Nothing asserts on it, and
   after T9 it will not exist. The comments I wrote there are phrased to be true
   in BOTH states.
5. **Test 2b (`emits scheduled.updated per claimed rung`) could not keep its
   arm.** Retiming its ticks would have put the armed confirmation in tick 1's
   batch, and a claim-skip ALSO emits `scheduled.updated` - `toHaveLength(2)`
   would have become 3, with `contactId` undefined on the extra one
   (`claimSkipRow`'s tenantId argument is not passed for supersession). This is
   the one case where the arm-vs-create choice was forced rather than stylistic.
6. **`tours.spec.ts` self-guided: the en_route tick's comment was WRONG before
   this slice and is now corrected.** It said earlier rungs "ride along in the
   same tick - unasserted noise". They do not ride along: `morning_of` is in that
   batch and release supersession RETIRES it unsent. Re-derived in place.
7. **Guards g3 / g3b left alone** although report A s4a marks them cat1-FORCE.
   Worklist R7 assigns them to T9 and requires a derivation (does any LIVE kind
   render no name?), not a re-point. Recorded so nobody reads the slice as having
   missed them.
8. **`app/test/devGating.test.ts` untouched** per the brief (s4f is T7's), even
   though report A marks its `:553` case cat1. It is green today.

## Open worries - not blocking, your eye

- **The `tours.spec.ts` reschedule re-arm proof (T9) still ticks bare and asserts
  `confirmation`.** I re-derived its COMMENT (it claimed the fresh confirmation
  was "textually DISTINCT from the first one", and after my conversion there is no
  first one) but left the code, as the brief instructs. `teamReschedulesTour`'s
  docblock now PRESCRIBES the day_before vehicle that spec does not yet use - a
  deliberate forward reference the brief asked for, and T9 closes the gap.
- **The D11 block's global-tick exposure is unchanged but slightly wider.** Its
  ticks moved from 2026-08-05T10:00Z to 2026-08-06T23:30:01Z, so any pending row
  anywhere in the shared table with a dueAt in that 37-hour band now enters those
  batches. I checked: after this slice's arm removals there are none, and every
  such row's tour is in the past by then anyway (the 6.1a gate retires them). It
  is the same class of coupling the file already had.
- **The 30-minute worst case in `tours.spec.ts`'s wall-clock derivation is now
  load-bearing for FOUR tests instead of one.** The derivation (day_before 19:30
  on D-1 vs morning_of at T-4h) is sound and I re-read it, but it assumes host
  zone == ORG_TIMEZONE, which nothing in e2e/ enforces. Pre-existing, flagged by
  the comment itself, not introduced here - but the blast radius grew.
- **`expectReminderRung`'s 'canceled' branch is still a case-insensitive string.**
  Same latent trap as R12's, one branch over; no note today contains "canceled" in
  prose, so it is theoretical. Left alone rather than widening this slice.
- **The self-guided test's `justAfter(times.enRoute)` is a HOST-local mirror.**
  `armedReminderDueAt` exists because host mirrors can be wrong under quiet-hours
  clamping. I did not convert it (not a confirmation site, and it is green), but
  if the lane's org settings ever turn quiet hours ON by default, that tick and
  `times.morningOf` are the two places that would drift before day_before does.
