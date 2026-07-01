import { test, expect } from '@playwright/test';
import { getOutbox } from '../../fixtures/outbox.js';
import { reseed } from '../../fixtures/reseed.js';

// A housing-fair signup sends a welcome SMS synchronously (in-request). Use a
// unique phone each run so the assertion is independent of prior state.
test('synchronous welcome send is recorded in the outbox, and reseed clears it', async ({ request }) => {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  // A2P/CTIA (spec §3.1): the public intake now requires `smsConsent:true` (server
  // rejects a submit without it → 400 consent_required).
  const submit = await request.post('/public/housing-fair', {
    data: { firstName: 'Pat', lastName: 'Tester', phone, voucherSize: 2, smsConsent: true },
  });
  expect(submit.ok()).toBeTruthy();

  await expect
    .poll(async () => (await getOutbox(request, { to: phone })).length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // The default welcome is now the FILED A2P copy (WELCOME_SMS) — brand identity +
  // opt-out instruction — not a name-interpolated string. Assert the opt-out line
  // (a settings welcomeText override from another spec would still keep it, per the
  // template floor). NOTE: if a prior settings spec set a custom welcomeText, that
  // override wins; both the default and any valid override carry "Reply STOP".
  const messages = await getOutbox(request, { to: phone });
  expect(messages[0]?.body ?? '').toMatch(/Reply STOP/i);

  await reseed(request);
  expect(await getOutbox(request, { to: phone })).toHaveLength(0);
});
