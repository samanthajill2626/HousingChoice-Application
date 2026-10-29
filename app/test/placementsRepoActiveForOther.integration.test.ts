// placementsRepo.hasActivePlacementForOtherTenant against DynamoDB Local
// (WP1 B2a spec D1; PR5; WI20's repository half): active means the stage is
// not in TERMINAL_STAGES (moved_in, lost); the anchor tenant's own placement
// never excludes the unit.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
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
  console.warn(`[placementsRepoActiveForOther.integration] DynamoDB Local is required at ${endpoint}`);
}

describe.skipIf(!reachable)('placementsRepo.hasActivePlacementForOtherTenant against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const placements = createPlacementsRepo({ doc, env: testEnv, logger });
  const unit = (): string => `unit-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('placements'), tableName('placements', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('placements', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('false for a unit with no placements', async () => {
    expect(await placements.hasActivePlacementForOtherTenant(unit(), 'contact-anchor')).toBe(false);
  });

  it("the anchor tenant's own active placement does not count (WI20)", async () => {
    const unitId = unit();
    await placements.create({ tenantId: 'contact-anchor', unitId, stage: 'send_application' });
    expect(await placements.hasActivePlacementForOtherTenant(unitId, 'contact-anchor')).toBe(false);
  });

  it("another tenant's terminal placements (moved_in, lost) do not count", async () => {
    const unitId = unit();
    await placements.create({ tenantId: 'contact-a', unitId, stage: 'moved_in' });
    await placements.create({ tenantId: 'contact-b', unitId, stage: 'lost' });
    expect(await placements.hasActivePlacementForOtherTenant(unitId, 'contact-anchor')).toBe(false);
  });

  it("another tenant's active placement counts, beside the anchor's own", async () => {
    const unitId = unit();
    await placements.create({ tenantId: 'contact-anchor', unitId, stage: 'send_application' });
    await placements.create({ tenantId: 'contact-other', unitId, stage: 'awaiting_inspection' });
    expect(await placements.hasActivePlacementForOtherTenant(unitId, 'contact-anchor')).toBe(true);
    expect(await placements.hasActivePlacementForOtherTenant(unitId, 'contact-other')).toBe(true);
  });

  it('a placement on another unit never counts', async () => {
    const unitId = unit();
    await placements.create({ tenantId: 'contact-other', unitId: unit(), stage: 'send_application' });
    expect(await placements.hasActivePlacementForOtherTenant(unitId, 'contact-anchor')).toBe(false);
  });
});
