// unitsRepo.getManyByIds against DynamoDB Local (WP1 B2a spec D2.3; PR5): the
// full item round trip, a soft-deleted unit still answers, a missing id is
// absent. The stub-client cases are unitsRepoManyByIds.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
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
  console.warn(`[unitsRepoManyByIds.integration] DynamoDB Local is required at ${endpoint}`);
}

describe.skipIf(!reachable)('unitsRepo.getManyByIds against DynamoDB Local', () => {
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

  it('reads every stored attribute; a soft-deleted unit still answers; a missing id is absent', async () => {
    const kept = await units.create({
      landlordId: 'contact-ll-many-1',
      status: 'available',
      address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30301' },
      beds: 2,
      baths: 1,
      rent_max: 1450,
      notes: 'Ground floor, small yard',
    });
    const removed = await units.create({
      landlordId: 'contact-ll-many-2',
      status: 'available',
      address: { line1: '9 Elm Ave', city: 'Decatur', state: 'GA' },
    });
    await units.softDelete(removed.unitId, '2026-10-06T12:00:00.000Z');

    const found = await units.getManyByIds([kept.unitId, removed.unitId, 'unit-missing', kept.unitId], {
      requireComplete: true,
    });

    expect([...found.keys()].sort()).toEqual([kept.unitId, removed.unitId].sort());
    expect(found.get(kept.unitId)).toEqual(await units.getById(kept.unitId, { consistentRead: true }));
    expect(found.get(kept.unitId)).toMatchObject({ beds: 2, rent_max: 1450, notes: 'Ground floor, small yard' });
    expect(found.get(removed.unitId)!.deleted_at).toBe('2026-10-06T12:00:00.000Z');
  });
});
