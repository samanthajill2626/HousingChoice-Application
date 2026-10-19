import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { failNextSend, getOutboundTo } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';
import { dashboardUrl } from '../../support/urls.js';

// A STAFF TEXT THE PROVIDER REJECTS READS AS A REASON, NOT A CRASH.
//
// prod 2026-10-16 (docs/issues/phone-number-quality.md): an imported contact
// held a number that cannot exist. Twilio answered the create with 400 / 21211,
// the send route let the typed error fall through to the error handler, and
// the composer read the 500 as "Couldn't send - please try again". Staff pressed
// Send four times in 11 seconds. The route now answers 422
// { error: 'provider_rejected', providerCode } and the composer names the
// reason.
//
// THE SEAM. The fake's fail-next-send `reject` mode answers the next create to
// one number with a Twilio 400 carrying the given code and records nothing -
// exactly the `rejected` send the prod incident was. The arming is per number,
// so every test mints its own; an arming no create consumed survives until the
// fake's once-per-suite reset, so it is never armed on a seed number.
//
// LEAN LANE: each test builds its own data on a freshly reseeded lean world,
// and the file restores that world on the way out.
const NEXT = dashboardUrl;

const INVALID_NUMBER_REASON = "Not sent - this phone number isn't valid. Check the contact's number.";

// +1 555 8XX XXXX, the exchange the relay and reconcile specs mint from. The
// uid starts at 60 - disjoint from the relay specs (0, 40),
// send-outcome-reconcile.spec.ts (70) and retry-send-adoption.spec.ts (90).
let uid = 60;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Dev-login AFTER the reseed, so the session's cookie epoch matches the re-seeded users table. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A fresh tenant on a per-run number WITH recorded consent, so the send reaches the provider. */
async function createConsentedTenant(api: APIRequestContext): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'Rejected', lastName: 'Number', phone, voucherSize: 2 },
  });
  expect(res.ok(), `tenant create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), `consent failed: ${consent.status()} ${await consent.text()}`).toBeTruthy();
  return { contactId, phone };
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('a 21211 rejection reads "this phone number isn\'t valid" in the composer, keeps the draft, and nothing is sent or stored', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const tenant = await createConsentedTenant(page.request);
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'reject', code: 21211 });
  const since = new Date().toISOString();

  await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
  const body = `Rejected number check ${Date.now()}`;
  const box = page.getByRole('textbox', { name: 'Reply message' });
  await box.fill(body);
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
  await expect(sendBtn).toBeEnabled({ timeout: 20_000 });

  const sendResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(r.url()),
  );
  await sendBtn.click();
  const res = await sendResponse;

  // The route answers the typed rejection - never the error handler's 500.
  expect(res.status()).toBe(422);
  expect(await res.json()).toEqual({ error: 'provider_rejected', providerCode: '21211' });

  // The screen names the reason, never invites the same send again, and keeps the draft.
  const alert = page.getByRole('alert').filter({ hasText: 'Not sent' });
  await expect(alert).toHaveText(INVALID_NUMBER_REASON);
  await expect(alert).not.toContainText(/try again/i);
  await expect(box).toHaveValue(body);

  // The carrier's view: nothing reached the tenant.
  expect(await getOutboundTo(request, { to: tenant.phone, since })).toHaveLength(0);

  // The thread's stored rows: nothing was recorded for the rejected text.
  const conversationId = /\/api\/conversations\/([^/]+)\/messages$/.exec(res.url())?.[1] ?? '';
  const rows = await page.request.get(`${NEXT}/api/conversations/${conversationId}/messages?limit=100`);
  expect(rows.ok(), `messages fetch failed: ${rows.status()}`).toBeTruthy();
  const { messages } = (await rows.json()) as { messages: { body?: string }[] };
  expect(messages.filter((m) => m.body === body)).toHaveLength(0);
});
