# MISSION: Tour auto-close and reopen (Sam's improvement #18, remaining part)

Worktree: W:\tmp\tour-auto-close  Branch: feat/tour-auto-close  (cut from main @ae04122d)
Profile: W:\tmp\tour-auto-close\.claude\feature-mission.profile.md
Spec: W:\tmp\tour-auto-close\docs\superpowers\specs\2026-10-01-tour-auto-close-reopen-design.md (APPROVED)
Plan: W:\tmp\tour-auto-close\docs\superpowers\plans\2026-10-01-tour-auto-close-reopen.md (v4, APPROVED)
Design review: spec R3 (terminal), plan R2 (terminal); 0 BLOCKING; every finding ruled - adjudications at
  W:\tmp\tour-auto-close\docs\superpowers\reviews\2026-10-01-tour-auto-close\design-review\adjudications.md
Records: W:\tmp\tour-auto-close\docs\superpowers\reviews\2026-10-01-tour-auto-close\ (TRACKED - commit
  each review round, adjudication, findings list, slice/fix-wave report, self-QA and the handback AS
  PRODUCED; one file, one kind; run state stays in .superpowers/)

Work map (plan section 2 has the detail):
- S1 model: TOUR_OUTCOMES + no_outcome + STAFF guard (and the PATCH validator switch, same commit);
  the two-week clock (autoCloseDueAtMs / isAutoCloseDue); reopenTargetFor.
- S2 repo: TourOutcome re-export + new attribute docs; patch(..., { expectedStatus }); autoCloseIf;
  reopenIf - real repo AND the harness fake with identical conditions, DynamoDB Local integration +
  fake-parity tests.
- S3 events: tour_auto_closed / tour_reopened types; recordTourEvent extracted to lib/tourEvents.ts
  (pure refactor - toursApi.test.ts unchanged).
- S4 PATCH: consistent read + status precondition -> 409 tour_changed; lastMarkedAt stamp.
- S5 sweep: close-nag clear helper; jobs/tourAutoClose.ts; worker poll (own 15-min interval);
  POST /__dev/tour-auto-close/tick { now?, tourIds? }.
- S6 reopen: POST /api/tours/:tourId/reopen.
- S7 listing chip: auto-closed-from-toured keeps "Toured".
- S8 dashboard: api types + reopenTour + StaffTourOutcome + catalog entry; tourReopen.ts; kebab item;
  ReopenTourModal; 409 copy in every writing tour dialog; tour page wiring + Outcome card; Tours page
  badge + intros; Today lists no-shows; activity labels.
- S9 e2e: rewrite today-past-tours.spec.ts; new tour-auto-close.spec.ts (every tick scoped by tourIds).
- S10 docs: GLOSSARY, issue registry (resolve / update / new), RUNBOOK first-run entry.
- S11: one main sync, the five gates, live self-QA, handback (plan S11 step 4 lists what it must carry).

Watch items (beyond the plan's section 12):
- Cameron is ASLEEP until morning. No QUESTION can be answered tonight: decide spec-vs-tree
  discrepancies yourself when both readings honor the spec's intent (record them in the ledger and the
  handback); write STATUS: QUESTION only for a genuine product fork, and if you do, keep building every
  slice that does not depend on it.
- Failure budget for tonight: 4 budget-consuming recoveries (Cameron's ruling), infra-tier rules
  unchanged.
- DynamoDB Local: `npm run db:start` (a start) is allowed; NEVER restart, stop or remove the shared
  container - it holds Cameron's local dev data. If it degrades, compare against a main baseline,
  record it, and continue or BLOCK; do not "fix" the container.
- Docker Desktop was started by Cameron tonight; the hc-dynamodb-local and hc-s3-local containers
  are up (since ~23:03). Do not restart them.
- npm ci was run in the worktree by the planner before dispatch (EXIT 0; npm warned that the esbuild
  and protobufjs install scripts are not in allowScripts - a pure app vitest file ran green
  afterwards, so the toolchain works; rerun npm ci only if node_modules is missing).
- This PC: full e2e runs have shown late-run socket exhaustion (ERR_ADDRESS_IN_USE / ERR_NO_BUFFER_SPACE)
  on main too - judge a red e2e by isolating failing specs and a main baseline in a scratch worktree
  (W:\tmp\..., detached at the merge base), never by the raw exit code alone. Terraform IS on PATH now.
- Other worktrees under W:\tmp belong to other missions - never touch them.
- The plan-blind adversarial reviewer charter applies at your Phase 4 (no spec/plan in its brief).
- Never edit dashboard/app source while this worktree's e2e (suite or session) runs.

Gates (bare, from W:\tmp\tour-auto-close, real exit codes, never piped):
1. npm run typecheck
2. npm test
3. npm run smoke
4. npm run e2e   (hard outer timeout)
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
   - no NEW errors versus the merge base on the same paths

Post-merge obligations already known: NONE (no migration, env var, GSI, table or terraform change).
Deploy is Cameron's; the first production run's behavior and preview go in the handback and RUNBOOK.
