# Slice 5 report - Task 9 (stop arming `confirmation`)

STATUS: SHIPPED. One commit. Every required check green.

## Commit

| hash | subject |
|---|---|
| `ab0459af` | `feat(reminders): confirmation no longer arms` (13 files, +337/-217) |

## Tests / gates run (exit codes + counts)

| command | exit | result |
|---|---|---|
| `app$ npx vitest run <6 target files>` (RED probe, before edits) | 1 | 412 pass / **28 fail** |
| `app$ npx vitest run <6 target files + seedMatrixCoherence>` (after) | 0 | 478 passed, 7 files |
| **`app$ npx vitest run` FULL** | **0** | **6328 passed / 9 skipped, 347 files + 1 skipped** |
| root `npm run typecheck` | 0 | clean |
| `e2e$ npx tsc --noEmit -p .` | 0 | clean |
| `npx eslint <13 touched files>` | 1 | **3 errors, ALL PRE-EXISTING** + 6 pre-existing warnings |

Logs: `.superpowers/sdd/logs/s5-red1.log`, `s5-red2.log`, `s5-full-app.log`,
`s5-typecheck.log`, `s5-eslint.log`, `s5-eslint-base.log`. No Playwright run.

### Gate 5 attribution (baseline-compared by stashing the two files)

- `app/src/lib/seed/live.ts` - `overdueAt` / `followUpAt` assigned but never used.
  Present at baseline at `:128,:130`; my comment edits shifted them to `:129,:131`.
  **This is the exact line-number trap AGENTS.md warns about - attributed by
  baseline, not by line.**
- `app/src/lib/seed/matrix.ts:134` - `DEADLINE_TYPES` used only as a type.
  Byte-identical at baseline.
- 6 warnings, all `Unused eslint-disable directive (no-console)`: two each in
  `quiet-hours.spec.ts`, `scheduled-visibility.spec.ts`, `tours.spec.ts`. Slices
  2/3/4 recorded the same pair; I touched three such files, hence six.

Nothing new. None fixed (unrelated errors in a shared repo are their own change).

## Shipped

### Production

- `jobs/tourReminders.ts` `REMINDER_KINDS` is now `['day_before','morning_of',
  'en_route']`, with a comment mirroring the `no_show_checkin` note: the kind
  stays in `ReminderKind`, `computeDueAt`, `LADDER_ORDER` and the catalog so
  in-flight and seeded rows compose, sort and display; arming stopped 2026-08-31
  (founder 2026-08-24); SENDING is separately guarded by
  `DISCONTINUED_REMINDER_KINDS`. `REMINDER_KIND_LABELS.confirmation` untouched in
  both mirrors (`dashboard/src/api/types.ts`, `steps.ts:246`).

### Seeds (R6)

- `matrix.ts` - row KEPT (SENT/historical). Both comments rewritten to say WHY it
  is kept: arming stopping does not un-send what already went out.
- `live.ts` - four sites: header "four auto-armed rungs" -> three; TOUR-B block
  comment; TOUR-A and TOUR-B arm comments; TOUR-C's "all FOUR" (which the plan
  omitted and report B caught).
- `lean.ts` - the confirmation-clamp sentence re-derived onto day_before (the
  `quietHoursEnabled:false` setting stays, and its argument stands: day_before at
  19:30 org-local still moves under a window with an earlier start).
- `cast.ts` - untouched, as ruled.

### Unit re-baselines (cat2) - every one RE-DERIVED, none flipped blind

`tourReminders.test.ts`
- all-4-rows arm -> "creates all 3", `toHaveLength(4)`->3 x2, confirmation dueAt
  pin replaced by an explicit `toBeUndefined()`.
- no_show guard `toHaveLength(4)`->3.
- Test 1c (late-evening): dropped the confirmation dueAt line; 4 VISIBLE ->3,
  3 live ->2.
- Test 1d (en_route supersedes morning_of): live set `['day_before','en_route']`.
- Test 1f (clamped-past-start): live set `['day_before']`.
- Test 1g (retimed day_before): creation-order live list `['day_before']`.
- Test 1h (quiet OFF): 4 ->3. Test 1i (settings failure): live 3 ->2.
- reschedule: origRows 4->3, newRows 4->3.
- `cancelTourReminders`: the "one already fired" row is now `day_before`
  (`confirmRow`->`sentRow`, `confirmAfter`->`sentAfter`).
- same-day booked_too_late: `armedKinds).toContain('confirmation')` ->
  `rows.map(kind)).not.toContain('confirmation')`, comment re-derived to say
  en_route is now the whole surviving ladder.
- booked-too-late case 3: `confirmation.skippedAt undefined` -> `toBeUndefined()`
  on the ROW.
- booked-too-late case 9: dropped the confirmation dueAt/skippedAt pair,
  `rows).toHaveLength(3)` -> 2, and the comment now states the case's real point
  (the two booked_too_late traces are the whole ladder; en_route's silent drop is
  the only rung with no row).

`toursApi.test.ts` (10 sites)
- cases 7a/7b pending set `['confirmation','en_route']` -> `['en_route']`;
  7b's "four clean rungs" -> three.
- **THE THREE `dueAt === FIXED_NOW` SITES ARE A REAL COVERAGE HOLE, not a
  deletion.** Those tests are named "the injected clock produces assertable
  dueAts", and the confirmation rung WAS the clock: every other rung's dueAt
  derives from `scheduledAt` alone, so removing it would have left three tests
  named for a seam they no longer touch. Re-derived: `now` still reaches the
  armer through the arm-time SKIP rules, and on the real wall clock these July
  2026 fixtures are long past - so every row would be born
  `booked_too_late`/`past_event`. Each site now asserts `skippedAt === undefined`
  across the armed rows, which fails loudly if the seam breaks. The 4th site
  (`:2828`, the quiet-END boundary) is re-pointed with a note that
  `tourReminders.test.ts` pins that boundary on its own.

`relayApi.test.ts` (7 sites + 3 ladder pins)
- upcoming-rungs test: 4->3, first rung `confirmation`->`day_before`, body marker
  `'your tour is set for'` -> `'confirming your tour tomorrow at'` (day_before's
  catalog lead-in), and the fire-one-rung half now claims `day_before` (3->2).
- uncomposable-tour test: 4->3, kind list drops confirmation.
- withhold test: 4->3, and the anti-vacuity partner moved from `confirmation` to
  `morning_of` (a live kind that also never touches the property read).
- **The T8 discontinued-suppression test now CREATES its confirmation row
  directly** (`tourRemindersRepo.create`, dueAt = the old arm instant). It has to:
  the surface exists precisely for rows armed BEFORE arming stopped, and after
  T9 the seeder cannot produce one. Comment at the site says so.

`seedLive.test.ts`
- local `REMINDER_KINDS` drops confirmation (comment re-derived to name BOTH
  never-armed kinds). The `ReminderKind` type and `computeDueAt`'s confirmation
  case stay (R14's lockstep clone).
- TOUR-A "has reminder rows" comment re-derived.
- TOUR-A test renamed (`...and confirmation is superseded` dropped); the
  `quiet_hours_superseded` assertion replaced by an explicit
  `find(kind==='confirmation') === undefined`, so the case still says something
  about the kind rather than going silent on it.
- TOUR-B: `toBe(4)`->3, pending set to the three live kinds, comment re-derived,
  and the STALE TITLE finally made true - it has said "3 rungs" since the
  en_route retiming while asserting 4.

## E2E - every assertion changed, one line each (the orchestrator's full e2e is
## the first pass/fail signal for these)

`scheduled-visibility.spec.ts`
1. `:114` `('confirmation','next')` -> `('day_before','next')` - `next` is the
   earliest-dueAt upcoming row and day_before inherits that place.
2. `:115` `('day_before','upcoming')` DELETED - subsumed by (1); a row cannot be
   both, and asserting both would be a contradiction, not a strengthening.
3. `:127-134` "The four rungs asserted upcoming above" -> three, re-derived.
4. `:163` bare `tickTourReminders()` -> `justAfter(await
   armedReminderDueAt('day_before'))` - a bare wall-clock tick fired the
   arm-instant rung and nothing else; with that rung gone it fires nothing, and
   the lane's live 30s worker makes a bare tick unsafe anyway.
5. `:165` `('confirmation','sent')` -> `('day_before','sent')`.
6. `:166` `('day_before','upcoming')` -> `('morning_of','upcoming')` - the
   "a later rung the tick left untouched" role moves up one.
7. `:204-205` supersession comment: day_before is now the earliest rung, so
   nothing shares its batch.
8. (c) `:226` bare tick -> `justAfter(armedReminderDueAt('day_before'))`.
9. (c) `:227` `expectReminderTo1to1('confirmation')` -> `('day_before')`.
10. (c) `:229` `('confirmation','sent')` -> `('day_before','sent')`.
11. (c) `:230` `('day_before','upcoming')` -> `('morning_of','upcoming')`.
12. (c) `:249` `('day_before','canceled')` -> `('morning_of','canceled')` - the
    setup tick now SENDS day_before, and a sent row is not cancelable, so the
    canceled-row assertion had to move to a rung still pending at reschedule.
13. (c) `:250` `('confirmation','next')` -> `('day_before','next')` - two rows
    share the label (old SENT + fresh NEXT); the state filters disambiguate,
    which `expectReminderRung`'s docblock explicitly covers.
14. (c) `:258` bare tick -> `justAfter(armedReminderDueAt('day_before'))`;
    `armedReminderDueAt` filters on `state === 'upcoming'`, so it reads the FRESH
    row, not the sent one.
15. (c) `:259` arrival assertion `('confirmation')` -> `('day_before')` - the body
    composes off the NEW time, so its arrival at all is still the re-arm proof.
16. (c) `:232-246` the 2026-08-26 re-derivation comment rewritten in the same
    shape, naming both moved halves (which row is canceled, which is next).

`tours.spec.ts`
17. `:317` bare tick -> `justAfter(armedReminderDueAt('day_before'))`;
    `:318` `('confirmation')` -> `('day_before')`. Same treatment as (c), with a
    comment pointing at its twin.
18. `:12` file-header bullet: booking no longer FIRES anything, it ARMS.

`tour-roster.spec.ts` (R8)
19. Booking `+5d` -> `+48h` (the horizon the tour specs already tick).
20. The ladder GET now finds `day_before`, not `confirmation`; the tick is
    `justAfter` its stored dueAt; the throw message follows.
21. The chip assertion filters on `REMINDER_KIND_LABELS.day_before`.
22. The timing comment re-derived: the old "a far-future `now` never belongs
    here" warning defended the ARM-INSTANT trick (tick stayed at ~now). With no
    arm-instant rung left, a future global tick is unavoidable and is already the
    suite's standard vehicle; the +48h booking keeps its reach as short as the
    rest. The stale `steps.ts:3277` cross-ref is replaced by a name-based one,
    and the "60s poll" claim is gone with the sentence that carried it.
23. Checked the rest of that file: nothing else depended on the +5d booking.

`tour-no-show-checkin.spec.ts`
24. `:77-79` confirmation bullet DELETED; the no_show_checkin bullet now names
    both never-armed kinds and keeps the old derivation as history. Conclusion at
    `:89` survives verbatim. The count assertion at `:108-111` is a
    BEFORE/AFTER DELTA (`toBe(outboundBefore)`), not a row count, so it needed no
    re-derivation - confirmed by reading it, not assumed.

`quiet-hours.spec.ts`
25. `:57-61` parenthetical rewritten: the defer batch now holds `day_before`
    alone. Surrounding argument untouched.

`steps.ts` - nothing owed. Slice 3 already rewrote `tourSchedule`,
`tickTourReminders`, `teamReschedulesTour` and `requireTourReminderContext`, and
fixed the 60s->30s claim. Verified by reading, not by trusting the report.

## DIVERGENCES from the plan / worklist

1. **R7 (guards g3/g3b) was NOT mine to do.** Slice 4 did it - T7 is what broke
   them, not T9. Verified in the tree: both now ride `day_before` and are green.
   Nothing further owed.
2. **`toursApi.test.ts`'s three `FIXED_NOW` pins gained a NEW assertion** rather
   than just losing one (see above). Without it three tests would keep a name
   they no longer earn.
3. **`relayApi.test.ts`'s discontinued test creates its row directly.** The
   worklist listed it as a plain cat2 re-baseline; it is not - it needs a
   confirmation row to exist, and after T9 only a direct write can produce one.
4. **`scheduled-visibility.spec.ts` Part A lost one assertion** (`day_before`
   upcoming) because `next` supersedes it. Net panel coverage is unchanged:
   day_before/morning_of/en_route are still all asserted.
5. **`tourReminders.test.ts` Test 1e was re-pointed at `morning_of`, not
   `day_before`.** The brief allowed either "whichever the arm-time clamp still
   applies to". Derived: with the default 21:00-08:00 window, day_before's 19:30
   org-local raw time never clamps at all; `morning_of` (scheduledAt - 4h) does,
   on an early-morning tour. The fixture moved to a 10:00-EST tour so
   morning_of's raw 06:00 EST clamps forward to 08:00 - landing clear of both the
   start and en_route's slot, so it ARMS. That is the CLEAN clamp, the one
   outcome its two neighbours (Test 1d superseded, Test 1f past_event) do not
   cover; without it a clamp that silently did nothing would pass all three.

## Open worries - not blocking, your eye

- **Every reminder e2e now drives a FUTURE global tick.** That was already true
  of `tours.spec.ts` and `scheduled-visibility.spec.ts` after slice 3; this slice
  makes it true of `tour-roster.spec.ts` too, because the last near-now vehicle
  (the arm-instant rung) is gone. The tick fires every due row in the lane, so
  cross-spec interference is bounded only by arrival assertions being
  phone/tour-scoped. Nothing here is new in KIND, but the blast radius grew.
- **`scheduled-visibility.spec.ts` (c) now ticks ~2.8 days out** (the fresh +72h
  ladder's day_before). Derived safe at any wall clock: `now+72h` puts day_before
  at 19:30 org-local on D+2, always earlier than morning_of at `tour-4h` and
  en_route at `tour-1h`, so the asserted rung is alone in its batch. Checked at
  both ends of the day (02:00 and 21:00 local booking instants).
- **`tour-roster.spec.ts` half 2b sends a REAL text now.** Before, the
  arm-instant rung it drove was claim-SKIPPED (that is the whole point - the
  chip). Still true on day_before: the tenant is off the roster, so the rung is
  claim-skipped, not sent. Flagging because the rung changed and the outcome
  depends on the roster state persisting across the booking PATCH, which the
  block's step 1 establishes.
- `matrix.ts`'s kept confirmation row means `seedMatrixCoherence.test.ts` still
  exercises a confirmation row end to end. Green (run in s5-red2).
- The lean seed's `quietHoursEnabled:false` argument is now carried by
  `day_before` alone. It still holds, but it is weaker than it was: day_before
  only moves under a window whose START is earlier than 19:30, whereas the
  arm-instant rung moved under the DEFAULT window at night. If someone later
  argues the lean seed can turn quiet hours back on, that is the sentence to
  re-derive, not to trust.
