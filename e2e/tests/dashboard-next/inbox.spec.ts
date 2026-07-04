import { test, expect, type Page } from '@playwright/test';

// Entity-centric Inbox (:5174) against the real C8 feed. Proves the merged
// frontend (useInbox/InboxRow) + backend (GET /api/inbox + assign) behave together:
// the contact-row model, the filter tabs, opening a row → its contact page, and the
// inline Assign/Unassign round-trip with the live "Assigned · You" state-sync (the
// project's #1 historical bug class). Served on :5174 (the suite baseURL);
// targeted by absolute URL for explicitness.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('Inbox: contact rows + filter tabs; a row opens its contact page', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // Filter tabs — All is the default selection.
  for (const label of ['All', 'Unread', 'Unknown', 'Assigned to me']) {
    await expect(page.getByRole('tab', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');

  // The seeded tenant conversation renders as a contact row (one row per contact).
  // First data-dependent wait: give the feed headroom under full-suite load (the
  // default 5s races the inbox fetch when the whole suite shares the stack).
  const row = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Opening a row navigates to that contact's page (no parallel thread surface).
  await row.click();
  await expect(page).toHaveURL(/\/contacts\/contact-tenant-0001$/);
  // The contact header renders her name (a styled element, not a heading) and the
  // comms-left / file-right layout's Details panel.
  await expect(page.getByText('Tasha Nguyen').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
});

test('Inbox: inline Assign to me → "Assigned · You" + Assigned-to-me filter; Unassign reverts', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);

  const row = page.getByRole('listitem').filter({ hasText: 'Tasha Nguyen' });
  // Headroom under full-suite load (see the note in the first test).
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Inline action is hover-revealed on desktop — hover, then assign.
  await row.hover();
  await row.getByRole('button', { name: /Assign Tasha Nguyen to me/i }).click();

  // Live, no reload: the row shows the assignment as "You" (current user), and it
  // appears under the "Assigned to me" filter.
  await expect(row.getByText(/Assigned - You/i)).toBeVisible();
  await page.getByRole('tab', { name: 'Assigned to me' }).click();
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toBeVisible();

  // Unassign reverts live; restore baseline for the rest of the suite.
  await page.getByRole('tab', { name: 'All' }).click();
  await row.hover();
  await row.getByRole('button', { name: /Unassign/i }).click();
  await expect(row.getByText(/Assigned - You/i)).toHaveCount(0);
});
