---
id: e2e-scenario-specs-rotate-failures-full-suite
title: Scenario specs fail in rotation under the full suite - a different unrelated file each run, never twice
type: bug
severity: med
status: open
area: e2e
created: 2026-09-02
refs: e2e/tests/scenarios/tenant-onboarding.spec.ts, e2e/tests/scenarios/tours.spec.ts, e2e/tests/scenarios/approval-and-move-in.spec.ts
---

**Problem.** Across three full `npm run e2e` runs on 2026-09-02, the scenario
suite produced 0-4 failures per run, and the failing FILE was different every
time. No scenario file failed twice.

| Run | Commit | Scenario failures |
|---|---|---|
| branch run 1 | `docs/media-cache-risk-accepted` | `tenant-onboarding.spec.ts` (3 cases), `tours.spec.ts:277` (1) |
| merge base | `main` @ d4298abe | none |
| branch run 2 | `docs/media-cache-risk-accepted` | `approval-and-move-in.spec.ts` (2 cases) |
| relay-30003 gate 4 (2026-09-02, `feat/relay-30003-retry-lineage` @ 17bf49a7, main @ f82c149c merged) | none - the run's only red was `outbound-mms.spec.ts:517` with the trigger-not-visible signature, which passed alone twice on the same code | (a fourth data point: zero scenario failures this run; the pass-alone / fail-in-suite shape held on a NON-scenario file) |

Observed messages were absent-element assertions - e.g. a contact link filtered
by phone number never appearing in the Unknown tab
(`scenarios/steps.ts:576`) - not timeouts on a slow render.

**Why this is worth its own entry.** Each individual failure looks like a
one-off worth re-running past, and each one passes in isolation. Only the
rotation across runs shows the shape: something in full-suite conditions -
cross-spec process state, a shared reseed/session-epoch cache, or contention
from a concurrently running suite in another worktree - is knocking out an
arbitrary scenario file per run. Chasing any single failing spec will find a
healthy spec and conclude "flake", which is how this stays alive.

Related prior art: the pass-alone/fail-in-suite class documented in
`reseed-epoch-cache-bug` (cross-spec process state), and AGENTS.md's warning
that `reuseExistingServer` adopts an orphaned same-commit stack without checking
uptime or health, so an interrupted run silently contaminates the next one.

**Suggested first step.** Collect the shape before theorising: run the full
suite N times on an unchanged `main` and record WHICH scenario file fails each
time. If the rotation reproduces with no other worktree active, it is
cross-spec state; if it only appears when another suite is running, it is
contention and the fix is lane isolation, not spec code. Note that
`E2E_CHILD_LOG_DIR` is the wrong instrument for the timing-sensitive half -
piping a child's stdout changes the timings being measured (see AGENTS.md).

Distinct from
[`e2e-outbound-mms-viewer-trigger-not-visible`](e2e-outbound-mms-viewer-trigger-not-visible.md),
which fails in 3/3 full runs INCLUDING on main and is therefore deterministic,
not rotating.

**Sighting 2026-09-03, `feat/relay-30003-retry-lineage` (planner's independent
final battery).** Two cases in `e2e/tests/scenarios/scheduled-visibility.spec.ts`
(`:104` and `:179`) failed in a full `npm run e2e`, alongside the separate
`outbound-mms` red. **The same file passed ALONE minutes later on the same
commit: `5 passed (40.0s)`, EXIT 0.**

Two things this adds to the shape recorded above:

- **A fourth scenario file joins the rotation.** The entry lists
  `tenant-onboarding`, `tours` and `approval-and-move-in`;
  `scheduled-visibility` had not failed before, and the rotation still holds -
  no file has now failed twice.
- **The signature matches the absent-element class, not a slow render.**
  `getByRole('region', {name: 'Communications and activity'}).getByText(/would
  like to tour/i)` timed out with "element(s) not found" - an inbound message
  that never appeared, exactly like the Unknown-tab contact link already
  recorded, rather than a render that arrived late.

Not the closed `tour-reminders-panel-e2e-flake` signature, which was a rung row
invisible inside its own 10s budget; this is a message missing from the comms
region entirely. The branch fences `jobs/tourReminders.ts` and touches no tour
path, and its own relay retry spec passed in the same run (#137, 19.1s).
