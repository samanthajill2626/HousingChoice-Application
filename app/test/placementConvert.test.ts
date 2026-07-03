// Post-Tour & Application conversion tests — POST /api/placements/from-tour.
//
//   POST /api/placements/from-tour { tourId } → 201 { placement, tour }
//
// Creates a placement from a CONVERTIBLE tour, finalizes the tour (closed +
// convertedPlacementId + reminders canceled) and re-parents the tour's masked
// relay thread to the placement. QUIET conversion (no announcement is sent).
//
// Mirrors toursApi.test.ts: in-memory fakes via makeWebhookHarness (no DynamoDB,
// no network), authed via the seeded dev session cookie.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

/** Seed a tenant contact (searching), a unit (available), into the world. */
function seedTenantAndUnit(world: FakeWorld): { tenantId: string; unitId: string; landlordId: string } {
  const tenantId = 'tenant-convert-1';
  const unitId = 'unit-convert-1';
  const landlordId = 'll-convert-1';
  world.contacts.push({ contactId: tenantId, type: 'tenant', status: 'searching' });
  world.contacts.push({ contactId: landlordId, type: 'landlord', phone: '+15550300002' });
  world.units.set(unitId, {
    unitId,
    landlordId,
    status: 'available',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  });
  return { tenantId, unitId, landlordId };
}

describe('POST /api/placements/from-tour — conversion', () => {
  it('happy path: converts a convertible tour with a group thread, finalizes tour, rebinds thread, derives tenant → placing, cancels reminders', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    // A tour-owned relay group thread already exists for the tour.
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550309999',
      members: [{ phone: '+15550300001', contactId: tenantId }],
      owner: { type: 'tour', id: 'tour-convert-1' },
    });
    const groupThreadId = conversation.conversationId;

    // A convertible, toured tour carrying that thread.
    const tourId = 'tour-convert-1';
    world.toursMap.set(tourId, {
      tourId,
      tenantId,
      unitId,
      tourType: 'landlord_led',
      status: 'toured',
      convertible: true,
      groupThreadId,
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    // Two pending reminder rows for the tour (to prove cancel-on-convert).
    await world.tourRemindersRepo.create({ tourId, kind: 'confirmation', dueAt: '2026-07-15T10:00:00.000Z' });
    await world.tourRemindersRepo.create({ tourId, kind: 'day_before', dueAt: '2026-07-14T10:00:00.000Z' });

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });

    expect(res.status).toBe(201);
    const placement = res.body.placement as Record<string, unknown>;
    const placementId = placement['placementId'] as string;
    expect(placementId).toBeTruthy();
    expect(placement['stage']).toBe('send_application');
    expect(placement['fromTourId']).toBe(tourId);
    expect(placement['group_thread']).toBe(groupThreadId);

    // The tour is finalized: closed + convertedPlacementId, in the response and stored.
    expect((res.body.tour as Record<string, unknown>)['status']).toBe('closed');
    expect((res.body.tour as Record<string, unknown>)['convertedPlacementId']).toBe(placementId);
    const storedTour = world.toursMap.get(tourId)!;
    expect(storedTour.status).toBe('closed');
    expect(storedTour.convertedPlacementId).toBe(placementId);

    // The relay thread is re-parented to the placement (metadata-only).
    const storedConv = world.conversations.get(groupThreadId)!;
    expect(storedConv.owner).toEqual({ type: 'placement', id: placementId });
    expect(storedConv.placementId).toBe(placementId);

    // deriveForStage stamped the tenant coarse status → placing.
    const tenant = world.contacts.find((c) => c.contactId === tenantId);
    expect(tenant?.status).toBe('placing');

    // The tour's pending reminder rows were canceled.
    const pending = [...world.tourRemindersMap.values()].filter(
      (r) => r.tourId === tourId && r.sentAt === undefined && r.canceledAt === undefined,
    );
    expect(pending).toHaveLength(0);
  });

  it('no groupThreadId on the tour → 201 with no group_thread and no rebind', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-nothread';
    world.toursMap.set(tourId, {
      tourId,
      tenantId,
      unitId,
      tourType: 'self_guided',
      status: 'toured',
      convertible: true,
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });

    expect(res.status).toBe(201);
    const placement = res.body.placement as Record<string, unknown>;
    expect(placement['group_thread']).toBeUndefined();
    expect(placement['fromTourId']).toBe(tourId);
    // Tour still finalized.
    expect((res.body.tour as Record<string, unknown>)['status']).toBe('closed');
  });

  it('tour not convertible (convertible absent) → 409 tour_not_convertible, no placement created', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-notyet';
    world.toursMap.set(tourId, {
      tourId,
      tenantId,
      unitId,
      tourType: 'landlord_led',
      status: 'toured',
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tour_not_convertible');
    expect(world.placements.size).toBe(0);
  });

  it('second convert of the same tour → 409 tour_already_converted', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-twice';
    world.toursMap.set(tourId, {
      tourId,
      tenantId,
      unitId,
      tourType: 'landlord_led',
      status: 'toured',
      convertible: true,
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    const first = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(first.status).toBe(201);

    const second = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('tour_already_converted');
    // No second placement created.
    expect(world.placements.size).toBe(1);
  });

  it('bad body: unknown field → 400; missing tourId → 400; ghost tourId → 404 tour_not_found', async () => {
    const { app } = makeWebhookHarness();

    const unknown = await authed(app).post('/api/placements/from-tour').send({ tourId: 'x', bogus: 'y' });
    expect(unknown.status).toBe(400);

    const missing = await authed(app).post('/api/placements/from-tour').send({});
    expect(missing.status).toBe(400);

    const ghost = await authed(app).post('/api/placements/from-tour').send({ tourId: 'no-such-tour' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe('tour_not_found');
  });
});
