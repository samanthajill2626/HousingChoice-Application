// share-sent-outcome D7 against DynamoDB Local: the ledger row's per-share
// memory, the counted flag, the byContact index made sparse by ABSENCE (sentAt
// REMOVED while nothing counts), the base-table reader's filter, and the
// change token every putShareMemory stamps. The conditional write, its
// if_not_exists furniture and its SET-or-REMOVE shape are exactly what the
// in-memory double cannot validate.
//
// The cases run IN ORDER and share rows (the third reads what the first
// wrote), like the file's sibling listingSendsRepo.integration.test.ts.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT the suite is skipped (`npm run db:start` to run it).
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createListingSendsRepo } from '../src/repos/listingSendsRepo.js';
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
    `[listingSendsRepoShares.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const A1 = { attempt: '2026-09-28T10:00:00.000Z#SM1', state: 'counted' as const, by: 'acceptance' as const, countedAt: '2026-09-28T10:00:00.000Z' };

describe.skipIf(!reachable)('listingSendsRepo per-share memory against DynamoDB Local (share-sent-outcome D7)', () => {
  const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createListingSendsRepo({ doc, env, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('listing_sends'), tableName('listing_sends', env));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('listing_sends', env));
    doc.destroy();
    client.destroy();
  }, 120_000);

  describe('putShareMemory', () => {
    it('creates the row when no token is expected and none exists; a second tokenless write loses (the first write stamped the token)', async () => {
      const next = { shares: { b1: A1 }, counted: true, sentAt: A1.countedAt, broadcastId: 'b1' };
      expect(await repo.putShareMemory('unit-1', 'c1', next, { token: undefined })).toBe(true);
      expect(await repo.putShareMemory('unit-1', 'c1', next, { token: undefined })).toBe(false);
      const row = await repo.getByKeyConsistent('unit-1', 'c1');
      expect(row).toMatchObject({ counted: true, sentAt: A1.countedAt, broadcastId: 'b1', via: 'broadcast', shares: { b1: A1 } });
      expect(typeof row?.shares_op).toBe('string');
      expect(typeof row?.created_at).toBe('string');
    });
    it('a SEEDED row (created_at, sentAt, no token - the full-world matrix shape) accepts a tokenless first write and keeps its first-write furniture', async () => {
      await doc.send(new PutCommand({ TableName: tableName('listing_sends', env), Item: { unitId: 'unit-mx', contactId: 'c-mx', sentAt: '2026-08-01T00:00:00.000Z', via: 'broadcast', broadcastId: 'b-old', created_at: '2026-08-01T00:00:00.000Z' } }));
      expect(await repo.putShareMemory('unit-mx', 'c-mx', { shares: { 'b-old': { ...A1, attempt: '!legacy', countedAt: '2026-08-01T00:00:00.000Z' } }, counted: true, sentAt: '2026-08-01T00:00:00.000Z', broadcastId: 'b-old' }, { token: undefined })).toBe(true);
      expect(await repo.getByKeyConsistent('unit-mx', 'c-mx')).toMatchObject({ created_at: '2026-08-01T00:00:00.000Z', via: 'broadcast' });
    });
    it('the current token wins; a stale token loses; nothing-counted REMOVES sentAt and broadcastId, the byContact index drops the row and the base reader filters it; a re-count brings it back', async () => {
      const first = await repo.getByKeyConsistent('unit-1', 'c1');
      const cleared = { shares: { b1: { attempt: A1.attempt, state: 'failed' as const } }, counted: false, sentAt: undefined, broadcastId: undefined };
      expect(await repo.putShareMemory('unit-1', 'c1', cleared, { token: 'not-the-token' })).toBe(false);
      expect(await repo.putShareMemory('unit-1', 'c1', cleared, { token: first!.shares_op })).toBe(true);
      const row = await repo.getByKeyConsistent('unit-1', 'c1');
      expect(row?.counted).toBe(false);
      expect(row?.sentAt).toBeUndefined();
      expect(row?.broadcastId).toBeUndefined();
      expect(row?.shares_op).not.toBe(first!.shares_op); // every write stamps a fresh token
      expect(await repo.listByContact('c1')).toEqual([]); // the GSI is sparse by absence
      expect(await repo.listByUnit('unit-1')).toEqual([]); // the base-table reader filters counted === false
      const recounted = { shares: { b1: { attempt: '2026-09-28T10:05:00.000Z#SM2', state: 'counted' as const, by: 'delivery' as const, countedAt: '2026-09-28T10:05:00.000Z' } }, counted: true, sentAt: '2026-09-28T10:05:00.000Z', broadcastId: 'b1' };
      expect(await repo.putShareMemory('unit-1', 'c1', recounted, { token: row!.shares_op })).toBe(true);
      expect((await repo.listByContact('c1')).map((r) => r.sentAt)).toEqual(['2026-09-28T10:05:00.000Z']); // back in the index
      expect((await repo.listByUnit('unit-1')).map((r) => r.contactId)).toEqual(['c1']);
    });
    it('an individual-only counted pair keeps sentAt and no broadcastId', async () => {
      expect(await repo.putShareMemory('unit-2', 'c1', { shares: { individual: { attempt: '!individual', state: 'counted', by: 'acceptance', countedAt: '2026-07-01T00:00:00.000Z' } }, counted: true, sentAt: '2026-07-01T00:00:00.000Z', broadcastId: undefined }, { token: undefined })).toBe(true);
      const row = await repo.getByKeyConsistent('unit-2', 'c1');
      expect(row).toMatchObject({ counted: true, sentAt: '2026-07-01T00:00:00.000Z' });
      expect(row?.broadcastId).toBeUndefined();
    });
    it('getByKeys returns the found pairs keyed unitId|contactId', async () => {
      const m = await repo.getByKeys([{ unitId: 'unit-1', contactId: 'c1' }, { unitId: 'unit-9', contactId: 'c9' }]);
      expect([...m.keys()]).toEqual(['unit-1|c1']);
      expect(m.get('unit-1|c1')).toMatchObject({ unitId: 'unit-1', contactId: 'c1', counted: true });
    });
    it('getByKeys de-duplicates the pairs, reads more than one BatchGet chunk, and an empty list reads nothing', async () => {
      const pairs = Array.from({ length: 101 }, (_, i) => ({ unitId: 'unit-chunk', contactId: `c-${i}` }));
      for (const p of pairs) {
        await doc.send(new PutCommand({ TableName: tableName('listing_sends', env), Item: { ...p, sentAt: '2026-08-01T00:00:00.000Z', via: 'broadcast', created_at: '2026-08-01T00:00:00.000Z' } }));
      }
      const m = await repo.getByKeys([...pairs, pairs[0]!, pairs[100]!]);
      expect(m.size).toBe(101);
      expect((await repo.getByKeys([])).size).toBe(0);
    });
  });
});
