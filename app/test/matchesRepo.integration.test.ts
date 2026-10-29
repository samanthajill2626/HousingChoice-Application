// matchesRepo against DynamoDB Local (WP1 B2a spec D8, D8.1; PR5; WI1): the
// real key schema, the byUnit index, consistent reads, the legacy-row rule and
// the TTL attribute.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createMatchesRepo,
  decodeSnapshot,
  encodeSnapshot,
  rankingExpiresAt,
  type MatchRow,
} from '../src/repos/matchesRepo.js';
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
  console.warn(`[matchesRepo.integration] DynamoDB Local is required at ${endpoint}`);
}

const COMPUTED_AT = '2026-10-28T12:00:00.000Z';

function row(tenantId: string, unitId: string, over: Partial<MatchRow> = {}): MatchRow {
  return {
    tenantId,
    unitId,
    schema: 2,
    score: 64,
    for: [{ text: 'Area fits', source: 'area' }],
    against: [],
    missing: [{ key: 'accessibility', text: 'Accessibility' }],
    failedRequirements: ['no_pets'],
    fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
    stage: 1,
    rubricVersion: 'r1',
    examplesVersion: 'e1',
    promptFingerprint: 'b'.repeat(64),
    model: 'fake',
    runId: 'run-int-1',
    jobGeneration: 'gen-int-1',
    computedAt: COMPUTED_AT,
    anchorSide: 'tenant',
    fingerprints: { tenantCard: 't'.repeat(64), unitCard: 'u'.repeat(64), pairHistory: 'p'.repeat(64) },
    inputSnapshot: encodeSnapshot({ anchor: { card: { firstName: 'Pat' } }, candidate: { card: { beds: 2 } } }),
    expires_at: rankingExpiresAt(COMPUTED_AT, 180),
    ...over,
  };
}

describe.skipIf(!reachable)('matchesRepo against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const matches = createMatchesRepo({ doc, env: testEnv, logger });
  const table = tableName('matches', testEnv);
  const id = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('matches'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('put then read by key round-trips the whole row; the snapshot decodes; the TTL is set', async () => {
    const written = row(id('contact'), id('unit'));
    expect(await matches.putMatches([written])).toEqual({ written: 1, unwritten: [] });

    const found = await matches.getPairs([{ tenantId: written.tenantId, unitId: written.unitId }], {
      requireComplete: true,
    });

    const read = found.get(`${written.tenantId}#${written.unitId}`);
    expect(read).toEqual(written);
    expect(decodeSnapshot(read!.inputSnapshot)).toEqual({
      anchor: { card: { firstName: 'Pat' } },
      candidate: { card: { beds: 2 } },
    });
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: { tenantId: written.tenantId, unitId: written.unitId } }),
    );
    expect(Item!['expires_at']).toBe(Math.floor(Date.parse(COMPUTED_AT) / 1000) + 180 * 86400);
  });

  it('a rewrite of the pair replaces the row (one row per pair)', async () => {
    const tenantId = id('contact');
    const unitId = id('unit');
    await matches.putMatches([row(tenantId, unitId, { score: 20, runId: 'run-a' })]);
    await matches.putMatches([row(tenantId, unitId, { score: 85, runId: 'run-b' })]);

    const found = await matches.getPairs([{ tenantId, unitId }], { requireComplete: true });
    expect(found.get(`${tenantId}#${unitId}`)).toMatchObject({ score: 85, runId: 'run-b' });
    expect(await matches.listByTenant(tenantId)).toHaveLength(1);
  });

  it('writes and reads 30 pairs across two BatchWrite chunks', async () => {
    const unitId = id('unit');
    const rows = Array.from({ length: 30 }, (_, i) => row(`contact-bulk-${i}-${unitId}`, unitId));
    await matches.putMatches(rows);

    const found = await matches.getPairs(rows.map((r) => ({ tenantId: r.tenantId, unitId })), {
      requireComplete: true,
    });
    expect(found.size).toBe(30);
    expect((await matches.listByUnit(unitId)).map((r) => r.tenantId).sort()).toEqual(
      rows.map((r) => r.tenantId).sort(),
    );
  });

  it('listByUnit and listByTenant return only schema 2 rows; a legacy row is ignored by every reader', async () => {
    const tenantId = id('contact');
    const unitId = id('unit');
    const otherUnit = id('unit');
    const legacyTenant = id('contact');
    // The removed lean seed row's shape (lean.ts before WP1 B2a S2.7).
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          tenantId: legacyTenant,
          unitId,
          fit_score: 0.91,
          approval_likelihood: 0.84,
          rank: 1,
          status: 'shared',
          expires_at: 1787270400,
          generated_at: '2026-06-01T12:00:00.000Z',
        },
      }),
    );
    await matches.putMatches([row(tenantId, unitId), row(tenantId, otherUnit)]);

    expect((await matches.listByUnit(unitId)).map((r) => r.tenantId)).toEqual([tenantId]);
    expect((await matches.listByTenant(tenantId)).map((r) => r.unitId).sort()).toEqual([unitId, otherUnit].sort());
    expect(await matches.listByTenant(legacyTenant)).toEqual([]);
    const pairs = await matches.getPairs([{ tenantId: legacyTenant, unitId }], { requireComplete: true });
    expect(pairs.size).toBe(0);
  });
});
