// M1.2 integration tests against DynamoDB Local — the conversation-hub
// conditional writes: participants claim (the auto-capture race anchor),
// unread increment/reset, touchLastActivity ALL_NEW,
// the one-Query inbox pagination, contact createIfAbsent no-overwrite, and
// the full contactCapture race on real conditional writes.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createContactCapture } from '../src/services/contactCapture.js';
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
    `[conversationHub.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('conversation hub repos against DynamoDB Local (throwaway prefix)', () => {
  // Throwaway prefix so this suite never touches hc-local-* dev data.
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);
  const contacts = createContactsRepo(repoDeps);
  const audit = createAuditRepo(repoDeps);

  const bases = ['contacts', 'conversations', 'audit_events'] as const;

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

  describe('createOrGetByParticipantPhone — the phone-keyed claim (M1.2 race backstop)', () => {
    it('two CONCURRENT creates for one new phone yield exactly one conversation, same id for both', async () => {
      const phone = '+15550208888';
      const [a, b] = await Promise.all([
        conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1'),
        conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1'),
      ]);

      expect(a.conversationId).toBe(b.conversationId);

      // Exactly one real conversation row exists, matching the claim's ref.
      const claim = await doc.send(
        new GetCommand({
          TableName: tableName('conversations', testEnv),
          Key: { conversationId: `phone#${phone}` },
        }),
      );
      expect(claim.Item?.['ref_conversationId']).toBe(a.conversationId);
      const row = await conversations.getById(a.conversationId);
      expect(row).toMatchObject({ participant_phone: phone, status: 'open', ai_mode: 'auto' });

      // The claim must stay OUT of both GSIs: no participant_phone (sparse
      // byParticipantPhone) and no status/last_activity_at (sparse
      // byLastActivity) on the claim item.
      expect(claim.Item).toEqual({
        conversationId: `phone#${phone}`,
        ref_conversationId: a.conversationId,
      });
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: tableName('conversations', testEnv),
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      expect(Items?.map((i) => i['conversationId'])).toEqual([a.conversationId]);
    });

    it('self-heals the claim-then-crash window: claim exists, row missing → next call creates the claimed id', async () => {
      const phone = '+15550209999';
      // Simulate a winner that claimed the phone and crashed before writing
      // the conversation row.
      await doc.send(
        new PutCommand({
          TableName: tableName('conversations', testEnv),
          Item: { conversationId: `phone#${phone}`, ref_conversationId: 'conv-crashed-claim' },
        }),
      );

      const healed = await conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1');

      expect(healed.conversationId).toBe('conv-crashed-claim'); // the claimed id, not a fresh one
      expect(await conversations.getById('conv-crashed-claim')).toMatchObject({
        participant_phone: phone,
        status: 'open',
        type: 'tenant_1to1',
      });

      // And a later call settles on the same conversation.
      const again = await conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1');
      expect(again.conversationId).toBe('conv-crashed-claim');
    });
  });

  describe('setParticipantsIfAbsent — the auto-capture race anchor', () => {
    it('claims once; every later claim loses without overwriting the link', async () => {
      const conv = await conversations.createOrGetByParticipantPhone('+15550201111', 'tenant_1to1');

      const first = await conversations.setParticipantsIfAbsent(conv.conversationId, [
        { contactId: 'contact-winner', phone: '+15550201111' },
      ]);
      expect(first).toBe(true);

      const second = await conversations.setParticipantsIfAbsent(conv.conversationId, [
        { contactId: 'contact-loser', phone: '+15550201111' },
      ]);
      expect(second).toBe(false);

      const reread = await conversations.getById(conv.conversationId);
      expect(reread?.participants).toEqual([{ contactId: 'contact-winner', phone: '+15550201111' }]);
    });

    it('throws for a nonexistent conversation (claim must never upsert)', async () => {
      await expect(
        conversations.setParticipantsIfAbsent('conv-ghost', [{ contactId: 'c', phone: '+1' }]),
      ).rejects.toThrow(/conversation not found/);
    });
  });

  describe('unread tracking', () => {
    it('incrementUnread counts atomically (sequential + concurrent) and resetUnread zeroes', async () => {
      const conv = await conversations.createOrGetByParticipantPhone('+15550202222', 'tenant_1to1');

      expect(await conversations.incrementUnread(conv.conversationId)).toBe(1);
      expect(await conversations.incrementUnread(conv.conversationId)).toBe(2);

      // Concurrent bumps must never lose an update (ADD is atomic).
      await Promise.all(
        Array.from({ length: 5 }, () => conversations.incrementUnread(conv.conversationId)),
      );
      expect((await conversations.getById(conv.conversationId))?.unread_count).toBe(7);

      const reset = await conversations.resetUnread(conv.conversationId);
      expect(reset.unread_count).toBe(0);
      expect(reset.conversationId).toBe(conv.conversationId);
      expect((await conversations.getById(conv.conversationId))?.unread_count).toBe(0);
    });

    it('both writes are conditional on the conversation existing', async () => {
      await expect(conversations.incrementUnread('conv-ghost')).rejects.toBeInstanceOf(
        ConditionalCheckFailedException,
      );
      await expect(conversations.resetUnread('conv-ghost')).rejects.toBeInstanceOf(
        ConditionalCheckFailedException,
      );
    });
  });

  describe('touchLastActivity (M1.2: returns ALL_NEW)', () => {
    it('returns the post-update item carrying the fresh activity, preview, and unread count', async () => {
      const conv = await conversations.createOrGetByParticipantPhone('+15550204444', 'tenant_1to1');
      await conversations.incrementUnread(conv.conversationId);

      const touched = await conversations.touchLastActivity(
        conv.conversationId,
        'fresh preview',
        '2026-06-12T13:00:00.000Z',
      );
      expect(touched).toMatchObject({
        conversationId: conv.conversationId,
        status: 'open',
        last_activity_at: '2026-06-12T13:00:00.000Z',
        last_message_preview: 'fresh preview',
        unread_count: 1, // the increment travels in the same snapshot
      });
    });
  });

  describe('listByLastActivity — ONE Query inbox pagination', () => {
    // A status value unique to this block so other tests' conversations
    // never leak into the result set (status is the GSI partition key).
    const STATUS = 'inbox-page-test';
    const ids = ['conv-pg-1', 'conv-pg-2', 'conv-pg-3', 'conv-pg-4', 'conv-pg-5'];

    beforeAll(async () => {
      for (const [i, conversationId] of ids.entries()) {
        await doc.send(
          new PutCommand({
            TableName: tableName('conversations', testEnv),
            Item: {
              conversationId,
              participant_phone: `+1555030000${i}`,
              status: STATUS,
              last_activity_at: `2026-06-12T0${i}:00:00.000Z`,
              type: 'tenant_1to1',
              ai_mode: 'auto',
              created_at: '2026-06-12T00:00:00.000Z',
            },
          }),
        );
      }
      // One closed conversation that must never appear in this partition.
      await doc.send(
        new PutCommand({
          TableName: tableName('conversations', testEnv),
          Item: {
            conversationId: 'conv-pg-closed',
            participant_phone: '+15550309999',
            status: `${STATUS}-closed`,
            last_activity_at: '2026-06-12T09:00:00.000Z',
            type: 'tenant_1to1',
            ai_mode: 'auto',
            created_at: '2026-06-12T00:00:00.000Z',
          },
        }),
      );
    });

    it('pages DESC by last_activity_at via LastEvaluatedKey with no gaps or duplicates', async () => {
      const collected: string[] = [];
      let cursor: Record<string, unknown> | undefined;
      let pages = 0;
      do {
        const page = await conversations.listByLastActivity({
          status: STATUS,
          limit: 2,
          ...(cursor !== undefined && { exclusiveStartKey: cursor }),
        });
        pages += 1;
        expect(page.items.length).toBeLessThanOrEqual(2);
        collected.push(...page.items.map((c) => c.conversationId));
        cursor = page.lastEvaluatedKey;
      } while (cursor !== undefined && pages < 10);

      // Newest activity first: conv-pg-5 (04:00) … conv-pg-1 (00:00).
      expect(collected).toEqual(['conv-pg-5', 'conv-pg-4', 'conv-pg-3', 'conv-pg-2', 'conv-pg-1']);
      expect(pages).toBeGreaterThanOrEqual(3); // really paginated, not one big read
    });

    it('filters by the requested status partition (other statuses invisible)', async () => {
      const page = await conversations.listByLastActivity({ status: `${STATUS}-closed` });
      expect(page.items.map((c) => c.conversationId)).toEqual(['conv-pg-closed']);
      expect(page.lastEvaluatedKey).toBeUndefined();
    });
  });

  describe('contactsRepo.createIfAbsent — the no-overwrite guarantee', () => {
    it('creates once; a second create with different fields changes NOTHING', async () => {
      const first = await contacts.createIfAbsent({
        contactId: 'contact-it-create',
        type: 'tenant',
        status: 'new',
        phone: '+15550205555',
        capture_source: 'inbound_sms',
      });
      expect(first).toBe(true);

      const second = await contacts.createIfAbsent({
        contactId: 'contact-it-create',
        type: 'landlord', // hostile overwrite attempt
        status: 'active',
        phone: '+15550999999',
      });
      expect(second).toBe(false);

      const reread = await contacts.getById('contact-it-create');
      expect(reread).toMatchObject({
        contactId: 'contact-it-create',
        type: 'tenant',
        status: 'new',
        phone: '+15550205555',
        capture_source: 'inbound_sms',
      });
    });
  });

  describe('contactCapture — real conditional writes', () => {
    const capture = createContactCapture({
      contactsRepo: contacts,
      conversationsRepo: conversations,
      auditRepo: audit,
      logger,
    });

    async function captureAudits(contactId: string): Promise<number> {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: tableName('audit_events', testEnv),
          KeyConditionExpression: 'entityKey = :k',
          ExpressionAttributeValues: { ':k': `contacts#${contactId}` },
        }),
      );
      return (Items ?? []).filter(
        (i) => (i as { event_type?: string }).event_type === 'contact_auto_captured',
      ).length;
    }

    it('two CONCURRENT captures for one unknown phone create exactly one contact + link + audit', async () => {
      const conv = await conversations.createOrGetByParticipantPhone('+15550206666', 'tenant_1to1');

      const [a, b] = await Promise.all([capture(conv), capture(conv)]);
      expect(a.contactId).toBe(b.contactId);

      const linked = await conversations.getById(conv.conversationId);
      expect(linked?.participants).toEqual([{ contactId: a.contactId, phone: '+15550206666' }]);

      const persisted = await contacts.getById(a.contactId);
      // Auto-captured stubs never carry guessed identity (2026-06-12).
      expect(persisted).toMatchObject({
        type: 'unknown',
        status: 'needs_review',
        phone: '+15550206666',
        capture_source: 'inbound_sms',
      });
      // Exactly one byPhone hit and exactly one capture audit event.
      expect((await contacts.findByPhone('+15550206666'))?.contactId).toBe(a.contactId);
      expect(await captureAudits(a.contactId)).toBe(1);
    });

    it('an existing contact gets the link backfilled and is never written', async () => {
      await doc.send(
        new PutCommand({
          TableName: tableName('contacts', testEnv),
          Item: {
            contactId: 'contact-it-backfill',
            type: 'landlord',
            status: 'active',
            phone: '+15550207777',
            notes: 'must survive capture',
          },
        }),
      );
      const conv = await conversations.createOrGetByParticipantPhone('+15550207777', 'landlord_1to1');

      const result = await capture(conv);
      expect(result.contactId).toBe('contact-it-backfill');

      const linked = await conversations.getById(conv.conversationId);
      expect(linked?.participants).toEqual([
        { contactId: 'contact-it-backfill', phone: '+15550207777' },
      ]);
      expect(await contacts.getById('contact-it-backfill')).toMatchObject({
        type: 'landlord',
        status: 'active',
        notes: 'must survive capture',
      });
      expect(await captureAudits('contact-it-backfill')).toBe(0);
    });
  });
});
