import { test, expect, type Page } from '@playwright/test';

// Lost-reason modal (:5174) against the real backend (F2.2). Proves the
// Mark-lost action opens the modal, the confirm stays BLOCKED until a reason
// (category or text) is given, and confirming transitions the placement to the
// `lost` terminal stage — after which the card moves into the collapsed Closed
// area (terminal placements leave the active columns). Served on :5174 alongside
// legacy (:5173); targeted by absolute URL since the suite baseURL is :5173.
const NEXT = 'http://localhost:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('Lost modal: blocks until a reason is given, then closes the placement', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/cases`);

  await expect(page.getByRole('listitem', { name: 'Inspection' }).getByText('Tasha Nguyen')).toBeVisible();

  // Mark lost opens the modal — and does NOT transition yet.
  await page.getByRole('button', { name: /Mark Tasha Nguyen's placement lost/i }).click();
  await expect(page.getByRole('heading', { name: 'Mark placement lost' })).toBeVisible();

  // Confirm is disabled until a category OR free text is provided.
  const confirm = page.getByRole('button', { name: 'Mark lost' });
  await expect(confirm).toBeDisabled();

  await page.getByRole('radio', { name: 'Tenant withdrew' }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The placement is now terminal → it appears in the collapsed Closed area.
  // The card has left the Inspection column.
  await expect(
    page.getByRole('listitem', { name: 'Inspection' }).getByText('Tasha Nguyen'),
  ).toHaveCount(0);

  // Expand the Closed disclosure and assert the lost placement is listed.
  const summary = page.getByText('Closed', { exact: false }).first();
  await expect(summary).toBeVisible();
  await summary.click();
  const closedList = page.getByRole('list', { name: 'Closed placements' });
  await expect(closedList.getByText('Tasha Nguyen')).toBeVisible();
  await expect(closedList.getByText(/Lost/)).toBeVisible();
});
