// T6.6 - the wiring. Earlier slices left four named seams with not-wired
// defaults; this proves the real implementations are behind them now.
//
// Why these are worth their own tests rather than trusting the one-line default
// swaps: every one of them is a place where a silent gap looks EXACTLY like
// health. An unwired detection enqueue leaves threads inbound-only with no
// error. An unwired classic filing leaves every cross-check event unmatched, so
// a healthy channel alarms as if detection had died. An unwired migration rail
// makes the cutover report claim success it did not earn.
import { describe, expect, it, vi } from 'vitest';
import {
  createFakeWorld,
  inboundSmsParams,
  makeWebhookHarness,
  signedTwilioPost,
  TENANT_PHONE,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { conversationIdForGroup } from '../src/lib/import/ids.js';
import { createGroupCrossCheck } from '../src/services/groupCrossCheck.js';
import { createGroupSendService } from '../src/services/groupSend.js';
import { createGroupRailService } from '../src/services/groupRail.js';
import { GROUP_CROSSCHECK_LAST_EVENT_AT_ID } from '../src/repos/settingsRepo.js';
import { loadConfig } from '../src/lib/config.js';

const SMS_PATH = '/webhooks/twilio/sms';
const CONVERSATIONS_PATH = '/webhooks/twilio/conversations';
const SENDER = TENANT_PHONE;
const MEMBER_B = '+15550100002';
const MEMBER_C = '+15550100003';
const GROUP_ID = conversationIdForGroup([SENDER, MEMBER_B, MEMBER_C]);
const RAIL = 'CH00000000000000000000000000000001';

function groupParams(overrides: Record<string, string> = {}): Record<string, string> {
  return inboundSmsParams({
    MessageSid: 'MMwiring0001',
    OtherRecipients0: MEMBER_B,
    OtherRecipients1: MEMBER_C,
    ...overrides,
  });
}

/** An onMessageAdded exactly as the live addendum capture shaped it. */
function messageAddedParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    EventType: 'onMessageAdded',
    MessageSid: 'IM00000000000000000000000000000001',
    ConversationSid: RAIL,
    ParticipantSid: 'MB00000000000000000000000000000001',
    Author: SENDER,
    Source: 'SMS',
    DateCreated: '2026-08-11T12:00:00.000Z',
    Body: 'anyone free saturday?',
    ...over,
  };
}

async function railedGroup(world: FakeWorld, app: Parameters<typeof signedTwilioPost>[0]) {
  await signedTwilioPost(app, SMS_PATH, groupParams());
  const thread = world.conversations.get(GROUP_ID)!;
  thread.twilio_conversation_sid = RAIL;
  return thread;
}

describe('T6.6(a) - detection enqueues the real groupRail.ensure job', () => {
  it('enqueues at thread creation AND again on rail-less inbound', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());
    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMwiring0002' }));

    // The second enqueue is the crash-window heal (spec 15.3): a rail that was
    // created at Twilio but never persisted locally gets another chance on
    // EVERY inbound, forever, until a rail is actually stored.
    expect(world.groupRailEnqueues.map((r) => r.reason)).toEqual(['created', 'rail_missing']);
    expect(world.groupRailEnqueues.every((r) => r.conversationId === GROUP_ID)).toBe(true);
  });

  it('stops enqueueing once a rail exists', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await railedGroup(world, app);
    world.groupRailEnqueues.length = 0;

    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMwiring0003' }));
    expect(world.groupRailEnqueues).toEqual([]);
  });
});

describe('T6.6(d) - a filed group inbound is the cross-check MATCH', () => {
  it('an event then its classic filing leaves NOTHING to alarm about', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await railedGroup(world, app);

    // The Conversations webhook sees the next carrier message...
    await signedTwilioPost(app, CONVERSATIONS_PATH, messageAddedParams());
    // ...and the classic webhook files the same one onto the railed thread.
    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMwiring0004' }));

    const sweep = await createGroupCrossCheck({
      messagesRepo: world.messagesRepo,
      settingsRepo: world.settingsRepo,
      businessNumber: '+15550000000',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    }).sweepCrossCheckDeadlines('2026-08-11T23:00:00.000Z');
    expect(sweep.alarms).toEqual([]);
  });

  it('WITHOUT the filing, the same event alarms - which is what the wiring prevents', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await railedGroup(world, app);

    await signedTwilioPost(app, CONVERSATIONS_PATH, messageAddedParams());

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const sweep = await createGroupCrossCheck({
      messagesRepo: world.messagesRepo,
      settingsRepo: world.settingsRepo,
      businessNumber: '+15550000000',
      logger: log as never,
    }).sweepCrossCheckDeadlines('2026-08-11T23:00:00.000Z');

    expect(sweep.alarms).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'group_crosscheck_inbound_missing' }),
      'conversation-bound inbound missing from classic webhook',
    );
  });

  it('the Conversations route records the liveness high-water mark', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await railedGroup(world, app);

    await signedTwilioPost(app, CONVERSATIONS_PATH, messageAddedParams());

    expect(typeof world.groupTimestamps.get(GROUP_CROSSCHECK_LAST_EVENT_AT_ID)).toBe('string');
  });
});

describe('T6.6(b) - the send path ensures a rail inline', () => {
  it('creates the missing rail through ensureGroupRail and posts into it', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, SMS_PATH, groupParams());

    const created: string[] = [];
    const port = {
      async createConversationWithParticipants(input: { uniqueName: string; members: string[] }) {
        created.push(input.uniqueName);
        return {
          conversation: { conversationSid: RAIL, uniqueName: input.uniqueName, state: 'active' },
          participants: input.members.map((address, i) => ({
            participantSid: `MB${i}`,
            address,
          })),
          failures: [],
        };
      },
      async fetchByUniqueName() {
        return undefined;
      },
      async postGroupMessage() {
        return {
          messageSid: 'IMposted0001',
          dateCreated: '2026-08-11T12:05:00.000Z',
        };
      },
      async fetchParticipants() {
        return [];
      },
    };

    // Every roster member needs a consent basis; detection stamped them.
    const rail = createGroupRailService({
      conversationsRepo: world.conversationsRepo,
      groupConversations: port as never,
      businessNumber: '+15550000000',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    const send = createGroupSendService({
      config: loadConfig({
        NODE_ENV: 'test',
        BUSINESS_PHONE_NUMBER: '+15550000000',
        CF_ORIGIN_SECRET: 'test-origin-secret',
      }),
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      groupConversations: port as never,
      rail,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    await send({ conversationId: GROUP_ID, body: 'saturday works', actorUserId: 'u-1' });

    // The rail was created through the ONE authoritative path (UniqueName is
    // our conversationId), and the thread now carries it.
    expect(created).toEqual([GROUP_ID]);
    expect(world.conversations.get(GROUP_ID)?.twilio_conversation_sid).toBe(RAIL);
  });
});
