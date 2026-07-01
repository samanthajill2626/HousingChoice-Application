// Tours API tests — /api/tours (Task 3).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt, tourType }  → 201 { tour }
//   GET   /api/tours/:tourId                                        → { tour } | 404
//   GET   /api/tours?tenantId=&unitId=&from=&to=                    → { tours }
//   PATCH /api/tours/:tourId                                        → { tour } | 404
//
// Mirrors unitsApi.test.ts: in-memory fakes via makeWebhookHarness, no DynamoDB.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

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
