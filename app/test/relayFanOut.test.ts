// relay.fanOut + relay.intro (M1.7) — the milestone golden tests for the
// fan-out job in isolation: stored-once + fan-out to OTHER members only,
// sender-prefixed, per-recipient delivery states, idempotency, mid-thread
// membership, removed-member, transient/permanent error handling, and the
// intro naming every member. Driven through the real jobs envelope machinery
// (enqueue → InMemoryScheduler/InProcessOutboundQueue → dispatchJob) so the
// jobId-marker idempotency guard is exercised for real.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
  composeIntroBody,
  composeRelayBody,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import { buildTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

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

describe('relay.fanOut (M1.7)', () => {
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
      logger,
    });
    // The delay refactor routes the <=12min transient continuation (5/10/20s)
    // through the SQS path (outbound adapter), NOT EventBridge. In tests the
    // InProcess adapter dispatches immediate jobs in-process and RECORDS delayed
    // ones in `delayed[]` for assertions (no real sleep).
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
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
    const stored = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(stored.delivery_recipients?.['c-bob']?.status).toBe('failed');
    expect(stored.delivery_recipients?.['c-carol']?.status).toBe('sent');
  });

  it('relay.intro names every member and sends to each', async () => {
    seedRelay(world);
    await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId: 'conv-relay-1' });
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    // Each intro body names all three.
    for (const sent of world.sent) {
      expect(sent.body).toContain('Alice');
      expect(sent.body).toContain('Bob');
      expect(sent.body).toContain('Carol');
    }
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

  it('A2P/CTIA (spec §5): the intro is PREPENDED with business identity + opt-out', () => {
    // Every intro (named or count-phrasing) leads with the registered brand + STOP.
    for (const names of [['Alice', 'Bob', 'Carol'], ['Alice'], [undefined, undefined]] as (string | undefined)[][]) {
      const body = composeIntroBody(names);
      expect(body.startsWith('Tenant Place LLC. Reply STOP to opt out.')).toBe(true);
    }
  });
});
