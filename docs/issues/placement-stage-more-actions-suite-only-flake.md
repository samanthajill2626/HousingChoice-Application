---
id: placement-stage-more-actions-suite-only-flake
title: approval-and-move-in times out waiting for the placement page's "More actions" button in full-suite runs, and passes solo
type: bug
severity: med
status: open
area: e2e
created: 2026-08-23
reopened: 2026-08-25
refs: e2e/scenarios/steps.ts:3529, e2e/tests/scenarios/approval-and-move-in.spec.ts:223, e2e/tests/scenarios/tours.spec.ts:93, docs/issues/evidence/placement-page-load-hang/2026-08-25-run2-failure.json
---

**REOPENED 2026-08-25 on this issue's own stated trigger.** The NAMED
page-load message - "the placement page did not finish loading (header absent
- check `<main>` for a stuck 'Loading' status)" - fired in a gate run. Per the
resolution note below, that means a hung bundle fetch SURVIVES the keep-alive
fix and has a second cause. Severity raised from `low` to `med`: this is no
longer a one-test click race, it has now been seen four times across three
branches, and it reddens a required gate.

**RESOLVED (2026-08-24): the mystery this issue preserved artifacts for is
solved, and it was never a click race.** Both sightings' failure snapshots
(:318 on 2026-08-23, :258 on 2026-08-24 - the second captured because this
issue's own copy-the-artifacts-first instruction was followed) show the same
page state: `<main>` holding only `status "Loading"`. The placement bundle
fetch hung for the entire 30s budget under two-suite machine load; the kebab
never existed to click.

Two fixes landed on `fix/test-suite-wave3`:

- ROOT CAUSE CLASS: keep-alive hardening on the app server AND the Vite dev
  server (65s/66s). A server FINning an idle pooled socket the client is about
  to reuse produces exactly a hung/reset proxied request with nothing in any
  log - the mechanism reproduced 3/3 vs 0/3 against fake-twilio with the same
  values (see `app-server-default-keepalive-timeout`).
- DIAGNOSABILITY: `pickPlacementStage` now waits for the placement header
  FIRST, with its own named failure ("the placement page did not finish
  loading"), so any residual cause reads as what it is instead of "a button
  would not click".

REOPEN IF the NAMED page-load message fires in a gate run - that means a hung
bundle fetch survives the keep-alive fix and has a second cause worth its own
diagnosis. A recurrence of the OLD opaque kebab-click shape would instead mean
the readiness wait regressed.


**Sightings 3 and 4 (2026-08-25, `feat/error-surface-detail` @b535a7fa, two
consecutive full-gate runs).** Both hit the NAMED page-load message. The branch
changes only the System Status read path, which `isLocalEnv` short-circuits in
the hermetic lane, so its diff cannot reach this code.

| run | started | result | failing test | timed out |
|---|---|---|---|---|
| 3 | 17:0x | 253/1, 19.7m | `tours.spec.ts:93` (landlord-led -> placement) | 30s |
| 4 | 17:27:48 | 253/1, 21.7m | `approval-and-move-in.spec.ts:223` (inspection FAILS -> Lost) | 30s at 17:41:37.990 |

Record for sighting 4 preserved at
`docs/issues/evidence/placement-page-load-hang/2026-08-25-run2-failure.json`.
Sighting 3's `results.json` and BOTH runs' screenshots were lost - a third run
was started before the artifacts were copied aside, and Playwright clears
`test-results/` on start. That is the exact loss this issue's copy-first
instruction exists to prevent; do not start another run before preserving.

**DIFFERENT FILES, ONE CODE PATH - do not read the two as unrelated.** Sighting
4 failed inside `pickPlacementStage` (`steps.ts:3529`). Sighting 3's
`tours.spec.ts:93` reaches `expectPlacementStage('Send application')` at
`:150`, which navigates to the same `/placements/:id` and waits on the same
`placementBanner()`. The compare-failing-FILES rule in AGENTS.md is scoped to
the `npm test` DynamoDB contention signature; applied to e2e it hides a shared
helper and turns one recurring defect into two "unrelated" blips.

**Ruled out, with evidence, so the next investigator does not repeat it:**

- NOT concurrency from another worktree. A concurrent `inbox-unread-cluster`
  run did exist, but it started 17:46:41 - **4m33s AFTER** sighting 4's test had
  already timed out at ~17:42:08. Overlapping windows are not causation; check
  ORDERING before blaming a neighbour.
- NOT DynamoDB Local accumulation. Measured during the same window: 255 MB in a
  6 GB tmpfs, 124 databases, 1.92 GiB of a 31 GiB limit, ~21% CPU, and the
  harness already drops lane tables on stop and prunes orphans at 7 days.
  Per-key databases mean no shared write lock. Nothing near a threshold.

**One open lead worth pulling.** Lane 4's `hclane4_us-east-1.db` measured 48 MB
against lane 15's 10 MB - a PER-LANE file that grows across reseeds. That fits
the monotonic within-worktree slowdown (17.9m -> 19.7m -> 21.7m across three
runs of the identical suite) better than shared-container load does.

**THE DIAGNOSTIC THAT WOULD SETTLE THIS WAS NOT CAPTURED.**
`E2E_CHILD_LOG_DIR` was unset on both runs, so the app / Vite / worker logs
were discarded - and those are the only evidence that distinguishes a SLOW
bundle fetch from a HUNG one. AGENTS.md says to set it when chasing an
intermittent failure. **Set it on the next reproduction attempt before doing
anything else.**

**Sighting 2 (2026-08-24, `fix/test-suite-wave3` gate RE-run, 250/3, 27.4m).**
A SECOND test in the same file hit the same signature: approval-and-move-in.spec.ts:258 (rent-rejection -> Lost) timed out with the More-actions kebab 'resolved' but never 'visible, enabled and stable'. Same mechanism surface, different test - the flake is per-MACHINERY, not per-test.
IMPORTANT CONTEXT for both runs that day: the re-run raced a LIVE concurrent
feature mission on the same machine (a dozen Playwright MCP browser processes,
a live test-server, Codex runtimes), and the suite ran 27.4m against a healthy
21m baseline. All three failures in that run were already-filed load-sensitive
issues; treat sightings from it as heavy-load data points, not baselines.


**Problem.** In a full `npm run e2e`, the LIF non-eligible branch fails at its
first stage move:

```
1) tests\scenarios\approval-and-move-in.spec.ts:318:1
   LIF non-eligible branch - advances through Complete paperwork with the LIF row
   absent and no LIF flag on the readiness confirm
   > Team moves the placement -> Schedule inspection

   Error: locator.click: Test timeout of 30000ms exceeded.
   Call log:
     - waiting for getByRole('button', { name: 'More actions' })

   at Scenario.pickPlacementStage (e2e/scenarios/steps.ts:3516)
```

`pickPlacementStage` opens the placement detail page's overflow menu:

```ts
await this.page.getByRole('button', { name: 'More actions' }).click();
await this.page.getByRole('button', { name: /^Placement stage/ }).click();
await this.page.getByRole('menuitemradio', { name: stageLabel, exact: true }).click();
```

The button never appears inside the 30s test budget - not the menu failing to
open, the trigger itself never rendering.

**Evidence (2026-08-23, `fix/test-hardening-wave2`).**

- FULL suite, run 1: 2 failed / 251 passed (21.5m). This was one of the two.
- SOLO, this spec plus `post-tour-application.spec.ts` (the other failure) in
  one targeted run: **10 passed (3.0m)**.
- FULL suite, run 2, same commit, nothing changed between them:
  **253 passed (19.0m)**.

So: 1 failure in 2 full runs, green solo. Intermittent, suite-only - the
signature of a race the machine's speed decides rather than a broken assertion.
It is not a known flake under any other name; the registry's
`approval-and-move-in` mentions are unrelated.

**Not yet diagnosed, and deliberately not guessed at.** The failure-time page
snapshot (`error-context.md`) was lost: Playwright clears `.artifacts/
test-results/` at the start of every run, and the isolation run that proved the
solo pass wiped it. COPY THAT DIRECTORY ASIDE BEFORE RE-RUNNING - it carries the
accessibility snapshot of what was actually on screen, which is the difference
between diagnosing this and speculating about it.

Candidate shapes, none confirmed:

- the page had not finished loading the placement (the button renders after the
  detail fetch resolves), so this is an under-waited navigation rather than a
  missing element;
- the spec was on a different route than it believed - a redirect, or an earlier
  step's navigation not settling;
- the overflow trigger's accessible name differs while some state is pending
  (e.g. a disabled or busy variant), so `getByRole` legitimately does not match
  yet.

**Suggested next step.** Re-run the full suite with the artifact directory
preserved, read the snapshot, and fix the cause rather than widening the
timeout. A 30s budget that is not enough for a button to render is not a budget
problem.

Related: same class as
[`landlord-onboarding-e2e-suite-only-flake`](./landlord-onboarding-e2e-suite-only-flake.md)
and [`tours-pm-exit-closed-chip-flake`](./tours-pm-exit-closed-chip-flake.md) -
pass solo, fail in the suite.
