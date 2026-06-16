import { test, expect } from '@playwright/test';

// Live smoke for the fake-phones UI (the dev-only operator surface served as a
// static build by the fake-twilio host on :8889). This is the interactive-UI
// counterpart to the control-API proof in fake-twilio-sms.spec.ts: instead of
// driving the engine over /control/*, a human/agent acts as a seeded party in
// the browser and watches the outbound message progress to `delivered` live
// over SSE.
//
// The UI lives on its own origin (:8889), distinct from the dashboard baseURL
// (:5173), so we navigate to an absolute URL. Override with FAKE_PHONES_URL.
//
// Selectors are accessibility-first and reconciled against the real component
// markup (see fake-twilio/web/src/ui/*):
//   - DevBanner       → role="status",  text "fake Twilio — no real messages are sent"
//   - RosterRail      → role="navigation", aria-label "Personas"
//   - persona row     → button, accessible name "<label>, <number>" (RosterRail.tsx)
//   - thread log      → role="log",     aria-label "Conversation" (App.tsx PhonePanel)
//   - Composer input  → role="textbox", aria-label "Message" (Composer.tsx)
//   - Send button     → role="button",  name "Send" (Composer.tsx)
//   - StatusChip      → role="status",  text "Delivered" once delivered (StatusChip.tsx)
const FAKE_PHONES_URL = process.env.FAKE_PHONES_URL ?? 'http://localhost:8889';

// Seeded tenant persona (fake-twilio/src/engine/registry.ts SEEDED_PERSONAS).
const TENANT_NUMBER = '+15550100001';
const TENANT_LABEL = 'Tasha Nguyen (tenant)';

test('fake-phones UI: send as the seeded tenant and watch it reach delivered', async ({ page }) => {
  await page.goto(FAKE_PHONES_URL);

  // The persistent dev banner and the persona roster are visible on load.
  await expect(page.getByText('fake Twilio — no real messages are sent')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Personas' })).toBeVisible();

  // Select the seeded tenant — the roster row's accessible name is "<label>, <number>".
  await page.getByRole('button', { name: `${TENANT_LABEL}, ${TENANT_NUMBER}` }).click();

  // The conversation panel opens for that party.
  const thread = page.getByRole('log', { name: 'Conversation' });
  await expect(thread).toBeVisible();

  // Type a message and send it (acting AS the tenant).
  const stamp = `${Date.now()}`.slice(-7);
  const body = `smoke from the fake-phones UI ${stamp}`;
  await page.getByRole('textbox', { name: 'Message' }).fill(body);
  await page.getByRole('button', { name: 'Send' }).click();

  // The new outbound bubble appears in the thread.
  const bubble = thread.getByText(body);
  await expect(bubble).toBeVisible();

  // Its StatusChip progresses to `delivered` (the engine's scheduled status
  // callbacks arrive live over SSE). Scope to the outbound bubble's row so we
  // assert on THIS message's chip, then poll until it reads "Delivered".
  const outboundRow = page
    .locator('[data-testid="message-bubble"][data-direction="outbound"]')
    .filter({ hasText: body });
  await expect(outboundRow.getByRole('status')).toHaveText(/Delivered/, { timeout: 15_000 });
});
