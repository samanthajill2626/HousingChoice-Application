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
  composeMemberAddedGroupBody,
  composeNameList,
  composeRelayBody,
  joinedName,
  registerRelayFanOutJobHandler,
  resolveRelayComposeInputs,
  type RelayComposeDeps,
  type RelayComposeInputs,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import { buildTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
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
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
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

  // Member added to an EXISTING group. Phase B (spec 9.4 / 9.6, Cameron
  // 2026-08-31) SPLITS the one 2026-07-14 body per recipient: the group hears
  // who joined, the new member gets the naked intro, and the ONE persisted row
  // carries the NEW MEMBER's copy.
  it('relay.memberAdded splits the copy per recipient and persists the NEW MEMBER\'s body', async () => {
    seedRelay(world);
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-relay-1',
      addedMemberKey: 'c-carol',
    });
    await outbound.settle();

    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    // This group has no owner, so there is no role: the no-role entry.
    const groupBody = 'Hey, adding Carol to the group.';
    const carolLeg = world.sent.find((s) => s.to === CAROL)!;
    const aliceLeg = world.sent.find((s) => s.to === ALICE)!;
    const bobLeg = world.sent.find((s) => s.to === BOB)!;
    expect(aliceLeg.body).toBe(groupBody);
    expect(bobLeg.body).toBe(groupBody);
    // The new member's own leg is the naked intro naming the POST-ADD roster -
    // their entire context, since a relay member sees no history.
    expect(carolLeg.body).toContain("You're now connected with Alice, Bob, and Carol");
    expect(carolLeg.body).not.toBe(groupBody);

    // Still ONE row with a slot per member (one bubble, one rollup chip)...
    const rows = world.messages.filter((m) => m.conversationId === 'conv-relay-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relay_sender_key).toBe('system');
    expect(Object.keys(rows[0]!.delivery_recipients ?? {})).toHaveLength(3);
    // ...and spec 9.6's named exception to the 2026-07-14 visibility rule: the
    // persisted body is the NEW MEMBER's leg, NOT an existing member's.
    expect(rows[0]!.body).toBe(carolLeg.body);
    expect(rows[0]!.body).not.toBe(aliceLeg.body);
    // The inbox preview inherits the same (persisted) body, by construction.
    const conv = world.conversations.get('conv-relay-1')!;
    expect(rows[0]!.body!.startsWith((conv.last_message_preview ?? '').slice(0, 20))).toBe(true);
  });

  it('relay.memberAdded degrades to the neutral joined label when the key matches no member', async () => {
    seedRelay(world);
    // Raced remove: the added member is already off the roster at job time.
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-relay-1',
      addedMemberKey: 'phone#+15550109999',
    });
    await outbound.settle();

    // Nobody on the roster matches the key, so EVERY leg is the group body -
    // and the neutral label is lower-cased for Sam's mid-sentence wording.
    expect(world.sent[0]!.body).toBe('Hey, adding a new member to the group.');

    // ...and the PERSISTED row follows the legs (review round 1, B-N1). Spec
    // 9.6 persists the new member's copy because it is the one worth seeing in
    // the thread - but when no member matched the key, NOBODY received it, so
    // persisting it would leave a bubble and an inbox preview quoting a message
    // that was never sent to anyone.
    const rows = world.messages.filter((m) => m.conversationId === 'conv-relay-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Hey, adding a new member to the group.');
  });
});

/** The no-owner inputs value: a standalone group, or any owner-routed case that
 *  spec 9.5 degraded. Phase B gave both composers an `inputs` first argument. */
const NAKED: RelayComposeInputs = { variant: 'naked' };

describe('relay body/intro composition (M1.7)', () => {
  it('composeRelayBody prefixes the sender name, falls back to a neutral label', () => {
    expect(composeRelayBody('Alice', 'hi')).toBe('Alice: hi');
    expect(composeRelayBody(undefined, 'hi')).toBe('A member: hi');
    expect(composeRelayBody('  ', 'hi')).toBe('A member: hi');
  });

  // NAKED is the variant these pin: every one of these rosters is a standalone
  // group (no owner), which is what a `{ variant: 'naked' }` inputs value means.
  it('composeIntroBody lists names with an Oxford-style join, never a phone', () => {
    expect(composeIntroBody(NAKED, ['Alice', 'Bob', 'Carol'])).toContain('Alice, Bob, and Carol');
    expect(composeIntroBody(NAKED, ['Alice', 'Bob'])).toContain('Alice and Bob');
    expect(composeIntroBody(NAKED, ['Alice'])).toContain('Alice');
    // No names → a neutral count phrasing.
    expect(composeIntroBody(NAKED, [undefined, undefined])).toMatch(
      /connected with 1 other person/,
    );
  });

  // FOUNDER DECISIONS 2026-08-18 (opt-out line) and 2026-08-20 (brand): the
  // intro now carries NEITHER. Both are first-contact messages, so engineering
  // advised keeping each and was overruled both times - attribution is in
  // catalog.ts. Asserted, not deleted: restoring either should be a deliberate
  // act that trips a test, never a silent drift.
  it('the intro carries NO opt-out line and NO brand identity (founder decisions)', () => {
    for (const names of [['Alice', 'Bob', 'Carol'], ['Alice'], [undefined, undefined]] as (string | undefined)[][]) {
      const body = composeIntroBody(NAKED, names);
      expect(body).not.toContain('HousingChoice');
      expect(body).not.toContain('Reply STOP');
      // It still says who is texting, by first name.
      expect(body).toContain("it's Sam");
    }
  });

  it('the connection sentence uses FIRST names only (founder decision 2026-08-20)', () => {
    const body = composeIntroBody(NAKED, ['Brenda Morris', 'Sam Whitfield']);
    expect(body).toContain('Brenda and Sam');
    expect(body).not.toContain('Morris');
    expect(body).not.toContain('Whitfield');
  });

  // Re-baselined for the Phase B split (spec 9.4, Cameron 2026-08-31). The old
  // one-body announcement ("Hey! Carol joined this group chat. You're now
  // connected with Alice, Bob, and Carol ...") is GONE: the group hears only who
  // joined, and the name list belongs to the NEW member's naked intro instead.
  // The FIRST-name rule (2026-08-20) and the no-opt-out rule both survive.
  it('the group announcement names the joiner by FIRST name, with no opt-out line', () => {
    const body = composeMemberAddedGroupBody(NAKED, 'Carol Brown');
    expect(body).not.toContain('Reply STOP');
    expect(body).toBe('Hey, adding Carol to the group.');
    expect(body).not.toContain('Brown');
    // The name list moved OUT of this body - it is the new member's intro now.
    expect(body).not.toContain("You're now connected with");
    // No name (phone-only member) → neutral label, NEVER a phone.
    expect(composeMemberAddedGroupBody(NAKED, undefined)).toBe(
      'Hey, adding a new member to the group.',
    );
    expect(composeMemberAddedGroupBody(NAKED, '  ')).toBe(
      'Hey, adding a new member to the group.',
    );
  });
});

// Phase B spec 9.2 / 9.4. {members} was a whole computed SENTENCE; {names} is
// the bare list, so the fixed copy around it moves into the catalog where it is
// visible. Both token values are TOTAL - they never return the empty string -
// because an unvalued token in a NON-EDITABLE catalog default does not degrade,
// it THROWS (messages/resolve.ts), which would kill the intro job AFTER its
// idempotency claim (announcement lost, not retried) and 500 the preview route.
describe('composeNameList - the TOTAL {names} value (spec 9.2)', () => {
  it('Oxford list of FIRST names', () => {
    expect(composeNameList(['Alicia Reyes', 'Marcus Webb', 'Dana Cole'])).toBe(
      'Alicia, Marcus, and Dana',
    );
    expect(composeNameList(['Alicia Reyes', 'Marcus Webb'])).toBe('Alicia and Marcus');
    expect(composeNameList(['Alicia Reyes'])).toBe('Alicia');
  });

  it('no names known: count phrase, never empty, never a phone', () => {
    expect(composeNameList([undefined, undefined, undefined])).toBe('2 other people');
    expect(composeNameList([undefined, undefined])).toBe('1 other person');
    // Zero-others row (spec 9.2's last row): a mildly wrong sentence beats a
    // strict-mode throw. The PREVIEW builder can reach this branch.
    expect(composeNameList([undefined])).toBe('1 other person');
    // Whitespace-only is the same as absent, and an EMPTY roster still answers.
    expect(composeNameList(['  '])).toBe('1 other person');
    expect(composeNameList([])).toBe('1 other person');
  });

  it('a partially-named roster lists only the names it has, never a placeholder', () => {
    expect(composeNameList(['Alicia Reyes', undefined])).toBe('Alicia');
  });
});

describe('joinedName - the TOTAL {name} value (spec 9.4)', () => {
  it('first name, else the lower-cased neutral phrase', () => {
    expect(joinedName('Dana Cole')).toBe('Dana');
    expect(joinedName(undefined)).toBe('a new member');
    expect(joinedName('  ')).toBe('a new member');
  });

  it('is lower-cased so it reads correctly MID-sentence in the founder wording', () => {
    // "Hey, adding a new member to the group." - the pre-Phase-B constant was
    // sentence-initial ("A new member joined this group chat.") and cannot be
    // reused as-is. Wired in Task 14; pinned here so the value is settled.
    expect(joinedName(undefined)).not.toBe('A new member');
  });
});

describe('relay catalog entries (spec 9.2a)', () => {
  it('naked intro composed output is BYTE-IDENTICAL to the pre-change body', () => {
    // Derived by RUNNING the pre-change composeIntroBody(['Alicia Reyes',
    // 'Marcus Webb']) before the rewrite, not hand-assembled. The old pipeline
    // was "Hey, it's Sam. " + the whole connection SENTENCE + the trailing copy;
    // the new one is the same text with the sentence living in the default and
    // only the name list interpolated. This pin is what proves the seam.
    const names = ['Alicia Reyes', 'Marcus Webb'];
    const expected =
      "Hey, it's Sam. You're now connected with Alicia and Marcus on this number. " +
      'Reply here and everyone in the group sees it. Use this group text for anything ' +
      'that comes up. It can be a long process, so ask me anything in here!';
    expect(resolveMessage('relay.intro', { names: composeNameList(names) })).toBe(expected);
    // ...and the composer that every call site still goes through agrees.
    expect(composeIntroBody(NAKED, names)).toBe(expected);
  });

  it('the nameless multi-member intro is BYTE-IDENTICAL too', () => {
    expect(composeIntroBody(NAKED, [undefined, undefined, undefined])).toBe(
      "Hey, it's Sam. You're now connected with 2 other people on this number. Reply here " +
        'and everyone in the group sees it. Use this group text for anything that comes up. ' +
        'It can be a long process, so ask me anything in here!',
    );
    expect(composeIntroBody(NAKED, [undefined, undefined])).toBe(
      "Hey, it's Sam. You're now connected with 1 other person on this number. Reply here " +
        'and everyone in the group sees it. Use this group text for anything that comes up. ' +
        'It can be a long process, so ask me anything in here!',
    );
  });

  it('the ONE composed output spec 9.2 deliberately changes: the zero-others intro', () => {
    // Pre-change this single-member roster RESTRUCTURED the sentence:
    // "You're now connected on this number. Reply here and the group sees it."
    // As a token {names} cannot restructure the one sentence in the template, so
    // 9.2's table routes it to the "1 other person" phrasing instead - mildly
    // wrong copy on an edge case, in exchange for a template that always works.
    const body = composeIntroBody(NAKED, [undefined]);
    expect(body).toBe(
      "Hey, it's Sam. You're now connected with 1 other person on this number. Reply here " +
        'and everyone in the group sees it. Use this group text for anything that comes up. ' +
        'It can be a long process, so ask me anything in here!',
    );
    expect(body).not.toContain("You're now connected on this number");
  });

  it('the four new founder entries carry the exact 9.1 / 9.4 copy and 9.2a metadata', () => {
    expect(
      resolveMessage('relay.intro_tour_today', {
        tenantFirstName: 'Alicia',
        propertyContactFirstName: 'Marcus',
        time: '3:00 PM',
        where: '412 Oak St',
      }),
    ).toBe(
      "Hey Alicia! It's Sam. Putting you in a group text with Marcus to tour 412 Oak St at 3:00 PM. " +
        'Looking forward to you seeing the property and meeting Marcus! Please let us know ' +
        "when you're on the way.",
    );
    expect(
      resolveMessage('relay.intro_tour', {
        tenantFirstName: 'Alicia',
        propertyContactFirstName: 'Marcus',
        when: 'Tue, Sep 8 at 3:00 PM',
        where: '412 Oak St',
      }),
    ).toBe(
      "Hey Alicia! It's Sam. Putting you in a group text with Marcus to tour 412 Oak St on Tue, Sep 8 " +
        'at 3:00 PM. Looking forward to you seeing the property and meeting Marcus! Please ' +
        "let us know when you're on the way.",
    );
    expect(
      resolveMessage('relay.intro_placement', {
        tenantFirstName: 'Alicia',
        propertyContactFirstName: 'Marcus',
        where: '412 Oak St',
      }),
    ).toBe(
      "Hey Alicia! It's Sam. Excited to have you move into 412 Oak St. Please use this group text for " +
        'all future communication and Marcus will share updates as they receive them from ' +
        'the housing authority. This can be a long process so if you have any questions feel ' +
        'free to ask in here! We are committed to the process and are excited to have you ' +
        'move in.',
    );
    expect(resolveMessage('relay.member_added_role', { name: 'Dana', role: 'property manager' })).toBe(
      'Hey, adding Dana to the group as the property manager.',
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

// ---------------------------------------------------------------------------
// Phase B spec 9.0 / 9.3 / 9.4 / 9.5: the OWNER-ROUTED resolver and the two
// pure composers it feeds. The resolver does every repo read; the composers
// stay pure and synchronous (the same split Phase A's tour copy uses).
//
// The load-bearing property is TOTALITY. Both entry families are non-editable
// catalog DEFAULTS, so an unvalued declared token does not degrade - it THROWS
// (messages/resolve.ts), and the intro job composes AFTER its
// putJobExecutionMarker claim, so a throw loses the announcement instead of
// retrying it, and 500s the preview route. Hence: the resolver NEVER throws
// (every read gets its own try/catch and degrades toward 'naked'), and the
// composers answer for every input they can be handed.
// ---------------------------------------------------------------------------

const NY = 'America/New_York';
/** 2026-09-08 15:00 New York (19:00Z, EDT). */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
/** 09:00 New York on the SAME local day as TOUR_AT. */
const SAME_DAY_NOW = '2026-09-08T13:00:00.000Z';
/** 09:00 New York the day BEFORE - "today" must be false. */
const DAY_BEFORE_NOW = '2026-09-07T13:00:00.000Z';

function fakeUnit(over: Record<string, unknown> = {}): UnitItem {
  return {
    unitId: 'unit-1',
    landlordId: 'c-landlord',
    status: 'available',
    address: { line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30314' },
    contacts: [{ contactId: 'c-landlord', role: 'landlord', primaryContact: true }],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  } as UnitItem;
}

/** Deps whose every read succeeds: a scheduled tour on a unit with a landlord. */
function fakeDeps(
  over: Partial<RelayComposeDeps> = {},
  unit: UnitItem | undefined = fakeUnit(),
  tour: Record<string, unknown> = {
    tourId: 'tour-1',
    tenantId: 'c-tenant',
    unitId: 'unit-1',
    scheduledAt: TOUR_AT,
  },
): RelayComposeDeps {
  return {
    toursRepo: { get: async () => tour as never },
    placementsRepo: {
      getById: async () =>
        ({ placementId: 'plc-1', tenantId: 'c-tenant', unitId: 'unit-1' }) as never,
    },
    unitsRepo: { getById: async () => unit as never },
    contactsRepo: {
      getById: async (id: string) =>
        (id === 'c-tenant'
          ? { contactId: 'c-tenant', type: 'tenant', firstName: 'Alicia', lastName: 'Reyes' }
          : id === 'c-landlord'
            ? { contactId: 'c-landlord', type: 'landlord', firstName: 'Marcus', lastName: 'Webb' }
            : undefined) as never,
    },
    settingsRepo: { getOrgSettings: async () => ({ timezone: NY }) as never },
    nowIso: DAY_BEFORE_NOW,
    ...over,
  };
}

describe('resolveRelayComposeInputs (spec 9.3) - owner routing, and it NEVER throws', () => {
  it('a tour TODAY in the org timezone resolves the today variant with {time}', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({ nowIso: SAME_DAY_NOW }),
    );
    expect(inputs.variant).toBe('tour_today');
    expect(inputs.time).toBe('3:00 PM');
    expect(inputs.when).toBeUndefined();
    expect(inputs.where).toBe('412 Oak St');
    expect(inputs.tenantFirstName).toBe('Alicia');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
  });

  it('a tour on any OTHER day resolves the dated variant with {when}', async () => {
    const inputs = await resolveRelayComposeInputs({ type: 'tour', id: 'tour-1' }, fakeDeps());
    expect(inputs.variant).toBe('tour');
    expect(inputs.when).toBe('Tue, Sep 8 at 3:00 PM');
    expect(inputs.time).toBeUndefined();
  });

  it('"today" is judged in the ORG zone, not UTC (the booked-too-late zone)', async () => {
    // 2026-09-08T02:00Z is 22:00 on Sep 7 in New York - the day BEFORE the tour,
    // even though UTC already says the 8th. resolveQuietHoursTimezone is the
    // same seam the same-day booking test uses, so the two cannot disagree.
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({ nowIso: '2026-09-08T02:00:00.000Z' }),
    );
    expect(inputs.variant).toBe('tour');
  });

  // THE PAST-TOUR GATE (review round 1, B-MF1). Both tour entries close "Please
  // let us know when you're on the way", so their copy ASSUMES the tour has not
  // happened - the same assumption the ladder's fire-time gate
  // (retiredByTourStart) exists to protect. Two ordinary paths reach a past
  // tour here: an operator opening the group from a tour whose outcome is not
  // recorded yet, and a quiet-hours deferral that straddles the tour start (the
  // route defers the open to quiet-end, and the job composes THEN).
  it('a tour that has ALREADY STARTED is naked, exactly as an absent time is', async () => {
    // 16:00 New York, an hour after the 15:00 tour - still the SAME local day,
    // which is the case the "is it today" test alone cannot catch.
    const sameDayAfter = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({ nowIso: '2026-09-08T20:00:00.000Z' }),
    );
    expect(sameDayAfter.variant).toBe('naked');
    expect(sameDayAfter.time).toBeUndefined();
    // ...and a day later, which would otherwise render the DATED variant.
    const dayAfter = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({ nowIso: '2026-09-09T13:00:00.000Z' }),
    );
    expect(dayAfter.variant).toBe('naked');
    expect(dayAfter.when).toBeUndefined();
    // Spec 9.5's degrade, not a bare naked: the names it did resolve survive.
    expect(dayAfter.tenantFirstName).toBe('Alicia');
  });

  it('the boundary is INCLUSIVE: at exactly the start instant the tour copy is already stale', async () => {
    // R2-S1. This has to agree with retiredByTourStart, which is `now >= start`
    // and is pinned by a case named "exactly AT the tour start - the copy is
    // already stale". Both gate the SAME forward-looking sentence ("let us know
    // when you're on the way"), so one instant gets one answer.
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({ nowIso: TOUR_AT }),
    );
    expect(inputs.variant).toBe('naked');
    expect(inputs.time).toBeUndefined();
    // One millisecond earlier the tour has NOT started, and the copy is right.
    const justBefore = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({ nowIso: '2026-09-08T18:59:59.999Z' }),
    );
    expect(justBefore.variant).toBe('tour_today');
    expect(justBefore.time).toBe('3:00 PM');
  });

  it('a placement owner resolves the placement variant (no time tokens at all)', async () => {
    const inputs = await resolveRelayComposeInputs({ type: 'placement', id: 'plc-1' }, fakeDeps());
    expect(inputs.variant).toBe('placement');
    expect(inputs.where).toBe('412 Oak St');
    expect(inputs.when).toBeUndefined();
    expect(inputs.time).toBeUndefined();
  });

  it('a null owner (a standalone group) is naked - and reads NOTHING', async () => {
    let reads = 0;
    const inputs = await resolveRelayComposeInputs(
      { type: null },
      fakeDeps({
        toursRepo: {
          get: async () => {
            reads += 1;
            return undefined as never;
          },
        },
      }),
    );
    expect(inputs).toEqual({ variant: 'naked' });
    expect(reads).toBe(0);
  });

  // Spec 9.5: ONE rule - a missing landlord, address or tour time falls back to
  // the naked intro rather than emptying a clause, because both new intros use
  // {where} MID-sentence (Phase A spec 6.4's empty-clause trick cannot help).
  it('EVERY missing input degrades to naked (never a throw, never a blank clause)', async () => {
    const rows: [string, RelayComposeDeps][] = [
      ['the tour row is gone', fakeDeps({ toursRepo: { get: async () => undefined as never } })],
      [
        'no scheduledAt (a requested tour)',
        fakeDeps({}, fakeUnit(), { tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1' }),
      ],
      // NOT fakeDeps({}, undefined): an explicit undefined takes the default
      // parameter, which would hand back the healthy unit.
      ['no unit row', fakeDeps({ unitsRepo: { getById: async () => undefined as never } })],
      ['the unit has no street', fakeDeps({}, fakeUnit({ address: undefined }))],
      [
        'no property contact resolves',
        fakeDeps({}, fakeUnit({ landlordId: undefined, contacts: [] })),
      ],
      [
        'the tour read THROWS',
        fakeDeps({
          toursRepo: {
            get: async () => {
              throw new Error('tours-boom');
            },
          },
        }),
      ],
      [
        'the unit read THROWS',
        fakeDeps({
          unitsRepo: {
            getById: async () => {
              throw new Error('units-boom');
            },
          },
        }),
      ],
      [
        'the settings read THROWS',
        fakeDeps({
          settingsRepo: {
            getOrgSettings: async () => {
              throw new Error('settings-boom');
            },
          },
        }),
      ],
      [
        'scheduledAt is unparseable (formatLocalTime would RangeError)',
        fakeDeps({}, fakeUnit(), {
          tourId: 'tour-1',
          tenantId: 'c-tenant',
          unitId: 'unit-1',
          scheduledAt: 'not-a-date',
        }),
      ],
      // R11: the preview deps are OPTIONAL picks; a caller that wires none of
      // them degrades rather than failing - rosterEdits.test.ts hand-builds
      // deps ~25 times without them.
      ['no repos wired at all', { nowIso: DAY_BEFORE_NOW }],
    ];
    for (const [why, deps] of rows) {
      const inputs = await resolveRelayComposeInputs({ type: 'tour', id: 'tour-1' }, deps);
      expect(inputs.variant, why).toBe('naked');
    }
  });

  it('a missing TENANT first name KEEPS the variant (it degrades in-sentence)', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({
        contactsRepo: {
          getById: async (id: string) =>
            (id === 'c-landlord'
              ? { contactId: 'c-landlord', type: 'landlord', firstName: 'Marcus' }
              : { contactId: 'c-tenant', type: 'tenant' }) as never,
        },
      }),
    );
    expect(inputs.variant).toBe('tour');
    expect(inputs.tenantFirstName).toBeUndefined();
  });

  // Spec 9.4's role table. The source is UnitContact.role, NOT ContactItem.type
  // (which has no property-manager value at all).
  it('maps the roster role for the ADDED member, tenant included', async () => {
    const unit = fakeUnit({
      contacts: [
        { contactId: 'c-landlord', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
        { contactId: 'c-owner', role: 'owner', primaryContact: false },
        { contactId: 'c-other', role: 'other', primaryContact: false },
      ],
    });
    const roleOf = async (addedContactId?: string) =>
      (
        await resolveRelayComposeInputs(
          { type: 'tour', id: 'tour-1' },
          fakeDeps({}, unit),
          addedContactId,
        )
      ).role;
    expect(await roleOf('c-pm')).toBe('property manager');
    expect(await roleOf('c-landlord')).toBe('landlord');
    expect(await roleOf('c-owner')).toBe('landlord');
    // The OWNING tour's tenant is 'tenant' whatever the property roster says.
    expect(await roleOf('c-tenant')).toBe('tenant');
    // No role: 'other', a stranger, and a phone-only member with no contactId.
    expect(await roleOf('c-other')).toBeUndefined();
    expect(await roleOf('c-stranger')).toBeUndefined();
    expect(await roleOf(undefined)).toBeUndefined();
  });

  it('resolves the ROLE even when the INTRO degrades to naked', async () => {
    // The two are independent questions: a unit with a roster but no street
    // cannot compose a tour intro (9.5) and still knows who the joiner is.
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      fakeDeps({}, fakeUnit({ address: undefined })),
      'c-landlord',
    );
    expect(inputs.variant).toBe('naked');
    expect(inputs.role).toBe('landlord');
  });
});

describe('composeIntroBody (spec 9.1) - entry selection from the resolved variant', () => {
  const TOUR_INPUTS: RelayComposeInputs = {
    variant: 'tour',
    tenantFirstName: 'Alicia',
    propertyContactFirstName: 'Marcus',
    when: 'Tue, Sep 8 at 3:00 PM',
    where: '412 Oak St',
  };

  it('routes each variant to its founder entry', () => {
    expect(composeIntroBody(TOUR_INPUTS, ['Alicia Reyes', 'Marcus Webb'])).toBe(
      "Hey Alicia! It's Sam. Putting you in a group text with Marcus to tour 412 Oak St on Tue, Sep 8 " +
        'at 3:00 PM. Looking forward to you seeing the property and meeting Marcus! Please ' +
        "let us know when you're on the way.",
    );
    expect(
      composeIntroBody({ ...TOUR_INPUTS, variant: 'tour_today', when: undefined, time: '3:00 PM' }, [
        'Alicia Reyes',
      ]),
    ).toBe(
      "Hey Alicia! It's Sam. Putting you in a group text with Marcus to tour 412 Oak St at 3:00 PM. " +
        'Looking forward to you seeing the property and meeting Marcus! Please let us know ' +
        "when you're on the way.",
    );
    expect(
      composeIntroBody({ ...TOUR_INPUTS, variant: 'placement', when: undefined }, ['Alicia Reyes']),
    ).toContain('Excited to have you move into 412 Oak St.');
  });

  it('the NAKED variant is the live copy, unchanged, and names the roster', () => {
    expect(composeIntroBody({ variant: 'naked' }, ['Alicia Reyes', 'Marcus Webb'])).toBe(
      "Hey, it's Sam. You're now connected with Alicia and Marcus on this number. " +
        'Reply here and everyone in the group sees it. Use this group text for anything ' +
        'that comes up. It can be a long process, so ask me anything in here!',
    );
  });

  // TOTALITY (plan review P3). The tour/placement entries OPEN with
  // "Hey {tenantFirstName}!" and are strict non-editable defaults, so an absent
  // tenant name must never reach resolveMessage as undefined. Phase A's own
  // fallback (messages/tourCopy.ts) is the one used.
  it('a variant with NO tenant name greets "Hey there!" and does not throw', () => {
    const body = composeIntroBody({ ...TOUR_INPUTS, tenantFirstName: undefined }, []);
    expect(body).toContain("Hey there! It's Sam. Putting you in a group text with Marcus");
  });

  // The composer is the LAST line of 9.5's defence: the resolver already
  // guarantees these, but a hand-built inputs value must never throw either.
  it('a variant missing its own tokens falls back to the naked entry', () => {
    for (const broken of [
      { ...TOUR_INPUTS, propertyContactFirstName: undefined },
      { ...TOUR_INPUTS, where: undefined },
      { ...TOUR_INPUTS, when: undefined },
      { ...TOUR_INPUTS, variant: 'tour_today' as const, when: undefined },
    ]) {
      const body = composeIntroBody(broken, ['Alicia Reyes', 'Marcus Webb']);
      expect(body).toContain("You're now connected with Alicia and Marcus");
    }
  });
});

describe('composeMemberAddedGroupBody (spec 9.4) - the GROUP half of the split', () => {
  it('uses the role entry when the role resolved, the no-role entry otherwise', () => {
    expect(
      composeMemberAddedGroupBody({ variant: 'naked', role: 'property manager' }, 'Dana Cole'),
    ).toBe('Hey, adding Dana to the group as the property manager.');
    expect(composeMemberAddedGroupBody({ variant: 'naked', role: 'landlord' }, 'Dana Cole')).toBe(
      'Hey, adding Dana to the group as the landlord.',
    );
    expect(composeMemberAddedGroupBody({ variant: 'naked' }, 'Dana Cole')).toBe(
      'Hey, adding Dana to the group.',
    );
  });

  it('is TOTAL on a nameless joiner (a bare-phone member), and never a phone', () => {
    expect(composeMemberAddedGroupBody({ variant: 'naked' }, undefined)).toBe(
      'Hey, adding a new member to the group.',
    );
    expect(composeMemberAddedGroupBody({ variant: 'naked', role: 'tenant' }, '  ')).toBe(
      'Hey, adding a new member to the group as the tenant.',
    );
  });

  it('carries NO opt-out line and NO brand (the same founder decisions)', () => {
    const body = composeMemberAddedGroupBody({ variant: 'naked', role: 'landlord' }, 'Dana');
    expect(body).not.toContain('Reply STOP');
    expect(body).not.toContain('HousingChoice');
  });
});

// ---------------------------------------------------------------------------
// The JOBS, owner-routed end to end (spec 9.1 / 9.4 / 9.6). Its own world +
// registration because these handlers need the four extra repos wired; the
// suite above deliberately registers WITHOUT them (an unowned group must still
// compose, which is what keeps the naked path honest).
// ---------------------------------------------------------------------------
describe('relay.intro / relay.memberAdded on an OWNED group', () => {
  const TENANT = '+15550100051';
  const LANDLORD = '+15550100052';
  const PM = '+15550100053';
  const OWNED_POOL = '+15550109050';
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;

  beforeEach(async () => {
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
      unitsRepo: world.unitsRepo,
      toursRepo: world.toursRepo,
      placementsRepo: world.placementsRepo,
      settingsRepo: world.settingsRepo,
      logger,
    });
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);

    world.contacts.push(
      { contactId: 'c-tenant', type: 'tenant', phone: TENANT, firstName: 'Tina', lastName: 'Tenant' },
      { contactId: 'c-land', type: 'landlord', phone: LANDLORD, firstName: 'Larry', lastName: 'Land' },
      { contactId: 'c-pm', type: 'landlord', phone: PM, firstName: 'Pat', lastName: 'Manager' },
    );
    world.units.set('unit-owned', {
      unitId: 'unit-owned',
      landlordId: 'c-land',
      status: 'available',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30314' },
      contacts: [
        { contactId: 'c-land', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    } as never);
    // A FIXED far-future instant, so "today" is deterministic whatever day the
    // suite runs: the dated variant, never the today one.
    world.toursMap.set('tour-owned', {
      tourId: 'tour-owned',
      tenantId: 'c-tenant',
      unitId: 'unit-owned',
      scheduledAt: '2026-09-08T19:00:00.000Z',
      status: 'scheduled',
      tourType: 'landlord_led',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    } as never);
    await world.settingsRepo.putOrgSettings({ timezone: 'America/New_York' });
  });

  afterEach(() => {
    _resetForTests();
  });

  function seedOwnedRelay(participants: { contactId: string; phone: string; name?: string }[]): void {
    const now = '2026-07-10T00:00:00.000Z';
    world.conversations.set('conv-owned', {
      conversationId: 'conv-owned',
      participant_phone: OWNED_POOL,
      pool_number: OWNED_POOL,
      status: 'open',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      participants,
      owner: { type: 'tour', id: 'tour-owned' },
      created_at: now,
    });
  }

  it('a TOUR-owned group sends Sam tour intro to every member, not the naked one', async () => {
    seedOwnedRelay([
      { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
      { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
    ]);
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-owned' });
    await outbound.settle();

    const expected =
      "Hey Tina! It's Sam. Putting you in a group text with Larry to tour 77 Peachtree St on " +
      'Tue, Sep 8 at 3:00 PM. Looking forward to you seeing the property and meeting ' +
      "Larry! Please let us know when you're on the way.";
    expect(world.sent.map((s) => s.to).sort()).toEqual([TENANT, LANDLORD].sort());
    for (const sent of world.sent) expect(sent.body).toBe(expected);
    // Persisted verbatim - one row, the same body (the intro is NOT split).
    const row = world.messages.find((m) => m.conversationId === 'conv-owned')!;
    expect(row.body).toBe(expected);
  });

  // Precedence rule 1 (spec 9.1): Sam asked for the manual opener to keep
  // winning outright, and it must win over the OWNER ROUTING too.
  it('an operator-edited intro_body still wins over the tour variant', async () => {
    seedOwnedRelay([
      { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
      { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
    ]);
    const conv = world.conversations.get('conv-owned')!;
    world.conversations.set('conv-owned', { ...conv, intro_body: 'Hand-written by the operator.' });
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-owned' });
    await outbound.settle();
    for (const sent of world.sent) expect(sent.body).toBe('Hand-written by the operator.');
  });

  // Spec 9.5: the SAME group, with the tour's time removed (a 'requested' tour),
  // falls all the way back to the naked intro rather than emptying a clause.
  it('the same group with no scheduledAt falls back to the naked intro', async () => {
    const tour = world.toursMap.get('tour-owned')!;
    const { scheduledAt: _dropped, ...timeless } = tour;
    world.toursMap.set('tour-owned', timeless as never);
    seedOwnedRelay([
      { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
      { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
    ]);
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-owned' });
    await outbound.settle();
    for (const sent of world.sent) {
      expect(sent.body).toContain("You're now connected with Tina and Larry");
    }
  });

  it('member_added on an owned group carries the ROLE, and the new member the naked intro', async () => {
    seedOwnedRelay([
      { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
      { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
      { contactId: 'c-pm', phone: PM, name: 'Pat Manager' },
    ]);
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-owned',
      addedMemberKey: 'c-pm',
    });
    await outbound.settle();

    // UnitContact.role 'pm' -> "property manager" (spec 9.4's table).
    const groupBody = 'Hey, adding Pat to the group as the property manager.';
    expect(world.sent.find((s) => s.to === TENANT)!.body).toBe(groupBody);
    expect(world.sent.find((s) => s.to === LANDLORD)!.body).toBe(groupBody);
    const pmLeg = world.sent.find((s) => s.to === PM)!;
    // The new member gets the NAKED intro even on a tour-owned group: one
    // message, no variants (spec 9.4).
    expect(pmLeg.body).toContain("You're now connected with Tina, Larry, and Pat");
    expect(pmLeg.body).not.toContain('Putting you in a group text');
    // ONE row, carrying the new member's copy (spec 9.6).
    const rows = world.messages.filter((m) => m.conversationId === 'conv-owned');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe(pmLeg.body);
  });

  it('the TENANT joining an owned group reads as the tenant role', async () => {
    seedOwnedRelay([
      { contactId: 'c-land', phone: LANDLORD, name: 'Larry Land' },
      { contactId: 'c-tenant', phone: TENANT, name: 'Tina Tenant' },
    ]);
    await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
      relayConversationId: 'conv-owned',
      addedMemberKey: 'c-tenant',
    });
    await outbound.settle();
    expect(world.sent.find((s) => s.to === LANDLORD)!.body).toBe(
      'Hey, adding Tina to the group as the tenant.',
    );
  });
});
