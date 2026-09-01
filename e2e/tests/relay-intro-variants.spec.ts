// e2e/tests/relay-intro-variants.spec.ts
//
// THE OWNER-ROUTED RELAY COPY, end to end (Phase B spec 9.0-9.6). Everything
// else in the suite opens its group on a TIMELESS tour, which spec 9.5 routes
// to the naked intro; this walk books FIRST, so it is the only place the tour
// variant and the per-recipient member_added split are exercised for real:
//
//   1. OPEN a relay on a BOOKED tour -> every member's fake thread carries Sam's
//      tour intro with the resolved names and the property's street, and the
//      body each member received is BYTE-EQUAL to what preview-open showed (the
//      parity contract of spec 9.0: an operator who edits a previewed body pins
//      what they saw, so a preview showing a different variant would pin the
//      wrong one permanently).
//
//   2. ADD a member -> TWO different bodies (spec 9.4). The people already on
//      the thread hear "Hey, adding <name> to the group as the <role>." - the
//      role coming from the PROPERTY roster (UnitContact.role), not the contact
//      type - and the new member gets the naked intro instead, because they can
//      see no history and that message is their entire context. preview-add
//      shows the GROUP body (spec 9.0's ruling); the dashboard thread shows ONE
//      bubble carrying the NEW MEMBER's (spec 9.6's named, dated exception to
//      the 2026-07-14 everything-is-visible rule).
//
//   3. OPEN a relay on a PLACEMENT (spec 14's second walk) -> the move-in intro,
//      previewed and then delivered to EVERY member of the server's own roster,
//      from the group's masked pool number. The placement variant is the one
//      with no clock in it at all, so this walk is the control for the tour
//      walk's time-dependent copy.
//
// DETERMINISM: the tour is booked +48h, so it is never "today" in the org zone
// and the copy is always the dated variant - no straddling midnight, and no
// assertion here depends on the wall clock.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const + local
// devLogin, raw page.request for setup, accessibility-first locators. Self-clean
// isolation: every contact / property / tour is minted fresh, so NOTHING here
// reseeds and the lean world stays byte-stable.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { driveConnectingGroupToOpen } from '../fixtures/relayConnect.js';
import { getOutboundTo } from '../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

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
}

async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type,
      firstName,
      lastName: 'Variant',
      phone,
      ...(type === 'tenant' && { voucherSize: 2 }),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, phone };
}

/** An AVAILABLE property owned by `landlordId`, with the street the intro will
 *  interpolate into {where} (formatStreet is line1 [+ line2], never the city). */
async function createAvailableUnit(
  request: APIRequestContext,
  landlordId: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${`${Date.now()}`.slice(-6)} Intro Variant Way NW`;
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
  return { unitId, line1 };
}

/** Put a contact on the PROPERTY roster. `primaryContact` is left FALSE on
 *  purpose for the PM here: with no primary row the property contact falls back
 *  to the landlord of record, so the tour intro still names the owner while the
 *  PM's ROLE is available for the member_added clause. */
async function rosterOnProperty(
  request: APIRequestContext,
  unitId: string,
  contactId: string,
  role: 'landlord' | 'pm' | 'owner' | 'other',
): Promise<void> {
  const res = await request.post(`${NEXT}/api/units/${unitId}/contacts`, {
    data: { contactId, role, primaryContact: false },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** A BOOKED tour: +48h, so it is never "today" in the org zone. */
async function createBookedTour(
  request: APIRequestContext,
  data: { tenantId: string; unitId: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/tours`, {
    data: {
      ...data,
      tourType: 'landlord_led',
      scheduledAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
}

/** A placement on `unitId` for `tenantId`, at the ladder's first rung. A
 *  placement carries NO time of its own, which is exactly why its intro variant
 *  is clock-free - unlike the tour walk above, nothing here can straddle a
 *  boundary. */
async function createPlacement(
  request: APIRequestContext,
  data: { tenantId: string; unitId: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/placements`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { placement: { placementId: string } }).placement.placementId;
}

/** Open the relay through the REAL route (`<ownerPath>/relay`), completing the
 *  connect handshake when a fresh pair has no reusable number. Returns the
 *  conversation id AND the masked pool number the legs must be sent FROM. */
async function openRelay(
  request: APIRequestContext,
  ownerPath: string,
): Promise<{ conversationId: string; poolNumber: string }> {
  const res = await request.post(`${NEXT}${ownerPath}/relay`, { data: {} });
  expect(res.ok(), await res.text()).toBeTruthy();
  const { conversation } = (await res.json()) as {
    conversation: { conversationId: string; status?: string; pool_number?: string };
  };
  if (conversation.status === 'connecting') {
    const opened = await driveConnectingGroupToOpen(request, conversation.conversationId);
    return { conversationId: opened.conversationId, poolNumber: opened.pool_number };
  }
  return {
    conversationId: conversation.conversationId,
    poolNumber: conversation.pool_number ?? '',
  };
}

/** Poll the fake until an OUTBOUND body EXACTLY equal to `body` reached `phone`.
 *  Exact, not a fragment: the whole point here is which of two copies landed. */
async function expectExactSentTo(
  request: APIRequestContext,
  phone: string,
  body: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await getOutboundTo(request, { to: phone })).map((m) => m.body ?? ''),
      { timeout: 30_000, message: `nothing exactly equal to the expected copy reached ${phone}` },
    )
    .toContain(body);
}

/** As above, but also pinning the SENDER: the leg has to come from the group's
 *  masked pool number, not the business number, or the member cannot reply into
 *  the group at all. */
async function expectExactSentFromPool(
  request: APIRequestContext,
  phone: string,
  body: string,
  poolNumber: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: phone }))
          .filter((m) => m.from === poolNumber)
          .map((m) => m.body ?? ''),
      {
        timeout: 30_000,
        message: `nothing exactly equal to the expected copy reached ${phone} from ${poolNumber}`,
      },
    )
    .toContain(body);
}

test.describe('Relay intro variants + the member_added split', () => {
  test('a BOOKED tour opens with Sam tour intro, and an add splits the copy', async ({
    page,
  }) => {
    test.slow(); // build-a-world, a real relay provision, and a live add.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Vown${stamp}`);
    const { unitId, line1 } = await createAvailableUnit(req, owner.contactId);
    const pm = await createContact(req, 'landlord', `Vpm${stamp}`);
    const tenant = await createContact(req, 'tenant', `Vten${stamp}`);
    await rosterOnProperty(req, unitId, pm.contactId, 'pm');
    const tourId = await createBookedTour(req, {
      tenantId: tenant.contactId,
      unitId,
    });

    // --- 1. The PREVIEW is the tour variant ---------------------------------
    const previewRes = await req.get(`${NEXT}/api/tours/${tourId}/roster/preview-open`);
    expect(previewRes.ok(), await previewRes.text()).toBeTruthy();
    const introBody = ((await previewRes.json()) as { body: string }).body;
    // Resolved copy, not a catalog echo: the greeting, the property contact,
    // and the STREET the resolver read off the unit. A naked intro contains
    // none of these, so none of this can pass vacuously.
    expect(introBody.startsWith(`Hey ${tenant.firstName}!`), introBody).toBeTruthy();
    expect(introBody).toContain(`Putting you in a group text with ${owner.firstName}`);
    expect(introBody).toContain(`to tour ${line1}`);
    // The PM is on the property but not on this roster, and the tour intro
    // names only the tenant and the property contact either way.
    expect(introBody).not.toContain(pm.firstName);

    // --- 2. Opening SENDS exactly what the preview showed (spec 9.0) --------
    const { conversationId } = await openRelay(req, `/api/tours/${tourId}`);
    await expectExactSentTo(req, tenant.phone, introBody);
    await expectExactSentTo(req, owner.phone, introBody);

    // The dashboard thread carries it too (2026-07-14 visibility rule). A
    // distinctive FRAGMENT, not the whole body: the bubble is what is being
    // located here, and the byte-exact body is already pinned on the wire above.
    await page.goto(`${NEXT}/conversations/${conversationId}`);
    await expect(
      page.getByText(`Putting you in a group text with ${owner.firstName}`, { exact: false }),
    ).toBeVisible({ timeout: 20_000 });

    // --- 3. preview-add shows the GROUP body, with the ROLE clause ----------
    const addPreview = await req.post(`${NEXT}/api/tours/${tourId}/roster/preview-add`, {
      data: { contactId: pm.contactId },
    });
    expect(addPreview.ok(), await addPreview.text()).toBeTruthy();
    const groupBody = ((await addPreview.json()) as { body: string }).body;
    // UnitContact.role 'pm' -> "property manager" (spec 9.4's table). Pinned as
    // a whole line: this is the founder wording, resolved.
    expect(groupBody).toBe(`Hey, adding ${pm.firstName} to the group as the property manager.`);

    // --- 4. The live add splits the copy per recipient (spec 9.4 / 9.6) -----
    const added = await req.post(`${NEXT}/api/tours/${tourId}/roster/live-members`, {
      data: { contactId: pm.contactId },
    });
    expect(added.ok(), await added.text()).toBeTruthy();

    // The EXISTING members hear the group line - byte-equal to the preview.
    await expectExactSentTo(req, tenant.phone, groupBody);
    await expectExactSentTo(req, owner.phone, groupBody);
    // The NEW member gets the naked intro naming the POST-ADD roster instead.
    const nakedNeedle = `You're now connected with ${tenant.firstName}, ${owner.firstName}, and ${pm.firstName}`;
    await expect
      .poll(
        async () =>
          (await getOutboundTo(req, { to: pm.phone })).some((m) =>
            (m.body ?? '').includes(nakedNeedle),
          ),
        { timeout: 30_000, message: 'the new member never received their naked intro' },
      )
      .toBe(true);
    // ...and NEVER the group line, nor a tour variant. Read once, after the
    // send above has landed, so this is not a race against an empty outbox.
    const pmOutbox = (await getOutboundTo(req, { to: pm.phone })).map((m) => m.body ?? '');
    expect(pmOutbox).not.toContain(groupBody);
    expect(pmOutbox.some((b) => b.includes('Putting you in a group text'))).toBe(false);

    // --- 5. ONE bubble in the thread, and it is the NEW MEMBER's (spec 9.6) --
    await page.reload();
    await expect(
      page.getByText(new RegExp(`You're now connected with ${tenant.firstName}`)),
    ).toBeVisible({ timeout: 20_000 });
    // The group-side copy is deliberately NOT shown in the thread: two rows
    // would mean two bubbles and two rollup chips for one event.
    await expect(page.getByText(groupBody, { exact: false })).toHaveCount(0);
  });

  // The PLACEMENT half of spec 14's requirement, mirroring the tour walk above.
  // The API-level pins (placementsApi.test.ts preview-open + relayFanOut.test.ts
  // "a placement owner resolves the placement variant") already prove the
  // resolver picks this variant; what only an e2e can prove is the LEG-ARRIVAL
  // half - that the copy the operator previewed is the copy that reaches every
  // member's phone, from the group's own masked number.
  //
  // Simpler than the tour walk by construction: a placement carries no time, so
  // there is one variant and no clock to straddle.
  test('a PLACEMENT opens with Sam move-in intro, previewed and delivered to every member', async ({
    page,
  }) => {
    test.slow(); // build-a-world plus a real relay provision.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Pown${stamp}`);
    const { unitId, line1 } = await createAvailableUnit(req, owner.contactId);
    const tenant = await createContact(req, 'tenant', `Pten${stamp}`);
    const placementId = await createPlacement(req, { tenantId: tenant.contactId, unitId });
    const ownerPath = `/api/placements/${placementId}`;

    // --- 1. The PREVIEW is the placement variant ----------------------------
    const previewRes = await req.get(`${NEXT}${ownerPath}/roster/preview-open`);
    expect(previewRes.ok(), await previewRes.text()).toBeTruthy();
    const introBody = ((await previewRes.json()) as { body: string }).body;
    // Resolved copy, not a catalog echo: the tenant's greeting, the STREET the
    // resolver read off the property, and the property contact who will share
    // updates. A naked intro carries none of these, so nothing here can pass
    // vacuously - and none of the tour copy may appear.
    expect(introBody.startsWith(`Hey ${tenant.firstName}!`), introBody).toBeTruthy();
    expect(introBody).toContain(`Excited to have you move into ${line1}`);
    expect(introBody).toContain(`${owner.firstName} will share updates`);
    expect(introBody).not.toContain('to tour ');
    expect(introBody).not.toContain('on the way');

    // --- 2. Opening sends THAT body to EVERY member, from the POOL number ---
    const { conversationId, poolNumber } = await openRelay(req, ownerPath);
    expect(poolNumber, 'an opened relay group is assigned a masked pool number').not.toBe('');

    // Asserted against the phones this walk MINTED, exactly as the tour walk
    // above does. An earlier draft read them back from
    // GET <ownerPath>/roster to make the SERVER name its own members - but that
    // route answers RosterView, whose rows carry `phoneLast4` and never a full
    // `phone` (the full number never leaves the server; see
    // lib/rosterResolution.ts). The read returned nothing, so the leg-arrival
    // assertions below - the entire substance of this walk - had nothing to
    // iterate. Two minted numbers, named explicitly, cannot go quiet that way.
    //
    // The placement's default roster is the tenant plus the unit's
    // landlord-of-record, so these two ARE every member.
    for (const phone of [tenant.phone, owner.phone]) {
      await expectExactSentFromPool(req, phone, introBody, poolNumber);
    }

    // --- 3. ...and the dashboard thread shows the same one bubble -----------
    await page.goto(`${NEXT}/conversations/${conversationId}`);
    await expect(
      page.getByText(`Excited to have you move into ${line1}`, { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
