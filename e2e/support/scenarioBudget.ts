import { test } from '@playwright/test';

/**
 * The per-test budget for `tests/scenarios/*`.
 *
 * WHY THESE SPECS GET THEIR OWN NUMBER. A scenario spec is a multi-step journey
 * - a dozen-plus navigations, gated modals, job ticks and board reads - which is
 * structurally different work from the rest of the suite. Across 255 tests the
 * p50 is 3.0s and the p95 17.2s; the scenario specs run 15-40s. Playwright's 30s
 * default was never sized for them, and the result was a class of failure that
 * looked like a product bug for months: the test runs out of clock, Playwright
 * attributes the timeout to whatever assertion happens to be in flight, and the
 * error names that assertion. Four separate investigations chased a "hung
 * placement page" that was only ever a scenario running long.
 * See docs/issues/placement-detail-bundle-fetch-stall.md.
 *
 * WHY 100s. Measured, not guessed, across five pressure runs at 1.34x-1.96x a
 * 17.9m idle baseline. The pack sits at 20-45s; the high-water mark is
 * approval-and-move-in:164 (the nine-stage no-skip walk) at 62.6s under 1.90x.
 *
 * TODO(concurrent-capacity-budget-tail): 100s is NOT a comfortable multiple of
 * that worst observation - it is ~1.6x, chosen deliberately over a roomier 150s
 * because a budget long enough to never fire is also long enough to hide a real
 * hang. THE COROLLARY IS A STANDING OBLIGATION: if any scenario test ever fails
 * at ~100s, do NOT simply raise this number. That failure means either the
 * sizing is genuinely too tight (in which case size it from the run's numbers,
 * not by doubling) or - more likely, given the history below - something is
 * actually hanging and the budget is the messenger. Four separate
 * investigations already chased a "hung placement page" that was only a
 * scenario running out of clock; the mirror-image mistake is to keep widening
 * the budget until a real hang stops being visible. Read the failing test's
 * duration against this constant BEFORE touching it.
 *
 * Also note :164 is not linear with load - it ran 34.4s at 1.96x and 62.6s at
 * 1.90x - so treat any single observation as a sample, not a measurement.
 *
 * WHY A DIRECTORY BUDGET RATHER THAN PER-TEST `test.slow()`. That is what this
 * replaced, and it failed by attrition: the annotation landed wherever someone
 * happened to get bitten, so coverage was 1-of-7 in one file and 3-of-3 in
 * another, and every new long scenario started life unprotected. The 2026-08-25
 * pressure run found five more tests at 81-127% of the default in files nobody
 * had touched yet. A budget that has to be remembered per test is a budget that
 * will be missing on the next one.
 *
 * DO NOT raise the GLOBAL default to fix this. The other 200-odd tests are short
 * by design, and a blanket raise only lengthens how long a real hang takes to
 * surface everywhere else. Keep the sizing where the long work actually is.
 */
export const SCENARIO_TIMEOUT_MS = 100_000;

/**
 * Apply {@link SCENARIO_TIMEOUT_MS} to every test in the calling spec file.
 * Call once at module scope, below the imports:
 *
 * ```ts
 * useScenarioBudget();
 * ```
 *
 * Registers a `beforeEach`, which is what lets a per-file budget apply to
 * top-level `test()` calls - `test.describe.configure({ timeout })` only reaches
 * tests inside a `describe`, and these specs deliberately have none.
 */
export function useScenarioBudget(): void {
  test.beforeEach(() => {
    test.setTimeout(SCENARIO_TIMEOUT_MS);
  });
}
