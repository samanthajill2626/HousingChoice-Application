// Tour auto-close and reopen (Sam's item 18, 2026-10-01; spec
// docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md sections
// 6, 7, 9.2, 9.3 and 11).
//
// Against the real backend on the hermetic lane. The lean world seeds NO tours,
// so this spec creates PAST-DATED tours through POST /api/tours (the create
// texts nobody: a past tour's reminder rungs are born skipped) and runs the
// sweep through the dev seam POST /__dev/tour-auto-close/tick instead of
// waiting two weeks. EVERY tick passes `tourIds`: an unscoped tick with a
// future `now` would close every other spec's due tours on the lane. No client
// can set createdAt, so a tour created here is due only 14 days after its
// creation - the lane's real worker (first poll 15 minutes after boot, wall
// clock) never closes one; a tick with `now` 15 days ahead does.
//
//   1. A tour dated 20 days ago is NOT closed by a tick at the real time (its
//      clock starts at its creation, today); a tick 15 days ahead closes it
//      with "No outcome recorded" (closed, auto-closed from scheduled). The
//      Closed tab row carries that outcome badge; the tour page's Outcome card
//      reads "Closed automatically on <date>" and the page offers "Reopen
//      tour"; nothing reached the tenant or the property's landlord.
//   2. Reopened from the tour page, the dialog says it goes back to Not
//      marked; "Yes, reopen" returns it to Scheduled (nothing sent), the Past
//      tab lists it as Not marked, and it has a fresh two weeks: a tick 1 day
//      ahead leaves it open, one 15 days ahead closes it again.
//   3. A toured tour closed as "Not a fit" reopens straight into the Record
//      outcome dialog; canceled, the tour reads Toured with "Record outcome".
//
// Every tour a test creates is decided in afterEach (toured + not a fit)
// unless it ended closed, so no later spec meets it on the Past tab or Today.
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import { getOutboundTo } from '../../fixtures/fakeTwilio.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW
const UNIT_B = 'unit-0002'; // 88 Sycamore St
const DAY_MS = 24 * 60 * 60 * 1000;
/** The Reopen dialog's body for each target (dashboard tourReopen.ts REOPEN_BODY). */
const REOPEN_TO_SCHEDULED =
  'This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent.';
const REOPEN_TO_TOURED = 'This tour goes back to Toured so you can record a different outcome. Nothing is sent.';

/** `daysAgo` days before today at `hour`:00 LOCAL, as an ISO instant. */
function pastAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** `days` days after the real now, as an ISO instant (a tick's `now`). */
const daysFromNow = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Every tour the test creates, registered the moment it exists and decided in
 *  afterEach even if the test failed midway. */
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

interface TourWire {
  status: string;
  outcome?: string;
  autoClosedAt?: string;
  autoClosedFrom?: string;
  lastMarkedAt?: string;
}

async function getTour(page: Page, tourId: string): Promise<TourWire> {
  const res = await page.request.get(`${NEXT}/api/tours/${tourId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: TourWire }).tour;
}

interface TickSummary {
  scanned: number;
  due: number;
  closed: number;
  lost: number;
  failed: number;
}

/** One auto-close pass over `tourIds` ONLY (the dev seam; `now` defaults to
 *  the wall clock). Never call it without ids - see the header. */
async function tick(page: Page, tourIds: string[], now?: string): Promise<TickSummary> {
  const res = await page.request.post(`${NEXT}/__dev/tour-auto-close/tick`, {
    data: { tourIds, ...(now !== undefined && { now }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as TickSummary;
}

/** A contact's phone, read through the API - never hard-coded. Asserted E.164,
 *  so a missing phone cannot turn the nothing-sent read into a vacuous []. */
async function phoneOf(page: Page, contactId: string): Promise<string> {
  const res = await page.request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const phone = ((await res.json()) as { contact: { phone?: string } }).contact.phone ?? '';
  expect(phone, `${contactId} has an E.164 phone`).toMatch(/^\+\d{10,15}$/);
  return phone;
}

/** The phone of a unit's landlord: two reads - the unit's roster rows carry no
 *  phone, so the unit's landlordId, then that contact. */
async function landlordPhoneOf(page: Page, unitId: string): Promise<string> {
  const res = await page.request.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const landlordId = ((await res.json()) as { unit: { landlordId?: string } }).unit.landlordId ?? '';
  expect(landlordId, `${unitId} has a landlord`).not.toBe('');
  return phoneOf(page, landlordId);
}

/** The tour page's header band - its status badge and primary CTA live here. */
const tourHeader = (page: Page) => page.locator('header').filter({ hasText: 'Tour -' });

/** The tour page's Outcome card. Outcome text is read INSIDE it: the page also
 *  renders the tour's activity (the transcript and the Activity card), and the
 *  label "Closed automatically: no outcome recorded after two weeks" contains
 *  both "No outcome recorded" and "Closed automatically" - getByText(string) is
 *  a case-insensitive substring match. */
const outcomeCard = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Outcome', exact: true }) });

/** Decide a tour (toured + not a fit) so it leaves both Past and Today. A
 *  CLOSED tour is already off both, and PATCH refuses any change to it (409
 *  illegal_status_transition), so it is left as it is. */
async function decide(page: Page, tourId: string): Promise<void> {
  const tour = await getTour(page, tourId);
  if (tour.status === 'closed') return;
  if (tour.status !== 'toured') await patchTour(page, tourId, { status: 'toured' });
  if (tour.outcome === undefined) await patchTour(page, tourId, { outcome: 'not_a_fit', moveForward: false });
}

/** decide() for cleanup: never throws, so a teardown cannot mask the real failure. */
async function decideQuietly(page: Page, tourId: string): Promise<void> {
  try {
    await decide(page, tourId);
  } catch {
    // Best-effort: a later spec's reseed is the backstop.
  }
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tour auto-close and reopen', () => {
  test.afterEach(async ({ page }) => {
    for (const id of created.splice(0)) await decideQuietly(page, id);
  });

  test('a tour with no outcome closes on its own two weeks on, and nothing is sent', async ({ page }) => {
    test.slow(); // two ticks, the Closed tab, the tour page and a settle on a possibly cold lane
    await devLogin(page); // page.request carries the session cookie for /api writes
    const since = new Date().toISOString(); // the nothing-sent window opens before the tour exists
    const tenantPhone = await phoneOf(page, TENANT_ID);
    const landlordPhone = await landlordPhoneOf(page, UNIT_A);

    const tourId = await createTour(page, UNIT_A, pastAt(20, 10));
    // Dated 20 days ago but CREATED today: the clock starts at the later of the
    // two, so a tick at the real time reads it (scanned 1) and leaves it open...
    expect(await tick(page, [tourId])).toMatchObject({ scanned: 1, due: 0, closed: 0 });
    // ...and a tick 15 days on - past creation + 14 days - closes it.
    expect(await tick(page, [tourId], daysFromNow(15))).toMatchObject({
      scanned: 1,
      due: 1,
      closed: 1,
      lost: 0,
      failed: 0,
    });
    const closed = await getTour(page, tourId);
    expect(closed).toMatchObject({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'scheduled' });
    expect(typeof closed.autoClosedAt, 'autoClosedAt is stamped').toBe('string');

    // The Closed tab: the row's badges read "Closed" and "No outcome recorded"
    // (scoped to the row - the tab's intro also says "closed automatically
    // with no outcome").
    await page.goto(`${NEXT}/tours/closed`);
    await expect(page.getByRole('heading', { name: 'Closed tours' })).toBeVisible();
    const closedRow = page.getByRole('region', { name: 'Closed tours' }).locator(`a[href="/tours/${tourId}"]`);
    await expect(closedRow).toBeVisible();
    await expect(closedRow.getByText('Closed', { exact: true })).toBeVisible();
    await expect(closedRow.getByText('No outcome recorded', { exact: true })).toBeVisible();

    // The tour page: Closed; the Outcome card says it closed automatically and
    // when (shortDate of autoClosedAt - local month and day, so the expected
    // text is formatted IN THE BROWSER, as the page formats it), with no
    // "Moving forward" row; "Reopen tour" is the way back.
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(tourHeader(page).getByText('Closed', { exact: true })).toBeVisible();
    const card = outcomeCard(page);
    await expect(card.getByText('No outcome recorded', { exact: true })).toBeVisible();
    const closedOn = await page.evaluate(
      (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      closed.autoClosedAt ?? '',
    );
    await expect(card.getByText('Closed automatically on')).toHaveText(`Closed automatically on ${closedOn}`);
    await expect(card.getByText('Moving forward')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reopen tour' })).toBeVisible();

    // Nothing was sent: the sweep has no messaging dependency at all, but a
    // regression that ENQUEUED a send would land in the fake's thread store
    // asynchronously, so give the worker a moment before the per-party reads.
    await page.waitForTimeout(2000);
    expect(await getOutboundTo(page.request, { to: tenantPhone, since })).toEqual([]);
    expect(await getOutboundTo(page.request, { to: landlordPhone, since })).toEqual([]);
  });

  test('reopen returns it to Not marked and gives it a fresh two weeks', async ({ page }) => {
    test.slow(); // a tick, the tour page and a dialog, a settle, the Past tab, two more ticks
    await devLogin(page);
    const tenantPhone = await phoneOf(page, TENANT_ID);
    const landlordPhone = await landlordPhoneOf(page, UNIT_A);
    const tourId = await createTour(page, UNIT_A, pastAt(20, 10));
    expect(await tick(page, [tourId], daysFromNow(15))).toMatchObject({ scanned: 1, due: 1, closed: 1 });
    const closed = await getTour(page, tourId);
    expect(closed).toMatchObject({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'scheduled' });

    // Reopen from the tour page. The confirm is scoped to the dialog: the
    // page behind the shared Modal stays live.
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(tourHeader(page).getByText('Closed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen tour' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reopen tour' });
    await expect(dialog.getByText(REOPEN_TO_SCHEDULED, { exact: true })).toBeVisible();
    const since = new Date().toISOString(); // the reopen's own nothing-sent window
    await dialog.getByRole('button', { name: 'Yes, reopen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tourHeader(page).getByText('Scheduled', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark toured' })).toBeVisible();

    // On the wire: back to scheduled, the close's facts gone, and the mark
    // moved to the reopen. The ticks below cannot tell "two weeks from the
    // reopen" from "two weeks from the creation" (both are today here), so
    // the restarted clock is read directly - server clock against server clock.
    const reopened = await getTour(page, tourId);
    expect(reopened.status).toBe('scheduled');
    expect(reopened.outcome).toBeUndefined();
    expect(reopened.autoClosedAt).toBeUndefined();
    expect(reopened.autoClosedFrom).toBeUndefined();
    expect(Date.parse(reopened.lastMarkedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(closed.autoClosedAt ?? ''));

    // Nothing was sent by the reopen either (the dialog says so).
    await page.waitForTimeout(2000);
    expect(await getOutboundTo(page.request, { to: tenantPhone, since })).toEqual([]);
    expect(await getOutboundTo(page.request, { to: landlordPhone, since })).toEqual([]);

    // Back on the Past tab as Not marked.
    await page.goto(`${NEXT}/tours/past`);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();
    const pastRow = page
      .getByRole('region', { name: 'Past tours' })
      .getByRole('listitem')
      .filter({ has: page.locator(`a[href="/tours/${tourId}"]`) });
    await expect(pastRow.getByText('Not marked', { exact: true })).toBeVisible();

    // A fresh two weeks: open a day on, closed again 15 days on.
    expect(await tick(page, [tourId], daysFromNow(1))).toMatchObject({ scanned: 1, due: 0, closed: 0 });
    expect(await tick(page, [tourId], daysFromNow(15))).toMatchObject({ scanned: 1, due: 1, closed: 1 });
    expect(await getTour(page, tourId)).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
    });
  });

  test('a not-a-fit tour reopens straight into Record outcome', async ({ page }) => {
    await devLogin(page);
    const tourId = await createTour(page, UNIT_B, pastAt(3, 10));
    await patchTour(page, tourId, { status: 'toured' });
    await patchTour(page, tourId, { outcome: 'not_a_fit', moveForward: false, status: 'closed' });

    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(tourHeader(page).getByText('Closed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen tour' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reopen tour' });
    await expect(dialog.getByText(REOPEN_TO_TOURED, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes, reopen' }).click();

    // The reopen hands its modal slot straight to the exit gate - and keeps it
    // there (the confirm's own close is guarded).
    const outcomeDialog = page.getByRole('dialog', { name: 'Record outcome' });
    await expect(outcomeDialog).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await outcomeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tourHeader(page).getByText('Toured', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record outcome' })).toBeVisible();

    const reopened = await getTour(page, tourId);
    expect(reopened.status).toBe('toured');
    expect(reopened.outcome).toBeUndefined();
  });
});
