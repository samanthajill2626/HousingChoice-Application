// Real DynamoDB coverage for expression construction that the unit fake cannot
// validate. Self-skips when DynamoDB Local is unavailable.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createExtractionRepo } from '../src/repos/extractionRepo.js';
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
    `[extractionRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('extractionRepo against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createExtractionRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(
      client,
      getTableSpec('ai_extraction'),
      tableName('ai_extraction', testEnv),
    );
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('ai_extraction', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('conditionally deletes a revisioned suggestion without unused expression fields', async () => {
    const { item } = await repo.putSuggestion({
      ownerContactId: 'contact-1',
      target: 'pets',
      suggestedValue: 'two cats',
      conversationId: 'conversation-1',
      runId: 'run-1',
      createdAt: '2026-08-08T02:00:00.000Z',
    });

    await expect(repo.deleteSuggestionIfCurrent(
      item.ownerContactId,
      item.target,
      item.createdAt,
      item.runId,
      item.revision,
    )).resolves.toBe(true);
    await expect(repo.getSuggestion(item.ownerContactId, item.target)).resolves.toBeUndefined();
  });

  it('atomically suppresses a dismissed normalized value while allowing a different value', async () => {
    await repo.putDismissal('contact-dismissed', 'pets', 'two cats');

    await expect(repo.putSuggestion({
      ownerContactId: 'contact-dismissed',
      target: 'pets',
      suggestedValue: 'two cats',
      conversationId: 'conversation-1',
    })).rejects.toMatchObject({ name: 'SuggestionDismissedError' });

    await expect(repo.putSuggestion({
      ownerContactId: 'contact-dismissed',
      target: 'pets',
      suggestedValue: 'one dog',
      conversationId: 'conversation-2',
    })).resolves.toMatchObject({ item: { suggestedValue: 'one dog' } });
  });

  it('reports the exact displaced row after concurrent CAS writers contend', async () => {
    const base = await repo.putSuggestion({
      ownerContactId: 'contact-writers',
      target: 'pets',
      suggestedValue: 'base',
      conversationId: 'conversation-base',
    });
    const [left, right] = await Promise.all([
      repo.putSuggestion({
        ownerContactId: 'contact-writers',
        target: 'pets',
        suggestedValue: 'left',
        conversationId: 'conversation-left',
      }),
      repo.putSuggestion({
        ownerContactId: 'contact-writers',
        target: 'pets',
        suggestedValue: 'right',
        conversationId: 'conversation-right',
      }),
    ]);
    const live = await repo.getSuggestion('contact-writers', 'pets');
    const winner = live?.revision === left.item.revision ? left : right;
    const earlier = winner === left ? right : left;
    expect(winner.displaced?.revision).toBe(earlier.item.revision);
    expect(earlier.displaced?.revision).toBe(base.item.revision);
  });
});
