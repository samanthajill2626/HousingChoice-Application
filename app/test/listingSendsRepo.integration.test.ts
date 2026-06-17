// BE4/C4 integration tests against DynamoDB Local — the listing-sends repo:
// recordSend creates a 'no_reply' row; a re-send refreshes sentAt but PRESERVES
// a previously-set response (the no-reset invariant); setResponse updates;
// listByUnit + listByContact both return the row (two query directions); a
// missing-row setResponse throws the conditional-check error (route → 404); rows
// are isolated per unit/contact.
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

  it('recordSend creates a no_reply row and stamps audit furniture', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    const row = await repo.recordSend({
      contactId,
      unitId,
      via: 'broadcast',
      broadcastId: 'bcast-1',
      sentAt: '2026-06-16T10:00:00.000Z',
    });
    expect(row.response).toBe('no_reply');
    expect(row.sentAt).toBe('2026-06-16T10:00:00.000Z');
    expect(row.via).toBe('broadcast');
    expect(row.broadcastId).toBe('bcast-1');
    expect(row.created_at).toBeDefined();
    expect(row.updated_at).toBeDefined();
  });

  it('re-send updates sentAt/via but PRESERVES a previously-set response (no reset)', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    await repo.recordSend({
      contactId,
      unitId,
      via: 'broadcast',
      broadcastId: 'bcast-1',
      sentAt: '2026-06-16T10:00:00.000Z',
    });
    await repo.setResponse(unitId, contactId, 'interested');

    const resent = await repo.recordSend({
      contactId,
      unitId,
      via: 'individual',
      sentAt: '2026-06-17T10:00:00.000Z',
    });
    expect(resent.response).toBe('interested'); // NOT reset to no_reply
    expect(resent.sentAt).toBe('2026-06-17T10:00:00.000Z');
    expect(resent.via).toBe('individual');
    // An individual re-send with no broadcastId clears the prior attribution.
    expect(resent.broadcastId).toBeUndefined();
  });

  it('setResponse updates the response and both query directions return the row', async () => {
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    await repo.recordSend({ contactId, unitId, via: 'broadcast' });
    await repo.setResponse(unitId, contactId, 'not_a_fit');

    const byUnit = await repo.listByUnit(unitId);
    const byContact = await repo.listByContact(contactId);
    expect(byUnit).toHaveLength(1);
    expect(byContact).toHaveLength(1);
    expect(byUnit[0]?.response).toBe('not_a_fit');
    expect(byContact[0]?.response).toBe('not_a_fit');
    expect(byUnit[0]?.unitId).toBe(unitId);
    expect(byContact[0]?.contactId).toBe(contactId);
  });

  it('setResponse on a missing row throws ConditionalCheckFailedException (route → 404)', async () => {
    await expect(
      repo.setResponse(`unit-${randomUUID().slice(0, 8)}`, `contact-${randomUUID().slice(0, 8)}`, 'interested'),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('listByContact returns a contact’s sends newest-first by sentAt', async () => {
    const contactId = `contact-${randomUUID().slice(0, 8)}`;
    const u1 = `unit-${randomUUID().slice(0, 8)}`;
    const u2 = `unit-${randomUUID().slice(0, 8)}`;
    const u3 = `unit-${randomUUID().slice(0, 8)}`;
    await repo.recordSend({ contactId, unitId: u1, via: 'broadcast', sentAt: '2026-06-16T10:00:00.000Z' });
    await repo.recordSend({ contactId, unitId: u2, via: 'broadcast', sentAt: '2026-06-16T12:00:00.000Z' });
    await repo.recordSend({ contactId, unitId: u3, via: 'individual', sentAt: '2026-06-16T11:00:00.000Z' });

    const sends = await repo.listByContact(contactId);
    expect(sends.map((s) => s.unitId)).toEqual([u2, u3, u1]); // newest-first
  });

  it('isolates rows by unit and contact', async () => {
    const unitA = `unit-${randomUUID().slice(0, 8)}`;
    const unitB = `unit-${randomUUID().slice(0, 8)}`;
    const c1 = `contact-${randomUUID().slice(0, 8)}`;
    const c2 = `contact-${randomUUID().slice(0, 8)}`;
    await repo.recordSend({ contactId: c1, unitId: unitA, via: 'broadcast' });
    await repo.recordSend({ contactId: c2, unitId: unitA, via: 'broadcast' });
    await repo.recordSend({ contactId: c1, unitId: unitB, via: 'broadcast' });

    const unitARecipients = await repo.listByUnit(unitA);
    const c1Sends = await repo.listByContact(c1);
    expect(unitARecipients).toHaveLength(2);
    expect(unitARecipients.every((r) => r.unitId === unitA)).toBe(true);
    expect(c1Sends).toHaveLength(2);
    expect(c1Sends.every((r) => r.contactId === c1)).toBe(true);
  });
});
