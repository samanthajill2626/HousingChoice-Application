// Integration tests against DynamoDB Local for the sparse byUnread GSI (design
// 2026-08-16): the unread_flag invariant maintained by the two unread
// primitives, the relay-close reset, and the raw queryUnreadPage index read.
//
// The invariant under test: unread_flag exists on a conversation item IFF that
// row's unread_count is meant to be > 0. Because the flag is the index's HASH
// attribute, "flag absent" and "row not in byUnread" are the same statement -
// which is why every assertion here checks BOTH the item shape (via getById)
// and the index membership (via queryUnreadPage) rather than trusting one.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
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
    `[unreadIndexRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('byUnread index + unread_flag against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-unread-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);

  const bases = ['conversations'] as const;
  const table = tableName('conversations', testEnv);

  /** Raw item read - the ONLY way to prove an attribute is genuinely ABSENT. */
  async function rawItem(conversationId: string): Promise<Record<string, unknown>> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId } }));
    return (Item ?? {}) as Record<string, unknown>;
  }

  /** Every conversationId currently resident in the byUnread index. */
  async function unreadIds(limit = 50): Promise<string[]> {
    const { items } = await conversations.queryUnreadPage({ limit });
    return items.map((c) => c.conversationId);
  }

  let phoneSeq = 0;
  const nextPhone = (): string => `+1555${String(2_000_000 + ++phoneSeq).slice(0, 7)}`;

  beforeAll(async () => {
    for (const base of bases) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of bases) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('incrementUnread stamps unread_flag and every further increment re-stamps it', async () => {
    const conv = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    const fresh = await rawItem(conv.conversationId);
    expect('unread_flag' in fresh).toBe(false); // a new thread is not unread

    const first = await conversations.incrementUnread(conv.conversationId);
    expect(first).toBe(1);
    const afterOne = await rawItem(conv.conversationId);
    expect(afterOne['unread_count']).toBe(1);
    expect(afterOne['unread_flag']).toBe('unread');

    // No `=== 1` crossing detection: the second bump re-sets the same value.
    const second = await conversations.incrementUnread(conv.conversationId);
    expect(second).toBe(2);
    const afterTwo = await rawItem(conv.conversationId);
    expect(afterTwo['unread_count']).toBe(2);
    expect(afterTwo['unread_flag']).toBe('unread');
  });

  it('resetUnread zeroes the count and REMOVEs unread_flag (the attribute is absent, not empty)', async () => {
    const conv = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    await conversations.incrementUnread(conv.conversationId);
    expect(await unreadIds()).toContain(conv.conversationId);

    const reset = await conversations.resetUnread(conv.conversationId);
    expect(reset.unread_count).toBe(0);
    expect(reset.unread_flag).toBeUndefined();

    const raw = await rawItem(conv.conversationId);
    expect(raw['unread_count']).toBe(0); // count stays SET to 0 (wire shapes unchanged)
    expect('unread_flag' in raw).toBe(false);
    expect(await unreadIds()).not.toContain(conv.conversationId);
  });

  it('either ordering leaves flag iff count > 0 (reset-then-increment, increment-then-reset)', async () => {
    const a = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    await conversations.incrementUnread(a.conversationId);
    await conversations.resetUnread(a.conversationId);
    await conversations.incrementUnread(a.conversationId);
    const rawA = await rawItem(a.conversationId);
    expect(rawA['unread_count']).toBe(1);
    expect(rawA['unread_flag']).toBe('unread');
    expect(await unreadIds()).toContain(a.conversationId);

    const b = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    await conversations.incrementUnread(b.conversationId);
    await conversations.incrementUnread(b.conversationId);
    await conversations.resetUnread(b.conversationId);
    const rawB = await rawItem(b.conversationId);
    expect(rawB['unread_count']).toBe(0);
    expect('unread_flag' in rawB).toBe(false);
    expect(await unreadIds()).not.toContain(b.conversationId);
  });

  it('queryUnreadPage returns ONLY flagged rows, newest last_activity_at first, and drops a row on reset', async () => {
    const older = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    const newer = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    const read = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    await conversations.touchLastActivity(older.conversationId, undefined, '2026-08-16T10:00:00.000Z');
    await conversations.touchLastActivity(newer.conversationId, undefined, '2026-08-16T11:00:00.000Z');
    await conversations.touchLastActivity(read.conversationId, undefined, '2026-08-16T12:00:00.000Z');
    for (const c of [older, newer, read]) await conversations.incrementUnread(c.conversationId);

    // The read thread is the NEWEST, so if it were still indexed it would sort
    // first - its absence cannot be explained by the ordering.
    await conversations.resetUnread(read.conversationId);

    const { items } = await conversations.queryUnreadPage({ limit: 10 });
    const ids = items.map((c) => c.conversationId);
    expect(ids).not.toContain(read.conversationId);
    expect(ids.indexOf(newer.conversationId)).toBeLessThan(ids.indexOf(older.conversationId));
    expect(items.every((c) => c.unread_flag === 'unread')).toBe(true);
  });

  it('queryUnreadPage pages by Limit and resumes from the LastEvaluatedKey', async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const conv = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
      await conversations.touchLastActivity(
        conv.conversationId,
        undefined,
        `2026-08-15T0${i}:00:00.000Z`,
      );
      await conversations.incrementUnread(conv.conversationId);
      made.push(conv.conversationId);
    }
    const before = await unreadIds(100);

    const page1 = await conversations.queryUnreadPage({ limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.lastEvaluatedKey).toBeDefined();
    const page2 = await conversations.queryUnreadPage({
      limit: 1,
      ...(page1.lastEvaluatedKey !== undefined && { exclusiveStartKey: page1.lastEvaluatedKey }),
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.conversationId).not.toBe(page1.items[0]?.conversationId);
    // Paging walks the SAME newest-first order as a single big page.
    expect([page1.items[0]?.conversationId, page2.items[0]?.conversationId]).toEqual(
      before.slice(0, 2),
    );
    expect(made).toHaveLength(3);
  });

  it('a resume key built from item N lands on N+1 even when N and N+1 share last_activity_at', async () => {
    // The tie case the synthesized full key exists for: with equal RANGE values
    // only the trailing table key (conversationId) breaks the tie, so a
    // position-based cursor would either repeat or skip a row here.
    const sameTs = '2026-08-14T09:30:00.000Z';
    const twinA = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    const twinB = await conversations.createOrGetByParticipantPhone(nextPhone(), 'tenant_1to1');
    await conversations.touchLastActivity(twinA.conversationId, undefined, sameTs);
    await conversations.touchLastActivity(twinB.conversationId, undefined, sameTs);
    await conversations.incrementUnread(twinA.conversationId);
    await conversations.incrementUnread(twinB.conversationId);

    const all = await conversations.queryUnreadPage({ limit: 100 });
    const tied = all.items.filter((c) => c.last_activity_at === sameTs);
    expect(tied).toHaveLength(2);
    const [first, second] = tied;

    const resumed = await conversations.queryUnreadPage({
      limit: 100,
      exclusiveStartKey: {
        unread_flag: 'unread',
        last_activity_at: sameTs,
        conversationId: first?.conversationId,
      },
    });
    const resumedIds = resumed.items.map((c) => c.conversationId);
    expect(resumedIds).not.toContain(first?.conversationId);
    expect(resumedIds[0]).toBe(second?.conversationId);
  });

  it('setRelayStatus to closed zeroes unread + drops the flag; reopen does not resurrect it', async () => {
    const pool = `+1555044${Math.floor(Math.random() * 9000 + 1000)}`;
    const group = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: nextPhone(), name: 'A' }],
    });
    await conversations.incrementUnread(group.conversationId);
    await conversations.incrementUnread(group.conversationId);
    expect(await unreadIds()).toContain(group.conversationId);

    const closed = await conversations.setRelayStatus(group.conversationId, 'closed', 'open');
    expect(closed.status).toBe('closed');
    expect(closed.unread_count).toBe(0);
    const rawClosed = await rawItem(group.conversationId);
    expect('unread_flag' in rawClosed).toBe(false);
    expect(await unreadIds()).not.toContain(group.conversationId);

    // Reopen is the branch that must NOT carry the reset values (an unused
    // ExpressionAttributeValues entry is a hard ValidationException, so this
    // call failing at all is the regression signal).
    const reopened = await conversations.setRelayStatus(group.conversationId, 'open', 'closed');
    expect(reopened.status).toBe('open');
    expect(reopened.unread_count).toBe(0); // declared product change: no resurrection
    const rawReopened = await rawItem(group.conversationId);
    expect('unread_flag' in rawReopened).toBe(false);
    expect(await unreadIds()).not.toContain(group.conversationId);
  });

  it('reopen of a relay group that was never unread still succeeds (no unused expression value)', async () => {
    const pool = `+1555045${Math.floor(Math.random() * 9000 + 1000)}`;
    const group = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c2', phone: nextPhone(), name: 'B' }],
    });
    await conversations.setRelayStatus(group.conversationId, 'closed', 'open');
    const reopened = await conversations.setRelayStatus(group.conversationId, 'open', 'closed');
    expect(reopened.status).toBe('open');
    const raw = await rawItem(group.conversationId);
    expect('unread_flag' in raw).toBe(false);
  });

  it('pointer/claim partitions never enter byUnread (they carry no unread attributes)', async () => {
    const phone = nextPhone();
    const conv = await conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1');
    await conversations.incrementUnread(conv.conversationId);
    const ids = await unreadIds(100);
    expect(ids).toContain(conv.conversationId);
    expect(ids.some((id) => id.startsWith('phone#') || id.startsWith('email#'))).toBe(false);
  });
});
