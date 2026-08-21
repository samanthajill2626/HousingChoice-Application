---
id: e2e-session-lane-mismatch
title: A filtered playwright run does not reuse the live e2e:session stack - it free-probes the NEXT lane and boots its own
type: debt
severity: low
status: resolved
area: e2e
created: 2026-08-05
resolved: 2026-08-21
refs: e2e/playwright.config.ts, scripts/e2e-session.mjs
---

**Resolution (2026-08-21, `fix/e2e-harness-determinism`).** `playwright.config.ts`
now prefers a live session's lane before free-probing, so a filtered
`npx playwright test <file>` reuses the warm `e2e:session` stack instead of
booting a second one.

Reuse requires BOTH proofs: the launcher pid in `e2e/.artifacts/lane.json` is
alive, AND the lane lease still matches its recorded owner token. Either alone
is insufficient - a crashed session leaves a stale `lane.json` that would
otherwise capture every later run onto a dead lane.

Reading the per-worktree `lane.json` is correct here, and is NOT the mistake
[`e2e-lane-allocation-cross-worktree-race`](./e2e-lane-allocation-cross-worktree-race.md)
was about: the question is "is THIS worktree running a session", which is
exactly what a per-worktree artifact answers. Cross-worktree arbitration stays
with the machine-global lease.

An explicit `E2E_LANE` still wins, and the session's ready banner names it.

**Problem.** The documented interactive inner loop (`npm run e2e:session` +
filtered `npx playwright test <file>` from `e2e/`) does not compose: the
session launcher picks a free lane (observed: lane 4 -> app :9401), but a
subsequent `npx playwright test` run from the `e2e/` workspace free-probes its
OWN lane, lands on the next one (lane 5), and boots a second full stack -
`reuseExistingServer` never engages because the two processes resolve
different ports. Observed 2026-08-05 during feat/tour-reminder-details slice
5: four per-file runs each paid their own stack boot (~40-60s apiece) while a
perfectly warm session stack sat idle one lane down. Harmless for
correctness; wasteful and confusing (an agent watching lane 4's log sees no
traffic and may conclude the run is wedged).

**Suggested fix.** Make the session lane sticky for child runs: have
`e2e:session` export/persist its lane (it already writes lane.json - have the
playwright config PREFER an existing lane.json's lane when the launcher pid
is alive, or document `E2E_LANE=<n>` as a required env for filtered runs and
emit it in the session-ready banner). Either way the ready banner should say
exactly what to export.
