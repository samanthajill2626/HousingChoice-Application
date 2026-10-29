// rankingRunsRepo, the UNLAWFUL-FLAG family (WP1 B2a spec D10; plan PR5).
// "Open" is decided on read (S6) against the property's CURRENT card: the
// field is on it and its trimmed text still hashes to textHash. So the write
// is conditioned on the hash the caller computes from the current card: an
// equal stored hash is an OPEN flag (kept, first raising run), a different
// one is CLOSED (overwritten), none is ABSENT (written).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createRankingRunsRepo,
  unlawfulFlagEntityKey,
  unlawfulFlagItemId,
  type UnlawfulFlagInput,
} from '../src/repos/rankingRunsRepo.js';
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
  console.warn(`[rankingRunsRepoFlags.integration] DynamoDB Local is required at ${endpoint}`);
}

describe('unlawful flag keys', () => {
  it('uflag#<unitId>#<field>, and the uflags#<unitId> partition', () => {
    expect(unlawfulFlagItemId('unit-1', 'qualifications')).toBe('uflag#unit-1#qualifications');
    expect(unlawfulFlagItemId('unit-1', 'landlord:notes')).toBe('uflag#unit-1#landlord:notes');
    expect(unlawfulFlagEntityKey('unit-1')).toBe('uflags#unit-1');
  });
});

describe.skipIf(!reachable)('rankingRunsRepo flag family against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createRankingRunsRepo({ doc, env: testEnv, logger });
  const table = tableName('ai_runs', testEnv);
  const unit = (): string => `unit-${randomUUID().slice(0, 8)}`;

  function flag(unitId: string, over: Partial<UnlawfulFlagInput> = {}): UnlawfulFlagInput {
    return {
      unitId,
      field: 'qualifications',
      textHash: 'a'.repeat(64),
      reason: 'No kids under 10',
      runId: 'rank-1',
      raisedAt: '2026-10-28T11:00:00.000Z',
      ...over,
    };
  }

  async function raw(unitId: string, field: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: { itemId: unlawfulFlagItemId(unitId, field) }, ConsistentRead: true }),
    );
    return Item as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('ai_runs'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('an absent flag is written with its index keys and NO TTL', async () => {
    const unitId = unit();

    expect(await repo.putFlagIfAbsentOrClosed(flag(unitId))).toBe(true);

    expect(await raw(unitId, 'qualifications')).toEqual({
      itemId: `uflag#${unitId}#qualifications`,
      unitId,
      field: 'qualifications',
      textHash: 'a'.repeat(64),
      reason: 'No kids under 10',
      runId: 'rank-1',
      raisedAt: '2026-10-28T11:00:00.000Z',
      entityKey: `uflags#${unitId}`,
      sortKey: 'qualifications',
    });
  });

  it('an OPEN flag (same text hash) is kept: raised once per property and field, first run wins', async () => {
    const unitId = unit();
    await repo.putFlagIfAbsentOrClosed(flag(unitId));

    expect(
      await repo.putFlagIfAbsentOrClosed(flag(unitId, { runId: 'rank-2', raisedAt: '2026-10-28T11:05:00.000Z' })),
    ).toBe(false);
    expect(await raw(unitId, 'qualifications')).toMatchObject({ runId: 'rank-1', raisedAt: '2026-10-28T11:00:00.000Z' });
  });

  it('a CLOSED flag (the text was edited: a different hash) is overwritten when raised again', async () => {
    const unitId = unit();
    await repo.putFlagIfAbsentOrClosed(flag(unitId));

    expect(
      await repo.putFlagIfAbsentOrClosed(
        flag(unitId, { textHash: 'b'.repeat(64), runId: 'rank-3', raisedAt: '2026-10-29T09:00:00.000Z', reason: 'Adults only' }),
      ),
    ).toBe(true);
    expect(await raw(unitId, 'qualifications')).toMatchObject({
      textHash: 'b'.repeat(64),
      runId: 'rank-3',
      raisedAt: '2026-10-29T09:00:00.000Z',
      reason: 'Adults only',
    });
  });

  it("getOpenCandidateFlags answers every record for the unit, by field, and no other unit's", async () => {
    const unitId = unit();
    await repo.putFlagIfAbsentOrClosed(flag(unitId, { field: 'notes' }));
    await repo.putFlagIfAbsentOrClosed(flag(unitId, { field: 'landlord:qualifications' }));
    await repo.putFlagIfAbsentOrClosed(flag(unitId, { field: 'application_process' }));
    await repo.putFlagIfAbsentOrClosed(flag(unit(), { field: 'notes' }));

    const flags = await repo.getOpenCandidateFlags(unitId);

    expect(flags.map((f) => f.field)).toEqual(['application_process', 'landlord:qualifications', 'notes']);
    expect(flags.every((f) => f.unitId === unitId)).toBe(true);
    expect(await repo.getOpenCandidateFlags(unit())).toEqual([]);
  });
});
