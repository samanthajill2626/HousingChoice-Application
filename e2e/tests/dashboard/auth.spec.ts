import { test, expect } from '../../fixtures/auth.js';

test('unauthenticated visit to the dashboard shows the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Sign in with Google')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toHaveCount(0);
});

test('dev-login lands on the authenticated inbox', async ({ vaPage }) => {
  await vaPage.goto('/');
  await expect(vaPage.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(vaPage.getByText('Sign in with Google')).toHaveCount(0);
});
