// Inbound-message push broadcasts (inbound-message-push spec 3.2/3.4): every
// FRESH inbound message row persisted by the Twilio messaging webhook emits
// exactly ONE `message` push fan-out; a deduped redelivery or an echo drop
// emits none. Driven end-to-end through the real webhook harness so the four
// append paths (1:1, relay, closed-group intercept, native group) are exercised
// exactly as production runs them.
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
import { groupThreadLabel, relayThreadLabel } from '../src/lib/groupTitle.js';
import { conversationIdForGroup } from '../src/lib/import/ids.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  inboundSmsParams,
  makeWebhookHarness,
  OUR_NUMBER,
  signedTwilioPost,
  TENANT_PHONE,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const SMS_PATH = '/webhooks/twilio/sms';

// --- relay fixtures (copied from relayWebhook.test.ts) -----------------------
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const CAROL = '+15550100003';
const DAVE = '+15550100004';
/** A phone on NO roster for POOL (an unknown/stranger sender). */
const ZARA = '+15550100009';

// --- native-group fixtures (copied from groupTextWebhook.test.ts) ------------
const SENDER = TENANT_PHONE; // +15550100001
const MEMBER_B = '+15550100002';
const MEMBER_C = '+15550100003';
const GROUP_ROSTER = [SENDER, MEMBER_B, MEMBER_C];
const GROUP_ID = conversationIdForGroup(GROUP_ROSTER);

/** The flat push payload shape this feature emits (spec 3.4). */
interface MessagePushPayload {
  title: string;
  body: string;
  kind: string;
  conversationId: string;
}

/**
 * Assert the shared envelope (exactly one broadcast, kind 'message', no TTL -
 * a message push is "late is better than never") and hand back the payload.
 */
function soleMessagePayload(world: FakeWorld): MessagePushPayload {
  expect(world.pushBroadcasts).toHaveLength(1);
  const broadcast = world.pushBroadcasts[0]!;
  expect(broadcast.notification.kind).toBe('message');
  expect(broadcast.notification.ttlSeconds).toBeUndefined();
  return broadcast.notification.payload as unknown as MessagePushPayload;
}

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

/** Seed an extra relay group on POOL (the unknown-sender fallback world). */
function seedGroup(
  w: FakeWorld,
  opts: {
    id: string;
    participants: { contactId: string; phone: string; name?: string }[];
    createdAt: string;
  },
): ConversationItem {
  const conv: ConversationItem = {
    conversationId: opts.id,
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: opts.createdAt,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: opts.participants,
    created_at: opts.createdAt,
  };
  w.conversations.set(conv.conversationId, conv);
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

/** Inbound 1:1 MMS params (one image attachment by default). */
function inboundMmsParams(over: Record<string, string> = {}): Record<string, string> {
  return inboundSmsParams({
    MessageSid: 'SMmms0001',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/abc0',
    MediaContentType0: 'image/jpeg',
    ...over,
  });
}

/** Inbound params carrying a two-other-recipient group envelope. */
function groupParams(overrides: Record<string, string> = {}): Record<string, string> {
  return inboundSmsParams({
    MessageSid: 'MMgroup0001',
    OtherRecipients0: MEMBER_B,
    OtherRecipients1: MEMBER_C,
    ...overrides,
  });
}

let world: FakeWorld;

beforeEach(() => {
  _resetForTests();
  const logger = createLogger({ destination: createLogCapture().stream });
  configureJobsLogger(logger);
  configureScheduler(new InMemorySchedulerAdapter());
  world = createFakeWorld();
  // The relay fan-out runs in-process against the SAME world, exactly as
  // relayWebhook.test.ts wires it, so the relay paths behave end-to-end.
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

describe('inbound message push - fire-and-forget (spec D11)', () => {
  it('a sendToAll that NEVER resolves does not delay or fail the webhook ack', async () => {
    // The emit is `void pushService.sendToAll(...)`. If anyone ever awaits it,
    // this test hangs and fails on the vitest timeout instead of passing - the
    // recording fake resolves instantly, so nothing else pins the contract.
    world.pushService.sendToAll = (): Promise<never> => new Promise(() => {});
    const { app } = makeWebhookHarness({ world });

    const started = Date.now();
    const res = await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'hello' }));

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4_000);
    // The message was still filed - the push is a side effect, never a gate.
    expect(world.conversations.size).toBe(1);
  });
});

describe('inbound message push - plain 1:1 SMS', () => {
  it('pushes ONE flat message payload titled with the contact display name', async () => {
    world.contacts.push({
      contactId: 'contact-T',
      type: 'tenant',
      phone: TENANT_PHONE,
      firstName: 'Keisha',
      lastName: 'Jones',
    });
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'hey are we still on' }));

    const conv = [...world.conversations.values()][0]!;
    expect(soleMessagePayload(world)).toEqual({
      title: 'Keisha Jones',
      body: 'hey are we still on',
      kind: 'message',
      conversationId: conv.conversationId,
    });
  });

  it('titles an unknown number with the formatted phone, never the raw E.164', async () => {
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: 'who is this' }));

    const conv = [...world.conversations.values()][0]!;
    expect(soleMessagePayload(world)).toEqual({
      title: '(555) 010-0001',
      body: 'who is this',
      kind: 'message',
      conversationId: conv.conversationId,
    });
  });

  it('caps a long body at 300 code points INCLUDING the ellipsis', async () => {
    const { app } = makeWebhookHarness({ world });
    const long = 'x'.repeat(350);

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ Body: long }));

    const payload = soleMessagePayload(world);
    expect(Array.from(payload.body)).toHaveLength(300);
    expect(payload.body.endsWith('...')).toBe(true);
    expect(payload.body.startsWith('xxx')).toBe(true);
  });

  it('REDELIVERY: the identical webhook twice pushes exactly ONCE', async () => {
    const { app } = makeWebhookHarness({ world });
    const params = inboundSmsParams({ MessageSid: 'SMredeliver01' });

    await signedTwilioPost(app, SMS_PATH, params);
    await signedTwilioPost(app, SMS_PATH, params);

    expect(world.messages).toHaveLength(1);
    expect(world.pushBroadcasts).toHaveLength(1);
  });

  it('ECHO: a webhook From our own business number pushes ZERO times', async () => {
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ From: OUR_NUMBER, To: TENANT_PHONE, MessageSid: 'SMecho0001' }),
    );

    expect(res.status).toBe(200);
    expect(world.pushBroadcasts).toHaveLength(0);
    expect(world.messages).toHaveLength(0);
  });

  it('a keyword STOP still pushes - the rule is "persisted fresh row => push"', async () => {
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ Body: 'STOP', OptOutType: 'STOP', MessageSid: 'SMstop01' }),
    );

    const payload = soleMessagePayload(world);
    expect(payload.body).toBe('STOP');
    expect(payload.title).toBe('(555) 010-0001');
  });

  it('still pushes when ALL THREE awaited 1:1 side effects fail', async () => {
    // Unlike the relay/group blocks, the 1:1 emit sits BEHIND three awaited
    // side effects - captureContact, processInboundKeywords and
    // mirrorInboundMedia. All three are internally guarded today, so the
    // "one fresh append => one push" invariant holds only because those
    // guards are there. Nothing else pins that, so an unguarded throw added
    // to any of them would silently kill the alert on the highest-volume
    // path. This is the 1:1 twin of the relay touchLastActivity tripwire.
    world.contacts.push({
      contactId: 'contact-T',
      type: 'tenant',
      phone: TENANT_PHONE,
      firstName: 'Keisha',
      lastName: 'Jones',
    });
    // (1) captureContact: the participants-claim write rejects.
    world.conversationsRepo.setParticipantsIfAbsent = async (): Promise<never> => {
      throw new Error('participants claim exploded');
    };
    // (2) processInboundKeywords: the inbound_text consent stamp rejects.
    world.contactsRepo.update = async (): Promise<never> => {
      throw new Error('consent stamp exploded');
    };
    // (3) mirrorInboundMedia: the media fetch rejects.
    world.failMediaUrls.add('https://api.twilio.com/media/abc0');
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, inboundMmsParams({ Body: 'still alive' }));

    expect(res.status).toBe(200);
    const conv = [...world.conversations.values()][0]!;
    expect(soleMessagePayload(world)).toEqual({
      title: 'Keisha Jones',
      body: 'still alive',
      kind: 'message',
      conversationId: conv.conversationId,
    });
  });

  it('VOICE REGRESSION: a message push never touches the per-user sendToUser path', async () => {
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    expect(world.pushBroadcasts).toHaveLength(1);
    // pre_ring / missed_call / voicemail are the ONLY sendToUser senders.
    expect(world.pushSends).toHaveLength(0);
  });
});

describe('inbound message push - 1:1 MMS', () => {
  it('media-only (no body text): body is the attachment line', async () => {
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundMmsParams({ Body: '' }));

    expect(soleMessagePayload(world).body).toBe('Sent an attachment.');
  });

  it('body WITH media: the text alone, with no attachment suffix', async () => {
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundMmsParams({ Body: 'here is the doc' }));

    expect(soleMessagePayload(world).body).toBe('here is the doc');
  });
});

describe('inbound message push - relay group', () => {
  it('titles with the relay thread label and prefixes the body with the roster name', async () => {
    const relay = seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, relayInboundParams());

    expect(soleMessagePayload(world)).toEqual({
      title: 'With Alice & Bob & Carol',
      body: 'Alice: is the unit available?',
      kind: 'message',
      conversationId: 'conv-relay-1',
    });
    // Same label the inbox row renders (parity by construction).
    expect(soleMessagePayload(world).title).toBe(relayThreadLabel(relay));
  });

  it('relay media-only: "<sender> sent an attachment."', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      relayInboundParams({
        Body: '',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/relay0',
        MediaContentType0: 'image/jpeg',
      }),
    );

    expect(soleMessagePayload(world).body).toBe('Alice sent an attachment.');
  });

  it('relay with NEITHER text NOR media: the body is the sender label alone', async () => {
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, relayInboundParams({ Body: '', NumMedia: '0' }));

    expect(soleMessagePayload(world).body).toBe('Alice');
  });

  it('still pushes when touchLastActivity THROWS - the emit is not bound to `if (touched)`', async () => {
    // The three group/relay fresh-append blocks end with a BRACELESS
    // `if (touched) events.emit(...)`. If the push were folded into that `if`,
    // an inbox-touch failure would silently kill the alert. It must not.
    seedRelay(world);
    world.conversationsRepo.touchLastActivity = async (): Promise<never> => {
      throw new Error('touch exploded');
    };
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, relayInboundParams());

    expect(res.status).toBe(200);
    expect(world.touches).toHaveLength(0);
    expect(soleMessagePayload(world).body).toBe('Alice: is the unit available?');
  });

  it('REMOVED member reply: the sender falls back to the formatted phone', async () => {
    const relay = seedRelay(world);
    relay.participants = relay.participants!.filter((p) => p.phone !== CAROL);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      relayInboundParams({ From: CAROL, MessageSid: 'SMfrom-removed' }),
    );

    expect(soleMessagePayload(world)).toEqual({
      title: 'With Alice & Bob',
      body: '(555) 010-0003: is the unit available?',
      kind: 'message',
      conversationId: 'conv-relay-1',
    });
  });

  it('UNKNOWN sender on the open-group fallback: pushes on the newest open group', async () => {
    seedGroup(world, {
      id: 'conv-open-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
    });
    const newer = seedGroup(world, {
      id: 'conv-open-new',
      createdAt: '2026-06-01T00:00:00.000Z',
      participants: [
        { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
        { contactId: 'c-dave', phone: DAVE, name: 'Dave' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      relayInboundParams({ From: ZARA, MessageSid: 'SMunknown' }),
    );

    expect(soleMessagePayload(world)).toEqual({
      title: 'With Carol & Dave',
      body: '(555) 010-0009: is the unit available?',
      kind: 'message',
      conversationId: newer.conversationId,
    });
  });
});

describe('inbound message push - closed-group intercept', () => {
  it('renders as a plain 1:1: no sender prefix, the SENDER 1:1 conversationId', async () => {
    const group = seedRelay(world, { status: 'closed' });
    world.contacts.push({
      contactId: 'c-alice',
      type: 'tenant',
      phone: ALICE,
      firstName: 'Ana',
      lastName: 'Reyes',
    });
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, relayInboundParams());

    const oneToOne = [...world.conversations.values()].find(
      (c) => c.conversationId !== group.conversationId,
    )!;
    expect(soleMessagePayload(world)).toEqual({
      title: 'Ana Reyes',
      body: 'is the unit available?',
      kind: 'message',
      conversationId: oneToOne.conversationId,
    });
    // Never the dead group thread.
    expect(soleMessagePayload(world).conversationId).not.toBe(group.conversationId);
  });
});

describe('inbound message push - native group text', () => {
  it('titles with groupThreadLabel and prefixes the body with the sender label', async () => {
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    const thread = world.conversations.get(GROUP_ID)!;
    expect(soleMessagePayload(world)).toEqual({
      title: 'With (555) 010-0001 & (555) 010-0002 & (555) 010-0003',
      body: '(555) 010-0001: hello, looking for a 2 bed',
      kind: 'message',
      conversationId: GROUP_ID,
    });
    // Order-independent restatement: the title IS the canonical group label.
    expect(soleMessagePayload(world).title).toBe(groupThreadLabel(thread.participants));
  });

  it('uses roster NAMES once the members are known contacts', async () => {
    world.contacts.push(
      { contactId: 'c-ana', type: 'tenant', phone: SENDER, firstName: 'Ana', lastName: 'Reyes' },
      { contactId: 'c-ben', type: 'tenant', phone: MEMBER_B, firstName: 'Ben', lastName: 'Ortiz' },
      { contactId: 'c-cleo', type: 'tenant', phone: MEMBER_C, firstName: 'Cleo', lastName: 'Park' },
    );
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(soleMessagePayload(world)).toEqual({
      title: 'With Ana & Ben & Cleo',
      body: 'Ana Reyes: hello, looking for a 2 bed',
      kind: 'message',
      conversationId: GROUP_ID,
    });
  });
});
