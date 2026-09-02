// T5.1 - the Conversations rail adapter (groupConversationsPort).
//
// The PARTICIPANT SHAPE is the load-bearing assertion here: the business number
// is its OWN participant carrying ONLY a projected address (no identity, no
// address), and each member is a SEPARATE participant carrying ONLY an address
// (no proxy address, no projected address). Combining address + projected on
// one participant returns a misleading `50407 Invalid messaging binding
// address` - verified live on the dev account 2026-08-11.
import { describe, it, expect, vi } from 'vitest';
import {
  TwilioGroupConversationsDriver,
  ConsoleGroupConversationsDriver,
  GroupConversationsAuthorRejectedError,
  GroupConversationsUnavailableError,
  createGroupConversationsAdapter,
} from '../src/adapters/groupConversations.js';
import { SmsSendingDisabledError } from '../src/adapters/messaging.js';
import type { AppConfig } from '../src/lib/config.js';

const BASE_DEPS = {
  accountSid: 'ACtest',
  apiKeySid: 'SKtest',
  apiKeySecret: 'secret',
  messagingServiceSid: 'MGcampaign',
} as const;

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

/** A structural stand-in for twilio v6's `client.conversations.v1.*`. */
function fakeConversationsClient(
  overrides: {
    bulkCreate?: ReturnType<typeof vi.fn>;
    participantCreate?: ReturnType<typeof vi.fn>;
    participantList?: ReturnType<typeof vi.fn>;
    conversationCreate?: ReturnType<typeof vi.fn>;
    fetch?: ReturnType<typeof vi.fn>;
    messageCreate?: ReturnType<typeof vi.fn>;
    remove?: ReturnType<typeof vi.fn>;
    participantRemove?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const bulkCreate =
    overrides.bulkCreate ??
    vi.fn().mockResolvedValue({ sid: 'CHrail1', uniqueName: 'conv-1', state: 'active' });
  const conversationCreate =
    overrides.conversationCreate ??
    vi.fn().mockResolvedValue({ sid: 'CHrail1', uniqueName: 'conv-1', state: 'active' });
  const participantCreate =
    overrides.participantCreate ?? vi.fn().mockResolvedValue({ sid: 'MBnew' });
  const participantList =
    overrides.participantList ??
    vi.fn().mockResolvedValue([
      { sid: 'MBbiz', messagingBinding: { projected_address: '+14045550000' } },
      { sid: 'MBann', messagingBinding: { address: '+16175550111' } },
      { sid: 'MBmarcus', messagingBinding: { address: '+16175550222' } },
    ]);
  const fetch =
    overrides.fetch ??
    vi.fn().mockResolvedValue({ sid: 'CHrail1', uniqueName: 'conv-1', state: 'active' });
  const messageCreate =
    overrides.messageCreate ??
    vi
      .fn()
      .mockResolvedValue({ sid: 'IMposted', index: 3, dateCreated: new Date('2026-08-11T13:06:45.433Z') });

  const remove = overrides.remove ?? vi.fn().mockResolvedValue(true);
  const participantRemove = overrides.participantRemove ?? vi.fn().mockResolvedValue(true);

  const addressed: string[] = [];
  const participantsAddressed: string[] = [];
  const conversations = Object.assign(
    (sidOrUniqueName: string) => {
      addressed.push(sidOrUniqueName);
      return {
        fetch,
        remove,
        messages: { create: messageCreate },
        // twilio v6: `participants` is a callable list instance - call it with
        // an MBxx to get the ParticipantContext (remove/fetch/update).
        participants: Object.assign(
          (participantSid: string) => {
            participantsAddressed.push(participantSid);
            return { remove: participantRemove };
          },
          { create: participantCreate, list: participantList },
        ),
      };
    },
    { create: conversationCreate },
  );
  return {
    client: {
      conversations: {
        v1: {
          conversations,
          conversationWithParticipants: { create: bulkCreate },
        },
      },
    },
    bulkCreate,
    conversationCreate,
    participantCreate,
    participantList,
    fetch,
    messageCreate,
    remove,
    participantRemove,
    addressed,
    participantsAddressed,
  };
}

const CREATE_INPUT = {
  uniqueName: 'conv-1',
  businessNumber: '+14045550000',
  members: ['+16175550111', '+16175550222'],
};

describe('TwilioGroupConversationsDriver.createConversationWithParticipants', () => {
  it('pins the campaign-bearing messaging service and the deterministic UniqueName', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const out = await driver.createConversationWithParticipants(CREATE_INPUT);

    expect(out.conversation.conversationSid).toBe('CHrail1');
    const params = f.bulkCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['messagingServiceSid']).toBe('MGcampaign');
    expect(params['uniqueName']).toBe('conv-1');
  });

  it('gives the business number its OWN projected-address participant with no address and no identity', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await driver.createConversationWithParticipants(CREATE_INPUT);

    const params = f.bulkCreate.mock.calls[0]?.[0] as { participant?: string[] };
    const participants = (params.participant ?? []).map(
      (p) => JSON.parse(p) as { messaging_binding?: Record<string, unknown>; identity?: unknown },
    );
    expect(participants).toHaveLength(3);
    const business = participants[0];
    expect(business?.messaging_binding).toEqual({ projected_address: '+14045550000' });
    expect(business?.identity).toBeUndefined();
  });

  it('gives each member an address-ONLY participant - never a proxy or projected address', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await driver.createConversationWithParticipants(CREATE_INPUT);

    const params = f.bulkCreate.mock.calls[0]?.[0] as { participant?: string[] };
    const participants = (params.participant ?? []).map(
      (p) => JSON.parse(p) as { messaging_binding?: Record<string, unknown> },
    );
    expect(participants.slice(1).map((p) => p.messaging_binding)).toEqual([
      { address: '+16175550111' },
      { address: '+16175550222' },
    ]);
  });

  it('reads the MBxx -> address map back from a participants fetch', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const out = await driver.createConversationWithParticipants(CREATE_INPUT);

    expect(out.participants).toEqual([
      { participantSid: 'MBbiz', projectedAddress: '+14045550000' },
      { participantSid: 'MBann', address: '+16175550111' },
      { participantSid: 'MBmarcus', address: '+16175550222' },
    ]);
    expect(out.failures).toEqual([]);
  });

  it('falls back to individual adds when the bulk create is refused, reporting the member that failed', async () => {
    const f = fakeConversationsClient({
      bulkCreate: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 50407 })),
      participantCreate: vi
        .fn()
        .mockResolvedValueOnce({ sid: 'MBbiz' })
        .mockResolvedValueOnce({ sid: 'MBann' })
        .mockRejectedValueOnce(Object.assign(new Error('bad address'), { code: 50407 })),
      participantList: vi.fn().mockResolvedValue([
        { sid: 'MBbiz', messagingBinding: { projected_address: '+14045550000' } },
        { sid: 'MBann', messagingBinding: { address: '+16175550111' } },
      ]),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const out = await driver.createConversationWithParticipants(CREATE_INPUT);

    expect(f.conversationCreate).toHaveBeenCalledTimes(1);
    expect(out.conversation.conversationSid).toBe('CHrail1');
    expect(out.failures).toEqual([
      { address: '+16175550222', errorCode: '50407', message: 'bad address' },
    ]);
    // The rail still exists with the members that DID attach.
    expect(out.participants.map((p) => p.participantSid)).toEqual(['MBbiz', 'MBann']);
  });
});

// THE DEFECT THIS PINS (fix wave 4, C5). The port had NO add-participant
// operation, so a rail left short by one throttled add could never be repaired:
// every retry adopted the same Conversation by UniqueName, re-read the same
// incomplete list, and recorded `rail_failed` again - against a cutover gate
// that requires ZERO unresolved rail failures over 132 real threads.
describe('TwilioGroupConversationsDriver.createConversationWithParticipants refusals', () => {
  it('re-throws a UNIQUENAME CONFLICT instead of blaming the participants', async () => {
    // The fallback re-creates under the SAME UniqueName and fails identically,
    // so falling through cost a round trip and left a "falling back to
    // individual participant adds" breadcrumb for what is really "this rail
    // already exists". ensureGroupRail's adopt handles it on the retry.
    const f = fakeConversationsClient({
      bulkCreate: vi.fn().mockRejectedValue(Object.assign(new Error('taken'), { code: 50353 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await expect(driver.createConversationWithParticipants(CREATE_INPUT)).rejects.toThrow('taken');
    expect(f.conversationCreate).not.toHaveBeenCalled();
  });

  it('reads ONE participant over the cap so an over-cap rail is detectable, not silently truncated', async () => {
    const overCap = Array.from({ length: 11 }, (_unused, i) => ({
      sid: `MB${i}`,
      messagingBinding: { address: `+1617555${String(i).padStart(4, '0')}` },
    }));
    const f = fakeConversationsClient({
      participantList: vi.fn().mockResolvedValue(overCap),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const out = await driver.fetchParticipants('CHrail1');

    expect(f.participantList.mock.calls[0]?.[0]).toEqual({ limit: 11 });
    expect(out).toHaveLength(11);
  });
});

describe('TwilioGroupConversationsDriver.addParticipants', () => {
  it('attaches ADDRESS-ONLY participants - never a second projected address', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const failures = await driver.addParticipants('CHrail1', ['+16175550222']);

    expect(failures).toEqual([]);
    expect(f.participantCreate.mock.calls.map((c) => c[0])).toEqual([
      { 'messagingBinding.address': '+16175550222' },
    ]);
  });

  it('reports the member Twilio refuses instead of throwing the whole repair away', async () => {
    const f = fakeConversationsClient({
      participantCreate: vi
        .fn()
        .mockResolvedValueOnce({ sid: 'MBok' })
        .mockRejectedValueOnce(Object.assign(new Error('bad address'), { code: 50407 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const failures = await driver.addParticipants('CHrail1', ['+16175550222', '+16175550333']);

    expect(failures).toEqual([
      { address: '+16175550333', errorCode: '50407', message: 'bad address' },
    ]);
  });
});

describe('TwilioGroupConversationsDriver.postGroupMessage', () => {
  it('classifies and preserves a frozen serializable Group MMS intent before posting', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });
    const intent = driver.classifyGroupMessageTransport();
    const input = {
      conversationSid: 'CHrail1',
      author: '+14045550000',
      body: 'on my way',
    };

    expect(intent).toEqual({ requestedTransport: 'mms' });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.getPrototypeOf(intent)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(intent))).toEqual({ requestedTransport: 'mms' });

    const prepared = driver.prepareGroupMessagePost(intent, input);
    expect(prepared).toEqual({ requestedTransport: 'mms', input });
    expect(f.messageCreate).not.toHaveBeenCalled();

    await expect(driver.postPreparedGroupMessage(prepared)).resolves.toEqual({
      messageSid: 'IMposted',
      index: 3,
      dateCreated: '2026-08-11T13:06:45.433Z',
      actualTransport: 'mms',
    });
    expect(f.messageCreate).toHaveBeenCalledWith({ author: '+14045550000', body: 'on my way' });
  });

  it('treats ChannelMessageSid only as corroborating or conflicting evidence', async () => {
    const corroborating = fakeConversationsClient({
      messageCreate: vi.fn().mockResolvedValue({
        sid: 'IMcorroborating',
        channelMessageSid: `MM${'d'.repeat(32)}`,
        dateCreated: new Date('2026-08-11T13:06:45.433Z'),
      }),
    });
    const corroboratingLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const corroboratingDriver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: corroborating.client as never,
      logger: corroboratingLogger as never,
    });

    const corroboratingResult = await corroboratingDriver.postGroupMessage({
      conversationSid: 'CHrail1',
      author: '+14045550000',
      body: 'hello',
    });
    expect(corroboratingResult.actualTransport).toBe('mms');
    expect(corroboratingLogger.warn).not.toHaveBeenCalled();

    const conflicting = fakeConversationsClient({
      messageCreate: vi.fn().mockResolvedValue({
        sid: 'IMconflicting',
        channelMessageSid: `SM${'e'.repeat(32)}`,
        dateCreated: new Date('2026-08-11T13:06:45.433Z'),
      }),
    });
    const conflictingLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const conflictingDriver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: conflicting.client as never,
      logger: conflictingLogger as never,
    });

    const conflictingResult = await conflictingDriver.postGroupMessage({
      conversationSid: 'CHrail1',
      author: '+14045550000',
      body: 'hello',
    });
    expect(conflictingResult.actualTransport).toBe('mms');
    expect(conflictingLogger.warn).toHaveBeenCalledTimes(1);
    expect(conflictingLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'group_message_transport_evidence_conflict',
        providerSid: 'IMconflicting',
        channelMessageSid: `SM${'e'.repeat(32)}`,
        observedTransport: 'sms',
        authoritativeTransport: 'mms',
      }),
      expect.any(String),
    );
  });

  it('authors as the business number and NEVER sets X-Twilio-Webhook-Enabled', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const out = await driver.postGroupMessage({
      conversationSid: 'CHrail1',
      author: '+14045550000',
      body: 'on my way',
    });

    expect(out).toEqual({
      messageSid: 'IMposted',
      index: 3,
      dateCreated: '2026-08-11T13:06:45.433Z',
      actualTransport: 'mms',
    });
    const params = f.messageCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['author']).toBe('+14045550000');
    expect(params['body']).toBe('on my way');
    expect(params['xTwilioWebhookEnabled']).toBeUndefined();
  });

  it('refuses to post when the SMS kill switch is off, with the error the existing consumers catch', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
      sendingEnabled: false,
    });

    await expect(
      driver.postGroupMessage({ conversationSid: 'CHrail1', author: '+14045550000', body: 'hi' }),
    ).rejects.toBeInstanceOf(SmsSendingDisabledError);
    expect(f.messageCreate).not.toHaveBeenCalled();
  });

  it('creating a rail is SILENT and stays allowed while the kill switch is off', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
      sendingEnabled: false,
    });

    await expect(driver.createConversationWithParticipants(CREATE_INPUT)).resolves.toMatchObject({
      conversation: { conversationSid: 'CHrail1' },
    });
  });
});

describe('TwilioGroupConversationsDriver.fetchByUniqueName', () => {
  it('returns the conversation for a known UniqueName', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });
    expect(await driver.fetchByUniqueName('conv-1')).toEqual({
      conversationSid: 'CHrail1',
      uniqueName: 'conv-1',
      state: 'active',
    });
  });

  it('maps a 404 to undefined so adopt-or-create can proceed', async () => {
    const f = fakeConversationsClient({
      fetch: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });
    expect(await driver.fetchByUniqueName('conv-1')).toBeUndefined();
  });

  it('re-throws a non-404 failure rather than reporting "no rail"', async () => {
    const f = fakeConversationsClient({
      fetch: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });
    await expect(driver.fetchByUniqueName('conv-1')).rejects.toThrow('boom');
  });
});

// THE DEFECT THIS OPERATION EXISTS FOR (fix wave 4, H1). A Conversation that
// closes keeps its UniqueName, and our UniqueName is the conversationId - so
// `ensureGroupRail`'s adopt half re-adopted the same dead resource on every
// retry and recorded `rail_failed` forever. Reclaiming the NAME is the fix, and
// this is the operation that reclaims it.
describe('TwilioGroupConversationsDriver.removeConversation', () => {
  it('deletes the conversation by SID and reports that it did', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    expect(await driver.removeConversation('CHdead')).toBe(true);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.addressed).toContain('CHdead');
  });

  it('treats an ALREADY GONE conversation as success - a delete asks for an end state', async () => {
    const f = fakeConversationsClient({
      remove: vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { code: 20404 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    expect(await driver.removeConversation('CHdead')).toBe(false);
  });

  it('RE-THROWS anything else, so a create never follows a delete that did not happen', async () => {
    // A swallowed 500 here would be followed immediately by a create under the
    // same UniqueName, which collides (50353) and reports as a rail failure
    // naming creation - the wrong cause, and one that no retry resolves.
    const f = fakeConversationsClient({
      remove: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await expect(driver.removeConversation('CHdead')).rejects.toThrow('boom');
  });
});

// THE DEFECT THESE PIN (prod incident 2026-08-17). Twilio's 50513 - "Message
// author should be among Group MMS participants" - is what a post returns when
// the rail carries no projected-address participant for the CURRENT business
// number: 132 imported rails had none at all, and 3 carried the released
// pre-port number. Untranslated it was a bare `group_send_failed` 503 that told
// staff nothing and healed nothing. Translated, groupSend can repair the rail's
// business participant and retry - which needs the two participant operations
// below.
describe('TwilioGroupConversationsDriver.postGroupMessage author refusal (50513)', () => {
  it('translates 50513 into GroupConversationsAuthorRejectedError so the send can repair the rail', async () => {
    const f = fakeConversationsClient({
      messageCreate: vi.fn().mockRejectedValue(
        Object.assign(new Error('Message author should be among Group MMS participants.'), {
          code: 50513,
          status: 400,
        }),
      ),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await expect(
      driver.postGroupMessage({ conversationSid: 'CHrail1', author: '+14045550000', body: 'hi' }),
    ).rejects.toBeInstanceOf(GroupConversationsAuthorRejectedError);
  });

  it('leaves every OTHER 400 untranslated - only the author refusal means "repair the rail"', async () => {
    const f = fakeConversationsClient({
      messageCreate: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('bad body'), { code: 50501, status: 400 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const err = await driver
      .postGroupMessage({ conversationSid: 'CHrail1', author: '+14045550000', body: 'hi' })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GroupConversationsAuthorRejectedError);
    expect(err).not.toBeInstanceOf(GroupConversationsUnavailableError);
    expect((err as { code?: number }).code).toBe(50501);
  });
});

describe('TwilioGroupConversationsDriver.addProjectedParticipant', () => {
  it('attaches the business number as a projected-address-ONLY participant and returns it', async () => {
    const f = fakeConversationsClient({
      participantCreate: vi.fn().mockResolvedValue({
        sid: 'MBbiz2',
        messagingBinding: { projected_address: '+14045550000' },
      }),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    const ref = await driver.addProjectedParticipant('CHrail1', '+14045550000');

    expect(ref).toEqual({ participantSid: 'MBbiz2', projectedAddress: '+14045550000' });
    expect(f.addressed).toContain('CHrail1');
    const params = f.participantCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['messagingBinding.projectedAddress']).toBe('+14045550000');
    // No address, no identity - the shape that avoids the misleading 50407.
    expect(params['messagingBinding.address']).toBeUndefined();
    expect(params['identity']).toBeUndefined();
  });

  it('RE-THROWS a refusal - the caller records the rail failure, never a silent "attached"', async () => {
    // Swallowing this is EXACTLY how 132 rails shipped without a business
    // participant: the individual-add fallback's business add was refused,
    // nothing looked, and "roster covered" counted as success.
    const f = fakeConversationsClient({
      participantCreate: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not owned'), { code: 50407, status: 400 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await expect(driver.addProjectedParticipant('CHrail1', '+14045550000')).rejects.toMatchObject({
      code: 50407,
    });
  });
});

describe('TwilioGroupConversationsDriver.removeParticipant', () => {
  it('removes the participant by MBxx on the addressed conversation', async () => {
    const f = fakeConversationsClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    expect(await driver.removeParticipant('CHrail1', 'MBstale')).toBe(true);
    expect(f.addressed).toContain('CHrail1');
    expect(f.participantsAddressed).toEqual(['MBstale']);
    expect(f.participantRemove).toHaveBeenCalledTimes(1);
  });

  it('treats an ALREADY GONE participant as the asked-for end state', async () => {
    const f = fakeConversationsClient({
      participantRemove: vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { code: 20404 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    expect(await driver.removeParticipant('CHrail1', 'MBstale')).toBe(false);
  });

  it('RE-THROWS anything else', async () => {
    const f = fakeConversationsClient({
      participantRemove: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    });
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await expect(driver.removeParticipant('CHrail1', 'MBstale')).rejects.toThrow('boom');
  });
});

describe('ConsoleGroupConversationsDriver', () => {
  it('creates NO rail - it logs and refuses, so a thread is never stamped with a rail that does not exist', async () => {
    const driver = new ConsoleGroupConversationsDriver({ logger: silentLogger });
    await expect(driver.createConversationWithParticipants(CREATE_INPUT)).rejects.toBeInstanceOf(
      GroupConversationsUnavailableError,
    );
  });

  it('refuses to post, so no message row is ever persisted for a send that never left', async () => {
    const driver = new ConsoleGroupConversationsDriver({ logger: silentLogger });
    await expect(
      driver.postGroupMessage({ conversationSid: 'CHx', author: '+1', body: 'hi' }),
    ).rejects.toBeInstanceOf(GroupConversationsUnavailableError);
  });

  it('REFUSES the rail lookup rather than reporting "no such rail"', async () => {
    // `undefined` would read as "no rail exists" and send ensureGroupRail down
    // the create path to the throw above: the same end state, one wasted
    // Twilio-shaped round trip, and a rail_failed reason naming creation
    // instead of the real cause. Every method on this driver refuses.
    const driver = new ConsoleGroupConversationsDriver({ logger: silentLogger });
    await expect(driver.fetchByUniqueName('conv-1')).rejects.toBeInstanceOf(
      GroupConversationsUnavailableError,
    );
    expect(await driver.fetchParticipants('CHx')).toEqual([]);
  });
});

describe('createGroupConversationsAdapter', () => {
  it('selects the console driver for MESSAGING_DRIVER=console', () => {
    const config = { messagingDriver: 'console' } as AppConfig;
    expect(createGroupConversationsAdapter({ config, logger: silentLogger })).toBeInstanceOf(
      ConsoleGroupConversationsDriver,
    );
  });

  it('selects the Twilio driver when the twilio config is complete', () => {
    const config = {
      messagingDriver: 'twilio',
      twilioAccountSid: 'ACx',
      twilioApiKeySid: 'SKx',
      twilioApiKeySecret: 'secret',
      twilioMessagingServiceSid: 'MGx',
      smsSendingEnabled: true,
    } as AppConfig;
    const f = fakeConversationsClient();
    expect(
      createGroupConversationsAdapter({
        config,
        logger: silentLogger,
        twilioClient: f.client as never,
      }),
    ).toBeInstanceOf(TwilioGroupConversationsDriver);
  });

  it('refuses to build a Twilio driver with incomplete twilio config', () => {
    const config = { messagingDriver: 'twilio' } as AppConfig;
    expect(() => createGroupConversationsAdapter({ config, logger: silentLogger })).toThrow(
      /twilio\* config is incomplete/,
    );
  });
});

// ---------------------------------------------------------------------------
// Conversations SERVICE scoping (cross-env isolation)
// ---------------------------------------------------------------------------
//
// A Conversations service owns its UniqueName namespace, and the account default
// is one per ACCOUNT. Two envs sharing an account and both on the default derive
// the SAME UniqueName for the same roster (it is uuidv5 over the roster), so one
// env ADOPTS the other's live rail. These tests pin that the adapter addresses
// the configured service and never silently falls back to the shared default.

/** A client exposing BOTH scopes with DISTINCT spies, so a test can prove which
 *  one the adapter actually addressed. */
function dualScopeClient() {
  const mkScope = (tag: string) => {
    const create = vi
      .fn()
      .mockResolvedValue({ sid: `CH${tag}`, uniqueName: 'conv-1', state: 'active' });
    const bulkCreate = vi
      .fn()
      .mockResolvedValue({ sid: `CH${tag}`, uniqueName: 'conv-1', state: 'active' });
    // ONE shared context, so a test can assert which scope's conversation
    // resource was addressed AND which operation ran on it.
    const participantRemove = vi.fn().mockResolvedValue(true);
    const ctx = {
      fetch: vi.fn().mockResolvedValue({ sid: `CH${tag}`, uniqueName: 'conv-1', state: 'active' }),
      remove: vi.fn().mockResolvedValue(true),
      messages: { create: vi.fn().mockResolvedValue({ sid: 'IM1', index: 0 }) },
      participants: Object.assign(() => ({ remove: participantRemove }), {
        create: vi.fn().mockResolvedValue({ sid: 'MB1' }),
        list: vi.fn().mockResolvedValue([]),
      }),
      participantRemove,
    };
    // `conversations` must itself be a SPY, not a plain arrow. Asserting only
    // that services(sid) ran proves nothing about any single operation - the
    // constructor calls it once regardless, so a per-operation regression (a
    // create on the service scope, a read on the default) would stay green.
    const conversations = Object.assign(
      vi.fn(() => ctx),
      { create },
    );
    return {
      scope: { conversations, conversationWithParticipants: { create: bulkCreate } },
      conversations,
      ctx,
      create,
      bulkCreate,
    };
  };

  const dflt = mkScope('default');
  const svc = mkScope('service');
  const services = vi.fn().mockReturnValue(svc.scope);
  return {
    client: { conversations: { v1: { ...dflt.scope, services } } },
    services,
    dflt,
    svc,
  };
}

/** Every adapter operation that ADDRESSES a conversation, with the assertion for
 *  the resource call it must make. Table-driven so a newly added operation that
 *  forgets the scope is a missing row rather than silent coverage loss. */
const SCOPED_OPERATIONS: {
  name: string;
  run: (d: TwilioGroupConversationsDriver) => Promise<unknown>;
  ran: (scope: ReturnType<typeof dualScopeClient>['svc']) => boolean;
}[] = [
  {
    name: 'fetchByUniqueName (the ADOPT half - reading the wrong scope adopts the other env rail)',
    run: (d) => d.fetchByUniqueName('conv-1'),
    ran: (s) => s.ctx.fetch.mock.calls.length > 0,
  },
  {
    name: 'addParticipants',
    run: (d) => d.addParticipants('CHrail', ['+16175550111']),
    ran: (s) => s.ctx.participants.create.mock.calls.length > 0,
  },
  {
    name: 'fetchParticipants',
    run: (d) => d.fetchParticipants('CHrail'),
    ran: (s) => s.ctx.participants.list.mock.calls.length > 0,
  },
  {
    name: 'removeConversation',
    run: (d) => d.removeConversation('CHrail'),
    ran: (s) => s.ctx.remove.mock.calls.length > 0,
  },
  {
    name: 'addProjectedParticipant',
    run: (d) => d.addProjectedParticipant('CHrail', '+14045550000'),
    ran: (s) => s.ctx.participants.create.mock.calls.length > 0,
  },
  {
    name: 'removeParticipant',
    run: (d) => d.removeParticipant('CHrail', 'MBstale'),
    ran: (s) => s.ctx.participantRemove.mock.calls.length > 0,
  },
  {
    name: 'postGroupMessage',
    run: (d) => d.postGroupMessage({ conversationSid: 'CHrail', body: 'hi', author: '+14045550000' }),
    ran: (s) => s.ctx.messages.create.mock.calls.length > 0,
  },
];

describe('TwilioGroupConversationsDriver Conversations service scoping', () => {
  it('addresses the account DEFAULT scope when no service SID is configured', async () => {
    const f = dualScopeClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      client: f.client as never,
      logger: silentLogger,
    });

    await driver.createConversationWithParticipants(CREATE_INPUT);

    expect(f.services).not.toHaveBeenCalled();
    expect(f.dflt.bulkCreate).toHaveBeenCalledTimes(1);
    expect(f.svc.bulkCreate).not.toHaveBeenCalled();
  });

  it('addresses the CONFIGURED service scope and never the default when a service SID is set', async () => {
    const f = dualScopeClient();
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      conversationsServiceSid: 'ISgrouprails',
      client: f.client as never,
      logger: silentLogger,
    });

    await driver.createConversationWithParticipants(CREATE_INPUT);

    expect(f.services).toHaveBeenCalledWith('ISgrouprails');
    expect(f.svc.bulkCreate).toHaveBeenCalledTimes(1);
    // The whole point: the shared default namespace is never touched.
    expect(f.dflt.bulkCreate).not.toHaveBeenCalled();
  });

  // Per-OPERATION proof. Asserting services(sid) alone is vacuous: the
  // constructor calls it once whatever the operations then do, so reverting any
  // single call site to `this.client.conversations.v1...` would leave such a test
  // green while creates hit the configured service and reads hit the shared
  // default - precisely the cross-env bug this change fixes.
  describe.each(SCOPED_OPERATIONS)('$name', ({ run, ran }) => {
    it('addresses the CONFIGURED service scope and never the default', async () => {
      const f = dualScopeClient();
      const driver = new TwilioGroupConversationsDriver({
        ...BASE_DEPS,
        conversationsServiceSid: 'ISgrouprails',
        client: f.client as never,
        logger: silentLogger,
      });

      await run(driver);

      expect(f.svc.conversations).toHaveBeenCalled();
      expect(ran(f.svc)).toBe(true);
      // The load-bearing half: the shared default namespace is never addressed.
      expect(f.dflt.conversations).not.toHaveBeenCalled();
      expect(ran(f.dflt)).toBe(false);
    });

    it('addresses the account DEFAULT scope when no service is configured', async () => {
      const f = dualScopeClient();
      const driver = new TwilioGroupConversationsDriver({
        ...BASE_DEPS,
        client: f.client as never,
        logger: silentLogger,
      });

      await run(driver);

      expect(f.services).not.toHaveBeenCalled();
      expect(f.dflt.conversations).toHaveBeenCalled();
      expect(ran(f.dflt)).toBe(true);
    });
  });

  it('routes the INDIVIDUAL-ADDS FALLBACK create through the configured service too', async () => {
    // The bulk create and the fallback create are DIFFERENT resources
    // (conversationWithParticipants vs conversations.create), so covering the
    // happy path proves nothing about the fallback. If only the fallback
    // regressed, the rail would be minted in the shared default namespace while
    // every subsequent participant/message op addressed the configured service -
    // cross-env contamination PLUS not-found participant failures, and it would
    // only ever fire on a bulk refusal (a 50407-class member), so no happy-path
    // test would ever catch it.
    const f = dualScopeClient();
    f.svc.bulkCreate.mockRejectedValueOnce(
      Object.assign(new Error('bad address'), { code: 50407 }),
    );
    const driver = new TwilioGroupConversationsDriver({
      ...BASE_DEPS,
      conversationsServiceSid: 'ISgrouprails',
      client: f.client as never,
      logger: silentLogger,
    });

    await driver.createConversationWithParticipants(CREATE_INPUT);

    // The fallback's own create, on the service scope.
    expect(f.svc.create).toHaveBeenCalledTimes(1);
    expect(f.dflt.create).not.toHaveBeenCalled();
    // ...and the participant adds that follow it, on the same scope.
    expect(f.svc.ctx.participants.create).toHaveBeenCalled();
    expect(f.dflt.conversations).not.toHaveBeenCalled();
  });

  it('REFUSES to construct when a service SID is set but the client cannot scope - never falls back', async () => {
    const f = fakeConversationsClient(); // no services() accessor
    expect(
      () =>
        new TwilioGroupConversationsDriver({
          ...BASE_DEPS,
          conversationsServiceSid: 'ISgrouprails',
          client: f.client as never,
          logger: silentLogger,
        }),
    ).toThrow(/refusing to fall back to the shared default service/);
  });

  it('the factory forwards config.twilioConversationsServiceSid', async () => {
    const f = dualScopeClient();
    const config = {
      messagingDriver: 'twilio',
      twilioAccountSid: 'ACx',
      twilioApiKeySid: 'SKx',
      twilioApiKeySecret: 'secret',
      twilioMessagingServiceSid: 'MGx',
      twilioConversationsServiceSid: 'ISfromconfig',
      smsSendingEnabled: true,
    } as AppConfig;

    const driver = createGroupConversationsAdapter({
      config,
      logger: silentLogger,
      twilioClient: f.client as never,
    });
    await (driver as TwilioGroupConversationsDriver).createConversationWithParticipants(CREATE_INPUT);

    expect(f.services).toHaveBeenCalledWith('ISfromconfig');
  });
});
