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

  it('closed-thread reply: flagged received_on_closed_thread, NO fan-out', async () => {
    seedRelay(world, { status: 'closed' });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/sms', relayInboundParams());
    expect(res.status).toBe(200);
    const msg = world.messages.find((m) => m.provider_sid === 'SMrelay-in-1')!;
    expect(msg.received_on_closed_thread).toBe(true);
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
});
