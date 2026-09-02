# Slice 3 - Task 5 (unit immediate-send vehicle + confirmation ride conversion) + Task 6 (e2e vehicle conversion + live-worker audit)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-3.md`
Research: report A section 4 (THE DERIVED per-site classification for all eight app test
files, with each cat1 site's now/scheduledAt pair - your Task 5 step 1 is largely done; verify
each row against the live file and record outcomes); report D sections 3-5 (e2e vehicle
mechanics, the 13 e2e code sites + 8 comment sites, live-worker audit prep).
Prior slices: tokens (@26f73e3b); predicate + gate + force-send refusal + two new steps.ts
verbs `upcomingReminderKinds` / `expectRungsRetiredPastTour` and a rewritten
`tours.spec.ts:282-288` block (@0172bf88); sweep script (@3307afe0). Read
`.superpowers/sdd/reports/slice-2.md` divergence list - notably `tourRemindersApi.test.ts`
send-now fixtures were re-dated to 2099 because a hardcoded 2026-07 tour had rotted into the
past under the new gate. Watch for the same rot in any fixture you convert.

Scope: plan Task 5 (steps 1-5) and plan Task 6 (steps 1-5). Files: `app/test/tourReminders.test.ts`
(+ the other seven app test files ONLY where report A s4 marks a cat1 site), `e2e/tests/scenarios/
tours.spec.ts`, `e2e/scenarios/steps.ts`, and the conversion worklist file
`.superpowers/sdd/confirmation-conversion-worklist.md` (run state, not committed).

Binding deltas (worklist s1, s2 T5/T6; rulings R12):
- THIS SLICE CHANGES NO PRODUCTION CODE. Confirmation still arms and the manual-only set is
  still full; every converted test must be GREEN at your commit against the CURRENT tree.
- Task 5 helper `createDueReminder(repo, tourId, kind, dueAt)` exactly as the plan's Interfaces
  block, with its 6.1a-precondition docblock. Convert every cat1 site in report A s4a (and the
  cat1 rows in s4b `:1003,1025`, s4f is Task 7's - leave `devGating.test.ts` alone). For each,
  the replacement dueAt must satisfy `dueAt < scheduledAt` AND `dueAt <= tick now`; update
  asserted bodies from `rungBody('confirmation', ...)` to the new kind's body. Cat1 FORCE rides
  (`:2523,:2851,:3240`) -> `seedForceTour` with a live kind (`day_before`). Leave every cat2 /
  redesign / keep row untouched (Task 9 owns them) - list them in the worklist file with the
  category so Task 9 inherits the table.
- Task 6 cat1 sites: `tours.spec.ts:130-133,199-200,242-244,279-280` -> replace the bare
  `flow.tickTourReminders()` + `expectReminder*('confirmation', ...)` with
  `await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')))` +
  the same expectation on `'day_before'`. Ticking `day_before` (the EARLIEST live rung) pulls
  no earlier same-tour rung into the batch, so no supersession side effect arises - state
  that in a one-line comment at the first converted site rather than asserting a retirement
  that cannot happen. Check what follows each converted site: a later tick in the same test
  (e.g. `:149` `justAfter(times.enRoute)`, `:255`) now finds `day_before` already SENT - fine,
  but re-derive any comment that assumed the confirmation was the sent one.
  DO NOT touch the cat2/redesign sites (`scheduled-visibility.spec.ts`, `tours.spec.ts:290-300`,
  `tour-roster.spec.ts:480-523`, `tour-no-show-checkin.spec.ts:77-89`) - Task 9.
- R12: in `steps.ts` `expectReminderRung` (`~:3513`), the `'upcoming'` branch adds
  `.filter({ hasNotText: 'Skipped' })` so a skipped row can no longer satisfy an 'upcoming'
  assertion. Extend its docblock with one sentence saying why.
- steps.ts comment rewrites (ASCII on touched lines; the file is otherwise non-ASCII):
  `:289-290` (`tourSchedule` docblock: confirmation sentence -> say the ladder's earliest
  live rung is `day_before`, read its dueAt via `armedReminderDueAt`), `:2033-2038`
  (`tickTourReminders` docblock: the future-rung idiom is the PRIMARY use; omitting `now`
  fires only what is due on the wall clock), `:1712` and `tour-roster.spec.ts:493` if you
  touch it (60s -> 30s; the worker poll is `WORKER_POLL_INTERVAL_MS` default 30000),
  `:2248` (`teamReschedulesTour`: re-arm proof now rides `day_before`), `:3596`
  (`requireTourReminderContext`: the "verified" claim - re-verify against your converted
  tours.spec.ts and state what it now asserts).
- Task 6 step 2a LIVE-WORKER AUDIT: with the pause lifted in Task 7 the e2e lane's real
  worker (30s poll) becomes a live sender. Audit every spec listed in report D s5.3 and
  record per spec in the worklist file: each pending-rung assertion, its fixture dueAt
  offset, SAFE / AT-RISK, and (for AT-RISK) what you changed. Report D s5.5 has the
  expected verdicts - verify, do not copy. The rule: rungs meant to stay upcoming ride
  far-future fixtures (`tourSchedule(72)` / `tourScheduleFullLadder()`), never near-now.
- Do NOT run Playwright. `cd .../e2e && npx tsc --noEmit -p .` must be green.

Verify: `cd .../app && npx vitest run test/tourReminders.test.ts test/tourRemindersApi.test.ts
test/toursApi.test.ts test/contactTimeline.test.ts test/relayApi.test.ts test/devGating.test.ts
test/placementConvert.test.ts test/seedLive.test.ts` (PASS - nothing production-side changed);
`npm run typecheck` (root); e2e tsc. Two commits: `test(reminders): immediate-send vehicle
replaces confirmation rides` and `test(e2e): reminder specs ride the future-rung tick vehicle`.
