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

  const addressed: string[] = [];
  const conversations = Object.assign(
    (sidOrUniqueName: string) => {
      addressed.push(sidOrUniqueName);
      return {
        fetch,
        remove,
        messages: { create: messageCreate },
        participants: { create: participantCreate, list: participantList },
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
    addressed,
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
