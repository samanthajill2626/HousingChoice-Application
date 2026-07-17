import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { sendAsParty, registerParty } from '../../fixtures/fakeTwilio.js';
import { getOutbox } from '../../fixtures/outbox.js';
// Single source of truth for the final "group is closed" copy (no drift).
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';
import { Scenario, freshTenant, freshLandlord, tourSchedule } from '../../scenarios/steps.js';

// Relay NUMBER LIFECYCLE end-to-end proofs (design section 8). Drives the real
// dashboard + API + fake-phones against the hermetic lane and proves the burn-
// multiplexing model end-to-end:
//   1. MULTIPLEX      - two disjoint groups land on ONE pool number; each member's
//                       inbound routes to their OWN group only, both directions.
//   2. OVERLAP        - a third group sharing a member is forced onto a SECOND number.
//   3. CLOSE (UI)     - closing a group in ConversationDetail sends the final catalog
//                       message to BOTH members, hard-disables the composer, and KEEPS
//                       the pool number on the closed conversation.
//   3b. CLOSE (ASK)   - recording "not a fit" on a tour with a linked open group pops
//                       the inline RelayCloseAskDialog; "Close group text" runs the same
//                       close (final message to both members).
//   4. LATE TEXT      - after a group closes, a still-rostered member's text to the
//                       (kept) number lands in their 1:1 WITH the provenance badge; the
//                       closed group transcript is untouched and a disjoint OPEN group on
//                       the SAME number is unaffected.
//   5. NAG            - the Today "Group texts to close" card renders a past-due seeded
//                       group; "Keep open" defers it 28 days and the row leaves.
//
// SEEDING: burn is PERMANENT per seeded DB, so multiplexing is NOT seedable - the
// proofs CREATE groups via the API with per-run-unique phones. The e2e stack runs
// MESSAGING_DRIVER=twilio (config currentVia='twilio'), so the seeded console pool
// numbers are invisible to the reuse ladder: the first created group MINTS a fresh
// number and the next disjoint group REUSES it (a clean, deterministic multiplex).
// We reseed LEAN before EACH test (a clean, LIGHT slate: the create-your-own tests
// need no seeded groups, and a small DB keeps the tour-build typeahead fast under
// full-suite load); ONLY the nag test reseeds FULL, for the seeded past-due group
// conv-mx-relay-01. afterAll restores LEAN. Sequential workers (workers:1,
// fullyParallel:false) mean no other spec races these reseeds.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// The exact catalog copy the close route sends (the send may brand-prefix it, so
// every assertion uses includes()).
const CLOSED_COPY = MESSAGE_CATALOG['relay.group_closed'].default;

// Seeded past-due nag group (app/src/lib/seed/matrix.ts, FULL profile). conv-mx-relay-01
// stays OPEN with a ~14-day-overdue close_nag_next_at; members Terrence Grant
// (+15550200205) + Marcus Bell (+15550100002) on pool +15550190101.
const NAG_CONV = 'conv-mx-relay-01';
const NAG_POOL = '+15550190101';
const NAG_POOL_DISPLAY = '(555) 019-0101'; // dashboard formatPhoneDisplay(NAG_POOL)

// --- Per-run-unique phones ---------------------------------------------------
// +1 555 8XX XXXX: the "8" exchange never collides with the fake's minted pool
// numbers (+1555019xxxx) or the seeded rosters (+155501xxxxx / +155502xxxxx). The
// last-4 of the wall clock + an incrementing counter keep every number unique.
let uid = 0;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

interface Member {
  phone: string;
  name: string;
  contactId?: string;
}

interface CreatedGroup {
  conversationId: string;
  pool_number: string;
}

/** Reseed the lane with the FULL profile (needed only for the seeded nag group). */
async function reseedFull(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed?profile=full`);
  expect(res.ok(), `full reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Reseed the lane with the LEAN profile (a light, clean slate for the tests that
 *  build all their own data). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Fresh dev-login via the seeded VA (session minted AFTER the reseed so its cookie
 *  epoch matches the freshly re-seeded users table). page.request then shares the
 *  authenticated context for the /api calls below. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** Create a relay group via the standalone API (POST /api/relay-groups). Provisions
 *  a pool number (burn-as-claim ladder) and returns the conversation + its number. */
async function createGroup(page: Page, members: Member[]): Promise<CreatedGroup> {
  const res = await page.request.post(`${NEXT}/api/relay-groups`, {
    data: {
      members: members.map((m) => ({
        phone: m.phone,
        name: m.name,
        ...(m.contactId !== undefined && { contactId: m.contactId }),
      })),
    },
  });
  expect(res.ok(), `create group failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { conversation } = (await res.json()) as { conversation: CreatedGroup };
  expect(typeof conversation.pool_number, 'created group carries a pool number').toBe('string');
  expect(conversation.pool_number.length).toBeGreaterThan(0);
  return conversation;
}

/** The bodies of a conversation's transcript (GET /api/conversations/:id/messages). */
async function groupMessageBodies(page: Page, conversationId: string): Promise<string[]> {
  const res = await page.request.get(
    `${NEXT}/api/conversations/${conversationId}/messages?limit=100`,
  );
  expect(res.ok()).toBeTruthy();
  const { messages } = (await res.json()) as { messages: Array<{ body?: string }> };
  return messages.map((m) => m.body ?? '');
}

interface ConvRow {
  status?: string;
  pool_number?: string;
  close_nag_next_at?: string;
}

async function getConversation(page: Page, id: string): Promise<ConvRow> {
  const res = await page.request.get(`${NEXT}/api/conversations/${id}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { conversation: ConvRow }).conversation;
}

/** Poll the dev outbox until a message to `phone` whose body includes `needle`
 *  (optionally FROM `from`) is observed. */
async function expectOutboxIncludes(
  request: APIRequestContext,
  phone: string,
  needle: string,
  from?: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const msgs = await getOutbox(request, { to: phone });
        return msgs.some(
          (m) => (m.body ?? '').includes(needle) && (from === undefined || m.from === from),
        );
      },
      { timeout: 15_000, message: `outbox to ${phone} never carried the expected copy` },
    )
    .toBe(true);
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('multiplex: two disjoint groups share ONE pool number; inbound routes to the right group both ways', async ({
  page,
  request,
}) => {
  await devLogin(page);

  const tenantA = { phone: uniquePhone(), name: 'Multiplex TenantA' };
  const landlordA = { phone: uniquePhone(), name: 'Multiplex LandlordA' };
  const tenantB = { phone: uniquePhone(), name: 'Multiplex TenantB' };
  const landlordB = { phone: uniquePhone(), name: 'Multiplex LandlordB' };

  // Two participant-DISJOINT groups created in sequence: the burn ladder reuses the
  // first number for the second (nothing overlaps), so both share ONE pool number.
  const group1 = await createGroup(page, [tenantA, landlordA]);
  const group2 = await createGroup(page, [tenantB, landlordB]);
  expect(group2.pool_number, 'disjoint groups multiplex onto one number').toBe(
    group1.pool_number,
  );
  const pool = group1.pool_number;

  await registerParty(request, { label: 'mxTenantA', role: 'tenant', number: tenantA.phone });
  await registerParty(request, { label: 'mxTenantB', role: 'tenant', number: tenantB.phone });

  // tenantB texts the shared number -> lands in GROUP 2 only, fans out to landlordB.
  const tokenB = `mx-b-${Date.now()}`;
  await sendAsParty(request, { from: tenantB.phone, to: pool, body: tokenB });
  await expect
    .poll(async () => (await groupMessageBodies(page, group2.conversationId)).some((b) => b.includes(tokenB)), {
      timeout: 15_000,
      message: 'tenantB inbound never reached group2 transcript',
    })
    .toBe(true);
  expect(
    (await groupMessageBodies(page, group1.conversationId)).some((b) => b.includes(tokenB)),
    'group1 must NOT receive group2 traffic on the shared number',
  ).toBe(false);
  await expectOutboxIncludes(request, landlordB.phone, tokenB, pool); // fan-out to B's landlord

  // tenantA texts the SAME number -> lands in GROUP 1 only, fans out to landlordA.
  const tokenA = `mx-a-${Date.now()}`;
  await sendAsParty(request, { from: tenantA.phone, to: pool, body: tokenA });
  await expect
    .poll(async () => (await groupMessageBodies(page, group1.conversationId)).some((b) => b.includes(tokenA)), {
      timeout: 15_000,
      message: 'tenantA inbound never reached group1 transcript',
    })
    .toBe(true);
  expect(
    (await groupMessageBodies(page, group2.conversationId)).some((b) => b.includes(tokenA)),
    'group2 must NOT receive group1 traffic on the shared number',
  ).toBe(false);
  await expectOutboxIncludes(request, landlordA.phone, tokenA, pool);
});

test('overlap forces a SECOND number: a group sharing a member never reuses the first number', async ({
  page,
}) => {
  await devLogin(page);

  const tenantA = { phone: uniquePhone(), name: 'Overlap TenantA' };
  const landlordA = { phone: uniquePhone(), name: 'Overlap LandlordA' };
  const landlordC = { phone: uniquePhone(), name: 'Overlap LandlordC' };

  const groupA = await createGroup(page, [tenantA, landlordA]);
  // group3 shares tenantA -> the (number, person) burn on groupA's number forbids
  // reuse, so it must be provisioned onto a DIFFERENT number.
  const group3 = await createGroup(page, [tenantA, landlordC]);
  expect(group3.pool_number, 'an overlapping roster is forced onto a fresh number').not.toBe(
    groupA.pool_number,
  );
});

test('close (ConversationDetail): final message to both members, composer hard-disabled, number KEPT', async ({
  page,
  request,
}) => {
  await devLogin(page);

  const tenant = { phone: uniquePhone(), name: 'Close Tenant' };
  const landlord = { phone: uniquePhone(), name: 'Close Landlord' };
  const group = await createGroup(page, [tenant, landlord]);

  await page.goto(`${NEXT}/conversations/${group.conversationId}`);
  // Sending is available while the group is open.
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 15_000 });

  // Close via the header action + confirm dialog (the real dashboard close flow).
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const closeDialog = page.getByRole('dialog', { name: 'Close group?' });
  await closeDialog.getByRole('button', { name: 'Close group' }).click();

  // Composer hard-disables: the closed hint shows and Send is disabled.
  await expect(page.getByText(/This group is closed/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

  // The final catalog message went out to BOTH members FROM the pool number.
  await expectOutboxIncludes(request, tenant.phone, CLOSED_COPY, group.pool_number);
  await expectOutboxIncludes(request, landlord.phone, CLOSED_COPY, group.pool_number);

  // The number is KEPT on the closed conversation (burn-multiplexing invariant).
  const conv = await getConversation(page, group.conversationId);
  expect(conv.status).toBe('closed');
  expect(conv.pool_number).toBe(group.pool_number);
});

test('close (inline ask): "not a fit" on a tour pops RelayCloseAskDialog; "Close group text" sends the final message', async ({
  page,
  request,
}) => {
  test.slow(); // a full tour build (interest -> group -> book -> toured) then the ask.
  const flow = new Scenario(page, request);
  const owner = freshLandlord('AskOwner');
  const tenant = freshTenant('AskTenant');

  await flow.login();
  await flow.teamCreatesLandlord({
    firstName: owner.firstName,
    lastName: owner.lastName,
    phone: owner.phone,
  });
  const ownerId = flow.landlordId();
  const unit = await flow.seedAvailableUnit({ beds: 2, landlordId: ownerId });
  await flow.teamCreatesTenant({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    phone: tenant.phone,
  });
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  await flow.teamOpensTourGroup(); // creates the group + links tour.groupThreadId
  await flow.teamBooksTour(tourSchedule());
  await flow.teamMarksToured();

  // Record "not a fit" through the real Record-outcome modal (leaves us on /tours/:id).
  await page.getByRole('button', { name: 'Record outcome' }).click();
  const form = page.getByRole('form', { name: 'Record outcome form' });
  await form.getByRole('radio', { name: 'No - not a fit' }).check();
  await page.getByRole('button', { name: 'Save decision' }).click();

  // The inline ask appears (design D4 human path) - nothing auto-closed the group.
  const ask = page.getByRole('dialog', { name: /Also close the group text/i });
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.getByRole('button', { name: 'Close group text' }).click();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });

  // "Close group text" ran the close: the final catalog copy reached BOTH members.
  await expectOutboxIncludes(request, tenant.phone, CLOSED_COPY);
  await expectOutboxIncludes(request, owner.phone, CLOSED_COPY);
});

test('late text: a closed member texting the kept number lands in their 1:1 with the provenance badge (group + disjoint open group untouched)', async ({
  page,
  request,
}) => {
  await devLogin(page);

  // tenantA is a REAL contact so its 1:1 timeline (with the badge) is addressable.
  const tenantAPhone = uniquePhone();
  const created = await page.request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'Late', lastName: `Texter${uid}`, phone: tenantAPhone },
  });
  expect(created.ok(), `create contact failed: ${created.status()} ${await created.text()}`).toBeTruthy();
  const tenantAId = ((await created.json()) as { contact: { contactId: string } }).contact.contactId;

  const landlordA = { phone: uniquePhone(), name: 'Late LandlordA' };
  const tenantB = { phone: uniquePhone(), name: 'Late TenantB' };
  const landlordB = { phone: uniquePhone(), name: 'Late LandlordB' };

  // group1 (to be closed) + group2 (stays open) multiplexed on ONE number.
  const group1 = await createGroup(page, [
    { phone: tenantAPhone, name: 'Late TenantA', contactId: tenantAId },
    landlordA,
  ]);
  const group2 = await createGroup(page, [tenantB, landlordB]);
  expect(group2.pool_number).toBe(group1.pool_number);
  const pool = group1.pool_number;

  // Close group1 (API; the close UI is proven above). Number stays on it.
  const closeRes = await page.request.patch(
    `${NEXT}/api/conversations/${group1.conversationId}/close`,
    { data: { closed: true } },
  );
  expect(closeRes.ok(), `close failed: ${closeRes.status()} ${await closeRes.text()}`).toBeTruthy();
  const beforeCount = (await groupMessageBodies(page, group1.conversationId)).length;

  // tenantA (a still-rostered member of the CLOSED group) texts the kept number.
  await registerParty(request, { label: 'lateA', role: 'tenant', number: tenantAPhone });
  const lateToken = `late-${Date.now()}`;
  await sendAsParty(request, { from: tenantAPhone, to: pool, body: lateToken });

  // It lands in tenantA's 1:1 timeline WITH the provenance badge linking to the group.
  await page.goto(`${NEXT}/contacts/${tenantAId}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  await expect(timeline.getByText(lateToken)).toBeVisible({ timeout: 15_000 });
  const badge = page.getByRole('link', { name: 'Sent to the closed group chat' });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('href', `/conversations/${group1.conversationId}`);

  // The CLOSED group transcript gained nothing; the disjoint OPEN group on the same
  // number is entirely unaffected (still open, same number, no leak).
  const g1after = await groupMessageBodies(page, group1.conversationId);
  expect(g1after.some((b) => b.includes(lateToken)), 'closed group must not gain the late text').toBe(false);
  expect(g1after.length, 'closed group transcript is unchanged').toBe(beforeCount);
  const g2after = await groupMessageBodies(page, group2.conversationId);
  expect(g2after.some((b) => b.includes(lateToken)), 'the open group on the same number is untouched').toBe(false);
  const g2 = await getConversation(page, group2.conversationId);
  expect(g2.status).toBe('open');
  expect(g2.pool_number).toBe(pool);
});

test('Today nag: the past-due seeded group shows in "Group texts to close"; Keep open defers it and the row leaves', async ({
  page,
  request,
}) => {
  await reseedFull(request); // the seeded past-due nag group lives only in FULL
  await devLogin(page); // lands on Today (session minted after the FULL reseed)

  // The seeded past-due nag surfaces in the "Group texts to close" card.
  await expect(page.getByRole('heading', { name: /Group texts to close/i })).toBeVisible({
    timeout: 15_000,
  });
  const list = page.getByRole('list', { name: 'Group texts to close' });
  const row = list.getByRole('listitem').filter({ hasText: NAG_POOL_DISPLAY });
  await expect(row).toBeVisible();

  // Keep open -> the row leaves (optimistic dismiss) and the nag defers ~28 days.
  await row.getByRole('button', { name: 'Keep open' }).click();
  await expect(page.getByText(NAG_POOL_DISPLAY)).toHaveCount(0, { timeout: 15_000 });

  // API: close_nag_next_at moved well into the future (was ~14 days overdue).
  const conv = await getConversation(page, NAG_CONV);
  expect(conv.pool_number).toBe(NAG_POOL);
  expect(typeof conv.close_nag_next_at).toBe('string');
  expect(Date.parse(conv.close_nag_next_at as string)).toBeGreaterThan(
    Date.now() + 20 * 24 * 60 * 60 * 1000,
  );
});
