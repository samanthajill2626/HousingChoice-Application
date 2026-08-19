/**
 * The Today-page readiness assertion - ONE definition of "the dashboard is up",
 * shared by every sign-in helper and every mid-test navigation back to `/`.
 *
 * WHY A SHARED MODULE. This assertion was copy-pasted into 60 call sites across
 * 54 files, and 41 of those copies were WRONG in the same way:
 *
 *   await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
 *
 * `getByRole` name matching is a SUBSTRING match by default, so that locator
 * also matches the Today queue's own `Tours today` group heading (an <h2>). The
 * page renders that group whenever a tour is scheduled for the current day - at
 * which point the locator resolves to TWO elements and Playwright's strict mode
 * throws rather than guessing.
 *
 * The failure that produces is unusually expensive to diagnose:
 *   - it fires during SIGN-IN, so the test dies before touching its subject and
 *     the error names none of what the spec was written to check;
 *   - it depends on LANE state, not on the failing spec - one spec leaving a
 *     tour on today's date breaks whichever innocent spec runs next;
 *   - so the failing set shifts between runs and goes away on a re-run in
 *     isolation, which reads exactly like flaky infrastructure.
 *
 * That was mis-blamed on a feature branch on 2026-08-19 (three unrelated specs,
 * a different three on the serial re-run, all green alone). About a dozen specs
 * had already been patched to `exact: true` individually over the preceding
 * months - each fixing its own symptom and leaving the trap set everywhere else.
 * The selector living in one place is the actual fix; see
 * docs/issues/today-heading-selector-ambiguity.md.
 *
 * Deliberately NOT a `signIn(page)` helper. The suite has several legitimate
 * ways in (the dev-user button, a POST to /auth/dev-login, a persona login) plus
 * plain navigations back to `/` mid-test - collapsing those would flatten real
 * differences. What every one of them shares is this one assertion.
 */
import { expect, type Page } from '@playwright/test';

/**
 * The Today landing page has rendered. `exact: true` is load-bearing - see the
 * module header. `timeout` overrides the default for the slower entries (a
 * cold-boot sign-in behind a reseed).
 */
export async function expectTodayReady(page: Page, opts?: { timeout?: number }): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible(
    opts?.timeout !== undefined ? { timeout: opts.timeout } : undefined,
  );
}
