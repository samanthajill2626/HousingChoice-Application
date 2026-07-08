import { test, expect, type Page } from '@playwright/test';

// Placements page (:5174) against the real status-model backend. The kanban
// board is gone: the page is a phase FILTER (rail on desktop / chips on mobile)
// + one ledger list. Rows link to the placement detail; the desktop kebab menu
// moves a placement by exact stage (gated prompts still apply). The seeded
// placement (placement-0001) is tenant Tasha Nguyen on unit A; each test resets
// it to `awaiting_inspection` (Inspection phase).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

test('all-view groups by phase; the row appears under its phase heading', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await expect(page.getByRole('heading', { name: 'Placements' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Inspection/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }),
  ).toBeVisible();
});

test('phase filter narrows the list and lands in the URL', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  const nav = page.getByRole('navigation', { name: 'Placement phases' });
  await nav.getByRole('link', { name: /^Inspection/ }).click();
  await expect(page).toHaveURL(/\?phase=inspection$/);
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();
  // A slice is flat: no group heading.
  await expect(page.getByRole('heading', { name: /^Inspection \d/ })).toHaveCount(0);
  // The selected entry is marked.
  await expect(nav.getByRole('link', { name: /^Inspection/ })).toHaveAttribute('aria-current', 'true');
});

test('search narrows rows by tenant name', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await page.getByRole('searchbox', { name: 'Search placements' }).fill('tasha');
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search placements' }).fill('zzz-no-such');
  await expect(page.getByText("No matches for 'zzz-no-such'.")).toBeVisible();
});

test('kebab menu moves by exact stage through the gate prompt and persists', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  // Moving OUT of awaiting_inspection requires the inspection outcome. Scope the
  // kebab to placement-0001's own row (its detail link is unique to the seeded
  // Inspection-stage placement) so manual placements other specs may have created
  // for the same tenant don't make the button name ambiguous.
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }) });
  await row.getByRole('button', { name: 'Actions for Tasha Nguyen' }).click();
  await page.getByRole('menuitem', { name: 'Determine rent' }).click();
  await expect(page.getByRole('heading', { name: 'Record inspection outcome' })).toBeVisible();
  await page.getByRole('radio', { name: 'Pass' }).click();
  await page.getByRole('button', { name: 'Confirm move' }).click();

  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Determine rent' })).toBeVisible();

  // Persisted across a reload.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Determine rent' })).toBeVisible();
});

test('mobile: chip filter works, no kebab, row navigates to the detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  // The filter renders as chips (same accessible nav) and still filters.
  const nav = page.getByRole('navigation', { name: 'Placement phases' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: /^Inspection/ }).click();
  await expect(page).toHaveURL(/\?phase=inspection$/);

  // No row actions on mobile (the kebab is display:none below 768px).
  await expect(page.getByRole('button', { name: 'Actions for Tasha Nguyen' })).not.toBeVisible();

  // The whole row opens the placement detail.
  await page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }).click();
  await expect(page).toHaveURL(/\/placements\/placement-0001$/);
});
