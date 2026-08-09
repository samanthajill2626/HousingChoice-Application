import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createExtractionRepo, type SuggestionItem } from '../src/repos/extractionRepo.js';
import {
  createSuggestionResolutionRepo,
  resolutionItemId,
  tokenFor,
  type ClaimResolutionInput,
  type ResolutionReplayPlan,
} from '../src/repos/suggestionResolutionRepo.js';
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
  console.warn(`[suggestionResolutionRepo.integration] DynamoDB Local is required at ${endpoint}`);
}

describe.skipIf(!reachable)('suggestion resolution protocol against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-resolution-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const extraction = createExtractionRepo({ doc, env: testEnv, logger });
  const resolutions = createSuggestionResolutionRepo({ doc, env: testEnv, logger });
  const extractionTable = tableName('ai_extraction', testEnv);
  const contactsTable = tableName('contacts', testEnv);
  const auditTable = tableName('audit_events', testEnv);
  const activityTable = tableName('activity_events', testEnv);

  beforeAll(async () => {
    for (const base of ['ai_extraction', 'contacts', 'audit_events', 'activity_events'] as const) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const table of [activityTable, auditTable, contactsTable, extractionTable]) {
      await deleteTableIfExists(client, table);
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  const contactPlan = (value: string): ResolutionReplayPlan => ({
    kind: 'contact',
    patch: { pets: value },
    audit: { eventType: 'suggestion_accepted', payload: { target: 'pets' } },
  });

  async function putSuggestion(
    contactId: string,
    target = 'pets',
    value = 'two cats',
    over: Partial<Parameters<typeof extraction.putSuggestion>[0]> = {},
  ): Promise<SuggestionItem> {
    return (await extraction.putSuggestion({
      ownerContactId: contactId,
      target,
      suggestedValue: value,
      conversationId: `conversation-${contactId}`,
      createdAt: '2026-08-08T12:00:00.000Z',
      runId: `run-${contactId}`,
      ...over,
    })).item;
  }

  function claimInput(
    suggestion: SuggestionItem,
    over: Partial<ClaimResolutionInput> = {},
  ): ClaimResolutionInput {
    return {
      suggestion,
      action: 'accept',
      actorId: 'user-1',
      plan: contactPlan(suggestion.suggestedValue),
      now: '2026-08-08T12:01:00.000Z',
      leaseId: `lease-${suggestion.ownerContactId}`,
      leaseMs: 30_000,
      ...over,
    };
  }

  async function putContact(contactId: string, over: Record<string, unknown> = {}): Promise<void> {
    await doc.send(new PutCommand({
      TableName: contactsTable,
      Item: { contactId, type: 'tenant', status: 'onboarding', ...over },
    }));
  }

  it('gives exactly one winner for concurrent modern claims and hides the journal from both GSIs', async () => {
    const suggestion = await putSuggestion('claim-modern');
    const [a, b] = await Promise.all([
      resolutions.claim(claimInput(suggestion, { leaseId: 'lease-a' })),
      resolutions.claim(claimInput(suggestion, { leaseId: 'lease-b' })),
    ]);
    expect([a.status, b.status].sort()).toEqual(['blocked', 'claimed']);

    const byOwner = await doc.send(new QueryCommand({
      TableName: extractionTable,
      IndexName: 'byOwner',
      KeyConditionExpression: 'ownerContactId = :owner',
      ExpressionAttributeValues: { ':owner': 'claim-modern' },
    }));
    const byPending = await doc.send(new QueryCommand({
      TableName: extractionTable,
      IndexName: 'byPending',
      KeyConditionExpression: '#pendingPartition = :pending',
      ExpressionAttributeNames: { '#pendingPartition': '_pendingPartition' },
      ExpressionAttributeValues: { ':pending': 'pending' },
    }));
    expect(byOwner.Items).toEqual([]);
    expect((byPending.Items ?? []).some((item) => item['itemId'] === resolutionItemId('claim-modern', 'pets'))).toBe(false);
  });

  it('blocks a live lease, permits expired takeover, and rejects the stale fence domain effect', async () => {
    const contactId = 'takeover';
    await putContact(contactId);
    const suggestion = await putSuggestion(contactId);
    const claimed = await resolutions.claim(claimInput(suggestion, {
      leaseId: 'lease-old',
      leaseMs: 1_000,
    }));
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    const live = await resolutions.takeover({
      contactId,
      target: 'pets',
      now: '2026-08-08T12:01:00.500Z',
      leaseId: 'lease-too-soon',
    });
    expect(live.status).toBe('blocked');

    const takeover = await resolutions.takeover({
      contactId,
      target: 'pets',
      now: '2026-08-08T12:01:01.001Z',
      leaseId: 'lease-new',
    });
    expect(takeover.status).toBe('taken_over');
    if (takeover.status !== 'taken_over') throw new Error('takeover failed');
    expect(takeover.journal.fence).toBe(2);

    expect(await resolutions.commitContactEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('stale');
    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    expect(contact.Item?.['pets']).toBeUndefined();
  });

  it('claims modern revisions and legacy createdAt/runId identities exactly', async () => {
    const modern = await putSuggestion('modern-exact');
    expect((await resolutions.claim(claimInput({
      ...modern,
      revision: 'not-the-live-revision',
    }))).status).toBe('suggestion_replaced');
    expect((await extraction.getSuggestion('modern-exact', 'pets'))?.revision).toBe(modern.revision);
    expect((await resolutions.claim(claimInput(modern))).status).toBe('claimed');

    const contactId = 'legacy';
    const itemId = `sugg#${contactId}#pets`;
    const legacy: SuggestionItem = {
      itemId,
      ownerContactId: contactId,
      target: 'pets',
      suggestedValue: 'cat',
      conversationId: 'conversation-legacy',
      runId: 'run-legacy',
      createdAt: '2026-08-08T12:00:00.000Z',
      _pendingPartition: 'pending',
    };
    await doc.send(new PutCommand({ TableName: extractionTable, Item: legacy }));
    const wrong = await resolutions.claim(claimInput({ ...legacy, runId: 'run-other' }));
    expect(wrong.status).toBe('suggestion_replaced');
    expect((await extraction.getSuggestion(contactId, 'pets'))?.runId).toBe('run-legacy');
    const exact = await resolutions.claim(claimInput(legacy));
    expect(exact.status).toBe('claimed');
  });

  it('handles replacement-first, resolver-first/later pending, safe release, and completion replacement', async () => {
    const contactId = 'ordering';
    const old = await putSuggestion(contactId, 'pets', 'cat');
    const replacement = await putSuggestion(contactId, 'pets', 'dog', {
      createdAt: '2026-08-08T12:00:01.000Z',
      runId: 'run-new',
    });
    expect((await resolutions.claim(claimInput(old))).status).toBe('suggestion_replaced');
    expect((await extraction.getSuggestion(contactId, 'pets'))?.revision).toBe(replacement.revision);

    const claimed = await resolutions.claim(claimInput(replacement));
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    const later = await putSuggestion(contactId, 'pets', 'bird', {
      createdAt: '2026-08-08T12:00:02.000Z',
      runId: 'run-later',
    });
    expect(await resolutions.release({ token: tokenFor(claimed.journal), expectedPhase: 'claimed' })).toBe('unsafe');
    expect((await extraction.getSuggestion(contactId, 'pets'))?.revision).toBe(later.revision);

    await putContact(contactId);
    const token = tokenFor(claimed.journal);
    expect(await resolutions.commitContactEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' })).toBe('committed');
    expect(await resolutions.advancePhase({ token, expectedPhase: 'domain_applied', nextPhase: 'verdict_attempted' })).toBe('committed');
    expect(await resolutions.complete({ token, expectedPhase: 'verdict_attempted', completedAt: '2026-08-08T12:05:00.000Z' })).toBe('completed');
    const completed = await resolutions.get(contactId, 'pets');
    expect(completed?.state).toBe('completed');
    expect(JSON.stringify(completed)).not.toContain('cat');

    const nextClaim = await resolutions.claim(claimInput(later, { leaseId: 'lease-next' }));
    expect(nextClaim.status).toBe('claimed');
  });

  it('restores the original snapshot on a safe pre-mutation release', async () => {
    const suggestion = await putSuggestion('release-safe');
    const claimed = await resolutions.claim(claimInput(suggestion));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    expect(await resolutions.release({ token: tokenFor(claimed.journal), expectedPhase: 'claimed' })).toBe('released');
    expect((await extraction.getSuggestion('release-safe', 'pets'))?.revision).toBe(suggestion.revision);
    expect(await resolutions.get('release-safe', 'pets')).toBeUndefined();
  });

  it('commits contact plus deterministic audit plus phase atomically and recovers by phase', async () => {
    const contactId = 'contact-effect';
    await putContact(contactId);
    const suggestion = await putSuggestion(contactId);
    const claimed = await resolutions.claim(claimInput(suggestion));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    const phase = {
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed' as const,
      nextPhase: 'domain_applied' as const,
    };
    expect(await resolutions.commitContactEffect(phase)).toBe('committed');
    expect(await resolutions.commitContactEffect(phase)).toBe('already_committed');
    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    expect(contact.Item?.['pets']).toBe('two cats');
    const audit = await doc.send(new QueryCommand({
      TableName: auditTable,
      KeyConditionExpression: 'entityKey = :entity',
      ExpressionAttributeValues: { ':entity': `contacts#${contactId}` },
    }));
    expect(audit.Items).toHaveLength(1);
    expect((await resolutions.get(contactId, 'pets'))?.state).toBe('active');
  });

  it('classifies unknown claim and effect outcomes through consistent journal reads', async () => {
    const contactId = 'unknown-outcome';
    await putContact(contactId);
    const suggestion = await putSuggestion(contactId);
    let hideNextTransaction = true;
    const unknownDoc = {
      send: async (command: unknown) => {
        const result = await doc.send(command as never);
        if (hideNextTransaction && command instanceof TransactWriteCommand) {
          hideNextTransaction = false;
          throw new Error('connection dropped after commit');
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient;
    const unknownRepo = createSuggestionResolutionRepo({ doc: unknownDoc, env: testEnv, logger });

    const claimed = await unknownRepo.claim(claimInput(suggestion, { leaseId: 'lease-unknown' }));
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    hideNextTransaction = true;
    expect(await unknownRepo.commitContactEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('already_committed');
    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    expect(contact.Item?.['pets']).toBe('two cats');

    const unavailableDoc = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          throw new Error('connection dropped before send');
        }
        return doc.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;
    const unavailableRepo = createSuggestionResolutionRepo({
      doc: unavailableDoc,
      env: testEnv,
      logger,
    });
    await expect(unavailableRepo.advancePhase({
      token: tokenFor(claimed.journal),
      expectedPhase: 'domain_applied',
      nextPhase: 'verdict_attempted',
    })).rejects.toThrow('connection dropped before send');
    expect(await resolutions.get(contactId, 'pets')).toMatchObject({ phase: 'domain_applied' });
  });

  it('repairs a missing phone pointer and preserves a concurrent phone-list addition', async () => {
    const contactId = 'phone-repair';
    await putContact(contactId, {
      phone: '+14045550000',
      phones: [
        { phone: '+14045550000', primary: true },
        { phone: '+14045551111', primary: false, label: 'cell' },
      ],
    });
    const suggestion = await putSuggestion(contactId, 'phone', '+14045551111');
    const plan: ResolutionReplayPlan = {
      kind: 'phone',
      phone: '+14045551111',
      label: 'cell',
      audit: { eventType: 'suggestion_accepted', payload: { target: 'phone' } },
    };
    const claimed = await resolutions.claim(claimInput(suggestion, { plan }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    await doc.send(new PutCommand({
      TableName: contactsTable,
      Item: {
        ...(await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }))).Item,
        phones: [
          { phone: '+14045550000', primary: true },
          { phone: '+14045551111', primary: false, label: 'cell' },
          { phone: '+14045552222', primary: false },
        ],
      },
    }));
    expect(await resolutions.commitPhoneEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('committed');
    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    expect((contact.Item?.['phones'] as Array<{ phone: string }>).map((p) => p.phone).sort()).toEqual([
      '+14045550000', '+14045551111', '+14045552222',
    ]);
    const pointer = await doc.send(new GetCommand({
      TableName: contactsTable,
      Key: { contactId: 'phoneref#+14045551111' },
    }));
    expect(pointer.Item?.['phone_ref_owner']).toBe(contactId);
    const audit = await doc.send(new QueryCommand({
      TableName: auditTable,
      KeyConditionExpression: 'entityKey = :entity',
      ExpressionAttributeValues: { ':entity': `contacts#${contactId}` },
    }));
    expect(audit.Items).toHaveLength(1);
    expect((await resolutions.get(contactId, 'phone'))).toMatchObject({ phase: 'domain_applied' });
  });

  it('detects another contact phone pointer before mutation', async () => {
    const contactId = 'phone-conflict';
    await putContact(contactId, { phone: '+14045550000' });
    await doc.send(new PutCommand({
      TableName: contactsTable,
      Item: {
        contactId: 'phoneref#+14045553333',
        phone: '+14045553333',
        phone_ref: true,
        phone_ref_owner: 'somebody-else',
      },
    }));
    const suggestion = await putSuggestion(contactId, 'phone', '+14045553333');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'phone',
        phone: '+14045553333',
        audit: { eventType: 'suggestion_accepted' },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    expect(await resolutions.commitPhoneEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('phone_conflict');
    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    expect(JSON.stringify(contact.Item)).not.toContain('+14045553333');
  });

  it('makes activity deterministic and phase-idempotent', async () => {
    const contactId = 'activity';
    await putContact(contactId);
    const suggestion = await putSuggestion(contactId);
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'status',
        patch: { status: 'searching' },
        audit: { eventType: 'suggestion_accepted' },
        activity: { type: 'contact_status_changed', label: 'Status changed to Searching' },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    const token = tokenFor(claimed.journal);
    expect(await resolutions.commitContactEffect({ token, expectedPhase: 'claimed', nextPhase: 'domain_applied' })).toBe('committed');
    const activityPhase = { token, expectedPhase: 'domain_applied' as const, nextPhase: 'activity_recorded' as const };
    expect(await resolutions.commitActivityEffect(activityPhase)).toBe('committed');
    expect(await resolutions.commitActivityEffect(activityPhase)).toBe('already_committed');
    const items = await doc.send(new QueryCommand({
      TableName: activityTable,
      KeyConditionExpression: 'contactId = :contactId',
      ExpressionAttributeValues: { ':contactId': contactId },
    }));
    expect(items.Items).toHaveLength(1);
  });

  it('fences dismissal against both writer orderings and preserves a different value', async () => {
    const contactId = 'dismiss-order';
    const suggestion = await putSuggestion(contactId, 'pets', 'two cats');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      action: 'dismiss',
      plan: {
        kind: 'dismiss',
        normalizedValue: 'two cats',
        audit: { eventType: 'suggestion_dismissed', payload: { target: 'pets' } },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    const writer = await putSuggestion(contactId, 'pets', 'two cats', {
      createdAt: '2026-08-08T12:00:01.000Z',
      runId: 'writer-race',
    });
    expect((await extraction.getSuggestion(contactId, 'pets'))?.revision).toBe(writer.revision);
    expect(await resolutions.commitDismissalEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('committed');
    expect(await extraction.getSuggestion(contactId, 'pets')).toBeUndefined();

    const suppressed = putSuggestion(contactId, 'pets', 'two cats', {
      createdAt: '2026-08-08T12:00:02.000Z',
    });
    await expect(suppressed).rejects.toMatchObject({ name: 'SuggestionDismissedError' });

    const different = await putSuggestion(contactId, 'pets', 'one dog', {
      createdAt: '2026-08-08T12:00:03.000Z',
      runId: 'different',
    });
    expect((await extraction.getSuggestion(contactId, 'pets'))?.revision).toBe(different.revision);
  });

  it('retries dismissal when a same-value writer commits after its pending read', async () => {
    const contactId = 'dismiss-crossed';
    const suggestion = await putSuggestion(contactId, 'pets', 'two cats');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      action: 'dismiss',
      plan: {
        kind: 'dismiss',
        normalizedValue: 'two cats',
        audit: { eventType: 'suggestion_dismissed', payload: { target: 'pets' } },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    let releaseDismissal: (() => void) | undefined;
    let signalTransaction: (() => void) | undefined;
    const transactionReached = new Promise<void>((resolve) => {
      signalTransaction = resolve;
    });
    const dismissalMayContinue = new Promise<void>((resolve) => {
      releaseDismissal = resolve;
    });
    let paused = false;
    const crossedDoc = {
      send: async (command: unknown) => {
        if (!paused && command instanceof TransactWriteCommand) {
          paused = true;
          signalTransaction?.();
          await dismissalMayContinue;
        }
        return doc.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;
    const crossedRepo = createSuggestionResolutionRepo({ doc: crossedDoc, env: testEnv, logger });
    const dismissal = crossedRepo.commitDismissalEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    });
    await transactionReached;
    await putSuggestion(contactId, 'pets', 'two cats', {
      createdAt: '2026-08-08T12:00:04.000Z',
      runId: 'crossed-writer',
    });
    releaseDismissal?.();

    await expect(dismissal).resolves.toBe('committed');
    expect(await extraction.getSuggestion(contactId, 'pets')).toBeUndefined();
  });
});
