// e2e/tests/dashboard-next/inbox-mark-unread-header.spec.ts
//
// THE HEADER HALF of mark-unread (D6). The inbox-ROW half is already covered by
// call-inbox-unread.spec.ts and is NOT duplicated here: this file drives the two
// surfaces a staff member reaches AFTER opening a thread - the contact page's
// kebab and the group-text conversation header - plus the live-count mechanism
// that decides which of the two labels each one offers.
//
// WHY A SEPARATE FILE. call-inbox-unread.spec.ts is a CALLS spec: its subject is
// "an inbound business-line call surfaces in the inbox", every case is driven by
// the fake-voice control API, and its module furniture (placeCall, the whisper
// scenarios, the missed-call auto-text setting) exists for that. The header half
// is a different subject driven by different fixtures (fake-twilio SMS and
// carrier-group inbounds), so folding it in would leave that file with two
// unrelated headers and two unrelated fixture sets. Keeping them apart also
// keeps the frozen row round trip untouched.
//
// D6, as shipped by S7 - exactly ONE action per surface, chosen by a LIVE count:
//
//   | Surface                | Role     | While READ                | While UNREAD          |
//   |------------------------|----------|---------------------------|-----------------------|
//   | Group-text header      | button   | Mark Group text as unread | Mark Group text read  |
//   | Contact kebab          | menuitem | Mark <name> as unread     | Mark <name> read      |
//
// The deliberate "as" is what keeps the two accessible names from being
// substrings of each other, so Playwright's substring name matching cannot
// confuse them. The pending state changes only the VISIBLE text
// ("Marking unread..."), never the aria-label, so a locator that found the
// action still finds it mid-flight.
//
// Driving notes:
//   - The GROUP-TEXT thread is the multi-party arm, not a relay group: the lean
//     seed's only relay group is `connecting` and is absent from the Groups
//     filter (group-text-conversion.spec.ts), and an `open` one would cost a
//     full-profile reseed.
//   - Every group text here is MINTED FRESH (registerParty + sendGroupAsParty
//     with run-unique numbers). Leaving the SEEDED group text unread would
//     poison call-inbox-unread.spec.ts's "lean seed baseline: nothing unread"
//     assertion for any later run.
//   - Rows are addressed BY HREF and their count span is read INSIDE the row: an
//     inbox row's count carries the same `<n> unread` accessible name as the nav
//     badge, so a bare getByLabel('1 unread') is a strict-mode collision
//     (inbox-nav-badge.spec.ts).
//   - The conversation page's auto-read is MOUNT ONLY (useMarkThreadRead), which
//     is what makes the third case possible: an inbound arriving while the
//     thread is open really does leave it unread, and the header has to learn
//     that from the conversation.updated SSE event alone.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerParty, sendAsParty, sendGroupAsParty } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';

/** The dashboard dev-server origin - resolved per-lane by playwright.config.ts. */
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

interface InboxRowWire {
  kind: string;
  contactId?: string;
  conversationId?: string;
  name: string;
  unreadCount: number;
}

async function devLogin(page: Page, email = 'va@example.com'): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Per-run-unique NANP E.164s so cases never collide across a full-suite run. */
let phoneSeq = 0;
function uniquePhone(): string {
  const stamp = `${Date.now()}`.slice(-5);
  phoneSeq += 1;
  return `+1555${stamp}${String(phoneSeq).padStart(2, '0')}`;
}

/** A FRESH contact per case - never the shared seeded tenant
 *  (docs/issues/inbox-specs-flaky-shared-tasha-state.md). */
async function createContact(
  api: APIRequestContext,
  firstName: string,
  lastName: string,
): Promise<{ contactId: string; phone: string; name: string }> {
  const phone = uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return { contactId: contact.contactId, phone, name: `${firstName} ${lastName}` };
}

async function inboxRows(
  api: APIRequestContext,
  filter: 'all' | 'unread' | 'groups',
): Promise<InboxRowWire[]> {
  const res = await api.get(`${NEXT}/api/inbox?filter=${filter}&limit=50`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { rows: InboxRowWire[] }).rows;
}

/** This thread's unread count as the SERVER sees it (0 when the row is absent
 *  from the unread feed), so a green UI assertion can never be an optimistic
 *  patch the server never committed. */
async function serverUnread(
  api: APIRequestContext,
  match: (row: InboxRowWire) => boolean,
): Promise<number> {
  const row = (await inboxRows(api, 'unread')).find(match);
  return row?.unreadCount ?? 0;
}

/** Mint a group text nobody else asserts on, and return its derived id. */
async function mintGroupText(
  api: APIRequestContext,
  label: string,
  body: string,
): Promise<{ conversationId: string; from: string; other: string }> {
  const from = uniquePhone();
  const other = uniquePhone();
  await registerParty(api, { label, role: 'tenant', number: from });
  await sendGroupAsParty(api, { from, otherRecipients: [other], body });
  return { conversationId: conversationIdForGroup([from, other]), from, other };
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test('the contact kebab marks a READ 1:1 thread unread, lands back on /inbox, and the row is unread', async ({
  page,
}) => {
  test.slow();
  const api = page.request;
  await devLogin(page);
  const { contactId, phone, name } = await createContact(api, 'Header', 'Tester');

  // Manufacture a real thread, then read it on the SERVER so the contact page is
  // opened on a genuinely read thread (the state the kebab must offer "Mark
  // unread" for). Lean seeds nothing unread, so this inbound is the only one.
  await registerParty(api, { label: `Header Tester ${contactId}`, role: 'tenant', number: phone });
  await sendAsParty(api, { from: phone, body: `header kebab inbound ${contactId}` });
  await expect
    .poll(() => serverUnread(api, (r) => r.contactId === contactId), {
      timeout: 20_000,
      message: 'the inbound never made the thread unread',
    })
    .toBe(1);
  const read = await api.post(`${NEXT}/api/inbox/${contactId}/read`);
  expect(read.ok(), await read.text()).toBeTruthy();
  await expect.poll(() => serverUnread(api, (r) => r.contactId === contactId)).toBe(0);

  // Open the contact FROM THE INBOX, by href - the row's derived title is not a
  // safe locator on a list this spec does not control.
  await page.goto(`${NEXT}/inbox`);
  const row = page.locator(`a[href="/contacts/${contactId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${contactId}$`));
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible({ timeout: 15_000 });

  // THE TOGGLE, BOTH DIRECTIONS. An absence-only assertion goes vacuous rather
  // than red, so the present half and the absent half are asserted together.
  await page.getByRole('button', { name: 'More actions' }).click();
  const markUnread = page.getByRole('menuitem', { name: `Mark ${name} as unread` });
  await expect(markUnread).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('menuitem', { name: `Mark ${name} read` })).toHaveCount(0);

  // D2: the unread direction is a DEPARTURE - it navigates to the inbox.
  await markUnread.click();
  await expect(page).toHaveURL(/\/inbox$/, { timeout: 15_000 });

  // ...and the row it just left is unread again, in the UI and on the server.
  const backRow = page.locator(`a[href="/contacts/${contactId}"]`);
  await expect(backRow).toBeVisible({ timeout: 15_000 });
  await expect(backRow.getByLabel('1 unread')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => serverUnread(api, (r) => r.contactId === contactId)).toBe(1);
});

test('the group-text header marks the open thread unread, lands back on /inbox, and the row is unread', async ({
  page,
}) => {
  test.slow();
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const body = `header group inbound ${stamp}`;
  const { conversationId } = await mintGroupText(api, `Header group ${stamp}`, body);

  await devLogin(page);

  // Open it from the Groups filter (a group row is on its own partition and is
  // addressed by href - its derived title is formatted numbers here).
  await page.goto(`${NEXT}/inbox?filter=groups`);
  const row = page.locator(`a[href="/conversations/${conversationId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByLabel(/\d+ unread/)).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
  await expect(page.getByText(body)).toBeVisible({ timeout: 20_000 });

  // The mount auto-read has just read the thread, and the header learns its new
  // count from that read's OWN conversation.updated event - no re-fetch. So the
  // settled header offers "Mark unread", and never both.
  const markUnread = page.getByRole('button', { name: 'Mark Group text as unread' });
  await expect(markUnread).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Mark Group text read' })).toHaveCount(0);
  await expect
    .poll(() => serverUnread(api, (r) => r.conversationId === conversationId), { timeout: 20_000 })
    .toBe(0);

  await markUnread.click();
  await expect(page).toHaveURL(/\/inbox$/, { timeout: 20_000 });

  // Back in the inbox the group row is unread again. It lives on the group
  // partition, so it is read off the Groups filter rather than the All tab.
  await expect
    .poll(() => serverUnread(api, (r) => r.conversationId === conversationId), {
      timeout: 20_000,
      message: 'the header mark-unread never reached the server',
    })
    .toBe(1);
  await page.goto(`${NEXT}/inbox?filter=groups`);
  const backRow = page.locator(`a[href="/conversations/${conversationId}"]`);
  await expect(backRow).toBeVisible({ timeout: 20_000 });
  await expect(backRow.getByLabel(/\d+ unread/)).toBeVisible({ timeout: 15_000 });
});

test('a fresh inbound flips the open group-text header from Mark unread to Mark read with NO reload, and Mark read flips it back without leaving', async ({
  page,
}) => {
  test.slow();
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const first = `live toggle first ${stamp}`;
  const { conversationId, from, other } = await mintGroupText(api, `Live toggle ${stamp}`, first);

  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${conversationId}`);
  await expect(page.getByText(first)).toBeVisible({ timeout: 20_000 });

  // Settle on the READ state first. The seed is deterministically PRE-auto-read,
  // so on arrival the header shows "Mark read" for a beat and then flips once
  // the mount auto-read's own conversation.updated lands; waiting for the
  // settled label is what keeps the rest of this case off that window.
  await expect(page.getByRole('button', { name: 'Mark Group text as unread' })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => serverUnread(api, (r) => r.conversationId === conversationId), { timeout: 20_000 })
    .toBe(0);

  // THE OTHER HALF OF THE TOGGLE, driven by the SSE live count. A party texts the
  // group while staff are sitting on the thread. The conversation page's
  // auto-read is MOUNT ONLY, so this inbound really does leave the thread unread,
  // and the header must learn it from conversation.updated alone - no reload, no
  // re-fetch of the mount header. This is what a frozen-seed header would fail.
  const second = `live toggle second ${stamp}`;
  await sendGroupAsParty(api, { from, otherRecipients: [other], body: second });
  await expect(page.getByRole('button', { name: 'Mark Group text read' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Mark Group text as unread' })).toHaveCount(0);
  await expect(page.getByText(second)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));

  // Mark read is NOT a departure (D2), and it flips the header back the same
  // live way. This also leaves the world clean: nothing this case minted stays
  // unread for a later spec.
  await page.getByRole('button', { name: 'Mark Group text read' }).click();
  await expect(page.getByRole('button', { name: 'Mark Group text as unread' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Mark Group text read' })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
  await expect
    .poll(() => serverUnread(api, (r) => r.conversationId === conversationId), {
      timeout: 20_000,
      message: 'the header mark-read never reached the server',
    })
    .toBe(0);
});
