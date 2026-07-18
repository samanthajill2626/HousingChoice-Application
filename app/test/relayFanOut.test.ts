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
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';
import { resolveMessage } from '../src/messages/index.js';

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
      contactsRepo: world.contactsRepo,
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

  // Founder decision 2026-07-14: everything sent into a group text must be
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
    expect(world.sent[0]!.body).toContain('Carol joined this group text.');
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

    expect(world.sent[0]!.body).toContain('A new member joined this group text.');
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

  it('A2P/CTIA (spec §5): every intro leads with the brand and TRAILS the opt-out', () => {
    // Founder wording (2026-07-14): content first, "Reply STOP to opt out." last.
    for (const names of [['Alice', 'Bob', 'Carol'], ['Alice'], [undefined, undefined]] as (string | undefined)[][]) {
      const body = composeIntroBody(names);
      expect(body.startsWith('Tenant Place LLC.')).toBe(true);
      expect(body.endsWith('Reply STOP to opt out.')).toBe(true);
    }
  });

  it('composeMemberAddedBody names the joiner (neutral fallback) with brand-first, STOP-last framing', () => {
    const body = composeMemberAddedBody('Carol Brown', ['Alice', 'Bob', 'Carol Brown']);
    expect(body.startsWith('Tenant Place LLC.')).toBe(true);
    expect(body.endsWith('Reply STOP to opt out.')).toBe(true);
    expect(body).toContain('Carol Brown joined this group text.');
    expect(body).toContain("You're now connected with Alice, Bob, and Carol Brown");
    // No name (phone-only member) → neutral label, NEVER a phone.
    expect(composeMemberAddedBody(undefined, ['Alice', undefined])).toContain(
      'A new member joined this group text.',
    );
    expect(composeMemberAddedBody('  ', ['Alice'])).toContain(
      'A new member joined this group text.',
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
});
