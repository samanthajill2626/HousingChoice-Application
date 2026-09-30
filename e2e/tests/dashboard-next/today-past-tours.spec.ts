// The Today page's "Past tours needing an outcome" section (Sam's item 18,
// Cameron 2026-09-30): the Tours page's Past rows minus no-shows, most recent
// first, up to five, with a link to the Past tab.
//
// Against the real backend on the hermetic lane. The lean world seeds NO tours,
// so this spec creates PAST-DATED tours through POST /api/tours (the route
// accepts any valid ISO scheduledAt; the arm writes a visible booked_too_late
// skipped reminder row and sends nothing), then advances some through the API
// - the same setup as tours-past.spec.ts.
//
//   Today lists the Not marked and the Needs outcome tour, most recent first,
//   and NOT the no-show; Today is not "all caught up"; the link names the Past
//   tab's own count ("See all 3" - it lists the no-show too). The Needs
//   outcome row opens its tour with the Record outcome dialog up, and the back
//   arrow ("Back to Today") returns to Today. Recording that outcome through
//   the API drops the row LIVE (the tour.updated event), with no reload. With
//   six qualifying tours Today shows five, and "See all 7 on the Past tab"
//   lands on seven Past rows. No horizontal overflow at 360px. Every tour this
//   spec creates is decided afterwards - in afterEach too, so a failure midway
//   cannot leave a later spec a Today section it did not expect.
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW
const UNIT_B = 'unit-0002'; // 88 Sycamore St
const HEADING = 'Past tours needing an outcome';
/** An 880px window: above the 768px nav breakpoint, so the expanded sidebar
 *  (240px) and the content padding leave a ~592px pane. */
const MID_880 = { width: 880, height: 800 } as const;

/** `daysAgo` days before today at `hour`:00 LOCAL, as an ISO instant. */
function pastAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Every tour the test creates, registered the moment it exists and decided in
 *  afterEach even if the test failed midway (review N5). */
const created: string[] = [];

async function createTour(page: Page, unitId: string, scheduledAt: string): Promise<string> {
  const res = await page.request.post(`${NEXT}/api/tours`, {
    data: { tenantId: TENANT_ID, unitId, scheduledAt, tourType: 'self_guided' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const tourId = ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
  created.push(tourId);
  return tourId;
}

async function patchTour(page: Page, tourId: string, data: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch(`${NEXT}/api/tours/${tourId}`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Decide a tour (toured + not a fit) so it leaves both Past and Today. */
async function decide(page: Page, tourId: string): Promise<void> {
  const res = await page.request.get(`${NEXT}/api/tours/${tourId}`);
  expect(res.ok()).toBeTruthy();
  const tour = ((await res.json()) as { tour: { status: string; outcome?: string } }).tour;
  if (tour.status !== 'toured') await patchTour(page, tourId, { status: 'toured' });
  if (tour.outcome === undefined) await patchTour(page, tourId, { outcome: 'not_a_fit', moveForward: false });
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

/** decide() for cleanup: never throws, so a teardown cannot mask the real failure. */
async function decideQuietly(page: Page, tourId: string): Promise<void> {
  try {
    await decide(page, tourId);
  } catch {
    // Best-effort: a later spec's reseed is the backstop.
  }
}

test.describe('Today - past tours needing an outcome', () => {
  test.afterEach(async ({ page }) => {
    for (const id of created.splice(0)) await decideQuietly(page, id);
  });

  test('lists past tours minus no-shows, deep-links Record outcome, back to Today, live drop, cap of five', async ({
    page,
  }) => {
    test.slow(); // API setup, three Today visits, a tour page, a live update, 360px.
    await devLogin(page); // page.request carries the session cookie for /api writes

    // Yesterday (stays scheduled = "Not marked"), two days ago (-> toured, no
    // outcome = "Needs outcome"), three days ago (-> no_show, NOT on Today).
    const notMarkedId = await createTour(page, UNIT_A, pastAt(1, 10));
    const needsOutcomeId = await createTour(page, UNIT_B, pastAt(2, 10));
    const noShowId = await createTour(page, UNIT_A, pastAt(3, 10));
    await patchTour(page, needsOutcomeId, { status: 'toured' });
    await patchTour(page, noShowId, { status: 'no_show' });

    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    const list = page.getByRole('list', { name: HEADING });
    await expect(list).toBeVisible();
    await expect(page.getByRole('heading', { name: HEADING })).toBeVisible();
    await expect(page.getByText(/all caught up/i)).toHaveCount(0);
    await expect(list.getByRole('listitem')).toHaveCount(2);
    // Most recent first; the Needs outcome row deep-links the dialog.
    const hrefs = await list.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs).toEqual([`/tours/${notMarkedId}`, `/tours/${needsOutcomeId}?outcome=1`]);
    await expect(list.getByRole('link', { name: /^Tour for Tasha Nguyen at .* on .*, Not marked$/ })).toBeVisible();
    await expect(list.getByRole('link', { name: /^Tour for Tasha Nguyen at .* on .*, Needs outcome$/ })).toBeVisible();
    // The no-show is on the Past tab only - nowhere on Today.
    await expect(page.locator(`a[href^="/tours/${noShowId}"]`)).toHaveCount(0);
    // The link names what the Past tab holds: these two plus the no-show.
    await expect(page.getByRole('link', { name: 'See all 3 on the Past tab' })).toHaveAttribute('href', '/tours/past');

    // Narrow: the section's rows must not push Today sideways.
    await page.setViewportSize(NARROW_360);
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expectNoHorizontalOverflow(page, 'Today with past tours at 360px');
    // Mid-width: an 880px window leaves a ~592px pane beside the expanded
    // sidebar - the band where a one-line past-tour row squeezed the property
    // out (review P2). The row stacks there, so no text inside any card is
    // clipped. Two cards, counted first, so the check is never vacuous.
    await page.setViewportSize(MID_880);
    const cards = list.getByRole('link');
    await expect(cards).toHaveCount(2);
    // The check's premise, asserted (review P-a): the pane is inside the
    // stacking band. A changed sidebar default fails HERE, loudly, instead of
    // quietly testing the one-line layout.
    const pane = Math.round((await list.boundingBox())?.width ?? 0);
    expect(pane, 'the Today pane width at an 880px window').toBeLessThan(760);
    const clipped = await cards.evaluateAll((els) =>
      els.flatMap((card) =>
        Array.from(card.querySelectorAll('*'))
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => `${el.tagName.toLowerCase()}: ${el.textContent ?? ''}`),
      ),
    );
    expect(clipped, 'clipped text inside a past-tour card at an 880px window').toEqual([]);
    await page.setViewportSize(WIDE_RESTORE);

    // The Needs outcome row: the tour page with Record outcome up, param stripped.
    await list.getByRole('link', { name: /, Needs outcome$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tours/${needsOutcomeId}$`));
    const dialog = page.getByRole('dialog', { name: 'Record outcome' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The back arrow names Today and goes there.
    await page.getByRole('link', { name: 'Back to Today' }).click();
    await expect(page).toHaveURL(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(list.getByRole('listitem')).toHaveCount(2);

    // Live: recording the outcome elsewhere drops the row without a reload.
    await patchTour(page, needsOutcomeId, { outcome: 'not_a_fit', moveForward: false });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(page.locator(`a[href^="/tours/${needsOutcomeId}"]`)).toHaveCount(0);

    // The cap: five more Not marked tours (4-8 days ago) make six that qualify.
    const older: string[] = [];
    for (let d = 4; d <= 8; d++) older.push(await createTour(page, d % 2 === 0 ? UNIT_A : UNIT_B, pastAt(d, 10)));
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(list.getByRole('listitem')).toHaveCount(5);
    const capped = await list.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    // Most recent first: yesterday's, then 4, 5, 6 and 7 days ago (8 is cut).
    expect(capped).toEqual([`/tours/${notMarkedId}`, ...older.slice(0, 4).map((id) => `/tours/${id}`)]);
    // Six qualify for Today; the Past tab also lists the no-show: seven.
    const seeAll = page.getByRole('link', { name: 'See all 7 on the Past tab' });
    await expect(seeAll).toBeVisible();
    await seeAll.click();
    await expect(page).toHaveURL(/\/tours\/past$/);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Past tours' }).getByRole('listitem')).toHaveCount(7);

    // Leave the lane as we found it: decide every tour this spec created. The
    // Past tab's empty state proves it (it renders only once loaded, so the
    // check is never vacuous the way a Today "section absent" check would be).
    for (const id of created) await decide(page, id);
    await page.goto(`${NEXT}/tours/past`);
    await expect(page.getByText('No past tours need attention in the last 90 days.')).toBeVisible();
  });
});
