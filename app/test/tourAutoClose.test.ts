// Tour auto-close sweep (Sam #18; spec
// docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md section 6)
// driven against the harness world fakes. The fake toursRepo.autoCloseIf is the
// real repo's condition evaluated synchronously (parity is pinned by
// toursRepoFakeConditions.test.ts); bus emits are read from world.emitted.
//
// CLOCK TRAP (ruling D-f): the fake `create` stamps updatedAt with the WALL
// clock, and with no lastMarkedAt the two-week clock's mark IS updatedAt (spec
// 5.3) - a tour created here would not be due for 14 REAL days whatever its
// dates say. Every seed therefore pins updatedAt to the case's intended last
// change (its createdAt unless stated) right after the write, and each case's
// injected `now` is built from those values.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  runTourAutoClose,
  TOUR_AUTO_CLOSE_INTERVAL_MS,
  TOUR_AUTO_CLOSED_LABEL,
  type TourAutoCloseDeps,
} from '../src/jobs/tourAutoClose.js';
import { createLogger } from '../src/lib/logger.js';
import { AUTO_CLOSE_AFTER_MS } from '../src/lib/toursModel.js';
import { CLOSE_NAG_INTERVAL_MS } from '../src/repos/conversationsRepo.js';
import type { ReminderKind } from '../src/repos/tourRemindersRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const TENANT = 'contact-tenant-1';
const UNIT = 'unit-abc';
const LANDLORD = 'c-ll';
const DAY_MS = 24 * 60 * 60 * 1000;
const INFO = 30;
const ERROR = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The reference tour: booked ahead, never marked. Due at its time + 14 days.
const CREATED = '2026-08-25T00:00:00.000Z';
const CREATED_LATER = '2026-08-26T00:00:00.000Z';
const AT = '2026-09-01T15:00:00.000Z';
const NOW = '2026-09-20T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DUE_MS = Date.parse(AT) + AUTO_CLOSE_AFTER_MS; // 2026-09-15T15:00:00.000Z

const iso = (ms: number): string => new Date(ms).toISOString();

interface Fixture {
  world: FakeWorld;
  capture: LogCapture;
  deps: TourAutoCloseDeps;
}

/** A world with the tenant contact and a unit whose landlord is LANDLORD, and
 *  the sweep's deps wired to it exactly as the worker builds them. */
function fixture(): Fixture {
  const world = createFakeWorld();
  world.contacts.push({ contactId: TENANT, type: 'tenant', status: 'searching' });
  world.units.set(UNIT, {
    unitId: UNIT,
    landlordId: LANDLORD,
    status: 'available',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  });
  const capture = createLogCapture();
  const deps: TourAutoCloseDeps = {
    toursRepo: world.toursRepo,
    tourRemindersRepo: world.tourRemindersRepo,
    conversationsRepo: world.conversationsRepo,
    unitsRepo: world.unitsRepo,
    auditRepo: world.auditRepo,
    activityEventsRepo: world.activityEventsRepo,
    events: world.events,
    logger: createLogger({ destination: capture.stream }),
  };
  return { world, capture, deps };
}

type SeedInput = Partial<TourItem> & { createdAt: string };

/** Create a tour through the fake, then pin its updatedAt (the CLOCK TRAP). */
async function seedTour(world: FakeWorld, input: SeedInput): Promise<string> {
  const { updatedAt, ...rest } = input;
  const created = await world.toursRepo.create({
    tenantId: TENANT,
    unitId: UNIT,
    tourType: 'self_guided',
    ...rest,
  });
  world.toursMap.get(created.tourId)!.updatedAt = updatedAt ?? input.createdAt;
  return created.tourId;
}

/** An OPEN relay group owned by the tour, linked through groupThreadId with a
 *  direct map write (so the tour's updatedAt - its clock - is untouched). */
async function openGroupFor(
  world: FakeWorld,
  tourId: string,
  poolNumber: string,
  nagAt?: string,
): Promise<string> {
  const group = await world.conversationsRepo.createRelayGroup({
    poolNumber,
    members: [{ phone: '+15550100001', contactId: '', name: 'Alice' }],
    owner: { type: 'tour', id: tourId },
  });
  if (nagAt !== undefined) world.conversations.get(group.conversationId)!.close_nag_next_at = nagAt;
  world.toursMap.get(tourId)!.groupThreadId = group.conversationId;
  return group.conversationId;
}

const statusOf = (world: FakeWorld, tourId: string): string | undefined => world.toursMap.get(tourId)?.status;

describe('runTourAutoClose', () => {
  it('pins the constants: a 15-minute poll and the person-timeline label', () => {
    expect(TOUR_AUTO_CLOSE_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(TOUR_AUTO_CLOSED_LABEL).toBe('Tour closed automatically: no outcome recorded after two weeks');
  });

  it('closes a due scheduled tour: no_outcome from scheduled, both pins, both audit rows, both events', async () => {
    const { world, capture, deps } = fixture();
    const tourId = await seedTour(world, { createdAt: CREATED, scheduledAt: AT, currentLadderId: 'ladder-old' });
    const wallBefore = Date.now();

    const summary = await runTourAutoClose(NOW, deps);

    expect(summary).toEqual({ scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 });
    const t = world.toursMap.get(tourId)!;
    expect(t.status).toBe('closed');
    expect(t.outcome).toBe('no_outcome');
    expect(t.autoClosedFrom).toBe('scheduled');
    // Every stamp is the WALL clock; the injected now only picks who is due.
    expect(Date.parse(t.autoClosedAt!)).toBeGreaterThanOrEqual(wallBefore);
    expect(t.updatedAt).toBe(t.autoClosedAt);
    // A fresh rotation: the pointer now names a ladder no row carries.
    expect(t.currentLadderId).toMatch(UUID_RE);
    expect(t.scheduledAt).toBe(AT);

    const pins = world.activityEvents.map((e) => ({
      contactId: e.contactId,
      type: e.type,
      label: e.label,
      refType: e.refType,
      refId: e.refId,
    }));
    expect(pins).toEqual([
      { contactId: TENANT, type: 'tour_auto_closed', label: TOUR_AUTO_CLOSED_LABEL, refType: 'tour', refId: tourId },
      { contactId: LANDLORD, type: 'tour_auto_closed', label: TOUR_AUTO_CLOSED_LABEL, refType: 'tour', refId: tourId },
    ]);
    expect(world.auditEvents).toEqual([
      { entityKey: `units#${UNIT}`, event_type: 'tour_auto_closed', payload: { tourId } },
      { entityKey: `tours#${tourId}`, event_type: 'tour_auto_closed', payload: { tourId } },
    ]);
    expect(world.emitted).toEqual([
      { event: 'tour.updated', payload: { tourId, status: 'closed' } },
      { event: 'scheduled.updated', payload: { contactId: TENANT } },
    ]);

    // Info: one line per closed tour (ids only), then one run summary.
    const info = capture.atLevel(INFO);
    const closedLines = info.filter((l) => l['msg'] === 'tour closed automatically (no outcome after two weeks)');
    expect(closedLines.map((l) => [l['tourId'], l['from']])).toEqual([[tourId, 'scheduled']]);
    const runLines = info.filter((l) => l['msg'] === 'tour auto-close run');
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toMatchObject({ scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 });
  });

  it('is not due one millisecond before the 14-day boundary, and is due exactly at it', async () => {
    const { world, deps } = fixture();
    const tourId = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });

    expect(await runTourAutoClose(iso(DUE_MS - 1), deps)).toEqual({ scanned: 1, due: 0, closed: 0, lost: 0, failed: 0 });
    expect(statusOf(world, tourId)).toBe('scheduled');

    expect(await runTourAutoClose(iso(DUE_MS), deps)).toEqual({ scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 });
    expect(statusOf(world, tourId)).toBe('closed');
  });

  it('skips every non-candidate: requested, canceled, closed, needs-placement, a claimed conversion, a recent mark, a recent legacy change', async () => {
    const { world, capture, deps } = fixture();
    const old = iso(NOW_MS - 30 * DAY_MS);
    const within = iso(NOW_MS - 13 * DAY_MS);
    const ids = [
      await seedTour(world, { createdAt: old, status: 'requested' }),
      await seedTour(world, { createdAt: old, scheduledAt: old, status: 'canceled' }),
      await seedTour(world, {
        createdAt: old,
        scheduledAt: old,
        status: 'closed',
        outcome: 'not_a_fit',
        moveForward: false,
        convertible: false,
      }),
      // "Needs placement": toured, move-forward recorded, no placement yet.
      await seedTour(world, {
        createdAt: old,
        scheduledAt: old,
        status: 'toured',
        outcome: 'move_forward',
        moveForward: true,
        convertible: true,
      }),
      await seedTour(world, { createdAt: old, scheduledAt: old, status: 'toured', convertedPlacementId: 'pending:x' }),
      // Marked by a person inside the window: the clock counts from the mark.
      await seedTour(world, { createdAt: old, scheduledAt: old, status: 'toured', lastMarkedAt: within }),
      // LEGACY row (no lastMarkedAt) last changed inside the window - marked
      // just before the deploy: updatedAt stands in for the mark.
      await seedTour(world, { createdAt: old, scheduledAt: old, status: 'toured', updatedAt: within }),
    ];
    const before = ids.map((id) => ({ ...world.toursMap.get(id)! }));

    // The real poll lists only the three candidate statuses.
    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 4, due: 0, closed: 0, lost: 0, failed: 0 });
    // The dev tick's tourIds path reads tours of ANY status - still none is due.
    expect(await runTourAutoClose(NOW, deps, { tourIds: ids })).toEqual({
      scanned: 7,
      due: 0,
      closed: 0,
      lost: 0,
      failed: 0,
    });

    expect(ids.map((id) => world.toursMap.get(id))).toEqual(before);
    expect(world.activityEvents).toEqual([]);
    expect(world.auditEvents).toEqual([]);
    expect(world.emitted).toEqual([]);
    // Nothing closed and nothing failed: no run summary at info.
    expect(capture.atLevel(INFO).filter((l) => l['msg'] === 'tour auto-close run')).toEqual([]);
  });

  it('closes each candidate status: an undated toured tour (from its creation) and a no-show', async () => {
    const { world, deps } = fixture();
    const toured = await seedTour(world, { createdAt: iso(NOW_MS - 20 * DAY_MS), status: 'toured' });
    const noShow = await seedTour(world, {
      createdAt: iso(NOW_MS - 25 * DAY_MS),
      scheduledAt: iso(NOW_MS - 20 * DAY_MS),
      status: 'no_show',
    });

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 2, due: 2, closed: 2, lost: 0, failed: 0 });
    expect(world.toursMap.get(toured)).toMatchObject({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'toured' });
    expect(world.toursMap.get(toured)!.scheduledAt).toBeUndefined();
    expect(world.toursMap.get(noShow)).toMatchObject({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'no_show' });
  });

  it('a LOST close write counts as lost and runs NO side effect: no sweep, pins, audit, nag or events', async () => {
    const { world, deps } = fixture();
    const tourId = await seedTour(world, { createdAt: CREATED, scheduledAt: AT, currentLadderId: 'ladder-1' });
    const groupId = await openGroupFor(world, tourId, '+15550100090');
    const pending = await world.tourRemindersRepo.create({ tourId, kind: 'day_before', dueAt: AT, ladderId: 'ladder-1' });
    world.toursRepo.autoCloseIf = async () => undefined;

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 1, due: 1, closed: 0, lost: 1, failed: 0 });
    expect(statusOf(world, tourId)).toBe('scheduled');
    expect((await world.tourRemindersRepo.listByTour(tourId)).map((r) => r.reminderId)).toEqual([pending.reminderId]);
    expect(world.activityEvents).toEqual([]);
    expect(world.auditEvents).toEqual([]);
    expect(world.emitted).toEqual([]);
    expect(world.conversations.get(groupId)!.close_nag_next_at).toBeUndefined();
  });

  it("an unrelated write that moves a never-marked tour's updatedAt between the list read and the close wins: lost, no side effect", async () => {
    const { world, deps } = fixture();
    const tourId = await seedTour(world, { createdAt: CREATED, scheduledAt: AT, currentLadderId: 'ladder-1' });
    const groupId = await openGroupFor(world, tourId, '+15550100094');
    const realAutoCloseIf = world.toursRepo.autoCloseIf;
    world.toursRepo.autoCloseIf = async (tour, rotation) => {
      // A person resets the roster plan after the sweep listed the tour. No
      // status, outcome, date or mark changes, but the write moves updatedAt -
      // the clock of a tour nobody has marked (spec 5.3, ruling A-1).
      await world.toursRepo.clearRoster(tour.tourId);
      return realAutoCloseIf(tour, rotation);
    };

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 1, due: 1, closed: 0, lost: 1, failed: 0 });
    const t = world.toursMap.get(tourId)!;
    expect(t.updatedAt).not.toBe(CREATED);
    expect(t.status).toBe('scheduled');
    expect(t.outcome).toBeUndefined();
    expect(t.currentLadderId).toBe('ladder-1');
    expect(world.activityEvents).toEqual([]);
    expect(world.auditEvents).toEqual([]);
    expect(world.emitted).toEqual([]);
    expect(world.conversations.get(groupId)!.close_nag_next_at).toBeUndefined();
  });

  it('a close write that THROWS counts as failed, logs the tourId, and the run moves on to the next due tour', async () => {
    const { world, capture, deps } = fixture();
    const first = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });
    const second = await seedTour(world, { createdAt: CREATED_LATER, scheduledAt: AT });
    const realAutoCloseIf = world.toursRepo.autoCloseIf;
    world.toursRepo.autoCloseIf = async (tour, rotation) => {
      if (tour.tourId === first) throw new Error('dynamo unavailable');
      return realAutoCloseIf(tour, rotation);
    };

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 2, due: 2, closed: 1, lost: 0, failed: 1 });
    expect(statusOf(world, first)).toBe('scheduled');
    expect(statusOf(world, second)).toBe('closed');
    const writeErrors = capture.atLevel(ERROR).filter((l) => l['msg'] === 'tour auto-close write failed');
    expect(writeErrors.map((l) => l['tourId'])).toEqual([first]);
    // Only the closed tour got side effects.
    expect(world.activityEvents.map((e) => e.refId)).toEqual([second, second]);
    expect(world.emitted.filter((e) => e.event === 'tour.updated').map((e) => e.payload)).toEqual([
      { tourId: second, status: 'closed' },
    ]);
    // failed > 0 is reason enough for the run summary line.
    expect(capture.atLevel(INFO).filter((l) => l['msg'] === 'tour auto-close run')).toHaveLength(1);
  });

  it('arms the 28-day close-nag on an open relay group without one, and leaves an existing nag as it is', async () => {
    const { world, deps } = fixture();
    const bare = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });
    const nagged = await seedTour(world, { createdAt: CREATED_LATER, scheduledAt: AT });
    const bareGroup = await openGroupFor(world, bare, '+15550100091');
    const naggedGroup = await openGroupFor(world, nagged, '+15550100092', '2026-12-01T00:00:00.000Z');
    const wallBefore = Date.now();

    expect((await runTourAutoClose(NOW, deps)).closed).toBe(2);

    const armedAtMs = Date.parse(world.conversations.get(bareGroup)!.close_nag_next_at!);
    expect(armedAtMs).toBeGreaterThanOrEqual(wallBefore + CLOSE_NAG_INTERVAL_MS);
    expect(armedAtMs).toBeLessThanOrEqual(Date.now() + CLOSE_NAG_INTERVAL_MS);
    expect(world.conversations.get(naggedGroup)!.close_nag_next_at).toBe('2026-12-01T00:00:00.000Z');
  });

  it('a failing close-nag arm is logged WITH the tourId, and the run still closes the tour and moves on', async () => {
    const { world, capture, deps } = fixture();
    const first = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });
    const second = await seedTour(world, { createdAt: CREATED_LATER, scheduledAt: AT });
    const groupId = await openGroupFor(world, first, '+15550100095');
    const realGetById = world.conversationsRepo.getById;
    world.conversationsRepo.getById = async (conversationId) => {
      if (conversationId === groupId) throw new Error('dynamo unavailable');
      return realGetById(conversationId);
    };

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 2, due: 2, closed: 2, lost: 0, failed: 0 });
    expect(statusOf(world, first)).toBe('closed');
    expect(statusOf(world, second)).toBe('closed');
    // Spec 6.4: a failed step is logged with the tourId. The shared helper logs
    // only the conversationId; the job hands it a child logger carrying tourId.
    const armErrors = capture.atLevel(ERROR).filter((l) => l['msg'] === 'relay close-nag arm failed (best-effort)');
    expect(armErrors.map((l) => [l['tourId'], l['conversationId']])).toEqual([[first, groupId]]);
    // The steps after the arm still ran for the first tour.
    expect(world.emitted.filter((e) => e.event === 'tour.updated').map((e) => e.payload)).toEqual([
      { tourId: first, status: 'closed' },
      { tourId: second, status: 'closed' },
    ]);
  });

  it("deletes the old ladder's never-sent reminder rows (a skipped one included) and keeps a SENT row", async () => {
    const { world, deps } = fixture();
    const tourId = await seedTour(world, { createdAt: CREATED, scheduledAt: AT, currentLadderId: 'ladder-1' });
    const mk = (kind: ReminderKind) =>
      world.tourRemindersRepo.create({ tourId, kind, dueAt: '2026-08-31T15:00:00.000Z', ladderId: 'ladder-1' });
    await mk('day_before');
    const skipped = await mk('morning_of');
    const sent = await mk('confirmation');
    await world.tourRemindersRepo.claimSkip(skipped.reminderId, '2026-09-01T12:00:00.000Z', 'booked_too_late');
    await world.tourRemindersRepo.claimSend(sent.reminderId, '2026-08-25T00:05:00.000Z');

    expect((await runTourAutoClose(NOW, deps)).closed).toBe(1);
    expect((await world.tourRemindersRepo.listByTour(tourId)).map((r) => r.reminderId)).toEqual([sent.reminderId]);
  });

  it('a failing audit append (both rows) does not stop a second due tour from closing', async () => {
    const { world, capture, deps } = fixture();
    const first = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });
    const second = await seedTour(world, { createdAt: CREATED_LATER, scheduledAt: AT });
    world.failAuditAppendFor.add('tour_auto_closed');

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 2, due: 2, closed: 2, lost: 0, failed: 0 });
    expect(statusOf(world, first)).toBe('closed');
    expect(statusOf(world, second)).toBe('closed');
    // The surfaces that did not fail still landed for BOTH tours.
    expect(world.activityEvents.map((e) => e.refId)).toEqual([first, first, second, second]);
    expect(world.emitted.filter((e) => e.event === 'tour.updated')).toHaveLength(2);
    const errors = capture.atLevel(ERROR).map((l) => l['msg']);
    expect(errors.filter((m) => m === 'tour_auto_closed unit audit failed (best-effort)')).toHaveLength(2);
    expect(errors.filter((m) => m === 'tour_auto_closed tour audit failed (best-effort)')).toHaveLength(2);
  });

  it('a failing reminder sweep is logged and the rest of the side effects and the run carry on', async () => {
    const { world, capture, deps } = fixture();
    const first = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });
    const second = await seedTour(world, { createdAt: CREATED_LATER, scheduledAt: AT });
    world.tourRemindersRepo.deleteSupersededForTour = async () => {
      throw new Error('dynamo unavailable');
    };

    expect(await runTourAutoClose(NOW, deps)).toEqual({ scanned: 2, due: 2, closed: 2, lost: 0, failed: 0 });
    expect(world.activityEvents.map((e) => e.refId)).toEqual([first, first, second, second]);
    expect(world.auditEvents).toHaveLength(4);
    expect(world.emitted.map((e) => e.event)).toEqual([
      'tour.updated',
      'scheduled.updated',
      'tour.updated',
      'scheduled.updated',
    ]);
    const sweepErrors = capture
      .atLevel(ERROR)
      .filter((l) => typeof l['msg'] === 'string' && l['msg'].startsWith('tour auto-close: reminder sweep failed'));
    expect(sweepErrors.map((l) => l['tourId'])).toEqual([first, second]);
  });

  it('sends nothing: no SMS, no persisted message, no push - even with a relay group and a live rung on the tour', async () => {
    const { world, deps } = fixture();
    const tourId = await seedTour(world, { createdAt: CREATED, scheduledAt: AT, currentLadderId: 'ladder-1' });
    await openGroupFor(world, tourId, '+15550100093');
    await world.tourRemindersRepo.create({ tourId, kind: 'day_before', dueAt: '2026-08-31T15:00:00.000Z', ladderId: 'ladder-1' });

    expect((await runTourAutoClose(NOW, deps)).closed).toBe(1);
    expect(world.sent).toEqual([]);
    expect(world.sentDetails).toEqual([]);
    expect(world.messages).toEqual([]);
    expect(world.pushSends).toEqual([]);
    expect(world.pushBroadcasts).toEqual([]);
  });

  it('is silent by construction: its deps are exactly these eight fields - no adapter, send service or token bucket', () => {
    // Compile-time pin (spec 6.5): adding any field to TourAutoCloseDeps fails
    // `npm run typecheck` here.
    expectTypeOf<keyof TourAutoCloseDeps>().toEqualTypeOf<
      | 'toursRepo'
      | 'tourRemindersRepo'
      | 'conversationsRepo'
      | 'unitsRepo'
      | 'auditRepo'
      | 'activityEventsRepo'
      | 'events'
      | 'logger'
    >();
  });

  it('tourIds scopes the sweep to those tours, each read CONSISTENTLY; an unknown id is ignored', async () => {
    const { world, deps } = fixture();
    const a = await seedTour(world, { createdAt: CREATED, scheduledAt: AT });
    const b = await seedTour(world, { createdAt: CREATED_LATER, scheduledAt: AT });
    const reads: { tourId: string; opts: unknown }[] = [];
    const realGet = world.toursRepo.get;
    world.toursRepo.get = async (tourId, opts) => {
      reads.push({ tourId, opts });
      return realGet(tourId, opts);
    };
    const listed: string[] = [];
    const realListByStatus = world.toursRepo.listByStatus;
    world.toursRepo.listByStatus = async (status) => {
      listed.push(status);
      return realListByStatus(status);
    };

    expect(await runTourAutoClose(NOW, deps, { tourIds: [a, 'tour-missing'] })).toEqual({
      scanned: 1,
      due: 1,
      closed: 1,
      lost: 0,
      failed: 0,
    });
    expect(statusOf(world, a)).toBe('closed');
    expect(statusOf(world, b)).toBe('scheduled');
    expect(reads).toEqual([
      { tourId: a, opts: { consistentRead: true } },
      { tourId: 'tour-missing', opts: { consistentRead: true } },
    ]);
    expect(listed).toEqual([]);
  });

  it('refuses an unparseable now', async () => {
    const { deps } = fixture();
    await expect(runTourAutoClose('nope', deps)).rejects.toThrow('now must be an ISO 8601 instant');
  });
});
