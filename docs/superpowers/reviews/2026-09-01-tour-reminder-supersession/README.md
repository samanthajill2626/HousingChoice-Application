# Mission record - tour reminder supersession + Upcoming placement (`feat/tour-reminder-supersession`)

**This record was committed by the mission itself** - the spec and plan review
rounds, the code reviews and their adjudications, the ten slice reports and two
fix waves, the self-QA, the handback, and the planner's own cold review round all
landed with the work. Only `worklist.md` and this README were added on 2026-09-02
when the branch was retired.

Merged to `main` as `dc686a04` (branch tip `bcb2d629`). The design and plan are
frozen at
[`2026-09-01-tour-reminder-supersession-design.md`](../../specs/2026-09-01-tour-reminder-supersession-design.md)
and [`2026-09-01-tour-reminder-supersession.md`](../../plans/2026-09-01-tour-reminder-supersession.md),
with the dispatch block at
[`2026-09-01-tour-reminder-supersession-mission.md`](../../plans/2026-09-01-tour-reminder-supersession-mission.md).
For current truth read the code.

## What shipped

A reminder rung is now retired by DELETION, not by a `canceledAt` stamp. Every
reminder row carries an optional `ladderId` and every tour an optional
`currentLadderId`; a reschedule, terminal transition or placement conversion
rotates the tour pointer and hard-deletes the never-sent rungs of the old
generation. Sent rungs are never touched and surface under the panel's
`Earlier reminders (N)` disclosure. A row with no `ladderId` on a tour with no
`currentLadderId` is a PRE-MIGRATION PAIR and is exempt, which is why no backfill
was owed (`app/src/lib/ladderPointer.ts` carries the four-cell table). S10 moved
the placement Upcoming block inside the scroll container behind a 3-valued
anchor. `RUNBOOK.md` records that nothing is owed operationally.

## Traps this record is worth reading for

- The sweep's SECOND argument is the pointer to PROTECT (the CAS-won `ladderId`,
  the rotation, finalize's rotation). Never re-add a pre-sweep ownership read.
- The terminal branch fires only on an EXPLICIT terminal `patch['status']` that
  differs from current. Inheriting `effectiveStatus` deleted pre-migration
  history.
- The Upcoming anchor re-derives ONLY on the block's UNMOUNT flip; a mount
  re-derive ate the first-mount pin.
- `armTourReminders` returns `{ ladderId, rows }`. Fixture rule: any test that
  arms for real against a hand-written tour must point the tour AND stamp the
  hand-added rows, or the pointer MISMATCH suppresses every rung.

## Working-tree deletion incident (cause never determined)

At ~22:29 on 2026-09-01, mid-gate-battery, 1,158 tracked files (all of `app/`,
part of `dashboard/`) were deleted from the worktree's working tree. `HEAD` was
untouched and `git restore .` recovered them byte-identical; the contaminated e2e
run was discarded and re-run twice (264/265 with one isolated-green SSE flake,
then 265/265 exit 0). Two suspects, neither proven: a throwaway eslint-baseline
worktree created with an MSYS `ln -s node_modules` across worktrees (undefined
behaviour under Git Bash here - do not do it again), or an orphaned stack from a
killed e2e run. Recorded because nothing else in this directory names it.

## What was deliberately NOT kept

The keeping rule is decisions, findings, adjudications and reasoning - not
anything recomputable from the repo.

- `sdd/research/{A-repo-seeds,B-jobs-routes,C-dashboard,D-tests-e2e}.md` (184KB).
  **The mission split these itself at authorship**: the corrections and gaps went
  to the tracked [`research-findings.md`](research-findings.md), and these four
  files hold the byte-exact quotation behind them.
- `.superpowers/review/*.txt` - raw diffs and commit lists. Git regenerates them.
- `sdd/gates/*` and `sdd/reports/gate-*|red-*|green-*` - captured gate output.
  The verdicts are in the slice reports and the handback.
- `sdd/progress.md` and `sdd/heartbeat.log` - the dispatch ledger and run state.
- `sdd/handback.md` and `sdd/reports/S*.md` were byte-identical to the tracked
  copies; nothing was overwritten.
