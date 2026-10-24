// e2e/tests/dashboard-next/unknown-inactive.spec.ts
//
// Inactive for every contact type (tracker #30; spec
// docs/superpowers/specs/2026-10-23-unknown-inactive-design.md, test 8):
// staff mark an unknown Needs review contact Inactive from the contact page
// HEADER DROPDOWN, without giving it a type. It leaves Today's Identify these
// contacts (live, on an already-open Today page; the "New unknown contact"
// rows moved there from Needs you now in tracker #31), stays on Contacts >
// Unknown (listed after the Needs review contacts), sits on the inbox Unknown
// tab BELOW the Needs review rows with an "Inactive" tag, and a new inbound
// text from it shows unread in the inbox without putting it back in Identify
// these contacts or moving its status.
//
// STATE. Every test reseeds first and last. The lean world holds ZERO unknown
// contacts (unknown-caller-triage.spec.ts relies on that), so after the reseed
// every unknown contact on the lane is one this test made, and the reseed
// after keeps this test's Inactive contact and unread rows out of later
// specs. The test builds two unknown contacts from inbound texts: A, the one
// marked Inactive, and B, a Needs review POSITIVE CONTROL that must stay on
// Identify these contacts and sit ABOVE A on the Unknown tab. No lean-seed
// contact is added (plan AR12).
//
// THE TEXTS go straight to the app's signed SMS webhook (postInboundSms), so
// no fake persona is needed: the inbound pipeline captures each new number as
// an (unknown, needs_review) stub with an unknown_1to1 thread. B is texted
// FIRST, so A's activity is newer: a newest-first sort would put A ABOVE B,
// and only the Unknown tab's Needs-review-first sort (D9) puts it below.
//
// UNREAD ORDERING. Opening a contact page marks every thread of the contact
// read (useMarkContactRead). A's page is opened BEFORE the Today page, so the
// read and its refetch have landed before the Today page starts watching; the
// second inbound's unread is asserted on the inbox and on Today BEFORE the
// last visit to A's page.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** Every accessible name and copy string this spec uses. If an as-built name
 *  differs, change it HERE only. */
const UI = {
  statusTrigger: (label: string): string => `Contact status: ${label}`,
  statusMenu: 'Contact status',
  needsReview: 'Needs review',
  inactive: 'Inactive',
  active: 'Active',
  triageCard: 'Needs triage',
  typeUnknownCard: 'Type unknown',
  markAsTenant: 'Mark as Tenant',
  identify: 'Identify these contacts',
  newUnknown: 'New unknown contact',
  inboxList: 'Conversations',
  unknownTab: 'Unknown',
  contactsUnknownList: 'Unknown',
  triageChip: 'Needs triage',
  inactiveTag: 'Inactive',
  unreadOne: '1 unread',
};

/** A window flag set on the open Today page; still set later = no reload. */
const NO_RELOAD = '__hcUnknownInactiveNoReload';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164: +1 555 8 <4 stamp digits> <2-digit index>. The leading
 *  8 keeps it clear of the lean seed's +1555010000x numbers, the fake's
 *  +155501990xx ad-hoc range and the app number. */
function mintNumber(stamp: string, i: number): string {
  return `+15558${stamp.slice(-4)}${String(i).padStart(2, '0')}`;
}

/** "+15551234567" -> "(555) 123-4567", how the app shows an unnamed contact. */
function displayOf(e164: string): string {
  const d = e164.replace(/\D/g, '').slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

let sidSeq = 0;
/** A per-call-unique inbound MessageSid (the webhook dedupes by SID). */
function uniqueSid(): string {
  sidSeq += 1;
  return `SMui${Date.now()}${sidSeq}`;
}

/** One signed inbound SMS from `from` to the business number. */
async function textIn(request: APIRequestContext, from: string, body: string): Promise<void> {
  const res = await postInboundSms(request, { from, body, messageSid: uniqueSid() });
  expect(res.status, `inbound webhook from ${from}: ${res.body}`).toBe(200);
}

/** The unknown contact the inbound captured, by the EXACT ?phone= lookup
 *  (the caseworkers.spec.ts idiom: never a scan of ?type=unknown). */
async function findUnknownContactId(api: APIRequestContext, phone: string): Promise<string> {
  let contactId: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        const { contacts } = (await res.json()) as {
          contacts: Array<{ contactId: string; type?: string }>;
        };
        contactId = contacts.find((c) => c.type === 'unknown')?.contactId;
        return contactId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return contactId as string;
}

async function readStatus(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), `read contact ${contactId}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { contact: { status?: string } }).contact.status;
}

interface TodayWireItem {
  group: string;
  refType: string;
  refId: string;
}

/** The contact ids on Today's Identify these contacts (the `identify` group
 *  since tracker #31), server truth. Throws on a non-200 so a failed read can
 *  never pass a "not in" check. */
async function identifyIds(api: APIRequestContext): Promise<string[]> {
  const res = await api.get(`${NEXT}/api/today`);
  if (res.status() !== 200) throw new Error(`GET /api/today: ${res.status()} ${await res.text()}`);
  const { items } = (await res.json()) as { items: TodayWireItem[] };
  return items.filter((i) => i.group === 'identify' && i.refType === 'contact').map((i) => i.refId);
}

interface InboxWireRow {
  contactId?: string;
  unreadCount: number;
  needsTriage: boolean;
  inactive?: boolean;
}

/** One contact's row in an inbox feed (absent = not in that feed). */
async function inboxWireRow(
  api: APIRequestContext,
  filter: 'unread' | 'unknown',
  contactId: string,
): Promise<InboxWireRow | undefined> {
  const res = await api.get(`${NEXT}/api/inbox?filter=${filter}&limit=100`);
  if (!res.ok()) throw new Error(`GET /api/inbox?filter=${filter}: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { rows: InboxWireRow[] }).rows.find((r) => r.contactId === contactId);
}

/** The contact hrefs of a list's row links, in DOM (render) order. */
async function rowHrefs(list: Locator): Promise<string[]> {
  return list.getByRole('link').evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
}

/** A "New unknown contact" row on Today's Identify these contacts, by the
 *  display phone. */
function todayRow(page: Page, phone: string): Locator {
  return page
    .getByRole('list', { name: UI.identify, exact: true })
    .getByRole('link')
    .filter({ hasText: displayOf(phone) });
}

function inboxList(page: Page): Locator {
  return page.getByRole('list', { name: UI.inboxList, exact: true });
}

/** An inbox row by its contact href (the inbox-nav-badge.spec.ts idiom). */
function inboxRow(page: Page, contactId: string): Locator {
  return inboxList(page)
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/contacts/${contactId}"]`) });
}

function statusTrigger(page: Page, label: string): Locator {
  return page.getByRole('button', { name: UI.statusTrigger(label), exact: true });
}

test.describe('Inactive for an unknown contact', () => {
  test.beforeEach(async ({ request }) => {
    await reseed(request);
  });
  test.afterEach(async ({ request }) => {
    await reseed(request);
  });

  test('the header dropdown marks an unknown contact Inactive: off Identify these contacts, still in the inbox, status kept', async ({
    page,
    request,
  }) => {
    test.slow(); // a reseed each side, three inbounds, two pages and several feeds
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const phoneB = mintNumber(stamp, 0); // stays Needs review: the positive control
    const phoneA = mintNumber(stamp, 1); // marked Inactive

    await devLogin(page);

    // (1) Two unknown contacts from inbound texts - B first, so A is newer.
    await textIn(request, phoneB, `hello from the control ${stamp}`);
    const idB = await findUnknownContactId(api, phoneB);
    await textIn(request, phoneA, `hello from the subject ${stamp}`);
    const idA = await findUnknownContactId(api, phoneA);
    expect(await readStatus(api, idA)).toBe('needs_review');
    expect(await readStatus(api, idB)).toBe('needs_review');

    // (2) A's contact page: the header carries the DROPDOWN (not a display-only
    //     badge) with exactly the unknown statuses. Opening the page marks A's
    //     thread read; wait for that to land so nothing from it is in flight
    //     when the Today page starts watching below.
    await page.goto(`${NEXT}/contacts/${idA}`);
    await expect(page.getByRole('heading', { name: UI.triageCard })).toBeVisible();
    await expect(statusTrigger(page, UI.needsReview)).toBeEnabled();
    await expect
      .poll(async () => (await inboxWireRow(api, 'unread', idA)) === undefined, { timeout: 15_000 })
      .toBe(true);

    // (3) An OPEN Today page, on the event stream, shows both contacts.
    const today = await page.context().newPage();
    const streamOpen = today.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
    );
    await today.goto(`${NEXT}/`);
    await expectTodayReady(today);
    await streamOpen;
    await expect(todayRow(today, phoneA)).toBeVisible();
    await expect(todayRow(today, phoneA)).toContainText(UI.newUnknown);
    await expect(todayRow(today, phoneB)).toBeVisible();
    await today.evaluate((k) => {
      (window as unknown as Record<string, unknown>)[k] = true;
    }, NO_RELOAD);

    // (4) Mark A Inactive from the header dropdown.
    await page.bringToFront();
    await statusTrigger(page, UI.needsReview).click();
    const menu = page.getByRole('menu', { name: UI.statusMenu });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { name: UI.needsReview, exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: UI.active, exact: true })).toHaveCount(0);
    await menu.getByRole('menuitemradio', { name: UI.inactive, exact: true }).click();
    await expect(statusTrigger(page, UI.inactive)).toBeEnabled();
    expect(await readStatus(api, idA)).toBe('inactive');
    // D8: the card keeps its Mark as buttons; only the title changes.
    await expect(page.getByRole('heading', { name: UI.typeUnknownCard })).toBeVisible();
    await expect(page.getByRole('heading', { name: UI.triageCard })).toHaveCount(0);
    await expect(page.getByRole('button', { name: UI.markAsTenant })).toBeVisible();

    // (5) The open Today page drops A WITHOUT a reload; B stays.
    await today.bringToFront();
    await expect(todayRow(today, phoneA)).toHaveCount(0);
    await expect(todayRow(today, phoneB)).toBeVisible();
    expect(
      await today.evaluate((k) => (window as unknown as Record<string, unknown>)[k], NO_RELOAD),
      'the Today page reloaded - the drop was not live',
    ).toBe(true);
    await today.close();
    await page.bringToFront();
    await expect(async () => {
      const ids = await identifyIds(api);
      expect(ids).not.toContain(idA);
      expect(ids).toContain(idB);
    }).toPass({ timeout: 10_000 });

    // (6) Contacts > Unknown still lists A, labeled Inactive, AFTER the Needs
    //     review contact B (WORKLIST OR-1: the server answers ascending by
    //     status, so without the Unknown view's own order A would list first).
    await page.goto(`${NEXT}/contacts/unknown`);
    const unknownList = page.getByRole('list', { name: UI.contactsUnknownList });
    const unknownRows = unknownList.getByRole('listitem');
    const contactsRowA = unknownRows.filter({ has: page.locator(`a[href="/contacts/${idA}"]`) });
    await expect(contactsRowA).toHaveCount(1);
    await expect(contactsRowA).toContainText(UI.inactive);
    await expect(unknownRows.filter({ has: page.locator(`a[href="/contacts/${idB}"]`) })).toHaveCount(1);
    const listed = await rowHrefs(unknownList);
    const listedB = listed.indexOf(`/contacts/${idB}`);
    const listedA = listed.indexOf(`/contacts/${idA}`);
    expect(listedB, `rows: ${JSON.stringify(listed)}`).toBeGreaterThanOrEqual(0);
    expect(listedB, `Needs review must list above Inactive: ${JSON.stringify(listed)}`).toBeLessThan(listedA);

    // (7) Inbox Unknown tab: B (older, Needs review) ABOVE A (newer, Inactive);
    //     A carries the Inactive tag and no Needs triage chip.
    await page.goto(`${NEXT}/inbox?filter=unknown`);
    await expect(page.getByRole('tab', { name: UI.unknownTab })).toHaveAttribute('aria-selected', 'true');
    const tabRowA = inboxRow(page, idA);
    const tabRowB = inboxRow(page, idB);
    await expect(tabRowA).toBeVisible();
    await expect(tabRowB).toBeVisible();
    await expect(tabRowA.getByText(UI.inactiveTag, { exact: true })).toBeVisible();
    await expect(tabRowA.getByText(UI.triageChip, { exact: true })).toHaveCount(0);
    await expect(tabRowB.getByText(UI.triageChip, { exact: true })).toBeVisible();
    await expect(tabRowB.getByText(UI.inactiveTag, { exact: true })).toHaveCount(0);
    const order = await rowHrefs(inboxList(page));
    const atB = order.indexOf(`/contacts/${idB}`);
    const atA = order.indexOf(`/contacts/${idA}`);
    expect(atB, `rows: ${JSON.stringify(order)}`).toBeGreaterThanOrEqual(0);
    expect(atB, `Needs review must sort above Inactive: ${JSON.stringify(order)}`).toBeLessThan(atA);
    expect(await inboxWireRow(api, 'unknown', idA)).toMatchObject({ needsTriage: false, inactive: true });
    const wireB = await inboxWireRow(api, 'unknown', idB);
    expect(wireB?.needsTriage).toBe(true);
    expect(wireB?.inactive).toBeUndefined();

    // (8) Another inbound text from A: unread in the inbox (All, Unread and
    //     Unknown).
    await textIn(request, phoneA, `still looking ${stamp}`);
    await expect
      .poll(async () => (await inboxWireRow(api, 'unread', idA))?.unreadCount ?? 0, { timeout: 15_000 })
      .toBe(1);
    // WORKLIST OR-17: the Unknown feed carries the same unread.
    await expect
      .poll(async () => (await inboxWireRow(api, 'unknown', idA))?.unreadCount ?? 0, { timeout: 15_000 })
      .toBe(1);
    expect(await inboxWireRow(api, 'unread', idA)).toMatchObject({ needsTriage: false, inactive: true });
    await page.goto(`${NEXT}/inbox`);
    await expect(inboxRow(page, idA).getByLabel(UI.unreadOne)).toBeVisible();
    await page.goto(`${NEXT}/inbox?filter=unread`);
    await expect(inboxRow(page, idA).getByLabel(UI.unreadOne)).toBeVisible();
    await expect(inboxRow(page, idA).getByText(UI.inactiveTag, { exact: true })).toBeVisible();

    // (9) ...but NOT back in Identify these contacts (D5); B still is.
    await expect(async () => {
      const ids = await identifyIds(api);
      expect(ids).not.toContain(idA);
      expect(ids).toContain(idB);
    }).toPass({ timeout: 10_000 });
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(todayRow(page, phoneB)).toBeVisible();
    await expect(todayRow(page, phoneA)).toHaveCount(0);

    // (10) The inbound did not move the status (D9), and the header says so.
    expect(await readStatus(api, idA)).toBe('inactive');
    await page.goto(`${NEXT}/contacts/${idA}`);
    await expect(statusTrigger(page, UI.inactive)).toBeVisible();
    await expect(page.getByRole('heading', { name: UI.typeUnknownCard })).toBeVisible();
  });
});
