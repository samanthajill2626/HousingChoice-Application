# Reader D - SWEEP SCRIPT precedent + E2E harness mechanics (plan Tasks 4, 6, 9-e2e, 15)

Common brief: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\research-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\research-D-sweep-e2e.md`

Deliver:
1. SWEEP PRECEDENT: `app/scripts/backfill-relay-optout-flag.ts` - its full frame
   (arg parsing, `--dry-run`, endpoint/table resolution via `lib/config`, Scan
   paging, conditional Update, logging style, exported planner, how its test
   `app/test/*.test.ts` exercises it against DynamoDB Local - name the test file
   and quote its table-setup idiom). List the other four `backfill-*.ts` briefly.
   How do dynamo-backed tests in this repo create tables (`hc-test-*` helper?) -
   quote the helper a new integration test should call.
2. RUNBOOK.md: its section structure and one existing "one-time" ops entry to
   model on (quote headings).
3. E2E VEHICLE: `e2e/scenarios/steps.ts` - `tickTourReminders`, `armedReminderDueAt`,
   `justAfter`, `tourSchedule`, and the docblock at ~2034-2038 byte-exact; how the
   dev tick route is called; the ARRIVAL-not-trigger discipline comment (~1711).
   Also `expectGroupIntros` and the `:1887` connection-sentence assertion (Reader C
   covers copy; you cover the step mechanics and every spec that CALLS these steps).
4. E2E CONFIRMATION SITES (the plan says 6+6+1+2): grep `confirmation` in
   `e2e/` fully; per site: file:line, quoted line, intent, category (cat1 convert
   via future-rung tick / cat2 redesign / cat4). Quote `tour-roster.spec.ts`
   ~488-501 and `scheduled-visibility.spec.ts` ~225-259 and ~111-165 in full
   enough to redesign from.
5. LIVE-WORKER AUDIT PREP (plan T6 step 2a): how is the e2e stack's worker
   started (`scripts/e2e-session.mjs`, playwright config webServer)? What is its
   poll interval? Does the e2e lane run the REAL worker poll for tour reminders
   today (with the manual-only pause making it inert)? Which specs assert a rung
   stays `upcoming`/pending - list file:line and the fixture dueAt offsets they
   use (near-now vs far-future). `quiet-hours.spec.ts` in full detail incl. its
   `:58` batch comment.
6. `docs/issues/tour-reminder-ladder-phase-b.md` (the ledger), `docs/issues/
   message-interpolate-token-reexpansion.md`, `docs/issues/placement-nudge-overdue-
   invisible-on-card.md`, `docs/issues/tour-copy-where-token-declared-not-passed.md`
   - status fields and frontmatter shape (Task 15 edits them); `TODO(tour-reminder-
   ladder-phase-b)` markers in `app/src` (grep) with lines.
7. e2e config: `workers`, `fullyParallel`, `retries`, `trace`; how `npm run e2e`
   selects its lane/ports from the worktree; the `e2e/README.md` bits on lanes.
