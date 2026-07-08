import { test, expect, type Page } from '@playwright/test';

// Manual placement creation (:5174) against the real status-model backend. Proves
// the "New placement" flow end-to-end from all three entry points:
//   1. the board's "New placement" button → a BLANK form (pick tenant + unit),
//   2. a property detail's "Start placement" → the UNIT side pre-filled + LOCKED,
//   3. a tenant file's "Start placement" → the TENANT side pre-filled + LOCKED.
// In every case a successful create lands on the placement detail page
// (/placements/<id>) showing the tenant + unit.
//
// Seeded data (app/src/lib/seedData.ts, reseeded by /__dev/reseed):
//   - tenant contact-tenant-0001 = Tasha Nguyen
//   - unit unit-0001 = 1450 Joseph E. Boone Blvd NW (HAS the active seeded
//     placement-0001 at awaiting_inspection)
//   - unit unit-0002 = 88 Sycamore St, Decatur (occupied, NO active placement)
//
// Tasha (tenant-0001) already has an active placement, so a create using her ALWAYS
// triggers the TENANT-side overlap notice (role="status"). That is correct
// (warn-but-allow, plan §G-4): the notice does not block submit and the create still
// succeeds. We deliberately pair Tasha with unit-0002 (no UNIT-side overlap) and
// assert the create succeeds despite the tenant notice. Served on :5174 (the suite
// baseURL); targeted by absolute URL for explicitness.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

const SEEDED_TENANT = 'contact-tenant-0001'; // Tasha Nguyen
const SEEDED_UNIT_FREE = 'unit-0002'; // 88 Sycamore St, Decatur — no active placement

/** A URL whose path ends in /placements/<id> (the placement detail page). */
const PLACEMENT_DETAIL_URL = /\/placements\/[A-Za-z0-9_-]+$/;

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test.describe('Manual placement creation', () => {
  test('board "New placement" → pick seeded tenant + unit → lands on the placement detail', async ({
    page,
  }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/placements`);
    await expect(page.getByRole('heading', { name: 'Placements' })).toBeVisible();

    // Open the create dialog from the board header.
    await page.getByRole('button', { name: 'New placement' }).click();
    const dialog = page.getByRole('dialog', { name: /New placement/i });
    await expect(dialog).toBeVisible();

    // Pick the seeded tenant (type → click the matching option).
    await dialog.getByRole('combobox', { name: 'Tenant' }).fill('Tasha');
    await dialog.getByRole('option', { name: /Tasha Nguyen/ }).click();

    // Pick unit-0002 (88 Sycamore) — no UNIT-side overlap.
    await dialog.getByRole('combobox', { name: 'Unit' }).fill('Sycamore');
    await dialog.getByRole('option', { name: /88 Sycamore St/ }).click();

    // Warn-but-allow (§G-4): Tasha already has an active placement, so the
    // TENANT-side overlap notice IS shown. It must NOT block the create — assert it
    // is present (proves the feature) but proceed anyway.
    await expect(dialog.getByRole('status')).toContainText(/already has an active placement/i);

    // Leave the Starting stage at its default; Create.
    await dialog.getByRole('button', { name: 'Create' }).click();

    // The dialog closes and we land on the new placement's detail page…
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(PLACEMENT_DETAIL_URL);

    // …which shows the tenant (by name) + the unit (by address) as links.
    await expect(page.getByRole('link', { name: 'Tasha Nguyen' })).toBeVisible();
    await expect(page.getByRole('link', { name: /88 Sycamore St/ })).toBeVisible();
  });

  test('property-prefilled create: the Unit side is locked, pick a tenant → lands on the detail', async ({
    page,
  }) => {
    await devLogin(page);
    // unit-0002 (occupied, no active placement → no UNIT-side overlap).
    await page.goto(`${NEXT}/listings/${SEEDED_UNIT_FREE}`);

    // "Start placement" lives in the property header kebab (More actions) menu;
    // it opens the create dialog locked to this unit.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Start placement' }).click();
    const dialog = page.getByRole('dialog', { name: /New placement/i });
    await expect(dialog).toBeVisible();

    // The Unit side is LOCKED: the address is shown (read-only), and there is NO
    // editable Unit combobox. The Tenant side stays an editable picker.
    await expect(dialog.getByRole('combobox', { name: 'Unit' })).toHaveCount(0);
    await expect(dialog.getByLabel('Unit')).toContainText(/88 Sycamore St/);
    await expect(dialog.getByRole('combobox', { name: 'Tenant' })).toBeVisible();

    // Pick the seeded tenant; Create.
    await dialog.getByRole('combobox', { name: 'Tenant' }).fill('Tasha');
    await dialog.getByRole('option', { name: /Tasha Nguyen/ }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Lands on the new placement's detail page, showing this tenant + unit.
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(PLACEMENT_DETAIL_URL);
    await expect(page.getByRole('link', { name: 'Tasha Nguyen' })).toBeVisible();
    await expect(page.getByRole('link', { name: /88 Sycamore St/ })).toBeVisible();
  });

  test('tenant-file-prefilled create: the Tenant side is locked, pick a unit → lands on the detail', async ({
    page,
  }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${SEEDED_TENANT}`);

    // The Placements-card "Start placement" action (accessible name "Start a
    // placement") opens the create dialog locked to this tenant.
    await page.getByRole('button', { name: 'Start a placement' }).click();
    const dialog = page.getByRole('dialog', { name: /New placement/i });
    await expect(dialog).toBeVisible();

    // The Tenant side is LOCKED: the name is shown (read-only), and there is NO
    // editable Tenant combobox. The Unit side stays an editable picker.
    await expect(dialog.getByRole('combobox', { name: 'Tenant' })).toHaveCount(0);
    await expect(dialog.getByLabel('Tenant')).toContainText(/Tasha Nguyen/);
    await expect(dialog.getByRole('combobox', { name: 'Unit' })).toBeVisible();

    // Pick unit-0002; Create.
    await dialog.getByRole('combobox', { name: 'Unit' }).fill('Sycamore');
    await dialog.getByRole('option', { name: /88 Sycamore St/ }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Lands on the new placement's detail page, showing this tenant + unit.
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(PLACEMENT_DETAIL_URL);
    await expect(page.getByRole('link', { name: 'Tasha Nguyen' })).toBeVisible();
    await expect(page.getByRole('link', { name: /88 Sycamore St/ })).toBeVisible();
  });
});
