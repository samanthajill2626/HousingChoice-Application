# Slice 5 - Task 9 (stop arming `confirmation` + cat-2 re-baselines + seeds + the two e2e anchor REDESIGNS)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-5.md`
Research: report A section 4 (cat2 rows per file), report B section 7 (seeds + `seedLive.test.ts`
pins) and section 8, report D section 4 (e2e sites with the redesign derivations quoted in
full: `scheduled-visibility.spec.ts:104-167,217-260`, `tour-roster.spec.ts:480-523`,
`tours.spec.ts:290-300`, `tour-no-show-checkin.spec.ts:77-89`). Also READ
`.superpowers/sdd/confirmation-conversion-worklist.md` (slice 3's per-site table - the cat2 /
redesign rows are yours) and reports slice-3 / slice-4 (what already moved: R7 guards g3/g3b
are DONE; `devGating`, `quiet-hours.spec.ts` are DONE; the unit vehicle `createDueReminder`
exists; `steps.ts` gained `upcomingReminderKinds`, `expectRungsRetiredPastTour`, and the
`/Skipped/` filter on 'upcoming').

Scope: plan Task 9 steps 1-3 (+ step 4's FULL app suite; the orchestrator runs the FULL e2e
after you return - you do NOT run Playwright, but every e2e file you touch must compile:
`cd .../e2e && npx tsc --noEmit -p .`).

Binding deltas (worklist s1 R6, R8; s2 T9):
- `REMINDER_KINDS` loses `'confirmation'` with a comment mirroring the `no_show_checkin`
  note: kind stays in `ReminderKind` / `computeDueAt` / `LADDER_ORDER` / catalog so in-flight
  and seeded rows compose and display; arming stopped 2026-08-31 (founder 2026-08-24);
  sending is separately guarded by `DISCONTINUED_REMINDER_KINDS`. `REMINDER_KIND_LABELS.
  confirmation` STAYS in `dashboard/src/api/types.ts` and `steps.ts:246`.
- RE-DERIVE every red site, never flip blind: arm-set pins drop `confirmation` (the whole
  auto ladder is now THREE rungs); "next rung" assertions shift to `day_before`; `toHaveLength(4)`
  -> 3 where it counts armed rungs. Files beyond the plan's list: `relayApi.test.ts
  ~:1469,1581,1585,1679`, `toursApi.test.ts ~:1341-1378,1507-1508,1546-1547,1695,2828-2830`,
  `seedLive.test.ts ~:86-95,168-259` (test `:186-221` is titled "confirmation is superseded"
  - redesign: pending set stays `['en_route']`, morning_of/day_before keep `booked_too_late`;
  TOUR-B title already says 3 - make the count/set match), `tourReminders.test.ts` cat2 rows
  (`:222-228,285,338,358-410,483,526,1236-1254,1301-1302,1427,1544-1547`) and its two
  REDESIGNS: `:414-437` ("a confirmation armed inside quiet hours is clamped to quiet-end" -
  re-point the subject at `day_before` or `morning_of` whichever the arm-time clamp still
  applies to, keeping the clamp assertion meaningful) and `:1556-1579` (`listDue` excludes
  sent/canceled - rebuild on rows created directly with `createDueReminder`).
- Seeds (R6): `matrix.ts:983-992` seeds a SENT confirmation - KEEP the row; rewrite ONLY the
  comments at `:879-881` and `:983`. `live.ts:9-12,504-513,522-527,536-537`: "four auto-armed"
  -> three; drop armed-at-now confirmation expectations. `lean.ts:420-427`: rewrite the
  confirmation-clamp sentence (the `quietHoursEnabled:false` setting stays). `cast.ts` KEEP.
  Run `npx vitest run test/seedLive.test.ts test/seedMatrixCoherence.test.ts` (+ any other
  seed suite grep finds) after.
- E2E REDESIGNS (read report D s4.3-4.5 derivations first):
  * `scheduled-visibility.spec.ts` Part A (`:104-167`): the NEXT rung after booking is
    `day_before`; the sent-state walk ticks `justAfter(await flow.armedReminderDueAt('day_before'))`
    and asserts `('day_before','sent')`; re-derive the `:127-134` "four rungs" comment to three.
  * `scheduled-visibility.spec.ts` (c) (`:217-260`): rebuild the re-arm proof on `day_before`
    per report D s4.3's derivation: the setup tick makes the OLD day_before SENT (so the
    `'canceled'` assertion at `:249` moves to `morning_of`, which the reschedule cancels);
    after the reschedule to `tourSchedule(72)` the fresh `day_before` is NEXT; the proof is a
    FUTURE tick `justAfter(armedReminderDueAt('day_before'))` with arrival asserted (body
    composed off the NEW time - use the existing body-marker/time idiom in the file). Re-derive
    the 2026-08-26 re-derivation comment (`:232-246`) in the same shape.
  * `tours.spec.ts:290-300` (the second re-arm proof): same treatment as (c).
  * `tour-roster.spec.ts:480-523` (R8): rebook that test's tour at `tourSchedule()` (+48h, the
    horizon `tours.spec.ts` already ticks), read `day_before`'s stored dueAt from the same
    `/reminders` GET and tick `justAfter` it; assert the `Skipped - <tenant_not_on_roster>`
    chip on the `day_before` row (`REMINDER_KIND_LABELS.day_before`). Re-derive the timing
    comment (its "far-future never belongs here" sentence was about the arm-instant trick);
    fix the stale `steps.ts:3277` cross-ref and the "60s" -> 30s. Check the rest of that file
    for anything that depended on the +5d booking.
  * `tour-no-show-checkin.spec.ts:77-89`: delete the confirmation bullet; conclusion survives;
    keep the count assertion at `:108-111` (re-derive its expected count if it counted rows).
  * `quiet-hours.spec.ts:57-61`: rewrite the confirmation parenthetical (the defer batch now
    holds `day_before` alone); keep the surrounding argument. `steps.ts:289-290` only if slice
    3 left a confirmation sentence there (grep `confirmation` in steps.ts and fix any comment
    that still claims it arms).
- Every pending-rung ('upcoming'/'next') assertion you write in e2e must be on a rung whose
  dueAt is far-future at spec runtime (the lane's 30s worker is now a live sender).

Verify: `cd .../app && npx vitest run` FULL (timeout 600000) - PASS; `npm run typecheck`;
`cd .../e2e && npx tsc --noEmit -p .`; `npx eslint <touched ts files>` (report pre-existing
vs new by baseline). ONE commit: `feat(reminders): confirmation no longer arms`. In your
report, list EVERY e2e assertion you changed with the derivation in one line each - the
orchestrator's full e2e run is the first pass/fail signal for them.
