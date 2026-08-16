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
import {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillUnreadFlag } from '../scripts/backfill-unread-flag.js';
import { ensureGsis } from '../scripts/db-update-gsis.js';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable, toCreateTableInput } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo, UNREAD_FLAG_VALUE } from '../src/repos/conversationsRepo.js';
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

// --- backfill:unread-flag round-trip ---------------------------------------
// The script's own tables, seeded with RAW legacy-shaped rows (whole-item Puts,
// exactly how a pre-migration table looks) so every one of the four rules runs
// against real DynamoDB rather than a fake. Its own throwaway prefix keeps its
// contacts/messages tables out of the suite above.
describe.skipIf(!reachable)('backfill:unread-flag against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-bfill-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });

  const bases = ['conversations', 'contacts', 'messages'] as const;
  const convTable = tableName('conversations', testEnv);
  const contactsTable = tableName('contacts', testEnv);
  const messagesTable = tableName('messages', testEnv);

  const DELETED_AT = '2026-08-10T00:00:00.000Z';
  const PHONE_LIVE = '+15550100301';
  const PHONE_DELETED_FRESH = '+15550100302';
  const PHONE_DELETED_STALE = '+15550100303';

  /** Every conversation row keyed by id - the byte-comparison baseline. */
  async function allConversations(): Promise<Record<string, Record<string, unknown>>> {
    const { Items } = await doc.send(new ScanCommand({ TableName: convTable }));
    const byId: Record<string, Record<string, unknown>> = {};
    for (const item of (Items ?? []) as Array<Record<string, unknown>>) {
      byId[String(item['conversationId'])] = item;
    }
    return byId;
  }

  beforeAll(async () => {
    for (const base of bases) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }

    // CONTACTS: two soft-deleted (the retroactive delete rule's population), one
    // live (proves the pre-pass discriminates), one phone-pointer row (proves
    // the pre-pass skips pointers rather than reading them as contacts).
    for (const contact of [
      { contactId: 'contact-live', phone: PHONE_LIVE, type: 'tenant', status: 'active' },
      {
        contactId: 'contact-deleted-fresh',
        phone: PHONE_DELETED_FRESH,
        type: 'tenant',
        status: 'active',
        deleted_at: DELETED_AT,
      },
      {
        contactId: 'contact-deleted-stale',
        phone: PHONE_DELETED_STALE,
        type: 'tenant',
        status: 'active',
        deleted_at: DELETED_AT,
      },
      { contactId: `phoneref#${PHONE_LIVE}`, phone: PHONE_LIVE, phone_ref: true, phone_ref_owner: 'contact-live' },
    ]) {
      await doc.send(new PutCommand({ TableName: contactsTable, Item: contact }));
    }

    // CONVERSATIONS: one row per rule, plus a pointer row and an
    // already-correct row so skip is exercised in both of its shapes.
    for (const conv of [
      // rule 5 -> remove: read, but still carrying the flag.
      {
        conversationId: 'conv-flagged-read',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: PHONE_LIVE,
        last_activity_at: '2026-08-01T01:00:00.000Z',
        unread_count: 0,
        unread_flag: UNREAD_FLAG_VALUE,
      },
      // rule 4 -> stamp: the migration proper.
      {
        conversationId: 'conv-unflagged-unread',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: PHONE_LIVE,
        last_activity_at: '2026-08-01T02:00:00.000Z',
        unread_count: 2,
      },
      // rule 2 -> closedReset: closed while unread, flagged (both must clear).
      {
        conversationId: 'conv-closed-relay',
        type: 'relay_group',
        status: 'closed',
        participant_phone: '+15550100399',
        pool_number: '+15550100399',
        last_activity_at: '2026-08-01T03:00:00.000Z',
        unread_count: 3,
        unread_flag: UNREAD_FLAG_VALUE,
      },
      // rule 3 -> probe -> stamp: a GENUINE resurfacing (inbound after delete).
      {
        conversationId: 'conv-deleted-fresh',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: PHONE_DELETED_FRESH,
        last_activity_at: '2026-08-11T00:00:00.000Z',
        unread_count: 1,
      },
      // rule 3 -> probe -> deletedReset: nothing since the delete.
      {
        conversationId: 'conv-deleted-stale',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: PHONE_DELETED_STALE,
        last_activity_at: '2026-08-09T00:00:00.000Z',
        unread_count: 1,
      },
      // rule 1 -> skip: key-only pointer partition.
      { conversationId: `phone#${PHONE_LIVE}`, ref_conversationId: 'conv-flagged-read' },
      // rule 6 -> skip: already correct, and must stay byte-identical.
      {
        conversationId: 'conv-correct-unread',
        type: 'tenant_1to1',
        status: 'open',
        participant_phone: PHONE_LIVE,
        last_activity_at: '2026-08-01T04:00:00.000Z',
        unread_count: 2,
        unread_flag: UNREAD_FLAG_VALUE,
      },
    ]) {
      await doc.send(new PutCommand({ TableName: convTable, Item: conv }));
    }

    // MESSAGES: the newest message on each deleted-contact thread is what the
    // probe reads. Ordering is by tsMsgId (newest-first), so the resurfacing
    // thread's post-delete inbound must ALSO be its newest key.
    for (const message of [
      {
        conversationId: 'conv-deleted-fresh',
        tsMsgId: '2026-08-09T00:00:00.000Z#m1',
        direction: 'outbound',
        created_at: '2026-08-09T00:00:00.000Z',
      },
      {
        conversationId: 'conv-deleted-fresh',
        tsMsgId: '2026-08-11T00:00:00.000Z#m2',
        direction: 'inbound',
        created_at: '2026-08-11T00:00:00.000Z', // AFTER the delete -> resurfaces
      },
      {
        conversationId: 'conv-deleted-stale',
        tsMsgId: '2026-08-09T00:00:00.000Z#m1',
        direction: 'inbound',
        created_at: '2026-08-09T00:00:00.000Z', // BEFORE the delete -> no resurfacing
      },
    ]) {
      await doc.send(new PutCommand({ TableName: messagesTable, Item: message }));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of bases) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  const EXPECTED_COUNTS = {
    scanned: 7,
    stamped: 2, // conv-unflagged-unread + the resurfacing probe
    removed: 1, // conv-flagged-read
    skipped: 2, // the pointer row + conv-correct-unread
    closedReset: 1, // conv-closed-relay
    deletedReset: 1, // conv-deleted-stale
    probed: 2, // both deleted-contact threads
  };

  it('--dry-run reports the full plan and writes NOTHING', async () => {
    const before = await allConversations();

    const counts = await backfillUnreadFlag({ doc, env: testEnv, dryRun: true });
    expect(counts).toEqual(EXPECTED_COUNTS);

    // Not "looks the same" - every row, every attribute, unchanged.
    expect(await allConversations()).toEqual(before);
  });

  it('the live run applies all four rules, with the right end state per row', async () => {
    const counts = await backfillUnreadFlag({ doc, env: testEnv });
    expect(counts).toEqual(EXPECTED_COUNTS);

    const after = await allConversations();

    // rule 5: the stale flag is GONE (absent, not empty), count untouched.
    expect('unread_flag' in (after['conv-flagged-read'] ?? {})).toBe(false);
    expect(after['conv-flagged-read']?.['unread_count']).toBe(0);

    // rule 4: stamped, count untouched.
    expect(after['conv-unflagged-unread']?.['unread_flag']).toBe(UNREAD_FLAG_VALUE);
    expect(after['conv-unflagged-unread']?.['unread_count']).toBe(2);

    // rule 2: closed relay zeroed AND unflagged, status left alone.
    expect(after['conv-closed-relay']?.['unread_count']).toBe(0);
    expect('unread_flag' in (after['conv-closed-relay'] ?? {})).toBe(false);
    expect(after['conv-closed-relay']?.['status']).toBe('closed');

    // rule 3a: the genuine resurfacing SURVIVED - stamped, count preserved.
    // This is the whole reason the probe exists instead of a blanket reset.
    expect(after['conv-deleted-fresh']?.['unread_flag']).toBe(UNREAD_FLAG_VALUE);
    expect(after['conv-deleted-fresh']?.['unread_count']).toBe(1);

    // rule 3b: nothing since the delete -> zeroed, unflagged.
    expect(after['conv-deleted-stale']?.['unread_count']).toBe(0);
    expect('unread_flag' in (after['conv-deleted-stale'] ?? {})).toBe(false);

    // rule 1: the pointer row is byte-identical (two attributes, no unread).
    expect(after[`phone#${PHONE_LIVE}`]).toEqual({
      conversationId: `phone#${PHONE_LIVE}`,
      ref_conversationId: 'conv-flagged-read',
    });

    // rule 6: already correct, untouched.
    expect(after['conv-correct-unread']?.['unread_flag']).toBe(UNREAD_FLAG_VALUE);
    expect(after['conv-correct-unread']?.['unread_count']).toBe(2);
  });

  it('the backfilled rows are the exact byUnread residents afterwards', async () => {
    // The end-to-end point of the whole script: index membership, read through
    // the real GSI rather than inferred from the item shapes above.
    const repo = createConversationsRepo({
      doc,
      env: testEnv,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const { items } = await repo.queryUnreadPage({ limit: 100 });
    expect(items.map((c) => c.conversationId).sort()).toEqual([
      'conv-correct-unread',
      'conv-deleted-fresh',
      'conv-unflagged-unread',
    ]);
  });

  it('re-running is idempotent: no further writes, identical end state', async () => {
    const before = await allConversations();

    const counts = await backfillUnreadFlag({ doc, env: testEnv });
    // Everything already sits in its target state. conv-deleted-fresh is still
    // unread with a deleted owner, so it is probed and re-stamped every run -
    // the conditional write makes that a no-op, which is exactly why the write
    // guards the state it transitions FROM.
    expect(counts).toEqual({
      scanned: 7,
      stamped: 1,
      removed: 0,
      // The other six: the pointer row, and five rows already in target state.
      skipped: 6,
      closedReset: 0,
      deletedReset: 0,
      probed: 1,
    });
    // Every row is accounted for exactly once - no row silently unvisited.
    expect(
      counts.stamped + counts.removed + counts.skipped + counts.closedReset + counts.deletedReset,
    ).toBe(counts.scanned);

    expect(await allConversations()).toEqual(before);
  });
});

// --- db:update-gsis ---------------------------------------------------------
// The no-data-loss local schema update. `ensureTable` is create-only, so a
// table that predates a new GSI never gains it; `db:create --reset` would fix
// that by DROPPING the table, taking the human's imported local data with it.
// This proves the third path: add the missing index in place, keep the rows.
describe.skipIf(!reachable)('db:update-gsis against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-gsis-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });

  const spec = getTableSpec('conversations');
  const physicalName = tableName('conversations', testEnv);

  beforeAll(async () => {
    // A table built from the REAL spec with ONE index artificially removed -
    // exactly the shape a local table created before Task 1 landed is in.
    const input = toCreateTableInput(spec, physicalName);
    input.GlobalSecondaryIndexes = (input.GlobalSecondaryIndexes ?? []).filter(
      (gsi) => gsi.IndexName !== 'byUnread',
    );
    // DynamoDB REJECTS an AttributeDefinition that no key schema references, so
    // dropping the index means dropping its now-orphaned key attribute too
    // (`unread_flag`). `last_activity_at` stays - byLastActivity and
    // byRelayStatus still range on it. This is the same strictness that makes
    // UpdateTable want a PER-INDEX definition set rather than the whole-table
    // one, which is why gsiAttributeDefinitions exists.
    const referenced = new Set(
      [
        ...(input.KeySchema ?? []),
        ...(input.GlobalSecondaryIndexes ?? []).flatMap((gsi) => gsi.KeySchema ?? []),
      ]
        .map((key) => key.AttributeName)
        .filter((name): name is string => typeof name === 'string'),
    );
    input.AttributeDefinitions = (input.AttributeDefinitions ?? []).filter(
      (attr) => typeof attr.AttributeName === 'string' && referenced.has(attr.AttributeName),
    );
    await client.send(new CreateTableCommand(input));
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: physicalName });

    // A row that must SURVIVE the update - the entire point of the script.
    await doc.send(
      new PutCommand({
        TableName: physicalName,
        Item: {
          conversationId: 'conv-preexisting',
          type: 'tenant_1to1',
          status: 'open',
          participant_phone: '+15550100401',
          last_activity_at: '2026-08-01T00:00:00.000Z',
          unread_count: 2,
          unread_flag: UNREAD_FLAG_VALUE,
        },
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await deleteTableIfExists(client, physicalName);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('starts from a table that is genuinely MISSING the index', async () => {
    // Without this the test could pass by doing nothing at all.
    const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));
    const names = (Table?.GlobalSecondaryIndexes ?? []).map((gsi) => gsi.IndexName);
    expect(names).not.toContain('byUnread');
    expect(names.length).toBe(spec.gsis.length - 1);
  });

  it('adds the missing GSI in place, ACTIVE, without dropping the table', async () => {
    const logged: string[] = [];
    const result = await ensureGsis(client, [spec], testEnv, (m) => logged.push(m));

    expect(result.added).toEqual([`${physicalName}.byUnread`]);
    expect(result.unchanged).toEqual([]);
    expect(result.missingTables).toEqual([]);
    expect(logged.some((m) => m.includes(`added    ${physicalName}.byUnread`))).toBe(true);

    const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));
    const added = (Table?.GlobalSecondaryIndexes ?? []).find((gsi) => gsi.IndexName === 'byUnread');
    expect(added).toBeDefined();
    expect(added?.IndexStatus).toBe('ACTIVE');
    expect(added?.KeySchema).toEqual([
      { AttributeName: 'unread_flag', KeyType: 'HASH' },
      { AttributeName: 'last_activity_at', KeyType: 'RANGE' },
    ]);
    expect(added?.Projection?.ProjectionType).toBe('ALL');

    // THE POINT: the pre-existing row is still there. A --reset would have
    // taken it with the table.
    const { Item } = await doc.send(
      new GetCommand({ TableName: physicalName, Key: { conversationId: 'conv-preexisting' } }),
    );
    expect(Item?.['unread_count']).toBe(2);

    // And the row is genuinely queryable through the new index.
    const repo = createConversationsRepo({
      doc,
      env: testEnv,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const { items } = await repo.queryUnreadPage({ limit: 10 });
    expect(items.map((c) => c.conversationId)).toContain('conv-preexisting');
    // Generous timeout: this is instant on an idle DynamoDB Local (~200ms) but
    // the index BACKFILL is a background task that starves when the shared
    // container is saturated by other worktrees' suites.
  }, 300_000);

  it('a SECOND run reports nothing to do (idempotent)', async () => {
    const logged: string[] = [];
    const result = await ensureGsis(client, [spec], testEnv, (m) => logged.push(m));

    expect(result.added).toEqual([]);
    expect(result.unchanged).toEqual([physicalName]);
    expect(logged).toEqual([`  ok       ${physicalName}`]);
  });

  it('reports an ABSENT table rather than trying to alter it', async () => {
    const absentEnv = { TABLE_PREFIX: `hc-test-gsis-absent-${randomUUID().slice(0, 8)}-` };
    const result = await ensureGsis(client, [spec], absentEnv, () => {});
    expect(result.added).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.missingTables).toEqual([tableName('conversations', absentEnv)]);
  });
});
