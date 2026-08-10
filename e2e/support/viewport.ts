/**
 * Narrow-viewport helpers - ONE definition of "phone width" and ONE
 * horizontal-overflow assertion, shared by every spec that verifies the
 * contact-rosters narrow-viewport contract (spec 6.7: "Every surface in this
 * spec is verified at 360px in the Playwright harness").
 *
 * Why a shared module rather than a per-spec inline expression: before this,
 * every overflow check in the suite was copy-pasted (outbound-mms.spec.ts,
 * voice-extraction.spec.ts, placements-page.spec.ts each grew their own), so
 * "no horizontal overflow" meant something slightly different in each file - and
 * one of those dialects (the documentElement one) was measuring a box this shell
 * never lets scroll. TODO(e2e-documentelement-overflow-check-vacuous): the
 * outbound-mms copy still hand-rolls it; migrate it onto these two.
 *
 * Geometry ONLY. These read what the browser actually laid out; they never
 * inspect CSS text or computed styles, because a computed style proves that a
 * rule exists, not that the pixels landed where the spec says.
 */
import { expect, type Locator, type Page } from '@playwright/test';

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
 * ROUTE CONTENT must not scroll sideways. `where` names the surface under test
 * so a failure says which one overflowed rather than just "expected <= 1".
 *
 * WHY THIS MEASURES TWO BOXES AND NOT JUST THE DOCUMENT. A documentElement-only
 * measurement is VACUOUS in this shell: the expression can never be non-zero, so
 * it asserts nothing. The dashboard clamps the document to the viewport by
 * construction and hands the scrolling to an inner box:
 *
 *   dashboard/src/index.css              html, body, #root { height: 100% }
 *   app/AppFrame.module.css:5-8          .shell { display: flex; height: 100% }
 *   app/AppFrame.module.css:307-317      .main { flex: 1; min-width: 0; height: 100% }
 *                                        (min-width:0 is what stops a wide child
 *                                        from widening the flex row instead)
 *   app/AppFrame.module.css:362-366      .content { flex: 1; overflow-y: auto }
 *                                        and per CSS Overflow L3 a `visible` on
 *                                        the OTHER axis computes to `auto` once
 *                                        one axis is not visible/clip - so
 *                                        .content is an x-scroll container too
 *   app/AppFrame.tsx:166                 <main class=.content><Outlet /></main>
 *
 * Every routed page renders inside that <main>, so content that runs too wide
 * scrolls INSIDE <main> and the document never moves. <main> is therefore the
 * real scroll container and the one that carries the signal. The document delta
 * is still taken because the login and public layouts render their own <main>
 * outside the app shell, and because a future fixed/absolute surface could yet
 * escape the shell - we assert on whichever of the two is worse.
 *
 * FIXED-POSITION SURFACES ARE INVISIBLE TO THIS FUNCTION. A `position: fixed`
 * box is out of flow: it contributes to the scrollable overflow of NEITHER the
 * document NOR <main>. The Modal backdrop is exactly that
 * (routes/contact/Modal.module.css:3-12 `position: fixed; inset: 0`), so no
 * page-level measurement can ever see a dialog overflow, whichever box it reads.
 * Dialogs use expectNoHorizontalOverflowIn on their own box instead.
 *
 * The 1px tolerance is deliberate: sub-pixel layout rounding can leave
 * scrollWidth one pixel past clientWidth on a page that is visually flush.
 */
export async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const worst = await page.evaluate(() => {
    const doc = document.documentElement;
    let what = 'the document';
    let overflow = doc.scrollWidth - doc.clientWidth;
    const main = document.querySelector('main');
    if (main !== null && main.scrollWidth - main.clientWidth > overflow) {
      what = 'the routed <main>';
      overflow = main.scrollWidth - main.clientWidth;
    }
    return { what, overflow };
  });
  expect(worst.overflow, `${where}: ${worst.what} scrolls sideways`).toBeLessThanOrEqual(1);
}

/**
 * ONE SURFACE must not scroll sideways - the element-scoped twin of
 * expectNoHorizontalOverflow, and the ONLY honest check for a `position: fixed`
 * surface (a dialog), which contributes nothing to the page-level boxes above.
 *
 * It reads the element's OWN scrolling area. That works whether or not the
 * element is a scroll container: for an `overflow: visible` box scrollWidth is
 * max(clientWidth, the union with its descendants' overflow), which is how this
 * catches a Modal footer whose buttons run wider than the dialog even though the
 * dialog itself never scrolls. One blind spot to size your locator against: a
 * NESTED scroll container self-contains, and Modal's `.body` is `overflow: auto`
 * (Modal.module.css:64-72), so body content never reaches the dialog's own box.
 * Pass the innermost element whose overflow you actually mean to forbid.
 *
 * Same 1px sub-pixel tolerance and the same `where` label as the page-level
 * twin. This is the idiom the suite already uses on a chip
 * (flows/voice-extraction.spec.ts:229-236) and on the channel tab rail
 * (tour-roster.spec.ts).
 */
export async function expectNoHorizontalOverflowIn(
  surface: Locator,
  where: string,
): Promise<void> {
  const overflow = await surface.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, `${where}: this surface scrolls sideways`).toBeLessThanOrEqual(1);
}
