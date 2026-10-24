// e2e/tests/dashboard-next/today-checklist.spec.ts
//
// Today as the daily checklist (tracker #31; spec
// docs/superpowers/specs/2026-10-23-today-checklist-design.md sections 2, 4,
// 5, 6 and 9; plan PR39). Against the real backend on the hermetic lane:
//   1. the checklist reads top to bottom - Identify these contacts, Tours to
//      book, Quiet shares, Placements - with the exact subtitle and help
//      lines; a known contact's unread text is NOT on Today (Unreplied is
//      gone, the inbox still has it); the page is not "All caught up";
//   2. Quiet shares groups by property: the first property line is open on
//      first render, folds and reopens, and lists the person who replied
//      first, then the one who never did, each with the exact quiet text and
//      state tag, and no Interested / Not interested buttons;
//   3. a staff text sent from the contact page composer drops that person
//      off an OPEN Today page live (the last_reached_out_at stamp and its
//      contact.updated event), keeps the viewer's open property open, and
//      leaves the other person;
//   4. Tours to book: two requested tours appear on an OPEN Today page live
//      (the tour.updated create emit), oldest request first, and booking one
//      on the tour page removes it live.
//
// STATE. The lean world seeds no listing sends, tours or unknown contacts,
// so every Identify, Tours to book and Quiet shares row is this spec's own.
// Every test reseeds before and after: the after keeps planted quiet shares,
// requested tours and an unknown contact off later specs' Today pages.
// Quiet shares are planted with the hermetic /__dev/listing-send-fixture
// (sentAt in the past) and an AGED inbound with
// /__dev/extraction/message-fixture, polled until last_heard_from_at is set
// (the follow-up-tab.spec.ts pattern). The Placements row is the lean
// placement made stuck through /__dev/placements/:id/deadline-fixture, so it
// does not depend on the seed's dates. No seed file is edited (plan WI9).
//
// LIVE CHECKS. A watching Today tab waits for its event stream AND its first
// GET /api/today (build WORKLIST WL-20) and then proves that load rendered
// (a positive control) before the change is made, so a row can only arrive
// through a live event - never from a first load still in flight.
//
// "All caught up" itself is not driven here: the lean world always holds the
// stuck placement. Its rule (every checklist section empty and settled, At a
// glance ignored, withheld for an unavailable section and the fallback) is
// pinned by the dashboard Today tests (S5).
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import {
  createTenant,
  createUnitViaApi,
  daysAgo,
  escapeRegExp,
  heardAt,
  plantListedSend,
} from '../../support/followUpFixtures.js';
import { expectTodayReady, todayList, todaySection } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
/** The lean world's one placement (app/src/lib/seed/lean.ts IDS.placement). */
const LEAN_PLACEMENT = 'placement-0001';

/** Every accessible name and copy string this spec uses (spec 2, 2.2, 5.4,
 *  6.2, 6.3). If an as-built name differs, change it HERE only. */
const UI = {
  subtitle: "Clear every section above the line and today's checklist is done. New messages are in the Inbox.",
  identify: 'Identify these contacts',
  toursToBook: 'Tours to book',
  quietShares: 'Quiet shares',
  placements: 'Placements',
  identifyHelp:
    "We don't know yet who these are. Call each one; after about a week with no contact, mark them Inactive.",
  toursToBookHelp: 'Said yes to a property; the tour has no date yet. Oldest first.',
  quietSharesHelp:
    'Properties sent in the last 14 days. Replied and then went quiet for 2+ days, or never replied in 5+ days. A message or call from either side restarts the clock; sending another property does not.',
  peopleWaitingOn: (unitLabel: string): string => `People waiting on ${unitLabel}`,
  repliedQuiet: (n: number): string => `Replied, then quiet ${n} days`,
  repliedTag: 'Replied',
  noReplyQuiet: (n: number): string => `No reply in ${n} days`,
  noReplyTag: 'No reply yet',
  summaryBoth: '2 people: 1 replied, then quiet - 1 never replied',
  summaryRepliedOnly: '1 person: 1 replied, then quiet',
  newUnknown: 'New unknown contact',
  requestedToday: 'Requested today',
  allCaughtUp: 'All caught up',
  replyBox: 'Reply message',
  send: 'Send',
  timeline: 'Communications and activity',
  scheduleTour: 'Schedule tour',
  scheduleTourForm: 'Schedule tour form',
  dateAndTime: 'Date and time',
  confirmSchedule: 'Confirm schedule',
};

/** The server's TodayGroup values (spec 3). */
const TODAY_GROUPS = ['needs_you_now', 'identify', 'tours_to_book', 'tours_today', 'follow_ups', 'ai_suggestions'];

/** A window flag set on an open Today page; still set later = no reload. */
const NO_RELOAD = '__hcTodayChecklistNoReload';

type Tenant = Awaited<ReturnType<typeof createTenant>>;

interface TodayWireItem {
  group: string;
  refType: string;
  refId: string;
  who: string;
  why: string;
  urgency?: string;
  at?: string;
  unitLabel?: string;
}

interface QuietSharesWire {
  status: 'ok' | 'unavailable';
  properties?: Array<{ unitId: string; unitLabel: string; people: Array<{ contactId: string; state: string }> }>;
  truncated?: boolean;
}

interface TodayWire {
  items: TodayWireItem[];
  quietShares?: QuietSharesWire;
  toursToBook?: string;
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** GET /api/today, server truth. Throws on a non-200 so a failed read can
 *  never pass an absence check. */
async function readToday(api: APIRequestContext): Promise<TodayWire> {
  const res = await api.get(`${NEXT}/api/today`);
  if (res.status() !== 200) throw new Error(`GET /api/today: ${res.status()} ${await res.text()}`);
  return (await res.json()) as TodayWire;
}

/** The server's unit label for a unit createUnitViaApi made
 *  (formatAddress, app/src/lib/address.ts). */
function unitLabelOf(line1: string): string {
  return `${line1}, Atlanta, GA 30314`;
}

async function conversationIdOf(api: APIRequestContext, contactId: string): Promise<string> {
  const res = await api.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { conversation: { conversationId: string } }).conversation.conversationId;
}

interface QuietWorld {
  unitId: string;
  line1: string;
  unitLabel: string;
  /** Sent 6 days ago, never replied: No reply yet, quiet 6 days. */
  quiet: Tenant;
  /** Sent 5 days ago, replied 3 days ago: Replied, quiet 3 days. */
  replied: Tenant;
}

/** One property, two quiet shares on it (spec 6.1: 120 h for no_reply,
 *  48 h for replied, both past). */
async function plantQuietShares(api: APIRequestContext, stamp: string): Promise<QuietWorld> {
  const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
  const quiet = await createTenant(api, `Quietn${stamp}`);
  const replied = await createTenant(api, `Quietr${stamp}`);
  await plantListedSend(api, unitId, quiet.contactId, daysAgo(6));
  await plantListedSend(api, unitId, replied.contactId, daysAgo(5));
  const conversationId = await conversationIdOf(api, replied.contactId);
  const heard = daysAgo(3);
  const fixture = await api.post(`${NEXT}/__dev/extraction/message-fixture`, {
    data: { conversationId, body: 'Is it still open?', createdAt: heard, direction: 'inbound' },
  });
  expect(fixture.ok(), await fixture.text()).toBeTruthy();
  await expect
    .poll(async () => Date.parse((await heardAt(api, replied.contactId)) ?? ''), { timeout: 20_000 })
    .toBe(Date.parse(heard));
  return { unitId, line1, unitLabel: unitLabelOf(line1), quiet, replied };
}

/** POST /api/tours with NO scheduledAt: a requested tour (Tours to book). */
async function requestTour(api: APIRequestContext, tenantId: string, unitId: string): Promise<string> {
  const res = await api.post(`${NEXT}/api/tours`, { data: { tenantId, unitId, tourType: 'self_guided' } });
  expect(res.status(), await res.text()).toBe(201);
  const { tour } = (await res.json()) as { tour: { tourId: string; status: string; scheduledAt?: string } };
  expect(tour.status).toBe('requested');
  expect(tour.scheduledAt).toBeUndefined();
  return tour.tourId;
}

/** An (unknown, needs_review) contact: the triage partition's Identify row. */
async function createUnknownContact(api: APIRequestContext, firstName: string): Promise<string> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await api.post(`${NEXT}/api/contacts`, { data: { type: 'unknown', firstName, phone } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** Backdate the lean placement's stage so its DERIVED stuck row is on
 *  Placements whatever the seed's dates are. */
async function makeLeanPlacementStuck(api: APIRequestContext): Promise<void> {
  const res = await api.post(`${NEXT}/__dev/placements/${LEAN_PLACEMENT}/deadline-fixture`, {
    data: { stageEnteredAt: daysAgo(60) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** A second tab on Today, listening on the event stream, its first queue load
 *  landed, flagged for the no-reload check (the unknown-inactive.spec.ts
 *  idiom; WL-20 adds the /api/today wait). The caller still proves that load
 *  RENDERED with a positive control before it acts. */
async function openWatchingToday(page: Page): Promise<Page> {
  const today = await page.context().newPage();
  const streamOpen = today.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/events' && r.status() === 200,
  );
  const loaded = today.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/today' && r.status() === 200,
  );
  await today.goto(`${NEXT}/`);
  await expectTodayReady(today);
  await streamOpen;
  await loaded;
  await today.evaluate((k) => {
    (window as unknown as Record<string, unknown>)[k] = true;
  }, NO_RELOAD);
  return today;
}

async function expectNotReloaded(today: Page): Promise<void> {
  expect(
    await today.evaluate((k) => (window as unknown as Record<string, unknown>)[k], NO_RELOAD),
    'the Today page reloaded - the change was not live',
  ).toBe(true);
}

/** The top edge of a rendered list (sections stack in one column). */
async function topOf(list: Locator): Promise<number> {
  await expect(list).toBeVisible();
  const box = await list.boundingBox();
  if (box === null) throw new Error('a visible list has no box');
  return box.y;
}

/** A property line in Quiet shares: a button whose name starts with the
 *  street line (its accessible name is `<unitLabel>, <summary>`). */
function quietLine(page: Page, line1: string): Locator {
  return todaySection(page, UI.quietShares).getByRole('button', {
    name: new RegExp(`^${escapeRegExp(line1)}`),
  });
}

function peopleOn(page: Page, unitLabel: string): Locator {
  return page.getByRole('list', { name: UI.peopleWaitingOn(unitLabel), exact: true });
}

/** A Date's LOCAL components as a datetime-local value (steps.ts idiom). */
function localInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

test.describe('Today - the daily checklist (tracker #31)', () => {
  test.beforeEach(async ({ request }) => {
    await reseed(request);
  });
  test.afterEach(async ({ request }) => {
    await reseed(request);
  });

  test('reads top to bottom: Identify, Tours to book, Quiet shares, Placements; no Unreplied; not all caught up', async ({
    page,
    request,
  }) => {
    test.slow(); // a reseed each side, a quiet-share world, a tour, an inbound and two feeds
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const world = await plantQuietShares(api, stamp);
    const booker = await createTenant(api, `Booker${stamp}`);
    const tourId = await requestTour(api, booker.contactId, world.unitId);
    const unknownFirst = `Ident${stamp}`;
    const unknownId = await createUnknownContact(api, unknownFirst);
    await makeLeanPlacementStuck(api);

    // A KNOWN contact's unread text: before tracker #31 an Unreplied row.
    const bookerConversationId = await conversationIdOf(api, booker.contactId);
    const sms = await postInboundSms(request, {
      from: booker.phone,
      body: `When can I see it ${stamp}?`,
      messageSid: `SMtc${Date.now()}`,
    });
    expect(sms.status, sms.body).toBe(200);
    await expect
      .poll(
        async () => {
          const res = await api.get(`${NEXT}/api/inbox?filter=unread&limit=100`);
          if (!res.ok()) return 0;
          const { rows } = (await res.json()) as { rows: Array<{ contactId?: string; unreadCount: number }> };
          return rows.find((r) => r.contactId === booker.contactId)?.unreadCount ?? 0;
        },
        { timeout: 15_000, message: 'the inbound never made the booker thread unread' },
      )
      .toBeGreaterThan(0);

    // Server truth.
    const wire = await readToday(api);
    for (const item of wire.items) expect(TODAY_GROUPS, JSON.stringify(item)).toContain(item.group);
    expect(wire.items.find((i) => i.refId === unknownId)).toMatchObject({
      group: 'identify',
      refType: 'contact',
      why: UI.newUnknown,
    });
    const booking = wire.items.find((i) => i.refId === tourId);
    expect(booking).toMatchObject({
      group: 'tours_to_book',
      refType: 'tour',
      why: world.unitLabel,
      unitLabel: world.unitLabel,
      urgency: UI.requestedToday,
    });
    expect(Number.isNaN(Date.parse(booking?.at ?? '')), `tours_to_book at: ${booking?.at}`).toBe(false);
    expect(wire.items.some((i) => i.group === 'follow_ups' && i.refId === LEAN_PLACEMENT)).toBe(true);
    expect(wire.toursToBook).toBe('ok');
    expect(wire.quietShares?.status).toBe('ok');
    // PR103: the wire carries no distinct-people count.
    expect(wire.quietShares).not.toHaveProperty('people');
    // The unread typed thread feeds ONLY the Inbox (spec 4): no row of any
    // group points at the booker or their thread, beyond their tour.
    expect(
      wire.items.filter(
        (i) => i.refType !== 'tour' && (i.refId === booker.contactId || i.refId === bookerConversationId),
      ),
    ).toEqual([]);

    // The page.
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(page.getByText(UI.subtitle, { exact: true })).toBeVisible();
    const identifyList = todayList(page, UI.identify);
    const toursList = todayList(page, UI.toursToBook);
    const quietList = todayList(page, UI.quietShares);
    const placementsList = todayList(page, UI.placements);
    const tops = [
      await topOf(identifyList),
      await topOf(toursList),
      await topOf(quietList),
      await topOf(placementsList),
    ];
    expect(new Set(tops).size, `section tops ${JSON.stringify(tops)}`).toBe(4);
    expect(tops, 'Identify, Tours to book, Quiet shares, Placements - top to bottom').toEqual(
      [...tops].sort((a, b) => a - b),
    );
    await expect(page.getByText(UI.identifyHelp, { exact: true })).toBeVisible();
    await expect(page.getByText(UI.toursToBookHelp, { exact: true })).toBeVisible();
    await expect(page.getByText(UI.quietSharesHelp, { exact: true })).toBeVisible();

    const identifyRow = identifyList.getByRole('link').filter({ hasText: unknownFirst });
    await expect(identifyRow).toHaveAttribute('href', `/contacts/${unknownId}`);
    await expect(identifyRow).toContainText(UI.newUnknown);
    const tourRow = toursList.locator(`a[href="/tours/${tourId}"]`);
    await expect(tourRow).toContainText(booker.firstName);
    await expect(tourRow).toContainText(world.unitLabel);
    await expect(tourRow).toContainText(UI.requestedToday);
    await expect(placementsList.locator(`a[href="/placements/${LEAN_PLACEMENT}"]`)).toBeVisible();

    // Gone for good: Unreplied and the old Placements heading; and the page
    // is not done while the checklist has rows.
    await expect(page.getByRole('heading', { name: /^Unreplied/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Follow-ups due/ })).toHaveCount(0);
    await expect(page.getByText(UI.allCaughtUp, { exact: true })).toHaveCount(0);
    // The booker's unread text is on no Today row (their tour row links the tour).
    await expect(page.locator(`a[href="/contacts/${booker.contactId}"]`)).toHaveCount(0);
    await expect(page.locator(`a[href="/conversations/${bookerConversationId}"]`)).toHaveCount(0);
  });

  test('Quiet shares: one line per property, the first open; the replied person first, then the one who never replied', async ({
    page,
  }) => {
    test.slow();
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const w = await plantQuietShares(api, stamp);

    const wire = await readToday(api);
    expect(wire.quietShares?.status).toBe('ok');
    // PR103: the wire carries no distinct-people count.
    expect(wire.quietShares).not.toHaveProperty('people');
    expect(
      wire.quietShares?.properties?.map((p) => [p.unitId, p.unitLabel, p.people.map((x) => [x.contactId, x.state])]),
    ).toEqual([[w.unitId, w.unitLabel, [[w.replied.contactId, 'replied'], [w.quiet.contactId, 'no_reply']]]]);

    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    // PR102: the heading is the bare label - no count.
    await expect(page.getByRole('heading', { name: UI.quietShares, exact: true })).toBeVisible();
    await expect(page.getByText(UI.quietSharesHelp, { exact: true })).toBeVisible();
    const line = quietLine(page, w.line1);
    // The first property in order is open when the section first renders.
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    await expect(line).toContainText(UI.summaryBoth);
    const people = peopleOn(page, w.unitLabel);
    const rows = people.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(w.replied.name);
    await expect(rows.nth(0).getByText(UI.repliedQuiet(3), { exact: true })).toBeVisible();
    await expect(rows.nth(0).getByText(UI.repliedTag, { exact: true })).toBeVisible();
    await expect(rows.nth(0).getByRole('link')).toHaveAttribute('href', `/contacts/${w.replied.contactId}`);
    await expect(rows.nth(1)).toContainText(w.quiet.name);
    await expect(rows.nth(1).getByText(UI.noReplyQuiet(6), { exact: true })).toBeVisible();
    await expect(rows.nth(1).getByText(UI.noReplyTag, { exact: true })).toBeVisible();
    await expect(rows.nth(1).getByRole('link')).toHaveAttribute('href', `/contacts/${w.quiet.contactId}`);
    // No Interested / Not interested on Today (spec 6.2).
    await expect(todaySection(page, UI.quietShares).getByRole('button', { name: /interested/i })).toHaveCount(0);

    // The line folds and reopens in place.
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    await expect(people).toHaveCount(0);
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    await expect(rows).toHaveCount(2);

    // Phone width: the open section does not push Today sideways.
    await page.setViewportSize(NARROW_360);
    await expect(rows).toHaveCount(2);
    await expectNoHorizontalOverflow(page, 'Today with an open quiet share at 360px');
    await page.setViewportSize(WIDE_RESTORE);
  });

  test('a staff text from the contact page drops that person off an open Today page, live', async ({ page }) => {
    test.slow();
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const w = await plantQuietShares(api, stamp);

    const today = await openWatchingToday(page);
    const people = peopleOn(today, w.unitLabel);
    // The positive control: the first load rendered both people.
    await expect(people.getByRole('listitem')).toHaveCount(2);

    // A staff text through the contact page composer: POST
    // /api/conversations/:id/messages, the W1 writer (spec 7.3).
    await page.bringToFront();
    await page.goto(`${NEXT}/contacts/${w.quiet.contactId}`);
    const body = `Still interested in ${w.line1}? ${stamp}`;
    await page.getByRole('textbox', { name: UI.replyBox }).fill(body);
    const send = page.getByRole('button', { name: UI.send, exact: true });
    await expect(send).toBeEnabled({ timeout: 20_000 });
    await send.click();
    await expect(page.getByRole('region', { name: UI.timeline }).getByText(body)).toBeVisible({ timeout: 15_000 });

    // Server truth: the person left Quiet shares; the other stays.
    await expect
      .poll(
        async () => {
          const qs = (await readToday(api)).quietShares;
          return qs?.status === 'ok' ? (qs.properties ?? []).flatMap((p) => p.people.map((x) => x.contactId)) : null;
        },
        { timeout: 15_000, message: 'the staff text never took the person off Quiet shares' },
      )
      .toEqual([w.replied.contactId]);
    // Outbound never moves last heard from (spec 7.1).
    expect(await heardAt(api, w.quiet.contactId)).toBeUndefined();

    // The open Today page dropped them WITHOUT a reload, kept the viewer's
    // open property open, and re-counted.
    await today.bringToFront();
    await expect(people.getByRole('listitem')).toHaveCount(1);
    await expect(people.getByRole('listitem').filter({ hasText: w.quiet.name })).toHaveCount(0);
    await expect(people.getByRole('listitem')).toContainText(w.replied.name);
    await expect(quietLine(today, w.line1)).toHaveAttribute('aria-expanded', 'true');
    await expect(quietLine(today, w.line1)).toContainText(UI.summaryRepliedOnly);
    // PR102: no heading count; the one listitem above is the live drop-off.
    await expect(today.getByRole('heading', { name: UI.quietShares, exact: true })).toBeVisible();
    await expectNotReloaded(today);
    await today.close();
  });

  test('Tours to book: requested tours appear live, oldest request first, and a booked one leaves live', async ({
    page,
  }) => {
    test.slow();
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
    const first = await createTenant(api, `Bookfirst${stamp}`);
    const second = await createTenant(api, `Booksecond${stamp}`);

    const today = await openWatchingToday(page);
    // WL-20: the positive control - the first load RENDERED (lean placement-0001
    // is always a derived stuck row) - and only then the empty Tours to book.
    await expect(todayList(today, UI.placements)).toBeVisible();
    const list = todayList(today, UI.toursToBook);
    await expect(list).toHaveCount(0);

    const firstTour = await requestTour(api, first.contactId, unitId);
    const secondTour = await requestTour(api, second.contactId, unitId);

    // Both appear on the OPEN page (POST /api/tours emits tour.updated, PR16).
    await expect(list.getByRole('link')).toHaveCount(2);
    const hrefs = await list.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs, 'oldest request first').toEqual([`/tours/${firstTour}`, `/tours/${secondTour}`]);
    const firstRow = list.locator(`a[href="/tours/${firstTour}"]`);
    await expect(firstRow).toContainText(first.firstName);
    await expect(firstRow).toContainText(unitLabelOf(line1));
    await expect(firstRow).toContainText(UI.requestedToday);
    await expect(today.getByText(UI.toursToBookHelp, { exact: true })).toBeVisible();
    await expectNotReloaded(today);

    // Book the first through the tour page's Schedule tour form (3 days out,
    // so it is not a Tours today row either).
    await page.bringToFront();
    await page.goto(`${NEXT}/tours/${firstTour}`);
    await page.getByRole('button', { name: UI.scheduleTour }).click();
    const form = page.getByRole('form', { name: UI.scheduleTourForm });
    await expect(form).toBeVisible();
    const when = new Date(Date.now() + 3 * 86_400_000);
    when.setHours(10, 0, 0, 0);
    await form.getByLabel(UI.dateAndTime).fill(localInput(when));
    await page.getByRole('button', { name: UI.confirmSchedule }).click();
    await expect(
      page.locator('header').filter({ hasText: 'Tour -' }).getByText('Scheduled', { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Server truth, then the open page - no reload.
    await expect
      .poll(
        async () => (await readToday(api)).items.filter((i) => i.group === 'tours_to_book').map((i) => i.refId),
        { timeout: 15_000 },
      )
      .toEqual([secondTour]);
    await today.bringToFront();
    await expect(list.getByRole('link')).toHaveCount(1);
    await expect(list.locator(`a[href="/tours/${firstTour}"]`)).toHaveCount(0);
    await expectNotReloaded(today);
    await today.close();
  });
});
