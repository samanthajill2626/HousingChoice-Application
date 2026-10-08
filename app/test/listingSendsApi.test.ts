// BE4/C4 route tests -- the "Sent to" / listings-sent endpoints:
//   GET /api/units/:unitId/recipients            -> { recipients: ListingSendRow[] }
//   GET /api/contacts/:contactId/listings-sent   -> { sent: ListingSendRow[] }
// The units direction adds optional recipient facts. The former response PATCH route is
// GONE (the `response` label was removed end to end) -- a 404 pin guards its removal.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;
/** share-sent-outcome T7: the seeded rows' counted instant (the retired upsert writer defaulted it to now). */
const SENT_AT = '2026-06-16T10:00:00.000Z';

function seedUnit(world: ReturnType<typeof createFakeWorld>, unitId: string): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'contact-ll-1',
    status: 'available',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
  };
  world.units.set(unitId, item);
  return item;
}

function seedTenant(world: ReturnType<typeof createFakeWorld>, contactId: string): ContactItem {
  const item: ContactItem = {
    contactId,
    type: 'tenant',
    status: 'active',
    phone: `+1555010${contactId.slice(-4).padStart(4, '0')}`,
  };
  world.contacts.push(item);
  return item;
}

describe('GET /api/units/:unitId/recipients (BE4/C4 - "Sent to")', () => {
  it('returns the unit recipients from listByUnit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT, broadcastId: 'b-1' });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-2', sentAt: SENT_AT });

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(2);
    const c1 = res.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-1');
    expect(c1).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast', broadcastId: 'b-1' });
    // The removed `response` label is gone from the wire.
    expect(c1).not.toHaveProperty('response');
    // The wire shape drops audit furniture.
    expect(c1).not.toHaveProperty('created_at');
    expect(c1).not.toHaveProperty('updated_at');
  });

  it('enriches each recipient with the tenant display name; honest absence when unknown', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const named = seedTenant(world, 'c-named');
    named.firstName = 'Brianna';
    named.lastName = 'Whitfield';
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-named', sentAt: SENT_AT });
    // No contact row for c-ghost - the row must still serve, without a name.
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-ghost', sentAt: SENT_AT });

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    const namedRow = res.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-named');
    expect(namedRow.tenantName).toBe('Brianna Whitfield');
    const ghostRow = res.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-ghost');
    expect(ghostRow).not.toHaveProperty('tenantName');
  });

  it('returns [] for a real unit with zero recipients', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-empty');
    const res = await request(app)
      .get('/api/units/unit-empty/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([]);
  });

  it('404s for an unknown unit (matches GET /:unitId)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/units/nope/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/contacts/:contactId/listings-sent (BE4/C4 — "Listings sent")', () => {
  it('returns the contact listings-sent from listByContact (same row, inverse direction)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT, broadcastId: 'b-1' });

    const res = await request(app)
      .get('/api/contacts/c-1/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(1);
    expect(res.body.sent[0]).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });
    expect(res.body.sent[0]).not.toHaveProperty('response');
  });

  it('returns [] for a contact with no listings sent', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, 'c-none');
    const res = await request(app)
      .get('/api/contacts/c-none/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([]);
  });

  it('404s for an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/contacts/ghost/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('the two directions share row fields; units adds recipient facts', () => {
  it('a single seeded row surfaces in both units/recipients and contacts/listings-sent', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-x');
    seedTenant(world, 'c-x');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-x', contactId: 'c-x', sentAt: SENT_AT, broadcastId: 'b-x' });

    const byUnit = await request(app)
      .get('/api/units/unit-x/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const byContact = await request(app)
      .get('/api/contacts/c-x/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    // caseworkers D20 (plan 3.7): the units side ALSO carries the recipient's
    // type (and role when set); the contact side does not (its contact is the
    // page owner). Otherwise the two directions return the same row.
    expect(byUnit.body.recipients[0]).toEqual({ ...byContact.body.sent[0], type: 'tenant' });
    expect(byContact.body.sent[0]).not.toHaveProperty('type');
    expect(byContact.body.sent[0]).not.toHaveProperty('role');
  });
});

describe('share-sent-outcome D7: a pair no share counts is listed nowhere', () => {
  it('a row written counted: false through putShareMemory is absent from both GET routes, beside a counted row that is listed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    seedTenant(world, 'c-2');
    const failed = { attempt: '2026-09-28T10:00:00.000Z#SM1', conversationId: 'conv-1', state: 'failed' as const };
    expect(await world.listingSendsRepo.putShareMemory('unit-1', 'c-1', { shares: { 'b-1': failed }, counted: false, sentAt: undefined, broadcastId: undefined }, { token: undefined })).toBe(true);
    const counted = { attempt: '2026-09-28T10:00:00.000Z#SM2', conversationId: 'conv-2', state: 'counted' as const, by: 'acceptance' as const, countedAt: '2026-09-28T10:00:00.000Z' };
    expect(await world.listingSendsRepo.putShareMemory('unit-1', 'c-2', { shares: { 'b-1': counted }, counted: true, sentAt: counted.countedAt, broadcastId: 'b-1' }, { token: undefined })).toBe(true);

    const byUnit = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(byUnit.status).toBe(200);
    expect(byUnit.body.recipients.map((r: { contactId: string }) => r.contactId)).toEqual(['c-2']);

    const uncounted = await request(app)
      .get('/api/contacts/c-1/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(uncounted.status).toBe(200);
    expect(uncounted.body.sent).toEqual([]);

    const listed = await request(app)
      .get('/api/contacts/c-2/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(listed.body.sent).toEqual([{ contactId: 'c-2', unitId: 'unit-1', sentAt: '2026-09-28T10:00:00.000Z', via: 'broadcast', broadcastId: 'b-1' }]);
  });
});

describe('tour chip projection (listing-response-tour-chip section 5)', () => {
  it('recipients: a qualifying tour lights ONLY the matching (unit, tenant) row', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-2', sentAt: SENT_AT });
    // c-1 has a scheduled tour on unit-1; c-2 has none.
    await world.toursRepo.create({
      tourId: 'tour-c1',
      tenantId: 'c-1',
      unitId: 'unit-1',
      tourType: 'self_guided',
      status: 'scheduled',
    });

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    const c1 = res.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-1');
    const c2 = res.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-2');
    // Exact optional-field wire shape: tour is EXACTLY { tourId, state }.
    expect(c1).toEqual({ contactId: 'c-1', unitId: 'unit-1', sentAt: c1.sentAt, via: 'broadcast', tour: { tourId: 'tour-c1', state: 'scheduled' } });
    // c-2 (no tour) carries NO tour field (absent, not null).
    expect(c2).not.toHaveProperty('tour');
  });

  it('recipients E2: tenant A tour on unit X does not light unit Y or tenant B', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-x');
    seedUnit(world, 'unit-y');
    // unit-x sent to A and B; unit-y sent to A.
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-x', contactId: 'c-a', sentAt: SENT_AT });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-x', contactId: 'c-b', sentAt: SENT_AT });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-y', contactId: 'c-a', sentAt: SENT_AT });
    // Tenant A has a tour on unit-x ONLY.
    await world.toursRepo.create({
      tourId: 'tour-ax',
      tenantId: 'c-a',
      unitId: 'unit-x',
      tourType: 'self_guided',
      status: 'toured',
    });

    const xRes = await request(app)
      .get('/api/units/unit-x/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const yRes = await request(app)
      .get('/api/units/unit-y/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    const xA = xRes.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-a');
    const xB = xRes.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-b');
    const yA = yRes.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-a');
    // A's row on unit-x is lit.
    expect(xA.tour).toEqual({ tourId: 'tour-ax', state: 'toured' });
    // B's row on unit-x is NOT lit (tour belongs to A, not B).
    expect(xB).not.toHaveProperty('tour');
    // A's row on unit-y is NOT lit (tour is on unit-x, not unit-y).
    expect(yA).not.toHaveProperty('tour');
  });

  it('listings-sent: a qualifying tour lights ONLY the matching (unit, tenant) row', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedUnit(world, 'unit-2');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-2', contactId: 'c-1', sentAt: SENT_AT });
    // c-1 has a requested tour on unit-2 only.
    await world.toursRepo.create({
      tourId: 'tour-u2',
      tenantId: 'c-1',
      unitId: 'unit-2',
      tourType: 'self_guided',
      status: 'requested',
    });

    const res = await request(app)
      .get('/api/contacts/c-1/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    const r1 = res.body.sent.find((r: { unitId: string }) => r.unitId === 'unit-1');
    const r2 = res.body.sent.find((r: { unitId: string }) => r.unitId === 'unit-2');
    expect(r1).not.toHaveProperty('tour');
    expect(r2.tour).toEqual({ tourId: 'tour-u2', state: 'requested' });
  });

  it('E3 degrade: a tours-query failure serves 200 chipless rows and logs (recipients)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    world.toursRepo.listByUnit = async () => {
      throw new Error('tours GSI unavailable');
    };

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(1);
    expect(res.body.recipients[0]).not.toHaveProperty('tour');
    expect(
      capture.atLevel(40).some((l) => l['msg'] === 'recipients tour-chip hydration failed (best-effort)'),
    ).toBe(true);
  });

  it('E3 degrade: a tours-query failure serves 200 chipless rows and logs (listings-sent)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    world.toursRepo.listByTenant = async () => {
      throw new Error('tours GSI unavailable');
    };

    const res = await request(app)
      .get('/api/contacts/c-1/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(1);
    expect(res.body.sent[0]).not.toHaveProperty('tour');
    expect(
      capture.atLevel(40).some((l) => l['msg'] === 'listings-sent tour-chip hydration failed (best-effort)'),
    ).toBe(true);
  });
});

describe('PATCH /api/units/:unitId/recipients/:contactId is GONE (response label removed)', () => {
  it('404s -- the response PATCH route no longer exists', async () => {
    // Regression pin: the `response` label was removed end to end, so the manual
    // set-response route must be absent. An existing send row + a valid old-shape
    // body must still 404 (route gone), not 200/400.
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });

    const res = await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });

    expect(res.status).toBe(404);
    // No listing_reviewed milestone can be emitted anymore (the type is gone too).
    expect(world.activityEvents.filter((e) => String(e.type) === 'listing_reviewed')).toHaveLength(0);
  });
});

describe('listing-send memory writes (no `response` field)', () => {
  it('a later counted share refreshes the broadcastId attribution and preserves created_at', async () => {
    const { world } = makeWebhookHarness();
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'b-1' });
    const first = await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1');
    // A second share of the same unit to the same tenant, counted later.
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: '2026-06-17T10:00:00.000Z', broadcastId: 'b-2' });
    const resent = await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1');
    expect(resent?.broadcastId).toBe('b-2'); // attribution refreshed
    expect(resent?.sentAt).toBe('2026-06-17T10:00:00.000Z');
    expect(Object.keys(resent?.shares ?? {}).sort()).toEqual(['b-1', 'b-2']); // both shares remembered
    expect(resent?.created_at).toBe(first?.created_at); // first-write furniture preserved
    // No `response` label is ever written.
    expect(resent).not.toHaveProperty('response');
  });
});
describe('caseworkers D20: recipients rows carry the contact type and role', () => {
  it('a resolved row carries type (and role when it holds text); an unresolved row omits both; listings-sent is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-ten1');
    world.contacts.push({
      contactId: 'c-pt01',
      type: 'partner',
      status: 'active',
      phone: '+15550109001',
      firstName: 'Cora',
      lastName: 'Reyes',
      role: '  Caseworker  ',
    });
    world.contacts.push({ contactId: 'c-pt02', type: 'partner', status: 'active', phone: '+15550109002', role: '   ' });
    world.contacts.push({ contactId: 'c-ll01', type: 'landlord', status: 'active', phone: '+15550109003' });
    for (const contactId of ['c-ten1', 'c-pt01', 'c-pt02', 'c-ll01', 'c-gone']) {
      await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
    }

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.recipients as Array<Record<string, unknown>>).map((r) => [r['contactId'] as string, r]),
    );
    expect(byId.get('c-ten1')).toMatchObject({ type: 'tenant' });
    expect(byId.get('c-ten1')).not.toHaveProperty('role');
    expect(byId.get('c-pt01')).toMatchObject({ type: 'partner', role: 'Caseworker', tenantName: 'Cora Reyes' });
    // A blank role is no role.
    expect(byId.get('c-pt02')).toMatchObject({ type: 'partner' });
    expect(byId.get('c-pt02')).not.toHaveProperty('role');
    expect(byId.get('c-ll01')).toMatchObject({ type: 'landlord' });
    // No contact row: the fields are OMITTED, never null (ruling R3-F3).
    expect(byId.get('c-gone')).not.toHaveProperty('type');
    expect(byId.get('c-gone')).not.toHaveProperty('role');

    const contactSide = await request(app)
      .get('/api/contacts/c-pt01/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(contactSide.status).toBe(200);
    expect(contactSide.body.sent[0]).not.toHaveProperty('type');
    expect(contactSide.body.sent[0]).not.toHaveProperty('role');
  });

  it('a failed display batch serves the rows with neither names nor type (best-effort, never a 500)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // Named, so the OLD read path (getDisplaysByIds, not stubbed) would serve a
    // tenantName - the RED evidence that the route switched methods.
    const named = seedTenant(world, 'c-ten2');
    named.firstName = 'Tia';
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-ten2', sentAt: SENT_AT });
    world.contactsRepo.getRecipientDisplaysByIds = async () => {
      throw new Error('dynamo down');
    };

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.recipients[0]).not.toHaveProperty('tenantName');
    expect(res.body.recipients[0]).not.toHaveProperty('type');
    expect(res.body.recipients[0]).not.toHaveProperty('role');
  });
});
