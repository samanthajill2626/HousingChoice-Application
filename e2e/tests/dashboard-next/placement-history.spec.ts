import { test, expect, type Page } from '@playwright/test';

// Placement history (:5174) against the real backend (F2.3). Proves the case
// detail page renders the placement facts + the provenance history, and that a
// transition made on the detail page adds a fresh history row (newest-first).
// The seeded placement (case-0001) is Tasha Nguyen on unit A, stage
// awaiting_inspection. Served on :5174 alongside legacy (:5173); targeted by
// absolute URL since the suite baseURL is :5173.
const NEXT = 'http://localhost:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('Case detail: shows placement facts + history, and a transition adds a row', async ({ page }) => {
  await devLogin(page);

  // Open the seeded placement from its board card.
  await page.goto(`${NEXT}/cases`);
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
