// send.reconcile over the REAL repos on DynamoDB Local (SOR spec D11, D15).
//
// The unit suite (sendReconcile.test.ts) drives every verdict over the
// harness twins. What only the real tables can show is the property D11 rests
// on: every write an adoption makes is idempotent, conditional or
// forward-only, so the SAME adoption run twice - here the natural way, a
// process that dies after the adoption's writes and before its record close,
// and the redelivery that completes it - writes each thing ONCE: one message
// row per SID, one relaysid pointer, one slot move, one stats bump, one record
// transition. And an adoption can never regress a slot a receipt already
// advanced.
//
// The provider is a stub adapter (the known-SID path: getMessage). Audit,
// activity and listing-send rows are the harness's in-memory repos - they
// are best-effort follow-ups, not what is proven here. Table names are unique
// per file; ids and SIDs are unique per case.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingAdapter, ProviderMessageSummary } from '../src/adapters/messaging.js';
import { InMemorySchedulerAdapter, InProcessOutboundQueueAdapter } from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueue,
} from '../src/jobs/jobs.js';
import {
  SEND_RECONCILE_JOB,
  registerSendReconcileJobHandler,
  toOwnerRef,
  type SendReconcilePayload,
} from '../src/jobs/sendReconcile.js';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createEventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import { bodyFingerprint, recipientDigest } from '../src/lib/sendFingerprint.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createBroadcastsRepo } from '../src/repos/broadcastsRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createMessagesRepo } from '../src/repos/messagesRepo.js';
import {
  createSendAttemptsRepo,
  type SendAttemptOwner,
  type SendAttemptsRepo,
} from '../src/repos/sendAttemptsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';

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
  console.warn(`[sendReconcile.integration] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

const MAIN = '+15550009999';
const POOL = '+15550109000';
const BODY = 'New listing: 2bd for $1200 near the park - reply YES for a tour';
const LEG_BODY = 'Alice: is the unit still available?';
const TABLES = ['messages', 'broadcasts', 'contacts', 'conversations'] as const;

const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const testEnv = { TABLE_PREFIX: `hc-test-sendreconcile-${randomUUID().slice(0, 8)}-` };
const capture = createLogCapture();
const logger = createLogger({ level: 'info', destination: capture.stream });
const repoDeps = { doc, env: testEnv, logger };
const messages = createMessagesRepo(repoDeps);
const broadcasts = createBroadcastsRepo(repoDeps);
const contacts = createContactsRepo(repoDeps);
const conversations = createConversationsRepo(repoDeps);
const realAttempts = createSendAttemptsRepo(repoDeps);

describe.skipIf(!reachable)('send.reconcile over the real repos (DynamoDB Local)', () => {
  /** The provider's view: the messages the stub adapter answers getMessage from. */
  const provider = new Map<string, ProviderMessageSummary>();
  const adapter = {
    async getMessage(sid: string) {
      return provider.get(sid);
    },
    async listMessages() {
      return { messages: [] };
    },
  } as unknown as MessagingAdapter;
  /** How many times the record close must die (the process that dies after its writes). */
  let dieOnClose = 0;
  const attempts: SendAttemptsRepo = {
    ...realAttempts,
    async closeFromReconcile(...args) {
      if (dieOnClose > 0) {
        dieOnClose -= 1;
        throw new Error('the process died before the record close');
      }
      return realAttempts.closeFromReconcile(...args);
    },
  };
  const events = createEventBus({ logger });
  const emitted: { event: string; payload: unknown }[] = [];
  events.on('message.persisted', (payload) => emitted.push({ event: 'message.persisted', payload }));
  events.on('broadcast.updated', (payload) => emitted.push({ event: 'broadcast.updated', payload }));
  let outbound: InProcessOutboundQueueAdapter;

  beforeAll(async () => {
    for (const base of TABLES) await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
  }, 120_000);

  afterAll(async () => {
    for (const base of TABLES) await deleteTableIfExists(client, tableName(base, testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, logger });
    configureOutboundQueue(outbound);
    const fakes = createFakeWorld();
    registerSendReconcileJobHandler({
      adapter,
      messagesRepo: messages,
      broadcastsRepo: broadcasts,
      contactsRepo: contacts,
      conversationsRepo: conversations,
      sendAttemptsRepo: attempts,
      activityEventsRepo: fakes.activityEventsRepo,
      listingSendsRepo: fakes.listingSendsRepo,
      auditRepo: fakes.auditRepo,
      events,
      logger,
    });
    dieOnClose = 0;
    emitted.length = 0;
  });

  /** Dispatch one check from a real envelope; a handler throw propagates (a delayed dispatch rethrows). */
  async function runCheck(payload: SendReconcilePayload): Promise<void> {
    const envelope = await enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + 600_000) });
    const index = outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId);
    const [item] = outbound.delayed.splice(index, 1);
    await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)) as unknown);
  }

  /** Claim and hand to reconcile WITH a known SID - a send that landed but was not recorded (D7a). */
  async function reconcilingWithSid(owner: SendAttemptOwner, sender: string, phone: string, body: string, sid: string): Promise<string> {
    const at = new Date().toISOString();
    const fp = bodyFingerprint(body);
    const claimed = await realAttempts.claim(
      owner,
      { recipientDigest: recipientDigest(sender, phone), sender, bodyHash: fp.hash, bodyShort: fp.short, mediaCount: 0 },
      at,
    );
    expect(claimed.outcome).toBe('claimed');
    expect(await realAttempts.handToReconcile(owner, { attemptNo: 1, attemptedAt: at }, sid)).toBe(true);
    return at;
  }

  async function seedBroadcast(id: string, contactId: string, phone: string): Promise<void> {
    expect(
      await contacts.createIfAbsent({ contactId, type: 'tenant', status: 'active', phone, consent_method: 'inbound_text' }),
    ).toBe(true);
    await broadcasts.create({
      broadcastId: id,
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: BODY,
    });
    await broadcasts.markSending(id, { [contactId]: { status: 'queued' } });
  }

  it('a broadcast adoption that dies before its record close is COMPLETED by the redelivery: one row, one slot move, one stats bump, one record transition', async () => {
    const u = randomUUID().slice(0, 8);
    const broadcastId = `b-${u}`;
    const contactId = `t-${u}`;
    const phone = `+1555${String(Date.now()).slice(-7)}`;
    const sid = `SMb-${u}`;
    await seedBroadcast(broadcastId, contactId, phone);
    const owner: SendAttemptOwner = { kind: 'broadcast', broadcastId, contactKey: contactId };
    const at = await reconcilingWithSid(owner, MAIN, phone, BODY, sid);
    const sentAt = new Date().toISOString();
    provider.set(sid, { providerSid: sid, providerStatus: 'delivered', body: BODY, mediaCount: 0, createdAt: sentAt, sentAt });
    const payload: SendReconcilePayload = { owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 };

    dieOnClose = 1;
    await expect(runCheck(payload)).rejects.toThrow('the process died before the record close');
    const afterFirst = await broadcasts.getByIdConsistent(broadcastId);
    expect(afterFirst!.recipients[contactId]).toMatchObject({ status: 'delivered', carrierSentAt: sentAt });
    expect(afterFirst!.stats).toMatchObject({ delivered: 1, queued: 0 });
    expect(await realAttempts.get(owner)).toMatchObject({ state: 'reconciling', checkNo: 1 });

    // The redelivery: the same check, the same attempt.
    await runCheck(payload);
    const row = await messages.getByProviderSidConsistent(sid);
    expect(row).toMatchObject({ broadcast_id: broadcastId, recipient_contact_id: contactId, automated: true, delivery_status: 'delivered' });
    const rows = await messages.listByConversationConsistent(row!.conversationId, { limit: 50 });
    expect(rows.filter((m) => m.provider_sid === sid)).toHaveLength(1);
    const afterSecond = await broadcasts.getByIdConsistent(broadcastId);
    expect(afterSecond!.recipients[contactId]).toEqual(afterFirst!.recipients[contactId]);
    expect(afterSecond!.recipients[contactId]).toMatchObject({ conversationId: row!.conversationId, tsMsgId: row!.tsMsgId });
    expect(afterSecond!.stats).toMatchObject({ delivered: 1, queued: 0 });
    expect(await realAttempts.get(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid, checkNo: 1 });
    // The slot moved once, so it was announced once; the finalize flipped once.
    expect(afterSecond!.status).toBe('sent');
    const ticks = emitted.filter((e) => e.event === 'broadcast.updated');
    expect(ticks.map((e) => (e.payload as { status: string }).status)).toEqual(['sending', 'sent']);

    // A third delivery finds the attempt closed: nothing is written again.
    await runCheck(payload);
    expect((await broadcasts.getByIdConsistent(broadcastId))!.stats).toMatchObject({ delivered: 1, queued: 0 });
    expect(await realAttempts.get(owner)).toMatchObject({ state: 'done', outcome: 'adopted' });
  }, 60_000);

  it('a relay-leg adoption that dies before its record close is COMPLETED by the redelivery: one pointer, one slot state, one record transition', async () => {
    const u = randomUUID().slice(0, 8);
    const conversationId = `conv-relay-${u}`;
    const sid = `SMr-${u}`;
    const bob = `+1555${String(Date.now()).slice(-7)}`;
    const source = await messages.append({
      conversationId,
      providerSid: `SMin-${u}`,
      providerTs: new Date(Date.now() - 5000).toISOString(),
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      body: 'is the unit still available?',
      deliveryStatus: 'delivered',
      relaySenderKey: 'c-alice',
      // A LEGACY source (no schema version), Bob's slot deferred once with a transient code.
      deliveryRecipients: { 'c-bob': { status: 'queued', errorCode: 'send_retryable' } },
    });
    const owner: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: conversationId, sourceTsMsgId: source.tsMsgId, memberKey: 'c-bob' };
    const at = await reconcilingWithSid(owner, POOL, bob, LEG_BODY, sid);
    const createdAt = new Date().toISOString();
    provider.set(sid, { providerSid: sid, providerStatus: 'sent', body: LEG_BODY, mediaCount: 0, createdAt, sentAt: createdAt });
    const payload: SendReconcilePayload = { owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0, continuation: { senderKey: 'c-alice' } };

    dieOnClose = 1;
    await expect(runCheck(payload)).rejects.toThrow('the process died before the record close');
    const slotAfterFirst = (await messages.getByTsMsgIdConsistent(conversationId, source.tsMsgId))!.delivery_recipients!['c-bob'];
    // Adopted forward; the stale transient code is gone with it (the carried legacy fix).
    expect(slotAfterFirst).toEqual({ status: 'sent', sid, sentAt: createdAt });
    expect(await messages.getRelaySidPointerConsistent(sid)).toEqual({ conversationId, tsMsgId: source.tsMsgId, memberKey: 'c-bob' });

    await runCheck(payload);
    const slotAfterSecond = (await messages.getByTsMsgIdConsistent(conversationId, source.tsMsgId))!.delivery_recipients!['c-bob'];
    expect(slotAfterSecond).toEqual(slotAfterFirst);
    // The pointer is claimed once; the redelivery's claim reads it back as this leg's.
    expect(await messages.claimRelaySidPointer(sid, { conversationId, tsMsgId: source.tsMsgId, memberKey: 'c-bob' })).toBe('mine');
    expect(await realAttempts.get(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid });
    // Every adoption that wrote the slot told the thread, in the webhook's shape (A1).
    expect(emitted.filter((e) => e.event === 'message.persisted').map((e) => e.payload)).toContainEqual({
      conversationId,
      tsMsgId: source.tsMsgId,
      direction: 'inbound',
      deliveryStatus: 'sent',
    });
  }, 60_000);

  it('an adoption never regresses a slot a receipt already advanced: the relay leg stays delivered, the broadcast slot stays delivered, and both still close adopted', async () => {
    const u = randomUUID().slice(0, 8);
    // Relay: a receipt moved the slot to delivered before the (stale) adoption of `sent`.
    const conversationId = `conv-relay-${u}`;
    const sid = `SMr-${u}`;
    const bob = `+1555${String(Date.now()).slice(-7)}`;
    const source = await messages.append({
      conversationId,
      providerSid: `SMin-${u}`,
      providerTs: new Date(Date.now() - 5000).toISOString(),
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      body: 'is the unit still available?',
      deliveryStatus: 'delivered',
      relaySenderKey: 'c-alice',
      deliveryRecipients: { 'c-bob': { status: 'queued' } },
    });
    const leg: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: conversationId, sourceTsMsgId: source.tsMsgId, memberKey: 'c-bob' };
    const atLeg = await reconcilingWithSid(leg, POOL, bob, LEG_BODY, sid);
    expect(await messages.updateRecipientDeliveryStatus(conversationId, source.tsMsgId, 'c-bob', 'delivered')).toBe(true);
    provider.set(sid, { providerSid: sid, providerStatus: 'sent', body: LEG_BODY, mediaCount: 0, createdAt: new Date().toISOString() });
    await runCheck({ owner: toOwnerRef(leg), attemptedAt: atLeg, checkNo: 0, continuation: { senderKey: 'c-alice' } });
    expect((await messages.getByTsMsgIdConsistent(conversationId, source.tsMsgId))!.delivery_recipients!['c-bob']).toMatchObject({
      status: 'delivered',
    });
    expect(await realAttempts.get(leg)).toMatchObject({ state: 'done', outcome: 'adopted', sid });

    // Broadcast: the slot already reads delivered; the adoption of a stale `sent` moves nothing and bumps nothing.
    const broadcastId = `b-${u}`;
    const contactId = `t-${u}`;
    const phone = `+1555${String(Date.now() + 1).slice(-7)}`;
    const bsid = `SMb-${u}`;
    await seedBroadcast(broadcastId, contactId, phone);
    const owner: SendAttemptOwner = { kind: 'broadcast', broadcastId, contactKey: contactId };
    const at = await reconcilingWithSid(owner, MAIN, phone, BODY, bsid);
    expect(await broadcasts.setRecipient(broadcastId, contactId, { status: 'delivered', conversationId: 'conv-x', tsMsgId: 'ts-x' }, ['queued'])).toBe(true);
    provider.set(bsid, { providerSid: bsid, providerStatus: 'sent', body: BODY, mediaCount: 0, createdAt: new Date().toISOString() });
    await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 });
    const b = await broadcasts.getByIdConsistent(broadcastId);
    expect(b!.recipients[contactId]).toEqual({ status: 'delivered', conversationId: 'conv-x', tsMsgId: 'ts-x' });
    expect(b!.stats).toMatchObject({ sent: 0, delivered: 0, queued: 1 });
    expect(await realAttempts.get(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: bsid });
  }, 60_000);
});
