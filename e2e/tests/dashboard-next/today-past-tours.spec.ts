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
//   and NOT the no-show; Today is not "all caught up"; "Open the Past tab"
//   links to /tours/past. The Needs
//   outcome row opens its tour with the Record outcome dialog up, and the back
//   arrow ("Back to Today") returns to Today. Recording that outcome through
//   the API drops the row LIVE (the tour.updated event), with no reload. With
//   six qualifying tours Today shows five and "See all 6 on the Past tab".
//   No horizontal overflow at 360px. Every tour this spec creates is decided
//   at the end, so no later spec inherits a Today section it did not expect.
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW
const UNIT_B = 'unit-0002'; // 88 Sycamore St
const HEADING = 'Past tours needing an outcome';

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

async function createTour(page: Page, unitId: string, scheduledAt: string): Promise<string> {
  const res = await page.request.post(`${NEXT}/api/tours`, {
    data: { tenantId: TENANT_ID, unitId, scheduledAt, tourType: 'self_guided' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
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

test.describe('Today - past tours needing an outcome', () => {
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
    const created = [notMarkedId, needsOutcomeId, noShowId];

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
    // Two rows, all shown: the footer offers the Past tab without a count.
    await expect(page.getByRole('link', { name: 'Open the Past tab' })).toHaveAttribute('href', '/tours/past');

    // Narrow: the section's rows must not push Today sideways.
    await page.setViewportSize(NARROW_360);
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expectNoHorizontalOverflow(page, 'Today with past tours at 360px');
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
    for (let d = 4; d <= 8; d++) created.push(await createTour(page, d % 2 === 0 ? UNIT_A : UNIT_B, pastAt(d, 10)));
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(list.getByRole('listitem')).toHaveCount(5);
    const capped = await list.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    // Most recent first: yesterday's, then 4, 5, 6 and 7 days ago (8 is cut).
    expect(capped).toEqual([`/tours/${notMarkedId}`, ...created.slice(3, 7).map((id) => `/tours/${id}`)]);
    const seeAll = page.getByRole('link', { name: 'See all 6 on the Past tab' });
    await expect(seeAll).toBeVisible();
    await seeAll.click();
    await expect(page).toHaveURL(/\/tours\/past$/);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();

    // Leave the lane as we found it: decide every tour this spec created. The
    // Past tab's empty state proves it (it renders only once loaded, so the
    // check is never vacuous the way a Today "section absent" check would be).
    for (const id of created) await decide(page, id);
    await page.goto(`${NEXT}/tours/past`);
    await expect(page.getByText('No past tours need attention in the last 90 days.')).toBeVisible();
  });
});
