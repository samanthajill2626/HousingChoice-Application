// share-sent-outcome D2 / I3 / I4 against DynamoDB Local: the ONE slot write
// that may leave `failed` - conditioned on the recorded attempt AND the status,
// carrying its stats delta - and the BatchGet by id D5 reads. The condition's
// nested-path aliases and the ADD clause are exactly what the in-memory double
// cannot validate (an unused alias is a ValidationException).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT the suite is skipped (`npm run db:start` to run it).
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createBroadcastsRepo, zeroStats, type BroadcastItem } from '../src/repos/broadcastsRepo.js';
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
    `[broadcastsRepoAttemptOutcome.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const ROOT = '2026-09-28T10:00:00.000Z#SM1';
const RETRY = '2026-09-28T10:01:00.000Z#SM2';
const stats1 = { ...zeroStats(), audience: 1 };

describe.skipIf(!reachable)('broadcastsRepo.applyAttemptOutcome and getByIds against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createBroadcastsRepo({ doc, env: testEnv, logger });
  const broadcastsTable = tableName('broadcasts', testEnv);

  /** The required item fields every seeded share carries (created_by, audience_filter, body_template, created_at). */
  const baseShare = {
    created_by: 'usr_test',
    created_at: '2026-09-28T09:59:00.000Z',
    audience_filter: { contact_type: 'tenant' as const, excludeOptedOut: true, excludeUnreachable: true },
    body_template: 'Hi [TenantName]',
  };
  /** Seed one share item verbatim (a raw Put - the slots a test needs, no lifecycle walk). */
  async function putShare(item: Partial<BroadcastItem> & Pick<BroadcastItem, 'broadcastId' | 'status' | 'recipients' | 'stats'>): Promise<void> {
    await doc.send(new PutCommand({ TableName: broadcastsTable, Item: { ...baseShare, ...item } }));
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('broadcasts'), broadcastsTable);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, broadcastsTable);
    doc.destroy();
    client.destroy();
  }, 120_000);

  describe('applyAttemptOutcome', () => {
    it('applies when the slot records no attempt (the original) and the status matches, and ADDs the delta in the same write', async () => {
      await putShare({ broadcastId: 'b1', status: 'sent', recipients: { c1: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT } },
        stats: { ...stats1, failed: 1 } });
      const res = await repo.applyAttemptOutcome('b1', 'c1', { status: 'failed', latestAttempt: undefined },
        { status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { failed: -1, delivered: 1 });
      expect(res.applied).toBe(true);
      expect(res.item?.recipients?.['c1']).toMatchObject({ status: 'delivered', latestAttempt: RETRY });
      expect(res.item?.stats).toMatchObject({ failed: 0, delivered: 1 });
      // The stored item, not only the returned image.
      expect((await repo.getByIdConsistent('b1'))?.recipients['c1']).toStrictEqual({ status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY });
    });
    it('refuses when the recorded attempt moved (another writer won) - no stats change', async () => {
      await putShare({ broadcastId: 'b2', status: 'sent', recipients: { c1: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY } },
        stats: { ...stats1, failed: 1 } });
      const res = await repo.applyAttemptOutcome('b2', 'c1', { status: 'failed', latestAttempt: undefined },
        { status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { failed: -1, delivered: 1 });
      expect(res.applied).toBe(false);
      expect((await repo.getByIdConsistent('b2'))?.stats.failed).toBe(1);
    });
    it('applies when the expected attempt is the recorded one (a later attempt over a recorded retry)', async () => {
      const later = '2026-09-28T10:02:00.000Z#SM3';
      await putShare({ broadcastId: 'b2b', status: 'sent', recipients: { c1: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY } },
        stats: { ...stats1, failed: 1 } });
      const res = await repo.applyAttemptOutcome('b2b', 'c1', { status: 'failed', latestAttempt: RETRY },
        { status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: later }, { failed: -1, sent: 1 });
      expect(res.applied).toBe(true);
      expect(res.item?.recipients['c1']).toStrictEqual({ status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: later });
      expect(res.item?.stats).toMatchObject({ failed: 0, sent: 1 });
    });
    it('refuses when the status moved under it', async () => {
      await putShare({ broadcastId: 'b3', status: 'sent', recipients: { c1: { status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT } }, stats: { ...stats1, delivered: 1 } });
      const res = await repo.applyAttemptOutcome('b3', 'c1', { status: 'sent', latestAttempt: undefined },
        { status: 'failed', errorCode: '30007', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { sent: -1, failed: 1 });
      expect(res.applied).toBe(false);
    });
    it('a missing broadcast is refused, never thrown', async () => {
      const res = await repo.applyAttemptOutcome('nope', 'c1', { status: 'failed', latestAttempt: undefined },
        { status: 'sent', latestAttempt: RETRY }, { failed: -1, sent: 1 });
      expect(res.applied).toBe(false);
    });
    it('an EMPTY delta writes the slot only (no ADD clause, no unused alias)', async () => {
      await putShare({ broadcastId: 'b4', status: 'sent', recipients: { c1: { status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT } }, stats: { ...stats1, sent: 1 } });
      const res = await repo.applyAttemptOutcome('b4', 'c1', { status: 'sent', latestAttempt: undefined },
        { status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, carrierSentAt: '2026-09-28T10:00:01.000Z' }, {});
      expect(res.applied).toBe(true);
      expect(res.item?.stats).toStrictEqual({ ...stats1, sent: 1 });
    });
  });

  describe('getByIds', () => {
    it('returns the found items keyed by id and omits the missing ones', async () => {
      await putShare({ broadcastId: 'g1', status: 'sent', recipients: {}, stats: zeroStats() });
      const m = await repo.getByIds(['g1', 'missing']);
      expect([...m.keys()]).toEqual(['g1']);
      expect(m.get('g1')?.body_template).toBe('Hi [TenantName]');
    });
    it('the stats projection carries recipients, stats, status and unitId but not the template', async () => {
      await putShare({ broadcastId: 'g2', status: 'sent', unitId: 'unit-1', recipients: { c1: { status: 'delivered' } }, stats: zeroStats() });
      const m = await repo.getByIds(['g2'], { projection: 'stats' });
      expect(m.get('g2')).toStrictEqual({ broadcastId: 'g2', status: 'sent', unitId: 'unit-1', recipients: { c1: { status: 'delivered' } }, stats: zeroStats() });
      expect(m.get('g2')?.body_template).toBeUndefined();
    });
    it('reads more than one BatchGet chunk (100 keys) and de-duplicates the ids', async () => {
      const ids = Array.from({ length: 105 }, (_, i) => `chunk-${i}`);
      for (const broadcastId of ids) await putShare({ broadcastId, status: 'sent', recipients: {}, stats: zeroStats() });
      const m = await repo.getByIds([...ids, 'chunk-0', 'chunk-104']);
      expect(m.size).toBe(105);
    });
    it('an empty list reads nothing', async () => {
      expect((await repo.getByIds([])).size).toBe(0);
    });
  });
});
