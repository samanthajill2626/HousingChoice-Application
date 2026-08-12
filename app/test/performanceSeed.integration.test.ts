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
  const readers = createPerformanceSeedReaders({ doc, config: configB });
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

  it('isolates namespaces, resolves physical/index readers, and reseeds deterministically', async () => {
    const manifest = await resetPerformanceData({ config: configB, input, anchor });
    expect(manifest.contacts).toBe(22);
    expect((await readers.contacts.listByType('tenant', { limit: 2 })).items).toHaveLength(2);
    expect(await readers.units.getById('perf-unit-00000')).toBeDefined();
    expect(await readers.placements.getById('perf-placement-00000')).toBeDefined();
    expect(await readers.tours.get('perf-tour-00000')).toBeDefined();
    expect(await readers.conversations.getById('perf-conversation-00000')).toBeDefined();
    expect(await readers.messages.listByConversation('perf-conversation-00000')).toHaveLength(2);
    expect(await readers.broadcasts.getById('perf-broadcast-00000')).toBeDefined();
    expect((await readers.unmatchedEmail.listByStatus('unmatched')).items.length).toBeGreaterThan(0);
    expect(await readers.contactVocabulary.get()).toEqual(expect.any(Object));
    expect(await doc.send(new GetCommand({ TableName: nsA.tableNameFor('contacts'), Key: { contactId: 'sentinel-a' } }))).toHaveProperty('Item.contactId', 'sentinel-a');

    const physicalContacts = `${prefixB}contacts`;
    const ordered = (items: Record<string, unknown>[] | undefined) =>
      [...(items ?? [])].sort((a, b) => String(a['contactId']).localeCompare(String(b['contactId'])));
    const first = ordered((await doc.send(new ScanCommand({ TableName: physicalContacts }))).Items);
    await resetPerformanceData({ config: configB, input, anchor });
    const second = ordered((await doc.send(new ScanCommand({ TableName: physicalContacts }))).Items);
    expect(second).toEqual(first);
  }, 120_000);
});
