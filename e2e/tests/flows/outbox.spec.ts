import { test, expect } from '@playwright/test';
import { getOutbox } from '../../fixtures/outbox.js';
import { reseed } from '../../fixtures/reseed.js';

// A housing-fair signup sends a welcome SMS synchronously (in-request). Use a
// unique phone each run so the assertion is independent of prior state.
test('synchronous welcome send is recorded in the outbox, and reseed clears it', async ({ request }) => {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const submit = await request.post('/public/housing-fair', {
    data: { firstName: 'Pat', lastName: 'Tester', phone, voucherSize: 2 },
  });
  expect(submit.ok()).toBeTruthy();

  await expect
    .poll(async () => (await getOutbox(request, { to: phone })).length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const messages = await getOutbox(request, { to: phone });
  expect(messages[0]?.body ?? '').toContain('Pat');

  await reseed(request);
  expect(await getOutbox(request, { to: phone })).toHaveLength(0);
});
