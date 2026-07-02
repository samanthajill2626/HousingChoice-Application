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
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
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
});
