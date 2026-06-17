import { test, expect } from '@playwright/test';

// B0 foundation proof for the NEW entity-centric dashboard (:5174): an anonymous
// visitor sees the Login screen, uses the hermetic dev-login button to sign in as
// the seeded VA, lands in the AppFrame with the full left nav (Workspace +
// Communications groups, Contacts ▸ children, Settings), and can Sign out back to
// Login. The new dashboard is served on :5174 by the e2e session alongside legacy
// (:5173); these specs target it by absolute URL since the suite's baseURL is the
// legacy :5173.
const NEXT = 'http://localhost:5174';

test('new dashboard: dev-login → AppFrame nav renders → sign out', async ({ page }) => {
  await page.goto(`${NEXT}/`);

  // Anonymous landing: Google sign-in + the hermetic dev-login button.
  await expect(page.getByRole('link', { name: /Sign in with Google/i })).toBeVisible();
  const devLogin = page.getByRole('button', { name: /Continue as dev user/i });
  await expect(devLogin).toBeVisible();

  // Dev-login reloads into / authenticated; the AppFrame mounts.
  await devLogin.click();

  // Left nav: the two labelled groups, with every Workspace destination present.
  const workspace = page.getByRole('navigation', { name: 'Workspace' });
  await expect(workspace).toBeVisible();
  for (const label of ['Today', 'Cases', 'Contacts', 'Tenants', 'Landlords', 'Unknown', 'Listings']) {
    await expect(workspace.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  const comms = page.getByRole('navigation', { name: 'Communications' });
  for (const label of ['Inbox', 'Broadcasts']) {
    await expect(comms.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

  // The Today landing page renders inside the frame.
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Account menu shows the seeded VA email + a Sign out action.
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('va@example.com')).toBeVisible();
  await menu.getByRole('button', { name: /Sign out/i }).click();

  // Back to anonymous Login.
  await expect(page.getByRole('link', { name: /Sign in with Google/i })).toBeVisible();
});
