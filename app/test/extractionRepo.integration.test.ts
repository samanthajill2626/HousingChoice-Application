// Real DynamoDB coverage for expression construction that the unit fake cannot
// validate. Self-skips when DynamoDB Local is unavailable.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createExtractionRepo } from '../src/repos/extractionRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
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
  const contacts = createContactsRepo({ doc, env: testEnv, logger });

  beforeAll(async () => {
    await ensureTable(
      client,
      getTableSpec('ai_extraction'),
      tableName('ai_extraction', testEnv),
    );
    await ensureTable(client, getTableSpec('contacts'), tableName('contacts', testEnv));
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('ai_extraction', testEnv));
    await deleteTableIfExists(client, tableName('contacts', testEnv));
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

  it('deletes only the exact type suggestion at the expected contact revision', async () => {
    const absentRevision = await contacts.create({ type: 'unknown' });
    const absentSuggestion = await repo.putSuggestion({
      ownerContactId: absentRevision.contactId,
      target: 'type',
      suggestedValue: 'partner',
      conversationId: 'conv-absent',
      contactClassificationRevision: 0,
    });
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(
      absentSuggestion.item,
      0,
    )).resolves.toBe('deleted');

    const explicitZero = await contacts.create({ type: 'unknown' });
    await doc.send(new UpdateCommand({
      TableName: tableName('contacts', testEnv),
      Key: { contactId: explicitZero.contactId },
      UpdateExpression: 'SET classification_revision = :zero',
      ExpressionAttributeValues: { ':zero': 0 },
    }));
    const zeroSuggestion = await repo.putSuggestion({
      ownerContactId: explicitZero.contactId,
      target: 'type',
      suggestedValue: 'partner',
      conversationId: 'conv-zero',
      contactClassificationRevision: 0,
    });
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(
      zeroSuggestion.item,
      0,
    )).resolves.toBe('deleted');

    const replacedContact = await contacts.create({ type: 'unknown' });
    const oldSuggestion = await repo.putSuggestion({
      ownerContactId: replacedContact.contactId,
      target: 'type',
      suggestedValue: 'tenant',
      conversationId: 'conv-old',
      contactClassificationRevision: 0,
    });
    const replacement = await repo.putSuggestion({
      ownerContactId: replacedContact.contactId,
      target: 'type',
      suggestedValue: 'partner',
      conversationId: 'conv-new',
      contactClassificationRevision: 0,
    });
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(
      oldSuggestion.item,
      0,
    )).resolves.toBe('suggestion_changed_or_absent');
    expect((await repo.getSuggestion(replacedContact.contactId, 'type'))?.revision)
      .toBe(replacement.item.revision);

    const changedContact = await contacts.create({ type: 'unknown' });
    const changedSuggestion = await repo.putSuggestion({
      ownerContactId: changedContact.contactId,
      target: 'type',
      suggestedValue: 'partner',
      conversationId: 'conv-changed',
      contactClassificationRevision: 0,
    });
    await contacts.update(changedContact.contactId, { type: 'tenant' });
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(
      changedSuggestion.item,
      0,
    )).resolves.toBe('contact_revision_changed');
    expect((await repo.getSuggestion(changedContact.contactId, 'type'))?.revision)
      .toBe(changedSuggestion.item.revision);

    const laterRevision = await contacts.create({ type: 'unknown' });
    await contacts.update(laterRevision.contactId, { type: 'tenant' });
    const revisionOneSuggestion = await repo.putSuggestion({
      ownerContactId: laterRevision.contactId,
      target: 'type',
      suggestedValue: 'partner',
      conversationId: 'conv-revision-one',
      contactClassificationRevision: 1,
    });
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(
      revisionOneSuggestion.item,
      1,
    )).resolves.toBe('deleted');
  });

  it('executes exact legacy suggestion identities and later numeric contact fences', async () => {
    const putLegacyTypeSuggestion = async (
      contactId: string,
      createdAt: string,
      opts: { runId?: string; revision?: string } = {},
    ) => {
      await doc.send(new PutCommand({
        TableName: tableName('ai_extraction', testEnv),
        Item: {
          itemId: `sugg#${contactId}#type`,
          ownerContactId: contactId,
          target: 'type',
          suggestedValue: 'partner',
          conversationId: `conv-${contactId}`,
          _pendingPartition: 'pending',
          createdAt,
          ...(opts.runId !== undefined && { runId: opts.runId }),
          ...(opts.revision !== undefined && { revision: opts.revision }),
        },
      }));
      return (await repo.getSuggestion(contactId, 'type'))!;
    };

    const absentRunContact = await contacts.create({ type: 'unknown' });
    const absentRun = await putLegacyTypeSuggestion(
      absentRunContact.contactId,
      '2026-08-26T01:00:00.000Z',
    );
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(absentRun, 0))
      .resolves.toBe('deleted');

    const runMismatchContact = await contacts.create({ type: 'unknown' });
    const absentRunIdentity = await putLegacyTypeSuggestion(
      runMismatchContact.contactId,
      '2026-08-26T01:01:00.000Z',
    );
    await putLegacyTypeSuggestion(
      runMismatchContact.contactId,
      '2026-08-26T01:01:00.000Z',
      { runId: 'run-present' },
    );
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(absentRunIdentity, 0))
      .resolves.toBe('suggestion_changed_or_absent');
    expect((await repo.getSuggestion(runMismatchContact.contactId, 'type'))?.runId).toBe('run-present');

    const revisionedContact = await contacts.create({ type: 'unknown' });
    const legacyIdentity = await putLegacyTypeSuggestion(
      revisionedContact.contactId,
      '2026-08-26T01:02:00.000Z',
    );
    await putLegacyTypeSuggestion(
      revisionedContact.contactId,
      '2026-08-26T01:02:00.000Z',
      { revision: 'replacement-revision' },
    );
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(legacyIdentity, 0))
      .resolves.toBe('suggestion_changed_or_absent');
    expect((await repo.getSuggestion(revisionedContact.contactId, 'type'))?.revision)
      .toBe('replacement-revision');

    const laterRevisionContact = await contacts.create({ type: 'unknown' });
    await contacts.update(laterRevisionContact.contactId, { type: 'tenant' });
    const numericLegacyIdentity = await putLegacyTypeSuggestion(
      laterRevisionContact.contactId,
      '2026-08-26T01:03:00.000Z',
    );
    await contacts.update(laterRevisionContact.contactId, { role: null });
    await expect(repo.deleteTypeSuggestionIfCurrentAtContactRevision(numericLegacyIdentity, 1))
      .resolves.toBe('contact_revision_changed');
    expect((await repo.getSuggestion(laterRevisionContact.contactId, 'type'))?.createdAt)
      .toBe('2026-08-26T01:03:00.000Z');
  });
});
