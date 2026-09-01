// relay.fanOut + relay.intro (M1.7) — the milestone golden tests for the
// fan-out job in isolation: stored-once + fan-out to OTHER members only,
// sender-prefixed, per-recipient delivery states, idempotency, mid-thread
// membership, removed-member, transient/permanent error handling, and the
// intro naming every member. Driven through the real jobs envelope machinery
// (enqueue → InMemoryScheduler/InProcessOutboundQueue → dispatchJob) so the
// jobId-marker idempotency guard is exercised for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import type { SendMessageParams } from '../src/adapters/messaging.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  RELAY_FANOUT_JOB,
  RELAY_INTRO_JOB,
  RELAY_MEMBER_ADDED_JOB,
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
  composeIntroBody,
  composeMemberAddedBody,
  composeRelayBody,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import { buildTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';
import { resolveMessage } from '../src/messages/index.js';
import { TRANSPORT_SCHEMA_VERSION } from '../src/lib/messageTransport.js';
import { flushQueuedMessages } from '../src/services/relayQueuedMessages.js';

const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const CAROL = '+15550100003';

function seedRelay(world: FakeWorld, overrides: Partial<ConversationItem> = {}): ConversationItem {
  const now = new Date().toISOString();
  const conv: ConversationItem = {
    conversationId: 'conv-relay-1',
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: now,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
    ],
    created_at: now,
    ...overrides,
  };
  world.conversations.set(conv.conversationId, conv);
  return conv;
}

/** Seed an inbound source message on the relay thread (as the webhook would). */
function seedSource(world: FakeWorld, body: string, senderKey: string): MessageItem {
  const providerTs = new Date().toISOString();
  const tsMsgId = buildTsMsgId(providerTs, 'SMrelay-in-1');
  const item: MessageItem = {
    conversationId: 'conv-relay-1',
    tsMsgId,
    type: 'sms',
    direction: 'inbound',
    author: 'unknown',
    body,
    provider_sid: 'SMrelay-in-1',
    provider_ts: providerTs,
    delivery_status: 'delivered',
    created_at: providerTs,
    relay_sender_key: senderKey,
  };
  world.messages.push(item);
  return item;
}

function seedVersionedSource(
  world: FakeWorld,
  body: string,
  senderKey: string,
  overrides: Partial<MessageItem> = {},
): MessageItem {
  const source = seedSource(world, body, senderKey);
  source.transport_schema_version = TRANSPORT_SCHEMA_VERSION;
  source.requested_transport = 'sms';
  source.delivery_recipients = {};
  Object.assign(source, overrides);
  return source;
}

describe('relay.fanOut (M1.7)', () => {
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;
  let capture: ReturnType<typeof createLogCapture>;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    // The delay refactor routes the <=12min transient continuation (5/10/20s)
    // through the SQS path (outbound adapter), NOT EventBridge. In tests the
    // InProcess adapter dispatches immediate jobs in-process and RECORDS delayed
    // ones in `delayed[]` for assertions (no real sleep).
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, logger });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    _resetForTests();
  });

  it('stored once + fans out to the OTHER members only, sender-prefixed, never to the sender', async () => {
    seedRelay(world);
    const source = seedSource(world, 'is the unit still available?', 'c-alice');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // Stored ONCE — no extra outbound message copies were appended.
    expect(world.messages.filter((m) => m.conversationId === 'conv-relay-1')).toHaveLength(1);

    // Two sends (Bob + Carol), never Alice; all FROM the pool number; prefixed.
    const recipients = world.sent.map((s: SendMessageParams) => s.to).sort();
    expect(recipients).toEqual([BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    expect(world.sent.every((s) => s.body === 'Alice: is the unit still available?')).toBe(true);
    expect(world.sent.some((s) => s.to === ALICE)).toBe(false);

    // Per-recipient delivery states recorded on the SOURCE message.
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(Object.keys(stored.delivery_recipients ?? {}).sort()).toEqual(['c-bob', 'c-carol']);
    expect(stored.delivery_recipients?.['c-bob']?.status).toBe('queued'); // fake adapter returns 'queued'
    expect(stored.delivery_recipients?.['c-bob']?.sid).toMatch(/^SMfake-out-/);

    // A relaysid pointer was written per recipient (delivery-callback routing).
    expect(world.relaySidPointers.size).toBe(2);
  });

  it('keeps the schema-absent path mechanically free of transport hooks for a continuation', async () => {
    seedRelay(world);
    const source = seedSource(world, 'legacy continuation', 'c-alice');
    const classify = vi.spyOn(world.adapter, 'classifyMessageTransport');
    const prepare = vi.spyOn(world.adapter, 'prepareMessageSend');
    const initialize = vi.spyOn(world.messagesRepo, 'initializeRecipientDelivery');
    const aggregate = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
    const apply = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
      attempt: 2,
      recipientKeys: ['c-carol'],
    });
    await outbound.settle();

    expect(world.sent.map((sent) => sent.to)).toEqual([CAROL]);
    expect(source.delivery_recipients?.['c-carol']?.sid).toMatch(/^SMfake-out-/);
    expect(classify).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('preflights every filtered eligible v1 slot before provider call zero', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'versioned', 'c-alice');
    const sourceRead = vi.spyOn(world.messagesRepo, 'listByConversation');
    const initialize = vi.spyOn(world.messagesRepo, 'initializeRecipientDelivery');
    const legacyWrite = vi.spyOn(world.messagesRepo, 'setRecipientDelivery');
    const snapshots: Array<Record<string, unknown>> = [];
    const originalSend = world.adapter.sendPreparedMessage.bind(world.adapter);
    vi.spyOn(world.adapter, 'sendPreparedMessage').mockImplementation(async (prepared) => {
      snapshots.push(structuredClone(source.delivery_recipients ?? {}));
      return originalSend(prepared);
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
      recipientKeys: ['c-bob', 'c-carol'],
    });
    await outbound.settle();

    expect(source.delivery_recipients?.['c-alice']).toBeUndefined();
    expect(sourceRead.mock.invocationCallOrder[0]).toBeLessThan(
      initialize.mock.invocationCallOrder[0]!,
    );
    expect(legacyWrite).not.toHaveBeenCalled();
    expect(Object.keys(snapshots[0] ?? {}).sort()).toEqual(['c-bob', 'c-carol']);
    expect(snapshots[0]).toMatchObject({
      'c-bob': { requestedTransport: 'sms' },
      'c-carol': { requestedTransport: 'sms', transportAggregationState: 'planned' },
    });
    expect(source.delivery_recipients).toMatchObject({
      'c-bob': {
        status: 'queued',
        requestedTransport: 'sms',
        actualTransport: 'sms',
        transportAggregationState: 'attempted',
      },
      'c-carol': {
        status: 'queued',
        requestedTransport: 'sms',
        actualTransport: 'sms',
        transportAggregationState: 'attempted',
      },
    });
  });

  it('aborts a v1 execution before provider call zero when preflight cannot initialize a slot', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'preflight failure', 'c-alice');
    const initialize = vi
      .spyOn(world.messagesRepo, 'initializeRecipientDelivery')
      .mockResolvedValue('missing');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    expect(world.sent).toHaveLength(0);
    expect(initialize).toHaveBeenCalled();
  });

  it('reconciles stale planned slots, preserves attempted slots, and excludes suppression', async () => {
    const conversation = seedRelay(world);
    conversation.participants = conversation.participants?.slice(0, 2);
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: BOB, sms_opt_out: true });
    const source = seedVersionedSource(world, 'states', 'c-alice', {
      delivery_recipients: {
        'c-alice': { status: 'queued', requestedTransport: 'sms' },
        'c-bob': {
          status: 'queued',
          requestedTransport: 'sms',
          transportAggregationState: 'planned',
        },
        'c-carol': {
          status: 'queued',
          requestedTransport: 'sms',
          transportAggregationState: 'attempted',
        },
        'c-removed': {
          status: 'queued',
          requestedTransport: 'sms',
          transportAggregationState: 'planned',
        },
      },
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    expect(source.delivery_recipients?.['c-alice']?.transportAggregationState).toBe('excluded');
    expect(source.delivery_recipients?.['c-bob']).toMatchObject({
      status: 'failed',
      errorCode: 'contact_opted_out',
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
    });
    expect(source.delivery_recipients?.['c-bob']?.actualTransport).toBeUndefined();
    expect(source.delivery_recipients?.['c-carol']?.transportAggregationState).toBe('attempted');
    expect(source.delivery_recipients?.['c-removed']?.transportAggregationState).toBe('excluded');
  });

  it('keeps a current continuation-omitted recipient planned while sending only the continuation roster', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'continuation roster', 'c-alice', {
      delivery_recipients: {
        'c-bob': {
          status: 'queued',
          requestedTransport: 'sms',
          transportAggregationState: 'planned',
        },
        'c-carol': {
          status: 'queued',
          requestedTransport: 'sms',
          transportAggregationState: 'planned',
        },
      },
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
      attempt: 2,
      recipientKeys: ['c-bob'],
    });
    await outbound.settle();

    expect(world.sent.map((sent) => sent.to)).toEqual([BOB]);
    expect(source.delivery_recipients?.['c-carol']).toMatchObject({
      status: 'queued',
      requestedTransport: 'sms',
      transportAggregationState: 'planned',
    });
  });

  it('keeps a suppressed excluded continuation slot out of provider handling', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'suppressed continuation', 'c-alice', {
      delivery_recipients: {
        'c-bob': {
          status: 'failed',
          errorCode: 'contact_opted_out',
          requestedTransport: 'sms',
          transportAggregationState: 'excluded',
        },
      },
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
      attempt: 2,
      recipientKeys: ['c-bob'],
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    expect(source.delivery_recipients?.['c-bob']).toMatchObject({
      status: 'failed',
      errorCode: 'contact_opted_out',
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
    });
  });

  it('reopens a never-attempted non-suppressed excluded member who has rejoined', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'rejoined member', 'c-alice', {
      delivery_recipients: {
        'c-bob': {
          status: 'queued',
          requestedTransport: 'sms',
          transportAggregationState: 'excluded',
        },
      },
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
      recipientKeys: ['c-bob'],
    });
    await outbound.settle();

    expect(world.sent.map((sent) => sent.to)).toEqual([BOB]);
    expect(source.delivery_recipients?.['c-bob']).toMatchObject({
      status: 'queued',
      requestedTransport: 'sms',
      actualTransport: 'sms',
      transportAggregationState: 'attempted',
    });
  });

  it('preserves first callback pointers while a v1 continuation adds actual evidence and clears transient error', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'retry', 'c-alice', {
      delivery_recipients: {
        'c-bob': {
          status: 'queued',
          sid: 'SMfirst',
          sentAt: '2026-08-31T12:00:00.000Z',
          errorCode: '30022',
          requestedTransport: 'sms',
          transportAggregationState: 'attempted',
        },
      },
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
      attempt: 2,
      recipientKeys: ['c-bob'],
    });
    await outbound.settle();

    expect(source.delivery_recipients?.['c-bob']).toMatchObject({
      status: 'queued',
      sid: 'SMfirst',
      sentAt: '2026-08-31T12:00:00.000Z',
      requestedTransport: 'sms',
      actualTransport: 'sms',
      transportAggregationState: 'attempted',
    });
    expect(source.delivery_recipients?.['c-bob']?.errorCode).toBeUndefined();
    expect(world.relaySidPointers.size).toBe(1);
  });

  it('keeps a schema-absent queued_pending release on the exact legacy path', async () => {
    seedRelay(world);
    const source = seedSource(world, 'held legacy', TEAM_SENDER_KEY);
    source.direction = 'outbound';
    source.delivery_status = 'queued_pending';
    const classify = vi.spyOn(world.adapter, 'classifyMessageTransport');
    const apply = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');

    await flushQueuedMessages('conv-relay-1', {
      messagesRepo: world.messagesRepo,
      logger: createLogger({ level: 'info', destination: capture.stream }),
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(3);
    expect(source.delivery_status).toBe('queued');
    expect(classify).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('preserves a durable mms request when unavailable media storage reclassifies execution to sms', async () => {
    seedRelay(world);
    const source = seedVersionedSource(world, 'media fallback', 'c-alice', {
      type: 'mms',
      requested_transport: 'mms',
      media_attachments: [{ s3Key: 'uploads/unavailable-key', contentType: 'image/png' }],
      delivery_recipients: {
        'c-bob': { status: 'queued', requestedTransport: 'mms' },
        'c-carol': { status: 'queued', requestedTransport: 'mms' },
      },
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(2);
    expect(world.sent.every((sent) => sent.mediaUrls === undefined)).toBe(true);
    expect(source.requested_transport).toBe('mms');
    expect(source.delivery_recipients).toMatchObject({
      'c-bob': { requestedTransport: 'mms', actualTransport: 'sms' },
      'c-carol': { requestedTransport: 'mms', actualTransport: 'sms' },
    });
    expect(
      capture.lines.filter(
        (line) =>
          line['msg'] ===
          'relayFanOut: persisted transport intent differs from execution classification',
      ),
    ).toHaveLength(1);
  });

  it('does NOT fan out when the group closed after the message was enqueued (status gate, AF-2)', async () => {
    // Enqueued while OPEN, but the group is CLOSED before the queued job runs.
    // pool_number is KEPT on close (burn-multiplexing), so the pool-number guard
    // alone would let this through - the status gate is what stops it.
    const conv = seedRelay(world);
    const source = seedSource(world, 'is the unit still available?', 'c-alice');
    conv.status = 'closed';
    world.conversations.set(conv.conversationId, conv);

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // Zero adapter sends - a closed group never fans out (never contradicts the
    // "This group chat is now closed" final message).
    expect(world.sent).toHaveLength(0);
    // No per-recipient delivery slots were written on the source message either.
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(Object.keys(stored.delivery_recipients ?? {})).toHaveLength(0);
  });

  it('does NOT fan out a RELAY thread that has lost its pool number', async () => {
    // NAMED FOR WHAT IT SEEDS. This is a relay_group row with pool_number
    // deleted - there is no group_text anywhere in it, so it never proved
    // anything about native group texting. What it does prove is real and worth
    // keeping: the no-pool-number refusal stops the fan-out from addressing an
    // undefined `from` instead of the members' handsets. The native group_text
    // exclusion is the test directly below.
    const conv = seedRelay(world);
    const source = seedSource(world, 'hello everyone', 'c-alice');
    delete (conv as { pool_number?: string }).pool_number;
    world.conversations.set(conv.conversationId, conv);

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(Object.keys(stored.delivery_recipients ?? {})).toHaveLength(0);
  });

  it('a NATIVE group_text never fans out - its group_open status fails the AF-2 gate first', async () => {
    // The real group_text exclusion, with a real group_text row. Nothing
    // enqueues this job for a group thread today (spec 4.2: no pool number, no
    // fan-out), so the value here is that a future caller which DID would be
    // refused rather than blasting the roster from an undefined `from`.
    //
    // WHICH gate fires is asserted, not just "nothing was sent": the status gate
    // and the pool-number gate BOTH independently refuse a group_text, so an
    // outcome-only assertion would survive deleting either one. Pinning the log
    // line makes this test fail when the status gate goes.
    const conv = seedRelay(world, {
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    delete (conv as { pool_number?: string }).pool_number;
    delete (conv as { participant_phone?: string }).participant_phone;
    world.conversations.set(conv.conversationId, conv);
    const source = seedSource(world, 'hello everyone', 'c-alice');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(Object.keys(stored.delivery_recipients ?? {})).toHaveLength(0);
    const skipped = capture.lines.find(
      (l) => l['msg'] === 'relay fan-out skipped - group not open',
    );
    expect(skipped).toBeDefined();
    expect(skipped?.['status']).toBe(GROUP_TEXT_STATUS);
  });

  it('does NOT relay to an opted-out member — marks the slot failed/contact_opted_out, still sends the others', async () => {
    seedRelay(world);
    // Bob STOP'd — contact-level sms_opt_out set. Relay must skip him.
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: BOB, sms_opt_out: true });
    const source = seedSource(world, 'is the unit still available?', 'c-alice');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // Carol receives; Bob (opted out) NEVER does.
    const recipients = world.sent.map((s: SendMessageParams) => s.to);
    expect(recipients).toEqual([CAROL]);
    expect(world.sent.some((s) => s.to === BOB)).toBe(false);

    // Bob's slot is recorded failed/contact_opted_out so the thread + Today
    // attention surface can show he is suppressed (not a silent drop).
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(stored.delivery_recipients?.['c-bob']).toMatchObject({
      status: 'failed',
      errorCode: 'contact_opted_out',
    });
    expect(stored.delivery_recipients?.['c-carol']?.status).toBe('queued');
  });

  it('does NOT relay to a member suppressed ONLY via the 1:1 conversation flag (BE1 per-phone scope)', async () => {
    seedRelay(world);
    // Bob's CONTACT carries no flag, but his phone's OWN 1:1 conversation is
    // flagged sms_opt_out (a STOP he texted from a secondary attached number).
    // The leg gate must honor that per-phone 1:1 flag and skip him just the same.
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: BOB });
    const now = new Date().toISOString();
    world.conversations.set('conv-1to1-bob', {
      conversationId: 'conv-1to1-bob',
      participant_phone: BOB,
      status: 'open',
      last_activity_at: now,
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: now,
      sms_opt_out: true,
    });
    const source = seedSource(world, 'is the unit still available?', 'c-alice');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // Carol receives; Bob (1:1-flagged) NEVER does.
    const recipients = world.sent.map((s: SendMessageParams) => s.to);
    expect(recipients).toEqual([CAROL]);
    expect(world.sent.some((s) => s.to === BOB)).toBe(false);

    // Bob's slot reaches the same terminal failed/contact_opted_out state and he
    // is annotated on the conversation so Today can surface the suppression.
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(stored.delivery_recipients?.['c-bob']).toMatchObject({
      status: 'failed',
      errorCode: 'contact_opted_out',
    });
    expect(stored.delivery_recipients?.['c-carol']?.status).toBe('queued');
    const conv = world.conversations.get('conv-relay-1')!;
    expect(conv.relay_opted_out_members?.['c-bob']).toMatchObject({
      contactId: 'c-bob',
      phone: BOB,
      name: 'Bob',
    });
  });

  it('records the opted-out member on the CONVERSATION (relay_opted_out_members) so Today can surface it', async () => {
    seedRelay(world);
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: BOB, sms_opt_out: true });
    const source = seedSource(world, 'is the unit still available?', 'c-alice');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // The conversation now carries Bob's opt-out (keyed by his relayMemberKey =
    // contactId), with his display data for the Today item + the observed instant.
    const conv = world.conversations.get('conv-relay-1')!;
    expect(conv.relay_opted_out_members?.['c-bob']).toMatchObject({
      contactId: 'c-bob',
      phone: BOB,
      name: 'Bob',
    });
    expect(typeof conv.relay_opted_out_members?.['c-bob']?.at).toBe('string');
    // Only the opted-out member is recorded (Carol received, is not annotated).
    expect(Object.keys(conv.relay_opted_out_members ?? {})).toEqual(['c-bob']);
  });

  it('relay intro skips an opted-out member', async () => {
    seedRelay(world);
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: BOB, sms_opt_out: true });

    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    await outbound.settle();

    const recipients = world.sent.map((s: SendMessageParams) => s.to).sort();
    expect(recipients).toEqual([ALICE, CAROL].sort()); // Bob skipped
    expect(world.sent.some((s) => s.to === BOB)).toBe(false);
  });

  it('uses a neutral label (never the phone) when the sender has no name', async () => {
    seedRelay(world, {
      participants: [
        { contactId: 'c-alice', phone: ALICE }, // no name
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const source = seedSource(world, 'hello', 'c-alice');
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.to).toBe(BOB);
    expect(world.sent[0]!.body).not.toContain(ALICE); // never leak the phone
    expect(world.sent[0]!.body).toMatch(/^A member: hello$/);
  });

  it('membership change mid-thread: a removed member is NOT fanned to on the next inbound', async () => {
    const conv = seedRelay(world);
    // Remove Carol BEFORE the fan-out (membership resolved at execution time).
    conv.participants = conv.participants!.filter((p) => p.phone !== CAROL);
    const source = seedSource(world, 'update', 'c-alice');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([BOB]); // Carol gone, only Bob
  });

  it('FIX 2: a TEAM message (senderKey sentinel + override label) fans out to ALL members, neutral label, never a phone', async () => {
    seedRelay(world);
    // A team-authored OUTBOUND source message — no member sender.
    const providerTs = new Date().toISOString();
    const tsMsgId = buildTsMsgId(providerTs, 'team-src-1');
    world.messages.push({
      conversationId: 'conv-relay-1',
      tsMsgId,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Open house Saturday',
      provider_sid: 'team-src-1',
      provider_ts: providerTs,
      delivery_status: 'queued',
      created_at: providerTs,
      relay_sender_key: TEAM_SENDER_KEY,
    });

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: tsMsgId,
      senderKey: TEAM_SENDER_KEY,
      senderNameOverride: TEAM_SENDER_LABEL,
    });
    await outbound.settle();

    // The sentinel matches no member → NOBODY is excluded (all three receive it).
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    // Neutral team label prefix, NEVER a phone.
    expect(world.sent.every((s) => s.body === `${TEAM_SENDER_LABEL}: Open house Saturday`)).toBe(true);
    expect(world.sent.some((s) => s.body?.includes(ALICE) || s.body?.includes(BOB))).toBe(false);
  });

  it('idempotency: a redelivered fan-out (same jobId) never double-sends', async () => {
    seedRelay(world);
    const source = seedSource(world, 'hi', 'c-alice');
    const envelope = await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    expect(world.sent).toHaveLength(2);

    // Re-dispatch the SAME envelope (SQS at-least-once redelivery): the jobId
    // marker suppresses it — no further sends.
    await dispatchJob(JSON.parse(JSON.stringify(envelope)));
    expect(world.sent).toHaveLength(2);
  });

  it('per-recipient idempotency: a continuation skips recipients already terminal', async () => {
    seedRelay(world);
    const source = seedSource(world, 'hi', 'c-alice');
    // Pre-mark Bob as already 'sent' (a prior partial fan-out).
    await world.messagesRepo.setRecipientDelivery('conv-relay-1', source.tsMsgId, 'c-bob', {
      status: 'sent',
      sid: 'SMprev',
    });
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    // Only Carol is sent — Bob was already terminal.
    expect(world.sent.map((s) => s.to)).toEqual([CAROL]);
  });

  it('30007 carrier filtering: recipient marked failed, NEVER retried', async () => {
    seedRelay(world, { participants: [{ contactId: 'c-alice', phone: ALICE, name: 'Alice' }, { contactId: 'c-bob', phone: BOB, name: 'Bob' }] });
    const source = seedSource(world, 'hi', 'c-alice');
    // Adapter throws a 30007 for Bob.
    world.adapter.sendMessage = async (params: SendMessageParams) => {
      if (params.to === BOB) throw Object.assign(new Error('filtered'), { code: 30007 });
      return { providerSid: 'SMx', status: 'sent', providerTs: new Date().toISOString() };
    };
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(stored.delivery_recipients?.['c-bob']?.status).toBe('failed');
    expect(stored.delivery_recipients?.['c-bob']?.errorCode).toBe('30007');
  });

  it('429/30022 transient: defers the recipient and enqueues a continuation with backoff (capped)', async () => {
    seedRelay(world, { participants: [{ contactId: 'c-alice', phone: ALICE, name: 'Alice' }, { contactId: 'c-bob', phone: BOB, name: 'Bob' }] });
    const source = seedSource(world, 'hi', 'c-alice');
    world.adapter.sendMessage = async (params: SendMessageParams) => {
      if (params.to === BOB) throw Object.assign(new Error('rate limited'), { code: 429 });
      return { providerSid: 'SMx', status: 'sent', providerTs: new Date().toISOString() };
    };
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    // A continuation relay.fanOut was enqueued for the remaining recipient via
    // the SQS path with an EXACT DelaySeconds backoff (5s for attempt 1, NOT
    // clamped to 60s) — recorded as a delayed outbound job, not an EventBridge
    // schedule.
    expect(outbound.delayed).toHaveLength(1);
    const cont = outbound.delayed[0]!.envelope;
    expect(cont.jobName).toBe(RELAY_FANOUT_JOB);
    const payload = cont.payload as { recipientKeys?: string[]; attempt?: number };
    expect(payload.recipientKeys).toEqual(['c-bob']);
    expect(payload.attempt).toBe(2);
    // fanOutBackoffMs(attempt 1) = 5s → DelaySeconds 5 (exact, no 60s floor).
    expect(outbound.delayed[0]!.delaySeconds).toBe(5);
  });

  it('SendRefusedError (opt-out/breaker): marks that recipient failed and continues with others', async () => {
    seedRelay(world);
    const source = seedSource(world, 'hi', 'c-alice');
    const { ContactOptedOutError } = await import('../src/services/sendMessage.js');
    world.adapter.sendMessage = async (params: SendMessageParams) => {
      if (params.to === BOB) throw new ContactOptedOutError('conv-relay-1');
      return { providerSid: `SMx-${params.to}`, status: 'sent', providerTs: new Date().toISOString() };
    };
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(stored.delivery_recipients?.['c-bob']?.status).toBe('failed');
    expect(stored.delivery_recipients?.['c-carol']?.status).toBe('sent');
  });

  it('relay.intro names every member and sends to each', async () => {
    seedRelay(world);
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    await outbound.settle();
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    // Each intro body names all three.
    for (const sent of world.sent) {
      expect(sent.body).toContain('Alice');
      expect(sent.body).toContain('Bob');
      expect(sent.body).toContain('Carol');
    }
  });

  // Operator-edited intro (2026-08-20). The confirm dialog stores what the
  // operator typed on the CONVERSATION - not on the job payload - because a
  // connecting group sends its intro only once relay.numberReady fires, and
  // quiet hours can defer it further. So the job reads it back off the row.
  it('relay.intro sends the OPERATOR-EDITED body verbatim when one was stored', async () => {
    const edited =
      "Hi Alice, this is Sam. Putting you in a group text with Bob. We're excited to have you move into 12 Peachtree St!";
    seedRelay(world, { intro_body: edited });
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    // Verbatim to EVERY member - not merged with the composed copy, not
    // re-wrapped, and the composed sentence is gone entirely.
    for (const sent of world.sent) {
      expect(sent.body).toBe(edited);
      expect(sent.body).not.toContain("You're now connected with");
    }
  });

  it('relay.intro falls back to the composed default when the stored body is blank', async () => {
    // Defensive: a legacy/hand-edited row carrying an empty string must not send
    // a blank first-contact text.
    seedRelay(world, { intro_body: '' });
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    await outbound.settle();
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) {
      expect(sent.body).toContain("You're now connected with");
    }
  });

  // Founder decision 2026-07-14: everything sent into a relay group must be
  // visible in its dashboard thread — the intro persists as a SYSTEM row.
  it('relay.intro PERSISTS one system announcement row with per-member delivery slots', async () => {
    seedRelay(world);
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    await outbound.settle();

    const rows = world.messages.filter((m) => m.conversationId === 'conv-relay-1');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.direction).toBe('outbound');
    expect(row.author).toBe('system');
    expect(row.relay_sender_key).toBe('system');
    // The stored body IS the sent body (verbatim — no "<name>: " prefix).
    expect(row.body).toBe(world.sent[0]!.body);
    // One slot per member, stamped with the leg's SID; pointer per leg so the
    // delivery callback can finalize the rollup chip.
    expect(Object.keys(row.delivery_recipients ?? {}).sort()).toEqual([
      'c-alice',
      'c-bob',
      'c-carol',
    ]);
    expect(row.delivery_recipients?.['c-alice']?.sid).toMatch(/^SMfake-out-/);
    expect(world.relaySidPointers.size).toBe(3);
    // The inbox preview was touched with the intro text (repo truncates — a
    // prefix match is the honest assertion).
    const conv = world.conversations.get('conv-relay-1')!;
    const preview = conv.last_message_preview ?? '';
    expect(preview.length).toBeGreaterThan(0);
    expect(row.body!.startsWith(preview.slice(0, 20))).toBe(true);
  });

  it('relay.intro marks an opted-out member failed/contact_opted_out on the persisted row', async () => {
    seedRelay(world);
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: BOB, sms_opt_out: true });
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    await outbound.settle();

    const row = world.messages.find((m) => m.conversationId === 'conv-relay-1')!;
    expect(row.delivery_recipients?.['c-bob']).toEqual({
      status: 'failed',
      errorCode: 'contact_opted_out',
    });
    expect(row.delivery_recipients?.['c-alice']?.status).toBe('queued'); // fake adapter returns 'queued'
  });

  // persist:false = the dev replay seam (POST /__dev/relay/replay-intros): the
  // legs send, the DB stays byte-stable — no announcement row, no pointers.
  it('relay.intro with persist:false sends the legs but persists NOTHING', async () => {
    seedRelay(world);
    await enqueueImmediate(RELAY_INTRO_JOB, {
      relayConversationId: 'conv-relay-1',
      persist: false,
    });
    await outbound.settle();

    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(world.messages.filter((m) => m.conversationId === 'conv-relay-1')).toHaveLength(0);
    expect(world.relaySidPointers.size).toBe(0);
  });

  // Member added to an EXISTING group (founder decision 2026-07-14): one
  // announcement to the WHOLE group, persisted as a system row in the thread.
  it('relay.memberAdded names the new member, sends to EVERYONE, and persists a system row', async () => {
    seedRelay(world);
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-relay-1',
      addedMemberKey: 'c-carol',
    });
    await outbound.settle();

    // Every member gets the same body FROM the pool (Carol's welcome doubles
    // as Alice/Bob's join notice).
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    expect(world.sent[0]!.body).toContain('Carol joined this group chat.');
    expect(world.sent[0]!.body).toContain('Alice, Bob, and Carol');

    // Persisted once as a system announcement with a slot per member.
    const rows = world.messages.filter((m) => m.conversationId === 'conv-relay-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relay_sender_key).toBe('system');
    expect(rows[0]!.body).toBe(world.sent[0]!.body);
    expect(Object.keys(rows[0]!.delivery_recipients ?? {})).toHaveLength(3);
  });

  it('relay.memberAdded degrades to the neutral joined label when the key matches no member', async () => {
    seedRelay(world);
    // Raced remove: the added member is already off the roster at job time.
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-relay-1',
      addedMemberKey: 'phone#+15550109999',
    });
    await outbound.settle();

    expect(world.sent[0]!.body).toContain('A new member joined this group chat.');
  });
});

describe('relay body/intro composition (M1.7)', () => {
  it('composeRelayBody prefixes the sender name, falls back to a neutral label', () => {
    expect(composeRelayBody('Alice', 'hi')).toBe('Alice: hi');
    expect(composeRelayBody(undefined, 'hi')).toBe('A member: hi');
    expect(composeRelayBody('  ', 'hi')).toBe('A member: hi');
  });

  it('composeIntroBody lists names with an Oxford-style join, never a phone', () => {
    expect(composeIntroBody(['Alice', 'Bob', 'Carol'])).toContain('Alice, Bob, and Carol');
    expect(composeIntroBody(['Alice', 'Bob'])).toContain('Alice and Bob');
    expect(composeIntroBody(['Alice'])).toContain('Alice');
    // No names → a neutral count phrasing.
    expect(composeIntroBody([undefined, undefined])).toMatch(/connected with 1 other person/);
  });

  // FOUNDER DECISIONS 2026-08-18 (opt-out line) and 2026-08-20 (brand): the
  // intro now carries NEITHER. Both are first-contact messages, so engineering
  // advised keeping each and was overruled both times - attribution is in
  // catalog.ts. Asserted, not deleted: restoring either should be a deliberate
  // act that trips a test, never a silent drift.
  it('the intro carries NO opt-out line and NO brand identity (founder decisions)', () => {
    for (const names of [['Alice', 'Bob', 'Carol'], ['Alice'], [undefined, undefined]] as (string | undefined)[][]) {
      const body = composeIntroBody(names);
      expect(body).not.toContain('HousingChoice');
      expect(body).not.toContain('Reply STOP');
      // It still says who is texting, by first name.
      expect(body).toContain("it's Sam");
    }
  });

  it('the connection sentence uses FIRST names only (founder decision 2026-08-20)', () => {
    const body = composeIntroBody(['Brenda Morris', 'Sam Whitfield']);
    expect(body).toContain('Brenda and Sam');
    expect(body).not.toContain('Morris');
    expect(body).not.toContain('Whitfield');
  });

  it('composeMemberAddedBody names the joiner (neutral fallback), with no opt-out line', () => {
    const body = composeMemberAddedBody('Carol Brown', ['Alice', 'Bob', 'Carol Brown']);
    expect(body).not.toContain('Reply STOP');
    // First name on BOTH halves (2026-08-20) - never "Carol Brown joined ...
    // connected with ... Carol", which reads like two different people.
    expect(body).toContain('Carol joined this group chat.');
    expect(body).toContain("You're now connected with Alice, Bob, and Carol");
    expect(body).not.toContain('Brown');
    // No name (phone-only member) → neutral label, NEVER a phone.
    expect(composeMemberAddedBody(undefined, ['Alice', undefined])).toContain(
      'A new member joined this group chat.',
    );
    expect(composeMemberAddedBody('  ', ['Alice'])).toContain(
      'A new member joined this group chat.',
    );
  });
});

// Outbound MMS: relay media BOTH directions (design Sec 7). The fan-out reads
// the source message's media_attachments, presigns each s3Key PER LEG at
// leg-send time, and forwards the media to the other members. A media-only
// source uses the relay.media_only catalog body.
describe('relay.fanOut media (outbound MMS)', () => {
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      // The real MediaStore fake: presign returns a UNIQUE URL per call deriving
      // from the s3Key, so per-leg freshness is assertable.
      mediaStore: world.mediaStore,
      logger,
    });
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    _resetForTests();
  });

  /** Seed a source message carrying media_attachments (as the mirror/hub would). */
  function seedMediaSource(
    body: string,
    senderKey: string,
    media: { s3Key: string; contentType: string }[],
    overrides: Partial<MessageItem> = {},
  ): MessageItem {
    const providerTs = new Date().toISOString();
    const tsMsgId = buildTsMsgId(providerTs, 'SMrelay-mms-1');
    const item: MessageItem = {
      conversationId: 'conv-relay-1',
      tsMsgId,
      type: 'mms',
      direction: 'inbound',
      author: 'unknown',
      ...(body.length > 0 && { body }),
      provider_sid: 'SMrelay-mms-1',
      provider_ts: providerTs,
      delivery_status: 'delivered',
      created_at: providerTs,
      relay_sender_key: senderKey,
      media_attachments: media,
      ...overrides,
    };
    world.messages.push(item);
    return item;
  }

  it('team MMS-with-text: every leg carries presigned media + the "Name: body" prefix', async () => {
    seedRelay(world);
    const source = seedMediaSource('here is the flyer', TEAM_SENDER_KEY, [
      { s3Key: 'uploads/flyer-key', contentType: 'application/pdf' },
    ]);

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: TEAM_SENDER_KEY,
      senderNameOverride: TEAM_SENDER_LABEL,
    });
    await outbound.settle();

    // A TEAM message has no member sender, so ALL 3 members get the media + body.
    expect(world.sent).toHaveLength(3);
    for (const s of world.sent) {
      expect(s.body).toBe(`${TEAM_SENDER_LABEL}: here is the flyer`);
      expect(s.mediaUrls).toHaveLength(1);
      expect(s.mediaUrls?.[0]).toContain('uploads/flyer-key'); // derived from the s3Key
      expect(s.mediaUrls?.[0]).toContain('X-Amz-Signature'); // presigned bearer URL
    }
  });

  it('media-only source: legs use the relay.media_only catalog body and carry the media', async () => {
    seedRelay(world);
    const source = seedMediaSource('', 'c-alice', [
      { s3Key: 'media/conv-relay-1/SMrelay-mms-1/0', contentType: 'image/png' },
    ]);

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // Body comes from the catalog entry with {name} = the sender's name.
    const expectedBody = resolveMessage('relay.media_only', { name: 'Alice' });
    expect(world.sent).toHaveLength(2);
    for (const s of world.sent) {
      expect(s.body).toBe(expectedBody);
      expect(s.mediaUrls?.[0]).toContain('media/conv-relay-1/SMrelay-mms-1/0');
      expect(s.mediaUrls?.[0]).toContain('X-Amz-Signature');
    }
  });

  it('member inbound MMS: presigns the mirrored keys and forwards them to the OTHER members', async () => {
    seedRelay(world);
    // Alice (a member) sent a photo; the webhook mirrored it to a media/ key.
    const source = seedMediaSource('look at this', 'c-alice', [
      { s3Key: 'media/conv-relay-1/SMrelay-mms-1/0', contentType: 'image/jpeg' },
    ]);

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    // Bob + Carol (never Alice) receive the forwarded media.
    const recipients = world.sent.map((s) => s.to).sort();
    expect(recipients).toEqual([BOB, CAROL].sort());
    expect(world.sent.some((s) => s.to === ALICE)).toBe(false);
    for (const s of world.sent) {
      expect(s.body).toBe('Alice: look at this');
      expect(s.mediaUrls?.[0]).toContain('media/conv-relay-1/SMrelay-mms-1/0');
    }
  });

  it('presigns PER LEG: each recipient gets a FRESH URL (never a single batched presign)', async () => {
    seedRelay(world);
    const source = seedMediaSource('', 'c-alice', [
      { s3Key: 'uploads/shared-key', contentType: 'image/png' },
    ]);

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(2);
    const url0 = world.sent[0]?.mediaUrls?.[0];
    const url1 = world.sent[1]?.mediaUrls?.[0];
    // Both derive from the same durable key...
    expect(url0).toContain('uploads/shared-key');
    expect(url1).toContain('uploads/shared-key');
    // ...but are DISTINCT presigns (per-leg, not one batched URL reused).
    expect(url0).not.toBe(url1);
  });

  it('uses fresh URLs with the persisted v1 request and records adapter actual evidence', async () => {
    seedRelay(world);
    const source = seedMediaSource(
      'versioned media',
      'c-alice',
      [{ s3Key: 'uploads/versioned-key', contentType: 'image/png' }],
      {
        transport_schema_version: TRANSPORT_SCHEMA_VERSION,
        requested_transport: 'mms',
        delivery_recipients: {
          'c-bob': { status: 'queued', requestedTransport: 'mms' },
          'c-carol': { status: 'queued', requestedTransport: 'mms' },
        },
      },
    );

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent).toHaveLength(2);
    expect(world.sent[0]?.mediaUrls?.[0]).not.toBe(world.sent[1]?.mediaUrls?.[0]);
    expect(source.delivery_recipients).toMatchObject({
      'c-bob': { requestedTransport: 'mms', actualTransport: 'mms' },
      'c-carol': { requestedTransport: 'mms', actualTransport: 'mms' },
    });
  });
});
