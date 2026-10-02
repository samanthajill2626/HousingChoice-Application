// Unit tests for lib/tourEvents.ts - the ONE writer for a tour lifecycle event
// (tour auto-close plan Task 3.2). The tours router delegates to it, and the
// auto-close sweep and the reopen route call it directly, so its contract is
// pinned here against the harness fake world: the three surfaces (BOTH
// parties' contact timelines, the property's `units#` audit row, the tour's
// own `tours#` audit row), their order, and the best-effort guards (nothing it
// writes may fail the caller - the state it describes is already persisted).
// The route-level behavior stays pinned through the real routes in
// toursApi.test.ts.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { recordTourEvent, type TourEventDeps } from '../src/lib/tourEvents.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

// toursApi.test.ts's fixture ids: BASE_CREATE_BODY's tenant and unit, and the
// landlord its seeding helpers give unit-abc.
const TENANT = 'contact-tenant-1';
const UNIT = 'unit-abc';
const LANDLORD = 'c-ll';
const TOUR = 'tour-x';
const SUBJECT = { tenantId: TENANT, unitId: UNIT, tourId: TOUR };
const AUTO_CLOSED_LABEL = 'Tour closed automatically: no outcome recorded after two weeks';
const PINO_ERROR = 50;

// Copied from toursApi.test.ts (its local helper is not exported).
function seedUnitWithLandlord(world: FakeWorld, landlordId: string): void {
  world.units.set('unit-abc', {
    unitId: 'unit-abc',
    landlordId,
    status: 'available',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  });
}

function setup(): { world: FakeWorld; deps: TourEventDeps; capture: LogCapture } {
  const world = createFakeWorld();
  seedUnitWithLandlord(world, LANDLORD);
  const capture = createLogCapture();
  const deps: TourEventDeps = {
    activityEvents: world.activityEventsRepo,
    units: world.unitsRepo,
    audit: world.auditRepo,
    log: createLogger({ destination: capture.stream }),
  };
  return { world, deps, capture };
}

describe('recordTourEvent - the shared tour-event writer', () => {
  it('pins the event on the tenant AND the unit landlord, then writes the units# and tours# audit rows', async () => {
    const { world, deps } = setup();

    await recordTourEvent(deps, SUBJECT, 'tour_auto_closed', 'tour_auto_closed', AUTO_CLOSED_LABEL);

    // One event, two feeds: the tenant's copy first, then the landlord's.
    expect(world.activityEvents).toHaveLength(2);
    expect(world.activityEvents[0]).toMatchObject({
      contactId: TENANT,
      type: 'tour_auto_closed',
      label: AUTO_CLOSED_LABEL,
      refType: 'tour',
      refId: TOUR,
    });
    expect(world.activityEvents[1]).toMatchObject({
      contactId: LANDLORD,
      type: 'tour_auto_closed',
      label: AUTO_CLOSED_LABEL,
      refType: 'tour',
      refId: TOUR,
    });
    // The property's Activity card row, then the tour's own history row - in
    // that order, ids only in the payload.
    expect(world.auditEvents).toEqual([
      { entityKey: 'units#unit-abc', event_type: 'tour_auto_closed', payload: { tourId: TOUR } },
      { entityKey: 'tours#tour-x', event_type: 'tour_auto_closed', payload: { tourId: TOUR } },
    ]);
  });

  it('writes the activity type to the timelines and the audit type to the audit rows (the reschedule shape)', async () => {
    const { world, deps } = setup();

    await recordTourEvent(deps, SUBJECT, 'tour_scheduled', 'tour_rescheduled', 'Tour rescheduled');

    expect(world.activityEvents.map((e) => [e.contactId, e.type, e.label])).toEqual([
      [TENANT, 'tour_scheduled', 'Tour rescheduled'],
      [LANDLORD, 'tour_scheduled', 'Tour rescheduled'],
    ]);
    expect(world.auditEvents.map((e) => [e.entityKey, e.event_type])).toEqual([
      ['units#unit-abc', 'tour_rescheduled'],
      ['tours#tour-x', 'tour_rescheduled'],
    ]);
  });

  it('a failing audit append never fails the caller: it resolves and the timeline pins still land', async () => {
    const { world, deps, capture } = setup();
    world.failAuditAppendFor.add('tour_auto_closed');

    await expect(
      recordTourEvent(deps, SUBJECT, 'tour_auto_closed', 'tour_auto_closed', AUTO_CLOSED_LABEL),
    ).resolves.toBeUndefined();

    expect(world.activityEvents.map((e) => [e.contactId, e.type])).toEqual([
      [TENANT, 'tour_auto_closed'],
      [LANDLORD, 'tour_auto_closed'],
    ]);
    expect(world.auditEvents).toHaveLength(0);
    // Each failed write is logged on its own line with the tourId - and the
    // label (human text) is never logged.
    const errors = capture.atLevel(PINO_ERROR);
    expect(errors.map((l) => [l['msg'], l['tourId']])).toEqual([
      ['tour_auto_closed unit audit failed (best-effort)', TOUR],
      ['tour_auto_closed tour audit failed (best-effort)', TOUR],
    ]);
    expect(JSON.stringify(capture.lines)).not.toContain(AUTO_CLOSED_LABEL);
  });

  it('guards each audit write on its own: a failing units# append still writes the tours# row', async () => {
    const { world, deps } = setup();
    const realAppend = world.auditRepo.append.bind(world.auditRepo);
    world.auditRepo.append = async (entityKey, eventType, payload) => {
      if (entityKey.startsWith('units#')) throw new Error('injected units# audit failure');
      return realAppend(entityKey, eventType, payload);
    };

    await recordTourEvent(deps, SUBJECT, 'tour_reopened', 'tour_reopened', 'Tour reopened');

    expect(world.auditEvents).toEqual([
      { entityKey: 'tours#tour-x', event_type: 'tour_reopened', payload: { tourId: TOUR } },
    ]);
  });

  it('a failing timeline write never fails the caller, and both audit rows still land', async () => {
    const { world, deps } = setup();
    world.activityEventsRepo.record = async () => {
      throw new Error('injected activity-event failure');
    };

    await expect(
      recordTourEvent(deps, SUBJECT, 'tour_reopened', 'tour_reopened', 'Tour reopened'),
    ).resolves.toBeUndefined();

    expect(world.auditEvents.map((e) => [e.entityKey, e.event_type])).toEqual([
      ['units#unit-abc', 'tour_reopened'],
      ['tours#tour-x', 'tour_reopened'],
    ]);
  });

  it('requires activityEvents in its deps, so no caller can silently drop both pins (decision D-c)', () => {
    const world = createFakeWorld();
    const log = createLogger({ destination: createLogCapture().stream });
    // Compile-time pin (npm run typecheck): PersonMilestoneDeps leaves the repo
    // optional, and an absent one skips BOTH pins without a word.
    // @ts-expect-error - activityEvents is REQUIRED on TourEventDeps
    const deps: TourEventDeps = { units: world.unitsRepo, audit: world.auditRepo, log };
    expect(deps.activityEvents).toBeUndefined();
  });
});
