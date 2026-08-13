import { randomUUID } from 'node:crypto';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { TABLES } from '../src/lib/tables.js';
import {
  createPerformanceSeedReaders,
  createTableNamespace,
  resetPerformanceData,
  writePerformanceSeed,
} from '../src/lib/performanceSeed.js';
import { generatePerformanceSeed, resolvePerformanceSeedConfig } from '../src/lib/seed/performance.js';
import { SEED } from '../src/lib/seed/lean.js';
import { aggregateInbox } from '../src/routes/inbox.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const reachable = await (async () => {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
})();
if (!reachable) {
  if (process.env.PERF_SEED_REQUIRE_DYNAMO === '1') throw new Error('dynamodb_local_required');
  console.warn('performance_seed_integration_skipped_dynamodb_unavailable');
}

describe('performance seed destructive boundary', () => {
  const anchor = '2026-08-11T12:00:00.000Z';

  it.each([
    [undefined, 'hc-local-9-'],
    ['https://dynamodb.us-east-1.amazonaws.com', 'hc-local-9-'],
    ['http://localhost:8000', 'hc-local-'],
    ['http://localhost:8000', 'hc-local-0-'],
    ['http://localhost:8000', 'hc-dev-'],
  ])('rejects endpoint %s and prefix %s before reset', async (endpoint, tablePrefix) => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 'test-origin-secret',
      ...(endpoint !== undefined && { DYNAMODB_ENDPOINT: endpoint }),
      TABLE_PREFIX: tablePrefix,
    });
    const reset = vi.fn();
    await expect(resetPerformanceData({ config, input: {}, anchor, reset })).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
  });

  it('accepts an exact positive lane prefix and passes its namespace into reset', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 'test-origin-secret',
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
      TABLE_PREFIX: 'hc-local-99991-',
    });
    const reset = vi.fn().mockResolvedValue(undefined);
    const doc = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    await resetPerformanceData({
      config,
      input: { contacts: 0, units: 0, placements: 0, tours: 0, conversations: 0, nativeGroups: 0, broadcasts: 0 },
      anchor,
      reset,
      doc,
    });
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'lean',
      namespace: expect.objectContaining({ tablePrefix: 'hc-local-99991-' }),
    }));
  });

  it('writes at most 25 items and retries only unprocessed requests', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 'test-origin-secret',
      DYNAMODB_ENDPOINT: 'http://localhost:8000',
      TABLE_PREFIX: 'hc-local-99992-',
    });
    const namespace = createTableNamespace(config);
    const resolved = resolvePerformanceSeedConfig({
      contacts: 26,
      units: 0,
      placements: 0,
      tours: 0,
      conversations: 0,
      broadcasts: 0,
    }, anchor);
    const generated = generatePerformanceSeed(resolved);
    const send = vi.fn()
      .mockResolvedValueOnce({
        UnprocessedItems: {
          [namespace.tableNameFor('contacts')]: [{ PutRequest: { Item: generated.tables.contacts[0] } }],
        },
      })
      .mockResolvedValue({});
    const sleep = vi.fn().mockResolvedValue(undefined);
    const written = await writePerformanceSeed({
      config,
      namespace,
      tables: generated.tables,
      doc: { send } as unknown as DynamoDBDocumentClient,
      sleep,
    });
    const batchSizes = send.mock.calls.map(([command]) =>
      Object.values((command as BatchWriteCommand).input.RequestItems ?? {}).flat().length,
    );
    expect(batchSizes.every((size) => size <= 25)).toBe(true);
    expect(batchSizes).toContain(1);
    expect(written).toBe(generated.manifest.physicalItemCount);
    expect(sleep).toHaveBeenCalled();
  });

  it('rejects missing reader config rather than falling back to ambient env', () => {
    expect(() => createPerformanceSeedReaders({
      doc: {} as DynamoDBDocumentClient,
      config: undefined as never,
    })).toThrow();
  });

  it('queries paginated lean messages and addresses only the injected lane during cleanup', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: 'test-origin-secret',
      DYNAMODB_ENDPOINT: 'http://localhost:8000',
      TABLE_PREFIX: 'hc-local-99993-',
    });
    const namespace = createTableNamespace(config);
    const leanNativeConversation = SEED.conversations.find((conversation) => conversation.type === 'group_text');
    if (!leanNativeConversation) throw new Error('lean_native_group_missing');
    const firstPageKey = { conversationId: leanNativeConversation.conversationId, tsMsgId: 'first' };
    let queryCount = 0;
    const send = vi.fn(async (command: QueryCommand | BatchWriteCommand | DeleteCommand) => {
      if (command instanceof QueryCommand) {
        queryCount += 1;
        expect(command.input.TableName).toBe(namespace.tableNameFor('messages'));
        expect(command.input.ExpressionAttributeValues).toEqual({ ':conversationId': leanNativeConversation.conversationId });
        if (queryCount === 2) {
          expect(command.input.ExclusiveStartKey).toEqual(firstPageKey);
        }
        return queryCount === 1
          ? { Items: [{ tsMsgId: 'first' }], LastEvaluatedKey: firstPageKey }
          : { Items: [{ tsMsgId: 'second' }] };
      }
      if (command instanceof DeleteCommand) {
        expect(command.input).toEqual({
          TableName: namespace.tableNameFor('conversations'),
          Key: { conversationId: leanNativeConversation.conversationId },
        });
      }
      return {};
    });

    await resetPerformanceData({
      config,
      input: { contacts: 0, units: 0, placements: 0, tours: 0, conversations: 0, nativeGroups: 0, broadcasts: 0 },
      anchor,
      reset: vi.fn().mockResolvedValue(undefined),
      doc: { send } as unknown as DynamoDBDocumentClient,
    });

    expect(queryCount).toBe(2);
    const batchDeleteKeys = send.mock.calls.flatMap(([command]) => {
      if (!(command instanceof BatchWriteCommand)) return [];
      const requestItems = command.input.RequestItems ?? {};
      const messageDeletes = requestItems[namespace.tableNameFor('messages')] ?? [];
      if (messageDeletes.length === 0) return [];
      expect(Object.keys(requestItems)).toEqual([namespace.tableNameFor('messages')]);
      return messageDeletes;
    }).map((request) => request.DeleteRequest?.Key);
    expect(batchDeleteKeys).toEqual([
      { conversationId: leanNativeConversation.conversationId, tsMsgId: 'first' },
      { conversationId: leanNativeConversation.conversationId, tsMsgId: 'second' },
    ]);
    const addressedTables = send.mock.calls.flatMap(([command]) => {
      const input = (command as QueryCommand | BatchWriteCommand | DeleteCommand).input as {
        TableName?: string;
        RequestItems?: Record<string, unknown>;
      };
      return [
        ...(input.TableName === undefined ? [] : [input.TableName]),
        ...Object.keys(input.RequestItems ?? {}),
      ];
    });
    expect(addressedTables).not.toContain('conversations');
    expect(addressedTables).not.toContain('messages');
    expect(addressedTables.every((table) => table.startsWith(config.tablePrefix))).toBe(true);
  });
});

describe.skipIf(!reachable)('performance seed against DynamoDB Local', () => {
  const laneA = 90_000 + Number.parseInt(randomUUID().slice(0, 4), 16);
  const laneB = laneA + 1;
  const prefixA = `hc-local-${laneA}-`;
  const prefixB = `hc-local-${laneB}-`;
  const configA = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'test-origin-secret', DYNAMODB_ENDPOINT: endpoint, TABLE_PREFIX: prefixA });
  const configB = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'test-origin-secret', DYNAMODB_ENDPOINT: endpoint, TABLE_PREFIX: prefixB });
  const nsA = createTableNamespace(configA);
  const nsB = createTableNamespace(configB);
  const doc = createDocumentClient({ config: configB });
  const client = createDynamoClient({ config: configB });
  const readers = (() => {
    const ambientPrefix = process.env.TABLE_PREFIX;
    process.env.TABLE_PREFIX = 'hc-local-performance-reader-ambient-trap-';
    try {
      return createPerformanceSeedReaders({ doc, config: configB });
    } finally {
      if (ambientPrefix === undefined) delete process.env.TABLE_PREFIX;
      else process.env.TABLE_PREFIX = ambientPrefix;
    }
  })();
  const anchor = '2026-08-11T12:00:00.000Z';
  const input = { contacts: 22, units: 3, placements: 4, tours: 4, conversations: 5, messagesPerConversation: 2, broadcasts: 2, recipientsPerBroadcast: 3 };
  const leanNativeConversation = SEED.conversations.find((conversation) => conversation.type === 'group_text');
  const leanNativeConversationId = leanNativeConversation?.conversationId;
  if (typeof leanNativeConversationId !== 'string') throw new Error('lean_native_group_missing');

  beforeAll(async () => {
    for (const spec of TABLES) {
      await ensureTable(client, spec, tableName(spec.baseName, nsA.env));
      await ensureTable(client, spec, tableName(spec.baseName, nsB.env));
    }
    await doc.send(new PutCommand({
      TableName: nsA.tableNameFor('contacts'),
      Item: { contactId: 'sentinel-a', type: 'tenant', status: 'searching', phone: '+15559999999' },
    }));
  }, 120_000);

  afterAll(async () => {
    for (const spec of TABLES) {
      await deleteTableIfExists(client, `${prefixA}${spec.baseName}`);
      await deleteTableIfExists(client, `${prefixB}${spec.baseName}`);
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('keeps all injected route readers on the supplied namespace and reseeds deterministically', async () => {
    const manifest = await resetPerformanceData({ config: configB, input, anchor });
    expect(manifest.contacts).toBe(22);

    const firstContactPage = await readers.contacts.listByType('tenant', { limit: 2 });
    expect(firstContactPage.items).toHaveLength(2);
    expect(firstContactPage.lastEvaluatedKey).toBeDefined();
    const secondContactPage = await readers.contacts.listByType('tenant', {
      limit: 2,
      exclusiveStartKey: firstContactPage.lastEvaluatedKey,
    });
    expect(secondContactPage.items.length).toBeGreaterThan(0);
    expect(secondContactPage.items.map((item) => item.contactId)).not.toEqual(
      firstContactPage.items.map((item) => item.contactId),
    );
    expect(await readers.contacts.getById('perf-contact-00001')).toBeDefined();
    expect((await readers.contacts.listByType('landlord', { limit: 20 })).items.length).toBeGreaterThan(0);
    expect((await readers.contacts.listByType('unknown', { limit: 20 })).items).toEqual([]);
    expect((await readers.contacts.listByType('tenant', { deleted: true, limit: 20 })).items.length).toBeGreaterThan(0);

    expect(await readers.units.getById('perf-unit-00000')).toBeDefined();
    expect((await readers.units.list({ limit: 20 })).items.some((item) => item.unitId === 'perf-unit-00001')).toBe(true);
    expect((await readers.units.list({ deleted: true, limit: 20 })).items.length).toBeGreaterThan(0);
    const landlords = await readers.contacts.listByType('landlord', { limit: 20 });
    expect((await readers.units.listByLandlord(landlords.items[0]!.contactId)).items.length).toBeGreaterThan(0);
    expect((await readers.units.listByStatus('available')).items.length).toBeGreaterThan(0);

    expect(await readers.placements.getById('perf-placement-00000')).toBeDefined();
    expect((await readers.placements.list({ limit: 20 })).items.some((item) => item.placementId === 'perf-placement-00001')).toBe(true);
    expect((await readers.placements.listByTenant('perf-contact-00001')).items.length).toBeGreaterThan(0);
    expect((await readers.placements.listByUnit('perf-unit-00000')).items.length).toBeGreaterThan(0);
    expect((await readers.placements.listByStage('send_application')).items.length).toBeGreaterThan(0);

    expect(await readers.tours.get('perf-tour-00000')).toBeDefined();
    expect((await readers.tours.listByTenant('perf-contact-00001')).length).toBeGreaterThan(0);
    expect((await readers.tours.listByUnit('perf-unit-00000')).length).toBeGreaterThan(0);
    expect((await readers.tours.listByScheduledRange(anchor, '2026-09-11T12:00:00.000Z')).length).toBeGreaterThan(0);
    expect((await readers.tours.listByStatus('requested')).length).toBeGreaterThan(0);

    expect(await readers.conversations.getById('perf-conversation-00000')).toBeDefined();
    expect((await readers.conversations.listByLastActivity({ status: 'open', limit: 20 })).items.length).toBeGreaterThan(0);
    expect(await readers.conversations.listRelayGroups('open')).toMatchObject({ truncated: false });
    expect(await readers.messages.listByConversation('perf-conversation-00000')).toHaveLength(2);

    expect(await readers.broadcasts.getById('perf-broadcast-00000')).toBeDefined();
    expect((await readers.broadcasts.list({ limit: 20 })).items.some((item) => item.broadcastId === 'perf-broadcast-00000')).toBe(true);

    const unmatched = await readers.unmatchedEmail.listByStatus('unmatched');
    expect(unmatched.items).toHaveLength(2);
    expect(await readers.unmatchedEmail.getById(unmatched.items[0]!.unmatchedId)).toBeDefined();

    expect((await readers.users.listAll()).some((user) => user.userId === 'user-0001')).toBe(true);
    expect(await readers.settings.getOrgSettings()).toMatchObject({ quietHoursEnabled: false });
    expect(await readers.aiRuns.listByEntity('global')).toEqual({ entries: [] });
    expect(await readers.poolNumbers.listByState('active')).toEqual([]);
    expect(await readers.placementNudges.listByPlacement('perf-placement-00000')).toEqual([]);
    expect(await readers.placementDeadlines.listByPlacement('perf-placement-00000')).toEqual([]);
    expect(await readers.placementDeadlines.listDue('9999-12-31T23:59:59.999Z', { limit: 50 })).toEqual([]);
    expect(await readers.placementDeadlines.listAllPending({ limit: 50 })).toEqual([]);
    expect(await readers.tourReminders.listByTour('perf-tour-00000')).toEqual([]);
    expect(await readers.activityEvents.listByContact('perf-contact-00001')).toEqual({ items: [] });
    expect(await readers.listingSends.listByContact('perf-contact-00001')).toEqual([]);
    expect(await readers.listingSends.listByUnit('perf-unit-00000')).toEqual([]);
    expect(await readers.pendingRosterActions.listByOwner({ ownerType: 'tour', ownerId: 'perf-tour-00000' })).toEqual([]);
    expect(await readers.suggestionResolution.listJournals('perf-contact-00001')).toEqual([]);
    expect(await readers.audit.listByEntity('placements#perf-placement-00000')).toEqual([]);
    expect((await readers.audit.listByEntity('placements#placement-0001')).length).toBeGreaterThan(0);
    expect(await readers.contactVocabulary.get()).toEqual({
      roles: [],
      relationshipRoles: [],
      fieldLabels: [],
    });
    expect(await readers.extraction.listSuggestionsByContact('perf-contact-00001')).toEqual([]);
    expect(await readers.extraction.listPending({ limit: 50 })).toEqual([]);

    expect(await doc.send(new GetCommand({ TableName: nsA.tableNameFor('contacts'), Key: { contactId: 'sentinel-a' } }))).toHaveProperty('Item.contactId', 'sentinel-a');

    const physicalContacts = `${prefixB}contacts`;
    const ordered = (items: Record<string, unknown>[] | undefined) =>
      [...(items ?? [])].sort((a, b) => String(a['contactId']).localeCompare(String(b['contactId'])));
    const first = ordered((await doc.send(new ScanCommand({ TableName: physicalContacts }))).Items);
    await resetPerformanceData({ config: configB, input, anchor });
    const second = ordered((await doc.send(new ScanCommand({ TableName: physicalContacts }))).Items);
    expect(second).toEqual(first);
  }, 180_000);

  it('returns the full maximum generated relay-group share without truncation', async () => {
    const maximumRelayInput = {
      contacts: 0,
      units: 0,
      placements: 0,
      tours: 0,
      conversations: 5_000,
      nativeGroups: 0,
      messagesPerConversation: 0,
      broadcasts: 0,
      recipientsPerBroadcast: 0,
    };
    const manifest = await resetPerformanceData({ config: configB, input: maximumRelayInput, anchor });
    expect(manifest.relayGroupCount).toBe(1_000);

    const open = await readers.conversations.listRelayGroups('open');
    const connecting = await readers.conversations.listRelayGroups('connecting');
    expect(open).toMatchObject({ truncated: false });
    expect(connecting).toMatchObject({ truncated: false });
    // Count the GENERATED share only (this test's own subject), not the whole
    // partition. resetPerformanceData reseeds the LEAN profile first
    // (performanceSeed.ts), and lean carries one `connecting` relay_group as the
    // group-texting conversion fixture - so the raw partition legitimately holds
    // 501. Asserting the absolute count made this test a tripwire for anything
    // lean ever adds, which is not what "without truncation" is about; the
    // `truncated: false` assertions above are.
    const generated = (items: typeof open.items) =>
      items.filter((item) => item.conversationId.startsWith('perf-'));
    expect(generated(open.items)).toHaveLength(500);
    expect(generated(connecting.items)).toHaveLength(500);
    expect(open.items.every((item) => item.relay_status === 'relay_group#open')).toBe(true);
    expect(connecting.items.every((item) => item.relay_status === 'relay_group#connecting')).toBe(true);
  }, 300_000);

  it('replaces the lean native group with the exact generated group workload in its own lane', async () => {
    const defaultManifest = await resetPerformanceData({ config: configB, input: {}, anchor });
    const defaultGroups = await readers.conversations.listGroupTexts({ limit: 100 });
    expect(defaultManifest.nativeGroups).toBe(21);
    expect(defaultGroups.items).toHaveLength(defaultManifest.nativeGroups);
    expect(defaultGroups.items.map((item) => item.conversationId)).not.toContain(leanNativeConversationId);
    expect(defaultGroups.items.every((item) => item.status === 'group_open' && item.type === 'group_text')).toBe(true);
    expect(defaultGroups.items.map((item) => item.last_activity_at)).toEqual(
      [...defaultGroups.items].map((item) => item.last_activity_at).sort().reverse(),
    );

    const defaultInboxDeps = {
      conversationsRepo: readers.conversations,
      contactsRepo: readers.contacts,
      messagesRepo: readers.messages,
      placementsRepo: readers.placements,
    };
    const all = await aggregateInbox({ filter: 'all', limit: 100 }, defaultInboxDeps);
    const unread = await aggregateInbox({ filter: 'unread', limit: 100 }, defaultInboxDeps);
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 100 }, defaultInboxDeps);
    const groups = await aggregateInbox({ filter: 'groups', limit: 100 }, defaultInboxDeps);
    expect(all.rows.length).toBeGreaterThan(0);
    expect(unread.rows.length).toBeGreaterThan(0);
    expect(unknown.rows.length).toBeGreaterThan(0);
    expect(groups.rows).toHaveLength(defaultManifest.nativeGroups);
    expect(groups.rows.every((row) => row.kind === 'group_text')).toBe(true);

    const nonDefaultInput = {
      contacts: 10,
      units: 1,
      placements: 1,
      tours: 1,
      conversations: 5,
      nativeGroups: 4,
      messagesPerConversation: 2,
      longConversationMessages: 7,
      broadcasts: 2,
      recipientsPerBroadcast: 2,
      largeBroadcastRecipients: 5,
    };
    const nonDefaultManifest = await resetPerformanceData({ config: configB, input: nonDefaultInput, anchor });
    const nonDefaultGroups = await readers.conversations.listGroupTexts({ limit: 100 });
    expect(nonDefaultGroups.items).toHaveLength(nonDefaultManifest.nativeGroups);
    expect(await readers.messages.listByConversation('perf-conversation-00000', { limit: 20 }))
      .toHaveLength(nonDefaultManifest.resolvedLongConversationMessages);
    const largeBroadcast = await readers.broadcasts.getById('perf-broadcast-00000');
    expect(Object.keys(largeBroadcast?.recipients ?? {})).toHaveLength(
      nonDefaultManifest.resolvedLargeBroadcastRecipients,
    );

    const zeroManifest = await resetPerformanceData({
      config: configB,
      input: { contacts: 0, units: 0, placements: 0, tours: 0, conversations: 0, nativeGroups: 0, broadcasts: 0 },
      anchor,
    });
    expect(zeroManifest.nativeGroups).toBe(0);
    expect((await readers.conversations.listGroupTexts({ limit: 100 })).items).toEqual([]);
    expect(await readers.messages.listByConversation(leanNativeConversationId, { limit: 100 })).toEqual([]);
    const leanConversation = await doc.send(new GetCommand({
      TableName: nsB.tableNameFor('conversations'),
      Key: { conversationId: leanNativeConversationId },
    }));
    expect(leanConversation.Item).toBeUndefined();
  }, 300_000);
});
