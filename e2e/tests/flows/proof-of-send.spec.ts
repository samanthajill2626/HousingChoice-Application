import { test, expect } from '@playwright/test';
import { getOutboundTo } from '../../fixtures/fakeTwilio.js';

// The proof-of-send loop every send assertion in the suite rides on: an app
// send lands in the fake-twilio thread store (GET /control/threads). Formerly
// asserted via the deprecated /__dev/outbox app-side log
// (remove-dev-outbox-proof-of-send); the thread store is the wire-level
// replacement - it records what the fake RECEIVED, so it also proves the
// app -> fake hop, which the outbox never could.
//
// Deliberately NOT asserted here: that /control/reset clears the store. That
// is pinned by fake-twilio's own unit suite (control.test.ts), and calling the
// reset mid-suite would violate the fake's documented once-per-suite reset
// design (conversationsEngine.ts listens for it and wipes the Conversations
// rail + opt-out list too - preflight.ts owns the single per-suite call).
//
// A housing-fair signup sends a welcome SMS synchronously (in-request). Use a
// unique phone each run so the assertion is independent of prior state.
test('synchronous welcome send lands in the fake thread store', async ({ request }) => {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  // A2P/CTIA (spec 3.1): the public intake now requires `smsConsent:true` (server
  // rejects a submit without it -> 400 consent_required).
  const submit = await request.post('/public/housing-fair', {
    data: { firstName: 'Pat', lastName: 'Tester', phone, voucherSize: 2, smsConsent: true },
  });
  expect(submit.ok()).toBeTruthy();

  await expect
    .poll(async () => (await getOutboundTo(request, { to: phone })).length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // The default welcome is the FILED A2P copy (WELCOME_SMS) - brand identity +
  // opt-out instruction. Assert the opt-out line (a settings welcomeText
  // override from another spec would still keep it, per the template floor):
  // both the default and any valid override carry "Reply STOP".
  const messages = await getOutboundTo(request, { to: phone });
  expect(messages[0]?.body ?? '').toMatch(/Reply STOP/i);
});
