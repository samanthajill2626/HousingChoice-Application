# Slice 2 report - Task 3 (past-tour predicate + gate + refusal) + Task 4 (sweep + RUNBOOK)

STATUS: both tasks SHIPPED. Three commits, all gates green.

## Commits

| hash | subject |
|---|---|
| `3f26f1a5` | feat(reminders): shared past-tour predicate |
| `0172bf88` | feat(reminders): fire-time past-tour gate, first in precedence |
| `3307afe0` | feat(scripts): one-time sweep retiring reminders armed during the pause |

## Tests / gates run (exit codes + counts)

| command | exit | result |
|---|---|---|
| `app$ npx vitest run test/tourReminders.test.ts` (T3 step 2, RED) | 1 | 6 failed / 79 passed (85) - `retiredByTourStart is not a function` |
| `app$ npx vitest run test/tourReminders.test.ts` (T3 step 4, GREEN) | 0 | 85 passed |
| `app$ npx vitest run test/tourReminders.test.ts` (T3 step 6, RED) | 1 | 6 failed / 85 passed (91) |
| `app$ npx vitest run test/tourReminders.test.ts` (T3 step 6, GREEN) | 0 | 91 passed |
| `e2e$ npx tsc --noEmit -p .` | 0 | clean |
| root `npm run typecheck` (after T3) | 0 | clean |
| `app$ npx vitest run` (T3 step 9, first) | 1 | 4 failed / 6297 passed - `tourRemindersApi.test.ts` send-now, diagnosed below |
| `app$ npx vitest run test/tourRemindersApi.test.ts` (after fix) | 0 | 37 passed |
| `app$ npx vitest run` (T3 step 9, final) | 0 | 6301 passed / 9 skipped (346 files) |
| `app$ npx vitest run test/retirePausedTourReminders.test.ts` | 0 | 12 passed |
| mutation check 1 (planner: B before A) | 1 | red - the population-order tests bite |
| mutation check 2 (write condition weakened to `attribute_exists`) | 1 | 2 failed - the race + idempotence tests bite |
| `app$ npx vitest run test/retirePausedTourReminders.test.ts` (restored) | 0 | 12 passed |
| root `npm run typecheck` (after T4) | 0 | clean |
| `app$ npx vitest run` (after T4) | 0 | 6313 passed / 9 skipped (347 files) |
| `npx eslint <7 touched files>` | 0 | 0 errors, 2 pre-existing warnings (`tours.spec.ts:55,59`, unused `no-console` disables, not mine) |

Logs under `.superpowers/sdd/logs/s2-*.log`. No e2e/Playwright run (orchestrator owns it).

## Task 3 - what shipped

- `retiredByTourStart(row, scheduledAt, now)` exported from `app/src/jobs/tourReminders.ts`,
  placed above `LADDER_ORDER`. Implementation is the plan's, verbatim, with one added
  comment explaining the canonicalization. Six predicate tests, written as a TOP-LEVEL
  `describe` in `app/test/tourReminders.test.ts` (outside the DynamoDB-gated describe) so
  the pure predicate runs on a machine with no DynamoDB Local. I added one case the plan
  did not have: `now === scheduledAt` is TRUE (the `>=` boundary was unpinned).
- Gate in `processReminderRow`, FIRST - above `supersededInBatch`, above `isQuietTime`.
  Tour read HOISTED there; `resolveReminderTarget` gained `prefetchedTour?: TourItem` and
  uses `prefetchedTour ?? (await deps.toursRepo.get(...))`. `deps.toursRepo.get`, never
  `getById` (worklist s0). The later `const { tour, conversation: conv } = target;`
  destructure would have shadowed the hoisted `tour`, so it is now
  `const { conversation: conv } = target;` with a comment saying why.
- Force-send refusal via the local `refuse` helper on `target.tour.scheduledAt`.
- Six new gate tests in a `describe('past-tour gate (spec 6.1a)')` block, plus the
  redesigned D7 case. Includes the pinned hoist consequence
  (superseded-in-batch AND tour-missing -> `tour_missing`).
- Comment rewrites: `beforeStart` docblock (R1), `claimSkipRow` docblock third
  paragraph (sweep-only category), stale refs `:652/:673` -> `:851/:872`, test comment
  `jobs/tourReminders.ts:797` -> `:1037`.

## Task 4 - what shipped

- `app/scripts/retire-paused-tour-reminders.ts`: header comment per the precedent's shape,
  `planReminderRetirement` (pure, exported), `retirePausedTourReminders({dryRun?, doc?,
  env?, now?, scanLimit?})`, `Map<string, TourItem | undefined>` tour cache from
  `createToursRepo(...).get`, Scan paging, conditional `UpdateCommand`
  (`attribute_not_exists` on all three terminal attrs) with
  `ConditionalCheckFailedException` caught as a logged skip, `--dry-run` writing nothing,
  the same `invokedDirectly` CLI entry. PII: counts + tourId/reminderId only.
- `app/test/retirePausedTourReminders.test.ts`: 8 pure planner cases + 4 DynamoDB Local
  cases (dry-run writes nothing; a real run stamps exactly the planned rows and a second
  run is a no-op; a mid-scan claim loses the conditional and is reported; a 65-row table
  pages on `scanLimit: 7` and reads each tour once).
- `RUNBOOK.md`: `### One-time: retire tour reminders armed during the 2026-08 pause
  (2026-08-31): NO schema change, ONE sweep, SWEEP FIRST`, modelled on the media
  content-type entry, placed immediately after it. States the preferred order and WHY it
  is only a preference, the two tokens, the safe-to-re-run note, the bare-"Skipped" chip
  window before the deploy, and the no-agent rule. No npm script.

## DIVERGENCES from plan / worklist - read these

1. **`e2e/tests/scenarios/tours.spec.ts:282-288` - verb, not an inline API read.** The brief
   said to add the retirement assertion via `req/page.request.get(...)` "read how the spec
   obtains the tour id and a request handle - other specs in the file do it". In the LIVE
   file they do not: `tours.spec.ts` imports only `test` (no `expect`), makes zero raw API
   calls, and `NEXT` is module-private to `steps.ts`. An inline read would have introduced
   a new dialect into a file whose header says every line is a verb. So I added two verbs
   to `e2e/scenarios/steps.ts` instead: `upcomingReminderKinds()` and
   `expectRungsRetiredPastTour(kinds)` (the latter throws on an empty list, so a vacuous
   assertion fails loudly).
2. **The spec captures the pending set BEFORE the tick rather than hand-listing the rungs.**
   `tourSchedule()` is `now + 48h` with NO fixed local time, so the tour's local hour equals
   the wall-clock hour of the run. At small-hours local times, arm-time quiet-hours clamping
   can push `morning_of`/`en_route` at or past the tour start and they are born `past_event`
   instead. A hand-listed `['day_before','morning_of','en_route']` would then flake.
   Capturing what is actually pending is both robust and a STRONGER claim (every pending
   pre-tour rung retired, not a chosen subset). NOTE for the orchestrator: this
   time-of-day exposure is pre-existing in the suite (`tours.spec.ts:255`
   `expectReminderTo1to1('en_route')` has it too) - I did not add it and did not fix it.
3. **`app/test/tourRemindersApi.test.ts` send-now fixtures re-dated 2026-07 -> 2099.** NOT
   in any file list. This was the only red from Task 3's full-suite gate: 4 cases in
   `POST /api/tours/:tourId/reminders/:reminderId/send-now`. `seedSendNowTour` seeded
   `scheduledAt: '2026-07-20T14:00:00.000Z'` and the route runs on the WALL clock - today
   is 2026-08-31, so that tour has already happened and every case now refused
   `tour_already_passed` before reaching the gate it was about. The gate is right; the
   fixture had rotted from future to past. Re-dated the pair (and the three literals that
   read it) to 2099, the file's own never-expires idiom, with a comment saying why.
   **Generalize this**: any fixture in the repo carrying a hardcoded 2026-07/2026-08 tour
   plus a wall-clock force-send is now a past-tour refusal. Only this one exists today
   (the full suite is green), but a later task adding one will hit it.
4. **Force-send refusal placed ABOVE the kill switch**, i.e. first among the `refuse`
   gates, mirroring "the gate goes FIRST" on the poll side. The spec pins the refusal
   precedence only relative to `kind_retired` and `names_unavailable`, so this was a
   judgement call: `tour_already_passed` is PERMANENT and `sms_sending_disabled` is
   temporary, so the permanent truth is the more useful answer. No existing test moved.
   Task 7's `kind_retired` inline return at the row lookup still outranks it.
5. **TDD deviation on Task 4.** The planner tests were written first but I implemented the
   script before running them, so they never went red. I closed that hole with two
   MUTATION runs instead (planner population order; write condition weakened) - both went
   red, both restored, restored run green. Task 3 was strict red-then-green throughout.
6. **Two options on the sweep runner the plan did not specify**: `now?` (deterministic
   population-A judgement, needed by the integration test) and `scanLimit?` (documented as
   an ops knob for a large table, and what makes the paging loop exercisable). Both
   optional; the CLI entry passes neither.
7. **No server-side `FilterExpression` on the Scan**, unlike the precedent. The reminder
   table is small, and scanning everything keeps `planReminderRetirement`'s terminal-row
   rule a live production rule rather than one only its unit test reaches, and makes
   `scanned` an honest count of the table. Documented in the script.

## Open worries - not blocking, your eye

- **`retiredByTourStart` compares `now` and `row.dueAt` as RAW strings** against a
  canonicalized `startIso` (the plan's implementation, kept verbatim). Every live caller
  passes canonical ISO, and `dueAt` is always `toISOString()` output, so this is correct
  today. A future caller passing `'2026-08-01T15:00:00Z'` as `now` would compare wrong.
  Cheap to harden if anyone wants it; I did not deviate from the plan's code.
- **`app/src/routes/contactTimeline.ts` does not project `skipReason`** (research A s7),
  so a `tour_already_passed` retirement is invisible there - the rung simply leaves the
  Upcoming bucket. Consistent with that bucket's contract; flagged, not changed.
- **Task 7 should re-check the `beforeStart` disjunct.** It is now unreachable for any
  pre-tour rung (the gate retires them first) and reachable only by a post-tour-dueAt rung
  on a non-self_guided tour with a pending open - i.e. `no_show_checkin`, which is never
  auto-armed. R1 says keep it as defence-in-depth and I did, with the docblock rewritten
  to say exactly that. Nothing to do; recorded so a later reviewer does not re-diagnose it
  as dead code.
- **The sweep's `toursRead` counter** is in the result object mainly so the cache is
  testable. It is honest output and cheap, but if anyone finds it noise in the RUNBOOK
  report line, it is the one field that can go.
- **`tour-no-show-checkin.spec.ts:77-89`** left for T9 per the worklist (its confirmation
  bullet). Its conclusion strengthens under this gate rather than breaking.
