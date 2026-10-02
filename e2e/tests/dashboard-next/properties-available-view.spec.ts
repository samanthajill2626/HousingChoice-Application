// e2e/tests/dashboard-next/properties-available-view.spec.ts
//
// The Properties page as Sam asked for it (Improvements Tracker #1; design
// docs/superpowers/specs/2026-10-01-properties-available-view-design.md):
//
//   1. the Active tab opens on Available, with a bare URL;
//   2. the by-housing-authority summary counts Available and Coming soon
//      (= Setup) per authority, a property that accepts two authorities
//      counting under both, and a zero is plain text, not a link;
//   3. a count is a drill-down: it sets the status and that authority, and the
//      list shows exactly the properties counted - and a reload keeps it;
//   4. the voucher-size filter narrows the list AND the summary;
//   5. Back from a property page returns to the same filtered view;
//   6. the Deleted tab starts clean, on every status;
//   7. no sideways scroll at 360px.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const + a
// local devLogin, raw page.request for setup, accessibility-first locators, no
// Scenario verbs. Self-clean isolation: the landlord, the properties and BOTH
// authority names are minted fresh per run (run-unique authority names make
// every count below exact, whatever other specs left in the lane), so NOTHING
// here reseeds (a reseed mid-suite would wipe other specs' data and log this
// session out).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164 (the landlord-activity.spec idiom) - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

async function createLandlord(request: APIRequestContext, stamp: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'landlord', firstName: `Avail${stamp}`, lastName: 'Summary', phone: freshPhone() },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** A property via the real route (it starts in Setup = "Coming soon"), then
 *  published to Available when asked. */
async function createProperty(
  request: APIRequestContext,
  landlordId: string,
  opts: { line1: string; authorities: string[]; voucherSize: number; available: boolean },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      accepted_authorities: opts.authorities,
      voucher_size_accepted: opts.voucherSize,
      beds: opts.voucherSize,
      rent_min: 1500,
      address: { line1: opts.line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  if (opts.available) {
    const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(pub.ok(), await pub.text()).toBeTruthy();
  }
  return unitId;
}

test.describe('Properties page - available now vs. coming soon, by housing authority', () => {
  test('opens on Available; the summary drills into the list; voucher, reload, Back and tabs hold', async ({
    page,
  }) => {
    test.slow(); // builds its own world: a landlord and three properties.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    // Both authorities are run-unique, so no other spec's property can count
    // under them and every number below is exact.
    const authA = `Summary Authority ${stamp}`;
    const authB = `Summary Partner ${stamp}`;
    const twoBr = `${stamp} Summary Avail Two St`;
    const both = `${stamp} Summary Avail Both Ave`;
    const soon = `${stamp} Summary Soon Ct`;

    const landlordId = await createLandlord(req, stamp);
    await createProperty(req, landlordId, { line1: twoBr, authorities: [authA], voucherSize: 2, available: true });
    await createProperty(req, landlordId, {
      line1: both,
      authorities: [authA, authB],
      voucherSize: 3,
      available: true,
    });
    await createProperty(req, landlordId, { line1: soon, authorities: [authA], voucherSize: 2, available: false });

    // 1. The Active tab opens on Available, with a bare URL.
    await page.goto(`${NEXT}/listings`);
    const status = page.getByLabel('Status', { exact: true });
    await expect(status).toHaveValue('available');
    await expect(page).toHaveURL(/\/listings$/);

    // 2. The summary: A has two available and one coming soon; B (accepted by
    //    the two-authority property only) has one available and a plain zero.
    const summary = page.getByRole('table', { name: 'By housing authority', exact: true });
    const rowA = summary.getByRole('row').filter({ has: page.getByRole('rowheader', { name: authA, exact: true }) });
    const rowB = summary.getByRole('row').filter({ has: page.getByRole('rowheader', { name: authB, exact: true }) });
    await expect(rowA.getByRole('cell')).toHaveText(['2', '1']);
    await expect(rowB.getByRole('cell')).toHaveText(['1', '0']);
    await expect(rowB.getByRole('link')).toHaveCount(1);

    // 3. A count drills in: Coming soon for A -> status Setup, only that property.
    const list = page.getByRole('list', { name: 'Properties', exact: true });
    await rowA.getByRole('link', { name: `Show 1 coming soon property for ${authA}` }).click();
    await expect(status).toHaveValue('setup');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem')).toContainText(soon);
    await expect(
      page.getByRole('group', { name: 'Housing authority', exact: true }).getByRole('button', { name: authA, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // ...and the URL carries it, so a reload lands on the same view.
    await page.reload();
    await expect(status).toHaveValue('setup');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem')).toContainText(soon);

    // 4. Available for A, then the 3-BR voucher chip: the list AND the summary narrow.
    await rowA.getByRole('link', { name: `Show 2 available properties for ${authA}` }).click();
    await expect(status).toHaveValue('available');
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('group', { name: 'Voucher size', exact: true }).getByRole('button', { name: '3-BR', exact: true }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem')).toContainText(both);
    await expect(rowA.getByRole('cell')).toHaveText(['1', '0']);

    // 5. Into the property and Back: the same filtered view returns.
    const filteredUrl = page.url();
    await list.getByRole('link', { name: new RegExp(both) }).click();
    await expect(page.getByRole('heading', { name: both, exact: false }).first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem')).toContainText(both);
    await expect(
      page.getByRole('group', { name: 'Voucher size', exact: true }).getByRole('button', { name: '3-BR', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // 6. The Deleted tab starts clean, on every status, with no summary.
    await page.getByRole('navigation', { name: 'Properties view', exact: true }).getByRole('link', { name: 'Deleted' }).click();
    await expect(page).toHaveURL(/\/listings\/deleted$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Deleted properties' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'By housing authority', exact: true })).toHaveCount(0);

    // 7. Phone width: the summary, chips and rows never scroll sideways.
    await page.setViewportSize(NARROW_360);
    try {
      await page.goto(`${NEXT}/listings`);
      await expect(page.getByRole('table', { name: 'By housing authority', exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page, 'Properties list at 360');
    } finally {
      await page.setViewportSize(WIDE_RESTORE);
    }
  });
});
