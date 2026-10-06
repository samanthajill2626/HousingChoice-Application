// POST /api/tours/:tourId/reopen - reopen a CLOSED tour (tour auto-close spec
// section 7, plan Task 6.1).
//
// The route is the ONLY way out of 'closed'. It returns the tour to the state
// it closed from (reopenTargetFor: autoClosedFrom, else 'toured' for a person's
// not-a-fit / move-forward decision), removes the outcome and the auto-close
// facts, and starts a fresh two weeks on the auto-close clock (lastMarkedAt =
// the router's injected clock). It is SILENT: no message, no reminder (not even
// into a past 'scheduled'), no placement, roster or tenant-status change. Its
// side effects (best-effort): the shared tour-event writer (tour_reopened), the
// close-nag clear on the tour's OWN open relay group, one tour.updated emit.
//
// Driven against the harness world fakes (no DynamoDB). An auto-closed tour is
// made by creating one through the API and closing it with the fake
// toursRepo.autoCloseIf - the real repo's condition, evaluated synchronously
// (parity is pinned by toursRepoFakeConditions.test.ts).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { RelayOwner } from '../src/repos/conversationsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

// ---- helpers ---------------------------------------------------------------
// authed(), BASE_CREATE_BODY and seedUnitWithLandlord are copied from
// toursApi.test.ts (its local helpers are not exported).

function authed(app: ReturnType<typeof makeWebhookHarness>['app']) {
  return {
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    get: (path: string) =>
      request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    delete: (path: string) =>
      request(app).delete(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

const BASE_CREATE_BODY = {
  tenantId: 'contact-tenant-1',
  unitId: 'unit-abc',
  scheduledAt: '2026-07-15T10:00:00.000Z',
  tourType: 'self_guided',
};

function seedUnitWithLandlord(world: FakeWorld, landlordId: string): void {
  world.units.set('unit-abc', {
    unitId: 'unit-abc',
    landlordId,
    status: 'available',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  });
}

type App = ReturnType<typeof makeWebhookHarness>['app'];

// BASE_CREATE_BODY's tenant, and the landlord the unit is seeded with.
const TENANT = 'contact-tenant-1';
const LANDLORD = 'c-ll';
// The router's clock at the reopen. BASE_CREATE_BODY's tour time (2026-07-15)
// is two months earlier, so every tour here is long past its date - the
// auto-close sweep's candidate - and its create wrote booked_too_late rungs.
const NOW = '2026-09-20T12:00:00.000Z';
// An earlier person mark (a status PATCH), so the reopen's own stamp shows.
const MARKED = '2026-09-01T12:00:00.000Z';
// A pending close-nag on a linked relay group (as the sweep arms it).
const NAG_AT = '2026-10-18T12:00:00.000Z';
// The five attributes a reopen removes (spec 7.3).
const CLEARED_FIELDS = ['outcome', 'moveForward', 'convertible', 'autoClosedAt', 'autoClosedFrom'] as const;

/** The conversion route's prerequisites (pattern placementConvert.test.ts
 *  seedTenantAndUnit): the tenant CONTACT and unit-abc with its landlord. */
function seedTenantAndUnit(world: FakeWorld): void {
  world.contacts.push({ contactId: TENANT, type: 'tenant', status: 'searching' });
  world.contacts.push({ contactId: LANDLORD, type: 'landlord', phone: '+15550300002' });
  seedUnitWithLandlord(world, LANDLORD);
}

async function createTour(app: App): Promise<string> {
  const created = await authed(app).post('/api/tours').send(BASE_CREATE_BODY);
  expect(created.status).toBe(201);
  return created.body.tour.tourId as string;
}

/** Close the tour the way the sweep does - one conditional write from the
 *  status it is in now (no sweep side effects). */
async function autoClose(world: FakeWorld, tourId: string): Promise<void> {
  const asRead = (await world.toursRepo.get(tourId))!;
  const closed = await world.toursRepo.autoCloseIf(asRead, 'rot-1');
  expect(closed?.status).toBe('closed');
}

/** An OPEN relay group with a pending close-nag, linked to the tour. */
async function linkOpenGroupWithNag(
  world: FakeWorld,
  tourId: string,
  poolNumber: string,
  owner: RelayOwner,
): Promise<string> {
  const group = await world.conversationsRepo.createRelayGroup({
    poolNumber,
    members: [{ phone: '+15550100001', contactId: '', name: 'Alice' }],
    owner,
  });
  world.conversations.get(group.conversationId)!.close_nag_next_at = NAG_AT;
  world.toursMap.get(tourId)!.groupThreadId = group.conversationId;
  return group.conversationId;
}

const reopen = (app: App, tourId: string) => authed(app).post(`/api/tours/${tourId}/reopen`);

/** The tour's reminder rows, copied (a snapshot later writes cannot change). */
const rowsFor = (world: FakeWorld, tourId: string) =>
  [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId).map((r) => ({ ...r }));

/** The tour's OWN tour_reopened audit rows (one per reopen that happened). */
const tourReopenedRows = (world: FakeWorld, tourId: string) =>
  world.auditEvents.filter((e) => e.entityKey === `tours#${tourId}` && e.event_type === 'tour_reopened');

// ============================================================================
// Refusals: every one writes nothing.
// ============================================================================

describe('POST /api/tours/:tourId/reopen - refusals', () => {
  it('404 tour_not_found for an unknown tour', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });

    const res = await reopen(app, 'tour-nope').send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tour_not_found' });
    expect(world.toursMap.has('tour-nope')).toBe(false);
  });

  it('409 tour_not_closed for a tour that is not closed (scheduled)', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    const before = { ...world.toursMap.get(tourId)! };
    const emitsBefore = world.emitted.length;

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_not_closed' });
    expect(world.toursMap.get(tourId)).toEqual(before);
    expect(tourReopenedRows(world, tourId)).toHaveLength(0);
    expect(world.emitted).toHaveLength(emitsBefore);
  });

  it('409 tour_converted for a tour converted through the real conversion route', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    seedTenantAndUnit(world);
    const tourId = await createTour(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true })
      .expect(200);
    const converted = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(converted.status).toBe(201);
    const before = { ...world.toursMap.get(tourId)! };
    // Closed by the conversion, still carrying the decision - which alone
    // would reopen to toured; the conversion is what refuses it.
    expect(before).toMatchObject({
      status: 'closed',
      outcome: 'move_forward',
      convertedPlacementId: converted.body.placement.placementId as string,
    });

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_converted' });
    expect(world.toursMap.get(tourId)).toEqual(before);
    expect(tourReopenedRows(world, tourId)).toHaveLength(0);
  });

  it('409 tour_converted for a closed tour mid-conversion (a pending: claim)', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    // A closed, decided tour whose conversion has claimed it but not finished.
    Object.assign(world.toursMap.get(tourId)!, {
      status: 'closed',
      outcome: 'move_forward',
      moveForward: true,
      convertible: true,
      convertedPlacementId: 'pending:x',
    });
    const before = { ...world.toursMap.get(tourId)! };

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_converted' });
    expect(world.toursMap.get(tourId)).toEqual(before);
    expect(tourReopenedRows(world, tourId)).toHaveLength(0);
  });

  it('409 tour_reopen_unsupported for a tour closed straight from scheduled (no autoClosedFrom, no decision)', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'closed' }).expect(200);
    const before = { ...world.toursMap.get(tourId)! };
    expect(before.status).toBe('closed');
    expect(before.outcome).toBeUndefined();
    expect(before.autoClosedFrom).toBeUndefined();

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_reopen_unsupported' });
    expect(world.toursMap.get(tourId)).toEqual(before);
    expect(tourReopenedRows(world, tourId)).toHaveLength(0);
  });

  it('400 for any body field (the body must be empty), and for a body that is not an object', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await autoClose(world, tourId);
    const before = { ...world.toursMap.get(tourId)! };

    const one = await reopen(app, tourId).send({ status: 'toured' });
    expect(one.status).toBe(400);
    expect(one.body).toEqual({ error: 'unknown field(s): status' });

    const two = await reopen(app, tourId).send({ status: 'toured', outcome: 'not_a_fit' });
    expect(two.status).toBe(400);
    expect(two.body).toEqual({ error: 'unknown field(s): status, outcome' });

    const notAnObject = await reopen(app, tourId).send([]);
    expect(notAnObject.status).toBe(400);
    expect(notAnObject.body).toEqual({ error: 'body must be a JSON object' });

    // Nothing was reopened.
    expect(world.toursMap.get(tourId)).toEqual(before);
    expect(tourReopenedRows(world, tourId)).toHaveLength(0);
  });
});

// ============================================================================
// Reopen targets (spec 7.2) and the write (spec 7.3).
// ============================================================================

describe('POST /api/tours/:tourId/reopen - back to the state the tour closed from', () => {
  it('auto-closed from scheduled -> scheduled, fields removed, lastMarkedAt = now; SILENT', async () => {
    const { app, world, capture } = makeWebhookHarness({ toursNow: () => NOW });
    world.contacts.push({ contactId: TENANT, type: 'tenant', status: 'searching' });
    const tourId = await createTour(app);
    await autoClose(world, tourId);
    // The create's booked_too_late rungs, under the retired ladder pointer.
    const rowsBefore = rowsFor(world, tourId);
    expect(rowsBefore.length).toBeGreaterThan(0);
    const sentBefore = world.sent.length;
    const contactsBefore = structuredClone(world.contacts);
    const placementsBefore = world.placements.size;
    const rosterActionsBefore = world.pendingRosterActionsMap.size;

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(200);
    const tour = res.body.tour as Record<string, unknown>;
    expect(tour['tourId']).toBe(tourId);
    expect(tour['status']).toBe('scheduled');
    expect(tour['lastMarkedAt']).toBe(NOW);
    // The time is kept as it was (now in the past); the pointer is left as is.
    expect(tour['scheduledAt']).toBe(BASE_CREATE_BODY.scheduledAt);
    expect(tour['currentLadderId']).toBe('rot-1');
    for (const field of CLEARED_FIELDS) expect(tour, field).not.toHaveProperty(field);
    // Stored exactly as returned.
    expect(world.toursMap.get(tourId)).toEqual(tour);
    // SILENT: no reminder row armed (not even into the past time) or removed,
    // nothing sent, no tenant / placement / roster change.
    expect(rowsFor(world, tourId)).toEqual(rowsBefore);
    expect(world.sent).toHaveLength(sentBefore);
    expect(world.contacts).toEqual(contactsBefore);
    expect(world.placements.size).toBe(placementsBefore);
    expect(world.pendingRosterActionsMap.size).toBe(rosterActionsBefore);
    // One info line, ids only.
    expect(capture.atLevel(30).filter((l) => l['msg'] === 'tour reopened via api')).toEqual([
      expect.objectContaining({ tourId, to: 'scheduled' }),
    ]);
  });

  it('auto-closed from toured -> toured, its own stamp replacing the earlier mark (no body at all)', async () => {
    let clock = MARKED;
    const { app, world } = makeWebhookHarness({ toursNow: () => clock });
    const tourId = await createTour(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    expect(world.toursMap.get(tourId)?.lastMarkedAt).toBe(MARKED);
    await autoClose(world, tourId);
    clock = NOW;

    const res = await reopen(app, tourId);

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('toured');
    expect(res.body.tour.lastMarkedAt).toBe(NOW);
    for (const field of CLEARED_FIELDS) expect(res.body.tour, field).not.toHaveProperty(field);
  });

  it('auto-closed from no_show -> no_show', async () => {
    let clock = MARKED;
    const { app, world } = makeWebhookHarness({ toursNow: () => clock });
    const tourId = await createTour(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' }).expect(200);
    await autoClose(world, tourId);
    clock = NOW;

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('no_show');
    expect(res.body.tour.lastMarkedAt).toBe(NOW);
    for (const field of CLEARED_FIELDS) expect(res.body.tour, field).not.toHaveProperty(field);
  });

  it('closed as not a fit -> toured with the decision removed, and the exit gate works again after it', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'toured' }).expect(200);
    await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'not_a_fit', moveForward: false, status: 'closed' })
      .expect(200);
    expect(world.toursMap.get(tourId)).toMatchObject({
      status: 'closed',
      outcome: 'not_a_fit',
      moveForward: false,
      convertible: false,
    });

    const res = await reopen(app, tourId).send({});

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('toured');
    for (const field of CLEARED_FIELDS) expect(res.body.tour, field).not.toHaveProperty(field);

    // The normal flow after a reopen: record a different decision.
    const decided = await authed(app)
      .patch(`/api/tours/${tourId}`)
      .send({ outcome: 'move_forward', moveForward: true });
    expect(decided.status).toBe(200);
    expect(decided.body.tour).toMatchObject({
      status: 'toured',
      outcome: 'move_forward',
      moveForward: true,
      convertible: true,
    });
  });

  it('reads the tour CONSISTENTLY before its conditional write', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await autoClose(world, tourId);
    const readOpts: unknown[] = [];
    const realGet = world.toursRepo.get;
    world.toursRepo.get = async (id, opts) => {
      readOpts.push(opts);
      return realGet(id, opts);
    };

    await reopen(app, tourId).send({}).expect(200);

    expect(readOpts).toEqual([{ consistentRead: true }]);
  });

  it('after a reopen, GET shows the reopened tour and a second reopen is 409 tour_not_closed', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await autoClose(world, tourId);
    await reopen(app, tourId).send({}).expect(200);

    const got = await authed(app).get(`/api/tours/${tourId}`);
    expect(got.status).toBe(200);
    expect(got.body.tour).toMatchObject({ tourId, status: 'scheduled', lastMarkedAt: NOW });
    for (const field of CLEARED_FIELDS) expect(got.body.tour, field).not.toHaveProperty(field);

    const again = await reopen(app, tourId).send({});
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'tour_not_closed' });
    expect(tourReopenedRows(world, tourId)).toHaveLength(1);
  });
});

// ============================================================================
// Side effects (spec 7.4) and the lost race.
// ============================================================================

describe('POST /api/tours/:tourId/reopen - side effects', () => {
  it("records tour_reopened through the shared writer: both parties' timelines, the units# and tours# rows", async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    seedUnitWithLandlord(world, LANDLORD);
    const tourId = await createTour(app);
    await autoClose(world, tourId);

    await reopen(app, tourId).send({}).expect(200);

    expect(
      world.activityEvents
        .filter((e) => e.type === 'tour_reopened')
        .map((e) => [e.contactId, e.label, e.refType, e.refId]),
    ).toEqual([
      [TENANT, 'Tour reopened', 'tour', tourId],
      [LANDLORD, 'Tour reopened', 'tour', tourId],
    ]);
    expect(world.auditEvents.filter((e) => e.event_type === 'tour_reopened')).toEqual([
      { entityKey: 'units#unit-abc', event_type: 'tour_reopened', payload: { tourId } },
      { entityKey: `tours#${tourId}`, event_type: 'tour_reopened', payload: { tourId } },
    ]);
  });

  it("clears a pending close-nag on the tour's OWN open relay group", async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    const groupId = await linkOpenGroupWithNag(world, tourId, '+15550100090', { type: 'tour', id: tourId });
    await autoClose(world, tourId);

    await reopen(app, tourId).send({}).expect(200);

    expect(world.conversations.get(groupId)!.close_nag_next_at).toBeUndefined();
  });

  it('leaves the close-nag on a linked group another owner holds (a placement)', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    const groupId = await linkOpenGroupWithNag(world, tourId, '+15550100091', {
      type: 'placement',
      id: 'placement-x',
    });
    await autoClose(world, tourId);

    await reopen(app, tourId).send({}).expect(200);

    expect(world.conversations.get(groupId)!.close_nag_next_at).toBe(NAG_AT);
  });

  it('emits exactly one tour.updated { tourId, status: <the target> } and nothing else', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await authed(app).patch(`/api/tours/${tourId}`).send({ status: 'no_show' }).expect(200);
    await autoClose(world, tourId);
    const emitsBefore = world.emitted.length;

    await reopen(app, tourId).send({}).expect(200);

    expect(world.emitted.slice(emitsBefore)).toEqual([
      { event: 'tour.updated', payload: { tourId, status: 'no_show' } },
    ]);
  });

  it('a reopen that loses its conditional write to a concurrent reopen answers 409 tour_changed and records nothing', async () => {
    const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
    const tourId = await createTour(app);
    await autoClose(world, tourId);

    // The in-memory harness runs a request's read-check-write in one go, so
    // two "parallel" reopens never interleave on their own. PARK the first
    // between its read and its write: its reopenIf first runs a COMPLETE
    // second reopen of the same tour (which wins), then forwards to the real
    // write - whose condition now fails. The flag is set BEFORE awaiting,
    // because the second request comes through this same wrapper.
    let parked = false;
    let second: request.Response | undefined;
    const realReopenIf = world.toursRepo.reopenIf;
    world.toursRepo.reopenIf = async (tour, target, lastMarkedAt) => {
      if (!parked) {
        parked = true;
        second = await reopen(app, tourId).send({});
      }
      return realReopenIf(tour, target, lastMarkedAt);
    };

    const first = await reopen(app, tourId).send({});

    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect(first.body).toEqual({ error: 'tour_changed' });
    // Exactly ONE reopen happened. A reopen also pins the tenant and writes a
    // units# row, so count the tour's own tours# row.
    expect(tourReopenedRows(world, tourId)).toHaveLength(1);
    expect(world.emitted.filter((e) => e.event === 'tour.updated')).toHaveLength(1);
    expect(world.toursMap.get(tourId)).toMatchObject({ status: 'scheduled', lastMarkedAt: NOW });
  });
});

describe('POST /api/tours/:tourId/reopen stays behind requireAuth', () => {
  it('403s without the origin secret and 401s without a session', async () => {
    const { app } = makeWebhookHarness();

    // No origin secret -> 403.
    expect((await request(app).post('/api/tours/x/reopen').send({})).status).toBe(403);

    // Origin secret but no session -> 401.
    const noSession = await request(app)
      .post('/api/tours/x/reopen')
      .set('x-origin-verify', SECRET)
      .send({});
    expect(noSession.status).toBe(401);
  });
});
