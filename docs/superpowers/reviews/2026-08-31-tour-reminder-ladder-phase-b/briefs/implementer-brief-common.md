# Implementer - common brief (every slice)

Begin by using tools - do not reply until the work is committed.

You are ONE implementer slice in a sequential build. You are the ONLY writer in this
worktree while you run. Worktree: `W:\tmp\tour-reminder-ladder-phase-b`, branch
`feat/tour-reminder-ladder-phase-b`. Use ABSOLUTE paths in every shell command (cwd resets
between calls); `pwd` before trusting a surprising git answer. `node_modules` are installed.
DynamoDB Local is running on :8000 (`docker ps` shows `hc-dynamodb-local`).

READ FIRST (files, not summaries):
1. `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\worklist.md` - the orchestrator's
   RULINGS (section 1) are binding; section 2 has your task's deltas over the plan.
2. The plan task(s) named in your slice brief:
   `W:\tmp\tour-reminder-ladder-phase-b\docs\superpowers\plans\2026-08-31-tour-reminder-ladder-phase-b.md`
3. The spec sections the plan task cites:
   `W:\tmp\tour-reminder-ladder-phase-b\docs\superpowers\specs\2026-08-31-tour-reminder-ladder-phase-b-design.md`
4. The research report(s) your worklist entry names (byte-exact anchors, rig idioms).
5. `W:\tmp\tour-reminder-ladder-phase-b\AGENTS.md` sections "Editing and commit discipline"
   and "Required completion gates" (you run the FAST gates only, see below).

Binding rules (verbatim from the repo + mission):
- The spec is a CONTRACT. Founder copy in fenced blocks is byte-exact - never re-word.
- STRICT TDD: failing test first, then implement, small commits. Plan test sketches with
  comment-only bodies are REQUIRED-ASSERTION specs you write out fully.
- Locate everything by NAME; line numbers in plan/worklist drift as tasks land.
- ASCII-only in every NEW/touched line (tests, comments, seeds, issues, docs). Existing
  non-ASCII lines you do not touch are fine.
- Never rewrite files with PowerShell Get-Content/-replace/Set-Content pipelines; use the
  Edit tool. Never `git add -A`; stage explicit paths. Bare `git status` before EVERY
  commit and check `.git/MERGE_HEAD` is absent. Every commit ends with
  `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.
- Never pipe a test/gate command (a pipe hides the exit code). Redirect to a file under
  `.superpowers/sdd/logs/` if you need to grep output.
- Run unit tests as `cd W:/tmp/tour-reminder-ladder-phase-b/app && npx vitest run test/<file>`;
  dashboard tests as `cd W:/tmp/tour-reminder-ladder-phase-b/dashboard && npx vitest run src/<path>`.
  A FULL app suite (when your brief demands it): `cd .../app && npx vitest run` - ~2-5 min;
  use a Bash timeout of 600000. If Dynamo suites go red with timeouts/lock errors and ZERO
  assertion failures, re-run under a clean key: `AWS_ACCESS_KEY_ID=hccleanrun<random> npx vitest run`.
- `npm run typecheck` from the worktree ROOT after every task that touches a type/signature
  (vitest strips types; only tsc proves a threaded signature).
- Do NOT run `npm run e2e`, `npm run e2e:session`, or any Playwright. The orchestrator runs
  e2e. You MAY and MUST keep e2e SOURCE compiling: `cd .../e2e && npx tsc --noEmit -p .`
  when you touch e2e files.
- NEVER run `app/scripts/retire-paused-tour-reminders.ts` against anything but a hermetic
  test table (spec 4.4). Never touch `.env*`, infra, deploys.
- NEVER end your turn with a background command running. Run long commands in the
  foreground with an explicit timeout.
- STOP-and-report (commit what is green first) on: an unexpected importer / cycle /
  contract mismatch; a spec point that looks WRONG (never silently deviate); a test whose
  intended behaviour you cannot re-derive. Divergences from the plan that trust the FILE
  over the plan are welcome - report each one.
- If you run low on context: COMMIT green work and report exactly the next step.
- Do not edit `.superpowers/sdd/progress.md` or `heartbeat.log` (orchestrator-owned).

REPORT: write your full slice report to the UNIQUE path named in your slice brief
(`.superpowers/sdd/reports/slice-<n>.md`): per task - shipped / deviated (why) / skipped;
commits (hash + one-liner); test commands run with their exit codes and counts; every
divergence from plan or worklist; open worries ("not blocking, your eye"). Your FINAL
MESSAGE is <=15 lines: status, commit hashes, gate/test exit codes + counts, and the
report path. No narration.
