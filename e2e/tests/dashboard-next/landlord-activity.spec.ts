import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Landlord timeline interleave (:5174) against the real backend — activity
// coverage WS3. A landlord contact's timeline interleaves the LIFECYCLE activity
// of the properties they own (broadcasts + tours) as milestone pins, deep-linked
// to the broadcast / tour. We build fully-owned infra (a fresh landlord, an owned
// property, consented tenants), drive a broadcast + a scheduled→canceled tour on
// that property, then assert those milestones appear on the LANDLORD's own
// timeline (not just the property's Activity card). Self-clean: run-unique data.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function createConsentedTenant(
  request: APIRequestContext,
  firstName: string,
): Promise<{ contactId: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Llact', phone, voucherSize: 2 },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok()).toBeTruthy();
  return { contactId, phone };
}

async function createLandlord(request: APIRequestContext, firstName: string): Promise<string> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'landlord', firstName, lastName: 'Llact', phone },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).contact.contactId as string;
}

async function createAvailableUnit(request: APIRequestContext, landlordId: string): Promise<string> {
  const line1 = `${`${Date.now()}`.slice(-6)} Landlord Loop NW`;
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

test.describe('Landlord timeline — owned-property activity interleave (activity coverage)', () => {
  test("a broadcast + tour on an owned property interleave onto the landlord's timeline", async ({
    page,
  }) => {
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const landlordId = await createLandlord(req, `Landlord${stamp}`);
    const unitId = await createAvailableUnit(req, landlordId);
    const t1 = await createConsentedTenant(req, `Llone${stamp}`);
    const t2 = await createConsentedTenant(req, `Lltwo${stamp}`);

    // Broadcast to the owned property (fan-out writes the units# broadcast_sent
    // audit on completion — SQS-driven, polled below).
    const draft = await req.post(`${NEXT}/api/broadcasts`, {
      data: {
        unitId,
        body_template: `Owned-property broadcast ${stamp} at [Address]`,
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      },
    });
    expect(draft.ok()).toBeTruthy();
    const broadcastId = (await draft.json()).broadcastId as string;
    const send = await req.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
      data: { recipientContactIds: [t1.contactId, t2.contactId] },
    });
    expect(send.ok()).toBeTruthy();

    // A scheduled → canceled tour on the same owned property (synchronous audit).
    const tourRes = await req.post(`${NEXT}/api/tours`, {
      data: { tenantId: t1.contactId, unitId, scheduledAt: '2026-09-20T16:00:00.000Z', tourType: 'self_guided' },
    });
    expect(tourRes.ok()).toBeTruthy();
    const tourId = (await tourRes.json()).tour.tourId as string;
    const cancel = await req.patch(`${NEXT}/api/tours/${tourId}`, { data: { status: 'canceled' } });
    expect(cancel.ok()).toBeTruthy();

    // Wait for the async fan-out to land the broadcast audit row.
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

    // The landlord's OWN timeline interleaves the owned property's lifecycle:
    // the broadcast pin (deep-links to the broadcast) + both tour pins (to the tour).
    await page.goto(`${NEXT}/contacts/${landlordId}`);
    const timeline = page.getByRole('region', { name: 'Communications and activity' });

    const bcast = timeline.getByRole('link', { name: /Sent to 2 tenants/ }).first();
    await expect(bcast).toBeVisible({ timeout: 10_000 });
    await expect(bcast).toHaveAttribute('href', `/broadcasts/${broadcastId}`);

    const scheduled = timeline.getByRole('link', { name: /Tour scheduled/ }).first();
    await expect(scheduled).toBeVisible();
    await expect(scheduled).toHaveAttribute('href', `/tours/${tourId}`);

    const canceled = timeline.getByRole('link', { name: /Tour canceled/ }).first();
    await expect(canceled).toBeVisible();
    await expect(canceled).toHaveAttribute('href', `/tours/${tourId}`);
  });
});
