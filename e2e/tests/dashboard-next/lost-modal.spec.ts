import { test, expect, type Page } from '@playwright/test';

// Lost-reason modal (:5174) against the real backend (F2.2). Proves the
// Mark-lost action opens the modal, the confirm stays BLOCKED until a reason
// (category or text) is given, and confirming transitions the placement to the
// `lost` terminal stage — after which the card moves into the collapsed Closed
// area (terminal placements leave the active columns). Served on :5174 (the
// suite baseURL); targeted by absolute URL for explicitness.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// Log in as the seeded VA, then reset the seeded placement (placement-0001) back to
// `awaiting_inspection` via an AUTHENTICATED request (session-safe, targeted —
// this spec moves the placement to `lost`, so it must not bleed into other specs;
// /__dev/reseed would wipe users/sessions and break auth after frame.spec).
async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

// This spec drives placement-0001 to the terminal `lost` stage; restore it to an
// ACTIVE stage afterwards so downstream specs that assume the seeded tenant still
// has an active placement (e.g. placement-create's overlap notice) are not
// polluted. A manual transition out of a terminal stage is allowed.
test.afterEach(async ({ page }) => {
  await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
});

test('Lost modal: blocks until a reason is given, then closes the placement', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();

  // Mark lost now lives in the row's kebab menu - it opens the modal and does
  // NOT transition yet.
  await page.getByRole('button', { name: 'Actions for Tasha Nguyen' }).click();
  await page.getByRole('menuitem', { name: 'Mark lost...' }).click();
  await expect(page.getByRole('heading', { name: 'Mark placement lost' })).toBeVisible();

  const confirm = page.getByRole('button', { name: 'Mark lost' });
  await expect(confirm).toBeDisabled();

  await page.getByRole('radio', { name: 'Tenant withdrew' }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // Terminal -> the row leaves the active ledger...
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toHaveCount(0);

  // ...and appears under the Closed filter with its stage label.
  await page
    .getByRole('navigation', { name: 'Placement phases' })
    .getByRole('link', { name: /^Closed/ })
    .click();
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Lost' })).toBeVisible();
});
