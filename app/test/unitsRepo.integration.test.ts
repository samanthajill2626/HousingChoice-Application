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
});
