// Does the byUnread FAKE actually agree with DynamoDB?
//
// WHY THIS EXISTS. Almost everything on the unread path runs against
// `app/test/helpers/unreadIndexFake.ts`, an in-memory model of the sparse
// byUnread GSI, and nothing checked that the model matched the service. That is
// not a theoretical worry: the fake modelled `LastEvaluatedKey` WRONGLY until
// 2026-08-16 - it returned a key only when items remained - so every
// `queryUnreadPage` call-count assertion in the suite was calibrated one round
// trip short of production. The bug was in the fake, and the tests agreed with
// it.
//
// It matters more here than a fake normally would, because
// `app/src/lib/unreadFeed.ts` states as a design rule that "the unit tests
// assert on the NUMBER of queryUnreadPage CALLS". The cost model of the app's
// highest-frequency request is therefore pinned against a hand-written
// imitation of DynamoDB, and only this file can catch the imitation drifting.
//
// THE SHAPE. Every case below runs the SAME inputs through both the real repo
// (against DynamoDB Local) and the fake, and requires the same answer - rows,
// order, and the presence AND value of the pagination key. It never asserts
// what the answer should be, only that the two agree, so it cannot itself go
// stale when the semantics are revisited. Where the two must differ, that has
// to be written down here as an explicit exception; there are none today.
//
// This is the same remedy applied to `updateCallStatus` (pin the real one) and
// to the service-worker mirror (run both over one input table), and it is the
// last of the three sibling fake-fidelity issues.
//
// See docs/issues/unread-index-fake-can-still-drift.md.
import { randomUUID } from 'node:crypto';

import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';

import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import {
  createConversationsRepo,
  UNREAD_FLAG_VALUE,
  type ConversationItem,
  type ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { queryUnreadPageFromItems } from './helpers/unreadIndexFake.js';

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
  console.warn(`[unreadIndexFakeMirror] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

/** A row as the fixtures describe it, before it becomes a ConversationItem. */
interface Row {
  conversationId: string;
  last_activity_at: string;
  /** false means "read": no unread_flag, so the sparse index must not hold it. */
  unread: boolean;
}

/**
 * One page request, expressed the way a caller expresses it. `startFrom` names
 * a conversationId whose SYNTHESIZED key is used as the ExclusiveStartKey -
 * the repo contract explicitly allows resuming from any item the caller has
 * seen, not only from a LastEvaluatedKey, and that is a distinct code path.
 */
interface PageRequest {
  limit: number;
  startFrom?: string;
}

const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const logger = createLogger({ destination: createLogCapture().stream });

/** Tables minted by this file, dropped together in afterAll. */
const created: string[] = [];

/**
 * A table seeded with `rows`, plus the identical item list the fake will see.
 * Each world gets its own table so no case can disturb another's page
 * boundaries - the sparse-membership case below mutates its index.
 */
async function makeWorld(rows: Row[]): Promise<{
  repo: ConversationsRepo;
  items: ConversationItem[];
  table: string;
  markRead: (conversationId: string) => Promise<void>;
}> {
  const env = { TABLE_PREFIX: `hc-test-unreadmirror-${randomUUID().slice(0, 8)}-` };
  const table = tableName('conversations', env);
  await ensureTable(client, getTableSpec('conversations'), table);
  created.push(table);

  const items: ConversationItem[] = [];
  for (const row of rows) {
    const item = {
      conversationId: row.conversationId,
      last_activity_at: row.last_activity_at,
      status: 'open',
      type: 'tenant_1to1',
      unread_count: row.unread ? 1 : 0,
      ...(row.unread ? { unread_flag: UNREAD_FLAG_VALUE } : {}),
    } as unknown as ConversationItem;
    await doc.send(new PutCommand({ TableName: table, Item: item }));
    items.push(item);
  }

  return {
    repo: createConversationsRepo({ doc, env, logger }),
    items,
    table,
    /** REMOVE the flag exactly as resetUnread does - the row leaves the index. */
    async markRead(conversationId: string) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'REMOVE unread_flag SET unread_count = :zero',
          ExpressionAttributeValues: { ':zero': 0 },
        }),
      );
      const local = items.find((i) => i.conversationId === conversationId);
      if (local !== undefined) {
        delete (local as { unread_flag?: unknown }).unread_flag;
        (local as { unread_count?: number }).unread_count = 0;
      }
    },
  };
}

/** The synthesized full key for one seeded row, as a caller would build it. */
function keyFor(items: ConversationItem[], conversationId: string): Record<string, unknown> {
  const item = items.find((i) => i.conversationId === conversationId);
  if (item === undefined) throw new Error(`no seeded row ${conversationId}`);
  return {
    unread_flag: UNREAD_FLAG_VALUE,
    last_activity_at: item.last_activity_at,
    conversationId,
  };
}

/**
 * Run one page request through both implementations and require agreement.
 * Returns the shared answer so a caller can walk page by page.
 */
async function bothAgree(
  world: { repo: ConversationsRepo; items: ConversationItem[] },
  request: PageRequest,
  label: string,
): Promise<{ ids: string[]; lastEvaluatedKey?: Record<string, unknown> }> {
  const startKey =
    request.startFrom === undefined ? undefined : keyFor(world.items, request.startFrom);

  const real = await world.repo.queryUnreadPage({
    limit: request.limit,
    ...(startKey === undefined ? {} : { exclusiveStartKey: startKey }),
  });
  const fake = queryUnreadPageFromItems(world.items, {
    limit: request.limit,
    ...(startKey === undefined ? {} : { exclusiveStartKey: startKey }),
  });

  const realIds = real.items.map((i) => i.conversationId);
  const fakeIds = fake.items.map((i) => i.conversationId);
  expect(fakeIds, `${label}: rows and order`).toEqual(realIds);

  // Presence is asserted separately from value. "Did a key come back at all" is
  // what the call-count assertions actually depend on, and it is the half the
  // fake got wrong for four months.
  expect(
    fake.lastEvaluatedKey !== undefined,
    `${label}: a pagination key came back`,
  ).toBe(real.lastEvaluatedKey !== undefined);

  if (real.lastEvaluatedKey !== undefined) {
    // The real GSI key carries the index keys plus the table key. The fake
    // synthesizes the same triple; anything extra would make a resume drift.
    expect(fake.lastEvaluatedKey, `${label}: pagination key value`).toEqual(
      real.lastEvaluatedKey,
    );
  }

  return {
    ids: realIds,
    ...(real.lastEvaluatedKey === undefined ? {} : { lastEvaluatedKey: real.lastEvaluatedKey }),
  };
}

/** Walk the whole index one page at a time, comparing every round trip. */
async function walkTogether(
  world: { repo: ConversationsRepo; items: ConversationItem[] },
  limit: number,
  label: string,
): Promise<{ pages: string[][]; roundTrips: number }> {
  const pages: string[][] = [];
  let cursor: Record<string, unknown> | undefined;
  let roundTrips = 0;

  // Hard stop well above any fixture here: a fake that never stops handing back
  // a key must fail as a bad assertion, not as a hung suite.
  while (roundTrips < 20) {
    roundTrips += 1;
    const real = await world.repo.queryUnreadPage({
      limit,
      ...(cursor === undefined ? {} : { exclusiveStartKey: cursor }),
    });
    const fake = queryUnreadPageFromItems(world.items, {
      limit,
      ...(cursor === undefined ? {} : { exclusiveStartKey: cursor }),
    });

    const page = `${label} page ${roundTrips}`;
    expect(fake.items.map((i) => i.conversationId), `${page}: rows`).toEqual(
      real.items.map((i) => i.conversationId),
    );
    expect(fake.lastEvaluatedKey !== undefined, `${page}: key present`).toBe(
      real.lastEvaluatedKey !== undefined,
    );
    if (real.lastEvaluatedKey !== undefined) {
      expect(fake.lastEvaluatedKey, `${page}: key value`).toEqual(real.lastEvaluatedKey);
    }

    pages.push(real.items.map((i) => i.conversationId));
    if (real.lastEvaluatedKey === undefined) break;
    cursor = real.lastEvaluatedKey;
  }

  return { pages, roundTrips };
}

describe.skipIf(!reachable)('byUnread fake mirrors DynamoDB Local', () => {
  afterAll(async () => {
    for (const table of created) {
      await deleteTableIfExists(client, table);
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('agrees on an empty index', async () => {
    const world = await makeWorld([]);
    const page = await bothAgree(world, { limit: 10 }, 'empty');
    expect(page.ids).toEqual([]);
  }, 120_000);

  it('agrees on membership: only flagged rows are in the index', async () => {
    const world = await makeWorld([
      { conversationId: 'conv-a', last_activity_at: '2026-08-01T00:00:00.000Z', unread: true },
      { conversationId: 'conv-b', last_activity_at: '2026-08-02T00:00:00.000Z', unread: false },
      { conversationId: 'conv-c', last_activity_at: '2026-08-03T00:00:00.000Z', unread: true },
    ]);
    const page = await bothAgree(world, { limit: 10 }, 'membership');
    // Asserted here as well as compared, because "both returned nothing" would
    // satisfy agreement while proving the index is not being read at all.
    expect(page.ids).toEqual(['conv-c', 'conv-a']);
  }, 120_000);

  it('agrees on the MEMBERS of a tie group, but NOT on their order', async () => {
    // THE ONE PLACE THE TWO REALLY DIVERGE, measured 2026-08-23. The fake
    // documented its order as "(last_activity_at DESC, conversationId DESC) -
    // a TUPLE, because equal timestamps are ordinary and the trailing table key
    // is what breaks the tie", and called that the real index semantics. It is
    // not. DynamoDB Local returns rows sharing one last_activity_at in a stable
    // but OPAQUE order that is neither ascending nor descending by id:
    //
    //   inserted a,b,c,d,e,f  -> returned f,b,c,d,e,a
    //   inserted f,e,d,c,b,a  -> returned f,b,c,d,e,a
    //   inserted shuffled     -> returned f,b,c,d,e,a
    //
    // Identical across insertion orders and across freshly created tables, so
    // it is a deterministic function of the key VALUES - the shape of a hash of
    // the table partition key, which is how a GSI entry is physically ordered
    // when its sort key ties. Real DynamoDB does not document an order here
    // either, so the honest statement is that tie order is UNSPECIFIED and no
    // caller may depend on it.
    //
    // This test therefore compares MEMBERSHIP, which is specified, and asserts
    // separately that the orders differ - so if DynamoDB Local ever starts
    // agreeing with the fake, someone re-reads this instead of quietly
    // inheriting a stronger guarantee than the service gives.
    const tie = '2026-08-05T12:00:00.000Z';
    const rows = [
      { conversationId: 'conv-a', last_activity_at: tie, unread: true },
      { conversationId: 'conv-b', last_activity_at: tie, unread: true },
      { conversationId: 'conv-c', last_activity_at: tie, unread: true },
      { conversationId: 'conv-d', last_activity_at: '2026-08-04T00:00:00.000Z', unread: true },
    ];
    const world = await makeWorld(rows);

    const real = await world.repo.queryUnreadPage({ limit: 10 });
    const fake = queryUnreadPageFromItems(world.items, { limit: 10 });
    const realIds = real.items.map((i) => i.conversationId);
    const fakeIds = fake.items.map((i) => i.conversationId);

    expect([...fakeIds].sort(), 'same members').toEqual([...realIds].sort());
    // The row OUTSIDE the tie still sorts by timestamp in both - that half is
    // specified, and a fake that lost it would be broken rather than merely
    // arbitrary.
    expect(realIds[3]).toBe('conv-d');
    expect(fakeIds[3]).toBe('conv-d');
    // Pinned to these exact ids, whose opaque order is measured above.
    expect(realIds.slice(0, 3), 'DynamoDB order at the tie').toEqual([
      'conv-b',
      'conv-c',
      'conv-a',
    ]);
    expect(fakeIds.slice(0, 3), 'the fake orders ties by id DESC').toEqual([
      'conv-c',
      'conv-b',
      'conv-a',
    ]);
  }, 120_000);

  it('agrees at an EXACT multiple of the limit - the extra round trip is real', async () => {
    // Four unread rows, limit two: page 1 and page 2 are full, and page 2 still
    // hands back a key even though nothing remains. The caller only learns the
    // stream ended by asking a THIRD time. This is precisely the case the fake
    // modelled wrongly, and the reason call-count assertions were off by one.
    const world = await makeWorld([
      { conversationId: 'conv-a', last_activity_at: '2026-08-01T00:00:00.000Z', unread: true },
      { conversationId: 'conv-b', last_activity_at: '2026-08-02T00:00:00.000Z', unread: true },
      { conversationId: 'conv-c', last_activity_at: '2026-08-03T00:00:00.000Z', unread: true },
      { conversationId: 'conv-d', last_activity_at: '2026-08-04T00:00:00.000Z', unread: true },
    ]);

    const walk = await walkTogether(world, 2, 'exact-multiple');
    expect(walk.pages).toEqual([['conv-d', 'conv-c'], ['conv-b', 'conv-a'], []]);
    expect(walk.roundTrips).toBe(3);
  }, 120_000);

  it('agrees page by page on a walk that does not divide evenly', async () => {
    // FIVE unread rows over a limit of two: the last page is SHORT, so it
    // carries no key and the walk really does end in three round trips. (An
    // earlier draft of this test seeded four unread rows and called it uneven,
    // which is the exact-multiple case above wearing a different name.)
    const world = await makeWorld([
      { conversationId: 'conv-a', last_activity_at: '2026-08-01T00:00:00.000Z', unread: true },
      { conversationId: 'conv-b', last_activity_at: '2026-08-02T00:00:00.000Z', unread: true },
      { conversationId: 'conv-c', last_activity_at: '2026-08-03T00:00:00.000Z', unread: true },
      { conversationId: 'conv-d', last_activity_at: '2026-08-04T00:00:00.000Z', unread: true },
      { conversationId: 'conv-e', last_activity_at: '2026-08-05T00:00:00.000Z', unread: true },
      { conversationId: 'conv-f', last_activity_at: '2026-08-06T00:00:00.000Z', unread: false },
    ]);

    const walk = await walkTogether(world, 2, 'uneven');
    expect(walk.pages).toEqual([['conv-e', 'conv-d'], ['conv-c', 'conv-b'], ['conv-a']]);
    expect(walk.roundTrips).toBe(3);
  }, 120_000);

  it('agrees when resuming from an item the caller has seen, not a LastEvaluatedKey', async () => {
    // `iterateUnreadConversations` really does this: an Unread-page cursor
    // arrives as a scan POSITION and becomes an ExclusiveStartKey
    // (app/src/lib/unreadFeed.ts:337), so this path is production, not a
    // hypothetical the repo contract merely permits.
    //
    // No tie here. Resuming INTO a tie group is the one case where the two
    // disagree - see the tie test above and
    // docs/issues/unread-index-fake-tie-order-is-not-the-services.md.
    const world = await makeWorld([
      { conversationId: 'conv-a', last_activity_at: '2026-08-01T00:00:00.000Z', unread: true },
      { conversationId: 'conv-b', last_activity_at: '2026-08-02T00:00:00.000Z', unread: true },
      { conversationId: 'conv-c', last_activity_at: '2026-08-03T00:00:00.000Z', unread: true },
      { conversationId: 'conv-d', last_activity_at: '2026-08-04T00:00:00.000Z', unread: true },
    ]);

    const page = await bothAgree(world, { limit: 10, startFrom: 'conv-c' }, 'resume-from-seen');
    expect(page.ids).toEqual(['conv-b', 'conv-a']);
  }, 120_000);

  it('agrees when the start key sits past the end of the index', async () => {
    const world = await makeWorld([
      { conversationId: 'conv-a', last_activity_at: '2026-08-01T00:00:00.000Z', unread: true },
      { conversationId: 'conv-b', last_activity_at: '2026-08-02T00:00:00.000Z', unread: true },
    ]);
    const page = await bothAgree(world, { limit: 10, startFrom: 'conv-a' }, 'past-the-end');
    expect(page.ids).toEqual([]);
  }, 120_000);

  it('agrees that REMOVEing unread_flag takes the row out of the sparse index', async () => {
    const world = await makeWorld([
      { conversationId: 'conv-a', last_activity_at: '2026-08-01T00:00:00.000Z', unread: true },
      { conversationId: 'conv-b', last_activity_at: '2026-08-02T00:00:00.000Z', unread: true },
    ]);
    const before = await bothAgree(world, { limit: 10 }, 'sparse-before');
    expect(before.ids).toEqual(['conv-b', 'conv-a']);

    await world.markRead('conv-b');

    const after = await bothAgree(world, { limit: 10 }, 'sparse-after');
    expect(after.ids).toEqual(['conv-a']);
  }, 120_000);
});
