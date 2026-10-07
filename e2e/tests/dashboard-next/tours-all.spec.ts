// The Tours page's All tab (Sam's item 18, final part; spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md section 9).
//
// Against the real backend on the hermetic lane. The lean world seeds NO tours,
// so each test creates the tours it needs through POST /api/tours for the lean
// seed's tenant (Tasha Nguyen) on the lean seed's two properties, then moves
// them through PATCH /api/tours/:id: a request (no time), an upcoming tour
// three days out, a no-show two days ago, a DATED canceled tour tomorrow and an
// undated toured tour (a request marked toured with the date left blank).
//
//   The tab strip reads All, Active, Past, Closed, and /tours still opens
//   Active. Any time + the Needs booking chip lists only the request, its date
//   reading "Needs booking"; Upcoming lists the upcoming and the canceled tour
//   (Canceled badge) and none of the others; Past + No show lists only the
//   no-show; Any time lists the two undated rows after every dated one, the
//   request first, the undated toured one reading "Undated" - as its tour page
//   does. A row opened and the back arrow return to the same filtered list
//   with the search, the opened row focused. GET /api/tours/list?limit=2 walks
//   to nextCursor: null through the real stack, each id exactly once.
//
// Earlier tests leave their tours behind (closed out in afterEach), so EVERY
// assertion is about the test's OWN ids, by href, and every list step searches
// for the tenant, so the walk covers the whole filtered list. Future tours are
// a day or more out and the canceled one's rungs are swept by its PATCH, so
// nothing sends during the run.
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW
const UNIT_B = 'unit-0002'; // 88 Sycamore St
/** The tenant search every list step types (spec 9). */
const SEARCH = 'Tasha';

/** `daysAgo` days before today at `hour`:00 LOCAL, as an ISO instant. */
function pastAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** `daysAhead` days after today at `hour`:00 LOCAL, as an ISO instant. */
function futureAt(daysAhead: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Every tour the test creates, registered the moment it exists and closed out
 *  in afterEach even if the test failed midway. */
const created: string[] = [];

/** A tour for the lean tenant; without `scheduledAt` it is a request. */
async function createTour(page: Page, unitId: string, scheduledAt?: string): Promise<string> {
  const res = await page.request.post(`${NEXT}/api/tours`, {
    data: {
      tenantId: TENANT_ID,
      unitId,
      tourType: 'self_guided',
      ...(scheduledAt !== undefined && { scheduledAt }),
    },
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

/** Close a tour out so no later spec meets it on the Past tab or Today:
 *  toured (unless it already is), then "not a fit" - it STAYS toured, it is
 *  not closed. A canceled tour is on no work list: no write at all. */
async function closeOut(page: Page, tourId: string): Promise<void> {
  const res = await page.request.get(`${NEXT}/api/tours/${tourId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const tour = ((await res.json()) as { tour: { status: string; outcome?: string } }).tour;
  if (tour.status === 'canceled') return;
  if (tour.status !== 'toured') await patchTour(page, tourId, { status: 'toured' });
  if (tour.outcome === undefined) await patchTour(page, tourId, { outcome: 'not_a_fit', moveForward: false });
}

/** closeOut() for cleanup: never throws, so a teardown cannot mask the real failure. */
async function closeOutQuietly(page: Page, tourId: string): Promise<void> {
  try {
    await closeOut(page, tourId);
  } catch {
    // Best-effort: a later spec's reseed is the backstop.
  }
}

/** A request marked toured with the date left blank - the PATCH the "Mark
 *  already toured" dialog sends - checked on the wire to carry no date. */
async function createUndatedToured(page: Page): Promise<string> {
  const tourId = await createTour(page, UNIT_B);
  await patchTour(page, tourId, { status: 'toured' });
  const wire = await page.request.get(`${NEXT}/api/tours/${tourId}`);
  expect(wire.ok(), await wire.text()).toBeTruthy();
  const tour = ((await wire.json()) as { tour: { status: string; scheduledAt?: string } }).tour;
  expect(tour.status).toBe('toured');
  expect(tour.scheduledAt).toBeUndefined();
  return tourId;
}

interface TourSet {
  requestId: string;
  upcomingId: string;
  noShowId: string;
  canceledId: string;
  undatedTouredId: string;
}

/** The five tours the All tab must tell apart, on both lean properties. */
async function createTourSet(page: Page): Promise<TourSet> {
  // A request: no time, stays requested.
  const requestId = await createTour(page, UNIT_B);
  // Three days out at 10:00 - its reminder ladder sends nothing during the run.
  const upcomingId = await createTour(page, UNIT_A, futureAt(3, 10));
  // Two days ago at 10:00 (past-dated: arms nothing), then a no-show.
  const noShowId = await createTour(page, UNIT_A, pastAt(2, 10));
  await patchTour(page, noShowId, { status: 'no_show' });
  // Tomorrow at 10:00, then canceled: a DATED canceled tour (the PATCH sweeps its rungs).
  const canceledId = await createTour(page, UNIT_A, futureAt(1, 10));
  await patchTour(page, canceledId, { status: 'canceled' });
  const undatedTouredId = await createUndatedToured(page);
  return { requestId, upcomingId, noShowId, canceledId, undatedTouredId };
}

/** The URL carries `name=value` as its own parameter - one check per
 *  parameter, never a whole query string (the serializer owns the order). */
async function expectParam(page: Page, name: string, value: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`[?&]${name}=${value}(&|$)`));
}

async function expectNoParam(page: Page, name: string): Promise<void> {
  await expect(page).not.toHaveURL(new RegExp(`[?&]${name}=`));
}

/** The All tab's controls and rows. Rows are found by href inside the list;
 *  "Needs booking" is the chip, every request row's date text and the Active
 *  tab's section heading at once, so it is always matched by role or scope
 *  with `exact: true`. */
function allTab(page: Page) {
  const view = page.getByRole('region', { name: 'All tours', exact: true });
  const list = view.getByRole('list', { name: 'All tours list' });
  const statusGroup = view.getByRole('group', { name: 'Status', exact: true });
  return {
    when: view.getByRole('combobox', { name: 'When', exact: true }),
    search: view.getByRole('searchbox', { name: 'Search', exact: true }),
    chip: (label: string) => statusGroup.getByRole('button', { name: label, exact: true }),
    clearStatus: statusGroup.getByRole('button', { name: 'Clear status filter', exact: true }),
    /** The count line once the WHOLE filtered list is loaded and searched:
     *  "N matches", never "Searching..." or "... so far". The Spinner is a
     *  status too, but it carries no text. */
    complete: view.getByRole('status').getByText(/^\d+ match(es)?$/),
    link: (id: string) => list.locator(`a[href="/tours/${id}"]`),
    row: (id: string) => list.getByRole('listitem').filter({ has: page.locator(`a[href="/tours/${id}"]`) }),
    hrefs: () => list.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href'))),
  };
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tours page - All tab', () => {
  test.afterEach(async ({ page }) => {
    for (const id of created.splice(0)) await closeOutQuietly(page, id);
  });

  test('the tabs read All, Active, Past, Closed; /tours stays Active; All opens /tours/all', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/tours`);
    const tabs = page.getByRole('navigation', { name: 'Tours view' });
    await expect(tabs.getByRole('link')).toHaveText(['All', 'Active', 'Past', 'Closed']);
    await expect(tabs.getByRole('link', { name: 'Active', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByRole('link', { name: 'All', exact: true })).not.toHaveAttribute('aria-current', 'page');

    await tabs.getByRole('link', { name: 'All', exact: true }).click();
    await expect(page).toHaveURL(/\/tours\/all$/);
    await expect(page.getByRole('heading', { name: 'All tours', exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('filters: Needs booking, Upcoming, Past + No show, and Any time with the undated rows last', async ({
    page,
  }) => {
    test.slow(); // five tours through the API, then four filter steps, each loading and searching a list.
    await devLogin(page); // page.request carries the session cookie for /api writes
    const t = await createTourSet(page);
    const mine = [t.requestId, t.upcomingId, t.noShowId, t.canceledId, t.undatedTouredId];

    await page.goto(`${NEXT}/tours/all`);
    await expect(page.getByRole('heading', { name: 'All tours', exact: true })).toBeVisible();
    const all = allTab(page);
    await all.search.fill(SEARCH);

    // 1. Any time + the Needs booking chip: exactly the request (D4). Presence
    //    and the complete count first, so an absence never passes on a list
    //    that has not landed yet.
    await all.chip('Needs booking').click();
    await expect(all.chip('Needs booking')).toHaveAttribute('aria-pressed', 'true');
    await expectParam(page, 'status', 'requested');
    await expectParam(page, 'q', SEARCH);
    await expectNoParam(page, 'when');
    await expect(all.link(t.requestId)).toBeVisible();
    await expect(all.complete).toBeVisible();
    for (const id of [t.upcomingId, t.noShowId, t.canceledId, t.undatedTouredId]) {
      await expect(all.link(id)).toHaveCount(0);
    }
    // Its date column reads the work; its status badge reads the status (D8).
    await expect(all.row(t.requestId).getByText('Needs booking', { exact: true })).toBeVisible();
    await expect(all.row(t.requestId).getByText('Requested', { exact: true })).toBeVisible();

    // 2. Upcoming, the chip cleared first (a dated When hides the chip but
    //    would keep it for the next Any time): the upcoming tour and the DATED
    //    canceled one (tomorrow, its Canceled badge - spec P13); no undated row
    //    and not the no-show.
    await all.clearStatus.click();
    await expect(all.chip('Needs booking')).toHaveAttribute('aria-pressed', 'false');
    await all.when.selectOption({ label: 'Upcoming' });
    await expectParam(page, 'when', 'upcoming');
    await expectNoParam(page, 'status');
    await expectParam(page, 'q', SEARCH);
    await expect(all.link(t.upcomingId)).toBeVisible();
    await expect(all.link(t.canceledId)).toBeVisible();
    await expect(all.complete).toBeVisible();
    await expect(all.row(t.canceledId).getByText('Canceled', { exact: true })).toBeVisible();
    for (const id of [t.requestId, t.noShowId, t.undatedTouredId]) {
      await expect(all.link(id)).toHaveCount(0);
    }
    await expect(all.chip('Needs booking')).toHaveCount(0);

    // 3. Past + the No show chip: exactly the no-show.
    await all.when.selectOption({ label: 'Past' });
    await all.chip('No show').click();
    await expect(all.chip('No show')).toHaveAttribute('aria-pressed', 'true');
    await expectParam(page, 'when', 'past');
    await expectParam(page, 'status', 'no_show');
    await expectParam(page, 'q', SEARCH);
    await expect(all.link(t.noShowId)).toBeVisible();
    await expect(all.complete).toBeVisible();
    await expect(all.row(t.noShowId).getByText('No show', { exact: true })).toBeVisible();
    for (const id of [t.requestId, t.upcomingId, t.canceledId, t.undatedTouredId]) {
      await expect(all.link(id)).toHaveCount(0);
    }

    // 4. Any time, no chips: all five. The two undated rows come after every
    //    dated one, the request first of the two; the undated toured row's
    //    date reads "Undated" and its badge "Toured - needs outcome".
    await all.when.selectOption({ label: 'Any time' });
    await all.clearStatus.click();
    await expectNoParam(page, 'when');
    await expectNoParam(page, 'status');
    await expectParam(page, 'q', SEARCH);
    for (const id of mine) await expect(all.link(id)).toBeVisible();
    await expect(all.complete).toBeVisible();
    const hrefs = await all.hrefs();
    const at = (id: string): number => hrefs.indexOf(`/tours/${id}`);
    const lastDated = Math.max(at(t.upcomingId), at(t.canceledId), at(t.noShowId));
    expect(lastDated, `dated rows before the undated ones in ${hrefs.join(' ')}`).toBeLessThan(at(t.requestId));
    expect(at(t.requestId), 'the request before the undated toured row').toBeLessThan(at(t.undatedTouredId));
    await expect(all.row(t.undatedTouredId).getByText('Undated', { exact: true })).toBeVisible();
    await expect(all.row(t.undatedTouredId).getByText('Toured - needs outcome', { exact: true })).toBeVisible();
    await expect(all.row(t.requestId).getByText('Needs booking', { exact: true })).toBeVisible();
  });

  test('the back arrow returns to the same filtered list with the search, the opened row focused', async ({
    page,
  }) => {
    await devLogin(page);
    const noShowId = await createTour(page, UNIT_A, pastAt(2, 10));
    await patchTour(page, noShowId, { status: 'no_show' });

    await page.goto(`${NEXT}/tours/all`);
    const all = allTab(page);
    await all.search.fill(SEARCH);
    await all.when.selectOption({ label: 'Past' });
    await all.chip('No show').click();
    await expectParam(page, 'status', 'no_show');
    await expect(all.link(noShowId)).toBeVisible();
    await expect(all.complete).toBeVisible();

    // Open the row; the tour page's back arrow says where it goes.
    await all.link(noShowId).click();
    await expect(page).toHaveURL(new RegExp(`/tours/${noShowId}$`));
    const back = page.getByRole('link', { name: 'Back to tours', exact: true });
    await expect(back).toBeVisible();
    // A short viewport, so the returned list starts below the fold: the row is
    // in view only because the view scrolls to it (code review r2 R2-3). 240,
    // not 360: with the view's scrollIntoView removed the row was still on
    // screen at 360 and off it at 240 (mutant runs, 2026-10-06). The page
    // fixture is per test, so the next test gets the default size again.
    await page.setViewportSize({ width: 1280, height: 240 });
    await back.click();

    // ASSERTIONS ONLY from here to the focus check: any click or keypress on
    // the list trips its user-intent guard and cancels the return anchor
    // (spec 4.9).
    await expect(page).toHaveURL(/\/tours\/all\?/);
    await expectParam(page, 'when', 'past');
    await expectParam(page, 'status', 'no_show');
    await expectParam(page, 'q', SEARCH);
    await expect(all.link(noShowId)).toBeFocused();
    // Spec 9: "the opened row in view and focused" - focus alone does not
    // prove the row is on screen.
    await expect(all.link(noShowId)).toBeInViewport();
    await expect(all.chip('No show')).toHaveAttribute('aria-pressed', 'true');
    await expect(all.search).toHaveValue(SEARCH);
  });

  test('an undated toured tour reads "Undated" on its tour page', async ({ page }) => {
    await devLogin(page);
    const undatedTouredId = await createUndatedToured(page);

    await page.goto(`${NEXT}/tours/${undatedTouredId}`);
    // The header band, scoped by its "Tour - <address>" identity (steps.ts tourHeader()).
    const header = page.locator('header').filter({ hasText: 'Tour -' });
    await expect(header.getByText(/^Undated - /)).toBeVisible();
    await expect(header.getByText('Needs booking')).toHaveCount(0);
  });

  test('GET /api/tours/list?limit=2 walks to nextCursor null through the real stack, each id once', async ({
    page,
  }) => {
    await devLogin(page); // page.request carries the session cookie
    const t = await createTourSet(page);
    const mine = [t.requestId, t.upcomingId, t.noShowId, t.canceledId, t.undatedTouredId];

    interface ListPage {
      tours: { tourId: string }[];
      contacts: Record<string, { firstName?: string; lastName?: string; phone?: string }>;
      units: Record<string, { address?: unknown }>;
      nextCursor: string | null;
    }
    // Any time, every status. The file creates at most 12 tours, so 30 pages
    // is a cap a regression cannot hang on, never a limit a good run reaches.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await page.request.get(`${NEXT}/api/tours/list`, {
        params: cursor === null ? { limit: 2 } : { limit: 2, cursor },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const body = (await res.json()) as ListPage;
      pages += 1;
      expect(body.tours.length).toBeLessThanOrEqual(2);
      if (body.tours.length === 0) {
        // The accepted boundary phantom (spec 5.4): an empty page carries empty maps.
        expect(body.contacts).toEqual({});
        expect(body.units).toEqual({});
      } else {
        expect(body.contacts[TENANT_ID]?.firstName).toBe('Tasha');
      }
      seen.push(...body.tours.map((r) => r.tourId));
      cursor = body.nextCursor;
    } while (cursor !== null && pages < 30);

    expect(cursor, `the walk ended within 30 pages (${pages} read)`).toBeNull();
    // Five tours at two a page: the walk followed at least one cursor.
    expect(pages, 'the walk paged').toBeGreaterThan(1);
    expect(new Set(seen).size, 'no tour id appears twice').toBe(seen.length);
    for (const id of mine) expect(seen.filter((s) => s === id), `${id} exactly once`).toHaveLength(1);
  });
});
