// Tours repo integration tests against DynamoDB Local — TDD (Task 1).
//
// Covers: create→get round-trip; listByTenant; listByUnit; listByScheduledRange
// (in-window and boundary exclusion); patch (field updates + updatedAt bump).
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT (default
// http://localhost:8000) the suite is skipped so `npm test` stays green without
// Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createToursRepo, type CreateTourInput, type TourItem, type TourType } from '../src/repos/toursRepo.js';
import {
  isUnfilteredPhase,
  locateTourListCursor,
  planTourListPhases,
  tourListFingerprint,
  tourListKeyOf,
  type TourListFilters,
  type TourListPhase,
  type TourListRange,
} from '../src/lib/tourListQuery.js';
import { listTourPage, type TourListPageResult } from '../src/services/tourListPage.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[toursRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('toursRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const tours = createToursRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('tours', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('create generates a tourId, stamps timestamps, and get reads it back', async () => {
    const tour = await tours.create({
      tenantId: 'contact-tenant-1',
      unitId: 'unit-abc-1',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'self_guided',
      status: 'scheduled',
    });

    expect(tour.tourId).toMatch(/^tour-/);
    expect(tour._schedPartition).toBe('tours');
    expect(tour.createdAt).toBeDefined();
    expect(tour.updatedAt).toBeDefined();
    expect(tour.status).toBe('scheduled');

    const read = await tours.get(tour.tourId);
    expect(read).toMatchObject({
      tourId: tour.tourId,
      tenantId: 'contact-tenant-1',
      unitId: 'unit-abc-1',
      scheduledAt: '2026-07-15T10:00:00.000Z',
      tourType: 'self_guided',
      status: 'scheduled',
      _schedPartition: 'tours',
    });
  });

  it('get returns undefined for an unknown tourId', async () => {
    const result = await tours.get('tour-does-not-exist');
    expect(result).toBeUndefined();
  });

  it('create stores optional fields (groupThreadId, outcome, moveForward, convertible)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-tenant-optional',
      unitId: 'unit-optional-1',
      scheduledAt: '2026-07-16T14:00:00.000Z',
      tourType: 'landlord_led',
      status: 'closed',
      groupThreadId: 'conv-group-xyz',
      outcome: 'move_forward',
      moveForward: true,
      convertible: true,
    });

    const read = await tours.get(tour.tourId);
    expect(read).toMatchObject({
      groupThreadId: 'conv-group-xyz',
      outcome: 'move_forward',
      moveForward: true,
      convertible: true,
    });
  });

  it('create without scheduledAt omits the attribute entirely (sparse byScheduledAt GSI)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-timeless-1',
      unitId: 'unit-timeless-1',
      tourType: 'landlord_led',
      status: 'requested',
    });

    const read = await tours.get(tour.tourId);
    expect(read).toBeDefined();
    // The attribute must be truly ABSENT (not undefined/null) so the sparse
    // byScheduledAt GSI never indexes the item.
    expect(Object.keys(read!)).not.toContain('scheduledAt');

    // A range query spanning all time must not surface the timeless tour.
    const all = await tours.listByScheduledRange('0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.000Z');
    expect(all.map((t) => t.tourId)).not.toContain(tour.tourId);
  });

  it('listByTenant returns all tours for a tenant and none for others', async () => {
    const tenantId = `contact-tenant-gsi-${randomUUID().slice(0, 6)}`;
    const otherTenant = `contact-tenant-other-${randomUUID().slice(0, 6)}`;

    await tours.create({ tenantId, unitId: 'unit-t1', scheduledAt: '2026-07-20T09:00:00.000Z', tourType: 'self_guided', status: 'scheduled' });
    await tours.create({ tenantId, unitId: 'unit-t2', scheduledAt: '2026-07-21T09:00:00.000Z', tourType: 'landlord_led', status: 'scheduled' });
    await tours.create({ tenantId: otherTenant, unitId: 'unit-t3', scheduledAt: '2026-07-22T09:00:00.000Z', tourType: 'pm_team', status: 'scheduled' });

    const result = await tours.listByTenant(tenantId);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.tenantId === tenantId)).toBe(true);

    const other = await tours.listByTenant(otherTenant);
    expect(other).toHaveLength(1);
    expect(other[0]!.tenantId).toBe(otherTenant);
  });

  it('listByUnit returns all tours for a unit and none for others', async () => {
    const unitId = `unit-gsi-${randomUUID().slice(0, 6)}`;
    const otherUnit = `unit-other-${randomUUID().slice(0, 6)}`;

    await tours.create({ tenantId: 'contact-t-u1', unitId, scheduledAt: '2026-07-23T09:00:00.000Z', tourType: 'self_guided', status: 'scheduled' });
    await tours.create({ tenantId: 'contact-t-u2', unitId, scheduledAt: '2026-07-24T09:00:00.000Z', tourType: 'self_guided', status: 'scheduled' });
    await tours.create({ tenantId: 'contact-t-u3', unitId: otherUnit, scheduledAt: '2026-07-25T09:00:00.000Z', tourType: 'self_guided', status: 'scheduled' });

    const result = await tours.listByUnit(unitId);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.unitId === unitId)).toBe(true);
  });

  it('listByScheduledRange returns tours in window and excludes tours outside', async () => {
    // Create three tours: inside, before, and after the window
    const inside1 = await tours.create({
      tenantId: 'contact-range-1',
      unitId: 'unit-range-1',
      scheduledAt: '2026-08-05T09:00:00.000Z', // inside
      tourType: 'self_guided',
      status: 'scheduled',
    });
    const inside2 = await tours.create({
      tenantId: 'contact-range-2',
      unitId: 'unit-range-2',
      scheduledAt: '2026-08-07T17:00:00.000Z', // inside
      tourType: 'landlord_led',
      status: 'scheduled',
    });
    await tours.create({
      tenantId: 'contact-range-before',
      unitId: 'unit-range-before',
      scheduledAt: '2026-08-04T23:59:59.000Z', // before window
      tourType: 'pm_team',
      status: 'scheduled',
    });
    await tours.create({
      tenantId: 'contact-range-after',
      unitId: 'unit-range-after',
      scheduledAt: '2026-08-10T00:00:01.000Z', // after window
      tourType: 'self_guided',
      status: 'scheduled',
    });

    const from = '2026-08-05T00:00:00.000Z';
    const to   = '2026-08-09T23:59:59.000Z';
    const result = await tours.listByScheduledRange(from, to);

    const insideIds = result.map((t) => t.tourId);
    expect(insideIds).toContain(inside1.tourId);
    expect(insideIds).toContain(inside2.tourId);
    // The tours outside the window must not appear. (scheduledAt is optional
    // on TourItem since the timeless create, but every row in the sparse
    // byScheduledAt GSI carries one — assert it inline for the type.)
    expect(
      result.every((t) => t.scheduledAt !== undefined && t.scheduledAt >= from && t.scheduledAt <= to),
    ).toBe(true);
  });

  it('listByScheduledRange boundary: BETWEEN is inclusive on both ends', async () => {
    const exactFrom = '2026-09-01T00:00:00.000Z';
    const exactTo   = '2026-09-01T23:59:59.000Z';

    const atFrom = await tours.create({
      tenantId: 'contact-bound-from',
      unitId: 'unit-bound-from',
      scheduledAt: exactFrom,
      tourType: 'self_guided',
      status: 'scheduled',
    });
    const atTo = await tours.create({
      tenantId: 'contact-bound-to',
      unitId: 'unit-bound-to',
      scheduledAt: exactTo,
      tourType: 'self_guided',
      status: 'scheduled',
    });

    const result = await tours.listByScheduledRange(exactFrom, exactTo);
    const ids = result.map((t) => t.tourId);
    expect(ids).toContain(atFrom.tourId);
    expect(ids).toContain(atTo.tourId);
  });

  // -------------------------------------------------------------------------
  // listByScheduledRange walks EVERY page (tour list S1, spec section 7). It
  // used to send ONE Query and drop LastEvaluatedKey, so a window larger than
  // one 1 MB page silently lost its newest tours. `pageLimit: 1` forces one
  // row per page, which makes a single-page read visible as one Query call.
  //
  // The window is MARCH 2027 because this file's one table is shared by every
  // case: the others write 2026 dates (and one reads all of 2026), and eight
  // rows keep the walk far under queryAll's 100-page cap.
  // -------------------------------------------------------------------------

  describe('listByScheduledRange pages to completion (March 2027 window)', () => {
    const from = '2027-03-01T00:00:00.000Z';
    const to = '2027-03-10T23:59:59.999Z';
    const insideIds: string[] = [];

    beforeAll(async () => {
      // Seven inside the window, one a day (distinct instants - no ties), and
      // one outside it.
      for (let day = 2; day <= 8; day += 1) {
        const tour = await tours.create({
          tenantId: `contact-paged-${day}`,
          unitId: `unit-paged-${day}`,
          scheduledAt: `2027-03-0${day}T10:00:00.000Z`,
          tourType: 'self_guided',
          status: 'scheduled',
        });
        insideIds.push(tour.tourId);
      }
      await tours.create({
        tenantId: 'contact-paged-outside',
        unitId: 'unit-paged-outside',
        scheduledAt: '2027-03-20T10:00:00.000Z',
        tourType: 'self_guided',
        status: 'scheduled',
      });
    });

    it('pageLimit 1 still returns the whole window, one Query per page', async () => {
      // The file's spying-doc idiom: record, then forward to the shared doc.
      // queryAll sends every page through the repo's doc, so this sees them all.
      let rangeQueries = 0;
      const spyingDoc = {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand && command.input.IndexName === 'byScheduledAt') {
            rangeQueries += 1;
          }
          return (doc as DynamoDBDocumentClient).send(command as never);
        },
      } as unknown as DynamoDBDocumentClient;
      const spyingRepo = createToursRepo({ doc: spyingDoc, env: testEnv, logger });

      const result = await spyingRepo.listByScheduledRange(from, to, { pageLimit: 1 });

      expect(new Set(result.map((t) => t.tourId))).toEqual(new Set(insideIds));
      expect(result).toHaveLength(insideIds.length);
      // One row per page: seven rows take at least seven Queries. A read that
      // ignores the page limit (or stops after one page) sends exactly one.
      expect(rangeQueries).toBeGreaterThanOrEqual(7);
    });

    it('(PIN) without opts the same window comes back whole', async () => {
      const result = await tours.listByScheduledRange(from, to);

      expect(new Set(result.map((t) => t.tourId))).toEqual(new Set(insideIds));
      expect(result).toHaveLength(insideIds.length);
    });
  });

  it('patch updates fields and bumps updatedAt without touching other fields', async () => {
    const tour = await tours.create({
      tenantId: 'contact-patch-1',
      unitId: 'unit-patch-1',
      scheduledAt: '2026-07-30T11:00:00.000Z',
      tourType: 'self_guided',
      status: 'scheduled',
    });
    const before = tour.updatedAt;

    // Patch status and groupThreadId
    const patched = await tours.patch(tour.tourId, {
      status: 'toured',
      groupThreadId: 'conv-group-patched',
    });

    expect(patched.status).toBe('toured');
    expect(patched.groupThreadId).toBe('conv-group-patched');
    // Untouched fields survive the merge
    expect(patched.tourType).toBe('self_guided');
    expect(patched.tenantId).toBe('contact-patch-1');
    expect(patched.unitId).toBe('unit-patch-1');
    expect(patched.scheduledAt).toBe('2026-07-30T11:00:00.000Z');
    // updatedAt was bumped
    expect(patched.updatedAt).not.toBe(before);
  });

  it('patch exit gate: sets outcome, moveForward, convertible', async () => {
    const tour = await tours.create({
      tenantId: 'contact-exit-1',
      unitId: 'unit-exit-1',
      scheduledAt: '2026-07-31T13:00:00.000Z',
      tourType: 'landlord_led',
      status: 'scheduled',
    });

    const patched = await tours.patch(tour.tourId, {
      status: 'closed',
      outcome: 'move_forward',
      moveForward: true,
      convertible: false,
    });

    expect(patched.outcome).toBe('move_forward');
    expect(patched.moveForward).toBe(true);
    expect(patched.convertible).toBe(false);
  });

  it('patch throws ConditionalCheckFailedException for an unknown tourId', async () => {
    const { ConditionalCheckFailedException: Err } = await import('../src/repos/toursRepo.js');
    await expect(
      tours.patch('tour-ghost-does-not-exist', { status: 'cancelled' }),
    ).rejects.toBeInstanceOf(Err);
  });

  // -------------------------------------------------------------------------
  // Task 1 additions: requested (time-less) tours + byStatus GSI
  // -------------------------------------------------------------------------

  it('create WITHOUT scheduledAt stores status=requested and NO scheduledAt attribute', async () => {
    const tour = await tours.create({
      tenantId: 'contact-requested-1',
      unitId: 'unit-requested-1',
      tourType: 'self_guided',
      // scheduledAt deliberately absent
    });

    expect(tour.tourId).toMatch(/^tour-/);
    expect(tour.status).toBe('requested');
    expect(tour.scheduledAt).toBeUndefined();
    expect(tour._schedPartition).toBe('tours');
    expect(tour.createdAt).toBeDefined();
    expect(tour.updatedAt).toBeDefined();

    const read = await tours.get(tour.tourId);
    expect(read).toBeDefined();
    expect(read!.status).toBe('requested');
    expect(read!.scheduledAt).toBeUndefined();
    // scheduledAt must truly be absent in the stored item (not null/empty string)
    expect(Object.prototype.hasOwnProperty.call(read, 'scheduledAt')).toBe(false);
  });

  it('requested tour appears in listByStatus("requested")', async () => {
    const tour = await tours.create({
      tenantId: 'contact-bystatus-1',
      unitId: 'unit-bystatus-1',
      tourType: 'landlord_led',
    });

    expect(tour.status).toBe('requested');

    const listed = await tours.listByStatus('requested');
    const ids = listed.map((t) => t.tourId);
    expect(ids).toContain(tour.tourId);
  });

  it('requested tour is absent from byScheduledAt range query spanning today', async () => {
    const requestedTour = await tours.create({
      tenantId: 'contact-sparse-1',
      unitId: 'unit-sparse-1',
      tourType: 'pm_team',
    });
    expect(requestedTour.status).toBe('requested');
    expect(requestedTour.scheduledAt).toBeUndefined();

    // Query a range that would capture any tour with a date in 2026
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-12-31T23:59:59.000Z';
    const rangeResult = await tours.listByScheduledRange(from, to);

    const ids = rangeResult.map((t) => t.tourId);
    expect(ids).not.toContain(requestedTour.tourId);
  });

  it('create WITH scheduledAt still produces status=scheduled (regression)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-scheduled-regression',
      unitId: 'unit-scheduled-regression',
      scheduledAt: '2026-10-01T14:00:00.000Z',
      tourType: 'self_guided',
    });

    expect(tour.status).toBe('scheduled');
    expect(tour.scheduledAt).toBe('2026-10-01T14:00:00.000Z');

    const listed = await tours.listByStatus('scheduled');
    expect(listed.map((t) => t.tourId)).toContain(tour.tourId);
  });

  it('listByStatus returns empty array for a status with no matching tours', async () => {
    const result = await tours.listByStatus('no_show');
    // no_show tours may or may not exist from other tests, but this call
    // should not throw - it may return any non-error result
    expect(Array.isArray(result)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Atomic conversion claim (Post-Tour double-create race guard) — mirrors the
  // claimGroupThread/releaseGroupThreadClaim conditional-write idiom.
  // -------------------------------------------------------------------------

  it('claimConversion: first claim wins; a second concurrent claim throws ConditionalCheckFailedException', async () => {
    const { ConditionalCheckFailedException: Err } = await import('../src/repos/toursRepo.js');
    const tour = await tours.create({
      tenantId: 'contact-claim-1',
      unitId: 'unit-claim-1',
      tourType: 'landlord_led',
    });

    await tours.claimConversion(tour.tourId, 'pending:aaa');
    expect((await tours.get(tour.tourId))!.convertedPlacementId).toBe('pending:aaa');

    // The slot is taken — a second claimant (the race loser) is rejected.
    await expect(tours.claimConversion(tour.tourId, 'pending:bbb')).rejects.toBeInstanceOf(Err);
    // The FIRST claimant still holds the slot (never clobbered).
    expect((await tours.get(tour.tourId))!.convertedPlacementId).toBe('pending:aaa');
  });

  it('claimConversion throws ConditionalCheckFailedException for a missing tour (attribute_exists guard)', async () => {
    const { ConditionalCheckFailedException: Err } = await import('../src/repos/toursRepo.js');
    await expect(tours.claimConversion('tour-ghost-claim', 'pending:x')).rejects.toBeInstanceOf(Err);
  });

  it('releaseConversionClaim removes ONLY while the value matches (lost condition = no-op)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-rel-1',
      unitId: 'unit-rel-1',
      tourType: 'landlord_led',
    });
    await tours.claimConversion(tour.tourId, 'pending:mine');

    // A mismatched value is a NO-OP (never clobbers a newer claim / finalized id).
    await tours.releaseConversionClaim(tour.tourId, 'pending:other');
    expect((await tours.get(tour.tourId))!.convertedPlacementId).toBe('pending:mine');

    // The matching value releases the slot.
    await tours.releaseConversionClaim(tour.tourId, 'pending:mine');
    expect((await tours.get(tour.tourId))!.convertedPlacementId).toBeUndefined();

    // Slot is free again — a fresh claim succeeds (attribute_not_exists true again).
    await tours.claimConversion(tour.tourId, 'pending:again');
    expect((await tours.get(tour.tourId))!.convertedPlacementId).toBe('pending:again');
  });

  // -------------------------------------------------------------------------
  // setRoster MATERIALIZE is guarded by the thread pointer too (contact-rosters
  // D1): once a thread exists the roster is a FACT, so a plan must never be
  // (re-)materialized onto that owner - it would be an INERT plan the resolver
  // ignores, written by a request that answered "saved".
  // -------------------------------------------------------------------------

  it('setRoster MATERIALIZE refuses once the tour carries a group-thread pointer', async () => {
    const { RosterPlanConflictError } = await import('../src/lib/rosterResolution.js');
    const tour = await tours.create({
      tenantId: 'contact-mat-1',
      unitId: 'unit-mat-1',
      tourType: 'landlord_led',
    });

    // No pointer yet: the materialize lands.
    const materialized = await tours.setRoster(tour.tourId, [{ contactId: 'c-a' }], undefined);
    expect(materialized.rosterVersion).toBe(1);

    // The group opens (pointer stamped) and CONSUMES the plan.
    await tours.claimGroupThread(tour.tourId, 'conv-mat-1');
    await tours.clearRoster(tour.tourId);

    // attribute_not_exists(roster) is TRUE again - only the pointer guard stops
    // a plan being written onto a thread-bearing tour.
    await expect(
      tours.setRoster(tour.tourId, [{ contactId: 'c-b' }], undefined),
    ).rejects.toBeInstanceOf(RosterPlanConflictError);
    expect((await tours.get(tour.tourId))!.roster).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // currentLadderId - the generation pointer (supersession S1, T1.2/T1.3).
  //
  // TourItem carries `[key: string]: unknown`, so PatchTourInput collapses to an
  // index-signature type: patch({ currentLadderId }) compiles today and so does
  // a MISSPELLED key. Nothing in the typechecker guards this field, which is why
  // every assertion below reads the STORED row through a raw GetCommand rather
  // than trusting the return value's shape.
  // -------------------------------------------------------------------------

  const rawTour = async (tourId: string) => {
    const { Item } = await doc.send(
      new GetCommand({ TableName: tableName('tours', testEnv), Key: { tourId } }),
    );
    return Item;
  };

  it('currentLadderId round-trips through create and patch onto the stored row', async () => {
    const tour = await tours.create({
      tenantId: 'contact-ladder-1',
      unitId: 'unit-ladder-1',
      scheduledAt: '2026-11-01T15:00:00.000Z',
      tourType: 'self_guided',
      currentLadderId: 'ladder-born',
    });
    expect(await rawTour(tour.tourId)).toMatchObject({ currentLadderId: 'ladder-born' });

    await tours.patch(tour.tourId, { currentLadderId: 'ladder-rotated' });
    expect(await rawTour(tour.tourId)).toMatchObject({ currentLadderId: 'ladder-rotated' });
  });

  it('setLadderIdIf writes the next pointer when the stored value matches', async () => {
    const tour = await tours.create({
      tenantId: 'contact-cas-win',
      unitId: 'unit-cas-win',
      scheduledAt: '2026-11-02T15:00:00.000Z',
      tourType: 'self_guided',
      currentLadderId: 'ladder-rotation',
    });
    const before = (await rawTour(tour.tourId))!['updatedAt'];

    const won = await tours.setLadderIdIf(tour.tourId, 'ladder-rotation', 'ladder-armed');

    expect(won).toBe(true);
    const stored = await rawTour(tour.tourId);
    expect(stored).toMatchObject({ currentLadderId: 'ladder-armed' });
    // The write bumps updatedAt like every other conditional write on this repo.
    expect(stored!['updatedAt']).not.toBe(before);
  });

  it('setLadderIdIf returns false and leaves the row UNCHANGED when the stored value differs', async () => {
    const tour = await tours.create({
      tenantId: 'contact-cas-lose',
      unitId: 'unit-cas-lose',
      scheduledAt: '2026-11-03T15:00:00.000Z',
      tourType: 'self_guided',
      currentLadderId: 'ladder-somebody-elses-rotation',
    });
    const before = await rawTour(tour.tourId);

    // A lost compare is NOT an error - the concurrent reschedule that rotated
    // the pointer is the winner and its rotation must survive intact.
    const won = await tours.setLadderIdIf(tour.tourId, 'ladder-my-rotation', 'ladder-armed');

    expect(won).toBe(false);
    expect(await rawTour(tour.tourId)).toEqual(before);
  });

  it('setLadderIdIf returns false when the tour has NO pointer at all (pre-migration)', async () => {
    const tour = await tours.create({
      tenantId: 'contact-cas-absent',
      unitId: 'unit-cas-absent',
      scheduledAt: '2026-11-04T15:00:00.000Z',
      tourType: 'self_guided',
    });

    expect(await tours.setLadderIdIf(tour.tourId, 'ladder-rotation', 'ladder-armed')).toBe(false);
    expect(await rawTour(tour.tourId)).not.toHaveProperty('currentLadderId');
  });

  it('setLadderIdIf returns false for a missing tour and creates NOTHING', async () => {
    expect(
      await tours.setLadderIdIf('tour-ghost-ladder', 'ladder-rotation', 'ladder-armed'),
    ).toBe(false);
    // attribute_exists(tourId) is the guard that stops UpdateItem conjuring an
    // attribute-only stub for a tour that does not exist.
    expect(await rawTour('tour-ghost-ladder')).toBeUndefined();
  });

  // The OPT-IN consistent read (review round NEW-5). DynamoDB's default GetItem
  // is eventually consistent, which is exactly what broke fix-wave 1's
  // ownership guard: a read issued one line after the write that it checks is
  // NOT guaranteed to see it. The flag is opt-in (the contactsRepo idiom) so
  // only the caller that must not be stale pays for it, and it is asserted on
  // the COMMAND INPUT: a strongly consistent store cannot tell the two apart,
  // so the only observable fact here is the request we send.
  it('get carries ConsistentRead ONLY when the caller opts in', async () => {
    const tour = await tours.create({
      tenantId: 'contact-consistent',
      unitId: 'unit-consistent',
      scheduledAt: '2026-11-05T15:00:00.000Z',
      tourType: 'self_guided',
    });

    const seen: (boolean | undefined)[] = [];
    const spyingDoc = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) {
          seen.push((command.input as { ConsistentRead?: boolean }).ConsistentRead);
        }
        return (doc as DynamoDBDocumentClient).send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;
    const spyingRepo = createToursRepo({ doc: spyingDoc, env: testEnv, logger });

    expect((await spyingRepo.get(tour.tourId))?.tourId).toBe(tour.tourId);
    expect((await spyingRepo.get(tour.tourId, { consistentRead: true }))?.tourId).toBe(tour.tourId);
    expect((await spyingRepo.get(tour.tourId, {}))?.tourId).toBe(tour.tourId);

    // Absent by default (never `false` - the key is omitted entirely), present
    // and true on the opt-in, absent again for an options object that does not
    // ask for it.
    expect(seen).toEqual([undefined, true, undefined]);
  });

  // -------------------------------------------------------------------------
  // Tour auto-close and reopen (Sam #18, 2026-10-01): the conditional writes.
  //
  // Every case below also runs against the harness fake in
  // toursRepoFakeConditions.test.ts - a fake looser than the store would make
  // every route test built on it lie. Stored rows are read through rawTour.
  // -------------------------------------------------------------------------

  it('patch with expectedStatus writes while the stored status matches, and refuses once it does not', async () => {
    const { ConditionalCheckFailedException: Err } = await import('../src/repos/toursRepo.js');
    const tour = await tours.create({
      tenantId: 'contact-expect-1',
      unitId: 'unit-expect-1',
      scheduledAt: '2026-09-10T15:00:00.000Z',
      tourType: 'self_guided',
    });

    // `status` is both SET and conditioned on here (two placeholders, one
    // attribute) - the PATCH route's own shape.
    const patched = await tours.patch(tour.tourId, { status: 'toured' }, { expectedStatus: 'scheduled' });
    expect(patched.status).toBe('toured');
    const before = await rawTour(tour.tourId);
    expect(before).toMatchObject({ status: 'toured' });

    // A caller still holding the 'scheduled' read loses - and writes nothing.
    await expect(
      tours.patch(tour.tourId, { status: 'no_show' }, { expectedStatus: 'scheduled' }),
    ).rejects.toBeInstanceOf(Err);
    // The precondition holds even when the patch does not touch status.
    await expect(
      tours.patch(tour.tourId, { scheduledAt: '2026-09-11T15:00:00.000Z' }, { expectedStatus: 'scheduled' }),
    ).rejects.toBeInstanceOf(Err);
    expect(await rawTour(tour.tourId)).toEqual(before);
  });

  it('(PIN) patch without opts keeps the unconditional contract', async () => {
    const tour = await tours.create({
      tenantId: 'contact-expect-2',
      unitId: 'unit-expect-2',
      scheduledAt: '2026-09-10T15:00:00.000Z',
      tourType: 'self_guided',
    });
    await tours.patch(tour.tourId, { status: 'toured' }, { expectedStatus: 'scheduled' });

    const patched = await tours.patch(tour.tourId, { status: 'no_show' });

    expect(patched.status).toBe('no_show');
    expect(await rawTour(tour.tourId)).toMatchObject({ status: 'no_show' });
  });

  it('(PIN) patch with expectedStatus on a missing tour throws ConditionalCheckFailedException and creates nothing', async () => {
    const { ConditionalCheckFailedException: Err } = await import('../src/repos/toursRepo.js');
    await expect(
      tours.patch('tour-ghost-expected', { status: 'toured' }, { expectedStatus: 'scheduled' }),
    ).rejects.toBeInstanceOf(Err);
    expect(await rawTour('tour-ghost-expected')).toBeUndefined();
  });

  // autoCloseIf - the sweep's ONE write (spec 6.3): equality on every input of
  // the due decision - updatedAt only for a never-marked tour, whose clock it
  // is (ruling A-1).

  it('autoCloseIf closes a scheduled tour as no_outcome, rotates the pointer and stamps the wall clock', async () => {
    const tour = await tours.create({
      tenantId: 'contact-close-1',
      unitId: 'unit-close-1',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
      currentLadderId: 'ladder-live',
    });
    const read = (await tours.get(tour.tourId))!;
    const before = Date.now();

    const closed = await tours.autoCloseIf(read, 'rot-1');

    expect(closed).toMatchObject({
      tourId: tour.tourId,
      tenantId: 'contact-close-1',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      createdAt: read.createdAt,
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
      currentLadderId: 'rot-1',
    });
    // Both stamps are the wall clock of the write itself.
    expect(closed!.autoClosedAt).toBe(closed!.updatedAt);
    expect(Date.parse(closed!.autoClosedAt as string)).toBeGreaterThanOrEqual(before);
    expect(closed).not.toHaveProperty('moveForward');
    expect(closed).not.toHaveProperty('convertible');
    expect(closed).not.toHaveProperty('lastMarkedAt');
    expect(await rawTour(tour.tourId)).toEqual(closed);
  });

  it('autoCloseIf closes a candidate carrying convertible: false and leaves moveForward / convertible as they are', async () => {
    const tour = await tours.create({
      tenantId: 'contact-close-cv',
      unitId: 'unit-close-cv',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
      status: 'toured',
      moveForward: false,
      convertible: false,
      lastMarkedAt: '2026-09-02T09:00:00.000Z',
    });
    const read = (await tours.get(tour.tourId))!;

    const closed = await tours.autoCloseIf(read, 'rot-cv');

    expect(closed).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'toured',
      moveForward: false,
      convertible: false,
      lastMarkedAt: '2026-09-02T09:00:00.000Z',
    });
    expect(await rawTour(tour.tourId)).toEqual(closed);
  });

  it('autoCloseIf closes an undated toured tour and adds no scheduledAt', async () => {
    const tour = await tours.create({
      tenantId: 'contact-close-2',
      unitId: 'unit-close-2',
      tourType: 'landlord_led',
    });
    await tours.patch(tour.tourId, { status: 'toured' });
    const read = (await tours.get(tour.tourId))!;

    const closed = await tours.autoCloseIf(read, 'rot-2');

    expect(closed).toMatchObject({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'toured' });
    const stored = await rawTour(tour.tourId);
    expect(stored).toEqual(closed);
    expect(stored).not.toHaveProperty('scheduledAt');
  });

  /** Set a first mark the way no repo method can: updatedAt untouched. */
  const rawFirstMark = async (tourId: string): Promise<void> => {
    const before = await rawTour(tourId);
    await doc.send(
      new UpdateCommand({
        TableName: tableName('tours', testEnv),
        Key: { tourId },
        UpdateExpression: 'SET #lm = :lm',
        ConditionExpression: 'attribute_exists(tourId)',
        ExpressionAttributeNames: { '#lm': 'lastMarkedAt' },
        ExpressionAttributeValues: { ':lm': '2026-09-20T00:00:00.000Z' },
      }),
    );
    // The mark is the ONLY difference from the read, so attribute_not_exists
    // on it is the only term that can fail.
    expect(await rawTour(tourId)).toEqual({ ...before, lastMarkedAt: '2026-09-20T00:00:00.000Z' });
  };

  // Each change lands BETWEEN the sweep's read and its write; the change wins.
  // One row per condition term (and per branch of the two optional fields);
  // `term` is the one its change breaks, and a row proves it only where no
  // other term can fail. Every repo write also moves updatedAt, which a
  // never-marked read conditions on too (ruling A-1) - and on DynamoDB Local
  // the change lands, in practice always, in a later millisecond than the
  // create - so on a NEVER-MARKED read a repo-write row also loses on
  // `#ua = :ua` (review r2, R2-1). A MARKED read has no updatedAt term: there
  // the row's own term is the only one that can fail, so that read proves
  // every term but the first mark's. `attribute_not_exists(#lm)` exists on a
  // never-marked read alone; its proving row writes the mark raw and leaves
  // updatedAt as it was. Each term stripped in turn, and the rows it turns
  // red: code-review/fix-wave-2-report.md.
  const BOTH_READS = ['never marked', 'marked'] as const;
  const autoCloseRaces: {
    name: string;
    term: string;
    reads: readonly (typeof BOTH_READS)[number][];
    undated?: boolean;
    change: (repo: typeof tours, tourId: string) => Promise<unknown>;
  }[] = [
    {
      name: 'the status changed',
      term: '#st = :from',
      reads: BOTH_READS,
      change: (r, id) => r.patch(id, { status: 'toured' }),
    },
    {
      name: 'an outcome was recorded',
      term: 'attribute_not_exists(#oc)',
      reads: BOTH_READS,
      change: (r, id) => r.patch(id, { outcome: 'not_a_fit' }),
    },
    {
      name: 'a conversion was claimed',
      term: 'attribute_not_exists(#cp)',
      reads: BOTH_READS,
      change: (r, id) => r.claimConversion(id, 'pending:x'),
    },
    {
      name: 'it became convertible',
      term: '#cv <> :true',
      reads: BOTH_READS,
      change: (r, id) => r.patch(id, { convertible: true }),
    },
    {
      name: 'it was rescheduled',
      term: '#sa = :sa',
      reads: BOTH_READS,
      change: (r, id) => r.patch(id, { scheduledAt: '2026-09-05T15:00:00.000Z' }),
    },
    {
      name: 'an undated tour got a date',
      term: 'attribute_not_exists(#sa)',
      reads: BOTH_READS,
      undated: true,
      change: (r, id) => r.patch(id, { scheduledAt: '2026-09-05T15:00:00.000Z' }),
    },
    // Never marked by construction, and the patch moves updatedAt as well, so
    // this row cannot prove its term on the store - the raw row below does.
    {
      name: 'a person marked it for the first time',
      term: 'attribute_not_exists(#lm)',
      reads: ['never marked'],
      change: (r, id) => r.patch(id, { lastMarkedAt: '2026-09-20T00:00:00.000Z' }),
    },
    {
      name: 'a raw write marked it, updatedAt kept',
      term: 'attribute_not_exists(#lm)',
      reads: ['never marked'],
      change: (_r, id) => rawFirstMark(id),
    },
    // Marked by construction.
    {
      name: 'a person marked it again',
      term: '#lm = :lm',
      reads: ['marked'],
      change: (r, id) => r.patch(id, { lastMarkedAt: '2026-09-20T00:00:00.000Z' }),
    },
  ];
  const autoCloseRaceCases = autoCloseRaces.flatMap(({ reads, ...row }) => reads.map((read) => ({ ...row, read })));

  it.each(autoCloseRaceCases)(
    'autoCloseIf loses - undefined, nothing written - when $name between its read and its write ($read read, breaks $term)',
    async ({ undated, read: readKind, change }) => {
      const tour = await tours.create({
        tenantId: 'contact-close-race',
        unitId: 'unit-close-race',
        tourType: 'self_guided',
        status: undated === true ? 'toured' : 'scheduled',
        ...(undated !== true && { scheduledAt: '2026-09-01T15:00:00.000Z' }),
        ...(readKind === 'marked' && { lastMarkedAt: '2026-09-10T00:00:00.000Z' }),
      });
      const read = (await tours.get(tour.tourId))!;
      await change(tours, tour.tourId);
      const changed = await rawTour(tour.tourId);

      // A lost condition is an answer, never a throw.
      await expect(tours.autoCloseIf(read, 'rot-race')).resolves.toBeUndefined();
      expect(await rawTour(tour.tourId)).toEqual(changed);
    },
  );

  /** Resolve once the wall clock has passed `iso`. The repo stamps updatedAt
   *  in whole milliseconds, so a write in the SAME millisecond as the read's
   *  stamp would leave updatedAt unchanged and prove nothing. */
  const afterMillisecond = async (iso: string): Promise<void> => {
    const ms = Date.parse(iso);
    while (Date.now() <= ms) await new Promise((resolve) => setTimeout(resolve, 1));
  };

  // A never-marked tour's clock counts from its updatedAt (spec 5.3), so the
  // close also conditions on it (ruling A-1, code-review/adjudications-r1.md);
  // once a mark exists the clock ignores updatedAt and so does the close.
  it("autoCloseIf loses - undefined, nothing written - when an unrelated write moved a never-marked tour's updatedAt", async () => {
    const tour = await tours.create({
      tenantId: 'contact-close-ua',
      unitId: 'unit-close-ua',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
    });
    const read = (await tours.get(tour.tourId))!;
    expect(read).not.toHaveProperty('lastMarkedAt');
    await afterMillisecond(read.updatedAt);
    // A roster reset: no status, outcome, date or mark changes - only updatedAt.
    await tours.clearRoster(tour.tourId);
    const changed = await rawTour(tour.tourId);
    expect(changed!['updatedAt']).not.toBe(read.updatedAt);

    await expect(tours.autoCloseIf(read, 'rot-ua')).resolves.toBeUndefined();
    expect(await rawTour(tour.tourId)).toEqual(changed);
  });

  it('(PIN) autoCloseIf still closes a MARKED tour after the same unrelated write - the clock ignores updatedAt once a mark exists', async () => {
    const tour = await tours.create({
      tenantId: 'contact-close-ua-marked',
      unitId: 'unit-close-ua-marked',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
      lastMarkedAt: '2026-09-02T09:00:00.000Z',
    });
    const read = (await tours.get(tour.tourId))!;
    await afterMillisecond(read.updatedAt);
    await tours.clearRoster(tour.tourId);
    expect((await rawTour(tour.tourId))!['updatedAt']).not.toBe(read.updatedAt);

    const closed = await tours.autoCloseIf(read, 'rot-ua-marked');

    expect(closed).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
      lastMarkedAt: '2026-09-02T09:00:00.000Z',
    });
    expect(await rawTour(tour.tourId)).toEqual(closed);
  });

  it('autoCloseIf returns undefined for a missing tour and creates NOTHING', async () => {
    const tour = await tours.create({
      tenantId: 'contact-close-ghost',
      unitId: 'unit-close-ghost',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      tourType: 'self_guided',
    });
    const read = (await tours.get(tour.tourId))!;

    await expect(tours.autoCloseIf({ ...read, tourId: 'tour-ghost-close' }, 'rot-ghost')).resolves.toBeUndefined();
    expect(await rawTour('tour-ghost-close')).toBeUndefined();
  });

  it.each(['canceled', 'requested', 'closed'])(
    'autoCloseIf refuses a %s tour up front and writes nothing (the store alone would let it through)',
    async (status) => {
      const tour = await tours.create({
        tenantId: 'contact-close-refuse',
        unitId: 'unit-close-refuse',
        tourType: 'self_guided',
        status,
        ...(status !== 'requested' && { scheduledAt: '2026-09-01T15:00:00.000Z' }),
      });
      const read = (await tours.get(tour.tourId))!;
      const before = await rawTour(tour.tourId);

      await expect(tours.autoCloseIf(read, 'rot-refuse')).resolves.toBeUndefined();
      expect(await rawTour(tour.tourId)).toEqual(before);
    },
  );

  // reopenIf - POST /api/tours/:id/reopen's write (spec 7.3).

  /** A closed tour of each shape reopen meets, AS THE CALLER READ IT. `auto`
   *  is the item autoCloseIf RETURNED (the post-close row - the pre-close read
   *  carries no outcome / autoClosedFrom, and reopenIf rightly refuses it). */
  const seedClosed = async (repo: typeof tours, kind: 'auto' | 'person' | 'bare') => {
    if (kind === 'auto') {
      const tour = await repo.create({
        tenantId: 'contact-reopen-auto',
        unitId: 'unit-reopen',
        scheduledAt: '2026-09-01T15:00:00.000Z',
        tourType: 'self_guided',
        moveForward: false,
        convertible: false,
        currentLadderId: 'ladder-live',
      });
      return (await repo.autoCloseIf((await repo.get(tour.tourId))!, 'rot-reopen'))!;
    }
    if (kind === 'person') {
      const tour = await repo.create({
        tenantId: 'contact-reopen-person',
        unitId: 'unit-reopen',
        scheduledAt: '2026-09-01T15:00:00.000Z',
        tourType: 'self_guided',
        status: 'toured',
      });
      await repo.patch(tour.tourId, { outcome: 'not_a_fit', moveForward: false, convertible: false, status: 'closed' });
      return (await repo.get(tour.tourId))!;
    }
    // API-only shape: closed with an autoClosedFrom and no outcome.
    const tour = await repo.create({
      tenantId: 'contact-reopen-bare',
      unitId: 'unit-reopen',
      tourType: 'self_guided',
      status: 'closed',
      autoClosedFrom: 'toured',
    });
    return (await repo.get(tour.tourId))!;
  };

  it('reopenIf returns an auto-closed tour to its status, stamps lastMarkedAt and removes the close and the decision', async () => {
    const closed = await seedClosed(tours, 'auto');
    expect(closed).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
      moveForward: false,
      convertible: false,
    });
    const before = Date.now();

    const reopened = await tours.reopenIf(closed, 'scheduled', '2026-10-20T12:00:00.000Z');

    expect(reopened).toMatchObject({
      tourId: closed.tourId,
      status: 'scheduled',
      lastMarkedAt: '2026-10-20T12:00:00.000Z',
      scheduledAt: '2026-09-01T15:00:00.000Z',
      // Left as is: it names no live rows, and nothing is armed.
      currentLadderId: 'rot-reopen',
    });
    for (const gone of ['outcome', 'moveForward', 'convertible', 'autoClosedAt', 'autoClosedFrom']) {
      expect(reopened).not.toHaveProperty(gone);
    }
    // updatedAt is the wall clock of the write, never the caller's mark.
    expect(reopened!.updatedAt).not.toBe('2026-10-20T12:00:00.000Z');
    expect(Date.parse(reopened!.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(await rawTour(closed.tourId)).toEqual(reopened);
  });

  it('reopenIf returns a person-decided tour to toured and removes outcome / moveForward / convertible', async () => {
    const closed = await seedClosed(tours, 'person');

    const reopened = await tours.reopenIf(closed, 'toured', '2026-10-20T12:00:00.000Z');

    expect(reopened).toMatchObject({ status: 'toured', lastMarkedAt: '2026-10-20T12:00:00.000Z' });
    for (const gone of ['outcome', 'moveForward', 'convertible', 'autoClosedAt', 'autoClosedFrom']) {
      expect(reopened).not.toHaveProperty(gone);
    }
    expect(await rawTour(closed.tourId)).toEqual(reopened);
  });

  // Each change lands AFTER the caller's read; the change wins. One row per
  // condition term (and per branch of the two read-dependent ones).
  const reopenRaces: {
    name: string;
    seed: 'auto' | 'person' | 'bare';
    change: (repo: typeof tours, tourId: string) => Promise<unknown>;
  }[] = [
    {
      name: 'a first reopen already ran',
      seed: 'auto',
      change: async (r, id) => r.reopenIf((await r.get(id))!, 'scheduled', '2026-10-21T12:00:00.000Z'),
    },
    { name: 'it left closed (outcome kept)', seed: 'auto', change: (r, id) => r.patch(id, { status: 'toured' }) },
    { name: 'a conversion was claimed', seed: 'person', change: (r, id) => r.claimConversion(id, 'pending:x') },
    { name: 'the outcome changed', seed: 'person', change: (r, id) => r.patch(id, { outcome: 'move_forward' }) },
    { name: 'an outcome appeared', seed: 'bare', change: (r, id) => r.patch(id, { outcome: 'not_a_fit' }) },
    { name: 'autoClosedFrom changed', seed: 'auto', change: (r, id) => r.patch(id, { autoClosedFrom: 'toured' }) },
    { name: 'autoClosedFrom appeared', seed: 'person', change: (r, id) => r.patch(id, { autoClosedFrom: 'no_show' }) },
  ];

  it.each(reopenRaces)(
    'reopenIf loses - undefined, nothing written - when $name after its read',
    async ({ seed, change }) => {
      const read = await seedClosed(tours, seed);
      await change(tours, read.tourId);
      const changed = await rawTour(read.tourId);

      // A lost condition is an answer, never a throw.
      await expect(tours.reopenIf(read, 'toured', '2026-10-20T12:00:00.000Z')).resolves.toBeUndefined();
      expect(await rawTour(read.tourId)).toEqual(changed);
    },
  );

  it('reopenIf returns undefined for a missing tour and creates NOTHING', async () => {
    const read = await seedClosed(tours, 'person');

    await expect(
      tours.reopenIf({ ...read, tourId: 'tour-ghost-reopen' }, 'toured', '2026-10-20T12:00:00.000Z'),
    ).resolves.toBeUndefined();
    expect(await rawTour('tour-ghost-reopen')).toBeUndefined();
  });
});

// queryListPhase - ONE Query of one All-tab phase (Tours page All tab, spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md 5.3-5.4). Its OWN
// table: a when=any-shaped read sees every tour in a table, and the describe
// above writes many. No two fixture rows share a range-key value (scheduledAt
// on byScheduledAt, createdAt on byStatus) - DynamoDB orders ties opaquely.
// Every instant is a full toISOString() value: the repo stores scheduledAt
// raw, and a short form would sort differently from the canonical bounds.
describe.skipIf(!reachable)('toursRepo.queryListPhase against DynamoDB Local (own prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const tours = createToursRepo({ doc, env: testEnv, logger });

  const at = (day: number): string => `2028-01-0${day}T10:00:00.000Z`;
  function tour(tourId: string, status: string, tourType: TourType, createdAt: string, scheduledAt?: string) {
    const input: CreateTourInput = {
      tourId,
      tenantId: `contact-${tourId}`,
      unitId: `unit-${tourId}`,
      tourType,
      status,
      createdAt,
      ...(scheduledAt !== undefined && { scheduledAt }),
    };
    return input;
  }
  // Six dated rows (ascending scheduledAt), two requests, one undated toured.
  const FIXTURE: CreateTourInput[] = [
    tour('tour-ql-d1', 'scheduled', 'self_guided', '2027-12-01T09:00:00.000Z', at(1)),
    tour('tour-ql-d2', 'toured', 'landlord_led', '2027-12-02T09:00:00.000Z', at(2)),
    tour('tour-ql-d3', 'no_show', 'pm_team', '2027-12-03T09:00:00.000Z', at(3)),
    tour('tour-ql-d4', 'canceled', 'self_guided', '2027-12-04T09:00:00.000Z', at(4)),
    tour('tour-ql-d5', 'closed', 'landlord_led', '2027-12-05T09:00:00.000Z', at(5)),
    tour('tour-ql-d6', 'scheduled', 'self_guided', '2027-12-06T09:00:00.000Z', at(6)),
    tour('tour-ql-r1', 'requested', 'pm_team', '2027-12-07T09:00:00.000Z'),
    tour('tour-ql-r2', 'requested', 'self_guided', '2027-12-08T09:00:00.000Z'),
    tour('tour-ql-u3', 'toured', 'landlord_led', '2027-12-09T09:00:00.000Z'),
  ];
  const DATED = ['tour-ql-d1', 'tour-ql-d2', 'tour-ql-d3', 'tour-ql-d4', 'tour-ql-d5', 'tour-ql-d6'];
  const ALL: TourListPhase = { kind: 'd', range: { op: 'all' } };
  const REQUESTED: TourListPhase = { kind: 'u', index: 0, status: 'requested', notExists: false };
  const UNDATED_TOURED: TourListPhase = { kind: 'u', index: 1, status: 'toured', notExists: true };

  const seededRows = new Map<string, TourItem>();
  function seeded(tourId: string): TourItem {
    const item = seededRows.get(tourId);
    if (item === undefined) throw new Error(`no seeded row ${tourId}`);
    return item;
  }
  const ids = (items: TourItem[]): string[] => items.map((t) => t.tourId);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
    for (const input of FIXTURE) {
      const item = await tours.create(input);
      seededRows.set(item.tourId, item);
    }
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('tours', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('1: D over the whole partition - the dated rows, whole, in scheduledAt order both ways; no key', async () => {
    const up = await tours.queryListPhase(ALL, { limit: 100, forward: true });
    expect(up.items).toEqual(DATED.map(seeded));
    expect(up.scannedCount).toBe(6);
    expect(up.lastEvaluatedKey).toBeUndefined();

    const down = await tours.queryListPhase(ALL, { limit: 100, forward: false });
    expect(ids(down.items)).toEqual([...DATED].reverse());
    expect(down.scannedCount).toBe(6);
    expect(down.lastEvaluatedKey).toBeUndefined();
  });

  it('2: each range op selects its key range', async () => {
    const cases: Array<[string, TourListRange, string[]]> = [
      ['gte', { op: 'gte', value: at(4) }, ['tour-ql-d4', 'tour-ql-d5', 'tour-ql-d6']],
      ['lt', { op: 'lt', value: at(4) }, ['tour-ql-d1', 'tour-ql-d2', 'tour-ql-d3']],
      ['lte', { op: 'lte', value: at(4) }, ['tour-ql-d1', 'tour-ql-d2', 'tour-ql-d3', 'tour-ql-d4']],
      ['between', { op: 'between', from: at(2), to: at(4) }, ['tour-ql-d2', 'tour-ql-d3', 'tour-ql-d4']],
    ];
    for (const [label, range, expected] of cases) {
      const page = await tours.queryListPhase({ kind: 'd', range }, { limit: 100, forward: true });
      expect(ids(page.items), label).toEqual(expected);
      expect(page.scannedCount, label).toBe(expected.length);
      expect(page.lastEvaluatedKey, label).toBeUndefined();
    }
    const pastDown = await tours.queryListPhase(
      { kind: 'd', range: { op: 'lt', value: at(4) } },
      { limit: 100, forward: false },
    );
    expect(ids(pastDown.items)).toEqual(['tour-ql-d3', 'tour-ql-d2', 'tour-ql-d1']);
    expect(pastDown.scannedCount).toBe(3);
  });

  it('3: a status filter and a type filter narrow the rows, and combine, while every row in range is evaluated', async () => {
    const cases: Array<[string, TourListPhase, string[], number]> = [
      [
        'status',
        { kind: 'd', range: { op: 'all' }, statusFilter: ['no_show', 'canceled'] },
        ['tour-ql-d3', 'tour-ql-d4'],
        6,
      ],
      ['type', { kind: 'd', range: { op: 'all' }, type: 'self_guided' }, ['tour-ql-d1', 'tour-ql-d4', 'tour-ql-d6'], 6],
      [
        'status + type',
        { kind: 'd', range: { op: 'all' }, statusFilter: ['no_show', 'canceled'], type: 'self_guided' },
        ['tour-ql-d4'],
        6,
      ],
      [
        'range + status + type',
        { kind: 'd', range: { op: 'gte', value: at(4) }, statusFilter: ['scheduled'], type: 'self_guided' },
        ['tour-ql-d6'],
        3,
      ],
    ];
    for (const [label, phase, expected, scanned] of cases) {
      const page = await tours.queryListPhase(phase, { limit: 100, forward: true });
      expect(ids(page.items), label).toEqual(expected);
      expect(page.scannedCount, label).toBe(scanned);
      expect(page.lastEvaluatedKey, label).toBeUndefined();
    }
  });

  it('4: U reads one status partition by createdAt; notExists keeps only its undated rows', async () => {
    const up = await tours.queryListPhase(REQUESTED, { limit: 100, forward: true });
    expect(ids(up.items)).toEqual(['tour-ql-r1', 'tour-ql-r2']);
    expect(up.scannedCount).toBe(2);
    expect(up.lastEvaluatedKey).toBeUndefined();
    const down = await tours.queryListPhase(REQUESTED, { limit: 100, forward: false });
    expect(ids(down.items)).toEqual(['tour-ql-r2', 'tour-ql-r1']);
    expect(down.scannedCount).toBe(2);

    // The dated toured row is EVALUATED, then filtered out.
    const undated = await tours.queryListPhase(UNDATED_TOURED, { limit: 100, forward: true });
    expect(ids(undated.items)).toEqual(['tour-ql-u3']);
    expect(undated.scannedCount).toBe(2);
    expect(undated.lastEvaluatedKey).toBeUndefined();
    const whole = await tours.queryListPhase({ ...UNDATED_TOURED, notExists: false }, { limit: 100, forward: true });
    expect(ids(whole.items)).toEqual(['tour-ql-d2', 'tour-ql-u3']);
    expect(whole.scannedCount).toBe(2);
  });

  it('5: Limit counts EVALUATED rows, before the filter - an empty filtered page still carries a key', async () => {
    const closed: TourListPhase = { kind: 'd', range: { op: 'all' }, statusFilter: ['closed'] };
    const page = await tours.queryListPhase(closed, { limit: 2, forward: true });
    expect(page.items).toEqual([]);
    expect(page.scannedCount).toBe(2);
    expect(page.lastEvaluatedKey).toStrictEqual(tourListKeyOf(seeded('tour-ql-d2'), closed));
  });

  it('6: a Query that stops AT its Limit returns a key even when nothing follows; resuming finds nothing', async () => {
    const two: TourListPhase = { kind: 'd', range: { op: 'between', from: at(2), to: at(3) } };
    const page = await tours.queryListPhase(two, { limit: 2, forward: true });
    expect(ids(page.items)).toEqual(['tour-ql-d2', 'tour-ql-d3']);
    expect(page.scannedCount).toBe(2);
    expect(page.lastEvaluatedKey).toStrictEqual(tourListKeyOf(seeded('tour-ql-d3'), two));

    const next = await tours.queryListPhase(two, { limit: 2, forward: true, startKey: page.lastEvaluatedKey });
    expect(next.items).toEqual([]);
    expect(next.scannedCount).toBe(0);
    expect(next.lastEvaluatedKey).toBeUndefined();
  });

  it('7: no key when the key range runs out before the Limit', async () => {
    for (const limit of [7, 100]) {
      const page = await tours.queryListPhase(ALL, { limit, forward: true });
      expect(ids(page.items), `limit ${limit}`).toEqual(DATED);
      expect(page.scannedCount, `limit ${limit}`).toBe(6);
      expect(page.lastEvaluatedKey, `limit ${limit}`).toBeUndefined();
    }
    // ...while a Limit equal to the row count stops AT it (case 6's fact).
    const exact = await tours.queryListPhase(ALL, { limit: 6, forward: true });
    expect(exact.scannedCount).toBe(6);
    expect(exact.lastEvaluatedKey).toStrictEqual(tourListKeyOf(seeded('tour-ql-d6'), ALL));
  });

  it('8: a start key built from an ITEM resumes right after that item, in either direction', async () => {
    const first = await tours.queryListPhase(ALL, { limit: 3, forward: true });
    expect(ids(first.items)).toEqual(['tour-ql-d1', 'tour-ql-d2', 'tour-ql-d3']);
    const third = first.items[2];
    if (third === undefined) throw new Error('expected a third row');

    const next = await tours.queryListPhase(ALL, { limit: 2, forward: true, startKey: tourListKeyOf(third, ALL) });
    expect(ids(next.items)).toEqual(['tour-ql-d4', 'tour-ql-d5']);
    expect(next.scannedCount).toBe(2);
    const back = await tours.queryListPhase(ALL, { limit: 100, forward: false, startKey: tourListKeyOf(third, ALL) });
    expect(ids(back.items)).toEqual(['tour-ql-d2', 'tour-ql-d1']);
    expect(back.scannedCount).toBe(2);

    const afterR1 = await tours.queryListPhase(REQUESTED, {
      limit: 100,
      forward: true,
      startKey: tourListKeyOf(seeded('tour-ql-r1'), REQUESTED),
    });
    expect(ids(afterR1.items)).toEqual(['tour-ql-r2']);
    expect(afterR1.scannedCount).toBe(1);
  });

  it('9: every phase SHAPE is a valid Query - no unused or missing expression names or values', async () => {
    const ranges: TourListRange[] = [
      { op: 'all' },
      { op: 'gte', value: at(2) },
      { op: 'lt', value: at(5) },
      { op: 'lte', value: at(5) },
      { op: 'between', from: at(2), to: at(5) },
    ];
    const statusFilters: Array<Extract<TourListPhase, { kind: 'd' }>['statusFilter']> = [
      undefined,
      ['toured', 'closed'],
    ];
    const types: Array<TourListPhase['type']> = [undefined, 'landlord_led'];
    const shapes: TourListPhase[] = [];
    for (const range of ranges) {
      for (const statusFilter of statusFilters) {
        for (const type of types) {
          shapes.push({
            kind: 'd',
            range,
            ...(statusFilter !== undefined && { statusFilter }),
            ...(type !== undefined && { type }),
          });
        }
      }
    }
    for (const base of [REQUESTED, UNDATED_TOURED]) {
      for (const type of types) shapes.push({ ...base, ...(type !== undefined && { type }) });
    }
    expect(shapes).toHaveLength(24);

    const failures: string[] = [];
    for (const phase of shapes) {
      for (const forward of [true, false]) {
        try {
          await tours.queryListPhase(phase, { limit: 100, forward });
        } catch (err) {
          const e = err as Error;
          failures.push(`${JSON.stringify(phase)} forward=${forward}: ${e.name}: ${e.message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// listTourPage over the REAL repo (Tours page All tab, spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md 5.4 and 9): the paging
// engine walks DynamoDB Local with TINY constants (2 items per filtered Query,
// ONE Query per page, 2 rows per page), so the budget stop, the k-less
// boundary cursor and the filtered phantom all happen on a ten-row table. If
// this fails where tourListPage.test.ts passes, the shared phase model
// (helpers/tourListIndexFake.ts) is wrong: fix it and its mirror first. Its OWN
// table (a when=any walk reads every tour in its table); no range-key ties;
// every instant a full toISOString() value.
describe.skipIf(!reachable)('listTourPage over toursRepo.queryListPhase on DynamoDB Local (own prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const tours = createToursRepo({ doc, env: testEnv, logger });

  const PINNED = '2026-10-06T16:00:00.000Z';
  const TINY = { queryPageLimit: 2, maxQueryCalls: 1 };
  const at = (day: number): string => `2028-02-0${day}T10:00:00.000Z`;
  const created = (day: number): string => `2028-01-${String(day).padStart(2, '0')}T09:00:00.000Z`;
  function tour(tourId: string, status: string, createdAt: string, scheduledAt?: string): CreateTourInput {
    return {
      tourId,
      tenantId: `contact-${tourId}`,
      unitId: `unit-${tourId}`,
      tourType: 'self_guided',
      status,
      createdAt,
      ...(scheduledAt !== undefined && { scheduledAt }),
    };
  }
  // Seven dated rows of several statuses (two of them closed), two requests,
  // one undated toured - and NO undated closed tour, so the closed partition's
  // first filtered batch of 2 is all filtered out.
  const FIXTURE: CreateTourInput[] = [
    tour('tour-lp-d1', 'scheduled', created(1), at(1)),
    tour('tour-lp-d2', 'toured', created(2), at(2)),
    tour('tour-lp-d3', 'no_show', created(3), at(3)),
    tour('tour-lp-d4', 'canceled', created(4), at(4)),
    tour('tour-lp-d5', 'closed', created(5), at(5)),
    tour('tour-lp-d6', 'scheduled', created(6), at(6)),
    tour('tour-lp-d7', 'closed', created(7), at(7)),
    tour('tour-lp-r1', 'requested', created(8)),
    tour('tour-lp-r2', 'requested', created(9)),
    tour('tour-lp-u3', 'toured', created(10)),
  ];
  const DATED = ['tour-lp-d1', 'tour-lp-d2', 'tour-lp-d3', 'tour-lp-d4', 'tour-lp-d5', 'tour-lp-d6', 'tour-lp-d7'];

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
    for (const input of FIXTURE) await tours.create(input);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('tours', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** One walked page, and whether every Query it made read an UNFILTERED phase D. */
  interface WalkedPage {
    page: TourListPageResult;
    unfilteredD: boolean;
  }

  /** Follow nextCursor to null (at most 50 pages), decode-free: the cursor goes
   *  back through locateTourListCursor as the next page's start. */
  async function walk(filters: TourListFilters): Promise<WalkedPage[]> {
    const phases = planTourListPhases(filters, PINNED);
    const fingerprint = tourListFingerprint(filters);
    const pages: WalkedPage[] = [];
    let start: { phaseIndex: number; startKey?: Record<string, string> } | undefined;
    for (let i = 0; i < 50; i++) {
      const read: TourListPhase[] = [];
      const page = await listTourPage(
        (phase, opts) => {
          read.push(phase);
          return tours.queryListPhase(phase, opts);
        },
        { phases, filters, fingerprint, pinnedNow: PINNED, limit: 2, ...(start !== undefined && { start }) },
        TINY,
      );
      pages.push({ page, unfilteredD: read.length > 0 && read.every((p) => p.kind === 'd' && isUnfilteredPhase(p)) });
      if (page.nextCursor === null) return pages;
      start = locateTourListCursor(page.nextCursor, phases);
      if (start === undefined) throw new Error(`cursor does not fit its plan: ${JSON.stringify(page.nextCursor)}`);
    }
    throw new Error('the walk did not end within 50 pages');
  }

  const walkedIds = (pages: WalkedPage[]): string[] => pages.flatMap((w) => w.page.items.map((t) => t.tourId));

  /** Spec 9 / ruling A-6: an unfiltered page reads at most ONE row past the
   *  rows it returns (the peek row) - on real DynamoDB. */
  function expectPeekBound(pages: WalkedPage[], label: string): number {
    const unfiltered = pages.filter((w) => w.unfilteredD);
    for (const [n, w] of unfiltered.entries()) {
      expect(w.page.evaluated, `${label} unfiltered-D page ${n}`).toBeLessThanOrEqual(w.page.items.length + 1);
    }
    return unfiltered.length;
  }

  it('latest first: every id exactly once - dated, then the requests, then the undated toured; the budget stop and the k-less u cursor survive real DynamoDB', async () => {
    const pages = await walk({ when: 'any', statuses: [], sort: 'latest' });
    const got = walkedIds(pages);
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual(FIXTURE.map((t) => String(t.tourId)).sort());
    expect(got).toEqual([...[...DATED].reverse(), 'tour-lp-r2', 'tour-lp-r1', 'tour-lp-u3']);

    expect(pages.some((w) => w.page.items.length === 0 && w.page.nextCursor !== null)).toBe(true);
    expect(pages.some((w) => w.page.nextCursor?.ph === 'u' && w.page.nextCursor.k === undefined)).toBe(true);
    expect(pages.every((w) => w.page.nextCursor?.ph !== 'd' || w.page.nextCursor.k !== undefined)).toBe(true);
    expect(pages.every((w) => w.page.calls === 1)).toBe(true);
    expect(expectPeekBound(pages, 'latest')).toBeGreaterThanOrEqual(3);
  });

  it('earliest first: every id exactly once - the dated rows EARLIEST first, then the undated ones in the same phase order', async () => {
    const pages = await walk({ when: 'any', statuses: [], sort: 'earliest' });
    const got = walkedIds(pages);
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual([...DATED, 'tour-lp-r1', 'tour-lp-r2', 'tour-lp-u3']);
    expect(pages.some((w) => w.page.items.length === 0 && w.page.nextCursor !== null)).toBe(true);
    expect(pages.some((w) => w.page.nextCursor?.ph === 'u' && w.page.nextCursor.k === undefined)).toBe(true);
    expect(expectPeekBound(pages, 'earliest')).toBeGreaterThanOrEqual(3);
  });

  it('a sparse filter (no_show): partial and empty pages, and the walk still reaches the one no-show and ends with nextCursor null', async () => {
    const pages = await walk({ when: 'any', statuses: ['no_show'], sort: 'latest' });
    expect(walkedIds(pages)).toEqual(['tour-lp-d3']);
    expect(pages.at(-1)?.page.nextCursor).toBeNull();
    expect(pages.some((w) => w.page.items.length === 0 && w.page.nextCursor?.ph === 'd')).toBe(true);
    expect(pages.length).toBeGreaterThan(2);
  });
});
