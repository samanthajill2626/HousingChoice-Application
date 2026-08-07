/**
 * Narrow-viewport helpers - ONE definition of "phone width" and ONE
 * horizontal-overflow assertion, shared by every spec that verifies the
 * contact-rosters narrow-viewport contract (spec 6.7: "Every surface in this
 * spec is verified at 360px in the Playwright harness").
 *
 * Why a shared module rather than a per-spec inline expression: before this,
 * every overflow check in the suite was copy-pasted (outbound-mms.spec.ts,
 * voice-extraction.spec.ts, placements-page.spec.ts each grew their own), so
 * "no horizontal overflow" meant something slightly different in each file.
 *
 * Geometry ONLY. These read what the browser actually laid out; they never
 * inspect CSS text or computed styles, because a computed style proves that a
 * rule exists, not that the pixels landed where the spec says.
 */
import { expect, type Page } from '@playwright/test';

/** The narrow viewport spec 6.7 names. 360px is the narrowest phone we support. */
export const NARROW_360 = { width: 360, height: 800 } as const;

/**
 * The restore. NOT a byte-exact restore of the project default
 * (devices['Desktop Chrome'] is 1280x720) - it is "widen back past the 860px
 * twoPaneShell breakpoint" so the REST of the same test walks the desktop
 * layout it was written against. Every narrowing must be paired with this:
 * playwright.config.ts runs `workers: 1` + `fullyParallel: false`, so a test
 * that leaves its own later steps at 360px reads as a mystery failure.
 */
export const WIDE_RESTORE = { width: 1280, height: 900 } as const;

/**
 * The page must not scroll sideways. `where` names the surface under test so a
 * failure says which one overflowed rather than just "expected <= 1".
 *
 * The 1px tolerance is deliberate: sub-pixel layout rounding can leave
 * scrollWidth one pixel past clientWidth on a page that is visually flush.
 */
export async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowX, `${where}: the page overflows horizontally`).toBeLessThanOrEqual(1);
}
