// Sam's improvements item #17 (spec docs/superpowers/specs/2026-09-25-inbox-rows-
// timestamps-design.md, section 7.3): a last-activity time on every inbox row,
// page size from ?limit=, auto-load on scroll, page one and the scroll position
// surviving a live update and the back button, and the refresh-failure banner.
//
// Hermetic e2e:session only. Every test RESEEDS first (and after, so the unread
// rows it mints never poison a later spec's "nothing unread" baseline) and mints
// its parties with run-unique numbers. A minted party is a STUB CONTACT row
// named by its formatted phone: the fake registers a persona only, and the
// app's inbound pipeline captures a `type:'unknown'` stub contact for a number
// it has never seen, so the row is a contact row carrying the Needs triage
// chip. Rows are therefore found by the formatted phone, never by the persona
// label, and nothing here asserts a row's kind or the shape of its href.
//
// The lean world alone renders FOUR inbox rows (app/src/lib/seed/lean.ts, all
// 2026-06-01 UTC): two one-to-one contact rows, Tasha (14:05) and Dario
// (13:20, the seed's OLDEST conversation), and two multi-party rows, the group
// text (13:45) and the connecting relay group (13:30). Every minted party is
// newer than all four. Under filter=all only the contact rows are paged: page
// one at ?limit=N holds the N newest contact rows (all of them, when fewer)
// PLUS both multi-party rows, and a cursor page holds contact rows only. The
// client sorts every rendered row newest first, so Dario's row is the LAST
// row, below the multi-party rows, and at a small limit it arrives on the last
// page. The counts below say "+ Tasha + Dario" for the seeded contacts and
// "+ 2" for the multi-party rows.
//
// Minted numbers are +1 555 <block><4 stamp digits><2-digit index>. The block
// digit (6-9) is never 0, so a minted number can never collide with the lean
// seed's +1555010000x contacts, the fake's +155501990xx ad-hoc range or the app
// number, and each mint CALL within a test takes its own block, so two calls in
// one test can never mint the same number.
//
// Request-log assertions count FINISHED inbox page requests (StrictMode issues
// and aborts one extra head read on every mount; an aborted request never
// reaches `requestfinished`). networkidle is never awaited: the SSE stream is
// an open request, so it would never settle. Counts of head reads are never
// asserted exactly: any later live event adds one; the ORDER (a head read
// first, cursor requests only after it) is the claim.
//
// The auto-load DISARM on an empty page with a cursor (the Unknown tab's budget
// exit) is proven in the unit tests only; the lean world cannot cheaply produce
// that server state. A long name with a placement tag cannot be minted through
// the fake; the 768px band with such a row is checked in the live self-QA.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:9001';
const ORIGIN_SECRET = process.env['CF_ORIGIN_SECRET'] ?? 'dev-placeholder-not-a-secret';
const apiHeaders = { 'x-origin-verify': ORIGIN_SECRET };

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** "+15551234567" -> "(555) 123-4567", the app's display of a stub contact's number. */
function displayOf(e164: string): string {
  const d = e164.replace(/\D/g, '').slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** A run-unique E.164 number in `block` (6-9; see the header). */
function mintNumber(block: number, stamp: string, i: number): string {
  if (!Number.isInteger(block) || block < 6 || block > 9) throw new Error(`mint block ${block} is not 6-9`);
  if (!Number.isInteger(i) || i < 0 || i > 99) throw new Error(`mint index ${i} is not 0-99`);
  return `+1555${block}${stamp.slice(-4)}${String(i).padStart(2, '0')}`;
}

/** Mint `n` fresh parties in `block`, each with one inbound text, newest last.
 *  Returns their E.164 numbers in send order. */
async function seedParties(request: APIRequestContext, n: number, stamp: string, block: number): Promise<string[]> {
  const numbers: string[] = [];
  for (let i = 0; i < n; i++) {
    const number = mintNumber(block, stamp, i);
    await registerParty(request, { label: `Party ${stamp} ${block}-${i}`, role: 'tenant', number });
    await sendAsParty(request, { from: number, body: `hello from party ${block}-${i}` });
    numbers.push(number);
  }
  return numbers;
}

interface SeenInboxRequest {
  url: string;
  cursor: boolean;
}
/** Every FINISHED page request to GET /api/inbox (not the badge count, not a
 *  read POST), in completion order. */
function trackInboxRequests(page: Page): SeenInboxRequest[] {
  const seen: SeenInboxRequest[] = [];
  page.on('requestfinished', (req) => {
    if (req.method() !== 'GET') return;
    const u = new URL(req.url());
    if (!u.pathname.endsWith('/api/inbox')) return;
    seen.push({ url: req.url(), cursor: u.searchParams.has('cursor') });
  });
  return seen;
}

/** After `mark`: the first finished request is a head read (so every cursor
 *  request that follows came from a chain rebuilt after it), and at least
 *  one cursor request followed when `expectCursors` says so. */
function expectHeadFirst(seen: SeenInboxRequest[], mark: number, where: string, expectCursors: boolean): void {
  const after = seen.slice(mark);
  expect(after.length, `${where}: requests after the mark`).toBeGreaterThan(0);
  expect(after[0]?.cursor, `${where}: first request is a head read`).toBe(false);
  expect(after.some((r) => r.cursor), `${where}: cursor requests followed`).toBe(expectCursors);
}

const inboxList = (page: Page): Locator => page.getByRole('list', { name: 'Conversations', exact: true });
const rows = (page: Page): Locator => inboxList(page).getByRole('listitem');
const rowFor = (page: Page, number: string): Locator => page.getByRole('link', { name: displayOf(number) });
const loadMore = (page: Page): Locator => page.getByRole('button', { name: 'Load more' });
const scroller = (page: Page): Locator => page.locator('main');

async function scrollToBottom(page: Page): Promise<void> {
  await scroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

async function scrollToTop(page: Page): Promise<void> {
  await scroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
}

/** The rows' link targets, sorted: WHICH rows are on screen, order aside. */
async function rowHrefs(page: Page): Promise<string[]> {
  return inboxList(page)
    .getByRole('link')
    .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? '').sort());
}

test.describe('inbox rows and timestamps', () => {
  test.beforeEach(async ({ page, request }) => {
    await reseed(request);
    await devLogin(page);
  });
  test.afterEach(async ({ request }) => {
    await reseed(request);
  });

  test('1. every row shows its last-activity time', async ({ page, request }) => {
    const stamp = `${Date.now()}`.slice(-6);
    const [number] = await seedParties(request, 1, stamp, 9);
    await page.goto(`${NEXT}/inbox`);
    const fresh = rowFor(page, number!);
    await expect(fresh).toBeVisible({ timeout: 15_000 });

    // The row's <time> carries the exact instant the API reports and a
    // clock-time label (the inbound is "today").
    const res = await page.request.get(`${APP}/api/inbox?limit=100`, { headers: apiHeaders });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { rows: { phone?: string; lastActivityAt: string }[] };
    const apiRow = body.rows.find((r) => r.phone === number);
    expect(apiRow).toBeDefined();
    const time = fresh.locator('time');
    await expect(time).toHaveAttribute('datetime', apiRow!.lastActivityAt);
    await expect(time).toHaveText(/^\d{1,2}:\d{2} [AP]M$/);

    // The lean seed's June rows show a date (year-agnostic so the spec survives
    // January): Tasha's 1:1 and the group text.
    await expect(page.getByRole('link', { name: /Tasha Nguyen/ }).locator('time')).toHaveText(
      /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/,
    );
    const groupRow = page.getByRole('link', { name: /Group text/ }).first();
    await expect(groupRow.locator('time')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  });

  test('2. paging, then a live update refreshes page one and auto-load rebuilds the rest', async ({ page, request }) => {
    test.slow();
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 3, stamp, 9);
    const seen = trackInboxRequests(page);
    await page.goto(`${NEXT}/inbox?limit=2`);

    // At limit=2 the four-row page one leaves the sentinel in view, so
    // auto-load chains to the end as soon as the page loads (spec 5.2, by
    // design at a tiny limit): 3 parties + Tasha + Dario = 5 contacts in pages
    // of 2, 2, 1, + 2 multi-party rows on page one = 7.
    await expect(rows(page)).toHaveCount(7, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);
    expect(seen.filter((r) => r.cursor).length).toBeGreaterThan(0);

    // A live update: a fourth party texts. The list is never detached, the
    // head read replaces page one, and auto-load rebuilds the pages from the
    // fresh chain: 4 parties + Tasha + Dario = 6 contacts in pages of 2, 2, 2,
    // + 2 = 8.
    const listHandle = await page.getByRole('list', { name: 'Conversations' }).elementHandle();
    const mark = seen.length;
    const [number4] = await seedParties(request, 1, stamp, 8);
    await expect(rowFor(page, number4!)).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(8, { timeout: 15_000 });
    // SC-13: the refresh put the new row at the top.
    await expect(rows(page).first().getByRole('link')).toHaveText(new RegExp(displayOf(number4!).replace(/[()]/g, '\\$&')));
    await expect(loadMore(page)).toHaveCount(0);
    expect(await listHandle!.evaluate((el) => el.isConnected)).toBe(true);
    expectHeadFirst(seen, mark, 'after the inbound at limit=2', true);

    // At the DEFAULT limit a page one holds everything (6 contacts + 2 = 8): a
    // further inbound adds its row at the top (7 contacts + 2 = 9), removes
    // nothing, and issues no cursor request.
    await page.goto(`${NEXT}/inbox`);
    await expect(rows(page)).toHaveCount(8, { timeout: 15_000 });
    const mark2 = seen.length;
    const [number5] = await seedParties(request, 1, stamp, 7);
    await expect(rowFor(page, number5!)).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(9);
    await expect(rows(page).first().getByRole('link')).toHaveText(new RegExp(displayOf(number5!).replace(/[()]/g, '\\$&')));
    await page.waitForTimeout(1000);
    expect(seen.slice(mark2).filter((r) => r.cursor)).toHaveLength(0);
  });

  test('3. the back button restores the list and the scroll position, then reconciles', async ({ page, request }) => {
    test.slow();
    await page.setViewportSize({ width: 1280, height: 400 });
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 6, stamp, 9);
    const seen = trackInboxRequests(page);

    // Everything fits in page one at limit=10: 6 parties + Tasha + Dario = 8
    // contacts (fewer than 10), + 2 = 10. The LAST row is Dario's (the oldest),
    // so both clicks below open his contact page.
    await page.goto(`${NEXT}/inbox?limit=10`);
    await expect(rows(page)).toHaveCount(10, { timeout: 15_000 });
    await scrollToBottom(page);
    const saved = await scroller(page).evaluate((el) => el.scrollTop);
    expect(saved).toBeGreaterThan(0);
    // SC-13: which rows are shown, so "the same rows" below is not a count only.
    const shown = await rowHrefs(page);

    const mark = seen.length;
    await rows(page).last().getByRole('link').click();
    await page.waitForURL(/\/(contacts|conversations)\//);
    // The URL changes inside the click, but React Router 7 renders the new
    // route as a TRANSITION that commits later. A back press before that commit
    // supersedes it: the Inbox never unmounts, so nothing is saved, restored or
    // reconciled and the checks below pass or fail vacuously. The list leaving
    // the DOM proves the route committed and the unmount save ran.
    await expect(inboxList(page)).toHaveCount(0);
    // The shell's scroll container keeps its offset across routes, so park it
    // at the top on the destination: then only the restore can bring `saved`
    // back, whatever the destination page's height.
    await scrollToTop(page);
    await page.goBack();
    await page.waitForURL(/\/inbox/);
    // Restored instantly: the rows are there and the position is back. A fresh
    // mount would sit at 0 behind a spinner.
    await expect(rows(page)).toHaveCount(10);
    const restored = await scroller(page).evaluate((el) => el.scrollTop);
    expect(Math.abs(restored - saved)).toBeLessThanOrEqual(8);
    expect(await rowHrefs(page), 'the restore shows the same rows').toEqual(shown);
    // A head read followed the return, and no cursor request did; the rows and
    // the position are unchanged once it settles (spec 7.3).
    await expect.poll(() => seen.slice(mark).filter((r) => !r.cursor).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(seen.slice(mark).filter((r) => r.cursor)).toHaveLength(0);
    await expect(rows(page)).toHaveCount(10);
    expect(await rowHrefs(page), 'the reconciled list holds the same rows').toEqual(shown);
    const settled = await scroller(page).evaluate((el) => el.scrollTop);
    expect(Math.abs(settled - saved)).toBeLessThanOrEqual(8);

    // The Option B trade, pinned deliberately: at limit=2 the restore shows all
    // rows instantly, then the head read rebuilds from page one and auto-load
    // reloads the rest (a head read FIRST, cursor requests only after it).
    // The 8 contacts page as 2, 2, 2, 2 (Tasha and Dario on the last page),
    // + 2 on page one = 10.
    await page.goto(`${NEXT}/inbox?limit=2`);
    await expect(rows(page)).toHaveCount(10, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);
    const mark2 = seen.length;
    await rows(page).last().getByRole('link').click();
    await page.waitForURL(/\/(contacts|conversations)\//);
    await expect(inboxList(page)).toHaveCount(0); // the route committed (see above)
    await page.goBack();
    await page.waitForURL(/\/inbox/);
    await expect(rows(page)).toHaveCount(10);
    await expect.poll(() => seen.slice(mark2).filter((r) => r.cursor).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(10, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0, { timeout: 15_000 });
    expectHeadFirst(seen, mark2, 'after the return at limit=2', true);
  });

  test('4. the time fits at phone width and in the tightest one-line band; an ordinary name is not ellipsized wide', async ({ page, request }) => {
    const stamp = `${Date.now()}`.slice(-6);
    const [number] = await seedParties(request, 1, stamp, 9);
    // A LONG NAME is minted through the app: create the contact FIRST (so the
    // inbound folds into a contact row named by it), then text from it. The
    // body shape is `ContactCreate` (dashboard/src/api/types.ts). Its number
    // takes its own block.
    const longNumber = mintNumber(8, stamp, 0);
    const created = await page.request.post(`${APP}/api/contacts`, {
      headers: apiHeaders,
      data: { type: 'tenant', firstName: 'Bartholomew', lastName: `Montgomery-Fitzgerald-Longname-${stamp}`, phone: longNumber },
    });
    expect(created.ok(), `create contact: ${created.status()}`).toBe(true);
    await registerParty(request, { label: `Long ${stamp}`, role: 'tenant', number: longNumber });
    await sendAsParty(request, { from: longNumber, body: 'a long name' });
    const longRow = page.getByRole('link', { name: /Bartholomew Montgomery-Fitzgerald-Longname/ });
    const longName = longRow.getByText(`Bartholomew Montgomery-Fitzgerald-Longname-${stamp}`, { exact: true });
    // A LONG PREVIEW (build review R2-1): a party whose inbound is about 300
    // characters. The preview is the whole latest message on one line, so its
    // max-content width dwarfs the row; the head must not yield its width to
    // it. Its number takes its own block.
    const longBodyNumber = mintNumber(7, stamp, 0);
    const longBody = 'Checking in about the two bedroom unit and the move in date. '.repeat(5).trim();
    await registerParty(request, { label: `Party ${stamp} 7-0`, role: 'tenant', number: longBodyNumber });
    await sendAsParty(request, { from: longBodyNumber, body: longBody });
    const longBodyRow = rowFor(page, longBodyNumber);
    const longBodyName = longBodyRow.getByText(displayOf(longBodyNumber), { exact: true });

    async function timeInsideRow(link: Locator, where: string): Promise<{ row: { x: number; y: number; width: number; height: number }; time: { x: number; y: number; width: number; height: number } }> {
      const li = link.locator('xpath=ancestor::li[1]');
      const row = await li.boundingBox();
      const time = await link.locator('time').boundingBox();
      expect(row, `${where}: row box`).not.toBeNull();
      expect(time, `${where}: time box`).not.toBeNull();
      expect(time!.width, `${where}: time has width`).toBeGreaterThan(0);
      expect(time!.x + time!.width, `${where}: time inside row (right edge)`).toBeLessThanOrEqual(row!.x + row!.width + 1);
      expect(time!.x, `${where}: time inside row (left edge)`).toBeGreaterThanOrEqual(row!.x - 1);
      expect(time!.y, `${where}: time inside row (top edge)`).toBeGreaterThanOrEqual(row!.y - 1);
      return { row: row!, time: time! };
    }

    await page.setViewportSize(NARROW_360);
    await page.goto(`${NEXT}/inbox`);
    const stubRow = rowFor(page, number!);
    await expect(stubRow).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalOverflow(page, 'inbox at 360');
    const narrow = await timeInsideRow(stubRow, 'narrow');
    // Two-line layout: the time sits in the row's top half.
    expect(narrow.time.y + narrow.time.height).toBeLessThanOrEqual(narrow.row.y + narrow.row.height / 2 + 2);

    // The tightest one-line band: sidebar open, content about 480px. Both the
    // stub row (the Needs triage chip) and the long-name contact row (the
    // shrinking head, spec 5.4) must keep their time inside the row.
    await page.setViewportSize({ width: 768, height: 720 });
    await expect(stubRow).toBeVisible();
    await timeInsideRow(stubRow, 'one-line at 768 (stub)');
    await expect(longRow).toBeVisible();
    await timeInsideRow(longRow, 'one-line at 768 (long name)');
    // The name is the row's identity: beside a 300-character preview it keeps
    // a visible width (the head never shrinks below min(content, 45%)), and a
    // long name keeps a visible part under the cap.
    await expect(longBodyRow).toBeVisible({ timeout: 15_000 });
    expect(await longBodyName.evaluate((el) => el.clientWidth), 'one-line at 768 (300-char preview): name width').toBeGreaterThan(0);
    expect(await longName.evaluate((el) => el.clientWidth), 'one-line at 768 (long name): name width').toBeGreaterThan(0);

    await page.setViewportSize(WIDE_RESTORE);
    const tashaName = page.getByRole('link', { name: /Tasha Nguyen/ }).getByText('Tasha Nguyen', { exact: true });
    await expect(tashaName).toBeVisible();
    expect(await tashaName.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // ...and a 300-character preview does not ellipsize an ordinary name either
    // (Tasha's seeded preview is 72 characters, too short to press on it).
    expect(await longBodyName.evaluate((el) => el.scrollWidth <= el.clientWidth), 'wide (300-char preview): name not ellipsized').toBe(true);
  });

  test('5. a failed background refresh keeps the rows and shows a banner whose Retry clears it', async ({ page, request }) => {
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 1, stamp, 9);
    // 1 party + Tasha + Dario = 3 contacts, + 2 = 5.
    await page.goto(`${NEXT}/inbox`);
    await expect(rows(page)).toHaveCount(5, { timeout: 15_000 });

    // Fail HEAD reads only (no cursor in the query); leave the badge count alone.
    const failHead = (url: URL): boolean => url.pathname.endsWith('/api/inbox') && !url.searchParams.has('cursor');
    await page.route(failHead, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    const [number2] = await seedParties(request, 1, stamp, 8);
    const banner = page.getByRole('status').filter({ hasText: "Couldn't refresh the inbox." });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(5);
    await expect(rowFor(page, number2!)).toHaveCount(0);

    await page.unroute(failHead);
    await banner.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(rowFor(page, number2!)).toBeVisible();
    // 2 parties + Tasha + Dario = 4 contacts, + 2 = 6.
    await expect(rows(page)).toHaveCount(6);
  });

  test('6. auto-load does not chain at the group wall: one cursor request per scroll', async ({ page, request }) => {
    test.slow();
    await page.setViewportSize({ width: 1280, height: 400 });
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 35, stamp, 9);
    const seen = trackInboxRequests(page);

    // A 15-row page is about 850px (a 56.5px row pitch at this width, measured
    // 2026-09-25), taller than the viewport plus the 400px margin, so a
    // committed page pushes the sentinel out (spec 5.2).
    // 35 parties + Tasha + Dario = 37 contacts: pages of 15, 15, 7, + 2
    // multi-party rows on page one: 17, then 32, then 39. Pages one and two
    // are minted parties only, so they sort wholly above the group wall; on
    // page three the last five parties and Tasha sort above it and Dario (the
    // oldest row) below it.
    await page.goto(`${NEXT}/inbox?limit=15`);
    await expect(rows(page)).toHaveCount(17, { timeout: 15_000 });
    const mark = seen.length;
    await scrollToBottom(page);
    await expect(rows(page)).toHaveCount(32, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(seen.slice(mark).filter((r) => r.cursor)).toHaveLength(1);
    await expect(rows(page)).toHaveCount(32);

    await scrollToBottom(page);
    await expect(rows(page)).toHaveCount(39, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(seen.slice(mark).filter((r) => r.cursor)).toHaveLength(2);
  });
});
