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
  composeNameList,
  composeRelayBody,
  joinedName,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import { buildTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
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
    expect(composeIntroBody(names)).toBe(expected);
  });

  it('the nameless multi-member intro is BYTE-IDENTICAL too', () => {
    expect(composeIntroBody([undefined, undefined, undefined])).toBe(
      "Hey, it's Sam. You're now connected with 2 other people on this number. Reply here " +
        'and everyone in the group sees it. Use this group text for anything that comes up. ' +
        'It can be a long process, so ask me anything in here!',
    );
    expect(composeIntroBody([undefined, undefined])).toBe(
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
    const body = composeIntroBody([undefined]);
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
      'Hey Alicia! Putting you in a group text with Marcus to tour 412 Oak St at 3:00 PM. ' +
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
      'Hey Alicia! Putting you in a group text with Marcus to tour 412 Oak St on Tue, Sep 8 ' +
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
      'Hey Alicia! Excited to have you move into 412 Oak St. Please use this group text for ' +
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
