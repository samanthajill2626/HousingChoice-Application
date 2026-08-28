// Relay non-member caller identity - hermetic end-to-end proof.
//
// This deliberately drives the existing pool-number webhook path with a caller
// who is neither a group member nor a contact. It proves the refusal stays a
// no-Dial call while staff can see the stored caller identity in the relay card.
import { test, expect, type Page } from '@playwright/test';
import { listCalls, placeCall, type FakeCall } from '../../fixtures/fakeVoice.js';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { reseed } from '../../fixtures/reseed.js';
import { legPhones, uniqueVoicePhone } from '../../fixtures/voiceSetup.js';
import { expectTodayReady } from '../../support/today.js';
import { formatDateTimeWithSeconds, formatPhone } from '../../../dashboard/src/routes/contact/format.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

interface RelayMessage {
  provider_sid?: string;
  provider_ts?: string;
  relay_refusal_reason?: string;
  relay_external_caller_phone?: string;
  relay_external_caller_contact_id?: string;
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

async function relayMessages(page: Page, conversationId: string): Promise<RelayMessage[]> {
  const res = await page.request.get(`${NEXT}/api/conversations/${conversationId}/messages?limit=50`);
  expect(res.ok(), `relay messages read failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { messages: RelayMessage[] }).messages;
}

function commsRegion(page: Page) {
  return page.getByRole('region', { name: 'Communications and activity' });
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

// This file creates a real relay group and therefore restores the stable lean
// fixture for every later spec, even when its assertion fails midway through.
test.afterAll(async ({ request }) => {
  await reseed(request);
});

test('a non-member caller is recorded without a participant leg and is explained to staff', async ({
  page,
}) => {
  await devLogin(page);

  const firstMember = uniqueVoicePhone();
  const secondMember = uniqueVoicePhone();
  const externalCaller = uniqueVoicePhone();
  const relay = await createGroupOpen(page, [
    { phone: firstMember, name: 'Relay Member One' },
    { phone: secondMember, name: 'Relay Member Two' },
  ]);

  const sid = await placeCall(page.request, { from: externalCaller, to: relay.pool_number });

  let fakeCall: FakeCall | undefined;
  await expect
    .poll(
      async () => {
        fakeCall = (await listCalls(page.request)).find((call) => call.callSid === sid);
        return fakeCall?.status;
      },
      { timeout: 15_000, message: 'the refused relay call never reached a terminal fake state' },
    )
    .toBe('completed');
  expect(fakeCall, 'the fake control API retained the refused relay call').toBeDefined();
  expect(legPhones(fakeCall!), 'a non-member refusal must not create a Dial leg').toEqual([]);

  let persisted: RelayMessage | undefined;
  await expect
    .poll(
      async () => {
        persisted = (await relayMessages(page, relay.conversationId)).find((message) => message.provider_sid === sid);
        return persisted?.relay_refusal_reason;
      },
      { timeout: 15_000, message: 'the non-member call row was not persisted' },
    )
    .toBe('non_member');
  expect(persisted!.relay_external_caller_phone).toBe(externalCaller);
  expect(persisted!.relay_external_caller_contact_id).toBeUndefined();

  const contacts = await page.request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(externalCaller)}`);
  expect(contacts.ok(), `contacts lookup failed: ${contacts.status()} ${await contacts.text()}`).toBeTruthy();
  expect(((await contacts.json()) as { contacts: unknown[] }).contacts).toHaveLength(0);

  await page.goto(`${NEXT}/conversations/${relay.conversationId}`);
  const region = commsRegion(page);
  const formattedPhone = formatPhone(externalCaller);
  const faceCopy = `${formattedPhone} tried to call this relay number`;
  const card = region.getByRole('group', { name: new RegExp(`^${escapedRegex(faceCopy)} -`) });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(faceCopy, { exact: true })).toBeVisible();
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible();

  const callerPhone = card.getByText(formattedPhone, { exact: true });
  await expect(callerPhone).toBeHidden();
  await card.getByRole('button', { name: /^Details for / }).click();
  await expect(callerPhone).toBeVisible();
  await expect(card.getByText('No linked contact', { exact: true })).toBeVisible();
  await expect(card.getByText('Not a participant in this relay group', { exact: true })).toBeVisible();
  await expect(card.getByText(formatDateTimeWithSeconds(persisted!.provider_ts ?? ''), { exact: true })).toBeVisible();
});

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
