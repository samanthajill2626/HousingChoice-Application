---
id: placement-stage-more-actions-suite-only-flake
title: approval-and-move-in times out waiting for the placement page's "More actions" button in full-suite runs, and passes solo
type: bug
severity: low
status: open
area: e2e
created: 2026-08-23
refs: e2e/scenarios/steps.ts:3516, e2e/tests/scenarios/approval-and-move-in.spec.ts:318
---

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
