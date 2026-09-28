// BE4/C4 integration tests against DynamoDB Local - the listing-sends repo:
// putShareMemory (the one writer since share-sent-outcome T7 retired the blind upsert)
// creates a row; a later counted share refreshes sentAt/broadcastId but
// PRESERVES created_at (the no first-write reset invariant); listByUnit +
// listByContact both return the row (two query directions); rows are isolated
// per unit/contact. The memory itself (tokens, sparse removal, BatchGet) is
// listingSendsRepoShares.integration.test.ts.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createListingSendsRepo } from '../src/repos/listingSendsRepo.js';
import { LEGACY_ATTEMPT_KEY } from '../src/lib/shareAttemptOrder.js';
import { createLogCapture } from './helpers/logCapture.js';
import { seedListingSend } from './helpers/listingSendSeed.js';

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
    `[listingSendsRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('listingSendsRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createListingSendsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('listing_sends'), tableName('listing_sends', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('listing_sends', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('putShareMemory creates a counted row and stamps audit furniture', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
    const row = await repo.getByKeyConsistent(unitId, contactId);
    expect(row?.sentAt).toBe('2026-06-16T10:00:00.000Z');
    expect(row?.via).toBe('broadcast');
    expect(row?.broadcastId).toBe('bcast-1');
    expect(row?.counted).toBe(true);
    expect(row?.shares?.['bcast-1']).toEqual({ attempt: LEGACY_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: '2026-06-16T10:00:00.000Z' });
    expect(typeof row?.shares_op).toBe('string');
    expect(row?.created_at).toBeDefined();
    expect(row?.updated_at).toBeDefined();
    // The removed `response` label is never written.
    expect(row).not.toHaveProperty('response');
  });

  it('a later counted share updates sentAt/broadcastId but PRESERVES created_at (no first-write reset); an individual share counted later clears the share attribution', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
    const first = await repo.getByKeyConsistent(unitId, contactId);

    await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-17T10:00:00.000Z', broadcastId: 'bcast-2' });
    const resent = await repo.getByKeyConsistent(unitId, contactId);
    expect(resent?.created_at).toBe(first?.created_at); // first-write furniture preserved
    expect(resent?.sentAt).toBe('2026-06-17T10:00:00.000Z');
    expect(resent?.broadcastId).toBe('bcast-2');
    expect(resent?.shares_op).not.toBe(first?.shares_op); // a fresh change token per write

    await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-18T10:00:00.000Z' });
    const individual = await repo.getByKeyConsistent(unitId, contactId);
    expect(individual?.sentAt).toBe('2026-06-18T10:00:00.000Z');
    // The latest counted entry is an individual send (no share id): the attribution clears.
    expect(individual?.broadcastId).toBeUndefined();
    expect(individual?.created_at).toBe(first?.created_at);
  });

  it('both query directions return the row', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });

    const byUnit = await repo.listByUnit(unitId);
    const byContact = await repo.listByContact(contactId);
    expect(byUnit).toHaveLength(1);
    expect(byContact).toHaveLength(1);
    expect(byUnit[0]?.unitId).toBe(unitId);
    expect(byContact[0]?.contactId).toBe(contactId);
  });

  it('getByKey point-reads a single row (and returns undefined when absent)', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    expect(await repo.getByKey(unitId, contactId)).toBeUndefined();
    await seedListingSend(repo, { unitId, contactId, sentAt: '2026-06-16T10:00:00.000Z' });
    const row = await repo.getByKey(unitId, contactId);
    expect(row?.unitId).toBe(unitId);
    expect(row?.contactId).toBe(contactId);
  });

  it('listByContact returns a contacts sends newest-first by sentAt', async () => {
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    const u1 = `unit-${randomUUID().slice(0, 8)}`;
    const u2 = `unit-${randomUUID().slice(0, 8)}`;
    const u3 = `unit-${randomUUID().slice(0, 8)}`;
    await seedListingSend(repo, { unitId: u1, contactId, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
    await seedListingSend(repo, { unitId: u2, contactId, sentAt: '2026-06-16T12:00:00.000Z', broadcastId: 'bcast-2' });
    await seedListingSend(repo, { unitId: u3, contactId, sentAt: '2026-06-16T11:00:00.000Z' });

    const sends = await repo.listByContact(contactId);
    expect(sends.map((s) => s.unitId)).toEqual([u2, u3, u1]); // newest-first
  });

  it('isolates rows by unit and contact', async () => {
    const unitA = `unit-${randomUUID().slice(0, 8)}`;
    const unitB = `unit-${randomUUID().slice(0, 8)}`;
    const c1 = `contact-${randomUUID().slice(0, 8)}`;
    const c2 = `contact-${randomUUID().slice(0, 8)}`;
    await seedListingSend(repo, { unitId: unitA, contactId: c1, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
    await seedListingSend(repo, { unitId: unitA, contactId: c2, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-1' });
    await seedListingSend(repo, { unitId: unitB, contactId: c1, sentAt: '2026-06-16T10:00:00.000Z', broadcastId: 'bcast-2' });

    const unitARecipients = await repo.listByUnit(unitA);
    const c1Sends = await repo.listByContact(c1);
    expect(unitARecipients).toHaveLength(2);
    expect(unitARecipients.every((r) => r.unitId === unitA)).toBe(true);
    expect(c1Sends).toHaveLength(2);
    expect(c1Sends.every((r) => r.contactId === c1)).toBe(true);
  });
});
