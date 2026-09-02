# Slice 2 - Task 3 (shared past-tour predicate + fire-time gate + force-send refusal) + Task 4 (retirement sweep script + RUNBOOK)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-2.md`
Research: report A (sections 1-3, 6 - gate order table, forceSend structure, rig idioms,
repo key layout); report D section 1 (sweep precedent frame + integration-test idiom),
section 2 (RUNBOOK model entry), section 4.2 (`tours.spec.ts:282-288` quoted).
Prior slice shipped: `ReminderSkipReason` now has `tour_already_passed | kind_retired |
names_unavailable`; `ForceSendRefusal` has `tour_already_passed | kind_retired` (@26f73e3b).

Scope: plan Task 3 (steps 1-9) and plan Task 4 (steps 1-5). Files: `app/src/jobs/tourReminders.ts`,
`app/test/tourReminders.test.ts`, `e2e/tests/scenarios/tours.spec.ts` (the `:282-288` block only),
`app/scripts/retire-paused-tour-reminders.ts` (new), `app/test/retirePausedTourReminders.test.ts`
(new), `RUNBOOK.md`.

Binding deltas (worklist s0, s1, s2):
- `deps.toursRepo.get(row.tourId)` - there is NO `getById`. Live idiom `if (!tour)`.
- Gate placement: ABOVE `supersededInBatch` (`const myOrder` at ~`:888`). Hoist the tour read
  there; thread the fetched `tour` into `resolveReminderTarget(row, deps, log, tour?)` which
  skips its own fetch when supplied (mirror its existing `tour_missing` skip exactly: it
  returns `{ unresolvable: 'tour_missing' }` with NO tenantId). PIN the stated consequence:
  a row that is superseded-in-batch AND tour-missing now takes `tour_missing`.
- RULING R1 (binding): keep the D7 `beforeStart` disjunct (`:952-964`) as defence-in-depth;
  rewrite its docblock (`:944-951`) to say the past-tour gate above is what makes the
  "wait ends at tour start" escape unreachable for pre-tour rungs. REDESIGN the existing test
  `app/test/tourReminders.test.ts:3205` ("AT/AFTER tour start the wait ENDS"): same setup,
  tick at `now === SCHEDULED_D11`, assert the rung is claim-skipped `tour_already_passed`
  and `world.sent` stays empty; rename the test to say so. This is spec 6.1a working as
  intended, not a regression.
- Force-send refusal for `tour_already_passed`: after target resolution succeeds, where the
  local `refuse` helper (`~:1420`) IS in scope; `target.tour.scheduledAt`. Never a claim-skip.
- Plan T3 step 7: rewrite the `claimSkipRow` docblock third paragraph (`:640-643`) to add the
  sweep-only category (`kind_retired` has no poll writer). Also correct the stale in-code refs
  at `jobs/tourReminders.ts:1381-1383` (":652/:673" -> the true lines of the tour/contact
  reads) and the test comment at `tourReminders.test.ts:3417` (":797" -> the true D7 line)
  IF your edits touch those blocks.
- Plan T3 step 8 (`tours.spec.ts:282-288`): the tick `justAfter(times.noShowCheckin)` is
  AFTER the tour start, so pre-tour pending rungs (`morning_of`, `en_route`; `day_before`
  too if still pending) are now claim-skipped `tour_already_passed`. Rewrite the comment AND
  ADD a positive retirement assertion via `req/page.request.get(`${NEXT}/api/tours/${id}/reminders`)`
  (read how the spec obtains the tour id and a request handle - other specs in the file do
  it) asserting those rungs have `state === 'skipped'` and `skipReason === 'tour_already_passed'`.
  Keep the existing absence assertion. Then `cd .../e2e && npx tsc --noEmit -p .`.
- Task 4 planner imports `retiredByTourStart` from `../src/jobs/tourReminders.js`. The Scan is
  a plain table Scan (bare `reminderId` hash key; fields listed in report A s2 / D s1.4).
  Tour cache `Map<string, TourItem | undefined>` filled from `createToursRepo(...).get`.
  Conditional `UpdateCommand`: `attribute_not_exists(sentAt) AND attribute_not_exists(canceledAt)
  AND attribute_not_exists(skippedAt)`; catch `ConditionalCheckFailedException` as a logged skip.
  `--dry-run` writes nothing. PII: counts + tourId/reminderId only. Header comment per plan.
  Integration test is REQUIRED (plan T4 step 3) using the `hc-test-<uuid8>-` + `ensureTable` +
  `deleteTableIfExists` idiom quoted in report D s1.2 (tables: `tours`, `tourReminders`).
  The script's runner signature should mirror `backfillRelayOptOutFlag({ dryRun?, doc?, env? })`
  so the test can inject `doc` + `env`.
- RUNBOOK entry: model on the `### Media content-type backfill (2026-08-26)` entry (`:262-285`);
  title it as a one-time entry; state spec 3.2's PREFERRED order (sweep dev, then prod, then
  deploy - either order is now safe because of DISCONTINUED_REMINDER_KINDS which lands in a
  later task; say the guard is what removes the deadline) and that re-running is safe.
  Command: `npx tsx app/scripts/retire-paused-tour-reminders.ts --dry-run` then without.
  No npm script (matches every other backfill). ASCII only.

Verify: `cd .../app && npx vitest run test/tourReminders.test.ts` then the FULL app suite
(`npx vitest run`, timeout 600000) at the end of Task 3 (plan step 9) - red from this task must
be attributed HERE; `npx vitest run test/retirePausedTourReminders.test.ts` for Task 4;
`npm run typecheck` from the root; `cd .../e2e && npx tsc --noEmit -p .`. Commits per the plan
(`feat(reminders): shared past-tour predicate`, `feat(reminders): fire-time past-tour gate,
first in precedence`, `feat(scripts): one-time sweep retiring reminders armed during the pause`).
