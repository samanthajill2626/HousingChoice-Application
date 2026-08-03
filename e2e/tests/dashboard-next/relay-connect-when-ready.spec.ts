import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads, type FakeThread } from '../../fixtures/fakeTwilio.js';
import { getOutbox } from '../../fixtures/outbox.js';
import { fakeUrl } from '../../support/urls.js';

// Relay CONNECT-WHEN-READY end-to-end proof (relay number buying strategy, plan
// Task 12; worklist SLICE 11). Drives the real dashboard + API + fake-twilio on
// the hermetic lane and proves the tier-3 (connect-when-ready) path the whole
// feature exists for:
//
//   1. A group text for a pair with NO reusable active number and NO fresh spare
//      is created CONNECTING - no pool number, and the auto-intro is NOT sent.
//   2. The dashboard renders a distinct "Connecting" state and the composer stays
//      usable (a team send is HELD, not refused).
//   3. A team compose on the connecting group is held as delivery_status
//      queued_pending - NOTHING is sent yet (outbox + fake threads stay empty).
//   4. When the warmed number registers (the fake POST /control/register-number
//      fires the Event Streams registration event), the group OPENS on its
//      dedicated number, the deferred auto-intro is sent, THEN the queued message
//      is flushed - in that order.
//   5. ZERO Twilio error 30034 is ever emitted (decision D13): the design keeps
//      the outbox EMPTY until the number registers (no send from an unregistered
//      number), and every fake per-recipient leg resolves without errorCode 30034.
//
// HOW TIER-3 IS FORCED (deterministic, no seed exhaustion needed): the hermetic
// stack runs MESSAGING_DRIVER=twilio (config currentVia='twilio') pointed at the
// fake via TWILIO_API_BASE_URL, so relayLiveProvisioning defaults TRUE and the
// spare-buffer target K defaults 0. provisionForGroup only ever REUSES an active
// number whose provisioned_via === currentVia ('twilio'); the seeded pool numbers
// are 'console', so on a fresh LEAN reseed there is NO twilio-provisioned active
// number to reuse (tier 1/2 both miss) and no maintained spare (K=0) - so a fresh
// pair lands in tier 3 (needs_connecting). We ASSERT the group is genuinely
// connecting (no pool_number, intro not sent) before proceeding, so a spec that
// did not actually exercise the connecting branch fails loudly instead of passing
// vacuously.
//
// OBSERVABILITY: outbound legs are proven via BOTH the fake-twilio thread store
// (listThreads - both directions + per-recipient delivery state incl. errorCode)
// and the app outbox (getOutbox - the D13 "nothing sent while connecting" absence
// proof). The warmed number is discovered via the admin GET /api/pool-numbers
// inventory (state 'warming'); firing readiness is the fake's POST
// /control/register-number (the T9 seam that drives warming -> active).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// The relay.intro trailing opt-out footer (catalog relay.intro default ends
// "... Reply STOP to opt out."). A stable substring that identifies the auto-intro
// leg and NEVER appears on a fan-out content leg (group content carries no opt-out
// footer), so it cleanly separates the intro from the queued team message.
const INTRO_NEEDLE = 'Reply STOP to opt out';

// --- Per-run-unique phones ---------------------------------------------------
// +1 555 8XX XXXX: the "8" exchange never collides with the fake's minted pool
// numbers (the fake mints them on the 019 exchange: +1<hint segment>019xxxx, so
// +1404019xxxx here) or the seeded rosters. The last-4 of the wall clock + an
// incrementing counter keep every number unique across the run.
let uid = 0;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

interface Member {
  phone: string;
  name: string;
}

interface ConvRow {
  conversationId: string;
  status?: string;
  pool_number?: string;
}

/** One admin pool-number inventory row (subset the spec reads). */
interface PoolNumberRow {
  number: string;
  state: 'active' | 'warming' | 'releasing' | 'released';
}

/** Reseed the lane with the LEAN profile (a light, clean slate: this spec builds
 *  all its own data, and a fresh reseed guarantees NO twilio-provisioned active
 *  number exists yet - the precondition that forces tier-3 connecting). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Fresh dev-login as the seeded VA (session minted AFTER the reseed so its cookie
 *  epoch matches the freshly re-seeded users table). page.request then shares the
 *  authenticated browser context for the /api calls below. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** Log the SEPARATE `request` context in as the seeded FOUNDER (role admin) so it
 *  can read the admin-only GET /api/pool-numbers inventory. The default dev-login
 *  identity (va@example.com) is role 'va' and would 403 there. Minted after the
 *  beforeEach reseed so the cookie epoch is valid. */
async function adminLogin(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/auth/dev-login`, {
    data: { email: 'founder@example.com' },
  });
  expect(res.ok(), `admin dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const who = (await res.json()) as { role?: string };
  expect(who.role, 'founder dev-login must yield an admin session').toBe('admin');
}

/** Create a relay group via POST /api/relay-groups and ASSERT it landed CONNECTING
 *  - no pool number yet (tier-3 connect-when-ready). If it opened immediately the
 *  tier-3 precondition was not met (a reusable twilio number leaked into the seed)
 *  and this fails loudly rather than passing without exercising the branch. */
async function createConnectingGroup(page: Page, members: Member[]): Promise<ConvRow> {
  const res = await page.request.post(`${NEXT}/api/relay-groups`, {
    data: { members: members.map((m) => ({ phone: m.phone, name: m.name })) },
  });
  expect(res.ok(), `create group failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { conversation } = (await res.json()) as { conversation: ConvRow };
  expect(conversation.status, 'a fresh pair with no reusable number must be CONNECTING').toBe(
    'connecting',
  );
  expect(
    conversation.pool_number ?? '',
    'a connecting group carries NO pool number yet',
  ).toBe('');
  return conversation;
}

async function getConversation(page: Page, id: string): Promise<ConvRow> {
  const res = await page.request.get(`${NEXT}/api/conversations/${id}`);
  expect(res.ok(), `get conversation failed: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { conversation: ConvRow }).conversation;
}

/** Admin inventory read (founder session on `request`). */
async function listPoolNumbers(request: APIRequestContext): Promise<PoolNumberRow[]> {
  const res = await request.get(`${NEXT}/api/pool-numbers`);
  expect(res.ok(), `pool-numbers admin read failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { numbers: PoolNumberRow[] }).numbers;
}

/** Poll the admin inventory until exactly the expected warming number appears (the
 *  warm job buys + records it ASYNC in the worker). With K=0 + a fresh LEAN reseed
 *  the ONLY warming number is the one earmarked to our connecting group, so we
 *  assert there is exactly one and return it. */
async function pollWarmingNumber(request: APIRequestContext): Promise<string> {
  let warming: string[] = [];
  await expect
    .poll(
      async () => {
        warming = (await listPoolNumbers(request))
          .filter((n) => n.state === 'warming')
          .map((n) => n.number);
        return warming.length;
      },
      { timeout: 30_000, message: 'no warming pool number ever appeared for the connecting group' },
    )
    .toBeGreaterThanOrEqual(1);
  expect(warming, 'exactly one warming number (K=0, one connecting group)').toHaveLength(1);
  return warming[0]!;
}

/** Fire the fake's A2P registration signal for a warming number (the T9 seam):
 *  the fake looks up the PN sid it minted for this number and POSTs the Event
 *  Streams number-registration.successful batch to the app's /webhooks/twilio/events
 *  sink, which promotes warming -> active and opens the earmarked connecting group. */
async function registerNumber(request: APIRequestContext, phoneNumber: string): Promise<void> {
  const res = await request.post(`${fakeUrl}/control/register-number`, { data: { phoneNumber } });
  expect(
    res.ok(),
    `register-number failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

/** The fake's traffic-inferred relay groups (per-recipient legs carry errorCode). */
interface GroupRecipient {
  number: string;
  state: string;
  errorCode?: string;
}
interface GroupEntry {
  kind: 'inbound' | 'outbound';
  body?: string;
  recipients?: GroupRecipient[];
}
interface GroupSnapshot {
  poolNumber: string;
  entries: GroupEntry[];
}
async function listGroups(request: APIRequestContext): Promise<GroupSnapshot[]> {
  const res = await request.get(`${fakeUrl}/control/groups`);
  expect(res.ok(), `fake /control/groups failed: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { groups: GroupSnapshot[] }).groups;
}

/** Ordered bodies of the OUTBOUND legs the pool number sent TO one member (fake
 *  thread append order == send order). */
function outboundBodiesTo(threads: FakeThread[], memberPhone: string, poolNumber: string): string[] {
  const thread = threads.find((t) => t.partyNumber === memberPhone);
  if (thread === undefined) return [];
  return thread.messages
    .filter((m) => m.direction === 'outbound' && m.from === poolNumber && m.to === memberPhone)
    .map((m) => m.body ?? '');
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('connect-when-ready: a connecting group queues a team send, then opens + delivers intro-then-queued with zero 30034', async ({
  page,
  request,
}) => {
  test.slow(); // async warm/register + a paced (1/sec) 4-leg fan-out; triple the budget.
  await devLogin(page);
  await adminLogin(request);

  // --- Arrange: a FRESH pair with no reusable twilio number + no spare (K=0) ->
  //     tier-3 connect-when-ready. createConnectingGroup ASSERTS the group is
  //     genuinely connecting (no pool number), so the branch really runs. ---
  const tenant: Member = { phone: uniquePhone(), name: 'Connect Tenant' };
  const landlord: Member = { phone: uniquePhone(), name: 'Connect Landlord' };
  const group = await createConnectingGroup(page, [tenant, landlord]);

  // The intro is DEFERRED on the connecting path (no number to send from): nothing
  // has been sent to either member yet. This absence is half of the D13 proof.
  expect(await getOutbox(request, { to: tenant.phone })).toHaveLength(0);
  expect(await getOutbox(request, { to: landlord.phone })).toHaveLength(0);

  // --- Assert (UI): the dashboard renders a distinct "Connecting" state and the
  //     composer stays usable (per T11). ---
  await page.goto(`${NEXT}/conversations/${group.conversationId}`);
  await expect(page.getByText('Connecting').first()).toBeVisible({ timeout: 15_000 });
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled();

  // --- Act (UI): compose a fire-and-forget team message on the connecting group.
  //     It must be HELD (queued_pending), not sent. ---
  const queuedToken = `queued-${Date.now()}`;
  await composer.fill(queuedToken);
  await page.getByRole('button', { name: 'Send' }).click();

  // The UI surfaces the deliberate hold: a "Queued - will send when connected" cue
  // (deliveryStatus.ts queued_pending label), NOT "Sending"/"Sent".
  await expect(page.getByText(/Queued - will send when connected/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // Deterministic hold proof: after a settle, STILL nothing sent to either member
  // (the compose neither sent nor enqueued a fan-out - it only persisted
  // queued_pending). The whole outbox is empty (D13: no send before registered).
  await page.waitForTimeout(2_000);
  expect(
    await getOutbox(request, { to: tenant.phone }),
    'a connecting-group compose must NOT send',
  ).toHaveLength(0);
  expect(await getOutbox(request, { to: landlord.phone })).toHaveLength(0);

  // --- Act: discover the warmed number (bought+recorded async by the warm job)
  //     and fire the readiness signal. ---
  const warmedNumber = await pollWarmingNumber(request);

  // Area-code preference (2026-08-03), proven end-to-end: this STANDALONE group
  // carries no property ZIP, so the buy's first search hint is the first
  // configured preferred area code - the Atlanta default 404 (the hermetic stack
  // sets no RELAY_PREFERRED_AREA_CODES). The fake echoes the winning hint back as
  // the minted number's area-code segment, so the warmed number is the witness
  // that the hint really threaded app -> twilio driver -> AvailablePhoneNumbers
  // search (a ZIP-hinted tour/placement buy mints +1303019xxxx instead).
  expect(warmedNumber, 'the warm buy searched with the preferred area-code hint').toMatch(
    /^\+1404019\d{4}$/,
  );

  await registerNumber(request, warmedNumber);

  // --- Assert: the group OPENS on that now-dedicated number. ---
  await expect
    .poll(async () => (await getConversation(page, group.conversationId)).status, {
      timeout: 30_000,
      message: 'connecting group never opened after register-number',
    })
    .toBe('open');
  const opened = await getConversation(page, group.conversationId);
  expect(opened.pool_number, 'the opened group is assigned the warmed number').toBe(warmedNumber);

  // --- Assert ORDER: the deferred intro is delivered FIRST, then the queued team
  //     message - both FROM the now-active number, to the tenant. The shared A2P
  //     token bucket serialises all sends FIFO, and the intro is enqueued before
  //     the flush enqueues the queued fan-out, so intro-then-queued is the order.
  //     We poll until BOTH legs to the tenant have landed, then assert positions. ---
  await expect
    .poll(
      async () => {
        const bodies = outboundBodiesTo(await listThreads(request), tenant.phone, warmedNumber);
        return (
          bodies.some((b) => b.includes(INTRO_NEEDLE)) &&
          bodies.some((b) => b.includes(queuedToken))
        );
      },
      { timeout: 30_000, message: 'intro + queued message never both delivered to the tenant' },
    )
    .toBe(true);

  const tenantBodies = outboundBodiesTo(await listThreads(request), tenant.phone, warmedNumber);
  const introIdx = tenantBodies.findIndex((b) => b.includes(INTRO_NEEDLE));
  const queuedIdx = tenantBodies.findIndex((b) => b.includes(queuedToken));
  expect(introIdx, 'intro delivered to the tenant').toBeGreaterThanOrEqual(0);
  expect(queuedIdx, 'queued message delivered to the tenant').toBeGreaterThanOrEqual(0);
  expect(introIdx, 'the intro is delivered BEFORE the queued team message').toBeLessThan(queuedIdx);

  // The landlord also receives both legs (the intro names everyone; the team
  // message fans out to every member).
  await expect
    .poll(
      async () => {
        const bodies = outboundBodiesTo(await listThreads(request), landlord.phone, warmedNumber);
        return (
          bodies.some((b) => b.includes(INTRO_NEEDLE)) &&
          bodies.some((b) => b.includes(queuedToken))
        );
      },
      { timeout: 30_000, message: 'intro + queued message never both delivered to the landlord' },
    )
    .toBe(true);

  // --- Assert ZERO 30034 (D13): scan every fake GROUP per-recipient leg for the
  //     A2P-unregistered error code. Per-recipient errorCode lives ONLY on the
  //     fake's group recipients (GET /control/groups); a thread message never
  //     carries it, so the group snapshot is the sole real source of a 30034. The
  //     design never sent from an unregistered number, so no leg carries 30034
  //     (and none failed at all). ---
  const groups = await listGroups(request);
  const groupLegsWith30034 = groups.flatMap((g) =>
    g.entries.flatMap((e) => (e.recipients ?? []).filter((r) => r.errorCode === '30034')),
  );
  expect(groupLegsWith30034, 'no fake group leg carries errorCode 30034').toHaveLength(0);

  // Outbox corroboration: every recorded send belongs to THIS group's members and
  // none is failed - the only sends that ever happened were the intro + the flushed
  // queued message, AFTER the number registered.
  const tenantOutbox = await getOutbox(request, { to: tenant.phone });
  const landlordOutbox = await getOutbox(request, { to: landlord.phone });
  expect(tenantOutbox.length, 'the tenant received sends only after registration').toBeGreaterThan(0);
  expect(landlordOutbox.length).toBeGreaterThan(0);
  for (const m of [...tenantOutbox, ...landlordOutbox]) {
    expect(m.from, 'every send is FROM the warmed dedicated number').toBe(warmedNumber);
    expect(m.status, 'no send failed').not.toBe('failed');
    expect(m.status).not.toBe('undelivered');
  }
});
