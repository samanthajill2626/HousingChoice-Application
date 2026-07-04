import { test, expect, type Page } from '@playwright/test';

// Tours e2e spec (:5174) — covers the three scenarios from the task brief:
//
//   1. Schedule WITH a time (→ 'scheduled'): the /tours Upcoming section lists it,
//      the Today board shows it under "Tours today" linking to /tours/:tourId.
//   2. Schedule WITHOUT a time (→ 'requested'): /tours "Needs booking" lists it,
//      the Today board does NOT show it, the tour detail shows the requested state.
//   3. Nav ordering: Tours appears after Placements in the Workspace nav and routes
//      to /tours (frame.spec covers label presence; we add the ordering assertion
//      and verify the route renders the Tours heading here).
//
// Seeded data (app/src/lib/seedData.ts):
//   - tenant  contact-tenant-0001 = Tasha Nguyen
//   - unit    unit-0001 = 1450 Joseph E. Boone Blvd NW
//              tour_process = 'Text landlord; lockbox tours weekdays 9-5.'
//              → keyword 'lockbox' is not a recognised keyword; 'Text landlord' →
//                'landlord' → deriveTourType → 'landlord_led'
//   - unit    unit-0002 = 88 Sycamore St, Decatur (used as an alternative unit)
//
// The spec reseeds once per file (beforeAll) so all tests in this file share a
// clean DynamoDB state and any tours created in earlier tests do not interfere.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A_ADDRESS = '1450 Joseph E. Boone Blvd NW'; // unit-0001 — has tour_process

/** A datetime-local string (HTML input format, YYYY-MM-DDTHH:MM) at a fixed
 *  wall-clock `hour`:`minute` on `base`'s LOCAL calendar date. Paired with a
 *  pinned browser clock to schedule a tour at a deterministic in-day time (see the
 *  "schedule WITH a time" test) — NOT `Date.now() + 1h`, which flaked near local
 *  midnight (the tour rolled into tomorrow, out of the Today board's local-today
 *  window). */
function localDatetimeAt(base: Date, hour: number, minute: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}` +
    `T${pad(hour)}:${pad(minute)}`
  );
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  // `exact: true` — match ONLY the <h1>Today</h1> board title, never the
  // <h2>Tours today</h2> section heading (both contain the substring "today", so a
  // non-exact match trips Playwright strict mode once that section renders).
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

// Reseed once before the entire describe block so every test starts clean.
test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tours page', () => {
  test('nav: Tours appears before Placements in the Workspace nav and routes to /tours', async ({
    page,
  }) => {
    await devLogin(page);
    const workspace = page.getByRole('navigation', { name: 'Workspace' });

    // Both links must be present (frame.spec also asserts labels; here we add the
    // route + ordering check).
    const placements = workspace.getByRole('link', { name: 'Placements', exact: true });
    const tours = workspace.getByRole('link', { name: 'Tours', exact: true });
    await expect(placements).toBeVisible();
    await expect(tours).toBeVisible();

    // DOM ordering: the Tours link appears BEFORE the Placements link in the nav
    // (Workspace was reordered 2026-07-04 → …Properties · Tours · Placements; see
    // dashboard/src/app/nav.ts).
    const placementsIndex = await placements.evaluate(
      (el) => Array.from(el.closest('nav')!.querySelectorAll('a')).indexOf(el as HTMLAnchorElement),
    );
    const toursIndex = await tours.evaluate(
      (el) => Array.from(el.closest('nav')!.querySelectorAll('a')).indexOf(el as HTMLAnchorElement),
    );
    expect(toursIndex).toBeLessThan(placementsIndex);

    // The link routes to /tours and renders the Tours heading.
    await tours.click();
    await expect(page).toHaveURL(/\/tours$/);
    await expect(page.getByRole('heading', { name: 'Tours' })).toBeVisible();
  });

  test('schedule WITH a time: appears in Upcoming + Today board under Tours today', async ({
    page,
  }) => {
    // Pin the browser wall-clock to a FIXED mid-morning instant on today's local
    // date so this test is deterministic at ANY real hour. WHY (do NOT revert to
    // `Date.now() + 1h`): the Today board derives "today" from the *browser's* clock
    // (useToday → localDayWindow(new Date())) and the Schedule dialog rejects a past
    // datetime. With now+1h, a run after ~23:00 local scheduled the tour into
    // *tomorrow* — so it fell outside the board's local-today window and the "Tours
    // today" list never rendered (the near-midnight flake this fixes). Pinning to
    // 09:00 and scheduling for 12:00 keeps the tour unambiguously *future* AND
    // *today*. setFixedTime pins Date.now()/new Date() but keeps timers running
    // (SSE/debounce), so the app behaves normally.
    const base = new Date();
    const pinnedNow = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0, 0, 0);
    await page.clock.setFixedTime(pinnedNow);

    await devLogin(page);

    // Navigate to the seeded tenant's contact page.
    await page.goto(`${NEXT}/contacts/${TENANT_ID}`);
    await expect(page.getByText('Tasha Nguyen').first()).toBeVisible();

    // Open the "Schedule a tour" dialog from the Tours card.
    await page.getByRole('button', { name: 'Schedule a tour' }).click();
    const dialog = page.getByRole('dialog', { name: /Schedule a tour/i });
    await expect(dialog).toBeVisible();

    // The tenant side is locked (read-only) — visible as a group.
    await expect(dialog.getByRole('group', { name: 'Tenant' })).toContainText('Tasha Nguyen');

    // Pick the seeded unit (unit-0001 / 1450 Joseph E. Boone Blvd NW).
    const propertyField = dialog.getByRole('combobox', { name: 'Unit' });
    await propertyField.fill('Joseph');
    await dialog.getByRole('option', { name: /Joseph E\. Boone/ }).click();

    // Tour type should now be prefilled — unit-0001 has tour_process containing
    // "landlord" → deriveTourType → 'landlord_led'.
    // The select value should be 'Landlord-led' (the TOUR_TYPE_LABELS display value).
    const tourTypeSelect = dialog.getByRole('combobox', { name: 'Tour type' });
    await expect(tourTypeSelect).toHaveValue('landlord_led');

    // Schedule for a FIXED time solidly inside today — noon local, comfortably
    // future vs the pinned 09:00 and 12 h from both midnight boundaries.
    const futureTime = localDatetimeAt(base, 12, 0);
    await dialog.getByLabel('Date and time').fill(futureTime);

    // Submit.
    await dialog.getByRole('button', { name: 'Schedule' }).click();

    // Dialog closes and we land on /tours/:tourId.
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/tours\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });

    // Capture the tour id from the URL for later assertions.
    const tourUrl = page.url();
    const tourIdMatch = /\/tours\/([A-Za-z0-9_-]+)$/.exec(tourUrl);
    expect(tourIdMatch, 'Expected to be on /tours/:tourId').not.toBeNull();
    const tourId = tourIdMatch![1]!;

    // ── Tour detail sanity ──
    // The detail page renders inside an article — status is "Scheduled".
    const detail = page.getByRole('article', { name: 'Tour details' });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(/Scheduled/i).first()).toBeVisible();

    // ── /tours page — Upcoming section lists the tour ──
    await page.goto(`${NEXT}/tours`);
    await expect(page.getByRole('heading', { name: 'Tours' })).toBeVisible();

    // The Upcoming section must contain a row linking to this tour's detail.
    const upcoming = page.getByRole('region', { name: 'Upcoming tours' });
    await expect(upcoming).toBeVisible();
    const tourLink = upcoming.getByRole('link', {
      name: new RegExp(`Tour for Tasha Nguyen at .*Joseph E\\. Boone`, 'i'),
    });
    await expect(tourLink).toBeVisible({ timeout: 10_000 });
    // The link href points to /tours/:tourId.
    await expect(tourLink).toHaveAttribute('href', `/tours/${tourId}`);

    // ── Today board — "Tours today" section shows this tour ──
    // The Today board derives "today" from the browser clock (useToday →
    // localDayWindow) and IGNORES query params, so just navigate home; the pinned
    // clock guarantees our noon tour is inside the board's local-today window.
    // `exact: true` matches ONLY the <h1>Today</h1> title, not the <h2>Tours
    // today</h2> section heading that now renders (both contain "today").
    await page.goto(`${NEXT}/`);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

    // The "Tours today" section must exist and contain a link to this tour.
    const toursSection = page.getByRole('list', { name: 'Tours today' });
    await expect(toursSection).toBeVisible({ timeout: 10_000 });
    const todayLink = toursSection.getByRole('link').filter({ hasText: /Tasha Nguyen/ });
    await expect(todayLink).toBeVisible();
    await expect(todayLink).toHaveAttribute('href', `/tours/${tourId}`);
  });

  test('schedule WITHOUT a time: appears in Needs booking, not in Today board, detail shows requested', async ({
    page,
  }) => {
    await devLogin(page);

    // Open the schedule dialog from the tenant file.
    await page.goto(`${NEXT}/contacts/${TENANT_ID}`);
    await expect(page.getByText('Tasha Nguyen').first()).toBeVisible();

    await page.getByRole('button', { name: 'Schedule a tour' }).click();
    const dialog = page.getByRole('dialog', { name: /Schedule a tour/i });
    await expect(dialog).toBeVisible();

    // Pick the unit.
    const propertyField = dialog.getByRole('combobox', { name: 'Unit' });
    await propertyField.fill('Joseph');
    await dialog.getByRole('option', { name: /Joseph E\. Boone/ }).click();

    // Leave Date and time EMPTY — the "book it later" hint should be visible.
    await expect(
      dialog.getByText('Leave empty to create the tour without a time — book it later.'),
    ).toBeVisible();

    // The Date and time input must be blank.
    await expect(dialog.getByLabel('Date and time')).toHaveValue('');

    // Submit with no time.
    await dialog.getByRole('button', { name: 'Schedule' }).click();

    // Dialog closes and we land on /tours/:tourId.
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/tours\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });

    const tourUrl = page.url();
    const tourIdMatch = /\/tours\/([A-Za-z0-9_-]+)$/.exec(tourUrl);
    expect(tourIdMatch, 'Expected to be on /tours/:tourId').not.toBeNull();
    const tourId = tourIdMatch![1]!;

    // ── Tour detail: status is "Requested" (the 'requested' label) ──
    const detail = page.getByRole('article', { name: 'Tour details' });
    await expect(detail).toBeVisible();
    // The status <dd> renders the TOUR_STATUS_LABELS text ("Requested") and has
    // aria-label="Status: Requested". Use getByLabel (aria-label match) since
    // Playwright doesn't expose bare <dd> with aria-label via getByRole('definition').
    await expect(detail.getByLabel('Status: Requested')).toBeVisible();
    // Scheduled row shows the timeless rendering (no time set).
    await expect(detail.getByLabel('Scheduled: Not yet booked')).toBeVisible();

    // ── /tours page — "Needs booking" section lists the tour ──
    await page.goto(`${NEXT}/tours`);
    await expect(page.getByRole('heading', { name: 'Tours' })).toBeVisible();

    const needsBooking = page.getByRole('region', { name: 'Needs booking' });
    await expect(needsBooking).toBeVisible();
    const bookingLink = needsBooking.getByRole('link', {
      name: new RegExp(`Tour for Tasha Nguyen at .*Joseph E\\. Boone`, 'i'),
    });
    await expect(bookingLink).toBeVisible({ timeout: 10_000 });
    await expect(bookingLink).toHaveAttribute('href', `/tours/${tourId}`);

    // ── Today board — "Tours today" section must NOT contain this tour ──
    // A requested tour has no scheduledAt, so it is excluded from the tours_today
    // window regardless of the clock. The board derives "today" from the browser
    // clock (not query params), so navigate home. `exact: true` matches only the
    // <h1>Today</h1> title, not the <h2>Tours today</h2> heading that the earlier
    // scheduled-tour test leaves visible (its noon tour persists via the shared
    // once-per-file reseed).
    await page.goto(`${NEXT}/`);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

    // Either the "Tours today" section is absent entirely, or it doesn't contain
    // a link to the requested tour.
    const toursTodayList = page.getByRole('list', { name: 'Tours today' });
    const todayLinkForRequestedTour = toursTodayList.getByRole('link', {
      name: /Tasha Nguyen/,
    });

    // We don't know whether a PREVIOUS test's scheduled tour is still visible;
    // but THIS requested tour must not be there. If "Tours today" exists at all,
    // the link to our requested tourId must be absent.
    const hasTodaySection = await toursTodayList.isVisible().catch(() => false);
    if (hasTodaySection) {
      // Assert that the link to /tours/<requestedTourId> is not present.
      await expect(page.locator(`a[href="/tours/${tourId}"]`)).toHaveCount(0);
    }
    // If the section is absent, there is nothing to assert — that also satisfies
    // the requirement.

    // Additional: the requested tour DOES link from the Needs booking section
    // (re-assert after navigating away and back to ensure persistence).
    await page.goto(`${NEXT}/tours`);
    await expect(
      page.getByRole('region', { name: 'Needs booking' }).getByRole('link', {
        name: new RegExp(`Tour for Tasha Nguyen at .*Joseph E\\. Boone`, 'i'),
      }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
