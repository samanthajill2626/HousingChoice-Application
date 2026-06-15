import { test as base, expect } from '@playwright/test';
import { VA_STATE } from './authState.js';
import type { Page } from '@playwright/test';

// Extends the base test with `vaPage`: a page in a context authenticated as the
// seeded VA user (via the storageState saved by auth.setup.ts). The default
// `page` fixture remains UNauthenticated.
export const test = base.extend<{ vaPage: Page }>({
  vaPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: VA_STATE });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
