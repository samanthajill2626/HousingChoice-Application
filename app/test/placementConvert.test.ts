// Post-Tour & Application conversion tests — POST /api/placements/from-tour.
//
//   POST /api/placements/from-tour { tourId } → 201 { placement, tour }
//
// Creates a placement from a CONVERTIBLE tour, finalizes the tour (closed +
// convertedPlacementId + a ROTATED reminder-ladder pointer, one write) and
// re-parents the tour's masked relay thread to the placement. The tour's unsent
// rungs are then swept - DELETED, not canceled (supersession spec 3.2). QUIET
// conversion (no announcement is sent).
//
// Mirrors toursApi.test.ts: in-memory fakes via makeWebhookHarness (no DynamoDB,
// no network), authed via the seeded dev session cookie.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  runDueTourReminders,
  type RunDueTourRemindersDeps,
} from '../src/jobs/tourReminders.js';
import { createLogger } from '../src/lib/logger.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { quietOffSettingsRepo } from './helpers/settingsStub.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
  type Harness,
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

// --- supersession fixtures (S8) --------------------------------------------
//
// The ladder pointer a post-migration tour carries, and one plausible ladder
// under it. Deterministic literals: the ROTATION the finalize writes is the
// only value in these tests that is a random UUID, which is exactly what makes
// "the pointer changed and now matches no row" assertable.
const LADDER_BEFORE = 'ladder-convert-before';
const TOUR_AT = '2026-07-15T18:00:00.000Z';
const DAY_BEFORE_DUE = '2026-07-14T23:30:00.000Z';
const MORNING_OF_DUE = '2026-07-15T13:00:00.000Z';
const EN_ROUTE_DUE = '2026-07-15T16:30:00.000Z';
/** One minute after the morning_of rung falls due - inside the poll's
 *  conversion-claim grace window (CONVERSION_CLAIM_GRACE_MS is an hour). */
const POLL_AT = '2026-07-15T13:01:00.000Z';
const SENT_BODY = 'Reminder: your tour is tomorrow.';

interface SeededLadder {
  sentId: string;
  morningOfId: string;
  enRouteId: string;
}

/**
 * A CONVERTIBLE tour that is still `scheduled` and still ARMED: one rung
 * already SENT (history, which no retirement may touch) plus two pending rungs,
 * all three stamped with the tour's CURRENT ladderId.
 *
 * This is the state a conversion must leave completely untouched when it FAILS
 * (the claim is released and the tour is retryable, so it has to still be
 * armed) and must retire when it LANDS.
 */
async function seedArmedConvertibleTour(
  world: FakeWorld,
  tourId: string,
  tenantId: string,
  unitId: string,
): Promise<SeededLadder> {
  world.toursMap.set(tourId, {
    tourId,
    tenantId,
    unitId,
    tourType: 'self_guided',
    status: 'scheduled',
    scheduledAt: TOUR_AT,
    convertible: true,
    currentLadderId: LADDER_BEFORE,
    _schedPartition: 'tours',
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  });
  const sent = await world.tourRemindersRepo.create({
    tourId,
    kind: 'day_before',
    dueAt: DAY_BEFORE_DUE,
    ladderId: LADDER_BEFORE,
  });
  await world.tourRemindersRepo.claimSend(sent.reminderId, DAY_BEFORE_DUE, SENT_BODY);
  const morningOf = await world.tourRemindersRepo.create({
    tourId,
    kind: 'morning_of',
    dueAt: MORNING_OF_DUE,
    ladderId: LADDER_BEFORE,
  });
  const enRoute = await world.tourRemindersRepo.create({
    tourId,
    kind: 'en_route',
    dueAt: EN_ROUTE_DUE,
    ladderId: LADDER_BEFORE,
  });
  return {
    sentId: sent.reminderId,
    morningOfId: morningOf.reminderId,
    enRouteId: enRoute.reminderId,
  };
}

/**
 * Nothing was retired: every seeded row is still in the table, the two pending
 * rungs are still PENDING (not canceled, not skipped - in particular not
 * stamped `superseded`, which is terminal and could not be undone by releasing
 * the claim), and the pointer still names the ladder they belong to.
 */
function expectLadderIntact(world: FakeWorld, tourId: string, ids: SeededLadder): void {
  const rows = [...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId);
  expect(rows.map((r) => r.reminderId).sort()).toEqual(
    [ids.sentId, ids.morningOfId, ids.enRouteId].sort(),
  );
  for (const id of [ids.morningOfId, ids.enRouteId]) {
    const row = world.tourRemindersMap.get(id)!;
    expect(row.sentAt).toBeUndefined();
    expect(row.canceledAt).toBeUndefined();
    expect(row.skippedAt).toBeUndefined();
    expect(row.skipReason).toBeUndefined();
  }
  expect(world.tourRemindersMap.get(ids.sentId)!.sentAt).toBe(DAY_BEFORE_DUE);
  expect(world.toursMap.get(tourId)!.currentLadderId).toBe(LADDER_BEFORE);
}

/**
 * The worker's tour-reminder poll wired to the SAME world fakes the route wrote
 * to - the dev-tick shape (routes/dev.ts, devGating.test.ts) minus the HTTP
 * seam. Quiet hours are stubbed OFF so the fixture instants above mean exactly
 * what they say.
 */
function pollDeps(harness: Harness): RunDueTourRemindersDeps {
  const { world, capture, config } = harness;
  const logger = createLogger({ level: 'info', destination: capture.stream });
  return {
    tourRemindersRepo: world.tourRemindersRepo,
    toursRepo: world.toursRepo,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    unitsRepo: world.unitsRepo,
    messagesRepo: world.messagesRepo,
    adapter: world.adapter,
    settingsRepo: quietOffSettingsRepo(),
    sendMessageService: createSendMessageService({
      config,
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
    }),
    events: world.events,
    logger,
  };
}

describe('POST /api/placements/from-tour — conversion', () => {
  it('happy path: converts a convertible tour with a group thread, finalizes tour, rebinds thread, derives tenant to placing, rotates the ladder pointer and DELETES the unsent rungs', async () => {
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
      currentLadderId: LADDER_BEFORE,
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    // The tour's armed ladder: one rung already SENT (history that survives the
    // conversion) and two pending rungs (what the conversion retires).
    const sent = await world.tourRemindersRepo.create({
      tourId,
      kind: 'day_before',
      dueAt: DAY_BEFORE_DUE,
      ladderId: LADDER_BEFORE,
    });
    await world.tourRemindersRepo.claimSend(sent.reminderId, DAY_BEFORE_DUE, SENT_BODY);
    const morningOf = await world.tourRemindersRepo.create({
      tourId,
      kind: 'morning_of',
      dueAt: MORNING_OF_DUE,
      ladderId: LADDER_BEFORE,
    });
    const enRoute = await world.tourRemindersRepo.create({
      tourId,
      kind: 'en_route',
      dueAt: EN_ROUTE_DUE,
      ladderId: LADDER_BEFORE,
    });

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

    // THE LADDER IS RETIRED BY DELETION, not by cancellation (supersession
    // acceptance 7): the unsent rungs are ABSENT from the table - a canceled row
    // would still be there, and would still be listed by every reader.
    expect(world.tourRemindersMap.has(morningOf.reminderId)).toBe(false);
    expect(world.tourRemindersMap.has(enRoute.reminderId)).toBe(false);
    // The rung that already went out SURVIVES, with the body it was sent with.
    const survivor = world.tourRemindersMap.get(sent.reminderId)!;
    expect(survivor.sentAt).toBe(DAY_BEFORE_DUE);
    expect(survivor.sentBody).toBe(SENT_BODY);
    expect([...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId)).toHaveLength(1);

    // The pointer ROTATED inside the finalize (acceptance 7a): present, different
    // from the ladder it replaced, and matching NO surviving row - so a rung the
    // sweep missed is refused by the poll and by Send now rather than sent on a
    // converted tour.
    const rotated = storedTour.currentLadderId;
    expect(typeof rotated).toBe('string');
    expect(rotated).not.toBe(LADDER_BEFORE);
    expect([...world.tourRemindersMap.values()].some((r) => r.ladderId === rotated)).toBe(false);
    // The 201 re-reads the tour before responding, so the response carries the
    // rotated pointer rather than the pre-finalize one.
    expect((res.body.tour as Record<string, unknown>)['currentLadderId']).toBe(rotated);
  });

  it('CONCURRENT REVIVAL: the post-finalize sweep is REFUSED BY THE STORE when another writer owns the ladder', async () => {
    const { app, world, capture } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-owned';
    const ids = await seedArmedConvertibleTour(world, tourId, tenantId, unitId);

    // A concurrent reschedule lands between the finalize and the sweep: it
    // rotates the pointer to its OWN ladder and arms it. Every delete in the
    // sweep rides a ConditionCheck on the finalize's own rotation (spec 3.2
    // step 4, review rounds B1/NEW-1), so the STORE refuses the whole sweep -
    // no read, no window, and the winner's live rungs are untouchable rather
    // than merely un-deleted-this-time.
    const REVIVAL_LADDER = 'ladder-concurrent-revival';
    const revived: string[] = [];
    const realPatch = world.toursRepo.patch;
    world.toursRepo.patch = async (id, updates) => {
      const out = await realPatch(id, updates);
      if ('convertedPlacementId' in updates && revived.length === 0) {
        const t = world.toursMap.get(id)!;
        t.currentLadderId = REVIVAL_LADDER;
        world.toursMap.set(id, t);
        for (const kind of ['morning_of', 'en_route'] as const) {
          const row = await world.tourRemindersRepo.create({
            tourId: id,
            kind,
            dueAt: MORNING_OF_DUE,
            ladderId: REVIVAL_LADDER,
          });
          revived.push(row.reminderId);
        }
      }
      return out;
    };

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    // The 201 STANDS: the conversion is persisted and is never rolled back for a
    // sweep decision.
    expect(res.status).toBe(201);

    // Nothing was swept - not the winner's fresh rows, and not this ladder's
    // either (the whole sweep is abandoned, by identity).
    expect(revived).toHaveLength(2);
    for (const id of revived) expect(world.tourRemindersMap.has(id)).toBe(true);
    expect(world.tourRemindersMap.has(ids.morningOfId)).toBe(true);
    expect(world.tourRemindersMap.has(ids.enRouteId)).toBe(true);
    expect(world.toursMap.get(tourId)!.currentLadderId).toBe(REVIVAL_LADDER);

    // And NOTHING is logged at error: a newer generation taking the tour is the
    // design working, not a failure. The repo says so at info instead.
    expect(
      capture.atLevel(50).filter((l) => l['tourId'] === tourId),
    ).toHaveLength(0);
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

  // --- roster inheritance (contact-rosters D4) -------------------------------

  it('a THREAD-BEARING tour needs no roster copy: the participants ride the rebind', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550309998',
      members: [
        { phone: '+15550300001', contactId: tenantId },
        { phone: '+15550300002', contactId: 'll-convert-1' },
      ],
      owner: { type: 'tour', id: 'tour-convert-fact' },
    });

    const tourId = 'tour-convert-fact';
    world.toursMap.set(tourId, {
      tourId,
      tenantId,
      unitId,
      tourType: 'landlord_led',
      status: 'toured',
      convertible: true,
      groupThreadId: conversation.conversationId,
      // A stale plan left by a crash between the pointer write and the delete is
      // INERT (spec D1) - the thread wins, and conversion must not resurrect it.
      roster: [{ contactId: 'c-ghost' }],
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(res.status).toBe(201);

    const placement = res.body.placement as Record<string, unknown>;
    expect(placement['group_thread']).toBe(conversation.conversationId);
    expect(placement['roster']).toBeUndefined();
    // The rebound thread still carries both members - that IS the inheritance.
    const rebound = world.conversations.get(conversation.conversationId)!;
    expect((rebound.participants ?? []).map((p) => p.contactId)).toEqual([tenantId, 'll-convert-1']);
  });

  it('a PLAN-ONLY tour (no thread) hands its roster to the placement, verbatim', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-plan';
    world.toursMap.set(tourId, {
      tourId,
      tenantId,
      unitId,
      tourType: 'self_guided',
      status: 'toured',
      convertible: true,
      roster: [{ contactId: 'c-caseworker' }, { phone: '+15550300007' }],
      rosterVersion: 3,
      _schedPartition: 'tours',
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(res.status).toBe(201);

    const placement = res.body.placement as Record<string, unknown>;
    expect(placement['group_thread']).toBeUndefined();
    expect(placement['roster']).toEqual([{ contactId: 'c-caseworker' }, { phone: '+15550300007' }]);
    // The placement starts its own optimistic-concurrency line, not the tour's.
    expect(placement['rosterVersion']).toBe(1);
  });

  it('records the tours# tour_converted milestone + emits tour.updated (tour-detail-page 1a)', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-audit';
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

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(res.status).toBe(201);
    const placementId = (res.body.placement as Record<string, unknown>)['placementId'] as string;

    // Exactly one tours#<tourId> tour_converted audit row, carrying the created
    // placementId (the tour Activity card links it) + the acting user.
    const converted = world.auditEvents.filter(
      (e) => e.entityKey === `tours#${tourId}` && e.event_type === 'tour_converted',
    );
    expect(converted).toHaveLength(1);
    expect(converted[0]!.payload).toMatchObject({ tourId, placementId });
    expect(converted[0]!.actorId).toBe('usr_testva00000000000000000');

    // tour.updated advised the dashboards the tour closed (ID + status only).
    const tourUpdates = world.emitted.filter((e) => e.event === 'tour.updated');
    expect(tourUpdates).toHaveLength(1);
    expect(tourUpdates[0]!.payload).toEqual({ tourId, status: 'closed' });
  });

  it('records tour_converted person milestones for BOTH the tenant and the unit landlord', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId, landlordId } = seedTenantAndUnit(world);

    const tourId = 'tour-convert-person';
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

    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(res.status).toBe(201);

    const converted = world.activityEvents.filter((e) => e.type === 'tour_converted');
    expect(converted).toHaveLength(2);
    expect(converted.map((e) => e.contactId).sort()).toEqual([landlordId, tenantId].sort());
    for (const pin of converted) {
      // The pin points back at the TOUR (its final chapter), not the placement.
      expect(pin).toMatchObject({
        type: 'tour_converted',
        label: 'Converted to placement',
        refType: 'tour',
        refId: tourId,
      });
    }

    // The pre-existing placement_opened tenant milestone is untouched by this.
    expect(
      world.activityEvents.filter((e) => e.type === 'placement_opened' && e.contactId === tenantId),
    ).toHaveLength(1);
  });

  it('a landlord-less unit converts fine with a tenant-only tour_converted pin', async () => {
    const { app, world } = makeWebhookHarness();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    world.units.set(unitId, { ...world.units.get(unitId)!, landlordId: '' });

    const tourId = 'tour-convert-nolandlord';
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
    const converted = world.activityEvents.filter((e) => e.type === 'tour_converted');
    expect(converted).toHaveLength(1);
    expect(converted[0]?.contactId).toBe(tenantId);
  });

  it('a failing tours# tour_converted audit write does NOT fail the conversion (best-effort)', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-audit-fail';
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

    // Fail ONLY the tours#-keyed appends; placements# and the rest still write.
    const realAppend = world.auditRepo.append.bind(world.auditRepo);
    world.auditRepo.append = async (entityKey, eventType, payload) => {
      if (entityKey.startsWith('tours#')) throw new Error('injected tours# audit failure');
      return realAppend(entityKey, eventType, payload);
    };

    const { app } = makeWebhookHarness({ world });
    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(res.status).toBe(201);
    expect(world.placements.size).toBe(1);
    expect(world.toursMap.get(tourId)!.status).toBe('closed');
    // The placements# provenance row still landed.
    expect(
      world.auditEvents.some(
        (e) => e.entityKey.startsWith('placements#') && e.event_type === 'placement_created',
      ),
    ).toBe(true);
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

  // --- supersession: the ladder is retired by the FINALIZE, never before ----
  //
  // Both halves of spec 3.2's argument, one test each. A pre-finalize
  // retirement passes the first of these and fails the second, which is why
  // they are written as a pair.

  it('placements.create failure leaves the ladder INTACT: the tour is released, still scheduled, and still armed', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-create-fail-ladder';
    const ids = await seedArmedConvertibleTour(world, tourId, tenantId, unitId);

    world.placementsRepo.create = async () => {
      throw new Error('injected placements.create failure');
    };

    const { app } = makeWebhookHarness({ world });
    const failed = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(failed.status).toBe(500);

    // The claim was RELEASED, so the tour is unconverted and retryable...
    const afterFail = world.toursMap.get(tourId)!;
    expect(afterFail.convertedPlacementId).toBeUndefined();
    expect(afterFail.status).toBe('scheduled');
    expect(world.placements.size).toBe(0);
    // ...and a retryable tour has to be an ARMED one. Nothing about this request
    // reached a decision the tour's reminders should be retired for.
    expectLadderIntact(world, tourId, ids);
  });

  it('FINALIZE failure leaves the ladder INTACT: the orphan placement exists, but the tour is released, still scheduled, and still armed', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-finalize-fail-ladder';
    const ids = await seedArmedConvertibleTour(world, tourId, tenantId, unitId);

    // Fail the FIRST toursRepo.patch only - the finalize is this route's single
    // patch call, so this hits the finalize and nothing else. The release path
    // goes through releaseConversionClaim, which is untouched.
    const realPatch = world.toursRepo.patch.bind(world.toursRepo);
    let failNext = true;
    world.toursRepo.patch = async (id, updates) => {
      if (failNext) {
        failNext = false;
        throw new Error('injected finalize patch failure');
      }
      return realPatch(id, updates);
    };

    const { app } = makeWebhookHarness({ world });
    const failed = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(failed.status).toBe(500);

    // ACCEPTED RESIDUE (the route says so): the placement was already created and
    // is now an orphan. The TOUR, though, is released and unconverted.
    expect(world.placements.size).toBe(1);
    const afterFail = world.toursMap.get(tourId)!;
    expect(afterFail.convertedPlacementId).toBeUndefined();
    expect(afterFail.status).toBe('scheduled');
    // This is the half a sweep-before-create gets wrong: the conversion never
    // became real, so the ladder must be exactly as it was.
    expectLadderIntact(world, tourId, ids);
  });

  it('a rung due while the conversion claim is IN FLIGHT is deferred by the poll, and the conversion that lands then deletes it', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-claim-window';
    const ids = await seedArmedConvertibleTour(world, tourId, tenantId, unitId);

    // Park the conversion INSIDE placements.create, so the request sits with its
    // `pending:` sentinel written - the exact window the poll's deferral exists
    // for, driven end to end rather than hand-stamped.
    const realCreate = world.placementsRepo.create.bind(world.placementsRepo);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    world.placementsRepo.create = async (input) => {
      entered();
      await held;
      return realCreate(input);
    };

    const harness = makeWebhookHarness({ world });
    // `.then` is what fires a supertest request - it is lazy until then.
    const conversion = authed(harness.app)
      .post('/api/placements/from-tour')
      .send({ tourId })
      .then((r) => r);
    await inFlight;

    // ANTI-VACUITY, both halves: the claim really is in flight, and the
    // morning_of rung really is due at POLL_AT (a retired one would not be
    // listed at all, and "nothing was stamped" would then prove nothing).
    expect(world.toursMap.get(tourId)!.convertedPlacementId).toMatch(/^pending:/);
    expect((await world.tourRemindersRepo.listDue(POLL_AT)).map((r) => r.reminderId)).toContain(
      ids.morningOfId,
    );

    await runDueTourReminders(POLL_AT, pollDeps(harness));

    // DEFERRED: returned UNCLAIMED with nothing sent and nothing stamped, so it
    // re-lists next tick if the conversion releases.
    expect(world.sent).toHaveLength(0);
    const deferred = world.tourRemindersMap.get(ids.morningOfId)!;
    expect(deferred.sentAt).toBeUndefined();
    expect(deferred.skippedAt).toBeUndefined();
    expect(deferred.skipReason).toBeUndefined();

    release();
    const res = await conversion;
    expect(res.status).toBe(201);

    // The conversion is real now, so the rung the poll deferred is GONE - and
    // the pointer moved off the ladder either way.
    expect(world.tourRemindersMap.has(ids.morningOfId)).toBe(false);
    expect(world.tourRemindersMap.has(ids.enRouteId)).toBe(false);
    expect(world.tourRemindersMap.has(ids.sentId)).toBe(true);
    expect(world.toursMap.get(tourId)!.currentLadderId).not.toBe(LADDER_BEFORE);
  });

  it('migrates the tour PENDING roster actions onto the placement (contact-rosters D4/Task 13)', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-actions';
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
    // One PENDING open deferred to quiet-end, plus a TERMINAL notice that must
    // stay with the tour's own history.
    await world.pendingRosterActionsRepo.upsertPending({
      ownerType: 'tour',
      ownerId: tourId,
      action: 'open_group',
      dueAt: '2026-07-15T12:00:00.000Z',
      createdAt: '2026-07-15T03:00:00.000Z',
    });
    await world.pendingRosterActionsRepo.upsertPending({
      ownerType: 'tour',
      ownerId: tourId,
      action: 'add_member',
      contactId: 'c-old',
      dueAt: '2026-07-14T12:00:00.000Z',
      createdAt: '2026-07-14T03:00:00.000Z',
    });
    await world.pendingRosterActionsRepo.claimSkip(
      `tour#${tourId}#add#c-old`,
      '2026-07-14T12:00:01.000Z',
      'already_member',
    );

    const { app } = makeWebhookHarness({ world });
    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });
    expect(res.status).toBe(201);
    const placementId = (res.body.placement as Record<string, unknown>)['placementId'] as string;

    // The PENDING row moved (its deterministic id was rewritten with the owner).
    expect(await world.pendingRosterActionsRepo.getById(`tour#${tourId}#open`)).toBeUndefined();
    const moved = await world.pendingRosterActionsRepo.getById(`placement#${placementId}#open`);
    expect(moved!.status).toBe('pending');
    expect(moved!.ownerKey).toBe(`placement#${placementId}`);
    expect(moved!.dueAt).toBe('2026-07-15T12:00:00.000Z');

    // The TERMINAL notice stayed with the tour.
    const stayed = await world.pendingRosterActionsRepo.getById(`tour#${tourId}#add#c-old`);
    expect(stayed!.status).toBe('skipped');
  });

  it('a failing action migration NEVER fails the conversion (the poller retires the orphan)', async () => {
    const world = createFakeWorld();
    const { tenantId, unitId } = seedTenantAndUnit(world);
    const tourId = 'tour-convert-migrate-fail';
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
    await world.pendingRosterActionsRepo.upsertPending({
      ownerType: 'tour',
      ownerId: tourId,
      action: 'open_group',
      dueAt: '2026-07-15T12:00:00.000Z',
      createdAt: '2026-07-15T03:00:00.000Z',
    });
    world.pendingRosterActionsRepo.migrate = async () => {
      throw new Error('injected migrate failure');
    };

    const { app } = makeWebhookHarness({ world });
    const res = await authed(app).post('/api/placements/from-tour').send({ tourId });

    expect(res.status).toBe(201);
    // The orphan is still on the (now converted) tour - the poller's 'converted'
    // skip is what retires it visibly.
    expect((await world.pendingRosterActionsRepo.getById(`tour#${tourId}#open`))!.status).toBe(
      'pending',
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
