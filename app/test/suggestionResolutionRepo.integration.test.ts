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
import { createContactsRepo, type ContactPhone } from '../src/repos/contactsRepo.js';
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
    guard: { pets: { exists: false } },
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

  // F1: recovery has to find abandoned work WITHOUT the suggestion row that a
  // claim already deleted. The journal key set for one contact is closed (the
  // twelve DECISION_TARGETS), so one BatchGet enumerates it.
  it('enumerates a contact bounded journals from the twelve fixed keys', async () => {
    const contactId = 'enumerate';
    const finished = await putSuggestion(contactId, 'pets');
    const finishedClaim = await resolutions.claim(claimInput(finished));
    if (finishedClaim.status !== 'claimed') throw new Error('claim failed');
    const finishedToken = tokenFor(finishedClaim.journal);
    expect(await resolutions.advancePhase({
      token: finishedToken, expectedPhase: 'claimed', nextPhase: 'verdict_attempted',
    })).toBe('committed');
    expect(await resolutions.complete({
      token: finishedToken, expectedPhase: 'verdict_attempted', completedAt: '2026-08-08T12:05:00.000Z',
    })).toBe('completed');

    const live = await putSuggestion(contactId, 'phone', '+15550104040');
    expect((await resolutions.claim(claimInput(live, { leaseId: 'lease-phone' }))).status).toBe('claimed');

    const foreign = await putSuggestion('enumerate-other', 'pets');
    expect((await resolutions.claim(claimInput(foreign))).status).toBe('claimed');

    const journals = await resolutions.listJournals(contactId);
    expect(journals.map((journal) => journal.target).sort()).toEqual(['pets', 'phone']);
    // Only the still-active journal is recoverable work; the completed row is inert.
    expect(journals.filter((journal) => journal.state === 'active').map((journal) => journal.target))
      .toEqual(['phone']);
    expect(journals.find((journal) => journal.target === 'pets')?.state).toBe('completed');
    expect(await resolutions.listJournals('enumerate-empty')).toEqual([]);
  });

  // F8: the newer suggestion owns the pending slot, so the refused journal ends
  // in place. Anything that touched `sugg#` here would destroy live work.
  it('finalizes an unsafe-released journal terminally without touching the replacement row', async () => {
    const contactId = 'release-unsafe';
    const original = await putSuggestion(contactId, 'pets', 'two cats');
    const claimed = await resolutions.claim(claimInput(original));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    const replacement = await putSuggestion(contactId, 'pets', 'one dog', {
      createdAt: '2026-08-08T12:00:02.000Z',
      runId: 'run-replacement',
    });
    const token = tokenFor(claimed.journal);

    expect(await resolutions.release({ token, expectedPhase: 'claimed' })).toBe('unsafe');
    expect(await resolutions.complete({
      token,
      expectedPhase: 'claimed',
      completedAt: '2026-08-08T12:05:00.000Z',
      disposition: 'released_unsafe',
    })).toBe('completed');

    const journal = await doc.send(new GetCommand({
      TableName: extractionTable,
      Key: { itemId: resolutionItemId(contactId, 'pets') },
      ConsistentRead: true,
    }));
    expect(journal.Item).toEqual({
      itemId: resolutionItemId(contactId, 'pets'),
      state: 'completed',
      contactId,
      target: 'pets',
      identityKey: claimed.journal.identityKey,
      action: 'accept',
      completedAt: '2026-08-08T12:05:00.000Z',
      disposition: 'released_unsafe',
    });
    expect(JSON.stringify(journal.Item)).not.toContain('two cats');
    expect(JSON.stringify(journal.Item)).not.toContain('user-1');

    const pending = await doc.send(new GetCommand({
      TableName: extractionTable,
      Key: { itemId: `sugg#${contactId}#pets` },
      ConsistentRead: true,
    }));
    expect(pending.Item).toEqual(replacement);
    // And the replacement is claimable on its FIRST attempt - no deadlock.
    expect((await resolutions.claim(claimInput(replacement, { leaseId: 'lease-replacement' }))).status)
      .toBe('claimed');
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

  it('applies a matching contact guard once and keeps the accepted audit atomic', async () => {
    const contactId = 'contact-guard-match';
    await putContact(contactId, {
      pets: 'one dog',
      pets_source: { source: 'manual', at: '2026-08-08T11:00:00.000Z' },
    });
    const suggestion = await putSuggestion(contactId);
    const plan: ResolutionReplayPlan = {
      kind: 'contact',
      patch: {
        pets: 'two cats',
        pets_source: { source: 'ai', at: '2026-08-08T12:01:00.000Z' },
      },
      guard: {
        pets: { exists: true, value: 'one dog' },
        pets_source: { exists: true, value: { source: 'manual', at: '2026-08-08T11:00:00.000Z' } },
      },
      audit: { eventType: 'suggestion_accepted', payload: { target: 'pets' } },
    };
    const claimed = await resolutions.claim(claimInput(suggestion, { plan }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    const phase = {
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed' as const,
      nextPhase: 'domain_applied' as const,
    };

    expect(await resolutions.commitContactEffect(phase)).toBe('committed');
    expect(await resolutions.commitContactEffect(phase)).toBe('already_committed');

    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId }, ConsistentRead: true }));
    expect(contact.Item).toMatchObject({ pets: 'two cats', pets_source: { source: 'ai' } });
    const audit = await doc.send(new QueryCommand({
      TableName: auditTable,
      KeyConditionExpression: 'entityKey = :entity',
      ExpressionAttributeValues: { ':entity': `contacts#${contactId}` },
    }));
    expect(audit.Items).toHaveLength(1);
  });

  it('durably supersedes a mismatching contact guard without contact or audit mutation', async () => {
    const contactId = 'contact-guard-mismatch';
    await putContact(contactId, {
      pets: 'one dog',
      pets_source: { source: 'manual', at: '2026-08-08T11:00:00.000Z' },
    });
    const suggestion = await putSuggestion(contactId);
    const plan: ResolutionReplayPlan = {
      kind: 'contact',
      patch: {
        pets: 'two cats',
        pets_source: { source: 'ai', at: '2026-08-08T12:01:00.000Z' },
      },
      guard: {
        pets: { exists: true, value: 'one dog' },
        pets_source: { exists: true, value: { source: 'manual', at: '2026-08-08T11:00:00.000Z' } },
      },
      audit: { eventType: 'suggestion_accepted', payload: { target: 'pets' } },
    };
    const claimed = await resolutions.claim(claimInput(suggestion, { plan }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    await doc.send(new PutCommand({
      TableName: contactsTable,
      Item: {
        contactId,
        type: 'tenant',
        status: 'onboarding',
        pets: 'human edit',
      },
    }));

    expect(await resolutions.commitContactEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('superseded_by_human_edit');

    const contact = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId }, ConsistentRead: true }));
    expect(contact.Item?.['pets']).toBe('human edit');
    const audit = await doc.send(new QueryCommand({
      TableName: auditTable,
      KeyConditionExpression: 'entityKey = :entity',
      ExpressionAttributeValues: { ':entity': `contacts#${contactId}` },
    }));
    expect(audit.Items).toEqual([]);
    expect(await resolutions.get(contactId, 'pets')).toMatchObject({
      state: 'active', phase: 'domain_applied', outcome: 'superseded_by_human_edit',
    });
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

  // F6: commitPhoneEffect must mirror contactsRepo.addPhone. It used to
  // materialize phones[] through the READ serializer contactPhones(), which
  // carries no timestamps, and then PERSIST that array - permanently destroying
  // the primary number's firstSeenAt (created_at) and lastSeenAt.
  it('materializes the legacy phone scalar with its addPhone timestamps', async () => {
    const contactId = 'phone-seed';
    await putContact(contactId, { phone: '+14045550000', created_at: '2026-01-02T03:04:05.000Z' });
    const suggestion = await putSuggestion(contactId, 'phone', '+14045556666');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'phone',
        phone: '+14045556666',
        audit: { eventType: 'suggestion_accepted', payload: { target: 'phone' } },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    expect(await resolutions.commitPhoneEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('committed');
    const stored = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    const phones = stored.Item?.['phones'] as ContactPhone[];
    const primary = phones.find((entry) => entry.primary === true);
    expect(primary).toEqual({
      phone: '+14045550000',
      primary: true,
      firstSeenAt: '2026-01-02T03:04:05.000Z',
      // journal.claimedAt is the deterministic clock: a replay writes the same bytes.
      lastSeenAt: '2026-08-08T12:01:00.000Z',
    });
  });

  // F6: addPhone ALWAYS attaches a number as non-primary and never touches the
  // byPhone-indexed `phone` scalar. The pre-F6 code promoted a first number to
  // primary and wrote the scalar (setPhone semantics, not addPhone semantics).
  it('adds a first-ever number as non-primary and leaves the phone scalar untouched', async () => {
    const contactId = 'phone-first';
    await putContact(contactId, { created_at: '2026-02-03T04:05:06.000Z' });
    const suggestion = await putSuggestion(contactId, 'phone', '+14045557777');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'phone',
        phone: '+14045557777',
        label: 'cell',
        audit: { eventType: 'suggestion_accepted', payload: { target: 'phone' } },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    expect(await resolutions.commitPhoneEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('committed');
    const stored = await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }));
    expect(stored.Item?.['phone']).toBeUndefined();
    expect(stored.Item?.['phones']).toEqual([{
      phone: '+14045557777',
      primary: false,
      firstSeenAt: '2026-08-08T12:01:00.000Z',
      lastSeenAt: '2026-08-08T12:01:00.000Z',
      label: 'cell',
    }]);
    const pointer = await doc.send(new GetCommand({
      TableName: contactsTable,
      Key: { contactId: 'phoneref#+14045557777' },
    }));
    expect(pointer.Item?.['phone_ref_owner']).toBe(contactId);
  });

  // F6 parity: the same seeded contact, one number attached by the REAL
  // contactsRepo.addPhone and one by a phone-accept resolution, must persist the
  // same phones[] structure. Timestamps differ by clock source (addPhone uses
  // the wall clock, the journal uses claimedAt), so compare presence plus the
  // created_at-sourced value.
  it('persists the same phones[] structure as contactsRepo.addPhone', async () => {
    const contacts = createContactsRepo({ doc, env: testEnv, logger });
    const created = '2026-03-04T05:06:07.000Z';
    await putContact('parity-add', { phone: '+14045558000', created_at: created });
    await putContact('parity-accept', { phone: '+14045558000', created_at: created });

    await contacts.addPhone('parity-add', { phone: '+14045558111', label: 'cell' });

    const suggestion = await putSuggestion('parity-accept', 'phone', '+14045558222');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'phone',
        phone: '+14045558222',
        label: 'cell',
        audit: { eventType: 'suggestion_accepted', payload: { target: 'phone' } },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    expect(await resolutions.commitPhoneEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('committed');

    const load = async (contactId: string): Promise<Record<string, unknown>> => (
      (await doc.send(new GetCommand({ TableName: contactsTable, Key: { contactId } }))).Item ?? {}
    );
    const shape = (phones: ContactPhone[], added: string): unknown[] => phones.map((entry) => ({
      phone: entry.phone === added ? '<added>' : entry.phone,
      primary: entry.primary,
      label: entry.label,
      hasFirstSeenAt: typeof entry.firstSeenAt === 'string',
      hasLastSeenAt: typeof entry.lastSeenAt === 'string',
    }));
    const addedItem = await load('parity-add');
    const acceptedItem = await load('parity-accept');
    const addedPhones = addedItem['phones'] as ContactPhone[];
    const acceptedPhones = acceptedItem['phones'] as ContactPhone[];

    expect(shape(acceptedPhones, '+14045558222')).toEqual(shape(addedPhones, '+14045558111'));
    expect(addedPhones.find((entry) => entry.primary === true)?.firstSeenAt).toBe(created);
    expect(acceptedPhones.find((entry) => entry.primary === true)?.firstSeenAt).toBe(created);
    expect(addedItem['phone']).toBe('+14045558000');
    expect(acceptedItem['phone']).toBe('+14045558000');
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

  // CHARACTERIZATION of a REPORTED GAP, not an endorsement. The conflict check
  // reads the phoneref# pointer ONLY (suggestionResolutionRepo.ts:797-803), and
  // a contact's PRIMARY number deliberately has no pointer (repo:845-849), so a
  // number held as somebody else's primary is invisible here. The service's
  // findByPhone pre-check (suggestionResolution.ts:489-494) covers the ordinary
  // accept, but the expired-journal HELP path replays commitPhoneEffect without
  // it. Pinned so the fake can mirror a KNOWN behavior rather than a guess: when
  // the gap is closed this goes red and both sides get updated together.
  it('does NOT detect a number held as another contact primary (reported gap)', async () => {
    const contactId = 'phone-primary-gap';
    await putContact(contactId, { phone: '+14045550000' });
    await putContact('phone-primary-owner', { phone: '+14045554444' });
    const suggestion = await putSuggestion(contactId, 'phone', '+14045554444');
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'phone',
        phone: '+14045554444',
        audit: { eventType: 'suggestion_accepted' },
      },
    }));
    if (claimed.status !== 'claimed') throw new Error('claim failed');
    expect(await resolutions.commitPhoneEffect({
      token: tokenFor(claimed.journal),
      expectedPhase: 'claimed',
      nextPhase: 'domain_applied',
    })).toBe('committed');
    const pointer = await doc.send(new GetCommand({
      TableName: contactsTable,
      Key: { contactId: 'phoneref#+14045554444' },
      ConsistentRead: true,
    }));
    // The number now resolves to TWO owners: the other contact primary scalar
    // and this contact fresh pointer row.
    expect(pointer.Item).toMatchObject({ phone_ref_owner: contactId });
  });

  it('makes activity deterministic and phase-idempotent', async () => {
    const contactId = 'activity';
    await putContact(contactId);
    const suggestion = await putSuggestion(contactId);
    const claimed = await resolutions.claim(claimInput(suggestion, {
      plan: {
        kind: 'status',
        patch: { status: 'searching' },
        guard: { status: { exists: true, value: 'onboarding' } },
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
