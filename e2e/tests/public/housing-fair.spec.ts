import { test, expect } from '@playwright/test';

// Phase 0 smoke: the public, unauthenticated housing-fair page renders in a
// real browser against the hermetic local stack. No auth, no form submission.
test('public housing-fair page renders unauthenticated', async ({ page }) => {
  await page.goto('/housing-fair');
  await expect(
    page.getByRole('heading', { name: 'Housing fair sign-up' }),
  ).toBeVisible();
});
