// e2e/tests/dashboard-next/unknown-caller-triage.spec.ts
//
// inbound-call-skips-contact-capture: an inbound CALL from a brand-new (unknown)
// number must leave the caller reachable everywhere an unknown TEXTER would be:
//
//   1. a needs_review stub contact exists -> Contacts > Unknown lists the caller
//   2. Today surfaces a needs_you_now "New unknown contact" row for them
//   3. the Inbox row deep-links to the CONTACT page (/contacts/:id), never the
//      phone-fallback list URL
//   4. the /contacts/unknown?phone= deep-link seeds the search box (the fallback
//      URL itself now lands somewhere useful)
//
// Driving notes: the call is placed via the fake-twilio voice control API from a
// per-run-unique phone with digit:null (the founder never accepts the whisper
// gate -> a MISSED business-line call, the exact shape of the live bug report).
// Capture happens at RING time (the /voice webhook), so assertions poll the
// contacts API for the stub before touching the UI.
import { test, expect, type Page } from '@playwright/test';
import { placeCall } from '../../fixtures/fakeVoice.js';
import { reseed } from '../../fixtures/reseed.js';
import { uniqueVoicePhone, NEXT } from '../../fixtures/voiceSetup.js';
import { expectTodayReady } from '../../support/today.js';

/** The app's business number in the e2e stack (BUSINESS_PHONE_NUMBER). */
const BUSINESS = '+15550009999';

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test('an inbound call from an unknown number is captured: Unknown list + Today + inbox contact deep-link', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);

  const caller = uniqueVoicePhone();
  // digit:null = the founder never presses the whisper gate -> missed call.
  await placeCall(api, { from: caller, to: BUSINESS, scenario: { digit: null } });

  // (1) The stub contact exists: type unknown / needs_review, call-channel stamps.
  let stub: { contactId: string; phone?: string; status?: string } | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?type=unknown`);
        if (!res.ok()) return false;
        const { contacts } = (await res.json()) as {
          contacts: Array<{ contactId: string; phone?: string; status?: string }>;
        };
        stub = contacts.find((c) => c.phone === caller);
        return stub !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  expect(stub!.status).toBe('needs_review');

  // (2) Today: a needs_you_now row anchored to the captured CONTACT.
  const today = await api.get(`${NEXT}/api/today`);
  expect(today.status(), await today.text()).toBe(200);
  const { items } = (await today.json()) as {
    items: Array<{ group: string; refType: string; refId: string; who: string; why: string }>;
  };
  const row = items.find((i) => i.refId === stub!.contactId);
  expect(row, `no Today item for ${stub!.contactId}: ${JSON.stringify(items)}`).toBeDefined();
  expect(row!.group).toBe('needs_you_now');
  expect(row!.refType).toBe('contact');
  expect(row!.why).toBe('New unknown contact');

  // Today is a staff-facing display surface: the contact keeps E.164 storage,
  // but its phone-only identity is rendered in the existing NANP display form.
  expect(caller).toMatch(/^\+1\d{10}$/);
  const local = caller.slice(2);
  const callerDisplay = `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  expect(row!.who).toBe(callerDisplay);

  await page.goto(`${NEXT}/`);
  const todayRow = page
    .getByRole('list', { name: 'Needs you now' })
    .getByRole('link')
    .filter({ hasText: callerDisplay })
    .filter({ hasText: 'New unknown contact' });
  await expect(todayRow).toBeVisible();
  await expect(todayRow).not.toContainText(caller);
  await expect(todayRow).toHaveAttribute('href', `/contacts/${stub!.contactId}`);

  // (3) The Inbox row for the caller links to the CONTACT page (never the
  // phone-fallback list URL) and carries the Needs-triage chip. Addressed by
  // href, NOT by preview copy: the row's preview is a race between the
  // missed-call auto-text body and the "Voicemail" stamp (call-inbox-unread),
  // and the old `hasText: 'Call'` only ever matched "...missed your call!" in
  // the auto-text - never the channel chip.
  await page.goto(`${NEXT}/inbox`);
  const inboxRow = page.locator(`a[href="/contacts/${stub!.contactId}"]`);
  await expect(inboxRow).toBeVisible();
  await expect(inboxRow).toContainText(/needs triage/i);

  // (4) The legacy ?phone= deep-link seeds the Unknown list's search box and
  // shows the captured caller's row.
  await page.goto(`${NEXT}/contacts/unknown?phone=${encodeURIComponent(caller)}`);
  await expect(page.getByRole('searchbox', { name: /search/i })).toHaveValue(caller);
  const rows = page.getByRole('list', { name: 'Unknown' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', `/contacts/${stub!.contactId}`);
});
