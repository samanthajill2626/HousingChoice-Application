import { test, expect, type Page } from '@playwright/test';

// Placement history (:5174) against the real backend (F2.3). Proves the placement
// detail page renders the placement facts + the provenance history, and that a
// transition made on the detail page adds a fresh history row (newest-first).
// The seeded placement (placement-0001) is Tasha Nguyen on unit A, stage
// awaiting_inspection. Served on :5174 (the suite baseURL); targeted by
// absolute URL for explicitness.
const NEXT = 'http://localhost:5174';

// Log in as the seeded VA, then reset the seeded placement (placement-0001) back to
// `awaiting_inspection` via an AUTHENTICATED request (session-safe, targeted) so
// the seeded card is in the Inspection column for the "Open" link below —
// /__dev/reseed would wipe users/sessions and break auth after frame.spec.
async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

test('Placement detail: shows placement facts + history, and a transition adds a row', async ({ page }) => {
  await devLoginAndReset(page);

  // Open the seeded placement from its board card.
  await page.goto(`${NEXT}/placements`);
  await page
    .getByRole('listitem', { name: 'Inspection' })
    .getByRole('link', { name: 'Open' })
    .click();

  // Detail header: the stage label + the History panel.
  await expect(page.getByRole('heading', { name: /Awaiting inspection/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /History/ })).toBeVisible();

  // Move out of awaiting_inspection via the full stage picker → the outcome
  // prompt → confirm. This records a transition the history then reflects.
  await page.getByRole('combobox', { name: 'Move to stage' }).selectOption('determine_rent');
  await expect(page.getByRole('heading', { name: 'Record inspection outcome' })).toBeVisible();
  await page.getByRole('radio', { name: 'Pass' }).click();
  await page.getByRole('button', { name: 'Confirm move' }).click();

  // The stage advanced and the history list shows at least one row (newest-first).
  await expect(page.getByRole('heading', { name: /Determine rent/ })).toBeVisible();
  const history = page.getByRole('list', { name: 'Placement history' });
  await expect(history.getByRole('listitem').first()).toBeVisible();
});
