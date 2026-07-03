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
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

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

  it('CONCURRENT double-convert: two simultaneous POSTs → exactly one 201 and one 409, exactly one placement, tour stamped with the winner', async () => {
    // The money test for the atomic-claim fix. It forces the exact concurrent
    // schedule the production race permits: BOTH requests pass the fast-path
    // read-check (tour still unconverted) BEFORE either writes. A gate on
    // toursRepo.get holds the first caller until the second has ALSO reached the
    // read-check, so both are inside the check-then-act window together. On the
    // pre-fix (check-then-act) route this produces TWO placements + two 201s;
    // the atomic claimConversion conditional write lets exactly one win.
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-race';
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

    // Barrier on get(): the first two read-check calls for THIS tour rendezvous
    // (both are held until the second arrives, then both proceed together).
    const origGet = world.toursRepo.get.bind(world.toursRepo);
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    world.toursRepo.get = async (id: string) => {
      const result = await origGet(id);
      if (id === tourId) {
        entered += 1;
        if (entered === 2) release();
        if (entered <= 2) await barrier;
      }
      return result;
    };

    const { app } = makeWebhookHarness({ world });
    const [a, b] = await Promise.all([
      authed(app).post('/api/placements/from-tour').send({ tourId }),
      authed(app).post('/api/placements/from-tour').send({ tourId }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(loser.body.error).toBe('tour_already_converted');
    const placementId = (winner.body.placement as Record<string, unknown>)['placementId'];

    // Exactly ONE placement exists for the tenant/unit — the orphan is gone.
    expect(world.placements.size).toBe(1);
    // The tour is stamped with the WINNER's placementId and closed.
    const storedTour = world.toursMap.get(tourId)!;
    expect(storedTour.convertedPlacementId).toBe(placementId);
    expect(storedTour.status).toBe('closed');
  });

  it('placements.create failure releases the claim: 500, tour left UNCONVERTED, a retry converts cleanly (201)', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-failpath';
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

    // Fail the FIRST placements.create only; the retry uses the real impl.
    const realCreate = world.placementsRepo.create.bind(world.placementsRepo);
    let failNext = true;
    world.placementsRepo.create = async (input) => {
      if (failNext) {
        failNext = false;
        throw new Error('injected placements.create failure');
      }
      return realCreate(input);
    };

    const { app } = makeWebhookHarness({ world });
    const failed = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(failed.status).toBe(500);

    // The claim was RELEASED: no sentinel, status unchanged, no placement row.
    const afterFail = world.toursMap.get(tourId)!;
    expect(afterFail.convertedPlacementId).toBeUndefined();
    expect(afterFail.status).toBe('toured');
    expect(world.placements.size).toBe(0);

    // A follow-up convert now succeeds cleanly.
    const ok = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(ok.status).toBe(201);
    expect(world.placements.size).toBe(1);
    const finalTour = world.toursMap.get(tourId)!;
    expect(finalTour.status).toBe('closed');
    expect(finalTour.convertedPlacementId).toBe(
      (ok.body.placement as Record<string, unknown>)['placementId'],
    );
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
