// M1.1 integration test against DynamoDB Local — the messaging repos.
//
// Self-skipping like dynamo.integration.test.ts: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
//
// Covers the M1.1 acceptance set: createOrGetByParticipantPhone uniqueness,
// append dedupe on the same provider SID, status-machine no-regress, and the
// SID → location pointer lookup.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, minuteBucket } from '../src/repos/conversationsRepo.js';
import { createMessagesRepo, type NewMessage } from '../src/repos/messagesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    // DynamoDB Local answers any HTTP request (400 for a bare GET) once up.
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[messaging.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

function outbound(conversationId: string, sid: string, ts: string, body: string): NewMessage {
  return {
    conversationId,
    providerSid: sid,
    providerTs: ts,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body,
    deliveryStatus: 'queued',
  };
}

describe.skipIf(!reachable)('messaging repos against DynamoDB Local (throwaway prefix)', () => {
  // Throwaway prefix so this suite never touches hc-local-* dev data.
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);
  const messages = createMessagesRepo(repoDeps);
  const contacts = createContactsRepo(repoDeps);
  const audit = createAuditRepo(repoDeps);

  // Only the four tables the messaging repos touch.
  const bases = ['contacts', 'conversations', 'messages', 'audit_events'] as const;

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

  describe('conversationsRepo', () => {
    it('createOrGetByParticipantPhone creates once, then returns the same active conversation', async () => {
      const created = await conversations.createOrGetByParticipantPhone('+15550101111', 'tenant_1to1');
      expect(created.conversationId).toMatch(/^conv-/);
      expect(created).toMatchObject({
        participant_phone: '+15550101111',
        status: 'open',
        ai_mode: 'auto',
        type: 'tenant_1to1',
      });

      const again = await conversations.createOrGetByParticipantPhone('+15550101111', 'tenant_1to1');
      expect(again.conversationId).toBe(created.conversationId); // one active 1:1 per phone

      const other = await conversations.createOrGetByParticipantPhone('+15550102222', 'landlord_1to1');
      expect(other.conversationId).not.toBe(created.conversationId);
    });

    it('touchLastActivity updates the byLastActivity GSI attrs + preview; setMode flips ai_mode', async () => {
      const conv = await conversations.createOrGetByParticipantPhone('+15550103333', 'tenant_1to1');
      await conversations.touchLastActivity(conv.conversationId, 'latest message text', '2026-06-12T11:00:00.000Z');
      await conversations.setMode(conv.conversationId, 'manual');

      const reread = await conversations.getById(conv.conversationId);
      expect(reread).toMatchObject({
        status: 'open',
        last_activity_at: '2026-06-12T11:00:00.000Z',
        last_message_preview: 'latest message text',
        ai_mode: 'manual',
      });
    });

    it('incrementAutomatedSendCount counts within a bucket and resets on rollover', async () => {
      const conv = await conversations.createOrGetByParticipantPhone('+15550104444', 'tenant_1to1');
      const bucket = minuteBucket(new Date('2026-06-12T15:04:00.000Z'));
      expect(await conversations.incrementAutomatedSendCount(conv.conversationId, bucket)).toBe(1);
      expect(await conversations.incrementAutomatedSendCount(conv.conversationId, bucket)).toBe(2);
      expect(await conversations.incrementAutomatedSendCount(conv.conversationId, bucket)).toBe(3);

      const nextBucket = minuteBucket(new Date('2026-06-12T15:05:00.000Z'));
      expect(await conversations.incrementAutomatedSendCount(conv.conversationId, nextBucket)).toBe(1);
    });
  });

  describe('messagesRepo', () => {
    const convId = 'conv-it-messages';

    it('append persists once; the same provider SID dedupes to a no-op', async () => {
      const first = await messages.append(outbound(convId, 'SMdup1', '2026-06-12T10:00:00.000Z', 'hello'));
      expect(first).toEqual({ deduped: false, tsMsgId: '2026-06-12T10:00:00.000Z#SMdup1' });

      // Twilio redelivery / webhook echo: identical provider message again.
      const second = await messages.append(outbound(convId, 'SMdup1', '2026-06-12T10:00:00.000Z', 'hello'));
      expect(second).toEqual({ deduped: true, tsMsgId: '2026-06-12T10:00:00.000Z#SMdup1' });

      const page = await messages.listByConversation(convId);
      expect(page.filter((m) => m.provider_sid === 'SMdup1')).toHaveLength(1);
    });

    it('a redelivery with a DIFFERENT provider ts still dedupes and returns the FIRST write\'s tsMsgId', async () => {
      // Inbound redeliveries carry no provider timestamp, so the second
      // delivery computes a NEW first-seen ts — the SID pointer still
      // collides, and the result must carry the PERSISTED key.
      const first = await messages.append(outbound(convId, 'SMdiffts1', '2026-06-12T10:05:00.000Z', 'first'));
      expect(first).toEqual({ deduped: false, tsMsgId: '2026-06-12T10:05:00.000Z#SMdiffts1' });

      const second = await messages.append(outbound(convId, 'SMdiffts1', '2026-06-12T10:06:11.000Z', 'first'));
      expect(second).toEqual({ deduped: true, tsMsgId: '2026-06-12T10:05:00.000Z#SMdiffts1' });

      const page = await messages.listByConversation(convId);
      expect(page.filter((m) => m.provider_sid === 'SMdiffts1')).toHaveLength(1);
    });

    it('getByProviderSid resolves a message via the SID pointer (doc §9 lookup)', async () => {
      await messages.append(outbound(convId, 'SMptr1', '2026-06-12T10:01:00.000Z', 'find me'));
      const found = await messages.getByProviderSid('SMptr1');
      expect(found).toMatchObject({
        conversationId: convId,
        tsMsgId: '2026-06-12T10:01:00.000Z#SMptr1',
        body: 'find me',
        delivery_status: 'queued',
      });
      expect(await messages.getByProviderSid('SMnope')).toBeUndefined();
    });

    it('updateDeliveryStatus walks forward and never regresses a delivered message', async () => {
      await messages.append(outbound(convId, 'SMstatus1', '2026-06-12T10:02:00.000Z', 'status walk'));

      expect(await messages.updateDeliveryStatus('SMstatus1', 'sent')).toBe(true);
      expect(await messages.updateDeliveryStatus('SMstatus1', 'delivered')).toBe(true);
      // Out-of-order/duplicate callbacks must be no-ops:
      expect(await messages.updateDeliveryStatus('SMstatus1', 'sent')).toBe(false);
      expect(await messages.updateDeliveryStatus('SMstatus1', 'undelivered')).toBe(false);
      expect(await messages.updateDeliveryStatus('SMstatus1', 'queued')).toBe(false);

      const final = await messages.getByProviderSid('SMstatus1');
      expect(final?.delivery_status).toBe('delivered');
    });

    it('records error codes on failure transitions and ignores unknown SIDs', async () => {
      await messages.append(outbound(convId, 'SMfail1', '2026-06-12T10:03:00.000Z', 'will fail'));
      expect(await messages.updateDeliveryStatus('SMfail1', 'failed', '30003')).toBe(true);
      expect((await messages.getByProviderSid('SMfail1'))?.error_code).toBe('30003');
      expect(await messages.updateDeliveryStatus('SMghost', 'delivered')).toBe(false);
    });

    it('annotateMessage stamps media keys / retry lineage onto an existing message (M1.1 webhooks)', async () => {
      await messages.append(outbound(convId, 'SMannotate1', '2026-06-12T10:04:00.000Z', 'annotate me'));
      await messages.annotateMessage(convId, '2026-06-12T10:04:00.000Z#SMannotate1', {
        mediaS3Keys: [`media/${convId}/SMannotate1/0`],
        retryOf: '2026-06-12T10:00:00.000Z#SMdup1',
        retryAttempt: 1,
      });
      const annotated = await messages.getByProviderSid('SMannotate1');
      expect(annotated).toMatchObject({
        media_s3_keys: [`media/${convId}/SMannotate1/0`],
        retry_of: '2026-06-12T10:00:00.000Z#SMdup1',
        retry_attempt: 1,
        body: 'annotate me', // content untouched — annotations only
      });
      // annotating a nonexistent message fails the conditional write
      await expect(
        messages.annotateMessage(convId, '2026-06-12T10:04:00.000Z#SMnope', { retryAttempt: 1 }),
      ).rejects.toThrow();
    });

    it('listByConversation pages newest-first and never returns sid pointer items', async () => {
      const page = await messages.listByConversation(convId, { limit: 10 });
      expect(page.length).toBeGreaterThanOrEqual(4);
      const keys = page.map((m) => m.tsMsgId);
      expect([...keys].sort().reverse()).toEqual(keys); // newest-first
      expect(page.every((m) => m.conversationId === convId)).toBe(true);

      const older = await messages.listByConversation(convId, { before: keys[0] });
      expect(older.map((m) => m.tsMsgId)).not.toContain(keys[0]);
    });
  });

  describe('contactsRepo', () => {
    it('findByPhone resolves via the byPhone GSI and setFlag sets suppression flags', async () => {
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
      await doc.send(
        new PutCommand({
          TableName: tableName('contacts', testEnv),
          Item: { contactId: 'contact-it-1', type: 'tenant', status: 'active', phone: '+15550105555' },
        }),
      );

      const found = await contacts.findByPhone('+15550105555');
      expect(found?.contactId).toBe('contact-it-1');
      expect(await contacts.findByPhone('+15550100000')).toBeUndefined();

      await contacts.setFlag('contact-it-1', 'sms_opt_out');
      expect((await contacts.findByPhone('+15550105555'))?.sms_opt_out).toBe(true);
    });

    it('clearFlag flips a suppression flag back off (START/UNSTOP, M1.1)', async () => {
      await contacts.clearFlag('contact-it-1', 'sms_opt_out');
      expect((await contacts.findByPhone('+15550105555'))?.sms_opt_out).toBe(false);
      // conditional on the contact existing, like setFlag
      await expect(contacts.clearFlag('contact-ghost', 'sms_opt_out')).rejects.toThrow();
    });
  });

  describe('auditRepo', () => {
    it('appends events under PK entityKey / SK ts, chronologically sortable and collision-free', async () => {
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
      await audit.append('contacts#contact-it-1', 'sms_opt_out_recorded', { providerSid: 'SMaudit1' });
      await audit.append('contacts#contact-it-1', 'sms_opt_out_cleared', { providerSid: 'SMaudit2' });

      const { Items } = await doc.send(
        new QueryCommand({
          TableName: tableName('audit_events', testEnv),
          KeyConditionExpression: 'entityKey = :k',
          ExpressionAttributeValues: { ':k': 'contacts#contact-it-1' },
        }),
      );
      const items = (Items ?? []) as { ts: string; event_type: string; payload: Record<string, unknown> }[];
      expect(items).toHaveLength(2);
      // Same-millisecond appends must not collide: the random SK suffix keeps
      // both, so order within a millisecond is unspecified — assert contents.
      expect(new Set(items.map((i) => i.ts)).size).toBe(2);
      expect(items.map((i) => i.event_type).sort()).toEqual([
        'sms_opt_out_cleared',
        'sms_opt_out_recorded',
      ]);
      const recorded = items.find((i) => i.event_type === 'sms_opt_out_recorded')!;
      expect(recorded.payload).toEqual({ providerSid: 'SMaudit1' });
      expect(items.every((i) => /^\d{4}-\d{2}-\d{2}T.*#.{8}$/.test(i.ts))).toBe(true);
    });
  });
});
