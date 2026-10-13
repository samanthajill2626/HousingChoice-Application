import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { APP_NUMBER, getOutboundTo, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { placeCall } from '../../fixtures/fakeVoice.js';
import { sendInboundEmail } from '../../fixtures/fakeEmail.js';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

// Last heard from (spec 2026-10-12 section 8 (1), 5.1, 14.2, 14.5 F5): every
// inbound channel moves a contact's `last_heard_from_at`, an outbound never does.
// Driven end to end through the real carrier/email seams against the hermetic
// lane: a 1:1 inbound text (path #1), a relay-group member's text (path #2), a
// missed business-line call (path #5) and an inbound email (path #8), each on a
// FRESH run-unique tenant - the label has minute resolution, so a "move" is
// proved as "Never" -> "Today h:mm" plus the API instant. Two outbound controls:
// a staff reply from the contact page, and a relay group's opening legs.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

const TODAY_LINE = /^Last heard from Today \d{1,2}:\d{2} [AP]M$/;

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** A consented, run-unique tenant (consent so a send reaches them). */
async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
  extra: { email?: string } = {},
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Heardtest';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone, voucherSize, ...extra },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} ${lastName}`, phone };
}

async function heardAt(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { last_heard_from_at?: string } }).contact.last_heard_from_at;
}

/** The contact header is fetched ONCE per id (useContact.ts) - it refreshes on
 *  navigation, never live (spec 14.5 F5) - so reload inside a retry, the
 *  expectEmailInTimeline idiom (scenarios/steps.ts). */
async function expectHeaderToday(page: Page, contactId: string): Promise<void> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  const header = page.locator('header').filter({ hasText: 'Last heard from' });
  await expect(async () => {
    await page.reload();
    await expect(header.getByText(TODAY_LINE)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

async function expectHeaderNever(page: Page, contactId: string): Promise<void> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(
    page.locator('header').filter({ hasText: 'Last heard from' }).getByText('Last heard from Never', { exact: true }),
  ).toBeVisible();
}

/** Poll the API (the touch is best-effort AFTER the append) until the value exists. */
async function waitForHeard(api: APIRequestContext, contactId: string): Promise<string> {
  let at: string | undefined;
  await expect
    .poll(async () => (at = await heardAt(api, contactId)) !== undefined, {
      timeout: 20_000,
      message: `last_heard_from_at never landed on ${contactId}`,
    })
    .toBe(true);
  return at!;
}

/** The stamp is the INBOUND's instant: no earlier than just before it was sent. */
function expectFresh(at: string, before: number): void {
  const ms = Date.parse(at);
  expect(ms, `last_heard_from_at ${at} predates the inbound`).toBeGreaterThanOrEqual(before - 60_000);
  expect(ms, `last_heard_from_at ${at} is in the future`).toBeLessThanOrEqual(Date.now() + 60_000);
}

test.describe('Last heard from - every inbound channel moves it, an outbound never does', () => {
  test('an inbound 1:1 text moves it; a staff reply does not', async ({ page, request }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const t = await createTenant(api, `HeardSms${stamp}`);
    expect(await heardAt(api, t.contactId)).toBeUndefined();
    await expectHeaderNever(page, t.contactId);

    // Path #1: the 1:1 inbound text stamps the inbound's own instant.
    const before = Date.now();
    await registerParty(request, { label: t.name, role: 'tenant', number: t.phone });
    await sendAsParty(request, { from: t.phone, to: APP_NUMBER, body: `Still looking ${t.firstName}` });
    const at = await waitForHeard(api, t.contactId);
    expectFresh(at, before);
    await expectHeaderToday(page, t.contactId);

    // Outbound control, from the contact page expectHeaderToday left open: the
    // fake carrier receiving the reply is the settle point that proves the
    // outbound completed; the stamp stays byte-identical (spec G1, I1).
    const since = new Date().toISOString();
    const reply = `Reply ${t.firstName}`;
    await page.getByRole('textbox', { name: 'Reply message' }).fill(reply);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(
        async () => (await getOutboundTo(request, { to: t.phone, since })).some((m) => (m.body ?? '').includes(reply)),
        { timeout: 15_000, message: 'the staff reply never reached the fake carrier' },
      )
      .toBe(true);
    expect(await heardAt(api, t.contactId)).toBe(at);
  });

  test('a missed business-line call moves it', async ({ page, request }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const t = await createTenant(api, `HeardCall${stamp}`);
    expect(await heardAt(api, t.contactId)).toBeUndefined();
    await expectHeaderNever(page, t.contactId);

    // Path #5 (14.5 F18): an inbound call nobody answers, no voicemail. The
    // missed-call auto-text that follows is an OUTBOUND and is not asserted here.
    const before = Date.now();
    await placeCall(request, { from: t.phone, to: APP_NUMBER, scenario: { digit: null, voicemail: false } });
    const at = await waitForHeard(api, t.contactId);
    expectFresh(at, before);
    await expectHeaderToday(page, t.contactId);
  });

  test("an inbound email from the contact's address moves it", async ({ page, request }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const email = `heard${stamp}@example.com`;
    const t = await createTenant(api, `HeardMail${stamp}`, 2, { email });
    expect(await heardAt(api, t.contactId)).toBeUndefined();
    await expectHeaderNever(page, t.contactId);

    // Path #8: the email channel resolves the sender by address.
    const before = Date.now();
    const res = await sendInboundEmail(request, {
      from: email,
      subject: `Heard ${stamp}`,
      text: 'Is the unit still open?',
    });
    expect(res.appStatus, 'the inbound webhook accepted the delivery').toBe(200);
    const at = await waitForHeard(api, t.contactId);
    expectFresh(at, before);
    await expectHeaderToday(page, t.contactId);
  });

  test.describe('relay group text', () => {
    // A real relay group must not outlive this file (relay-inbound-caller-identity.spec.ts).
    test.beforeEach(async ({ request }) => {
      await reseed(request);
    });
    test.afterAll(async ({ request }) => {
      await reseed(request);
    });

    test("a member's text in a relay group moves it", async ({ page, request }) => {
      await devLogin(page); // the reseed logged the browser out
      const api = page.request;
      const stamp = `${Date.now()}`.slice(-6);
      const t = await createTenant(api, `HeardRelay${stamp}`);
      const otherPhone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
      const relay = await createGroupOpen(page, [
        { phone: t.phone, name: t.name, contactId: t.contactId },
        { phone: otherPhone, name: 'Heard Relay Other' },
      ]);

      // The group's opening legs are OUTBOUND - a second outbound control.
      expect(await heardAt(api, t.contactId)).toBeUndefined();

      // Path #2: the relay inbound attributes the SENDING member.
      await registerParty(request, { label: t.name, role: 'tenant', number: t.phone });
      const before = Date.now();
      await sendAsParty(request, { from: t.phone, to: relay.pool_number, body: `Group hello ${t.firstName}` });
      const at = await waitForHeard(api, t.contactId);
      expectFresh(at, before);
      await expectHeaderToday(page, t.contactId);
    });
  });
});
