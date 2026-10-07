// repos/orgListRepo.ts against DynamoDB Local (spec 2026-10-06 D1, D2; plan
// 3.3): the ONE `org-list` item in the settings table - get() writes the
// starting list once under a create-only condition, peek() never creates,
// putForSeed() overwrites unconditionally. Task 2.2 adds mutate().
//
// Self-skipping like the other integration suites: with nothing answering at
// DYNAMODB_ENDPOINT the suites are skipped (`npm run db:start` runs them). The
// item is a SINGLETON, so every test starts by deleting it.
import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createOrgListRepo, ORG_LIST_SETTING_ID } from '../src/repos/orgListRepo.js';
import { ORG_T0, STEP_UP, orgListItem, quietLogger } from './helpers/orgFixtures.js';

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
    `[orgListRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

/** A throwaway settings table, emptied of the org-list item before every test. */
function useOrgListTable() {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = quietLogger();
  const table = tableName('settings', testEnv);
  const key = { settingId: ORG_LIST_SETTING_ID };

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('settings'), table);
  }, 120_000);
  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);
  beforeEach(async () => {
    await doc.send(new DeleteCommand({ TableName: table, Key: key }));
  });

  return {
    doc,
    table,
    /** A repo whose new ids are `<prefix>-1`, `<prefix>-2`, ... and whose clock is ORG_T0. */
    repo(prefix: string, withDoc: DynamoDBDocumentClient = doc) {
      let n = 0;
      return createOrgListRepo({
        doc: withDoc,
        env: testEnv,
        logger,
        now: () => ORG_T0,
        newId: () => `${prefix}-${(n += 1)}`,
      });
    },
    async raw(): Promise<Record<string, unknown> | undefined> {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      return Item;
    },
  };
}

describe.skipIf(!reachable)('orgListRepo get / peek / putForSeed against DynamoDB Local', () => {
  const store = useOrgListTable();

  it('get() on an empty store writes the starting list ONCE and returns it', async () => {
    const first = await store.repo('a').get();
    expect(first.settingId).toBe('org-list');
    expect(first.version).toBe(1);
    expect(first.entries.map((e) => e.name)).toEqual(STARTING_ORG_LIST.map((s) => s.name));
    expect(first.entries.map((e) => e.orgId)).toEqual(STARTING_ORG_LIST.map((_s, i) => `a-${i + 1}`));
    expect(first.entries.every((e) => e.createdBy === 'system' && e.createdAt === ORG_T0)).toBe(true);
    expect(first).not.toHaveProperty('lastRewrite');
    expect(await store.raw()).toMatchObject({ settingId: 'org-list', version: 1 });
    // Every later read returns the STORED item - never a fresh starting list.
    expect(await store.repo('b').get()).toEqual(first);
  });

  it('two first reads racing on an empty store agree on ONE stored list', async () => {
    const [a, b] = await Promise.all([store.repo('a').get(), store.repo('b').get()]);
    expect(a).toEqual(b);
    expect(await store.repo('c').get()).toEqual(a);
  });

  it('peek() never creates the item', async () => {
    const repo = store.repo('a');
    expect(await repo.peek()).toBeNull();
    expect(await store.raw()).toBeUndefined();
    const created = await repo.get();
    expect(await repo.peek()).toEqual(created);
  });

  it('putForSeed() overwrites unconditionally, whatever version is stored', async () => {
    const repo = store.repo('a');
    await repo.get();
    const seed = orgListItem([STEP_UP], { version: 0 });
    await repo.putForSeed(seed);
    expect(await repo.get()).toEqual(seed);
  });
});
