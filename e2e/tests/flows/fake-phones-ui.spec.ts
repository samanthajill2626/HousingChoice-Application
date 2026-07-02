import { test, expect } from '@playwright/test';

// Live smoke for the fake-phones UI (the dev-only operator surface served as a
// static build by the fake-twilio host on :8889). This is the interactive-UI
// counterpart to the control-API proof in fake-twilio-sms.spec.ts: instead of
// driving the engine over /control/*, a human/agent acts as a seeded party in
// the browser and watches their OWN sent message render live over SSE.
//
// The UI is a "fake phone" for the SELECTED PARTY, so bubbles are PARTY-CENTRIC
// (see fake-twilio/web/src/ui/MessageBubble.tsx): a message the party SENDS is
// engine `inbound` (party→app) and renders on the party's OUTGOING side
// (`data-party-side="outgoing"`, right/brand) with NO delivery chip. An app→party
// reply (engine `outbound`) would render on the INCOMING side with a StatusChip —
// but no app reply happens without a staff action, so this UI smoke does NOT
// assert one (that round-trip is proven by fake-twilio-sms.spec.ts and the run
// logs). This smoke proves the control-API send + SSE live-render round-trip.
//
// The UI lives on its own origin (:8889), distinct from the dashboard baseURL
// (:5173), so we navigate to an absolute URL. Override with FAKE_PHONES_URL.
//
// Selectors are accessibility-first and reconciled against the real component
// markup (see fake-twilio/web/src/ui/*):
//   - DevBanner       → text "fake Twilio — no real messages are sent" (DevBanner.tsx)
//   - RosterRail      → role="navigation", aria-label "Personas" (RosterRail.tsx)
//   - persona row     → button, accessible name starts "<label>, <number>" (RosterRail.tsx)
//   - thread log      → role="log",     aria-label "Conversation" (App.tsx PhonePanel)
//   - Composer input  → role="textbox", aria-label "Message" (Composer.tsx)
//   - Send button     → role="button",  name "Send" (Composer.tsx)
//   - message bubble  → [data-testid="message-bubble"] with party-centric
//                       [data-party-side="outgoing"|"incoming"] (MessageBubble.tsx)
const FAKE_PHONES_URL = process.env['FAKE_TWILIO_URL'] ?? process.env.FAKE_PHONES_URL ?? 'http://127.0.0.1:8889';

// Seeded tenant persona (fake-twilio/src/engine/registry.ts SEEDED_PERSONAS).
const TENANT_NUMBER = '+15550100001';
const TENANT_LABEL = 'Tasha Nguyen (tenant)';

test('fake-phones UI: send as the seeded tenant and see the tenant\'s own bubble render live', async ({
  page,
}) => {
  await page.goto(FAKE_PHONES_URL);

  // The persistent dev banner and the persona roster are visible on load.
  await expect(page.getByText('fake Twilio — no real messages are sent')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Personas' })).toBeVisible();

  // Select the seeded tenant — the roster row's accessible name starts
  // "<label>, <number>" (a trailing ", N unread" may follow), so match the prefix.
  await page
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(`${TENANT_LABEL}, ${TENANT_NUMBER}`)}`) })
    .click();

  // The conversation panel opens for that party.
  const thread = page.getByRole('log', { name: 'Conversation' });
  await expect(thread).toBeVisible();

  // Type a message and send it (acting AS the tenant).
  const stamp = `${Date.now()}`.slice(-7);
  const body = `smoke from the fake-phones UI ${stamp}`;
  await page.getByRole('textbox', { name: 'Message' }).fill(body);
  await page.getByRole('button', { name: 'Send' }).click();

  // The tenant's OWN message bubble renders live over SSE on the party's OUTGOING
  // side — proving the control-API send + SSE live-render round-trip. (No app
  // reply happens without a staff action, so we do NOT assert an incoming
  // "Delivered" bubble here.)
  const outgoingBubble = thread
    .locator('[data-testid="message-bubble"][data-party-side="outgoing"]')
    .filter({ hasText: body });
  await expect(outgoingBubble).toBeVisible({ timeout: 15_000 });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
