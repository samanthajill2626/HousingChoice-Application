// Relay inbound webhook routing (M1.7) — the milestone golden tests for the
// INBOUND pipeline: To=pool number routes to the relay path (stored once +
// fan-out to the other members), echo suppression (From=pool number dropped),
// removed-member reply (persisted, no fan-out), closed-thread reply (flagged,
// no fan-out), and the per-recipient delivery callback. Driven through the
// REAL app (buildApp) + the webhook harness with the jobs machinery wired so
// fan-out runs in-process end-to-end.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const CAROL = '+15550100003';
const DAVE = '+15550100004';
// A phone on NO roster for POOL (an unknown/stranger sender).
const ZARA = '+15550100009';

const ERROR = 50;

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

function relayInboundParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SMrelay-in-1',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: ALICE,
    To: POOL,
    Body: 'is the unit available?',
    NumMedia: '0',
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

describe('relay inbound webhook (M1.7)', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    // Register the relay handler against the SAME world repos + adapter so the
    // webhook's enqueueImmediate fans out in-process, end-to-end.
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('To=pool number → stored ONCE on the relay thread + fans out to the OTHER members', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/sms', relayInboundParams());
    expect(res.status).toBe(200);

    // Stored once on the relay thread, direction inbound, relay_sender_key set.
    const relayMsgs = world.messages.filter((m) => m.conversationId === 'conv-relay-1');
    expect(relayMsgs).toHaveLength(1);
    expect(relayMsgs[0]!.direction).toBe('inbound');
    expect(relayMsgs[0]!.relay_sender_key).toBe('c-alice');

    // Fan-out to Bob + Carol only (never Alice), FROM the pool number, prefixed.
    expect(world.sent.map((s) => s.to).sort()).toEqual([BOB, CAROL].sort());
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
    expect(world.sent.every((s) => s.body === 'Alice: is the unit available?')).toBe(true);
  });

  it('echo suppression: a fan-out projected back (From = pool number) is dropped', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: POOL, To: BOB, MessageSid: 'SMecho-1' }),
    );
    expect(res.status).toBe(200);
    // Dropped: no message persisted, no fan-out.
    expect(world.messages.find((m) => m.provider_sid === 'SMecho-1')).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });

  it('removed-member reply: a former member texts the pool number → persisted, NO fan-out', async () => {
    const conv = seedRelay(world);
    conv.participants = conv.participants!.filter((p) => p.phone !== CAROL); // Carol removed
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: CAROL, MessageSid: 'SMfrom-removed' }),
    );
    expect(res.status).toBe(200);
    // Persisted for the audit trail, but NOT fanned out.
    expect(world.messages.find((m) => m.provider_sid === 'SMfrom-removed')).toBeDefined();
    expect(world.sent).toHaveLength(0);
  });

  it('closed-group late text from a member: delivered to the sender 1:1 with via_closed_group, NOT appended to the group, NO fan-out', async () => {
    const group = seedRelay(world, { status: 'closed' });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/sms', relayInboundParams());
    expect(res.status).toBe(200);
    // Delivered into ALICE's OWN 1:1 thread (a non-group conversation) with provenance.
    const msg = world.messages.find((m) => m.provider_sid === 'SMrelay-in-1')!;
    expect(msg).toBeDefined();
    expect(msg.conversationId).not.toBe(group.conversationId);
    expect(msg.via_closed_group).toBe(group.conversationId);
    // The old received_on_closed_thread flag is gone from the SMS path.
    expect(msg.received_on_closed_thread).toBeUndefined();
    // The closed GROUP transcript received nothing, and nothing fanned out.
    expect(world.messages.filter((m) => m.conversationId === group.conversationId)).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  });

  it('1:1 echo + 1:1 inbound still behave (relay routing does not regress the 1:1 path)', async () => {
    const { app } = makeWebhookHarness({ world });
    // To = OUR number (not a pool number) → 1:1 path. From a fresh phone.
    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: '+15550199999', To: '+15550009999', MessageSid: 'SM1to1' }),
    );
    expect(res.status).toBe(200);
    // A 1:1 conversation was created + the message stored (no relay fan-out).
    expect(world.messages.find((m) => m.provider_sid === 'SM1to1')).toBeDefined();
    expect(world.sent).toHaveLength(0);
  });

  it('per-recipient delivery callback: updates the right delivery_recipients slot, forward-only', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    // Fan out first so a relaysid pointer exists for Bob's send.
    await signedTwilioPost(app, '/webhooks/twilio/sms', relayInboundParams());
    const source = world.messages.find((m) => m.conversationId === 'conv-relay-1')!;
    // Find the SID the adapter assigned to Bob's send.
    const bobPtrEntry = [...world.relaySidPointers.entries()].find(([, ref]) => ref.memberKey === 'c-bob');
    expect(bobPtrEntry).toBeDefined();
    const bobSid = bobPtrEntry![0];

    // Simulate Twilio's status callback for Bob's recipient SID → delivered.
    const res = await signedTwilioPost(app, '/webhooks/twilio/status', {
      MessageSid: bobSid,
      MessageStatus: 'delivered',
      To: BOB,
      From: POOL,
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    const updated = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(updated.delivery_recipients?.['c-bob']?.status).toBe('delivered');

    // Forward-only: a stale 'sent' callback after 'delivered' is a no-op.
    await signedTwilioPost(app, '/webhooks/twilio/status', {
      MessageSid: bobSid,
      MessageStatus: 'sent',
      To: BOB,
      From: POOL,
      ApiVersion: '2010-04-01',
    });
    const after = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(after.delivery_recipients?.['c-bob']?.status).toBe('delivered'); // unchanged
  });

  it('raced fan-out leg: relaysid pointer ABSENT on the first lookup, PRESENT after the retry → processed, no unknown-SID drop', async () => {
    seedRelay(world);
    const { app, capture } = makeWebhookHarness({ world, statusUnknownSidRetryDelayMs: 5 });
    // Fan out first so a relaysid pointer exists for Bob's send.
    await signedTwilioPost(app, '/webhooks/twilio/sms', relayInboundParams());
    const source = world.messages.find((m) => m.conversationId === 'conv-relay-1')!;
    const bobPtrEntry = [...world.relaySidPointers.entries()].find(([, ref]) => ref.memberKey === 'c-bob');
    expect(bobPtrEntry).toBeDefined();
    const bobSid = bobPtrEntry![0];

    // Reproduce the race: the pointer is written AFTER the provider send returns,
    // so a fast delivery callback can miss it on the FIRST getRelaySidPointer
    // lookup, then find it a beat later. Return undefined once, then delegate.
    const realGetPtr = world.messagesRepo.getRelaySidPointer.bind(world.messagesRepo);
    let ptrReads = 0;
    world.messagesRepo.getRelaySidPointer = async (sid: string) => {
      if (sid === bobSid) {
        ptrReads += 1;
        if (ptrReads === 1) return undefined; // the pacing gap — not yet visible
      }
      return realGetPtr(sid);
    };

    const res = await signedTwilioPost(app, '/webhooks/twilio/status', {
      MessageSid: bobSid,
      MessageStatus: 'delivered',
      To: BOB,
      From: POOL,
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    // The retry re-checked the pointer, found it, and advanced Bob's slot.
    const updated = world.messages.find((m) => m.tsMsgId === source.tsMsgId)!;
    expect(updated.delivery_recipients?.['c-bob']?.status).toBe('delivered');
    expect(ptrReads).toBeGreaterThanOrEqual(2); // the retry actually re-checked the pointer
    // NOT dropped: the outcome was recovered, so no unknown-SID ERROR fired.
    const dropped = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('unknown provider SID'));
    expect(dropped).toBeUndefined();
  });

  it('relaysid pointer absent on BOTH attempts → unknown-SID ERROR + 200 ack (outcome genuinely lost)', async () => {
    seedRelay(world);
    const { app, capture } = makeWebhookHarness({ world, statusUnknownSidRetryDelayMs: 5 });
    const res = await signedTwilioPost(app, '/webhooks/twilio/status', {
      MessageSid: 'SM-never-persisted',
      MessageStatus: 'delivered',
      To: BOB,
      From: POOL,
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    const err = capture.atLevel(ERROR).find((l) => String(l['msg']).includes('unknown provider SID'));
    expect(err).toBeDefined();
    expect(err!['providerSid']).toBe('SM-never-persisted');
  });
});

// One pool number now fronts MANY participant-disjoint groups (relay-number-
// lifecycle): pool_number is never cleared, so inbound resolves on (To, From).
describe('relay inbound - (To, From) resolution (relay-number-lifecycle)', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ destination: createLogCapture().stream });
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
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  /** Seed an extra relay group on POOL (disjoint from the others by default). */
  function seedGroup(
    w: FakeWorld,
    opts: {
      id: string;
      status?: 'open' | 'closed';
      participants: { contactId: string; phone: string; name?: string }[];
      createdAt?: string;
    },
  ): ConversationItem {
    const now = opts.createdAt ?? new Date().toISOString();
    const conv: ConversationItem = {
      conversationId: opts.id,
      participant_phone: POOL,
      pool_number: POOL,
      status: opts.status ?? 'open',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: opts.participants,
      created_at: now,
    };
    w.conversations.set(conv.conversationId, conv);
    return conv;
  }

  it('open-match: two OPEN groups share the number; From routes to ITS group only (fan-out for that group only)', async () => {
    seedGroup(world, {
      id: 'conv-g1',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    seedGroup(world, {
      id: 'conv-g2',
      participants: [
        { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
        { contactId: 'c-dave', phone: DAVE, name: 'Dave' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: CAROL, MessageSid: 'SMg2-in' }),
    );
    expect(res.status).toBe(200);
    // Stored on group2 only, attributed to Carol; group1 untouched.
    const stored = world.messages.find((m) => m.provider_sid === 'SMg2-in')!;
    expect(stored.conversationId).toBe('conv-g2');
    expect(stored.relay_sender_key).toBe('c-carol');
    expect(world.messages.filter((m) => m.conversationId === 'conv-g1')).toHaveLength(0);
    // Fan-out to Dave ONLY (group2's other member), from the pool number.
    expect(world.sent.map((s) => s.to)).toEqual([DAVE]);
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);
  });

  it('closed-match: late text delivers into the sender 1:1 (tenant_1to1) with via_closed_group, empty TwiML, no fan-out, group unchanged', async () => {
    const group = seedGroup(world, {
      id: 'conv-closed-a',
      status: 'closed',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, MessageSid: 'SMlate-1' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>'); // empty TwiML, no auto-reply
    const msg = world.messages.find((m) => m.provider_sid === 'SMlate-1')!;
    expect(msg.via_closed_group).toBe(group.conversationId);
    // Landed in a NON-group 1:1 conversation, typed tenant_1to1 (alice is a tenant).
    const oneToOne = world.conversations.get(msg.conversationId)!;
    expect(oneToOne.type).toBe('tenant_1to1');
    expect(oneToOne.conversationId).not.toBe(group.conversationId);
    // Group transcript unchanged; nothing fanned out.
    expect(world.messages.filter((m) => m.conversationId === group.conversationId)).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  });

  it('open WINS over closed: a sender in BOTH a closed and an open group on one number routes to the OPEN group', async () => {
    const closed = seedGroup(world, {
      id: 'conv-closed-b',
      status: 'closed',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    seedGroup(world, {
      id: 'conv-open-b',
      status: 'open',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, MessageSid: 'SMprefer-open' }),
    );
    expect(res.status).toBe(200);
    // Routed to the OPEN group (relay path): stored there + fanned out to Carol.
    const stored = world.messages.find((m) => m.provider_sid === 'SMprefer-open')!;
    expect(stored.conversationId).toBe('conv-open-b');
    expect(stored.via_closed_group).toBeUndefined(); // NOT the closed-group 1:1 intercept
    expect(world.sent.map((s) => s.to)).toEqual([CAROL]);
    // The closed group's 1:1 intercept did NOT fire.
    expect(world.messages.filter((m) => m.conversationId === closed.conversationId)).toHaveLength(0);
  });

  it('multiple closed matches: the NEWEST closed group wins for provenance', async () => {
    // Older closed group inserted FIRST, newer closed group SECOND - so a naive
    // first-match (no created_at sort) would pick the older one and fail here.
    seedGroup(world, {
      id: 'conv-closed-old',
      status: 'closed',
      createdAt: '2026-01-01T00:00:00.000Z',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const newer = seedGroup(world, {
      id: 'conv-closed-new',
      status: 'closed',
      createdAt: '2026-06-01T00:00:00.000Z',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-dave', phone: DAVE, name: 'Dave' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, MessageSid: 'SMnewest-closed' }),
    );
    expect(res.status).toBe(200);
    const msg = world.messages.find((m) => m.provider_sid === 'SMnewest-closed')!;
    expect(msg.via_closed_group).toBe(newer.conversationId); // the NEWER closed group
    expect(world.sent).toHaveLength(0);
  });

  it('unknown sender: persisted on the newest OPEN group, no fan-out (non-member behavior preserved)', async () => {
    seedGroup(world, {
      id: 'conv-open-old',
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const newer = seedGroup(world, {
      id: 'conv-open-new',
      status: 'open',
      createdAt: '2026-06-01T00:00:00.000Z',
      participants: [
        { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
        { contactId: 'c-dave', phone: DAVE, name: 'Dave' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    // ZARA is on NO roster for this number.
    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ZARA, MessageSid: 'SMunknown' }),
    );
    expect(res.status).toBe(200);
    const msg = world.messages.find((m) => m.provider_sid === 'SMunknown')!;
    expect(msg.conversationId).toBe(newer.conversationId); // newest OPEN group
    expect(msg.via_closed_group).toBeUndefined();
    expect(world.sent).toHaveLength(0); // non-member -> no fan-out
  });

  it('echo guard: From is the pool number of a CLOSED-only group is still dropped', async () => {
    seedGroup(world, {
      id: 'conv-closed-echo',
      status: 'closed',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: POOL, To: BOB, MessageSid: 'SMecho-closed' }),
    );
    expect(res.status).toBe(200);
    expect(world.messages.find((m) => m.provider_sid === 'SMecho-closed')).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });

  it('closed-group fallback persist (unknown sender, only a CLOSED group exists) no longer sets received_on_closed_thread', async () => {
    const closed = seedGroup(world, {
      id: 'conv-closed-only',
      status: 'closed',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    // Unknown sender, no OPEN group -> fallback persists on the newest (closed)
    // group for the audit trail, no fan-out - and WITHOUT the retired flag.
    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ZARA, MessageSid: 'SMclosed-fallback' }),
    );
    expect(res.status).toBe(200);
    const msg = world.messages.find((m) => m.provider_sid === 'SMclosed-fallback')!;
    expect(msg.conversationId).toBe(closed.conversationId);
    expect(msg.received_on_closed_thread).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });
});
