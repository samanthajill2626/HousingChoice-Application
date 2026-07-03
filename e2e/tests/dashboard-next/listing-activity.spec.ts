import { test, expect, type Page } from '@playwright/test';

// Property Activity card (:5174) against the real backend — proves the unit
// audit trail round-trip: a real edit (PATCH /api/units/:id) writes a
// unit_updated audit row, and GET /api/units/:id/activity serves it back into
// the Activity card with staff copy + the humanized changed-field detail.
//
// Targets seeded unit-0002 (88 Sycamore St — its `utilities` value is asserted
// by no other spec) and REVERTS the edit so the record stays pristine. The
// trail itself is append-only (rows accumulate), which no other spec asserts
// on — we deliberately do NOT change the unit's status here (public-pages /
// placement-create depend on the seeded statuses).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const UNIT = 'unit-0002'; // 88 Sycamore St, Decatur

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Open the ⋯ → Edit property dialog, set Utilities, save, and wait for close. */
async function editUtilities(page: Page, value: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Edit property/i }).click();
  const dialog = page.getByRole('dialog', { name: /Edit property/i });
  await dialog.getByLabel(/Utilities/i).fill(value);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.describe('Property detail — Activity card (unit audit trail)', () => {
  test('a real edit surfaces as a "Property updated" Activity row after reload', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/listings/${UNIT}`);
    await expect(page.getByRole('heading', { name: '88 Sycamore St', exact: false })).toBeVisible();

    // The Activity card is REAL (never the construction-era pending panel):
    // it shows either rows or the honest empty state.
    const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
    await expect(activity).toBeVisible();
    await expect(activity.getByText(/arrives with the backend/i)).toHaveCount(0);

    // Remember the current value so the edit is reverted for other specs.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Edit property/i }).click();
    const dialog = page.getByRole('dialog', { name: /Edit property/i });
    const original = await dialog.getByLabel(/Utilities/i).inputValue();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // A real edit → PATCH → unit_updated audit row.
    await editUtilities(page, 'E2E activity marker');

    // The Activity slice loads on mount — reload and the row is there,
    // newest-first, with the humanized changed-field sub-line.
    await page.reload();
    await expect(activity.getByText('Property updated').first()).toBeVisible();
    await expect(activity.getByText('Utilities').first()).toBeVisible();

    // Cleanup — revert so the seeded unit stays pristine (the extra
    // audit rows are append-only history nobody else asserts on).
    await editUtilities(page, original);
  });
});
