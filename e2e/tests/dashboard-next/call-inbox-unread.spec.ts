// e2e/tests/dashboard-next/call-inbox-unread.spec.ts
//
// Calls surface in the inbox (docs/issues/inbound-calls-invisible-in-inbox.md):
// a missed inbound business-line call re-sorts the caller's thread to the TOP,
// marks it UNREAD (nav badge + Unread tab), and staff clear it exactly like a
// text (Mark read / opening the contact). Only a MISS (and a voicemail) is
// unread; an ANSWERED call re-sorts already-read. The row action is ONE toggle:
// Mark read while unread, Mark unread while read (operator decision 2026-08-17).
//
// Driving notes:
//   - Calls come in through the fake-twilio voice control API from a fresh
//     contact created via the API (never the shared seeded tenant - see
//     docs/issues/inbox-specs-flaky-shared-tasha-state.md).
//   - digit:null = the founder never accepts the whisper gate -> a MISS.
//     `voicemail:false` hangs up at the beep so the miss stays a plain miss (a
//     left voicemail bumps unread AGAIN, covered by its own case).
//   - The missed-call auto-text is ON by default in the seed. It re-previews the
//     thread with the auto-text body (accepted v1 behavior); the unread state
//     and ordering are what this spec pins. The preview/chip assertions run
//     with the auto-text switched OFF via PUT /api/settings (admin).
//   - Rows are addressed by href (the contact page link) - the one identifier a
//     row certainly has; the nav badge is read through the navigation landmark
//     because an inbox row renders a same-named count span (inbox-nav-badge.spec).
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { placeCall } from '../../fixtures/fakeVoice.js';
import { reseed } from '../../fixtures/reseed.js';
import { uniqueVoicePhone, NEXT } from '../../fixtures/voiceSetup.js';
import { expectTodayReady } from '../../support/today.js';

/** The app's business number in the e2e stack (BUSINESS_PHONE_NUMBER). */
const BUSINESS = '+15550009999';
/** PUT /api/settings is admin-only; dev.ts maps this email to role 'admin'. */
const ADMIN_EMAIL = 'founder@example.com';

interface InboxRowWire {
  kind: string;
  contactId?: string;
  name: string;
  unreadCount: number;
  preview: string;
  channel?: string;
  direction?: string;
  lastActivityAt: string;
}

async function devLogin(page: Page, email = 'va@example.com'): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

async function createContact(api: APIRequestContext): Promise<{ contactId: string; phone: string }> {
  const phone = uniqueVoicePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'Caller', lastName: 'Tester', phone },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return { contactId: contact.contactId, phone };
}

async function inboxRows(api: APIRequestContext, filter: 'all' | 'unread'): Promise<InboxRowWire[]> {
  const res = await api.get(`${NEXT}/api/inbox?filter=${filter}&limit=50`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { rows: InboxRowWire[] }).rows;
}

async function unreadCount(api: APIRequestContext): Promise<number> {
  const res = await api.get(`${NEXT}/api/inbox/unread-count`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { unreadCount: number }).unreadCount;
}

/** Poll until the contact's inbox row satisfies `pred`; returns the row. */
async function waitForRow(
  api: APIRequestContext,
  filter: 'all' | 'unread',
  contactId: string,
  pred: (row: InboxRowWire) => boolean,
  message: string,
): Promise<InboxRowWire> {
  let found: InboxRowWire | undefined;
  await expect
    .poll(
      async () => {
        found = (await inboxRows(api, filter)).find((r) => r.contactId === contactId);
        return found !== undefined && pred(found);
      },
      { timeout: 20_000, message },
    )
    .toBe(true);
  return found!;
}

/** The nav badge, and ONLY the nav badge (an inbox row has a same-named twin). */
function navBadge(page: Page): Locator {
  return page
    .getByRole('navigation', { name: 'Communications' })
    .getByRole('link', { name: 'Inbox' })
    .locator('xpath=following-sibling::span[contains(@aria-label, "unread")]');
}

async function setMissedCallAutoText(api: APIRequestContext, enabled: boolean): Promise<void> {
  const res = await api.put(`${NEXT}/api/settings`, { data: { missedCallAutoTextEnabled: enabled } });
  expect(res.status(), await res.text()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test('a MISSED business-line call marks the caller unread: nav badge, Unread tab, top of the inbox; Mark read clears it', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);
  const { contactId, phone } = await createContact(api);
  // Lean seed baseline: nothing unread.
  expect(await unreadCount(api)).toBe(0);

  await placeCall(api, { from: phone, to: BUSINESS, scenario: { digit: null, voicemail: false } });

  // API: the thread is unread, and it is the newest row in BOTH feeds.
  const row = await waitForRow(api, 'unread', contactId, (r) => r.unreadCount === 1, 'missed call never became unread');
  expect(row.kind).toBe('contact');
  const all = await inboxRows(api, 'all');
  expect(all[0]?.contactId, `missed call is not the top row: ${JSON.stringify(all.slice(0, 3))}`).toBe(contactId);
  await expect.poll(() => unreadCount(api)).toBe(1);

  // UI: nav badge "1 unread"; the Unread tab shows the row with its own count.
  await page.goto(`${NEXT}/inbox`);
  await expect(navBadge(page)).toHaveAttribute('aria-label', '1 unread');
  await page.getByRole('tab', { name: 'Unread' }).click();
  const link = page.locator(`a[href="/contacts/${contactId}"]`);
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link.getByLabel('1 unread')).toBeVisible();

  // Mark read from the row (`.actions` reveals on row hover - the hover is part
  // of the interaction, as in inbox-nav-badge.spec): the badge is gone and the
  // server agrees.
  await link.hover();
  await page.getByRole('button', { name: 'Mark Caller Tester read' }).click();
  await expect(navBadge(page)).toHaveCount(0);
  await expect.poll(() => unreadCount(api)).toBe(0);
  await expect(page.locator(`a[href="/contacts/${contactId}"]`)).toHaveCount(0);

  // The toggle's other half: on the All tab the now-read row offers Mark UNREAD
  // (never both), and flagging it re-lists it as unread with the badge back.
  await page.getByRole('tab', { name: 'All' }).click();
  const readRow = page.locator(`a[href="/contacts/${contactId}"]`);
  await expect(readRow).toBeVisible({ timeout: 10_000 });
  await readRow.hover();
  await expect(page.getByRole('button', { name: 'Mark Caller Tester read' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark Caller Tester as unread' }).click();
  await expect(readRow.getByLabel('1 unread')).toBeVisible();
  await expect.poll(() => unreadCount(api)).toBe(1);
  await expect(navBadge(page)).toHaveAttribute('aria-label', '1 unread', { timeout: 10_000 });
  await readRow.hover();
  await expect(page.getByRole('button', { name: 'Mark Caller Tester as unread' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark Caller Tester read' })).toBeVisible();
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.locator(`a[href="/contacts/${contactId}"]`)).toBeVisible({ timeout: 10_000 });
});

test('with the auto-text OFF the row reads "Missed call" on the Call channel; a left voicemail re-flags it as "Voicemail"', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page, ADMIN_EMAIL);
  await setMissedCallAutoText(api, false);
  try {
    const { contactId, phone } = await createContact(api);

    // A plain miss (hang up at the beep).
    await placeCall(api, { from: phone, to: BUSINESS, scenario: { digit: null, voicemail: false } });
    const missed = await waitForRow(
      api,
      'unread',
      contactId,
      (r) => r.preview === 'Missed call',
      'row never previewed "Missed call"',
    );
    expect(missed.channel).toBe('call');
    expect(missed.direction).toBe('inbound');
    expect(missed.unreadCount).toBe(1);

    await page.goto(`${NEXT}/inbox`);
    await page.getByRole('tab', { name: 'Unread' }).click();
    const link = page.locator(`a[href="/contacts/${contactId}"]`);
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toContainText('Missed call');
    await expect(link).toContainText('Call');

    // Staff read it, then the SAME caller calls again and leaves a voicemail:
    // the thread re-flags with the "Voicemail" preview.
    const read = await api.post(`${NEXT}/api/inbox/${contactId}/read`);
    expect(read.ok()).toBeTruthy();
    await expect.poll(() => unreadCount(api)).toBe(0);

    await placeCall(api, {
      from: phone,
      to: BUSINESS,
      scenario: { digit: null, transcript: 'Please call me back.' },
    });
    const vm = await waitForRow(
      api,
      'unread',
      contactId,
      (r) => r.preview === 'Voicemail',
      'row never previewed "Voicemail"',
    );
    // Miss (+1) then voicemail (+1) on the second call, on a thread read in between.
    expect(vm.unreadCount).toBe(2);
    expect(vm.channel).toBe('call');
  } finally {
    await setMissedCallAutoText(api, true);
  }
});

test('an ANSWERED business-line call re-sorts the thread already-read ("Call - <talk time>")', async ({ page }) => {
  const api = page.request;
  await devLogin(page, ADMIN_EMAIL);
  await setMissedCallAutoText(api, false);
  try {
    const { contactId, phone } = await createContact(api);
    // digit:'1' = the founder accepts the whisper gate -> answered bridge.
    await placeCall(api, { from: phone, to: BUSINESS, scenario: { digit: '1', record: false } });
    const row = await waitForRow(
      api,
      'all',
      contactId,
      (r) => /^Call( - \d+m \d+s| - \d+s)?$/.test(r.preview),
      'answered call never re-previewed the thread',
    );
    expect(row.unreadCount).toBe(0);
    expect(row.channel).toBe('call');
    expect((await inboxRows(api, 'unread')).find((r) => r.contactId === contactId)).toBeUndefined();
    expect(await unreadCount(api)).toBe(0);
  } finally {
    await setMissedCallAutoText(api, true);
  }
});

test('a missed call that lands WHILE staff are viewing the contact page does not leave the thread unread', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);
  const { contactId, phone } = await createContact(api);
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

  await placeCall(api, { from: phone, to: BUSINESS, scenario: { digit: null, voicemail: false } });
  // The call card renders live in the comms region.
  const region = page.getByRole('region', { name: 'Communications and activity' });
  await expect(region.getByText('Missed', { exact: true })).toBeVisible({ timeout: 20_000 });

  // The open+visible page re-marked read on the live event: the server count
  // settles at 0 and the Unread tab does not list the caller.
  await expect.poll(() => unreadCount(api), { timeout: 10_000 }).toBe(0);
  await page.goto(`${NEXT}/inbox`);
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.locator(`a[href="/contacts/${contactId}"]`)).toHaveCount(0);
});
