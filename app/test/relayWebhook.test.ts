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

  it('closed-group member texting STOP: opt-out registered like the 1:1 path AND the message lands in the 1:1 with via_closed_group (AF-4)', async () => {
    const group = seedGroup(world, {
      id: 'conv-closed-stop',
      status: 'closed',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    // ALICE is a real tenant contact whose PRIMARY number is ALICE.
    world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, Body: 'STOP', MessageSid: 'SMclosed-stop' }),
    );
    expect(res.status).toBe(200);
    // The STOP confirmation rides the TwiML response - parity with a STOP to the
    // main number (pre-feature, a closed group's number fell through to the 1:1).
    expect(res.text).toContain('<Message>');

    // The STOP still lands in ALICE's OWN 1:1 thread WITH provenance (the message
    // stays on the timeline exactly as the 1:1 path keeps it).
    const msg = world.messages.find((m) => m.provider_sid === 'SMclosed-stop')!;
    expect(msg.via_closed_group).toBe(group.conversationId);
    expect(msg.conversationId).not.toBe(group.conversationId);

    // Opt-out registered EXACTLY like the 1:1 STOP path:
    //  - the conversation-level flag on the 1:1 thread,
    expect(
      world.optOutSets.some((o) => o.conversationId === msg.conversationId && o.value === true),
    ).toBe(true);
    //  - the CONTACT-level flag (STOP arrived on the contact's primary number),
    expect(world.contacts.find((c) => c.contactId === 'c-alice')?.sms_opt_out).toBe(true);
    //  - and the opt-out audit row on the contact.
    expect(
      world.auditEvents.some(
        (a) => a.event_type === 'sms_opt_out_recorded' && a.entityKey === 'contacts#c-alice',
      ),
    ).toBe(true);
    // Closed group: never a fan-out to the old members.
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

  it('unknown sender, only a CLOSED group on the number: falls through to a 1:1 (NOT buried in the closed group) (AF-5)', async () => {
    const closed = seedGroup(world, {
      id: 'conv-closed-only',
      status: 'closed',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const beforeGroupRows = world.messages.filter(
      (m) => m.conversationId === closed.conversationId,
    ).length;
    const { app } = makeWebhookHarness({ world });

    // ZARA is on NO roster and EVERY group on this number is closed: burying the
    // text in a dead group transcript would hide it (a stranger/second-phone
    // sender, or a member from a NEW phone). It falls through to the normal 1:1
    // intake path instead (pre-feature behavior: a cleared number fell to 1:1).
    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ZARA, MessageSid: 'SMclosed-fallback' }),
    );
    expect(res.status).toBe(200);
    const msg = world.messages.find((m) => m.provider_sid === 'SMclosed-fallback')!;
    // Landed in a fresh NON-group 1:1 conversation, NOT the closed group, and
    // WITHOUT a provenance badge (ZARA is not a closed-roster member).
    expect(msg.conversationId).not.toBe(closed.conversationId);
    expect(msg.via_closed_group).toBeUndefined();
    expect(world.conversations.get(msg.conversationId)!.type).not.toBe('relay_group');
    // The closed group's transcript is unchanged, and nothing fanned out.
    expect(
      world.messages.filter((m) => m.conversationId === closed.conversationId).length,
    ).toBe(beforeGroupRows);
    expect(world.sent).toHaveLength(0);
  });
});

// Open-path keyword handling (relay-open-path-stop, plan Task 3): a member (or
// any sender) who texts STOP / HELP / an opt-in keyword to a pool number while
// the group is OPEN gets the keyword processed exactly like the 1:1 and closed
// paths - flags set/cleared on the sender's OWN 1:1 (never the group), filed
// reply on the TwiML, and the bare keyword NEVER relayed to the other members.
describe('open-path keyword handling (relay-open-path-stop)', () => {
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

  /** The 1:1 thread the keyword flag must land on = the conversation whose
   *  participant_phone is the SENDER's phone (never the relay group, whose
   *  participant_phone is the pool number). */
  function oneToOneFor(phone: string): ConversationItem | undefined {
    return [...world.conversations.values()].find((c) => c.participant_phone === phone);
  }

  it('STOP from a roster member: persisted on the relay thread, NO fan-out, 1:1 flagged, contact flagged (primary), annotation set, STOP confirmation TwiML', async () => {
    seedRelay(world);
    // ALICE is a real tenant contact whose PRIMARY number is ALICE.
    world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, Body: 'STOP', MessageSid: 'SMopen-stop' }),
    );
    expect(res.status).toBe(200);
    // The STOP confirmation rides the TwiML response (WE own the reply).
    expect(res.text).toContain('<Message>');

    // The bare STOP stays on the RELAY thread for the audit trail (one row,
    // inbound, attributed to Alice) - and is NEVER fanned out to Bob/Carol.
    const relayMsgs = world.messages.filter((m) => m.conversationId === 'conv-relay-1');
    expect(relayMsgs).toHaveLength(1);
    expect(relayMsgs[0]!.direction).toBe('inbound');
    expect(relayMsgs[0]!.relay_sender_key).toBe('c-alice');
    expect(relayMsgs[0]!.body).toBe('STOP');
    expect(world.sent).toHaveLength(0);

    // The conversation flag lands on Alice's OWN 1:1 - NEVER the relay group.
    const oneToOne = oneToOneFor(ALICE);
    expect(oneToOne).toBeDefined();
    expect(world.optOutSets).toContainEqual({ conversationId: oneToOne!.conversationId, value: true });
    expect(world.optOutSets.every((o) => o.conversationId !== 'conv-relay-1')).toBe(true);

    // Contact flag set (STOP on the contact's primary number - BE1 scope).
    expect(world.contacts.find((c) => c.contactId === 'c-alice')?.sms_opt_out).toBe(true);

    // Immediate staff-visibility annotation on the relay group for the member.
    expect(world.conversations.get('conv-relay-1')?.relay_opted_out_members?.['c-alice']).toBeDefined();
  });

  it('STOP from a roster member whose phone is NOT the contact primary: 1:1 flagged, contact flag NOT set (BE1 corner)', async () => {
    seedRelay(world);
    // Bob was rostered with phone BOB, but a later primary swap made BOB his
    // SECONDARY number - his contact's PRIMARY is a different number now.
    const bobPrimaryElsewhere = '+15550100042';
    world.contacts.push({ contactId: 'c-bob', type: 'tenant', phone: bobPrimaryElsewhere } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: BOB, Body: 'STOP', MessageSid: 'SMopen-stop-secondary' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Message>');

    // The 1:1 for the SECONDARY number (BOB) is flagged - the correct per-number
    // suppression record when the contact flag is out of reach.
    const oneToOne = oneToOneFor(BOB);
    expect(oneToOne).toBeDefined();
    expect(world.optOutSets).toContainEqual({ conversationId: oneToOne!.conversationId, value: true });

    // Contact flag NOT set: the STOP did not arrive on the contact's primary
    // number, so the primary must not be contaminated (number-scoped).
    expect(world.contacts.find((c) => c.contactId === 'c-bob')?.sms_opt_out).toBeUndefined();
    expect(world.flagWrites.some((w) => w.contactId === 'c-bob')).toBe(false);
    expect(world.sent).toHaveLength(0);
  });

  it('HELP from a member: filed HELP reply TwiML, no flags, no fan-out', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, Body: 'HELP', MessageSid: 'SMopen-help' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Message>'); // the filed HELP copy rides the TwiML
    // HELP never touches suppression state and never fans out.
    expect(world.optOutSets).toHaveLength(0);
    expect(world.flagWrites).toHaveLength(0);
    expect(world.conversations.get('conv-relay-1')?.relay_opted_out_members).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });

  it('START from a previously opted-out member: flags cleared, annotation cleared, welcome TwiML, no fan-out', async () => {
    seedRelay(world, {
      relay_opted_out_members: {
        'c-alice': { contactId: 'c-alice', phone: ALICE, at: '2026-07-16T00:00:00.000Z' },
      },
    });
    // Alice previously opted out; her contact flag is currently set.
    world.contacts.push({
      contactId: 'c-alice',
      type: 'tenant',
      phone: ALICE,
      sms_opt_out: true,
    } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, Body: 'START', MessageSid: 'SMopen-start' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Message>'); // the welcome copy rides the TwiML

    // The 1:1 flag is CLEARED (value false), and the contact flag is cleared.
    const oneToOne = oneToOneFor(ALICE);
    expect(oneToOne).toBeDefined();
    expect(world.optOutSets).toContainEqual({ conversationId: oneToOne!.conversationId, value: false });
    expect(world.contacts.find((c) => c.contactId === 'c-alice')?.sms_opt_out).toBe(false);

    // The Today attention annotation is cleared for the member.
    expect(world.conversations.get('conv-relay-1')?.relay_opted_out_members?.['c-alice']).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });

  it('a body merely CONTAINING a keyword fans out normally with empty TwiML and no flags', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ALICE, Body: 'please stop by at 3', MessageSid: 'SMopen-contains' }),
    );
    expect(res.status).toBe(200);
    // Not a keyword -> relays exactly as today: empty TwiML + fan-out to the others.
    expect(res.text).toContain('<Response/>');
    expect(world.sent.map((s) => s.to).sort()).toEqual([BOB, CAROL].sort());
    expect(world.sent.every((s) => s.body === 'Alice: please stop by at 3')).toBe(true);
    // No suppression state touched.
    expect(world.optOutSets).toHaveLength(0);
    expect(world.flagWrites).toHaveLength(0);
  });

  it('unknown-sender STOP on the open fallback: 1:1 + contact flagged, NO annotation, confirmation TwiML, no fan-out', async () => {
    seedRelay(world); // open group Alice/Bob/Carol; ZARA is on NO roster
    // ZARA is a known contact (primary = ZARA) but not a member of this group.
    world.contacts.push({ contactId: 'c-zara', type: 'tenant', phone: ZARA } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      relayInboundParams({ From: ZARA, Body: 'STOP', MessageSid: 'SMopen-unknown-stop' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Message>'); // the STOP confirmation still rides the TwiML

    // ZARA's own 1:1 + contact are flagged (same as a STOP to the main number).
    const oneToOne = oneToOneFor(ZARA);
    expect(oneToOne).toBeDefined();
    expect(world.optOutSets).toContainEqual({ conversationId: oneToOne!.conversationId, value: true });
    expect(world.contacts.find((c) => c.contactId === 'c-zara')?.sms_opt_out).toBe(true);

    // NO roster annotation: the sender is on no roster (nothing to suppress there).
    expect(world.conversations.get('conv-relay-1')?.relay_opted_out_members).toBeUndefined();
    expect(world.sent).toHaveLength(0);
  });

  it('redelivered STOP (same MessageSid): still no fan-out, idempotent flag re-writes, confirmation TwiML again', async () => {
    seedRelay(world);
    world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE } as ContactItem);
    const { app } = makeWebhookHarness({ world });

    const params = relayInboundParams({ From: ALICE, Body: 'STOP', MessageSid: 'SMopen-stop-redeliver' });
    const first = await signedTwilioPost(app, '/webhooks/twilio/sms', params);
    expect(first.status).toBe(200);
    expect(first.text).toContain('<Message>');

    // Twilio redelivers the SAME SID.
    const second = await signedTwilioPost(app, '/webhooks/twilio/sms', params);
    expect(second.status).toBe(200);
    expect(second.text).toContain('<Message>'); // confirmation re-rides the TwiML

    // The relay message persisted exactly ONCE (SID dedupe), never fanned out.
    expect(world.messages.filter((m) => m.provider_sid === 'SMopen-stop-redeliver')).toHaveLength(1);
    expect(world.sent).toHaveLength(0);
    // Idempotent re-writes: the flag remains set (both stores).
    expect(world.contacts.find((c) => c.contactId === 'c-alice')?.sms_opt_out).toBe(true);
    const oneToOne = oneToOneFor(ALICE);
    expect(oneToOne).toBeDefined();
    expect(world.optOutSets.filter((o) => o.conversationId === oneToOne!.conversationId && o.value === true).length).toBeGreaterThanOrEqual(1);
  });
});
