// Email-channel A4 integration tests against DynamoDB Local - the messages repo
// carrying MessageType 'email' + the provider-id pointer convention (plan
// F5/F14, pinned):
//   INBOUND  email: providerSid = the RFC Message-ID; the plain sid# pointer IS
//                   the threading lookup (no third pointer).
//   OUTBOUND email: providerSid = the SES MessageId; email_message_id = our own
//                   <hc-...@domain> RFC id, and append() writes a THIRD
//                   emailmsgid#<rfcId> pointer so getByRfcMessageId can follow it.
// Also: dedupe on the same providerSid (the TransactionCanceledException path
// still resolves via the sid pointer read-back with the third item present), and
// the forward-only delivery machine over an email message.
//
// Self-skipping like the other integration suites (see the sibling suites).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createMessagesRepo, type NewMessage } from '../src/repos/messagesRepo.js';
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
    `[messagesRepo.email.integration] SKIPPED - no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

let sidSeq = 500;
const nextSid = (): string => `SID-${++sidSeq}-${randomUUID().slice(0, 8)}`;

describe.skipIf(!reachable)('messagesRepo email against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const messages = createMessagesRepo({ doc, env: testEnv, logger });
  const table = tableName('messages', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  const outboundEmail = (over: Partial<NewMessage> = {}): NewMessage => {
    const sesId = nextSid();
    const rfcId = `<hc-${randomUUID()}@mail.local.test>`;
    return {
      conversationId: `conv-${randomUUID()}`,
      providerSid: sesId, // OUTBOUND: providerSid = SES MessageId
      providerTs: new Date().toISOString(),
      type: 'email',
      direction: 'outbound',
      author: 'teammate',
      subject: 'Welcome',
      body: 'Hello there',
      email_from: 'team@mail.local.test',
      email_to: ['landlord@example.com'],
      email_cc: ['cc@example.com'],
      email_message_id: rfcId,
      deliveryStatus: 'queued',
      rfcMessageIdPointer: rfcId,
      ...over,
    };
  };

  it('append (outbound email, rfcMessageIdPointer set) writes the message + sid# + emailmsgid# pointers; getByRfcMessageId follows emailmsgid#', async () => {
    const msg = outboundEmail();
    const res = await messages.append(msg);
    expect(res.deduped).toBe(false);

    // The email fields persisted on the stored message.
    const bySid = await messages.getByProviderSid(msg.providerSid);
    expect(bySid?.type).toBe('email');
    expect(bySid?.subject).toBe('Welcome');
    expect(bySid?.email_from).toBe('team@mail.local.test');
    expect(bySid?.email_to).toEqual(['landlord@example.com']);
    expect(bySid?.email_cc).toEqual(['cc@example.com']);
    expect(bySid?.email_message_id).toBe(msg.email_message_id);

    // getByRfcMessageId resolves via the emailmsgid# pointer (OUTBOUND: rfc id
    // differs from the SES providerSid).
    const byRfc = await messages.getByRfcMessageId(msg.email_message_id!);
    expect(byRfc?.tsMsgId).toBe(res.tsMsgId);
    expect(byRfc?.provider_sid).toBe(msg.providerSid);

    // Only the message itself lands in the conversation partition (pointers live
    // in their own sid#/emailmsgid# partitions).
    const log = await messages.listByConversation(msg.conversationId);
    expect(log).toHaveLength(1);
  });

  it('append (inbound email, providerSid = the RFC Message-ID, no third pointer); getByRfcMessageId falls back to sid#', async () => {
    const rfcId = `<inbound-${randomUUID()}@sender.example.com>`;
    const res = await messages.append({
      conversationId: `conv-${randomUUID()}`,
      providerSid: rfcId, // INBOUND: providerSid IS the RFC Message-ID
      providerTs: new Date().toISOString(),
      type: 'email',
      direction: 'inbound',
      author: 'landlord',
      subject: 'Re: Welcome',
      body: 'Thanks!',
      email_from: 'landlord@example.com',
      email_to: ['team@mail.local.test'],
      deliveryStatus: 'delivered',
    });
    expect(res.deduped).toBe(false);

    // No emailmsgid# pointer was written; getByRfcMessageId falls back to sid#.
    const byRfc = await messages.getByRfcMessageId(rfcId);
    expect(byRfc?.tsMsgId).toBe(res.tsMsgId);
    expect(byRfc?.direction).toBe('inbound');
  });

  it('append is idempotent on providerSid (the 3-item transaction dedupes via the sid pointer read-back)', async () => {
    const msg = outboundEmail();
    const first = await messages.append(msg);
    const second = await messages.append(msg);
    expect(second.deduped).toBe(true);
    expect(second.tsMsgId).toBe(first.tsMsgId);
    // The rfc-id pointer still resolves to the single persisted message.
    const byRfc = await messages.getByRfcMessageId(msg.email_message_id!);
    expect(byRfc?.tsMsgId).toBe(first.tsMsgId);
  });

  it('the forward-only delivery machine advances an email message (queued -> sent -> delivered)', async () => {
    const msg = outboundEmail();
    await messages.append(msg);
    expect(await messages.updateDeliveryStatus(msg.providerSid, 'sent')).toBe(true);
    expect(await messages.updateDeliveryStatus(msg.providerSid, 'delivered')).toBe(true);
    // Regression is refused (delivered never goes back to sent).
    expect(await messages.updateDeliveryStatus(msg.providerSid, 'sent')).toBe(false);
    const stored = await messages.getByProviderSid(msg.providerSid);
    expect(stored?.delivery_status).toBe('delivered');
  });
});
