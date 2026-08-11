// group_text conversation primitives against DynamoDB Local (build slice S2).
//
// Covers the three things the rest of the feature binds to:
//   1. touchLastActivity's REPO-LEVEL PARTITION GUARD - a group_text thread's
//      `group_open` status survives ANY touch (inbound, outbound send path,
//      announcements), while typed AND legacy type-less 1:1 rows keep today's
//      exact "activity (re)opens the thread" semantics and a missing row still
//      surfaces ConditionalCheckFailedException (no phantom upsert).
//   2. createGroupTextThread / listGroupTexts - the deterministic-id conditional
//      create and the byLastActivity `group_open` partition read (tagged cursor,
//      newest-first, truncated flag).
//   3. setTwilioConversation - the FENCED rail finalize slice S6 depends on:
//      the write lands only while the caller still owns the rail_creating claim.
//
// Self-skipping like the other integration suites: with nothing answering at
// DYNAMODB_ENDPOINT the suite is skipped so `npm test` stays green without
// Docker (`npm run db:start` to exercise it).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import {
  createConversationsRepo,
  GROUP_TEXT_STATUS,
  type ConversationItem,
} from '../src/repos/conversationsRepo.js';
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
    `[groupTextRepo.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('group_text conversation primitives against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const conversations = createConversationsRepo({ doc, env: testEnv, logger });
  const table = tableName('conversations', testEnv);

  let seq = 0;
  const nextId = (): string => `gt-test-${++seq}-${randomUUID().slice(0, 8)}`;

  /** Write a raw row (bypassing the repo) so legacy/odd shapes can be modelled. */
  const putRaw = async (item: Record<string, unknown>): Promise<void> => {
    await doc.send(new PutCommand({ TableName: table, Item: item }));
  };

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('conversations'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  describe('touchLastActivity partition guard', () => {
    it("keeps a group thread's group_open status through a touch (preview + activity still land)", async () => {
      const created = await conversations.createGroupTextThread({
        conversationId: nextId(),
        members: [
          { contactId: 'c-1', phone: '+15550100001' },
          { contactId: 'c-2', phone: '+15550100002' },
        ],
      });

      const touched = await conversations.touchLastActivity(
        created.item.conversationId,
        'group preview',
        '2026-08-10T12:00:00.000Z',
      );

      expect(touched).toMatchObject({
        conversationId: created.item.conversationId,
        status: GROUP_TEXT_STATUS,
        type: 'group_text',
        last_activity_at: '2026-08-10T12:00:00.000Z',
        last_message_preview: 'group preview',
      });
      const reread = await conversations.getById(created.item.conversationId);
      expect(reread?.status).toBe(GROUP_TEXT_STATUS);
    });

    it('keeps group_open on the NO-PREVIEW retry path (the SET must not go empty)', async () => {
      const created = await conversations.createGroupTextThread({
        conversationId: nextId(),
        members: [{ contactId: 'c-3', phone: '+15550100003' }],
      });

      const touched = await conversations.touchLastActivity(
        created.item.conversationId,
        undefined,
        '2026-08-10T13:00:00.000Z',
      );

      expect(touched.status).toBe(GROUP_TEXT_STATUS);
      expect(touched.last_activity_at).toBe('2026-08-10T13:00:00.000Z');
      expect(touched.last_message_preview).toBeUndefined();
    });

    it('keeps today semantics for a TYPED 1:1 row: activity reopens the thread', async () => {
      const conversationId = nextId();
      await putRaw({
        conversationId,
        participant_phone: '+15550100010',
        status: 'closed',
        last_activity_at: '2026-08-01T00:00:00.000Z',
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: '2026-08-01T00:00:00.000Z',
      });

      const touched = await conversations.touchLastActivity(
        conversationId,
        'hello',
        '2026-08-10T14:00:00.000Z',
      );

      expect(touched).toMatchObject({
        status: 'open',
        last_activity_at: '2026-08-10T14:00:00.000Z',
        last_message_preview: 'hello',
      });
    });

    it('keeps today semantics for a LEGACY type-less row (attribute_not_exists arm)', async () => {
      const conversationId = nextId();
      await putRaw({
        conversationId,
        participant_phone: '+15550100011',
        status: 'closed',
        last_activity_at: '2026-08-01T00:00:00.000Z',
        ai_mode: 'auto',
        created_at: '2026-08-01T00:00:00.000Z',
      });

      const touched = await conversations.touchLastActivity(
        conversationId,
        undefined,
        '2026-08-10T15:00:00.000Z',
      );

      expect(touched.status).toBe('open');
      expect(touched.last_activity_at).toBe('2026-08-10T15:00:00.000Z');
    });

    it('still surfaces ConditionalCheckFailedException for a missing row (no phantom upsert)', async () => {
      const missing = nextId();
      await expect(
        conversations.touchLastActivity(missing, 'nope', '2026-08-10T16:00:00.000Z'),
      ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
      expect(await conversations.getById(missing)).toBeUndefined();
    });
  });

  describe('createGroupTextThread', () => {
    it('creates the group row in its own partition with no relay/1:1 attributes', async () => {
      const conversationId = nextId();
      const { item, created } = await conversations.createGroupTextThread({
        conversationId,
        members: [
          { contactId: 'c-10', phone: '+15550100020', name: 'Ana' },
          { contactId: 'c-11', phone: '+15550100021' },
        ],
        lastActivityAt: '2026-08-10T10:00:00.000Z',
        preview: 'first inbound',
      });

      expect(created).toBe(true);
      expect(item).toMatchObject({
        conversationId,
        status: GROUP_TEXT_STATUS,
        type: 'group_text',
        ai_mode: 'manual',
        last_activity_at: '2026-08-10T10:00:00.000Z',
        last_message_preview: 'first inbound',
      });
      expect(item.participants).toHaveLength(2);
      expect(item.participant_phone).toBeUndefined();
      expect(item.participant_email).toBeUndefined();
      expect(item.pool_number).toBeUndefined();
      expect(item.relay_status).toBeUndefined();

      const reread = await conversations.getById(conversationId);
      expect(reread?.status).toBe(GROUP_TEXT_STATUS);
      expect(reread?.relay_status).toBeUndefined();
    });

    it('is a conditional create: the loser adopts the existing row untouched', async () => {
      const conversationId = nextId();
      const first = await conversations.createGroupTextThread({
        conversationId,
        members: [{ contactId: 'c-20', phone: '+15550100030' }],
        lastActivityAt: '2026-08-10T10:00:00.000Z',
      });
      const second = await conversations.createGroupTextThread({
        conversationId,
        members: [{ contactId: 'c-21', phone: '+15550100031' }],
        lastActivityAt: '2026-08-10T11:00:00.000Z',
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.item.participants).toEqual(first.item.participants);
      expect(second.item.last_activity_at).toBe('2026-08-10T10:00:00.000Z');
    });

    it('two concurrent creates on one deterministic id produce exactly one winner', async () => {
      const conversationId = nextId();
      const members = [{ contactId: 'c-30', phone: '+15550100040' }];
      const [a, b] = await Promise.all([
        conversations.createGroupTextThread({ conversationId, members }),
        conversations.createGroupTextThread({ conversationId, members }),
      ]);
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
      expect(a.item.conversationId).toBe(b.item.conversationId);
    });
  });

  describe('listGroupTexts', () => {
    it('returns the group partition newest-first and pages through a tagged cursor', async () => {
      const stamps = [
        '2026-08-09T01:00:00.000Z',
        '2026-08-09T02:00:00.000Z',
        '2026-08-09T03:00:00.000Z',
      ];
      const ids: string[] = [];
      for (const at of stamps) {
        const conversationId = nextId();
        ids.push(conversationId);
        await conversations.createGroupTextThread({
          conversationId,
          members: [{ contactId: `c-${conversationId}`, phone: '+15550100050' }],
          lastActivityAt: at,
        });
      }

      const page1 = await conversations.listGroupTexts({ limit: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.truncated).toBe(false);
      expect(page1.items[0]!.last_activity_at >= page1.items[1]!.last_activity_at).toBe(true);
      expect(typeof page1.nextCursor).toBe('string');

      const page2 = await conversations.listGroupTexts({
        limit: 10,
        cursor: page1.nextCursor,
      });
      const seen = [...page1.items, ...page2.items].map((c) => c.conversationId);
      for (const id of ids) expect(seen).toContain(id);
      // Every returned row belongs to the group partition - nothing else leaks in.
      for (const row of [...page1.items, ...page2.items]) {
        expect(row.status).toBe(GROUP_TEXT_STATUS);
      }
    });

    it('rejects a foreign/tampered cursor instead of silently restarting the walk', async () => {
      await expect(
        conversations.listGroupTexts({ cursor: 'bm90LWEtY3Vyc29y' }),
      ).rejects.toThrowError(/cursor/i);
    });

    it('never surfaces group rows through the 1:1 open partition', async () => {
      const conversationId = nextId();
      await conversations.createGroupTextThread({
        conversationId,
        members: [{ contactId: 'c-40', phone: '+15550100060' }],
        lastActivityAt: '2026-08-09T09:00:00.000Z',
      });
      const open = await conversations.listByLastActivity({ status: 'open', limit: 100 });
      expect(open.items.map((c) => c.conversationId)).not.toContain(conversationId);
    });
  });

  describe('setTwilioConversation (rail fencing)', () => {
    const claim = async (conversationId: string, token: string, at: string): Promise<void> => {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET rail_creating = :rc',
          ExpressionAttributeValues: { ':rc': { token, at } },
        }),
      );
    };

    it('writes the rail and CLEARS the claim when the caller still owns it', async () => {
      const conversationId = nextId();
      await conversations.createGroupTextThread({
        conversationId,
        members: [{ contactId: 'c-50', phone: '+15550100070' }],
      });
      await claim(conversationId, 'token-a', '2026-08-10T10:00:00.000Z');

      const updated = await conversations.setTwilioConversation(
        conversationId,
        'CH11111111111111111111111111111111',
        { MB11111111111111111111111111111111: 'phone#+15550100070' },
        'token-a',
      );

      expect(updated).toBeDefined();
      expect(updated).toMatchObject({
        twilio_conversation_sid: 'CH11111111111111111111111111111111',
        twilio_participant_map: { MB11111111111111111111111111111111: 'phone#+15550100070' },
      });
      expect((updated as ConversationItem).rail_creating).toBeUndefined();
    });

    it('refuses (undefined, no write) when another claimant took over', async () => {
      const conversationId = nextId();
      await conversations.createGroupTextThread({
        conversationId,
        members: [{ contactId: 'c-51', phone: '+15550100071' }],
      });
      await claim(conversationId, 'token-new', '2026-08-10T10:05:00.000Z');

      const updated = await conversations.setTwilioConversation(
        conversationId,
        'CH22222222222222222222222222222222',
        {},
        'token-expired',
      );

      expect(updated).toBeUndefined();
      const reread = await conversations.getById(conversationId);
      expect(reread?.twilio_conversation_sid).toBeUndefined();
      expect(reread?.rail_creating).toMatchObject({ token: 'token-new' });
    });

    it('refuses when no claim exists at all', async () => {
      const conversationId = nextId();
      await conversations.createGroupTextThread({
        conversationId,
        members: [{ contactId: 'c-52', phone: '+15550100072' }],
      });

      const updated = await conversations.setTwilioConversation(
        conversationId,
        'CH33333333333333333333333333333333',
        {},
        'token-a',
      );

      expect(updated).toBeUndefined();
      const reread = await conversations.getById(conversationId);
      expect(reread?.twilio_conversation_sid).toBeUndefined();
    });
  });
});
