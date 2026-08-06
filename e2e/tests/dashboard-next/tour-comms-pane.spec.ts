// e2e/tests/dashboard-next/tour-comms-pane.spec.ts
//
// The tour + placement hubs' 1:1 tabs are now the SHARED person comms pane
// (ContactCommsTab -> ContactCommsPane, the same component the contact page
// renders). This file is the end-to-end proof of the four things that changed
// for an operator (contact-comms-pane spec, Testing e2e items 1-5):
//
//   1. An email exchanged with the tenant renders on the tour page Tenant tab
//      AND on the placement page tab (the person feed carries every channel,
//      not just one SMS thread).
//   2. Viewing the Tenant tab clears the tenant's WHOLE inbox row (every 1:1
//      thread they own - the contact-wide fan-out), while the Group tab dot and
//      the inbox group row SURVIVE (review M3: a 1:1 read must never touch the
//      relay group).
//   3. A SELF-GUIDED tour's own armed reminder ladder shows in the Tenant tab's
//      "Upcoming scheduled messages" bucket (self-guided routes 1:1, so nothing
//      is group-routed and correctly absent).
//   4. Sending SMS from a tour 1:1 tab still works end to end, INCLUDING for a
//      tenant with no prior conversation (create-on-demand).
//   5. This tour's lifecycle pins are sourced from the PERSON feed and land on
//      BOTH parties' tabs: "Tour scheduled" (schedule) and "Group text opened"
//      (group-open) appear on the Tenant tab AND the Landlord tab.
//
// The placement half of item 1 lives here rather than in a placement sibling
// because it shares this file's fixture (one tenant, one property, one inbound
// email) and because the claim is about the PANE, not the email channel - the
// email-channel specs (flows/email-*.spec.ts) stay the channel's own proof.
//
// dashboard-next dialect (e2e/support/selectors.md, research S7): a local NEXT
// const + a local devLogin, raw page.request for setup, accessibility-first
// locators, no Scenario verbs. Self-clean isolation: every contact / property /
// tour / placement is minted fresh per test, so NOTHING here reseeds (a reseed
// mid-suite would wipe other specs' data and log this session out).
//
// Two selector rules this file must keep (research S1/S4/S5, worklist 29):
//   - EVERY Upcoming assertion is scoped to getByRole('region', { name:
//     'Upcoming scheduled messages' }): the tour page now hosts the pane's
//     Upcoming region AND the right-pane Reminders card, and both carry the
//     same rung bodies.
//   - The send button is always { name: 'Send', exact: true } - a bare 'Send'
//     substring-matches the pane's "Send email" and the per-rung "Send <Kind>
//     reminder now" buttons.
//   - Never page.reload() on a tour page mid-assertion: a reload re-runs the
//     initial-tab rule (Group when a group exists) and silently drops you off
//     the tab under test. The retries below re-navigate and re-assert the tab.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { listThreads, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { sendInboundEmail } from '../../fixtures/fakeEmail.js';
import { driveConnectingGroupToOpen } from '../../fixtures/relayConnect.js';
import { APP_NUMBER, ORG_TIMEZONE, tourReminderBody } from '../../scenarios/steps.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** A run-unique E.164 (the landlord-activity.spec idiom) - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  firstName: string;
  lastName: string;
  phone: string;
}

/**
 * A fresh typed contact. Consent is recorded by default so the pane's
 * just-in-time consent modal stays quiet on a 1:1 send (pass consent:false only
 * when the gate is the thing under test - no test here wants it).
 */
async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
  opts: { email?: string; consent?: boolean } = {},
): Promise<Party> {
  const lastName = 'Cpane';
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type,
      firstName,
      lastName,
      phone,
      ...(type === 'tenant' && { voucherSize: 2 }),
      ...(opts.email !== undefined && { email: opts.email }),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  if (opts.consent !== false) {
    const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
    });
    expect(consent.ok(), await consent.text()).toBeTruthy();
  }
  return { contactId, firstName, lastName, phone };
}

/** An AVAILABLE property owned by `landlordId` (POST /api/units + publish).
 *  Returns `line1` too: the address is STRUCTURED, so line1 alone is the whole
 *  {where} a tour-reminder body composes to, and the reminder assertions need it. */
async function createAvailableUnit(
  request: APIRequestContext,
  landlordId: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${`${Date.now()}`.slice(-6)} Comms Pane Way NW`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      jurisdiction: 'atlanta_housing',
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
  return { unitId, line1 };
}

/** A tour via the real route. With `scheduledAt` the ladder arms and the
 *  "Tour scheduled" person milestone is written for BOTH parties; without it the
 *  tour is timeless ('requested') and nothing is armed. */
async function createTour(
  request: APIRequestContext,
  data: { tenantId: string; unitId: string; tourType: string; scheduledAt?: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/tours`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
}

/** Proof-of-send: EXACTLY one outbound leg carrying `bodyPart` reached `phone`
 *  from the app number (the preferred fake-twilio thread store, not the
 *  deprecated /__dev/outbox). */
async function expectOneOutboundTo(
  request: APIRequestContext,
  phone: string,
  bodyPart: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const threads = await listThreads(request);
        const thread = threads.find((t) => t.partyNumber === phone);
        return (
          thread?.messages.filter(
            (m) =>
              m.direction === 'outbound' &&
              m.from === APP_NUMBER &&
              (m.body ?? '').includes(bodyPart),
          ).length ?? 0
        );
      },
      { timeout: 20_000, message: `no outbound leg containing "${bodyPart}" reached ${phone}` },
    )
    .toBe(1);
}

/** The active tab's comms surface (the shared Timeline region). */
function commsRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Communications and activity' });
}

test.describe('Tour + placement comms pane - the person-centric 1:1 tabs', () => {
  test('self-guided tour: the Tenant tab shows this tour Upcoming reminders, and the schedule pin lands on BOTH parties tabs', async ({
    page,
  }) => {
    test.slow(); // a full build-a-world walk (landlord + property + tenant + tour).
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const landlord = await createContact(req, 'landlord', `Cpsgl${stamp}`);
    const { unitId, line1 } = await createAvailableUnit(req, landlord.contactId);
    const tenant = await createContact(req, 'tenant', `Cpsgt${stamp}`);

    // 48h out: every rung is still in the future at arm time, so day_before
    // (scheduled - 24h) is a real UPCOMING item rather than an already-fired one.
    const scheduledAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'self_guided',
      scheduledAt,
    });

    await page.goto(`${NEXT}/tours/${tourId}`);
    // Self-guided + no group thread -> Tenant is the INITIAL tab.
    await expect(page.getByRole('tab', { name: /^Tenant/, selected: true })).toBeVisible({
      timeout: 15_000,
    });

    // (item 3) The tour's own armed ladder is visible in the PERSON feed's
    // Upcoming bucket on this tab. Self-guided routes every rung 1:1, so the
    // whole ladder belongs here and nothing is group-routed-and-missing.
    // Scoped to the region: the page ALSO renders the Reminders card, which
    // carries the same rung bodies (research S1).
    const upcoming = page.getByRole('region', { name: 'Upcoming scheduled messages' });
    await expect(upcoming).toBeVisible({ timeout: 15_000 });
    // Card roots are grandchild divs of the region (region -> list -> card), so a
    // body filter cannot accidentally select an ancestor container. The body is
    // composed by the APP's own composer off THIS tour's instant + address (the
    // unit's address is structured, so {where} is line1 alone), which keeps the
    // filter exact through a copy change.
    const dayBefore = upcoming.locator('> div > div').filter({
      hasText: tourReminderBody('day_before', {
        scheduledAt,
        timezone: ORG_TIMEZONE,
        address: line1,
      }),
    });
    await expect(dayBefore).toHaveCount(1, { timeout: 15_000 });
    await expect(dayBefore.getByText('Tour reminder', { exact: true })).toBeVisible();

    // (item 5a) The "Tour scheduled" pin comes from the person feed - the server
    // wrote it for the tenant AND for the property's landlord.
    const tenantPin = commsRegion(page).getByRole('link', { name: /Tour scheduled/ }).first();
    await expect(tenantPin).toBeVisible({ timeout: 15_000 });
    await expect(tenantPin).toHaveAttribute('href', `/tours/${tourId}`);

    await page.getByRole('tab', { name: /^Landlord/ }).click();
    const landlordPin = commsRegion(page).getByRole('link', { name: /Tour scheduled/ }).first();
    await expect(landlordPin).toBeVisible({ timeout: 15_000 });
    await expect(landlordPin).toHaveAttribute('href', `/tours/${tourId}`);
  });

  test('viewing the Tenant tab clears the tenant WHOLE inbox row while the Group tab dot and the inbox group row survive', async ({
    page,
    request,
  }) => {
    // The masked-relay connect-when-ready handshake (buy -> register -> open) is
    // multi-hop async and can take a minute under full-suite load, on top of a
    // build-a-world walk - so this test gets an explicit, generous budget.
    test.setTimeout(240_000);
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const landlord = await createContact(req, 'landlord', `Cpgll${stamp}`);
    const { unitId } = await createAvailableUnit(req, landlord.contactId);
    const tenant = await createContact(req, 'tenant', `Cpgtn${stamp}`);

    // A SECOND number on the tenant, so "clears the WHOLE row" is a real claim:
    // two separate 1:1 threads -> one aggregated inbox row -> one fan-out read.
    const secondPhone = freshPhone();
    const addPhone = await req.post(`${NEXT}/api/contacts/${tenant.contactId}/phones`, {
      data: { phone: secondPhone, label: 'second line' },
    });
    expect(addPhone.ok(), await addPhone.text()).toBeTruthy();

    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'landlord_led',
    });

    // A REAL masked relay group through the real route (auto-resolved roster =
    // [tenant, the property's landlord]). placement-0001's seeded "group_thread"
    // is a 1:1 conversation, so it can never stand in for this (research D5).
    const relayRes = await req.post(`${NEXT}/api/tours/${tourId}/relay`, { data: {} });
    expect(relayRes.status(), await relayRes.text()).toBe(201);
    const relay = (await relayRes.json()) as {
      conversation: { conversationId: string; status?: string; pool_number?: string };
    };
    const groupThreadId = relay.conversation.conversationId;
    let poolNumber = relay.conversation.pool_number ?? '';
    if (relay.conversation.status === 'connecting') {
      // Tier-3 connect-when-ready: complete the handshake so the group OPENS on a
      // real pool number we can text into.
      poolNumber = (await driveConnectingGroupToOpen(req, groupThreadId)).pool_number;
    }
    expect(poolNumber, 'the tour group must be open on a pool number').not.toBe('');

    // Two inbound texts from the tenant, one per number -> two conversations.
    await registerParty(request, { label: `Cpgtn${stamp}a`, role: 'tenant', number: tenant.phone });
    await registerParty(request, { label: `Cpgtn${stamp}b`, role: 'tenant', number: secondPhone });
    await registerParty(request, {
      label: `Cpgll${stamp}`,
      role: 'landlord',
      number: landlord.phone,
    });
    const primaryBody = `Primary line ${stamp}`;
    const secondBody = `Second line ${stamp}`;
    await sendAsParty(request, { from: tenant.phone, to: APP_NUMBER, body: primaryBody });
    await sendAsParty(request, { from: secondPhone, to: APP_NUMBER, body: secondBody });

    // Inbox: ONE row for the tenant carrying BOTH threads' unread.
    await page.goto(`${NEXT}/inbox`);
    const tenantRow = page.locator(`a[href="/contacts/${tenant.contactId}"]`);
    await expect(tenantRow).toBeVisible({ timeout: 20_000 });
    await expect(tenantRow.locator('[aria-label="2 unread"]')).toBeVisible({ timeout: 20_000 });

    // The tour page opens on the GROUP tab (the tour has a group thread), and the
    // Tenant tab carries the summed dot.
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(page.getByRole('tab', { name: 'Group text', selected: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('tab', { name: /^Tenant\b.*unread$/ })).toBeVisible({
      timeout: 20_000,
    });

    // Viewing the Tenant tab fires the CONTACT-WIDE fan-out (not a
    // per-conversation read) - wait on the POST rather than racing it.
    const markedRead = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new RegExp(`/api/inbox/${tenant.contactId}/read$`).test(r.url()),
      { timeout: 30_000 },
    );
    await page.getByRole('tab', { name: /^Tenant/ }).click();
    await markedRead;

    // Both numbers' threads are in the ONE person feed on this tab.
    const comms = commsRegion(page);
    await expect(comms.getByText(primaryBody).first()).toBeVisible({ timeout: 15_000 });
    await expect(comms.getByText(secondBody).first()).toBeVisible({ timeout: 15_000 });

    // (item 5b) The group-open pin, sourced from the tenant's person feed.
    const tenantGroupPin = comms.getByRole('link', { name: /Group text opened/ }).first();
    await expect(tenantGroupPin).toBeVisible({ timeout: 15_000 });
    await expect(tenantGroupPin).toHaveAttribute('href', `/tours/${tourId}`);

    // The Tenant dot cleared. toHaveCount(0) RETRIES, which is what absorbs the
    // SSE-debounced refetch briefly re-reading the pre-fan-out server value
    // (the hook re-fires mark-read and converges).
    await expect(page.getByRole('tab', { name: /^Tenant\b.*unread$/ })).toHaveCount(0, {
      timeout: 20_000,
    });

    // NOW the group goes unread WHILE we sit on the Tenant tab: its dot must
    // appear (SSE refetch) and the 1:1 fan-out must never clear it. Sending it
    // after the fan-out is deliberate - landing on the tour page marks the
    // INITIAL (group) tab read, so an earlier group inbound would be consumed.
    await sendAsParty(request, {
      from: landlord.phone,
      to: poolNumber,
      body: `Group ping ${stamp}`,
    });
    await expect(page.getByRole('tab', { name: /^Group text unread$/ })).toBeVisible({
      timeout: 30_000,
    });

    // (item 5b, landlord half) The same dual-party group-open pin on his tab.
    await page.getByRole('tab', { name: /^Landlord/ }).click();
    const landlordGroupPin = commsRegion(page)
      .getByRole('link', { name: /Group text opened/ })
      .first();
    await expect(landlordGroupPin).toBeVisible({ timeout: 15_000 });
    await expect(landlordGroupPin).toHaveAttribute('href', `/tours/${tourId}`);

    // Back in the Inbox, the durable proof: the tenant's WHOLE row is read (both
    // threads), and the GROUP row is still there AND still unread.
    await page.goto(`${NEXT}/inbox`);
    const readRow = page.locator(`a[href="/contacts/${tenant.contactId}"]`);
    await expect(readRow).toBeVisible({ timeout: 20_000 });
    await expect(readRow.locator('[aria-label$="unread"]')).toHaveCount(0, { timeout: 20_000 });
    const groupRow = page.locator(`a[href="/conversations/${groupThreadId}"]`);
    await expect(groupRow).toBeVisible({ timeout: 20_000 });
    await expect(groupRow.locator('[aria-label$="unread"]')).toBeVisible({ timeout: 20_000 });
  });

  test('SMS sends from the tour Tenant tab - including for a tenant with NO prior conversation', async ({
    page,
    request,
  }) => {
    test.slow();
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const landlord = await createContact(req, 'landlord', `Cpsnl${stamp}`);
    const { unitId } = await createAvailableUnit(req, landlord.contactId);
    // Consented at create, and NEVER texted: this tenant owns no conversation at
    // all, so the first send has to create one on demand.
    const tenant = await createContact(req, 'tenant', `Cpsnt${stamp}`);
    await registerParty(request, { label: `Cpsnt${stamp}`, role: 'tenant', number: tenant.phone });

    // Timeless ('requested') tour: no ladder is armed, so the only outbound legs
    // reaching this tenant are the two sends asserted below.
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'self_guided',
    });

    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(page.getByRole('tab', { name: /^Tenant/, selected: true })).toBeVisible({
      timeout: 15_000,
    });

    // The pane's empty state names the person (not "No messages yet.").
    const comms = commsRegion(page);
    await expect(
      comms.getByText(`No messages with ${tenant.firstName} ${tenant.lastName} yet`),
    ).toBeVisible({ timeout: 15_000 });

    // First send: create-on-demand (no conversation existed).
    const first = `First contact ${stamp}`;
    await page.getByRole('textbox', { name: 'Reply message' }).fill(first);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(comms.getByText(first).first()).toBeVisible({ timeout: 15_000 });
    await expectOneOutboundTo(request, tenant.phone, first);

    // Second send: the ordinary existing-conversation path, same tab, same pane.
    const second = `Follow up ${stamp}`;
    await page.getByRole('textbox', { name: 'Reply message' }).fill(second);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(comms.getByText(second).first()).toBeVisible({ timeout: 15_000 });
    await expectOneOutboundTo(request, tenant.phone, second);
  });

  test('an email exchanged with the tenant renders on the tour page Tenant tab AND on the placement page tab', async ({
    page,
    request,
  }) => {
    test.slow();
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const landlord = await createContact(req, 'landlord', `Cpeml${stamp}`);
    const { unitId } = await createAvailableUnit(req, landlord.contactId);
    const tenantEmail = `cpane.tenant.${stamp}@example.com`;
    const tenant = await createContact(req, 'tenant', `Cpemt${stamp}`, { email: tenantEmail });

    // A tour AND a placement on the same tenant + property. Both hubs render the
    // SAME person pane on their 1:1 tab, so one inbound email must surface on
    // both. Neither has a group thread, so Tenant is the initial tab on both.
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'self_guided',
    });
    const placementRes = await req.post(`${NEXT}/api/placements`, {
      data: { tenantId: tenant.contactId, unitId, stage: 'send_application' },
    });
    expect(placementRes.ok(), await placementRes.text()).toBeTruthy();
    const placementId = ((await placementRes.json()) as {
      placement: { placementId: string };
    }).placement.placementId;

    // The tenant emails in through the REAL inbound seam (hand-rolled MIME ->
    // MinIO -> SNS-shaped POST to /webhooks/ses/inbound). Tier-6 findByEmail
    // threads it onto her contact and creates her email conversation.
    const subject = `Tour question ${stamp}`;
    const delivered = await sendInboundEmail(request, {
      from: tenantEmail,
      subject,
      text: 'Is the property still available to tour this weekend?',
    });
    expect(delivered.appStatus, 'the inbound webhook accepted the delivery').toBe(200);

    // The inbound lands through a webhook + queue, so both assertions RE-NAVIGATE
    // inside a retry instead of reloading: a reload on a hub page re-runs the
    // initial-tab rule, and re-asserting the selected tab inside the block is
    // what keeps the assertion honest about WHICH tab rendered the email
    // (research S5 - the shared expectEmailInTimeline verb reloads, so it is
    // deliberately not reused here).
    await expect(async () => {
      await page.goto(`${NEXT}/tours/${tourId}`);
      await expect(page.getByRole('tab', { name: /^Tenant/, selected: true })).toBeVisible({
        timeout: 5_000,
      });
      const comms = commsRegion(page);
      await expect(comms.getByText('EMAIL', { exact: true }).first()).toBeVisible({
        timeout: 5_000,
      });
      await expect(comms.getByText(subject).first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });

    await expect(async () => {
      await page.goto(`${NEXT}/placements/${placementId}`);
      await expect(page.getByRole('tab', { name: /^Tenant/, selected: true })).toBeVisible({
        timeout: 5_000,
      });
      const comms = commsRegion(page);
      await expect(comms.getByText('EMAIL', { exact: true }).first()).toBeVisible({
        timeout: 5_000,
      });
      await expect(comms.getByText(subject).first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
  });
});
