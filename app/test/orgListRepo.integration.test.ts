// repos/orgListRepo.ts against DynamoDB Local (spec 2026-10-06 D1, D2; plan
// 3.3): the ONE `org-list` item in the settings table - get() writes the
// starting list once under a create-only condition, peek() never creates,
// putForSeed() overwrites unconditionally. Task 2.2 adds mutate().
//
// Self-skipping like the other integration suites: with nothing answering at
// DYNAMODB_ENDPOINT the suites are skipped (`npm run db:start` runs them). The
// item is a SINGLETON, so every test starts by deleting it.
import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createOrgListRepo,
  ORG_LIST_MAX_BYTES,
  ORG_LIST_SETTING_ID,
  OrgListBusyError,
  OrgListFullError,
  type OrgListItem,
} from '../src/repos/orgListRepo.js';
import {
  ATLANTA,
  DCA,
  ORG_T0,
  STEP_UP,
  orgEntry,
  orgListItem,
  quietLogger,
  runningRewrite,
} from './helpers/orgFixtures.js';

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

/**
 * A doc client that lets a CONCURRENT writer commit first, `races.remaining`
 * times: just before each conditional org-list write it re-reads the item and
 * puts `competitor(item)` with version + 1, so the write it then forwards
 * loses its version condition exactly as it would in a real race.
 */
function racingDoc(
  real: DynamoDBDocumentClient,
  table: string,
  races: { remaining: number },
  competitor: (item: OrgListItem) => OrgListItem = (item) => item,
): DynamoDBDocumentClient {
  const send = real.send.bind(real) as unknown as (command: unknown) => Promise<unknown>;
  return {
    send: async (command: unknown) => {
      const versioned =
        command instanceof PutCommand && (command.input.ConditionExpression ?? '').includes('#version');
      if (versioned && races.remaining > 0) {
        races.remaining -= 1;
        const read = (await send(
          new GetCommand({ TableName: table, Key: { settingId: ORG_LIST_SETTING_ID }, ConsistentRead: true }),
        )) as { Item?: OrgListItem };
        if (read.Item !== undefined) {
          await send(
            new PutCommand({
              TableName: table,
              Item: { ...competitor(read.Item), version: read.Item.version + 1 },
            }),
          );
        }
      }
      return send(command);
    },
  } as unknown as DynamoDBDocumentClient;
}

const EXTRA = orgEntry({ orgId: 'org-extra', kind: 'agency', name: 'Extra Agency' });

describe.skipIf(!reachable)('orgListRepo.mutate - read-and-bump against DynamoDB Local', () => {
  const store = useOrgListTable();

  it('writes the change with version + 1 and returns the change result', async () => {
    const repo = store.repo('a');
    await repo.putForSeed(orgListItem([ATLANTA], { version: 4 }));
    const read = await repo.mutate((current) => ({
      next: { ...current, entries: [...current.entries, DCA] },
      result: current.version,
    }));
    expect(read).toBe(4);
    const stored = await repo.peek();
    expect(stored?.version).toBe(5);
    expect(stored?.entries.map((e) => e.orgId)).toEqual(['org-atl', 'org-dca']);
  });

  it('an absent item is created from the starting list first, then changed', async () => {
    const repo = store.repo('a');
    await repo.mutate((current) => ({ next: { ...current, entries: [...current.entries, EXTRA] }, result: null }));
    const stored = await repo.peek();
    expect(stored?.version).toBe(2);
    expect(stored?.entries).toHaveLength(STARTING_ORG_LIST.length + 1);
    expect(stored?.entries.at(-1)).toEqual(EXTRA);
  });

  it('a change that returns the item it was given writes nothing', async () => {
    const repo = store.repo('a');
    await repo.putForSeed(orgListItem([ATLANTA], { version: 7 }));
    expect(await repo.mutate((current) => ({ next: current, result: 'same' }))).toBe('same');
    expect((await repo.peek())?.version).toBe(7);
  });

  it('a domain error thrown by the change propagates and writes nothing', async () => {
    class Refused extends Error {}
    const repo = store.repo('a');
    await repo.putForSeed(orgListItem([ATLANTA], { version: 7 }));
    await expect(
      repo.mutate(() => {
        throw new Refused('no');
      }),
    ).rejects.toBeInstanceOf(Refused);
    expect((await repo.peek())?.version).toBe(7);
  });

  it('re-reads and re-applies the change after a lost version race', async () => {
    await store.repo('seed').putForSeed(orgListItem([ATLANTA], { version: 1 }));
    const races = { remaining: 1 };
    const repo = store.repo(
      'a',
      racingDoc(store.doc, store.table, races, (item) => ({ ...item, entries: [...item.entries, DCA] })),
    );
    let calls = 0;
    const read = await repo.mutate((current) => {
      calls += 1;
      return { next: { ...current, entries: [...current.entries, EXTRA] }, result: current.version };
    });
    expect(calls).toBe(2);
    expect(read).toBe(2);
    const stored = await store.repo('check').peek();
    expect(stored?.version).toBe(3);
    // The competitor's entry survives: the retry applied the change to a FRESH read.
    expect(stored?.entries.map((e) => e.orgId)).toEqual(['org-atl', 'org-dca', 'org-extra']);
  });

  it('gives up with OrgListBusyError after five lost races', async () => {
    await store.repo('seed').putForSeed(orgListItem([ATLANTA], { version: 1 }));
    const races = { remaining: 5 };
    const repo = store.repo('a', racingDoc(store.doc, store.table, races));
    let calls = 0;
    await expect(
      repo.mutate((current) => {
        calls += 1;
        return { next: { ...current, entries: [...current.entries, EXTRA] }, result: null };
      }),
    ).rejects.toBeInstanceOf(OrgListBusyError);
    expect(calls).toBe(5);
    const stored = await store.repo('check').peek();
    expect(stored?.version).toBe(6);
    expect(stored?.entries.map((e) => e.orgId)).toEqual(['org-atl']);
  });

  it('refuses a write past ORG_LIST_MAX_BYTES with OrgListFullError and writes nothing', async () => {
    const repo = store.repo('a');
    await repo.putForSeed(orgListItem([ATLANTA], { version: 1 }));
    await expect(
      repo.mutate((current) => ({
        next: { ...current, entries: [...current.entries, { ...EXTRA, notes: 'x'.repeat(ORG_LIST_MAX_BYTES) }] },
        result: null,
      })),
    ).rejects.toBeInstanceOf(OrgListFullError);
    expect((await repo.peek())?.version).toBe(1);
  });

  it('round-trips lastRewrite through a write', async () => {
    const repo = store.repo('a');
    await repo.putForSeed(orgListItem([ATLANTA]));
    const lastRewrite = runningRewrite({
      jobId: 'job-9',
      action: 'use',
      field: 'housingAuthority',
      fromTexts: ['AHA'],
      toName: ATLANTA.name,
    });
    await repo.mutate((current) => ({ next: { ...current, lastRewrite }, result: null }));
    expect((await repo.get()).lastRewrite).toEqual(lastRewrite);
  });
});
