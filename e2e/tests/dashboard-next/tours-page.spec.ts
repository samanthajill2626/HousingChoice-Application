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

    // Provenance (spec S3 / E1): unit-0001 has NO structured tour_type, only
    // free-text tour_process, so the prefill is the keyword GUESS - caption #2.
    await expect(dialog.locator('#schedule-tour-type-provenance')).toHaveText(
      "Guessed from the property's tour notes - check it",
    );

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
    // The rebuilt detail page shows the tour StatusBadge in the header band (no
    // more <article>/<dd> aria-labels). Scope to the page header via the
    // "Tour - <address>" identity so the status word can't collide with a card.
    const detailHeader = page.locator('header').filter({ hasText: 'Tour -' });
    await expect(detailHeader.getByText('Scheduled', { exact: true })).toBeVisible();

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
    // The rebuilt page shows the status as a header StatusBadge pill plus a "Not
    // booked" facts line (no more <dd> aria-labels). Scope to the page header.
    const detailHeader = page.locator('header').filter({ hasText: 'Tour -' });
    await expect(detailHeader.getByText('Requested', { exact: true })).toBeVisible();
    await expect(detailHeader.getByText('Not booked')).toBeVisible();

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

  // Structured tour_type provenance (spec S2/S3, edge notes E1). Drives the FULL
  // round-trip against the real backend: set a property's Tour type via the edit
  // form -> open Schedule a tour and pick it -> the modal prefills the value with
  // the "From the property" caption; overriding the picker drops that caption
  // (E1 - a manual pick must not keep a property-provenance claim); creating the
  // tour carries the OVERRIDDEN type. Uses a FRESH unit (not a seeded one) so it
  // is independent of the lean seed baseline and other specs.
  test('tour type provenance: From the property, override drops the caption, create carries the override', async ({
    page,
  }) => {
    await devLogin(page);

    // -- Create a fresh available property with NO structured tour_type yet. --
    // Run-unique street number so the Unit typeahead option is collision-free.
    // page.request shares the dev-login session cookie (the /api/* writes need
    // auth); the bare `request` fixture is unauthenticated -> 401.
    const addressLine1 = `${`${Date.now()}`.slice(-5)}01 Provenance Way NW`;
    const created = await page.request.post(`${NEXT}/api/units`, {
      data: {
        landlordId: 'contact-landlord-0001',
        jurisdiction: 'atlanta_housing',
        beds: 2,
        rent_min: 1500,
        rent_max: 1600,
        address: { line1: addressLine1, city: 'Atlanta', state: 'GA', zip: '30314' },
      },
    });
    expect(created.ok(), `create unit failed: ${created.status()} ${await created.text()}`).toBeTruthy();
    const unitId = ((await created.json()) as { unit: { unitId: string } }).unit.unitId;
    const published = await page.request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(published.ok()).toBeTruthy();

    // -- Set its Tour type to Landlord-led via the property edit form. --
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Edit property/i }).click();
    const editDialog = page.getByRole('dialog', { name: /Edit property/i });
    await editDialog.getByLabel('Tour type').selectOption('landlord_led');
    await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // -- Open Schedule a tour from the seeded tenant and pick this property. --
    await page.goto(`${NEXT}/contacts/${TENANT_ID}`);
    await expect(page.getByText('Tasha Nguyen').first()).toBeVisible();
    await page.getByRole('button', { name: 'Schedule a tour' }).click();
    const dialog = page.getByRole('dialog', { name: /Schedule a tour/i });
    await expect(dialog).toBeVisible();

    // The unit side may arrive pre-committed (the last property sent); resolve it
    // to OUR fresh unit either way (mirrors steps.ts teamCreatesTourFromInterest).
    const unitBox = dialog.getByRole('combobox', { name: 'Unit' });
    const clearUnit = dialog.getByRole('button', { name: 'Clear Unit' });
    await expect(async () => {
      if (await clearUnit.isVisible()) {
        if ((await unitBox.inputValue()).includes(addressLine1)) return;
        await clearUnit.click();
      }
      await unitBox.fill(addressLine1, { timeout: 2_000 });
      await dialog.getByRole('option', { name: addressLine1 }).click({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    // 1. "From the property": the structured value prefills + the honest caption.
    const tourTypeSelect = dialog.getByRole('combobox', { name: 'Tour type' });
    await expect(tourTypeSelect).toHaveValue('landlord_led');
    const provenance = dialog.locator('#schedule-tour-type-provenance');
    await expect(provenance).toHaveText('From the property');

    // 2. Override (E1): picking a different type drops the property-provenance
    //    caption entirely (the component sets provenance -> null on manual pick).
    await tourTypeSelect.selectOption('self_guided');
    await expect(tourTypeSelect).toHaveValue('self_guided');
    await expect(provenance).toHaveCount(0);

    // 3. Create carries the override: submit timeless -> the tour is self_guided.
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/tours\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });
    const tourId = /\/tours\/([A-Za-z0-9_-]+)$/.exec(page.url())![1]!;
    const tourRes = await page.request.get(`${NEXT}/api/tours/${tourId}`);
    expect(tourRes.ok()).toBeTruthy();
    const tour = ((await tourRes.json()) as { tour: { tourType: string } }).tour;
    expect(tour.tourType).toBe('self_guided');
  });

  // Closed tours are OFF the page by default; the header "Show closed" toggle
  // reveals them (Cameron 2026-07-15). Builds a CLOSED tour via the API -
  // booked YESTERDAY (outside the Upcoming window, so it can't leak into the
  // other tests' sections), toured, then exit-gated not-a-fit (the same PATCH
  // shape the Record-outcome modal sends; closes in the same PATCH).
  test('closed tours: hidden by default, revealed by the "Show closed" toggle', async ({
    page,
  }) => {
    await devLogin(page); // page.request needs the session cookie for /api writes

    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const created = await page.request.post(`${NEXT}/api/tours`, {
      data: { tenantId: TENANT_ID, unitId: 'unit-0002', scheduledAt: yesterday, tourType: 'self_guided' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const tourId = ((await created.json()) as { tour: { tourId: string } }).tour.tourId;
    const toured = await page.request.patch(`${NEXT}/api/tours/${tourId}`, {
      data: { status: 'toured' },
    });
    expect(toured.ok(), await toured.text()).toBeTruthy();
    const closed = await page.request.patch(`${NEXT}/api/tours/${tourId}`, {
      data: { outcome: 'not_a_fit', moveForward: false, status: 'closed' },
    });
    expect(closed.ok(), await closed.text()).toBeTruthy();

    await page.goto(`${NEXT}/tours`);
    await expect(page.getByRole('heading', { name: 'Tours' })).toBeVisible();

    // Hidden by default.
    await expect(page.getByRole('region', { name: 'Closed tours' })).toHaveCount(0);

    // Toggle on -> the Closed section lists the tour, linking to its detail.
    const toggle = page.getByRole('button', { name: 'Show closed' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    const region = page.getByRole('region', { name: 'Closed tours' });
    await expect(region).toBeVisible();
    const row = region.getByRole('link', {
      name: new RegExp(`Tour for Tasha Nguyen at .*Sycamore`, 'i'),
    });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveAttribute('href', `/tours/${tourId}`);

    // Toggle off hides the section again.
    await toggle.click();
    await expect(page.getByRole('region', { name: 'Closed tours' })).toHaveCount(0);
  });
});
