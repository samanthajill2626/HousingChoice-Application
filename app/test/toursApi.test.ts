// Tours API tests — /api/tours (Task 3 + Task 5 relay route).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt, tourType }  → 201 { tour }
//   GET   /api/tours/:tourId                                        → { tour } | 404
//   GET   /api/tours?tenantId=&unitId=&from=&to=                    → { tours }
//   PATCH /api/tours/:tourId                                        → { tour } | 404
//   POST  /api/tours/:tourId/relay  { members? }                    → 201 { tour, conversation }
//
// Mirrors unitsApi.test.ts: in-memory fakes via makeWebhookHarness, no DynamoDB.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import {
  RelayProvisioningDisabledError,
  type PoolNumbersService,
} from '../src/services/poolNumbers.js';
import { VoiceCapabilityError } from '../src/adapters/messaging.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

// ---- helpers ---------------------------------------------------------------

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

const BASE_CREATE_BODY = {
  tenantId: 'contact-tenant-1',
  unitId: 'unit-abc',
  scheduledAt: '2026-07-15T10:00:00.000Z',
  tourType: 'self_guided',
};

// ============================================================================
// POST /api/tours — create
// ============================================================================

describe('POST /api/tours — create', () => {
  it('creates a tour, defaults status to scheduled, returns 201', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.tour).toMatchObject({
      tenantId: 'contact-tenant-1',
      unitId: 'unit-abc',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'self_guided',
      status: 'scheduled',
    });
    expect(res.body.tour.tourId).toBeDefined();
    expect(world.toursMap.size).toBe(1);
  });

  it('returns 400 for missing required fields', async () => {
    const { app } = makeWebhookHarness();
    const cases = [
      {}, // nothing
      { unitId: 'u', scheduledAt: '2026-07-15T10:00:00.000Z', tourType: 'self_guided' }, // no tenantId
      { tenantId: 't', scheduledAt: '2026-07-15T10:00:00.000Z', tourType: 'self_guided' }, // no unitId
      // NOTE: no-scheduledAt is NOT here — it's a valid timeless create (status 'requested').
      { tenantId: 't', unitId: 'u', scheduledAt: '2026-07-15T10:00:00.000Z' }, // no tourType
      { tenantId: 't', unitId: 'u', scheduledAt: 'not-a-date', tourType: 'self_guided' }, // bad date
      { tenantId: 't', unitId: 'u', scheduledAt: '2026-07-15T10:00:00.000Z', tourType: 'bad_type' }, // bad tourType
    ];
    for (const body of cases) {
      const res = await authed(app).post('/api/tours').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects unknown fields with 400', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app)
      .post('/api/tours')
      .send({ ...BASE_CREATE_BODY, bogusField: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown field/);
  });

  it('accepts all three tourType values', async () => {
    const { app } = makeWebhookHarness();
    for (const tourType of ['self_guided', 'landlord_led', 'pm_team']) {
      const res = await authed(app)
        .post('/api/tours')
        .send({ ...BASE_CREATE_BODY, tourType });
      expect(res.status, tourType).toBe(201);
      expect(res.body.tour.tourType).toBe(tourType);
    }
  });
});

// ============================================================================
// GET /api/tours/:tourId — fetch one
// ============================================================================

describe('GET /api/tours/:tourId', () => {
  it('returns the tour when found, 404 when not found', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    const ok = await authed(app).get(`/api/tours/${tourId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.tour).toMatchObject({ tourId, status: 'scheduled' });

    const missing = await authed(app).get('/api/tours/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'tour_not_found' });
  });
});

// ============================================================================
// GET /api/tours — list
// ============================================================================

describe('GET /api/tours — list', () => {
  it('lists by tenantId', async () => {
    const { app } = makeWebhookHarness();
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, tenantId: 'tenant-A' });
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, tenantId: 'tenant-A' });
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, tenantId: 'tenant-B' });

    const res = await authed(app).get('/api/tours?tenantId=tenant-A');
    expect(res.status).toBe(200);
    expect(res.body.tours).toHaveLength(2);
    for (const t of res.body.tours) expect(t.tenantId).toBe('tenant-A');
  });

  it('lists by unitId', async () => {
    const { app } = makeWebhookHarness();
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, unitId: 'unit-X' });
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, unitId: 'unit-Y' });

    const res = await authed(app).get('/api/tours?unitId=unit-X');
    expect(res.status).toBe(200);
    expect(res.body.tours).toHaveLength(1);
    expect(res.body.tours[0].unitId).toBe('unit-X');
  });

  it('lists by scheduled range (from+to)', async () => {
    const { app } = makeWebhookHarness();
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, scheduledAt: '2026-07-10T09:00:00.000Z' });
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, scheduledAt: '2026-07-15T10:00:00.000Z' });
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, scheduledAt: '2026-07-20T12:00:00.000Z' });

    const res = await authed(app).get('/api/tours?from=2026-07-11T00:00:00.000Z&to=2026-07-16T00:00:00.000Z');
    expect(res.status).toBe(200);
    expect(res.body.tours).toHaveLength(1);
    expect(res.body.tours[0].scheduledAt).toBe('2026-07-15T10:00:00.000Z');
  });

  it('returns 400 when no filter is supplied', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid from/to dates in range query', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours?from=bad&to=also-bad');
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// PATCH /api/tours/:tourId — update / status transitions / exit gate
// ============================================================================

describe('PATCH /api/tours/:tourId', () => {
  it('reschedules a no_show tour back to scheduled (canReschedule path)', async () => {
    const { app } = makeWebhookHarness();
    // Create a tour, manually set it to no_show via status PATCH, then reschedule.
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // Move to no_show.
    const toNoShow = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' });
    expect(toNoShow.status).toBe(200);
    expect(toNoShow.body.tour.status).toBe('no_show');

    // Reschedule (no_show → scheduled with new scheduledAt).
    const newTime = '2026-08-01T14:00:00.000Z';
    const reschedule = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ status: 'scheduled', scheduledAt: newTime });
    expect(reschedule.status).toBe(200);
    expect(reschedule.body.tour.status).toBe('scheduled');
    expect(reschedule.body.tour.scheduledAt).toBe(newTime);
  });

  it('records the exit gate: outcome + moveForward → convertible:true', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // The exit gate records a decision on a TOURED tour (guard added by the
    // whole-branch review) — mark it toured first, as the dashboard does.
    const toured = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    expect(toured.status).toBe(200);

    // Record the exit gate.
    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true });
    expect(res.status).toBe(200);
    expect(res.body.tour.outcome).toBe('move_forward');
    expect(res.body.tour.moveForward).toBe(true);
    expect(res.body.tour.convertible).toBe(true);

    // No placement was created, no tenant status was changed.
    expect(world.placements.size).toBe(0);
    // The response shape contains only tour fields — no placementId, no tenantStatus change.
    expect(res.body.tour.placementId).toBeUndefined();

    // The stored tour reflects the exit gate but tenant status is untouched.
    const storedTour = world.toursMap.get(tourId)!;
    expect(storedTour.convertible).toBe(true);
    expect(storedTour.moveForward).toBe(true);
    expect(storedTour.outcome).toBe('move_forward');
  });

  it('exit gate with moveForward:false → convertible:false', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });

    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'not_a_fit', moveForward: false });
    expect(res.status).toBe(200);
    expect(res.body.tour.outcome).toBe('not_a_fit');
    expect(res.body.tour.moveForward).toBe(false);
    expect(res.body.tour.convertible).toBe(false);
  });

  // D5 close-nag safety net (relay-number-lifecycle AF-1/CF-1): a terminal tour
  // event (canceled or exit-gate not-a-fit) whose linked relay group is still
  // OPEN arms the 28-day close-nag (set-if-absent). A move-forward exit does NOT
  // (it continues into a placement and keeps the thread). Backend arm.
  async function seedTouredTourWithOpenGroup(
    app: ReturnType<typeof makeWebhookHarness>['app'],
    world: FakeWorld,
    poolNumber: string,
  ): Promise<{ tourId: string; groupId: string }> {
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    const group = await world.conversationsRepo.createRelayGroup({
      poolNumber,
      members: [{ phone: '+15550100001', contactId: '', name: 'Alice' }],
    });
    // Link the group to the tour, then move the tour to 'toured' (exit-gate ready).
    world.toursMap.get(tourId)!.groupThreadId = group.conversationId;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    return { tourId, groupId: group.conversationId };
  }

  it('exit-gate "not a fit" (moveForward:false) arms the close-nag on the linked OPEN group (AF-1)', async () => {
    const { app, world } = makeWebhookHarness();
    const { tourId, groupId } = await seedTouredTourWithOpenGroup(app, world, '+15550100080');
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'not_a_fit', moveForward: false, status: 'closed' });
    expect((await world.conversationsRepo.getById(groupId))!.close_nag_next_at).toBeDefined();
  });

  it('a move-forward exit gate does NOT arm the close-nag (thread continues into the placement)', async () => {
    const { app, world } = makeWebhookHarness();
    const { tourId, groupId } = await seedTouredTourWithOpenGroup(app, world, '+15550100082');
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true });
    expect((await world.conversationsRepo.getById(groupId))!.close_nag_next_at).toBeUndefined();
  });

  it('canceling a tour arms the close-nag on its linked OPEN group (AF-1)', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    const group = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550100081',
      members: [{ phone: '+15550100001', contactId: '', name: 'Alice' }],
    });
    world.toursMap.get(tourId)!.groupThreadId = group.conversationId;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect((await world.conversationsRepo.getById(group.conversationId))!.close_nag_next_at).toBeDefined();
  });

  it('rejects illegal transition: closed → scheduled (409)', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // Move to closed.
    const toClosed = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ status: 'closed' });
    expect(toClosed.status).toBe(200);
    expect(toClosed.body.tour.status).toBe('closed');

    // Attempt closed → scheduled: must be rejected.
    const illegal = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ status: 'scheduled' });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error).toBe('illegal_status_transition');
  });

  it('rejects reschedule from toured status (non-reschedulable via scheduledAt alone)', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    // Move to toured.
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });

    // Attempt scheduledAt-only patch from toured — not reschedulable.
    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-09-01T10:00:00.000Z' });
    expect(res.status).toBe(409);
  });

  it('returns 404 on PATCH for unknown tourId', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app)
      .patch('/api/tours/no-such-tour')
      .send({ status: 'canceled' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tour_not_found' });
  });

  it('returns 400 for empty patch and unknown fields', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const emptyRes = await authed(app).patch(`/api/tours/${tourId}`).send({});
    expect(emptyRes.status).toBe(400);

    const unknownRes = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ bogus: 'x' });
    expect(unknownRes.status).toBe(400);
  });

  it('returns 400 for invalid status / outcome values', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const badStatus = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ status: 'bad_status' });
    expect(badStatus.status).toBe(400);

    const badOutcome = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'dunno' });
    expect(badOutcome.status).toBe(400);
  });

  it("PATCH { status: 'confirmed' } is a plain 400 invalid-status error (the status was removed 2026-07-08)", async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    // The removed value fails the isTourStatus field validation FIRST - the
    // natural 400 with the existing invalid-field error shape, NOT a special
    // 409 (orchestrator decision E-B2). The enum listing must not offer it.
    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'confirmed' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'status must be one of: requested, scheduled, toured, no_show, canceled, closed',
    });

    // The tour is untouched (still scheduled).
    expect(world.toursMap.get(tourId)?.status).toBe('scheduled');
  });
});

// ============================================================================
// tour_took_place milestone — recorded on the transition INTO 'toured'
// (Post-Tour & Application Task 2; resolves docs/issues/tour-took-place-milestone)
// ============================================================================

describe('PATCH → toured records the tour_took_place activity milestone', () => {
  it('records exactly one tour_took_place (refType tour, refId tourId) on scheduled → toured', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;
    const tenantId = BASE_CREATE_BODY.tenantId;

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    expect(res.status).toBe(200);

    const { items } = await world.activityEventsRepo.listByContact(tenantId);
    const milestones = items.filter((e) => e.type === 'tour_took_place');
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toMatchObject({
      contactId: tenantId,
      type: 'tour_took_place',
      label: 'Tour took place',
      refType: 'tour',
      refId: tourId,
    });
  });

  it('is idempotent: re-PATCHing an already-toured tour does NOT re-emit', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    const tenantId = BASE_CREATE_BODY.tenantId;

    const first = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    expect(first.status).toBe(200);
    const second = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    expect(second.status).toBe(200);

    const { items } = await world.activityEventsRepo.listByContact(tenantId);
    expect(items.filter((e) => e.type === 'tour_took_place')).toHaveLength(1);
  });

  it('does not emit tour_took_place for a non-toured transition', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    const tenantId = BASE_CREATE_BODY.tenantId;

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(res.status).toBe(200);

    const { items } = await world.activityEventsRepo.listByContact(tenantId);
    expect(items.filter((e) => e.type === 'tour_took_place')).toHaveLength(0);
  });
});

// ============================================================================
// Tour lifecycle → tenant activity timeline + property (unit) audit (WS4)
// Dual-write on create-scheduled AND each surfaced PATCH transition.
// ============================================================================

describe('PATCH/POST /api/tours — activity + property audit propagation', () => {
  function seedUnit(world: FakeWorld): void {
    world.units.set('unit-abc', {
      unitId: 'unit-abc',
      landlordId: 'c-ll',
      status: 'available',
      jurisdiction: 'DCA',
      beds: 2,
      baths: 1,
      rent_min: 1200,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    });
  }

  async function seedScheduledTour(
    app: ReturnType<typeof makeWebhookHarness>['app'],
    world: FakeWorld,
  ): Promise<string> {
    seedUnit(world);
    const res = await authed(app).post('/api/tours').send(BASE_CREATE_BODY); // status 'scheduled'
    expect(res.status).toBe(201);
    return res.body.tour.tourId as string;
  }

  it('emits tour_scheduled activity + units# tour_scheduled audit on create-scheduled', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    expect(
      world.activityEvents.filter((e) => e.type === 'tour_scheduled' && e.refId === tourId),
    ).toHaveLength(1);
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_scheduled',
      ),
    ).toHaveLength(1);
  });

  it('emits NOTHING on a timeless (requested) create', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    const res = await authed(app)
      .post('/api/tours')
      .send({ tenantId: 'contact-tenant-1', unitId: 'unit-abc', tourType: 'self_guided' });
    expect(res.status).toBe(201);
    expect(res.body.tour.status).toBe('requested');
    expect(world.activityEvents.filter((e) => e.type === 'tour_scheduled')).toHaveLength(0);
    expect(world.auditEvents.filter((e) => e.event_type === 'tour_scheduled')).toHaveLength(0);
  });

  it('emits tour_canceled to tenant + property on cancel, once (idempotent)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' }).expect(200);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' }).expect(200); // re-write, no re-emit
    expect(world.activityEvents.filter((e) => e.type === 'tour_canceled')).toHaveLength(1);
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_canceled',
      ),
    ).toHaveLength(1);
  });

  it('emits tour_no_show to tenant + property on the no_show transition', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' }).expect(200);
    expect(world.activityEvents.filter((e) => e.type === 'tour_no_show')).toHaveLength(1);
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_no_show',
      ),
    ).toHaveLength(1);
  });

  it('emits tour_scheduled/tour_rescheduled audit on a reschedule (time-only change)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-07-20T14:00:00.000Z' })
      .expect(200);
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_rescheduled',
      ),
    ).toHaveLength(1);
    // The tenant activity for a reschedule is the tour_scheduled type.
    expect(
      world.activityEvents.filter((e) => e.type === 'tour_scheduled' && e.refId === tourId),
    ).toHaveLength(2); // one on create + one on reschedule

    // No-op reschedule (MINOR 5): re-PATCH the IDENTICAL time -> nothing new on
    // any surface (the units# audit and the tenant activity both stay put).
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-07-20T14:00:00.000Z' })
      .expect(200);
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_rescheduled',
      ),
    ).toHaveLength(1);
    expect(
      world.activityEvents.filter((e) => e.type === 'tour_scheduled' && e.refId === tourId),
    ).toHaveLength(2);
  });

  it('emits tour_took_place and tour_outcome on the toured→outcome path', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true })
      .expect(200);
    expect(world.activityEvents.filter((e) => e.type === 'tour_took_place')).toHaveLength(1);
    expect(world.activityEvents.filter((e) => e.type === 'tour_outcome')).toHaveLength(1);
    expect(
      world.activityEvents.find((e) => e.type === 'tour_outcome')?.label,
    ).toContain('moved forward');
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_took_place',
      ),
    ).toHaveLength(1);
    expect(
      world.auditEvents.filter(
        (e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_outcome',
      ),
    ).toHaveLength(1);
  });

  it('is idempotent on the exit gate: a second identical outcome PATCH does not re-emit', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await seedScheduledTour(app, world);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'not_a_fit', moveForward: false })
      .expect(200);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'not_a_fit', moveForward: false })
      .expect(200);
    expect(world.activityEvents.filter((e) => e.type === 'tour_outcome')).toHaveLength(1);
    expect(
      world.activityEvents.find((e) => e.type === 'tour_outcome')?.label,
    ).toContain('not a fit');
  });
});

// ============================================================================
// tours#<tourId> audit trail - the THIRD recordTourEvent write
// (tour-detail-page 1a; feeds GET /api/tours/:tourId/activity)
// ============================================================================

describe('tours#<tourId> audit trail (third best-effort write)', () => {
  const toursAudit = (world: FakeWorld, tourId: string) =>
    world.auditEvents.filter((e) => e.entityKey === `tours#${tourId}`);

  async function createScheduled(app: ReturnType<typeof makeWebhookHarness>['app']): Promise<string> {
    const res = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(res.status).toBe(201);
    return res.body.tour.tourId as string;
  }

  it('create-scheduled writes tours# tour_scheduled (alongside tenant + units# writes)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    const rows = toursAudit(world, tourId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityKey: `tours#${tourId}`,
      event_type: 'tour_scheduled',
      payload: { tourId },
    });
    // The existing two surfaces are UNCHANGED by the third write.
    expect(world.activityEvents.filter((e) => e.type === 'tour_scheduled' && e.refId === tourId)).toHaveLength(1);
    expect(
      world.auditEvents.filter((e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_scheduled'),
    ).toHaveLength(1);
  });

  it('a timeless (requested) create writes NO tours# row', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app)
      .post('/api/tours')
      .send({ tenantId: 'contact-tenant-1', unitId: 'unit-abc', tourType: 'self_guided' });
    expect(res.status).toBe(201);
    expect(toursAudit(world, res.body.tour.tourId as string)).toHaveLength(0);
  });

  it('booking a requested tour (into-scheduled) writes tours# tour_scheduled', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app)
      .post('/api/tours')
      .send({ tenantId: 'contact-tenant-1', unitId: 'unit-abc', tourType: 'landlord_led' });
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: '2026-07-20T10:00:00.000Z' }).expect(200);
    const rows = toursAudit(world, tourId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('tour_scheduled');
  });

  it('a reschedule (bare time change while scheduled) writes tours# tour_rescheduled', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: '2026-07-21T10:00:00.000Z' }).expect(200);
    expect(toursAudit(world, tourId).map((e) => e.event_type)).toEqual([
      'tour_scheduled',
      'tour_rescheduled',
    ]);
  });

  it('a no-op reschedule to the SAME time writes NO extra tours# row (MINOR 5)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: '2026-07-21T10:00:00.000Z' }).expect(200);
    // Re-PATCH the identical time: idempotent, like the INTO-status milestones.
    await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: '2026-07-21T10:00:00.000Z' }).expect(200);
    expect(toursAudit(world, tourId).map((e) => e.event_type)).toEqual([
      'tour_scheduled',
      'tour_rescheduled',
    ]);
  });

  it('toured writes tours# tour_took_place (idempotent - a re-PATCH does not re-write)', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    expect(
      toursAudit(world, tourId).filter((e) => e.event_type === 'tour_took_place'),
    ).toHaveLength(1);
  });

  it('no_show writes tours# tour_no_show', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' }).expect(200);
    expect(toursAudit(world, tourId).filter((e) => e.event_type === 'tour_no_show')).toHaveLength(1);
  });

  it('canceled writes tours# tour_canceled', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' }).expect(200);
    expect(toursAudit(world, tourId).filter((e) => e.event_type === 'tour_canceled')).toHaveLength(1);
  });

  it('the exit gate writes tours# tour_outcome', async () => {
    const { app, world } = makeWebhookHarness();
    const tourId = await createScheduled(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true })
      .expect(200);
    expect(toursAudit(world, tourId).filter((e) => e.event_type === 'tour_outcome')).toHaveLength(1);
  });

  it('a failing tours# write must NOT fail the mutation nor the other two surfaces (best-effort)', async () => {
    const world = createFakeWorld();
    const realAppend = world.auditRepo.append.bind(world.auditRepo);
    world.auditRepo.append = async (entityKey, eventType, payload) => {
      if (entityKey.startsWith('tours#')) throw new Error('injected tours# audit failure');
      return realAppend(entityKey, eventType, payload);
    };
    const { app } = makeWebhookHarness({ world });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201); // create survived the failing third write
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    expect(res.status).toBe(200); // the operator mutation never fails

    // The tenant-timeline + units# writes still landed; tours# has nothing.
    expect(world.activityEvents.filter((e) => e.type === 'tour_took_place')).toHaveLength(1);
    expect(
      world.auditEvents.filter((e) => e.entityKey === 'units#unit-abc' && e.event_type === 'tour_took_place'),
    ).toHaveLength(1);
    expect(world.auditEvents.filter((e) => e.entityKey.startsWith('tours#'))).toHaveLength(0);
  });
});

// ============================================================================
// GET /api/tours/:tourId/activity - the tour page's Activity read
// (placement-history paging pattern: limit + before; E-D1)
// ============================================================================

describe('GET /api/tours/:tourId/activity', () => {
  async function walkLifecycle(
    app: ReturnType<typeof makeWebhookHarness>['app'],
  ): Promise<string> {
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY); // tour_scheduled
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200); // tour_took_place
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true })
      .expect(200); // tour_outcome
    return tourId;
  }

  it('returns { events } newest-first with the fixed-key projection (id/at/type + payload whitelist)', async () => {
    const { app } = makeWebhookHarness();
    const tourId = await walkLifecycle(app);

    const res = await authed(app).get(`/api/tours/${tourId}/activity`);
    expect(res.status).toBe(200);
    const events = res.body.events as Record<string, unknown>[];
    expect(events.map((e) => e['type'])).toEqual([
      'tour_outcome',
      'tour_took_place',
      'tour_scheduled',
    ]);
    for (const e of events) {
      expect(typeof e['id']).toBe('string');
      expect(typeof e['at']).toBe('string');
      // at is the ISO prefix of the id SK.
      expect((e['id'] as string).startsWith(e['at'] as string)).toBe(true);
      expect(e['tourId']).toBe(tourId);
      // Fixed-key whitelist: the raw payload document never leaks through.
      expect(e['payload']).toBeUndefined();
    }
  });

  it('never leaks unknown payload keys (fixed-key whitelist)', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    // A poison row written straight to the trail: only whitelisted keys survive.
    await world.auditRepo.append(`tours#${tourId}`, 'tour_scheduled', {
      tourId,
      phone: '+15555550000',
      body: 'secret message text',
    });

    const res = await authed(app).get(`/api/tours/${tourId}/activity`);
    expect(res.status).toBe(200);
    for (const e of res.body.events as Record<string, unknown>[]) {
      expect(e['phone']).toBeUndefined();
      expect(e['body']).toBeUndefined();
    }
  });

  it('honors ?limit= and pages backward with ?before= (no overlap, no gap)', async () => {
    const { app } = makeWebhookHarness();
    const tourId = await walkLifecycle(app); // 3 rows

    const page1 = await authed(app).get(`/api/tours/${tourId}/activity?limit=2`);
    expect(page1.status).toBe(200);
    const rows1 = page1.body.events as { id: string; type: string }[];
    expect(rows1).toHaveLength(2);
    expect(rows1.map((e) => e.type)).toEqual(['tour_outcome', 'tour_took_place']);

    const cursor = rows1[rows1.length - 1]!.id;
    const page2 = await authed(app).get(
      `/api/tours/${tourId}/activity?limit=2&before=${encodeURIComponent(cursor)}`,
    );
    expect(page2.status).toBe(200);
    const rows2 = page2.body.events as { id: string; type: string }[];
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.type).toBe('tour_scheduled');
    // No overlap between pages.
    const ids1 = new Set(rows1.map((e) => e.id));
    expect(rows2.some((e) => ids1.has(e.id))).toBe(false);
  });

  it('returns an empty trail for a tour with no history (timeless create)', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app)
      .post('/api/tours')
      .send({ tenantId: 'contact-tenant-1', unitId: 'unit-abc', tourType: 'self_guided' });
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).get(`/api/tours/${tourId}/activity`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it('404 tour_not_found for an unknown tour', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours/no-such-tour/activity');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tour_not_found' });
  });

  it('400 for an invalid ?limit=', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    for (const bad of ['0', '-1', 'abc', '101', '1.5']) {
      const res = await authed(app).get(`/api/tours/${tourId}/activity?limit=${bad}`);
      expect(res.status, `limit=${bad}`).toBe(400);
    }
  });
});

// ============================================================================
// tour.updated bus event (tour-detail-page 1a) - emitted after successful
// PATCH mutations and relay provisioning; mirrors placement.updated plumbing.
// ============================================================================

describe('tour.updated bus emissions', () => {
  const tourUpdates = (world: FakeWorld) => world.emitted.filter((e) => e.event === 'tour.updated');

  it('a successful status PATCH emits tour.updated { tourId, status }', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    expect(tourUpdates(world)).toHaveLength(0); // create does not emit (1a scope)

    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    expect(tourUpdates(world)).toHaveLength(1);
    expect(tourUpdates(world)[0]!.payload).toEqual({ tourId, status: 'toured' });
  });

  it('a reschedule PATCH emits tour.updated with the post-patch status', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-07-22T10:00:00.000Z' })
      .expect(200);
    expect(tourUpdates(world)).toHaveLength(1);
    expect(tourUpdates(world)[0]!.payload).toEqual({ tourId, status: 'scheduled' });
  });

  it('a REJECTED patch (409 illegal transition / 400 invalid field) emits nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'closed' }).expect(200);
    const afterClose = tourUpdates(world).length;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'scheduled' }).expect(409);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'bogus' }).expect(400);
    expect(tourUpdates(world)).toHaveLength(afterClose);
  });
});

// ============================================================================
// Whole-branch-review hardening — transition guards, effective-status reminder
// side effects, scheduledAt canonicalization, exit-gate status coupling
// ============================================================================

describe('PATCH guards: requested lifecycle + exit-gate coupling', () => {
  const TIMELESS_BODY = { tenantId: 'contact-tenant-1', unitId: 'unit-abc', tourType: 'landlord_led' };

  it("rejects moving any tour BACK to 'requested' (create-only state)", async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'requested' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('illegal_status_transition');
  });

  it("a requested tour can only be booked or canceled - toured/no_show/closed are 409", async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(TIMELESS_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    for (const target of ['toured', 'no_show', 'closed']) {
      const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: target });
      expect(res.status, `requested → ${target}`).toBe(409);
      expect(res.body.error).toBe('illegal_status_transition');
    }

    // Canceling a requested lead is fine.
    const canceled = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(canceled.status).toBe(200);
    expect(canceled.body.tour.status).toBe('canceled');
  });

  it('the exit gate requires a toured tour (409 on scheduled, immutable once closed)', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    // On a scheduled tour: refused.
    const early = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('illegal_exit_gate');

    // Record it properly, close, then try to rewrite the decision: refused —
    // convertible must be immutable after closure (Post-Tour conversion trusts it).
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    await authed(app).patch(`/api/tours/${tourId}`).send({ outcome: 'not_a_fit', moveForward: false });
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'closed' });
    const rewrite = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true });
    expect(rewrite.status).toBe(409);
  });
});

describe('Reminder side effects key on the EFFECTIVE post-patch status', () => {
  const pendingRows = (world: FakeWorld, tourId: string) =>
    [...world.tourRemindersMap.values()].filter(
      (r) => r.tourId === tourId && r.sentAt === undefined && r.canceledAt === undefined,
    );

  it('PATCH {scheduledAt, status:canceled} cancels — it must NOT arm a ladder on a dead tour', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    expect(pendingRows(world, tourId).length).toBeGreaterThan(0);

    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-08-01T15:00:00.000Z', status: 'canceled' });
    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('canceled');
    expect(pendingRows(world, tourId)).toHaveLength(0);
  });

  it("PATCH {status:'toured'} cancels the still-pending rungs (no 'missed your tour' after attending)", async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    expect(pendingRows(world, tourId).length).toBeGreaterThan(0);

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    expect(res.status).toBe(200);
    expect(pendingRows(world, tourId)).toHaveLength(0);
  });

  it('bare {scheduledAt} on a canceled tour auto-advances to scheduled and re-arms', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(pendingRows(world, tourId)).toHaveLength(0);

    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: '2026-08-02T15:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('scheduled');
    expect(pendingRows(world, tourId).length).toBeGreaterThan(0);
  });

  it("status-only revival {status:'scheduled'} on a canceled tour re-arms off the stored time", async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(pendingRows(world, tourId)).toHaveLength(0);

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'scheduled' });
    expect(res.status).toBe(200);
    expect(pendingRows(world, tourId).length).toBeGreaterThan(0);
  });

  it("status-only {status:'no_show'} cancels the pending rows (the check-in is a manual send now)", async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    const before = pendingRows(world, tourId).map((r) => r.reminderId).sort();
    expect(before.length).toBeGreaterThan(0);

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' });
    expect(res.status).toBe(200);
    // no_show is terminal for auto-reminders now: the pending rungs are canceled so
    // a tour flagged no-show never later fires "your tour is tomorrow". The
    // "want to reschedule?" check-in is sent manually, not as an armed rung.
    expect(pendingRows(world, tourId)).toHaveLength(0);
  });
});

describe('scheduledAt is canonicalized (toISOString) at the route boundary', () => {
  it('POST stores a canonical form for a ms-less UTC input', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app)
      .post('/api/tours')
      .send({ ...BASE_CREATE_BODY, scheduledAt: '2026-07-15T10:00:00Z' });
    expect(res.status).toBe(201);
    expect(res.body.tour.scheduledAt).toBe('2026-07-15T10:00:00.000Z');
  });

  it('PATCH canonicalizes a raw datetime-local value (dashboard Book/Reschedule shape)', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const raw = '2026-08-03T14:30'; // zoneless datetime-local
    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: raw });
    expect(res.status).toBe(200);
    // Whatever instant the server resolves the zoneless string to, the STORED
    // value is the canonical toISOString() of it — lexicographically comparable
    // in the sparse byScheduledAt GSI and unambiguous for computeDueAt.
    expect(res.body.tour.scheduledAt).toBe(new Date(raw).toISOString());
  });
});

// ============================================================================
// Exit gate discipline — NO placement / NO tenant-status side effects
// ============================================================================

describe('Exit gate: NO placement created, tenant status untouched', () => {
  it('PATCH exit gate does not create a placement or touch any contact', async () => {
    const { app, world } = makeWebhookHarness();

    // Seed a tenant contact so we can verify its status is not touched.
    world.contacts.push({
      contactId: 'tenant-exit-gate',
      type: 'tenant',
      status: 'searching',
    });
    world.units.set('unit-exit', {
      unitId: 'unit-exit',
      landlordId: 'll-1',
      status: 'available',
      jurisdiction: 'DCA',
      beds: 2,
      baths: 1,
      rent_min: 1200,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    });

    // Create a tour.
    const created = await authed(app).post('/api/tours').send({
      tenantId: 'tenant-exit-gate',
      unitId: 'unit-exit',
      scheduledAt: '2026-07-20T10:00:00.000Z',
      tourType: 'landlord_led',
    });
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // Reach 'toured' first (the exit gate requires it), then fire the gate.
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' });
    const res = await authed(app).patch(`/api/tours/${tourId}`).send({
      outcome: 'move_forward',
      moveForward: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.tour.convertible).toBe(true);

    // No placement was created.
    expect(world.placements.size).toBe(0);

    // The tenant contact's status is untouched.
    const tenant = world.contacts.find((c) => c.contactId === 'tenant-exit-gate');
    expect(tenant?.status).toBe('searching');

    // The response only contains tour fields — no placement in the body.
    expect(res.body.placement).toBeUndefined();
  });
});

// ============================================================================
// Injected clock — dueAt values are computed from the injected 'now'
// (Fix #2: route-layer clock injection so tests can assert exact dueAts)
// ============================================================================

describe('Tour reminders — injected clock produces assertable dueAts', () => {
  it('POST /api/tours arms reminders with dueAts relative to the injected now', async () => {
    const FIXED_NOW = '2026-07-13T10:00:00.000Z';
    const SCHEDULED_AT = '2026-07-15T10:00:00.000Z';
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    const res = await authed(app).post('/api/tours').send({
      ...BASE_CREATE_BODY,
      scheduledAt: SCHEDULED_AT,
    });
    expect(res.status).toBe(201);
    const tourId = res.body.tour.tourId as string;

    // All reminder rows for this tour should have dueAts computed from FIXED_NOW.
    const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // confirmation = FIXED_NOW
    expect(byKind['confirmation']?.dueAt).toBe(FIXED_NOW);
    // day_before = SCHEDULED_AT - 24h = '2026-07-14T10:00:00.000Z'
    expect(byKind['day_before']?.dueAt).toBe('2026-07-14T10:00:00.000Z');
    // morning_of = 08:00 UTC on 2026-07-15 = '2026-07-15T08:00:00.000Z'
    expect(byKind['morning_of']?.dueAt).toBe('2026-07-15T08:00:00.000Z');
    // en_route = SCHEDULED_AT - 2h = '2026-07-15T08:00:00.000Z'
    expect(byKind['en_route']?.dueAt).toBe('2026-07-15T08:00:00.000Z');
    // no_show_checkin is manual-send only now, so it is not auto-armed.
    expect(byKind['no_show_checkin']).toBeUndefined();
  });

  it('PATCH reschedule re-arms with dueAts relative to the injected now', async () => {
    const FIXED_NOW = '2026-07-13T11:00:00.000Z';
    const ORIG_SCHEDULED = '2026-07-15T11:00:00.000Z';
    const NEW_SCHEDULED = '2026-07-20T14:00:00.000Z';
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    const created = await authed(app).post('/api/tours').send({
      ...BASE_CREATE_BODY,
      scheduledAt: ORIG_SCHEDULED,
    });
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // Reschedule — triggers cancel + re-arm.
    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: NEW_SCHEDULED });
    expect(res.status).toBe(200);

    // New (uncanceled) rows should have dueAts relative to NEW_SCHEDULED and FIXED_NOW.
    const allRows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    const newRows = allRows.filter((r) => r.canceledAt === undefined);
    const byKind = Object.fromEntries(newRows.map((r) => [r.kind, r]));

    // confirmation = FIXED_NOW (injected)
    expect(byKind['confirmation']?.dueAt).toBe(FIXED_NOW);
    // day_before = NEW_SCHEDULED - 24h = '2026-07-19T14:00:00.000Z'
    expect(byKind['day_before']?.dueAt).toBe('2026-07-19T14:00:00.000Z');
    // no_show_checkin is manual-send only now, so it is not auto-armed.
    expect(byKind['no_show_checkin']).toBeUndefined();
  });

  it('PATCH -> no_show cancels the still-pending rungs (no auto no-show check-in)', async () => {
    const FIXED_NOW = '2026-07-13T10:00:00.000Z';
    // Future tour, so day_before/morning_of/en_route are all still upcoming.
    const SCHEDULED_AT = '2026-07-20T10:00:00.000Z';
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    const created = await authed(app)
      .post('/api/tours')
      .send({ ...BASE_CREATE_BODY, scheduledAt: SCHEDULED_AT });
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // Pre-no_show: rungs are armed and uncanceled (en_route among them).
    const armed = [...world.tourRemindersMap.values()].filter(
      (r) => r.tourId === tourId && r.canceledAt === undefined,
    );
    expect(armed.map((r) => r.kind)).toContain('en_route');

    // Staff can mark no_show even before the tour (canMarkNoShow is not start-gated).
    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' });
    expect(res.status).toBe(200);

    // Every rung for this tour is now canceled - nothing fires "your tour is
    // tomorrow" at a tour flagged no-show, and there is no no_show_checkin rung.
    const after = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.canceledAt !== undefined)).toBe(true);
    expect(after.some((r) => r.kind === 'no_show_checkin')).toBe(false);
  });
});

// ============================================================================
// GET /api/tours/:tourId/no-show-checkin-draft - templated copy for the MANUAL
// no-show check-in send (the rung is no longer auto-armed)
// ============================================================================

describe('GET /api/tours/:tourId/no-show-checkin-draft', () => {
  it('returns the templated no-show check-in copy', async () => {
    // The copy is tour-independent, but mirror the sibling tour routes: book a
    // tour and read the draft off its id. The route resolves the editable
    // catalog entry (tour.no_show_checkin) via resolveMessage, no override set.
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).get(`/api/tours/${tourId}/no-show-checkin-draft`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      body: 'Hi! We noticed you may have missed your tour. Want to reschedule?',
    });
  });

  it('404s for an unknown tour (mirrors the reminders route)', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours/tour-does-not-exist/no-show-checkin-draft');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tour_not_found' });
  });
});

// ============================================================================
// Timeless create ('requested') + booking arms the ladder
// (tours sequence gap 1: the tour record precedes the time)
// ============================================================================

const TIMELESS_CREATE_BODY = {
  tenantId: 'contact-tenant-1',
  unitId: 'unit-abc',
  tourType: 'landlord_led',
};

describe('POST /api/tours — timeless create (no scheduledAt → requested)', () => {
  it('creates a requested tour with NO scheduledAt attribute and NO reminders armed', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app).post('/api/tours').send(TIMELESS_CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.tour).toMatchObject({
      tenantId: 'contact-tenant-1',
      unitId: 'unit-abc',
      tourType: 'landlord_led',
      status: 'requested',
    });
    expect(res.body.tour.scheduledAt).toBeUndefined();

    // The stored item must OMIT the attribute entirely (sparse byScheduledAt
    // GSI: absent attribute = not indexed) — not store undefined/null.
    const stored = world.toursMap.get(res.body.tour.tourId as string)!;
    expect('scheduledAt' in stored).toBe(false);

    // No reminder ladder armed for a timeless tour.
    expect(world.tourRemindersMap.size).toBe(0);
  });

  it('still requires tenantId, unitId, and tourType on a timeless create', async () => {
    const { app } = makeWebhookHarness();
    const cases = [
      { unitId: 'u', tourType: 'self_guided' }, // no tenantId
      { tenantId: 't', tourType: 'self_guided' }, // no unitId
      { tenantId: 't', unitId: 'u' }, // no tourType
    ];
    for (const body of cases) {
      const res = await authed(app).post('/api/tours').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('PATCH /api/tours/:tourId — booking a requested tour', () => {
  const FIXED_NOW = '2026-07-13T10:00:00.000Z';
  const BOOKED_AT = '2026-07-15T10:00:00.000Z';

  it('scheduledAt alone auto-advances requested → scheduled and arms the ladder off the injected now', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    const created = await authed(app).post('/api/tours').send(TIMELESS_CREATE_BODY);
    expect(created.status).toBe(201);
    expect(created.body.tour.status).toBe('requested');
    const tourId = created.body.tour.tourId as string;
    expect(world.tourRemindersMap.size).toBe(0); // nothing armed yet

    // Booking = the patch carries scheduledAt; no explicit status.
    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: BOOKED_AT });
    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('scheduled'); // auto-advanced
    expect(res.body.tour.scheduledAt).toBe(BOOKED_AT);

    // The ladder armed with dueAts computed from the injected clock (the
    // pre-booking cancel is a safe no-op: no rows existed, so none canceled).
    const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(rows.every((r) => r.canceledAt === undefined)).toBe(true);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind['confirmation']?.dueAt).toBe(FIXED_NOW);
    // day_before = BOOKED_AT - 24h
    expect(byKind['day_before']?.dueAt).toBe('2026-07-14T10:00:00.000Z');
    // no_show_checkin is manual-send only now, so it is not auto-armed.
    expect(byKind['no_show_checkin']).toBeUndefined();
  });

  it('explicit { scheduledAt, status: "scheduled" } booking also works', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    const created = await authed(app).post('/api/tours').send(TIMELESS_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ scheduledAt: BOOKED_AT, status: 'scheduled' });
    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('scheduled');
    expect(res.body.tour.scheduledAt).toBe(BOOKED_AT);

    const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rejects { status: "scheduled" } with no time anywhere (patch or stored) → 400', async () => {
    const { app, world } = makeWebhookHarness();

    const created = await authed(app).post('/api/tours').send(TIMELESS_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'scheduled' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'scheduledAt is required to schedule this tour' });

    // The tour is untouched and still unarmed.
    expect(world.toursMap.get(tourId)?.status).toBe('requested');
    expect(world.tourRemindersMap.size).toBe(0);
  });

  it('allows requested → canceled (no time needed to call it off)', async () => {
    const { app } = makeWebhookHarness();

    const created = await authed(app).post('/api/tours').send(TIMELESS_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('canceled');
  });

  it('closed stays terminal: closed → requested is rejected (409)', async () => {
    const { app } = makeWebhookHarness();

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'closed' });

    const res = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'requested' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('illegal_status_transition');
  });
});

// ============================================================================
// POST /api/tours/:tourId/relay — provision a masked relay group (Task 5)
// ============================================================================
//
// These tests wire the job machinery (relayFanOut intro) the same way
// relayApi.test.ts and placementsRelay.test.ts do — so the intro enqueue
// resolves in-process and we can assert the pool number used for sends.

/** Minimal fake pool-numbers service: deterministic numbers, no Twilio. */
function makeFakePoolNumbers(): PoolNumbersService & { provisioned: string[] } {
  let counter = 0;
  const provisioned: string[] = [];
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'active',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: new Date().toISOString(),
  });
  return {
    provisioned,
    async provisionForGroup() {
      counter += 1;
      const poolNumber = `+1555040${String(counter).padStart(4, '0')}`;
      provisioned.push(poolNumber);
      return { poolNumber, record: rec(poolNumber), provisioned: true };
    },
    async noteGroupClosed() {},
    async burnMember() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async getRecord(poolNumber) {
      return rec(poolNumber);
    },
  };
}

function makeDisabledPoolNumbers(): PoolNumbersService & { provisionAttempts: number } {
  let provisionAttempts = 0;
  return {
    get provisionAttempts() { return provisionAttempts; },
    async provisionForGroup() {
      provisionAttempts += 1;
      throw new RelayProvisioningDisabledError('set RELAY_LIVE_PROVISIONING=true after A2P approval');
    },
    async noteGroupClosed() {},
    async burnMember() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async getRecord() {
      return undefined;
    },
  };
}

function makeVoiceCapabilityFailingPool(): PoolNumbersService {
  return {
    async provisionForGroup() {
      throw new VoiceCapabilityError('no voice-capable number available');
    },
    async noteGroupClosed() {},
    async burnMember() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async getRecord() {
      return undefined;
    },
  };
}

describe('POST /api/tours/:tourId/relay — provision tour relay group (Task 5)', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('409 tour_not_active: a canceled tour cannot open a group thread (stale-page race)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [{ phone: '+15550200001', name: 'Alice' }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tour_not_active');
    expect(pool.provisioned).toHaveLength(0); // nothing was bought
  });

  it('concurrent provisions: exactly one 201, the loser 409s BEFORE buying a number (atomic claim)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const body = { members: [{ phone: '+15550200001', name: 'Alice' }, { phone: '+15550200002', name: 'Bob' }] };
    const [a, b] = await Promise.all([
      authed(app).post(`/api/tours/${tourId}/relay`).send(body),
      authed(app).post(`/api/tours/${tourId}/relay`).send(body),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error).toBe('relay_already_provisioned');
    // The race loser never provisioned: exactly ONE pool number was bought,
    // and the stored groupThreadId is the winner's conversation (no orphan).
    expect(pool.provisioned).toHaveLength(1);
    const winner = a.status === 201 ? a : b;
    expect(world.toursMap.get(tourId)!.groupThreadId).toBe(winner.body.conversation.conversationId);
  });

  it('happy path: 201, creates relay group owned by the tour, stamps groupThreadId on the tour', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    // Create a tour first.
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // Provision the relay group.
    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [
        { phone: '+15550200001', contactId: 'c-alice', name: 'Alice' },
        { phone: '+15550200002', contactId: 'c-bob', name: 'Bob' },
      ],
    });

    expect(res.status).toBe(201);

    // Response shape: { tour, conversation }.
    const { tour, conversation } = res.body as { tour: Record<string, unknown>; conversation: Record<string, unknown> };
    expect(tour).toBeDefined();
    expect(conversation).toBeDefined();

    // The conversation is a tour-owned relay group.
    expect(conversation['type']).toBe('relay_group');
    expect(conversation['pool_number']).toBe(pool.provisioned[0]);
    expect((conversation['participants'] as unknown[]).length).toBe(2);

    // The owner is the tour (not a placement).
    const convOwner = conversation['owner'] as { type: string; id: string };
    expect(convOwner.type).toBe('tour');
    expect(convOwner.id).toBe(tourId);

    // No placementId on a tour-owned thread.
    expect(conversation['placementId']).toBeUndefined();

    // The tour now has groupThreadId stamped.
    expect(tour['tourId']).toBe(tourId);
    expect(tour['groupThreadId']).toBe(conversation['conversationId']);

    // The stored tour reflects the stamp too.
    const storedTour = world.toursMap.get(tourId)!;
    expect(storedTour.groupThreadId).toBe(conversation['conversationId']);

    // The conversation is retrievable from the in-memory store.
    const storedConv = world.conversations.get(conversation['conversationId'] as string);
    expect(storedConv?.type).toBe('relay_group');
    expect(storedConv?.owner).toMatchObject({ type: 'tour', id: tourId });

    // The intro fanned out to both members FROM the pool number (proves relay sends).
    expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550200001', '+15550200002'].sort());
    expect(world.sent.every((s) => s.from === pool.provisioned[0])).toBe(true);
  });

  it('relay success records a tours#-ONLY tour_group_opened milestone + emits tour.updated (1a)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    const activityCountBefore = world.activityEvents.length;

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [{ phone: '+15550200001', name: 'Alice' }],
    });
    expect(res.status).toBe(201);
    const conversationId = (res.body.conversation as Record<string, unknown>)['conversationId'];

    // tours#<tourId> carries the milestone with the opened thread id + actor.
    const opened = world.auditEvents.filter(
      (e) => e.entityKey === `tours#${tourId}` && e.event_type === 'tour_group_opened',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toMatchObject({ tourId, conversationId });
    expect(opened[0]!.actorId).toBe('usr_testva00000000000000000');

    // tours#-ONLY: no units# row and no tenant activity event for group-opened.
    expect(world.auditEvents.some((e) => e.entityKey.startsWith('units#') && e.event_type === 'tour_group_opened')).toBe(false);
    expect(world.activityEvents.length).toBe(activityCountBefore);

    // tour.updated advised dashboards (ID + status only).
    const updates = world.emitted.filter((e) => e.event === 'tour.updated');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[updates.length - 1]!.payload).toEqual({ tourId, status: 'scheduled' });
  });

  it('a REFUSED relay provision (409 tour_not_active) records NO tour_group_opened milestone', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [{ phone: '+15550200001', name: 'Alice' }],
    });
    expect(res.status).toBe(409); // tour_not_active
    expect(
      world.auditEvents.some((e) => e.event_type === 'tour_group_opened'),
    ).toBe(false);
  });

  it('404 for a missing tour', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const res = await authed(app).post('/api/tours/no-such-tour/relay').send({
      members: [{ phone: '+15550200001', name: 'Alice' }],
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tour_not_found');
    // No number was provisioned.
    expect(pool.provisioned).toHaveLength(0);
  });

  // Auto-membership (founder flow): members is OPTIONAL — absent/empty resolves
  // the roster to [tenant contact, unit's landlord contact] from the world.
  // (Supersedes the old 400-for-missing-members contract.)

  /** Seed the tour's tenant + unit + landlord so auto-resolve can find them. */
  function seedAutoResolveWorld(): void {
    world.contacts.push({
      contactId: 'contact-tenant-1',
      type: 'tenant',
      phone: '+15550200011',
      firstName: 'Tina',
      lastName: 'Tenant',
    });
    world.contacts.push({
      contactId: 'll-relay-1',
      type: 'landlord',
      phone: '+15550200012',
      firstName: 'Larry',
      lastName: 'Lord',
    });
    world.units.set('unit-abc', {
      unitId: 'unit-abc',
      landlordId: 'll-relay-1',
      status: 'available',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    });
  }

  it('auto-resolves [tenant, landlord] with names when members is absent or empty', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    seedAutoResolveWorld();

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    // No members at all — the founder flow (one button click, no roster form).
    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(res.status).toBe(201);

    const conversation = res.body.conversation as Record<string, unknown>;
    const participants = conversation['participants'] as {
      phone: string;
      contactId: string;
      name?: string;
    }[];
    expect(participants).toHaveLength(2);
    const byPhone = Object.fromEntries(participants.map((p) => [p.phone, p]));
    expect(byPhone['+15550200011']).toMatchObject({ contactId: 'contact-tenant-1', name: 'Tina Tenant' });
    expect(byPhone['+15550200012']).toMatchObject({ contactId: 'll-relay-1', name: 'Larry Lord' });

    // groupThreadId stamped back on the tour.
    expect((res.body.tour as Record<string, unknown>)['groupThreadId']).toBe(conversation['conversationId']);

    // The intro fanned out to BOTH auto-resolved members FROM the pool number.
    expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550200011', '+15550200012']);
    expect(world.sent.every((s) => s.from === pool.provisioned[0])).toBe(true);

    // An EMPTY members array behaves identically (second tour — one thread per tour).
    const created2 = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId2 = created2.body.tour.tourId as string;
    const res2 = await authed(app).post(`/api/tours/${tourId2}/relay`).send({ members: [] });
    expect(res2.status).toBe(201);
    expect((res2.body.conversation as { participants: unknown[] }).participants).toHaveLength(2);
  });

  it('second relay POST → 409 relay_already_provisioned (one thread per tour)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    seedAutoResolveWorld();

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const first = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(first.status).toBe(201);
    const firstThreadId = (first.body.conversation as Record<string, unknown>)['conversationId'];

    // A second POST must NOT provision a new number or overwrite groupThreadId —
    // explicit members don't bypass the guard either.
    const again = await authed(app)
      .post(`/api/tours/${tourId}/relay`)
      .send({ members: [{ phone: '+15550200099', name: 'Interloper' }] });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'relay_already_provisioned' });
    expect(pool.provisioned).toHaveLength(1);
    expect(world.toursMap.get(tourId)?.groupThreadId).toBe(firstThreadId);
  });

  it('400 relay_member_unresolvable naming the tenant when the tenant contact has no phone', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    seedAutoResolveWorld();
    // Strip the tenant's phone (both scalar and phones[] are absent).
    const tenant = world.contacts.find((c) => c.contactId === 'contact-tenant-1')!;
    delete tenant.phone;

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'relay_member_unresolvable',
      detail: 'tenant contact has no phone',
    });
    expect(pool.provisioned).toHaveLength(0);
    expect(world.toursMap.get(tourId)?.groupThreadId).toBeUndefined();
  });

  it('400 relay_member_unresolvable names each missing rung of the resolution ladder', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    // Nothing seeded → the tenant contact is the first unresolvable member.
    const noTenant = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(noTenant.status).toBe(400);
    expect(noTenant.body).toEqual({
      error: 'relay_member_unresolvable',
      detail: 'tenant contact not found',
    });

    // Tenant exists (with phone) but the unit doesn't.
    world.contacts.push({ contactId: 'contact-tenant-1', type: 'tenant', phone: '+15550200011' });
    const noUnit = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(noUnit.status).toBe(400);
    expect(noUnit.body).toEqual({
      error: 'relay_member_unresolvable',
      detail: 'unit not found (cannot resolve landlord)',
    });

    // Unit exists but its landlord contact doesn't.
    world.units.set('unit-abc', {
      unitId: 'unit-abc',
      landlordId: 'll-ghost',
      status: 'available',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    });
    const noLandlord = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(noLandlord.status).toBe(400);
    expect(noLandlord.body).toEqual({
      error: 'relay_member_unresolvable',
      detail: 'landlord contact not found',
    });

    // Landlord contact exists but has no phone.
    world.contacts.push({ contactId: 'll-ghost', type: 'landlord', firstName: 'Larry' });
    const noLandlordPhone = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(noLandlordPhone.status).toBe(400);
    expect(noLandlordPhone.body).toEqual({
      error: 'relay_member_unresolvable',
      detail: 'landlord contact has no phone',
    });

    // Nothing was ever provisioned along the way.
    expect(pool.provisioned).toHaveLength(0);
  });

  it('explicit member with contactId and no name gets the contact display name', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });
    world.contacts.push({
      contactId: 'c-carol',
      type: 'landlord',
      phone: '+15550200031',
      firstName: 'Carol',
      lastName: 'Vaughn',
    });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [
        { phone: '+15550200031', contactId: 'c-carol' }, // name resolves from the contact
        { phone: '+15550200032', contactId: 'c-ghost' }, // unknown contact → passes through nameless
        { phone: '+15550200033', name: 'Explicit Ed' }, // explicit name wins as before
      ],
    });
    expect(res.status).toBe(201);
    const participants = (res.body.conversation as {
      participants: { phone: string; name?: string }[];
    }).participants;
    const byPhone = Object.fromEntries(participants.map((p) => [p.phone, p]));
    expect(byPhone['+15550200031']?.name).toBe('Carol Vaughn');
    expect(byPhone['+15550200032']?.name).toBeUndefined();
    expect(byPhone['+15550200033']?.name).toBe('Explicit Ed');
  });

  it('still 400s for a present-but-invalid members array', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    const missingPhone = await authed(app).post(`/api/tours/${tourId}/relay`).send({ members: [{}] });
    expect(missingPhone.status).toBe(400);
    expect(missingPhone.body.error).toBe('member.phone is required');

    const badPhone = await authed(app)
      .post(`/api/tours/${tourId}/relay`)
      .send({ members: [{ phone: 'not-a-phone' }] });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error).toMatch(/not a valid phone/);

    const notArray = await authed(app)
      .post(`/api/tours/${tourId}/relay`)
      .send({ members: 'nope' });
    expect(notArray.status).toBe(400);
    expect(notArray.body.error).toBe('members must be an array');

    // No number was provisioned for any of the bad requests.
    expect(pool.provisioned).toHaveLength(0);
  });

  it('503 relay_provisioning_disabled when the kill-switch is off', async () => {
    const pool = makeDisabledPoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [{ phone: '+15550200001', name: 'Alice' }],
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('relay_provisioning_disabled');
    expect(res.body.message).toMatch(/RELAY_LIVE_PROVISIONING=true/);
    expect(pool.provisionAttempts).toBe(1);
    // No conversation created; tour groupThreadId NOT stamped.
    expect([...world.conversations.values()]).toHaveLength(0);
    expect(world.toursMap.get(tourId)?.groupThreadId).toBeUndefined();
  });

  it('503 relay_provisioning_failed when no voice-capable number is available', async () => {
    const pool = makeVoiceCapabilityFailingPool();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    const res = await authed(app).post(`/api/tours/${tourId}/relay`).send({
      members: [{ phone: '+15550200001', name: 'Alice' }],
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('relay_provisioning_failed');
    // No conversation created; tour groupThreadId NOT stamped.
    expect([...world.conversations.values()]).toHaveLength(0);
    expect(world.toursMap.get(tourId)?.groupThreadId).toBeUndefined();
  });
});

// ============================================================================
// Task 1: requested (time-less) tours + byStatus GSI + ?status= filter
// ============================================================================

describe('POST /api/tours — requested (time-less) tours', () => {
  it('creates a requested tour when scheduledAt is absent → 201 status=requested', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app).post('/api/tours').send({
      tenantId: 'contact-tenant-req',
      unitId: 'unit-req',
      tourType: 'self_guided',
      // scheduledAt deliberately absent
    });

    expect(res.status).toBe(201);
    expect(res.body.tour.status).toBe('requested');
    expect(res.body.tour.scheduledAt).toBeUndefined();
    expect(res.body.tour.tenantId).toBe('contact-tenant-req');
    expect(world.toursMap.size).toBe(1);
  });

  it('POST without scheduledAt → ZERO reminder rows (reminder invariant)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await authed(app).post('/api/tours').send({
      tenantId: 'contact-tenant-req2',
      unitId: 'unit-req2',
      tourType: 'landlord_led',
    });

    expect(res.status).toBe(201);
    expect(res.body.tour.status).toBe('requested');

    const tourId = res.body.tour.tourId as string;
    const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(rows).toHaveLength(0);
  });

  it('POST with scheduledAt still defaults status to scheduled and arms reminders (regression)', async () => {
    const FIXED_NOW = '2026-07-13T10:00:00.000Z';
    const SCHEDULED_AT = '2026-07-20T10:00:00.000Z';
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    const res = await authed(app).post('/api/tours').send({
      tenantId: 'contact-tenant-sched',
      unitId: 'unit-sched',
      scheduledAt: SCHEDULED_AT,
      tourType: 'pm_team',
    });

    expect(res.status).toBe(201);
    expect(res.body.tour.status).toBe('scheduled');
    expect(res.body.tour.scheduledAt).toBe(SCHEDULED_AT);

    const tourId = res.body.tour.tourId as string;
    const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('returns 400 when scheduledAt is present but invalid', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).post('/api/tours').send({
      tenantId: 't',
      unitId: 'u',
      scheduledAt: 'not-a-date',
      tourType: 'self_guided',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduledAt/);
  });

  it('returns 400 for missing required fields (tenantId, unitId, tourType still required)', async () => {
    const { app } = makeWebhookHarness();
    const cases = [
      { unitId: 'u', tourType: 'self_guided' },         // no tenantId
      { tenantId: 't', tourType: 'self_guided' },         // no unitId
      { tenantId: 't', unitId: 'u' },                     // no tourType
    ];
    for (const body of cases) {
      const res = await authed(app).post('/api/tours').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('PATCH /api/tours — requested → scheduled transition', () => {
  it('PATCH sets scheduledAt on a requested tour → 200 status=scheduled + reminders armed', async () => {
    const FIXED_NOW = '2026-07-13T12:00:00.000Z';
    const NEW_SCHED = '2026-07-25T10:00:00.000Z';
    const { app, world } = makeWebhookHarness({ toursNow: () => FIXED_NOW });

    // Create a requested (time-less) tour.
    const created = await authed(app).post('/api/tours').send({
      tenantId: 'contact-req-to-sched',
      unitId: 'unit-req-to-sched',
      tourType: 'landlord_led',
    });
    expect(created.status).toBe(201);
    expect(created.body.tour.status).toBe('requested');
    const tourId = created.body.tour.tourId as string;

    // Confirm zero reminder rows at this point.
    const rowsBefore = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(rowsBefore).toHaveLength(0);

    // PATCH: set a scheduledAt → should auto-transition to scheduled.
    const patch = await authed(app).patch(`/api/tours/${tourId}`).send({ scheduledAt: NEW_SCHED });
    expect(patch.status).toBe(200);
    expect(patch.body.tour.status).toBe('scheduled');
    expect(patch.body.tour.scheduledAt).toBe(NEW_SCHED);

    // Reminder ladder should now be armed (rows exist with correct dueAts).
    const rowsAfter = [...world.tourRemindersMap.values()].filter(
      (r) => r.tourId === tourId && r.canceledAt === undefined,
    );
    expect(rowsAfter.length).toBeGreaterThan(0);

    // Assert the dueAts are computed from FIXED_NOW / NEW_SCHED.
    const byKind = Object.fromEntries(rowsAfter.map((r) => [r.kind, r]));
    expect(byKind['confirmation']?.dueAt).toBe(FIXED_NOW);
    expect(byKind['day_before']?.dueAt).toBe('2026-07-24T10:00:00.000Z'); // NEW_SCHED - 24h
    expect(byKind['no_show_checkin']).toBeUndefined(); // manual-send only, not auto-armed
  });

  it('PATCH canceled from requested is allowed (requested → canceled)', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send({
      tenantId: 'contact-req-cancel',
      unitId: 'unit-req-cancel',
      tourType: 'self_guided',
    });
    expect(created.status).toBe(201);
    expect(created.body.tour.status).toBe('requested');
    const tourId = created.body.tour.tourId as string;

    const cancel = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'canceled' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.tour.status).toBe('canceled');

    // No reminder rows (none were ever created).
    const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
    expect(rows).toHaveLength(0);
  });

  it('closed → requested is illegal (closed stays terminal)', async () => {
    const { app } = makeWebhookHarness();
    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'closed' });

    const illegal = await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'requested' });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error).toBe('illegal_status_transition');
  });

  it('no placement created and tenant status untouched on requested tour create', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'tenant-req-gate', type: 'tenant', status: 'searching' });

    const res = await authed(app).post('/api/tours').send({
      tenantId: 'tenant-req-gate',
      unitId: 'unit-some',
      tourType: 'self_guided',
    });
    expect(res.status).toBe(201);

    // No placement created.
    expect(world.placements.size).toBe(0);

    // Tenant status unchanged.
    const tenant = world.contacts.find((c) => c.contactId === 'tenant-req-gate');
    expect(tenant?.status).toBe('searching');
  });
});

describe('GET /api/tours — ?status= filter', () => {
  it('GET ?status=requested returns requested tours', async () => {
    const { app } = makeWebhookHarness();

    // Create one requested and one scheduled tour.
    await authed(app).post('/api/tours').send({
      tenantId: 'tenant-filter-a',
      unitId: 'unit-filter-a',
      tourType: 'self_guided',
      // no scheduledAt → requested
    });
    await authed(app).post('/api/tours').send(BASE_CREATE_BODY);

    const res = await authed(app).get('/api/tours?status=requested');
    expect(res.status).toBe(200);
    expect(res.body.tours).toBeDefined();
    const statuses = (res.body.tours as { status: string }[]).map((t) => t.status);
    expect(statuses).toContain('requested');
    expect(statuses.every((s) => s === 'requested')).toBe(true);
  });

  it('GET ?status=scheduled returns scheduled tours', async () => {
    const { app } = makeWebhookHarness();
    await authed(app).post('/api/tours').send(BASE_CREATE_BODY);

    const res = await authed(app).get('/api/tours?status=scheduled');
    expect(res.status).toBe(200);
    const tours = res.body.tours as { status: string }[];
    expect(tours.every((t) => t.status === 'scheduled')).toBe(true);
  });

  it('GET ?status=bogus → 400', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours?status=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/);
  });

  it('GET with no filter still returns 400 (existing rule preserved)', async () => {
    const { app } = makeWebhookHarness();
    const res = await authed(app).get('/api/tours');
    expect(res.status).toBe(400);
  });

  it('existing filters (tenantId, unitId, from+to) still work with new code (regression)', async () => {
    const { app } = makeWebhookHarness();
    await authed(app).post('/api/tours').send({ ...BASE_CREATE_BODY, tenantId: 'tenant-regression' });

    const res = await authed(app).get('/api/tours?tenantId=tenant-regression');
    expect(res.status).toBe(200);
    expect(res.body.tours).toHaveLength(1);
    expect(res.body.tours[0].tenantId).toBe('tenant-regression');
  });
});

// ============================================================================
// Auth gate
// ============================================================================

describe('Tours routes stay behind requireAuth', () => {
  it('403s without the origin secret and 401s without a session', async () => {
    const { app } = makeWebhookHarness();

    // No origin secret → 403.
    expect((await request(app).get('/api/tours?tenantId=x')).status).toBe(403);

    // Origin secret but no session → 401.
    const noSession = await request(app)
      .get('/api/tours?tenantId=x')
      .set('x-origin-verify', SECRET);
    expect(noSession.status).toBe(401);
  });
});
