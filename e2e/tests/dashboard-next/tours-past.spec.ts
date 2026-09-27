// The Tours page's Past tab (Sam's items 18 + 20, list half; spec
// docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md section 4).
//
// Against the real backend on the hermetic lane. The lean world seeds NO tours,
// so this spec creates three PAST-DATED tours through POST /api/tours (the
// route accepts any valid ISO scheduledAt; the arm writes a visible
// booked_too_late skipped reminder row and sends nothing), then advances two
// of them through the API: one to toured (no outcome) and one to no_show.
//
//   /tours/past lists exactly those three, most recent first, with the
//   plain-words states; none of them is in Active; bulk "Mark toured (1)"
//   re-reads and PATCHes the scheduled one to "Needs outcome" with a "Record
//   outcome" link that lands on the tour page with the dialog open and no
//   ?outcome in the URL; the fake Twilio THREAD store's outbound count is
//   unchanged by the batch, and nothing reached the tenant or the landlord
//   after the click; the back arrow returns to Past; no horizontal overflow
//   at 360px, on the page or inside the Past region, both while a row still
//   carries its checkbox (before the batch) and after it; at 360px that
//   checkbox sits beside its card, within the card's vertical span; and at a
//   960px viewport (a ~672px pane beside the expanded sidebar) no text inside
//   any Past row card is clipped.
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import {
  NARROW_360,
  WIDE_RESTORE,
  expectNoHorizontalOverflow,
  expectNoHorizontalOverflowIn,
} from '../../support/viewport.js';
import { getOutboundTo, listThreads } from '../../fixtures/fakeTwilio.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT_ID = 'contact-tenant-0001'; // Tasha Nguyen
const UNIT_A = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW
const UNIT_B = 'unit-0002'; // 88 Sycamore St
const TENANT_PHONE = '+15550100001'; // Tasha Nguyen (lean seed)
const LANDLORD_PHONE = '+15550100002'; // Marcus Bell, landlord of both units (lean seed)
/** A 960px window: with the expanded 240px sidebar and the content's 24px
 *  padding each side, the content pane is ~672px - inside the 561-800px band
 *  where a Past card must stack (review R2-1). Above the 768px nav
 *  breakpoint, so the layout is the desktop one, only narrower. */
const MID_960 = { width: 960, height: 800 } as const;

/** `daysAgo` days before today at `hour`:00 LOCAL, as an ISO instant. */
function pastAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Every outbound message the fake's thread store holds, across all parties. */
async function outboundCount(page: Page): Promise<number> {
  const threads = await listThreads(page.request);
  return threads.reduce((n, t) => n + t.messages.filter((m) => m.direction === 'outbound').length, 0);
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

async function patchStatus(page: Page, tourId: string, status: string): Promise<void> {
  const res = await page.request.patch(`${NEXT}/api/tours/${tourId}`, { data: { status } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tours page - Past tab', () => {
  test('lists past tours needing a decision, bulk Mark toured, Record outcome deep link, back arrow, 360px', async ({ page }) => {
    test.slow(); // ten stages: API setup, Active, Past, a batch, two tour pages, 360px - triple the budget.
    await devLogin(page); // page.request carries the session cookie for /api writes

    // Three past-dated tours: yesterday (stays scheduled = "Not marked"), two
    // days ago (-> toured, no outcome = "Needs outcome"), three days ago
    // (-> no_show = "No show"). Two units so the labels differ by property too.
    const notMarkedId = await createTour(page, UNIT_A, pastAt(1, 10));
    const needsOutcomeId = await createTour(page, UNIT_B, pastAt(2, 10));
    const noShowId = await createTour(page, UNIT_A, pastAt(3, 10));
    await patchStatus(page, needsOutcomeId, 'toured');
    await patchStatus(page, noShowId, 'no_show');

    // Active never shows them (their time has passed). Wait for BOTH Active
    // sections to have rendered before the negative count, or an unloaded
    // list passes it vacuously.
    await page.goto(`${NEXT}/tours`);
    await expect(page.getByRole('heading', { name: 'Tours' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Upcoming tours' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs booking' })).toBeVisible();
    for (const id of [notMarkedId, needsOutcomeId, noShowId]) {
      await expect(page.locator(`a[href="/tours/${id}"]`)).toHaveCount(0);
    }

    // The Past tab.
    const tabs = page.getByRole('navigation', { name: 'Tours view' });
    await tabs.getByRole('link', { name: 'Past' }).click();
    await expect(page).toHaveURL(/\/tours\/past$/);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Past' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(/^Last 90 days:/)).toBeVisible();

    const region = page.getByRole('region', { name: 'Past tours' });
    const rowFor = (id: string) =>
      region.getByRole('listitem').filter({ has: page.locator(`a[href="/tours/${id}"]`) });
    await expect(region.getByRole('listitem')).toHaveCount(3);
    // Most recent first.
    const hrefs = await region
      .getByRole('listitem')
      .getByRole('link', { name: /^Tour for .* on / })
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs).toEqual([`/tours/${notMarkedId}`, `/tours/${needsOutcomeId}`, `/tours/${noShowId}`]);

    await expect(rowFor(notMarkedId).getByText('Not marked', { exact: true })).toBeVisible();
    await expect(rowFor(notMarkedId).getByRole('button', { name: /^Mark toured: .* on / })).toBeVisible();
    await expect(rowFor(needsOutcomeId).getByText('Needs outcome', { exact: true })).toBeVisible();
    await expect(rowFor(needsOutcomeId).getByRole('link', { name: /^Record outcome: .* on / })).toBeVisible();
    await expect(rowFor(noShowId).getByText('No show', { exact: true })).toBeVisible();
    await expect(rowFor(noShowId).getByRole('button')).toHaveCount(0);
    await expect(rowFor(noShowId).getByRole('checkbox')).toHaveCount(0);

    // Mid-width, BEFORE the batch (while the widest Past row exists): a Past
    // card is ~170px narrower than the pane for its fixed lead and action
    // slots, so in a ~672px pane it must already stack its identity over its
    // meta. Side by side it cut every tenant name to a few characters with an
    // ellipsis, which neither overflow check can see (the clip stays inside
    // the card), so the pin is direct: no element inside any Past row card
    // is clipped. Three cards, counted first, so the check is never vacuous.
    await page.setViewportSize(MID_960);
    await expect(region.getByRole('listitem')).toHaveCount(3);
    const cards = region.getByRole('link', { name: /^Tour for .* on / });
    await expect(cards).toHaveCount(3);
    const paneWidth = Math.round((await region.boundingBox())?.width ?? 0);
    const clipped = await cards.evaluateAll((els) =>
      els.flatMap((card) =>
        Array.from(card.querySelectorAll('*'))
          .filter((el) => el.scrollWidth > el.clientWidth)
          .map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}: ${el.textContent ?? ''}`),
      ),
    );
    expect(clipped, `clipped text inside a Past row card at a 960px viewport (a ${paneWidth}px pane)`).toEqual([]);
    await page.setViewportSize(WIDE_RESTORE);

    // Narrow, BEFORE the batch: the only point at which a row still carries its
    // checkbox and Mark toured button (the batch below turns that row into
    // "Needs outcome"), so the widest Past row is measured here.
    await page.setViewportSize(NARROW_360);
    await expect(region.getByRole('listitem')).toHaveCount(3);
    await expect(rowFor(notMarkedId).getByRole('checkbox')).toBeVisible();
    await expectNoHorizontalOverflow(page, 'Past tours with a Not marked row at 360px');
    await expectNoHorizontalOverflowIn(region, 'Past tours region with a Not marked row at 360px');
    // The checkbox stays with its row (spec 4.8): it shares the first line
    // with the row's card, inside the card's vertical span, instead of sitting
    // alone on a line above it.
    const check = await rowFor(notMarkedId).getByRole('checkbox').boundingBox();
    const card = await rowFor(notMarkedId).getByRole('link', { name: /^Tour for .* on / }).boundingBox();
    expect(check, 'the Not marked row checkbox has a layout box at 360px').not.toBeNull();
    expect(card, 'the Not marked row card has a layout box at 360px').not.toBeNull();
    expect(check!.y, 'the checkbox top is not above its card top at 360px').toBeGreaterThanOrEqual(card!.y);
    expect(
      check!.y + check!.height,
      'the checkbox bottom is not below its card bottom at 360px',
    ).toBeLessThanOrEqual(card!.y + card!.height);
    await page.setViewportSize(WIDE_RESTORE);

    // Bulk: tick the one "Not marked" row, Mark toured (1). No text goes out.
    // The bulk button is located by an ANCHORED name: getByRole's default is
    // a substring match, and every row button also starts with "Mark toured".
    const outboundBefore = await outboundCount(page);
    await expect(page.getByRole('button', { name: /^Mark toured \(0\)$/ })).toBeDisabled();
    await rowFor(notMarkedId).getByRole('checkbox').check();
    const since = new Date().toISOString(); // the per-party proof window opens at the click
    await page.getByRole('button', { name: /^Mark toured \(1\)$/ }).click();
    await expect(rowFor(notMarkedId).getByRole('status')).toHaveText('Marked toured');
    await expect(rowFor(notMarkedId).getByText('Needs outcome', { exact: true })).toBeVisible();
    await expect(rowFor(notMarkedId).getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Mark toured \(0\)$/ })).toBeDisabled();
    // Give the worker a moment: a regression that ENQUEUED a send would land
    // in the fake's thread store asynchronously, after the PATCH returned.
    await page.waitForTimeout(2000);
    expect(await outboundCount(page)).toBe(outboundBefore);
    // Per party as well (the suite's since-scoped idiom): nothing to the
    // tenant, and nothing to the landlord of either property.
    expect(await getOutboundTo(page.request, { to: TENANT_PHONE, since })).toEqual([]);
    expect(await getOutboundTo(page.request, { to: LANDLORD_PHONE, since })).toEqual([]);
    // Verified on the wire too: the tour is toured with no outcome, nothing closed.
    const after = await page.request.get(`${NEXT}/api/tours/${notMarkedId}`);
    expect(after.ok()).toBeTruthy();
    const tour = ((await after.json()) as { tour: { status: string; outcome?: string } }).tour;
    expect(tour.status).toBe('toured');
    expect(tour.outcome).toBeUndefined();

    // Record outcome deep link -> the tour page with the dialog open, param stripped.
    await rowFor(notMarkedId).getByRole('link', { name: /^Record outcome: .* on / }).click();
    await expect(page).toHaveURL(new RegExp(`/tours/${notMarkedId}$`));
    await expect(page.getByRole('dialog', { name: 'Record outcome' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Record outcome' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The state SURVIVED the strip: the back arrow on this very page goes to Past.
    await page.getByRole('link', { name: 'Back to tours' }).click();
    await expect(page).toHaveURL(/\/tours\/past$/);
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();

    // A reload of the stripped URL does not reopen the dialog (the param is gone).
    await page.goto(`${NEXT}/tours/${notMarkedId}`);
    await expect(page.getByRole('button', { name: 'Record outcome' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The plain row link carries the pointer too.
    await page.goto(`${NEXT}/tours/past`);
    await rowFor(needsOutcomeId).getByRole('link', { name: /^Tour for .* on / }).click();
    await expect(page).toHaveURL(new RegExp(`/tours/${needsOutcomeId}$`));
    await page.getByRole('link', { name: 'Back to tours' }).click();
    await expect(page).toHaveURL(/\/tours\/past$/);

    // Narrow again, after the batch and a fresh mount: rows with Record outcome
    // actions must not push the page sideways.
    await expect(page.getByRole('heading', { name: 'Past tours' })).toBeVisible();
    await page.setViewportSize(NARROW_360);
    await expect(region.getByRole('listitem')).toHaveCount(3);
    await expectNoHorizontalOverflow(page, 'Past tours at 360px');
    // The Past region's own box as well (toolbar + rows), so an overflow is
    // pinned to this surface and not only read off <main>.
    await expectNoHorizontalOverflowIn(region, 'Past tours region at 360px');
    await page.setViewportSize(WIDE_RESTORE);
  });
});
