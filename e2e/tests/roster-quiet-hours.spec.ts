// e2e/tests/roster-quiet-hours.spec.ts
//
// Quiet hours DEFER a roster change - they never drop it, and they never text
// people at 11pm because someone clicked a button (contact-rosters D7 / spec
// 6.5, plan Task 14). Two walks, both end to end against the real API:
//
//   1. THE DEFERRED OPEN. Inside the window the pre-open confirm is the REAL
//      three-button layout - [Cancel] [Send now anyway] [Open at <time>], the
//      DEFERRAL as the default - and taking that default opens NOTHING: no
//      thread, no text, and a pending banner saying when it will happen. Then
//      the operator overrides with "Send now anyway" and the intro really goes
//      out (proved against the fake-twilio thread store, never the deprecated
//      /__dev/outbox - worklist A12).
//
//   2. THE DEFERRED ADD, both ways it can end. Against a LIVE relay group: the
//      add defers (the person is deliberately NOT a member yet - membership
//      defers WITH the message), the operator cancels it, and the cancel leaves
//      a VISIBLE notice that survives until it is dismissed - after which a full
//      reload never brings it back. Then a second deferred add is advanced by
//      the poller seam (POST /__dev/roster-actions/tick) and really joins, with
//      the announcement reaching the group.
//
// TIMING CONTRACT (what makes this deterministic at ANY wall clock):
//   - The server evaluates quiet hours against its WALL CLOCK, so the only way
//     to make a confirm defer is to store a REAL window containing that clock -
//     which is what windowAroundNow() does (a 4-hour window centred on now, in
//     ORG-local time, so the host's own timezone is irrelevant). NOTHING here
//     asserts a wall-clock-dependent value: the rendered "Opens at 8:00 AM" is
//     matched by SHAPE, because the label is formatted in the browser's zone.
//   - The one instant that must be crossed - the pending row's dueAt - is
//     crossed by handing the tick an explicit `now`, never by waiting.
//
// LANE HYGIENE: the lean seed ships quiet hours OFF (every other spec is
// time-of-day independent). This file turns it on explicitly and puts it back -
// defensively in beforeAll and always in afterAll. Nothing here reseeds: every
// contact / property / tour is minted fresh per test (dashboard-next dialect,
// worklist A15), so the lean world stays byte-stable.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { driveConnectingGroupToOpen } from '../fixtures/relayConnect.js';
import { listThreads, type FakeThread } from '../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../support/today.js';
import { NARROW_360, WIDE_RESTORE } from '../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** PUT /api/settings is admin-only; dev.ts maps this email to role 'admin'. */
const ADMIN_EMAIL = 'founder@example.com';

/** The org timezone the backend evaluates the window in (settingsRepo default).
 *  Every window here is computed in THIS zone, never the host's. */
const ORG_TZ = 'America/New_York';

/** The product default window with the feature OFF - the lean seed's posture,
 *  and what this file restores. */
const QUIET_OFF = {
  quietHoursEnabled: false,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  // RESTORE the zone too. `windowAroundNow()` writes `timezone`, the settings
  // route is a PATCH (`if ('timezone' in b)`), and afterAll runs this - so
  // without it the spec permanently overwrites lane settings for every later
  // spec in the run. Inert today only because ORG_TZ equals the repo default;
  // it becomes a cross-spec landmine the moment anyone changes ORG_TZ to
  // reproduce a bug. Caught by adversarial review 2026-08-23.
  timezone: 'America/New_York',
} as const;

interface QuietPatch {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  /**
   * PINNED, not assumed. This spec formats its window as HH:MM in ORG_TZ, but
   * the SERVER evaluates those strings in `settings.timezone` - and nothing
   * here used to write that field, so the two only agreed by default.
   *
   * During the 2026-08-05 S6 gate runs the server-computed `dueAt` landed ~2h
   * off the NY reading of the stored window (end `17:0x` NY -> expected
   * `21:0xZ`, observed `23:0xZ`). Both deferrals still fired, so nothing failed
   * for that reason - but a window written in one zone and evaluated in another
   * puts `now` near the effective EDGE, and a slow run could flip `isQuietTime`
   * mid-test and turn a deferral flow into an immediate send.
   *
   * Writing the zone in the same PUT removes the assumption instead of chasing
   * where the skew came from (never identified; candidates were a stale lane
   * settings row or another spec's write racing in).
   * See docs/issues/roster-quiet-hours-e2e-timezone-skew.md.
   */
  timezone: string;
}

/** "HH:MM" of `at` in the ORG timezone (not the host's) - the shape the API
 *  stores. Mirrors scenarios/quiet-hours.spec.ts. */
function orgLocalHhMm(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ORG_TZ,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const raw = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const hh = raw === '24' ? '00' : raw; // some ICU builds render midnight as 24
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

/** A REAL quiet window centred on the wall clock: [now-2h, now+2h] in org-local
 *  time. Wide enough that the whole test runs inside it. Never zero-length (the
 *  API rejects start === end). */
function windowAroundNow(): QuietPatch {
  const base = Date.now();
  return {
    quietHoursEnabled: true,
    quietHoursStart: orgLocalHhMm(new Date(base - 2 * 3_600_000)),
    quietHoursEnd: orgLocalHhMm(new Date(base + 2 * 3_600_000)),
    // Same zone the HH:MM strings above were formatted in - see QuietPatch.
    timezone: ORG_TZ,
  };
}

/** Store a quiet-hours patch through the REAL admin API. The context signs in
 *  as the founder first (requireRole('admin')); it is deliberately NOT the
 *  page's context, so the page keeps its own dev-user session. */
async function putQuietHours(
  api: APIRequestContext,
  patch: QuietPatch | typeof QUIET_OFF,
): Promise<void> {
  const login = await api.post(`${NEXT}/auth/dev-login`, { data: { email: ADMIN_EMAIL } });
  expect(login.ok(), await login.text()).toBeTruthy();
  const res = await api.put(`${NEXT}/api/settings`, { data: patch });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164 - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  firstName: string;
  phone: string;
  /** The display name every roster surface renders for this contact. */
  name: string;
}

async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const lastName = 'Qhours';
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type, firstName, lastName, phone, ...(type === 'tenant' && { voucherSize: 2 }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, phone, name: `${firstName} ${lastName}` };
}

/** An AVAILABLE property owned by `landlordId`. */
async function createAvailableUnit(request: APIRequestContext, landlordId: string): Promise<string> {
  const line1 = `${`${Date.now()}`.slice(-6)} Quiet Roster Way NW`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      accepted_authorities: ['atlanta_housing'],
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  return unitId;
}

/** Put a contact on the PROPERTY's roster (the tour then defaults to them). */
async function rosterOnProperty(
  request: APIRequestContext,
  unitId: string,
  contactId: string,
  role: 'landlord' | 'pm' | 'owner' | 'other',
  primaryContact = false,
): Promise<void> {
  const res = await request.post(`${NEXT}/api/units/${unitId}/contacts`, {
    data: { contactId, role, primaryContact },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** A tour via the real route. Timeless ('requested') - no ladder is armed and
 *  no relay group exists, so the roster starts as a PLAN. */
async function createTour(
  request: APIRequestContext,
  data: { tenantId: string; unitId: string; tourType: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/tours`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
}

async function getTour(
  request: APIRequestContext,
  tourId: string,
): Promise<{ groupThreadId?: string }> {
  const res = await request.get(`${NEXT}/api/tours/${tourId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { groupThreadId?: string } }).tour;
}

/** The tour's roster payload - the same body the card renders, used here only
 *  to read a pending row's `dueAt` (the instant the tick must cross). */
async function getRoster(
  request: APIRequestContext,
  tourId: string,
): Promise<{ pending: Array<{ actionId: string; kind: string; dueAt: string }> }> {
  const res = await request.get(`${NEXT}/api/tours/${tourId}/roster`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { pending: Array<{ actionId: string; kind: string; dueAt: string }> };
}

/** SETUP ONLY: open the tour's relay group through the API with quiet hours OFF,
 *  and drive the connect handshake so the thread is really OPEN. The subject of
 *  test 2 is the deferred ADD, not the open. */
async function openGroupForSetup(request: APIRequestContext, tourId: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/tours/${tourId}/relay`, { data: {} });
  expect(res.ok(), await res.text()).toBeTruthy();
  const conversationId = ((await res.json()) as { conversation: { conversationId: string } })
    .conversation.conversationId;
  const conv = await request.get(`${NEXT}/api/conversations/${conversationId}`);
  expect(conv.ok(), await conv.text()).toBeTruthy();
  const { conversation } = (await conv.json()) as { conversation: { status?: string } };
  if (conversation.status === 'connecting') {
    await driveConnectingGroupToOpen(request, conversationId);
  }
  return conversationId;
}

/** One party's fake-twilio thread, or undefined when nothing was ever sent to
 *  that number - which is exactly what "deferred, not sent" looks like. */
function threadFor(threads: FakeThread[], phone: string): FakeThread | undefined {
  return threads.find((t) => t.partyNumber === phone);
}

/** Poll the fake until an OUTBOUND message to `phone` contains `fragment`. */
async function expectSentTo(
  request: APIRequestContext,
  phone: string,
  fragment: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const thread = threadFor(await listThreads(request), phone);
        return (thread?.messages ?? []).some(
          (m) => m.direction === 'outbound' && (m.body ?? '').includes(fragment),
        );
      },
      { timeout: 30_000, message: `nothing containing "${fragment}" ever reached ${phone}` },
    )
    .toBe(true);
}

/** The card's pending list ("Joins at ..." / "Opens at ..." rows). */
function pendingList(page: Page): Locator {
  return page.getByRole('list', { name: 'Waiting for quiet hours to end' });
}

/** The card's notice list (a resolved deferral that never happened). */
function noticeList(page: Page): Locator {
  return page.getByRole('list', { name: 'Roster notices' });
}

// Defensive restore BEFORE the file runs (a crashed earlier run could have left
// the window on) and unconditional restore after it.
test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    await putQuietHours(api, QUIET_OFF);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    await putQuietHours(api, QUIET_OFF);
  } finally {
    await api.dispose();
  }
});

test.describe('Roster changes during quiet hours', () => {
  test('an open WAITS for the window to end - until the operator sends it anyway', async ({
    page,
    request,
  }) => {
    test.slow(); // a full build-a-world walk plus a real relay provision.
    await putQuietHours(request, QUIET_OFF);
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Qown${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const tenant = await createContact(req, 'tenant', `Qten${stamp}`);
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'landlord_led',
    });

    // The window opens AFTER the world is built, so nothing in setup defers.
    await putQuietHours(request, windowAroundNow());

    // --- 1. The confirm is the three-button layout, stacked at 360px ---------
    await page.setViewportSize(NARROW_360);
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(page.getByRole('list', { name: 'Roster' }).getByText(tenant.name)).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open relay group' }).click();
    const confirm = page.getByRole('dialog', { name: 'Open the relay group?' });
    await expect(confirm).toBeVisible({ timeout: 20_000 });

    // The clock label is formatted in the BROWSER's zone, so match its shape -
    // never a wall-clock-dependent literal.
    const cancel = confirm.getByRole('button', { name: 'Cancel' });
    const sendNow = confirm.getByRole('button', { name: 'Send now anyway' });
    const deferBtn = confirm.getByRole('button', { name: /^Open at / });
    await expect(deferBtn).toBeVisible();
    await expect(confirm.getByText(/^Quiet hours until .+ - this goes out then/)).toBeVisible();

    // Spec 6.7: below 860px the footer stacks FULL WIDTH with the DEFAULT on top.
    const cancelBox = (await cancel.boundingBox())!;
    const sendNowBox = (await sendNow.boundingBox())!;
    const deferBox = (await deferBtn.boundingBox())!;
    expect(deferBox.y, 'the deferral is the top (default) button').toBeLessThan(sendNowBox.y);
    expect(sendNowBox.y, 'Cancel stays last').toBeLessThan(cancelBox.y);
    expect(deferBox.width).toBeGreaterThan(240);
    expect(Math.round(deferBox.width)).toBe(Math.round(cancelBox.width));

    // --- 2. Taking the default opens NOTHING --------------------------------
    await page.setViewportSize(WIDE_RESTORE);
    await deferBtn.click();
    await expect(confirm).toHaveCount(0, { timeout: 20_000 });
    await expect(pendingList(page).getByText(/^Opens at .+ - quiet hours$/)).toBeVisible({
      timeout: 20_000,
    });
    // No thread was provisioned...
    expect((await getTour(req, tourId)).groupThreadId).toBeUndefined();
    // ...and nobody was texted (a fresh number with no thread at all).
    const quietThreads = await listThreads(req);
    expect(threadFor(quietThreads, tenant.phone)).toBeUndefined();
    expect(threadFor(quietThreads, owner.phone)).toBeUndefined();

    // --- 3. "Send now anyway" overrides the window --------------------------
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open relay group' }).click();
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.getByRole('button', { name: 'Send now anyway' }).click();
    await expect(confirm).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(async () => (await getTour(req, tourId)).groupThreadId, {
        timeout: 30_000,
        message: 'the forced open never linked a group thread',
      })
      .not.toBeUndefined();
    const conversationId = (await getTour(req, tourId)).groupThreadId as string;
    const conv = await req.get(`${NEXT}/api/conversations/${conversationId}`);
    expect(conv.ok(), await conv.text()).toBeTruthy();
    const { conversation } = (await conv.json()) as { conversation: { status?: string } };
    if (conversation.status === 'connecting') {
      await driveConnectingGroupToOpen(req, conversationId);
    }
    // The intro names everyone it connected - proof of send, from the fake's
    // own thread store (A12).
    await expectSentTo(req, tenant.phone, owner.firstName);
    await expectSentTo(req, owner.phone, tenant.firstName);
    // The pending row is retired by the open it was waiting for.
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(page.getByRole('list', { name: 'Roster' }).getByText(tenant.name)).toBeVisible({
      timeout: 20_000,
    });
    await expect(pendingList(page)).toHaveCount(0);
  });

  test('an add WAITS - cancel leaves a notice that dismisses for good, and the poller applies the next one', async ({
    page,
    request,
  }) => {
    test.slow(); // build-a-world + a real relay provision + a poller tick.
    await putQuietHours(request, QUIET_OFF);
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Qown2${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const pm = await createContact(req, 'landlord', `Qpm2${stamp}`);
    const tenant = await createContact(req, 'tenant', `Qten2${stamp}`);
    // The PM is on the PROPERTY but not on the tour, so they are the inline
    // "Also on this property" suggestion the operator adds.
    await rosterOnProperty(req, unitId, pm.contactId, 'pm');
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'landlord_led',
    });
    // SETUP: a LIVE relay group (adds against a live group are what announce).
    await openGroupForSetup(req, tourId);

    await putQuietHours(request, windowAroundNow());

    // --- 1. The add defers: a pending row, and NOT a member -----------------
    await page.goto(`${NEXT}/tours/${tourId}`);
    const roster = page.getByRole('list', { name: 'Roster' });
    await expect(roster.getByText(tenant.name)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Edit people' }).click();
    await page.getByRole('button', { name: `Add ${pm.name} to this tour` }).click();
    const addConfirm = page.getByRole('dialog', { name: `Add ${pm.name} to the relay group?` });
    await expect(addConfirm).toBeVisible({ timeout: 20_000 });
    await addConfirm.getByRole('button', { name: /^Add and notify at / }).click();
    await expect(addConfirm).toHaveCount(0, { timeout: 20_000 });

    const pendingRow = pendingList(page).getByRole('listitem').filter({ hasText: pm.name });
    await expect(pendingRow.getByText(/^Joins at .+ - quiet hours$/)).toBeVisible({
      timeout: 20_000,
    });
    // Membership defers WITH the message: they are not on the roster yet.
    await expect(roster.getByText(pm.name)).toHaveCount(0);

    // --- 2. Cancel leaves a VISIBLE notice, until it is dismissed ------------
    await page.getByRole('button', { name: `Cancel adding ${pm.name}` }).click();
    await expect(noticeList(page).getByText(`Canceled - ${pm.name} was not added.`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(pendingList(page)).toHaveCount(0);

    await page.getByRole('button', { name: `Dismiss notice for ${pm.name}` }).click();
    await expect(noticeList(page)).toHaveCount(0, { timeout: 20_000 });
    // A dismissed notice never comes back: the server excludes it from the
    // payload, so a full reload cannot resurrect it.
    await page.reload();
    await expect(roster.getByText(tenant.name)).toBeVisible({ timeout: 20_000 });
    await expect(noticeList(page)).toHaveCount(0);

    // --- 3. The SECOND deferred add is applied by the poller at quiet-end ----
    await page.getByRole('button', { name: 'Edit people' }).click();
    await page.getByRole('button', { name: `Add ${pm.name} to this tour` }).click();
    await expect(addConfirm).toBeVisible({ timeout: 20_000 });
    await addConfirm.getByRole('button', { name: /^Add and notify at / }).click();
    await expect(pendingList(page).getByText(/^Joins at .+ - quiet hours$/)).toBeVisible({
      timeout: 20_000,
    });

    // Cross the row's OWN dueAt explicitly - never by waiting for a wall clock.
    const { pending } = await getRoster(req, tourId);
    const due = pending.find((p) => p.kind === 'add_member');
    expect(due, 'the deferred add is on the roster payload').toBeDefined();
    const tick = await req.post(`${NEXT}/__dev/roster-actions/tick`, {
      data: { now: new Date(Date.parse(due!.dueAt) + 60_000).toISOString() },
    });
    expect(tick.ok(), await tick.text()).toBeTruthy();

    // They really joined, and the whole group was told.
    await page.reload();
    await expect(roster.getByText(pm.name)).toBeVisible({ timeout: 30_000 });
    await expect(pendingList(page)).toHaveCount(0);
    await expectSentTo(req, tenant.phone, 'joined this group chat');
    await expectSentTo(req, pm.phone, 'joined this group chat');
  });
});
