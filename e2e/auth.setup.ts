import fs from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import { AUTH_DIR, VA_EMAIL, VA_STATE } from './fixtures/authState.js';

// Runs as a dependency before the chromium project (so the webServer is up).
// Calls the dev-login endpoint and persists the resulting cookies as storageState.
setup('authenticate as the seeded VA user', async ({ request }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const res = await request.post('/auth/dev-login', { data: { email: VA_EMAIL } });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).email).toBe(VA_EMAIL);
  await request.storageState({ path: VA_STATE });
});
