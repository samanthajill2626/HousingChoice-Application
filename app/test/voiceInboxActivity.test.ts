// Calls surface in the inbox (docs/issues/inbound-calls-invisible-in-inbox.md).
// The voice paths stamp the conversation the same way the text/email writers
// do: touchLastActivity (re-sort + preview) on every founder-bridge / outbound
// call lifecycle step, and incrementUnread ONLY for an inbound MISS and a
// voicemail. Driven through the real app + the webhook harness with real
// signatures; the fake conversations repo models the repo primitives.
//
// Contract pinned here:
//  - ring: NO conversation write (a caller-abandon produces no Dial summary, so
//    a ring stamp could never be closed out - adversarial r1 HIGH 1 / Q1)
//  - terminal miss (Dial summary): unread +1 + "Missed call"; the unread write
//    lands BEFORE message.persisted (a viewer's re-mark-read must clear it)
//  - redelivered terminal summary: no second increment (forward-only machine)
//  - answered: "Call - <talk time>", never unread; its bridge recording never
//    touches unread either
//  - per-leg child callback: no conversation write at all
//  - voicemail upgrade: unread +1 again + "Voicemail", ONE message.persisted
//    emitted AFTER the counter moved; redelivery no-ops
//  - masked relay calls (bridge + refusal): NO conversation write (non-goal)
//  - outbound originate: NO write at placement (a never-accepted originate has
//    no callback that could close it out); the Dial summary stamps "Outgoing
//    call - ..." and never unread
//  - a missed call RESURFACES a soft-deleted contact's row; an outbound call
//    does not
//  - accepted v1 wart: the missed-call auto-text overwrites the preview with
//    the auto-text body; the row stays unread
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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
import { registerMissedCallAutoTextJobHandler } from '../src/jobs/missedCallAutoText.js';
import { createLogger } from '../src/lib/logger.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ConversationUpdatedEvent } from '../src/lib/events.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  ORIGIN_SECRET,
  OUR_NUMBER,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { TEST_ADMIN_USER, TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const CALLER = '+15550177777';
const HOLDER_CELL = '+15550160000';
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const STRANGER = '+15550133333';
const NAV_CELL = '+15550140000';
const TARGET = '+15550188888';
const RECORDING_URL = 'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/RE1111';

function bizVoiceParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAbiz0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: CALLER,
    To: OUR_NUMBER,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

function recordingParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAbiz0001',
    RecordingSid: 'RE1111',
    RecordingStatus: 'completed',
    RecordingUrl: RECORDING_URL,
    RecordingDuration: '6',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

function founderHarness(world: FakeWorld) {
  const harness = makeWebhookHarness({ world });
  const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId);
  if (admin) {
    admin.cell = HOLDER_CELL;
    admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
    void harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId);
  }
  return harness;
}

/** Ring the founder bridge once from a known tenant; return the app + the caller's 1:1 thread. */
async function ringBridge(world: FakeWorld) {
  world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
  const harness = founderHarness(world);
  const res = await signedTwilioPost(harness.app, '/webhooks/twilio/voice', bizVoiceParams());
  expect(res.status).toBe(200);
  const conv = [...world.conversations.values()].find((c) => c.participant_phone === CALLER);
  expect(conv).toBeDefined();
  return { app: harness.app, harness, conv: conv as ConversationItem };
}

function convUpdatedEvents(world: FakeWorld): ConversationUpdatedEvent[] {
  return world.emitted
    .filter((e) => e.event === 'conversation.updated')
    .map((e) => e.payload as ConversationUpdatedEvent);
}

async function noAnswer(app: Parameters<typeof signedTwilioPost>[0], callSid = 'CAbiz0001') {
  return signedTwilioPost(app, '/webhooks/twilio/voice/status', {
    CallSid: callSid,
    DialCallStatus: 'no-answer',
    ApiVersion: '2010-04-01',
  });
}

describe('inbound founder-bridge call -> inbox activity + unread', () => {
  it('ring: NO conversation write (no touch, no unread, no conversation.updated) - the Dial summary owns the stamp', async () => {
    const world = createFakeWorld();
    const { conv } = await ringBridge(world);
    expect(world.touches).toHaveLength(0);
    expect(world.unreadIncrements).toHaveLength(0);
    expect(conv.last_message_preview).toBeUndefined();
    expect(conv.unread_count ?? 0).toBe(0);
    expect(convUpdatedEvents(world)).toHaveLength(0);
    // The call row itself is still announced live.
    expect(world.emitted.filter((e) => e.event === 'message.persisted')).toHaveLength(1);
  });

  it('a redelivered inbound webhook (dedupe) does not re-emit', async () => {
    const world = createFakeWorld();
    const { app } = await ringBridge(world);
    const emittedBefore = world.emitted.length;
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    expect(world.touches).toHaveLength(0);
    expect(world.emitted).toHaveLength(emittedBefore);
  });

  it('terminal MISS: unread +1 with the byUnread flag, "Missed call" preview, and the unread write lands BEFORE message.persisted', async () => {
    const world = createFakeWorld();
    const { app, conv } = await ringBridge(world);
    world.emitted.length = 0;

    // Snapshot the thread's unread state at the moment message.persisted fires:
    // a staff member viewing the contact re-marks read on that event, so the
    // increment must already be visible or the miss stays unread forever.
    let unreadAtPersist: number | undefined;
    world.events.on('message.persisted', () => {
      unreadAtPersist = world.conversations.get(conv.conversationId)?.unread_count ?? 0;
    });

    const res = await noAnswer(app);
    expect(res.status).toBe(200);

    const fresh = world.conversations.get(conv.conversationId)!;
    expect(fresh.unread_count).toBe(1);
    expect(fresh.unread_flag).toBe('unread');
    expect(fresh.last_message_preview).toBe('Missed call');
    expect(fresh.status).toBe('open');
    expect(world.unreadIncrements).toEqual([conv.conversationId]);
    expect(unreadAtPersist).toBe(1);

    const order = world.emitted.map((e) => e.event);
    expect(order.indexOf('conversation.updated')).toBeGreaterThan(order.indexOf('message.persisted'));
    const updated = convUpdatedEvents(world);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.unread_count).toBe(1);
    expect(updated[0]!.preview).toBe('Missed call');
  });

  it('a redelivered terminal summary never double-counts (forward-only machine gates the write)', async () => {
    const world = createFakeWorld();
    const { app, conv } = await ringBridge(world);
    await noAnswer(app);
    const touchesAfterFirst = world.touches.length;
    await noAnswer(app);
    expect(world.conversations.get(conv.conversationId)!.unread_count).toBe(1);
    expect(world.unreadIncrements).toHaveLength(1);
    expect(world.touches).toHaveLength(touchesAfterFirst);
  });

  it('ANSWERED (press-1 then completed): "Call - <talk time>" preview, re-sorted, never unread', async () => {
    const world = createFakeWorld();
    const { app, conv } = await ringBridge(world);
    await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/whisper-gate?conversationId=x&parentCallSid=CAbiz0001&leg=founder',
      { Digits: '1', CallSid: 'CAfounder-leg' },
    );
    const before = world.conversations.get(conv.conversationId)!.last_activity_at;
    await new Promise((r) => setTimeout(r, 2));
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '42',
      ApiVersion: '2010-04-01',
    });
    const fresh = world.conversations.get(conv.conversationId)!;
    expect(fresh.last_message_preview).toBe('Call - 42s');
    expect(fresh.last_activity_at > before).toBe(true);
    expect(fresh.unread_count ?? 0).toBe(0);
    expect(fresh.unread_flag).toBeUndefined();
    expect(world.unreadIncrements).toHaveLength(0);
    expect(convUpdatedEvents(world)).toHaveLength(1);

    // The answered bridge's recording (record-from-answer-dual) lands: it must
    // never become a voicemail, never touch unread, never re-preview.
    const touchesBefore = world.touches.length;
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams({ RecordingDuration: '42' }));
    expect(world.messages.find((m) => m.provider_sid === 'CAbiz0001')!.call_outcome).toBe('answered');
    expect(world.touches).toHaveLength(touchesBefore);
    expect(world.unreadIncrements).toHaveLength(0);
    expect(world.conversations.get(conv.conversationId)!.last_message_preview).toBe('Call - 42s');
  });

  it('busy / canceled Dial summaries are misses too: unread +1, "Missed call"', async () => {
    for (const status of ['busy', 'canceled']) {
      const world = createFakeWorld();
      const { app, conv } = await ringBridge(world);
      await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
        CallSid: 'CAbiz0001',
        DialCallStatus: status,
        ApiVersion: '2010-04-01',
      });
      const fresh = world.conversations.get(conv.conversationId)!;
      expect(fresh.unread_count, status).toBe(1);
      expect(fresh.last_message_preview, status).toBe('Missed call');
    }
  });

  it('a per-leg child callback (ParentCallSid, no DialCallStatus) writes nothing on the conversation', async () => {
    const world = createFakeWorld();
    const { app } = await ringBridge(world);
    const touchesBefore = world.touches.length;
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAfounder-leg',
      ParentCallSid: 'CAbiz0001',
      CallStatus: 'ringing',
      ApiVersion: '2010-04-01',
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAfounder-leg',
      ParentCallSid: 'CAbiz0001',
      CallStatus: 'completed',
      ApiVersion: '2010-04-01',
    });
    expect(world.touches).toHaveLength(touchesBefore);
    expect(world.unreadIncrements).toHaveLength(0);
  });

  it('VOICEMAIL upgrade: unread +1 again (a read miss re-flags), "Voicemail" preview; a redelivered recording no-ops', async () => {
    const world = createFakeWorld();
    const { app, conv } = await ringBridge(world);
    await noAnswer(app);
    // Staff read the miss in between (the row is clean again).
    await world.conversationsRepo.resetUnread(conv.conversationId);
    world.emitted.length = 0;
    // The ordering rule holds on THIS path too (adversarial r1 HIGH 2): every
    // message.persisted the recording callback emits must already see the
    // voicemail's unread bump, or a viewer's re-mark-read clears nothing.
    const unreadAtPersist: number[] = [];
    world.events.on('message.persisted', () => {
      unreadAtPersist.push(world.conversations.get(conv.conversationId)?.unread_count ?? 0);
    });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200);
    const fresh = world.conversations.get(conv.conversationId)!;
    expect(world.messages.find((m) => m.provider_sid === 'CAbiz0001')!.call_outcome).toBe('voicemail');
    expect(fresh.unread_count).toBe(1);
    expect(fresh.unread_flag).toBe('unread');
    expect(fresh.last_message_preview).toBe('Voicemail');
    expect(unreadAtPersist).toEqual([1]);
    const order = world.emitted.map((e) => e.event);
    expect(order.indexOf('conversation.updated')).toBeGreaterThan(order.indexOf('message.persisted'));
    // The voicemail push still fires (once).
    expect(world.pushSends.filter((p) => p.notification.kind === 'voicemail')).toHaveLength(1);

    const incrementsAfter = world.unreadIncrements.length;
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(world.unreadIncrements).toHaveLength(incrementsAfter);
    expect(world.conversations.get(conv.conversationId)!.unread_count).toBe(1);
  });

  it('a sub-2s (discarded) voicemail recording touches nothing', async () => {
    const world = createFakeWorld();
    const { app, conv } = await ringBridge(world);
    await noAnswer(app);
    const touchesBefore = world.touches.length;
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams({ RecordingDuration: '1' }));
    expect(world.touches).toHaveLength(touchesBefore);
    expect(world.conversations.get(conv.conversationId)!.unread_count).toBe(1);
    expect(world.conversations.get(conv.conversationId)!.last_message_preview).toBe('Missed call');
  });

  it('a touch failure never 5xxs the webhook (the call row is already safe)', async () => {
    const world = createFakeWorld();
    const { app, conv } = await ringBridge(world);
    // Sabotage: the conversation vanishes before the terminal summary.
    world.conversations.delete(conv.conversationId);
    const res = await noAnswer(app);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record');
  });
});

describe('unknown caller -> the auto-captured unknown_1to1 thread carries the unread miss', () => {
  it('a first-ever call from a stranger that is missed leaves an unread unknown_1to1 thread linked to the stub contact', async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams({ From: STRANGER, CallSid: 'CAstr0001' }));
    await noAnswer(app, 'CAstr0001');
    const conv = [...world.conversations.values()].find((c) => c.participant_phone === STRANGER)!;
    expect(conv.type).toBe('unknown_1to1');
    expect(conv.unread_count).toBe(1);
    expect(conv.last_message_preview).toBe('Missed call');
    expect(conv.participants?.[0]?.contactId).toBeDefined();
    const stub = world.contacts.find((c) => c.contactId === conv.participants?.[0]?.contactId);
    expect(stub?.type).toBe('unknown');
  });
});

describe('masked relay calls stay OUT of the inbox activity (non-goal)', () => {
  function seedRelay(world: FakeWorld, over: Partial<ConversationItem> = {}): ConversationItem {
    const now = '2026-08-01T00:00:00.000Z';
    const conv: ConversationItem = {
      conversationId: 'conv-relay-voice-1',
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open',
      last_activity_at: now,
      last_message_preview: 'relay text',
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
      created_at: now,
      ...over,
    };
    world.conversations.set(conv.conversationId, conv);
    return conv;
  }

  it('a masked bridge (member calls the pool number) and its terminal miss never touch the relay thread', async () => {
    const world = createFakeWorld();
    const relay = seedRelay(world);
    const { app } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams({ From: ALICE, To: POOL, CallSid: 'CArelay01' }));
    await noAnswer(app, 'CArelay01');
    const fresh = world.conversations.get(relay.conversationId)!;
    expect(fresh.last_message_preview).toBe('relay text');
    expect(fresh.last_activity_at).toBe('2026-08-01T00:00:00.000Z');
    expect(fresh.unread_count ?? 0).toBe(0);
    expect(world.touches).toHaveLength(0);
    expect(world.unreadIncrements).toHaveLength(0);
  });

  it('a masked refusal (stranger calls the pool number) never touches the relay thread', async () => {
    const world = createFakeWorld();
    const relay = seedRelay(world);
    const { app } = founderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams({ From: STRANGER, To: POOL, CallSid: 'CArelay02' }));
    const fresh = world.conversations.get(relay.conversationId)!;
    expect(fresh.last_message_preview).toBe('relay text');
    expect(fresh.unread_count ?? 0).toBe(0);
    expect(world.touches).toHaveLength(0);
  });
});

describe('outbound originate -> "Outgoing call" lifecycle, never unread', () => {
  function seedNavigator(harness: ReturnType<typeof makeWebhookHarness>) {
    const nav = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    nav.cell = NAV_CELL;
    nav.cell_verified_at = '2026-07-01T00:00:00.000Z';
  }

  async function originate(world: FakeWorld) {
    world.contacts.push({ contactId: 'c-target', type: 'tenant', phone: TARGET, firstName: 'Jane', lastName: 'Doe' });
    const harness = makeWebhookHarness({ world });
    seedNavigator(harness);
    const res = await request(harness.app)
      .post('/api/contacts/c-target/call')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    const conv = [...world.conversations.values()].find((c) => c.participant_phone === TARGET)!;
    return { app: harness.app, conv, callSid: res.body.callSid as string };
  }

  it('placing the call writes NOTHING on the conversation (no touch, no unread, no conversation.updated)', async () => {
    const world = createFakeWorld();
    const { conv } = await originate(world);
    expect(world.touches).toHaveLength(0);
    expect(conv.last_message_preview).toBeUndefined();
    expect(conv.unread_count ?? 0).toBe(0);
    expect(world.unreadIncrements).toHaveLength(0);
    expect(convUpdatedEvents(world)).toHaveLength(0);
  });

  it('a navigator who never accepts (whisper-gate timeout -> <Hangup>, no <Dial>) leaves the thread untouched', async () => {
    // Adversarial r1 HIGH 1: the navigator leg has no status callback and no
    // <Dial> ever runs, so nothing could close out a stamp made at placement.
    const world = createFakeWorld();
    const { app, conv, callSid } = await originate(world);
    const res = await signedTwilioPost(
      app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conv.conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { CallSid: 'CAnav-leg' }, // no Digits
    );
    expect(res.text).toContain('<Hangup');
    // The only callback Twilio could still send: the parent leg's own terminal
    // status (no DialCallStatus) - dropped by design.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: callSid,
      CallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });
    expect(world.touches).toHaveLength(0);
    expect(world.conversations.get(conv.conversationId)!.last_message_preview).toBeUndefined();
    expect(convUpdatedEvents(world)).toHaveLength(0);
  });

  it('answered outbound (press-1 then completed 42s) -> "Outgoing call - 42s"; no unread', async () => {
    const world = createFakeWorld();
    const { app, conv, callSid } = await originate(world);
    await signedTwilioPost(
      app,
      `/webhooks/twilio/voice/whisper-gate?conversationId=${encodeURIComponent(conv.conversationId)}&parentCallSid=${encodeURIComponent(callSid)}&outbound=1`,
      { Digits: '1', CallSid: 'CAnav-leg' },
    );
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: callSid,
      DialCallStatus: 'completed',
      DialCallDuration: '42',
      ApiVersion: '2010-04-01',
    });
    const fresh = world.conversations.get(conv.conversationId)!;
    expect(fresh.last_message_preview).toBe('Outgoing call - 42s');
    expect(fresh.unread_count ?? 0).toBe(0);
  });

  it('outbound no-answer -> "Outgoing call - no answer"; NEVER unread (staff placed it)', async () => {
    const world = createFakeWorld();
    const { app, conv, callSid } = await originate(world);
    await noAnswer(app, callSid);
    const fresh = world.conversations.get(conv.conversationId)!;
    expect(fresh.last_message_preview).toBe('Outgoing call - no answer');
    expect(fresh.unread_count ?? 0).toBe(0);
    expect(world.unreadIncrements).toHaveLength(0);
  });
});

describe('soft-deleted contacts: a missed call resurfaces the row, an outbound call does not', () => {
  const authed = (r: request.Test) => r.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  it('a MISSED call from a soft-deleted contact resurfaces their inbox row (deleted: true, unread 1)', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    const harness = founderHarness(world);
    const del = await authed(request(harness.app).delete('/api/contacts/c-caller'));
    expect(del.status).toBe(200);
    expect((await authed(request(harness.app).get('/api/inbox'))).body.rows).toHaveLength(0);

    await signedTwilioPost(harness.app, '/webhooks/twilio/voice', bizVoiceParams());
    await noAnswer(harness.app);

    const rows = (await authed(request(harness.app).get('/api/inbox'))).body.rows as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['contactId'] === 'c-caller');
    expect(row).toMatchObject({ contactId: 'c-caller', deleted: true, unreadCount: 1, channel: 'call', preview: 'Missed call' });
  });

  it('an OUTBOUND call to a soft-deleted contact (Dial summary no-answer) does not resurface the row', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-target', type: 'tenant', phone: TARGET, firstName: 'Jane', lastName: 'Doe' });
    const harness = makeWebhookHarness({ world });
    const nav = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    nav.cell = NAV_CELL;
    nav.cell_verified_at = '2026-07-01T00:00:00.000Z';
    // Originate BEFORE the delete (originate itself has no deleted guard - a
    // separate open issue - but that is not what this pins).
    const res = await authed(request(harness.app).post('/api/contacts/c-target/call').send({}));
    expect(res.status).toBe(200);
    const del = await authed(request(harness.app).delete('/api/contacts/c-target'));
    expect(del.status).toBe(200);
    await noAnswer(harness.app, res.body.callSid as string);

    const conv = [...world.conversations.values()].find((c) => c.participant_phone === TARGET)!;
    expect(conv.last_message_preview).toBe('Outgoing call - no answer');
    expect(conv.unread_count ?? 0).toBe(0);
    const rows = (await authed(request(harness.app).get('/api/inbox'))).body.rows as Array<Record<string, unknown>>;
    expect(rows.find((r) => r['contactId'] === 'c-target')).toBeUndefined();
  });
});

describe('accepted v1 wart: the missed-call auto-text overwrites the call preview', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerMissedCallAutoTextJobHandler({
      settingsRepo: world.settingsRepo,
      messagesRepo: world.messagesRepo,
      sendMessageService: createSendMessageService({
        config: makeWebhookHarness({ world }).config,
        logger,
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
      }),
      logger,
    });
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('after the auto-text the preview is the auto-text body but the thread stays UNREAD (design item 4, v1)', async () => {
    const { app, conv } = await ringBridge(world);
    await noAnswer(app);
    expect(world.sent).toHaveLength(1);
    const fresh = world.conversations.get(conv.conversationId)!;
    // (toPreview truncates long bodies - compare the head.)
    expect(fresh.last_message_preview?.startsWith(world.settings.missedCallAutoText!.slice(0, 40))).toBe(true);
    expect(fresh.last_message_preview).not.toBe('Missed call');
    expect(fresh.unread_count).toBe(1);
    expect(fresh.unread_flag).toBe('unread');
  });
});
