import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Property Activity card (:5174) against the real backend — proves the unit
// audit trail round-trip: a real edit (PATCH /api/units/:id) writes a
// unit_updated audit row, and GET /api/units/:id/activity serves it back into
// the Activity card with staff copy + the humanized changed-field detail.
//
// Targets seeded unit-0002 (88 Sycamore St — its `utilities` value is asserted
// by no other spec) and REVERTS the edit so the record stays pristine. The
// trail itself is append-only (rows accumulate), which no other spec asserts
// on — we deliberately do NOT change the unit's status here (public-pages /
// placement-create depend on the seeded statuses).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const UNIT = 'unit-0002'; // 88 Sycamore St, Decatur

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Open the ⋯ → Edit property dialog, set Utilities, save, and wait for close. */
async function editUtilities(page: Page, value: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Edit property/i }).click();
  const dialog = page.getByRole('dialog', { name: /Edit property/i });
  await dialog.getByLabel(/Utilities/i).fill(value);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** A run-unique consented tenant (voucherSize 2). Consent so a broadcast reaches
 *  them (no JIT gate). Returns the id we send to. */
async function createConsentedTenant(
  request: APIRequestContext,
  firstName: string,
): Promise<{ contactId: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Actcov', phone, voucherSize: 2 },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok()).toBeTruthy();
  return { contactId, phone };
}

/** A run-unique landlord contact. */
async function createLandlord(request: APIRequestContext, firstName: string): Promise<string> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'landlord', firstName, lastName: 'Actcov', phone },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).contact.contactId as string;
}

/** A run-unique available 2-BR property owned by `landlordId`. */
async function createAvailableUnit(request: APIRequestContext, landlordId: string): Promise<string> {
  const line1 = `${`${Date.now()}`.slice(-6)} Activity Ave NW`;
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
  expect(res.ok()).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(pub.ok()).toBeTruthy();
  return unitId;
}

test.describe('Property detail — broadcast + tour Activity rows (activity coverage)', () => {
  test('a broadcast and a scheduled+canceled tour surface as deep-linked Activity rows', async ({
    page,
  }) => {
    // dev-login FIRST so page.request carries the session cookie for the /api setup.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    // Own infra: a landlord, an available 2-BR property, two consented tenants.
    const landlordId = await createLandlord(req, `Owner${stamp}`);
    const unitId = await createAvailableUnit(req, landlordId);
    const t1 = await createConsentedTenant(req, `Actone${stamp}`);
    const t2 = await createConsentedTenant(req, `Acttwo${stamp}`);

    // Broadcast to the property (explicit recipients) → on fan-out completion the
    // worker writes a units# `broadcast_sent` audit row (SQS-driven, no dev tick).
    const draft = await req.post(`${NEXT}/api/broadcasts`, {
      data: {
        unitId,
        body_template: `Open house ${stamp} at [Address]`,
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      },
    });
    expect(draft.ok()).toBeTruthy();
    const broadcastId = (await draft.json()).broadcastId as string;
    const send = await req.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
      data: { recipientContactIds: [t1.contactId, t2.contactId] },
    });
    expect(send.ok()).toBeTruthy();

    // A scheduled tour on the same property, then canceled → two units# audit rows
    // (written synchronously by the tour create + PATCH handlers).
    const tourRes = await req.post(`${NEXT}/api/tours`, {
      data: { tenantId: t1.contactId, unitId, scheduledAt: '2026-09-15T15:00:00.000Z', tourType: 'self_guided' },
    });
    expect(tourRes.ok()).toBeTruthy();
    const tourId = (await tourRes.json()).tour.tourId as string;
    const cancel = await req.patch(`${NEXT}/api/tours/${tourId}`, { data: { status: 'canceled' } });
    expect(cancel.ok()).toBeTruthy();

    // The fan-out is async — poll the activity API for the broadcast row's arrival.
    await expect
      .poll(
        async () => {
          const res = await req.get(`${NEXT}/api/units/${unitId}/activity`);
          if (!res.ok()) return false;
          const events = (await res.json()).events as Array<{ type: string }>;
          return events.some((e) => e.type === 'broadcast_sent');
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // The UI Activity card now shows all three rows, deep-linked.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
    await expect(activity).toBeVisible();

    const bcast = activity.getByRole('link', { name: /Broadcast to 2 tenants/ });
    await expect(bcast).toBeVisible();
    await expect(bcast).toHaveAttribute('href', `/broadcasts/${broadcastId}`);

    const scheduled = activity.getByRole('link', { name: /Tour scheduled/ }).first();
    await expect(scheduled).toBeVisible();
    await expect(scheduled).toHaveAttribute('href', `/tours/${tourId}`);

    const canceled = activity.getByRole('link', { name: /Tour canceled/ }).first();
    await expect(canceled).toBeVisible();
    await expect(canceled).toHaveAttribute('href', `/tours/${tourId}`);

    // Clicking the broadcast row navigates to that broadcast.
    await bcast.click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/${broadcastId}$`));
  });
});

test.describe('Property detail - "Sent to tenants" tour chip (listing-response-tour-chip)', () => {
  test('sent rows carry no response chip until a tour lights exactly the toured recipient', async ({
    page,
  }) => {
    // Proves the retired listing-send `response` label is GONE (no "No reply"
    // anywhere) and the derived tour chip is TRUTHFUL: it appears only for the
    // one recipient with a qualifying tour on THIS property, links to the tour,
    // and leaves the other recipient's row chipless.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    // Own infra: a landlord, an available 2-BR property, two consented tenants.
    const landlordId = await createLandlord(req, `Chipowner${stamp}`);
    const unitId = await createAvailableUnit(req, landlordId);
    const t1 = await createConsentedTenant(req, `Chipone${stamp}`);
    const t2 = await createConsentedTenant(req, `Chiptwo${stamp}`);

    // Send the property to both tenants via a broadcast -> each fan-out leg
    // records a listing_sends row (the "Sent to tenants" ledger).
    const draft = await req.post(`${NEXT}/api/broadcasts`, {
      data: {
        unitId,
        body_template: `Open house ${stamp} at [Address]`,
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      },
    });
    expect(draft.ok()).toBeTruthy();
    const broadcastId = (await draft.json()).broadcastId as string;
    const send = await req.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
      data: { recipientContactIds: [t1.contactId, t2.contactId] },
    });
    expect(send.ok()).toBeTruthy();

    // Fan-out (and its best-effort recordSend) is async -> poll the recipients
    // API until BOTH send rows have landed, and both are chipless (no tour yet).
    await expect
      .poll(
        async () => {
          const res = await req.get(`${NEXT}/api/units/${unitId}/recipients`);
          if (!res.ok()) return null;
          const rows = (await res.json()).recipients as Array<{ contactId: string; tour?: unknown }>;
          const ids = rows.map((r) => r.contactId);
          if (!ids.includes(t1.contactId) || !ids.includes(t2.contactId)) return null;
          return rows.every((r) => r.tour === undefined);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // The "Sent to tenants" card shows both recipients with NO tour chip, and
    // the dead "No reply" label appears nowhere on the page.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const card = page.locator('section', {
      has: page.getByRole('heading', { name: 'Sent to tenants' }),
    });
    await expect(card).toBeVisible();
    // Each row's identity link's accessible name IS the recipient's contactId
    // (the roster renders raw ids); scope a per-recipient row by that link.
    const rowFor = (contactId: string) =>
      card.locator('div').filter({ has: page.getByRole('link', { name: contactId, exact: true }) });
    await expect(rowFor(t1.contactId)).toBeVisible();
    await expect(rowFor(t2.contactId)).toBeVisible();
    await expect(card.getByRole('link', { name: /Tour requested|Tour scheduled|Toured/ })).toHaveCount(0);
    await expect(page.getByText(/No reply/i)).toHaveCount(0);

    // Schedule a tour for ONE recipient (t1) on THIS property -> status 'scheduled'.
    const tourRes = await req.post(`${NEXT}/api/tours`, {
      data: {
        tenantId: t1.contactId,
        unitId,
        scheduledAt: '2026-10-01T15:00:00.000Z',
        tourType: 'self_guided',
      },
    });
    expect(tourRes.ok()).toBeTruthy();
    const tourId = (await tourRes.json()).tour.tourId as string;

    // Reload until the derived chip surfaces (one byUnit GSI read per card load):
    // t1's row gains a "Tour scheduled" chip linking to the tour.
    await expect(async () => {
      await page.reload();
      const chip = rowFor(t1.contactId).getByRole('link', { name: 'Tour scheduled' });
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', `/tours/${tourId}`);
    }).toPass({ timeout: 20_000 });

    // The OTHER recipient stays chipless; exactly one chip on the card; still no
    // "No reply" text anywhere.
    await expect(
      rowFor(t2.contactId).getByRole('link', { name: /Tour requested|Tour scheduled|Toured/ }),
    ).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Tour scheduled' })).toHaveCount(1);
    await expect(page.getByText(/No reply/i)).toHaveCount(0);
  });
});

test.describe('Property detail — Notes card (internal staff notes)', () => {
  test('+ Add opens the edit dialog; saved notes render on the card', async ({ page }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    // Own infra (a run-unique property) so no seeded unit is mutated.
    const landlordId = await createLandlord(page.request, `Noteowner${stamp}`);
    const unitId = await createAvailableUnit(page.request, landlordId);

    await page.goto(`${NEXT}/listings/${unitId}`);
    const notesCard = page.locator('section', { has: page.getByRole('heading', { name: 'Notes' }) });
    await expect(notesCard).toBeVisible();
    await expect(notesCard.getByText('No notes yet.')).toBeVisible();

    // "+ Add" (accessible name "Edit property notes") opens the SAME edit dialog.
    await notesCard.getByRole('button', { name: 'Edit property notes' }).click();
    const dialog = page.getByRole('dialog', { name: /Edit property/i });
    await dialog.getByLabel('Notes').fill(`In-unit washer/dryer; no dishwasher (${stamp})`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The card now shows the note (and the empty state is gone).
    await expect(notesCard.getByText(`In-unit washer/dryer; no dishwasher (${stamp})`)).toBeVisible();
    await expect(notesCard.getByText('No notes yet.')).toHaveCount(0);
  });
});

test.describe('Property detail — Activity card (unit audit trail)', () => {
  test('a real edit surfaces as a "Property updated" Activity row after reload', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/listings/${UNIT}`);
    await expect(page.getByRole('heading', { name: '88 Sycamore St', exact: false })).toBeVisible();

    // The Activity card is REAL (never the construction-era pending panel):
    // it shows either rows or the honest empty state.
    const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
    await expect(activity).toBeVisible();
    await expect(activity.getByText(/arrives with the backend/i)).toHaveCount(0);

    // Remember the current value so the edit is reverted for other specs.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Edit property/i }).click();
    const dialog = page.getByRole('dialog', { name: /Edit property/i });
    const original = await dialog.getByLabel(/Utilities/i).inputValue();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // A real edit → PATCH → unit_updated audit row.
    await editUtilities(page, 'E2E activity marker');

    // The Activity slice loads on mount — reload and the row is there,
    // newest-first, with the humanized changed-field sub-line.
    await page.reload();
    await expect(activity.getByText('Property updated').first()).toBeVisible();
    await expect(activity.getByText('Utilities').first()).toBeVisible();

    // Cleanup — revert so the seeded unit stays pristine (the extra
    // audit rows are append-only history nobody else asserts on).
    await editUtilities(page, original);
  });
});
