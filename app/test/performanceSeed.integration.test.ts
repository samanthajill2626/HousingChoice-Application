import { randomUUID } from 'node:crypto';
import { BatchWriteCommand, GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
      input: { contacts: 0, units: 0, placements: 0, tours: 0, conversations: 0, broadcasts: 0 },
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
});

describe.skipIf(!reachable)('performance seed against DynamoDB Local', () => {
  const laneA = 90_000 + Number.parseInt(randomUUID().slice(0, 4), 16);
  const laneB = laneA + 1;
  const prefixA = `hc-local-${laneA}-`;
  const prefixB = `hc-local-${laneB}-`;
  const configA = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'test-origin-secret', DYNAMODB_ENDPOINT: endpoint, TABLE_PREFIX: prefixA });
  const configB = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'test-origin-secret', DYNAMODB_ENDPOINT: endpoint, TABLE_PREFIX: prefixB });
  const nsA = createTableNamespace(configA);
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

  beforeAll(async () => {
    for (const spec of TABLES) {
      await ensureTable(client, spec, tableName(spec.baseName, nsA.env));
      await ensureTable(client, spec, tableName(spec.baseName, createTableNamespace(configB).env));
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
    expect((await readers.contacts.listByType('unknown', { limit: 20 })).items.length).toBeGreaterThan(0);
    expect((await readers.contacts.listByType('tenant', { deleted: true, limit: 20 })).items.length).toBeGreaterThan(0);

    expect(await readers.units.getById('perf-unit-00000')).toBeDefined();
    expect((await readers.units.list({ limit: 20 })).items.some((item) => item.unitId === 'perf-unit-00001')).toBe(true);
    expect((await readers.units.list({ deleted: true, limit: 20 })).items.length).toBeGreaterThan(0);
    expect((await readers.units.listByLandlord('perf-contact-00006')).items.length).toBeGreaterThan(0);
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
    expect(open.items).toHaveLength(500);
    expect(connecting.items).toHaveLength(500);
    expect(open.items.every((item) => item.relay_status === 'relay_group#open')).toBe(true);
    expect(connecting.items.every((item) => item.relay_status === 'relay_group#connecting')).toBe(true);
  }, 300_000);
});
