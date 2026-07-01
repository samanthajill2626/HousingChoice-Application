// Tours API tests — /api/tours (Task 3 + Task 5 relay route).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt, tourType }  → 201 { tour }
//   GET   /api/tours/:tourId                                        → { tour } | 404
//   GET   /api/tours?tenantId=&unitId=&from=&to=                    → { tours }
//   PATCH /api/tours/:tourId                                        → { tour } | 404
//   POST  /api/tours/:tourId/relay  { members }                     → 201 { tour, conversation }
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
      { tenantId: 't', unitId: 'u', tourType: 'self_guided' }, // no scheduledAt
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

    const res = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'not_a_fit', moveForward: false });
    expect(res.status).toBe(200);
    expect(res.body.tour.outcome).toBe('not_a_fit');
    expect(res.body.tour.moveForward).toBe(false);
    expect(res.body.tour.convertible).toBe(false);
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
      .send({ status: 'confirmed' });
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

    // Fire exit gate.
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
    // no_show_checkin = SCHEDULED_AT + 30m = '2026-07-15T10:30:00.000Z'
    expect(byKind['no_show_checkin']?.dueAt).toBe('2026-07-15T10:30:00.000Z');
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
    // no_show_checkin = NEW_SCHEDULED + 30m = '2026-07-20T14:30:00.000Z'
    expect(byKind['no_show_checkin']?.dueAt).toBe('2026-07-20T14:30:00.000Z');
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
function makeFakePoolNumbers(): PoolNumbersService & { released: string[]; provisioned: string[] } {
  let counter = 0;
  const released: string[] = [];
  const provisioned: string[] = [];
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'assigned',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: new Date().toISOString(),
  });
  return {
    released,
    provisioned,
    async provisionForPlacement() {
      counter += 1;
      const poolNumber = `+1555040${String(counter).padStart(4, '0')}`;
      provisioned.push(poolNumber);
      return { poolNumber, record: rec(poolNumber), provisioned: true };
    },
    async assignConversation() {},
    async release(poolNumber) {
      released.push(poolNumber);
      return { ...rec(poolNumber), lifecycle_state: 'quarantined' };
    },
  };
}

function makeDisabledPoolNumbers(): PoolNumbersService & { provisionAttempts: number } {
  let provisionAttempts = 0;
  return {
    get provisionAttempts() { return provisionAttempts; },
    async provisionForPlacement() {
      provisionAttempts += 1;
      throw new RelayProvisioningDisabledError('set RELAY_LIVE_PROVISIONING=true after A2P approval');
    },
    async assignConversation() {},
    async release(poolNumber) {
      return {
        poolNumber,
        lifecycle_state: 'quarantined',
        quarantine_until: '0000-00-00T00:00:00.000Z',
        voice_capable: true,
        sms_capable: true,
        provisioned_at: new Date().toISOString(),
      };
    },
  };
}

function makeVoiceCapabilityFailingPool(): PoolNumbersService {
  return {
    async provisionForPlacement() {
      throw new VoiceCapabilityError('no voice-capable number available');
    },
    async assignConversation() {},
    async release(poolNumber) {
      return {
        poolNumber,
        lifecycle_state: 'quarantined',
        quarantine_until: '0000-00-00T00:00:00.000Z',
        voice_capable: false,
        sms_capable: true,
        provisioned_at: new Date().toISOString(),
      };
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

  it('400 for missing / empty members list', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = makeWebhookHarness({ world, poolNumbersService: pool });

    const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
    expect(created.status).toBe(201);
    const tourId = created.body.tour.tourId as string;

    const noMembers = await authed(app).post(`/api/tours/${tourId}/relay`).send({});
    expect(noMembers.status).toBe(400);
    expect(noMembers.body.error).toMatch(/members/);

    const emptyMembers = await authed(app).post(`/api/tours/${tourId}/relay`).send({ members: [] });
    expect(emptyMembers.status).toBe(400);
    expect(emptyMembers.body.error).toMatch(/members/);

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
