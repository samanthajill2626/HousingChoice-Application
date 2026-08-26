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
 * WHY 90s. Measured, not guessed. Under a 1.6x machine load (28.9m and 29.6m
 * suites against a 17.9m idle baseline) the slowest scenario test ran 38.1s and
 * the pack sat at 23-38s. 90s leaves every one of them 2.4x headroom or better,
 * while staying short enough that a genuine hang still surfaces in well under
 * two minutes.
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
export const SCENARIO_TIMEOUT_MS = 90_000;

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
