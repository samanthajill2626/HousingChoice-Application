// M1.5 integration tests against DynamoDB Local — the units repo: create
// (generated id), getById, SET-merge update (no-overwrite of unset fields +
// conditional 404), and each of the three GSIs (byLandlord, byStatus,
// byJurisdiction) plus the unfiltered Scan list.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createUnitsRepo } from '../src/repos/unitsRepo.js';
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
    `[unitsRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

// The appendMedia batch bound is a pure in-process guard (it throws BEFORE any
// DynamoDB write), so it is testable without Docker: a stub doc client proves
// the over-cap batch never reaches doc.send.
describe('unitsRepo.appendMedia batch bound (no DynamoDB needed)', () => {
  it('rejects a batch larger than the cap before any write', async () => {
    let sends = 0;
    const stubDoc = {
      send: async () => {
        sends += 1;
        throw new Error('should not reach DynamoDB');
      },
    };
    const logger = createLogger({ destination: createLogCapture().stream });
    const repo = createUnitsRepo({
      doc: stubDoc as unknown as NonNullable<Parameters<typeof createUnitsRepo>[0]>['doc'],
      env: { TABLE_PREFIX: 'hc-stub-' },
      logger,
    });
    await expect(repo.appendMedia('unit-x', ['k1', 'k2', 'k3', 'k4'], 3)).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
    expect(sends).toBe(0);
  });
});

describe.skipIf(!reachable)('unitsRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const units = createUnitsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('units'), tableName('units', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('units', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('create generates a unitId, stamps timestamps, and getById reads it back', async () => {
    const unit = await units.create({
      landlordId: 'contact-ll-1',
      status: 'available',
      jurisdiction: 'DCA',
      beds: 2,
      baths: 1,
      rent_min: 1400,
      tour_process: 'call the office',
    });
    expect(unit.unitId).toMatch(/^unit-/);
    expect(unit.created_at).toBeDefined();
    expect(unit.updated_at).toBeDefined();

    const read = await units.getById(unit.unitId);
    expect(read).toMatchObject({
      unitId: unit.unitId,
      landlordId: 'contact-ll-1',
      status: 'available',
      jurisdiction: 'DCA',
      beds: 2,
      tour_process: 'call the office',
    });
  });

  it('update SET-merges (leaves unset fields untouched) and bumps updated_at', async () => {
    const unit = await units.create({
      landlordId: 'contact-ll-2',
      status: 'available',
      beds: 3,
      rent_min: 1600,
      application_process: 'paper app at the unit',
    });
    const before = unit.updated_at;

    const updated = await units.update(unit.unitId, { status: 'placed', rent_max: 1800 });
    expect(updated.status).toBe('placed');
    expect(updated.rent_max).toBe(1800);
    // Untouched fields survive the merge.
    expect(updated.beds).toBe(3);
    expect(updated.rent_min).toBe(1600);
    expect(updated.application_process).toBe('paper app at the unit');
    expect(updated.updated_at).not.toBe(before);
  });

  it('update throws ConditionalCheckFailedException for an unknown unit', async () => {
    await expect(units.update('unit-ghost', { status: 'placed' })).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('lists via each GSI and the unfiltered Scan', async () => {
    const landlordId = `contact-ll-gsi-${randomUUID().slice(0, 6)}`;
    const jurisdiction = `JUR-${randomUUID().slice(0, 6)}`;
    const status = `st-${randomUUID().slice(0, 6)}`; // unique status partition
    await units.create({ landlordId, status, jurisdiction, beds: 1 });
    await units.create({ landlordId, status, jurisdiction, beds: 2 });

    const byLandlord = await units.listByLandlord(landlordId);
    expect(byLandlord.items).toHaveLength(2);
    expect(byLandlord.items.every((u) => u.landlordId === landlordId)).toBe(true);

    const byStatus = await units.listByStatus(status);
    expect(byStatus.items).toHaveLength(2);
    expect(byStatus.items.every((u) => u.status === status)).toBe(true);

    const byJurisdiction = await units.listByJurisdiction(jurisdiction);
    expect(byJurisdiction.items).toHaveLength(2);
    expect(byJurisdiction.items.every((u) => u.jurisdiction === jurisdiction)).toBe(true);

    // The unfiltered Scan sees everything (at least our six creates in this suite).
    const all = await units.list({ limit: 100 });
    expect(all.items.length).toBeGreaterThanOrEqual(2);
  });

  it('paginates a GSI query via LastEvaluatedKey', async () => {
    const landlordId = `contact-ll-page-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 3; i++) {
      await units.create({ landlordId, status: 'available', beds: i });
    }
    const collected: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const page = await units.listByLandlord(landlordId, {
        limit: 1,
        ...(cursor !== undefined && { exclusiveStartKey: cursor }),
      });
      collected.push(...page.items.map((u) => u.unitId));
      cursor = page.lastEvaluatedKey;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(new Set(collected).size).toBe(3); // no gaps or dupes
    expect(pages).toBeGreaterThanOrEqual(3); // really paginated
  });

  // unit-photos S1: the ATOMIC media array ops against the REAL DynamoDB item
  // (list_append + if_not_exists seed + the size-guard ConditionExpression).
  it('appendMedia atomically list_appends (seeds a missing attribute; first = cover)', async () => {
    const unit = await units.create({ landlordId: 'contact-ll-media', status: 'available' });
    // First append seeds the absent attribute (if_not_exists -> []), then appends.
    const a = await units.appendMedia(unit.unitId, ['unit-media/x/k1', 'unit-media/x/k2']);
    expect(a.media).toEqual(['unit-media/x/k1', 'unit-media/x/k2']);
    // A second append lands AFTER (list_append order), never clobbering.
    const b = await units.appendMedia(unit.unitId, ['unit-media/x/k3']);
    expect(b.media).toEqual(['unit-media/x/k1', 'unit-media/x/k2', 'unit-media/x/k3']);
  });

  it('appendMedia cap guard rejects a batch that would exceed the cap (ConditionalCheckFailed)', async () => {
    const unit = await units.create({ landlordId: 'contact-ll-cap', status: 'available' });
    // Seed to one below a small cap, then a 2-key batch would exceed it.
    await units.appendMedia(unit.unitId, ['unit-media/y/k1', 'unit-media/y/k2'], 3);
    await expect(
      units.appendMedia(unit.unitId, ['unit-media/y/k3', 'unit-media/y/k4'], 3),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    // The rejected append wrote NOTHING - the array is unchanged.
    const read = await units.getById(unit.unitId);
    expect(read?.media).toEqual(['unit-media/y/k1', 'unit-media/y/k2']);
  });

  it('appendMedia rejects a FIRST batch larger than the cap (the media-absent branch is bounded too)', async () => {
    // The size() ConditionExpression cannot guard an ABSENT media attribute
    // (if_not_exists is UpdateExpression-only), so the repo bounds the batch
    // in-process before the write. A fresh unit's first over-cap append must
    // reject and leave `media` unset.
    const unit = await units.create({ landlordId: 'contact-ll-first', status: 'available' });
    await expect(
      units.appendMedia(unit.unitId, ['unit-media/z/k1', 'unit-media/z/k2', 'unit-media/z/k3', 'unit-media/z/k4'], 3),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const read = await units.getById(unit.unitId);
    expect(read?.media).toBeUndefined();
  });

  it('removeMedia drops the entry (404-signal when absent); makeCover moves to front (no-op when already cover)', async () => {
    const unit = await units.create({ landlordId: 'contact-ll-rm', status: 'available' });
    await units.appendMedia(unit.unitId, ['k1', 'k2', 'k3']);

    const removed = await units.removeMedia(unit.unitId, 'k2');
    expect(removed.media).toEqual(['k1', 'k3']);
    await expect(units.removeMedia(unit.unitId, 'gone')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );

    const covered = await units.makeCover(unit.unitId, 'k3');
    expect(covered.media).toEqual(['k3', 'k1']);
    // Already the cover -> no-op success (unchanged).
    const noop = await units.makeCover(unit.unitId, 'k3');
    expect(noop.media).toEqual(['k3', 'k1']);
    await expect(units.makeCover(unit.unitId, 'gone')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });
});
