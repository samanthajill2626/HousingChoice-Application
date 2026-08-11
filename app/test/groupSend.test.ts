// T5.2 unit matrix: the dedicated group send service.
//
// `sendMessage` is structurally 1:1 (one participantPhone, one whole-send
// opt-out refusal), so a group reply gets its own service. What is asserted
// here is the refusal ORDER, the phone-scoped seeded slots, and - the part with
// a real crash window behind it - that the message row, the rail snapshot and
// the staleness due row are ONE transactional append.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createEventBus, type AppEventName } from '../src/lib/events.js';
import type { AppConfig } from '../src/lib/config.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';
import type { NewMessage } from '../src/repos/messagesRepo.js';
import {
  buildTsMsgId,
  GROUP_SEND_DUE_PARTITION,
  GROUP_SEND_DUE_KIND,
  GROUP_SEND_STALENESS_MS,
} from '../src/repos/messagesRepo.js';
import {
  GroupConversationsUnavailableError,
  type GroupConversationsPort,
} from '../src/adapters/groupConversations.js';
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../src/adapters/messaging.js';
import {
  SendRefusedError,
  SmsSendingDisabledError,
  ConversationNotFoundError,
} from '../src/services/sendMessage.js';
import {
  createGroupSendService,
  GroupMemberDeletedError,
  GroupMemberNoConsentError,
  GroupRailUnavailableError,
  GroupRosterEmptyError,
  GroupTooManyMembersError,
  NotAGroupTextError,
  MAX_SENDABLE_GROUP_MEMBERS,
} from '../src/services/groupSend.js';
import type { GroupRailEnsurer } from '../src/services/groupRail.js';

const NOW = new Date('2026-08-11T13:00:00.000Z');

function member(phone: string, contactId: string, name?: string): ConversationParticipant {
  return { contactId, phone, ...(name !== undefined && { name }) };
}

const ANN = member('+16175550111', 'contact-ann', 'Ann');
const MARCUS = member('+16175550222', 'contact-marcus', 'Marcus');

function consentingContact(contactId: string, phone: string): ContactItem {
  return {
    contactId,
    type: 'tenant',
    phone,
    // The group basis, NEVER consent_method (spec 5.3 / A7).
    group_participation_at: '2026-08-01T00:00:00.000Z',
  } as ContactItem;
}

interface Fakes {
  conversation: ConversationItem;
  contactsByPhone: Map<string, ContactItem>;
  appended: NewMessage[];
  posted: { conversationSid: string; author: string; body: string }[];
  audits: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  emitted: { event: AppEventName; payload: unknown }[];
  railCalls: string[];
  drained: string[];
  touched: { previewText: string | undefined; ts: string }[];
  send: ReturnType<typeof createGroupSendService>;
}

function makeFakes(
  overrides: {
    conversation?: Partial<ConversationItem>;
    members?: ConversationParticipant[];
    contacts?: ContactItem[];
    smsSendingEnabled?: boolean;
    businessPhoneNumber?: string | undefined;
    rail?: GroupRailEnsurer;
    port?: Partial<GroupConversationsPort>;
  } = {},
): Fakes {
  const members = overrides.members ?? [ANN, MARCUS];
  const conversation: ConversationItem = {
    conversationId: 'group-1',
    type: 'group_text',
    status: 'group_open',
    ai_mode: 'auto',
    created_at: '2026-08-01T00:00:00.000Z',
    last_activity_at: '2026-08-10T00:00:00.000Z',
    participants: members,
    twilio_conversation_sid: 'CHrail1',
    twilio_participant_map: {
      MBann: 'phone#+16175550111',
      MBmarcus: 'phone#+16175550222',
    },
    ...overrides.conversation,
  };
  const contacts =
    overrides.contacts ??
    members.map((m) => consentingContact(m.contactId, m.phone));
  const contactsByPhone = new Map(contacts.map((c) => [c.phone ?? '', c]));

  const fakes = {
    conversation,
    contactsByPhone,
    appended: [] as NewMessage[],
    posted: [] as Fakes['posted'],
    audits: [] as Fakes['audits'],
    emitted: [] as Fakes['emitted'],
    railCalls: [] as string[],
    drained: [] as string[],
    touched: [] as Fakes['touched'],
  };

  const port: GroupConversationsPort = {
    createConversationWithParticipants: async () => {
      throw new Error('groupSend must never create a rail directly - it goes through ensureGroupRail');
    },
    fetchByUniqueName: async () => undefined,
    fetchParticipants: async () => [],
    addParticipants: async () => {
      throw new Error('groupSend must never repair a rail directly - that is ensureGroupRail');
    },
    postGroupMessage: async (input) => {
      fakes.posted.push(input);
      return { messageSid: 'IMposted1', dateCreated: '2026-08-11T13:00:00.500Z' };
    },
    ...overrides.port,
  };

  const events = createEventBus();
  for (const name of ['message.persisted', 'conversation.updated'] as AppEventName[]) {
    events.on(name, (payload: unknown) => fakes.emitted.push({ event: name, payload }));
  }

  const rail: GroupRailEnsurer = overrides.rail ?? {
    ensureGroupRail: async (request) => {
      fakes.railCalls.push(request.conversationId);
      return { status: 'unavailable', reason: 'not wired in this test' };
    },
  };

  const config = {
    smsSendingEnabled: overrides.smsSendingEnabled ?? true,
    businessPhoneNumber:
      'businessPhoneNumber' in overrides ? overrides.businessPhoneNumber : '+14045550000',
  } as AppConfig;

  const send = createGroupSendService({
    config,
    logger: createLogger({ level: 'silent' }),
    groupConversations: port,
    conversationsRepo: {
      getById: async (id) => (id === conversation.conversationId ? conversation : undefined),
      touchLastActivity: async (_id, previewText, ts) => {
        fakes.touched.push({ previewText, ts });
        return conversation;
      },
    },
    messagesRepo: {
      append: async (message) => {
        fakes.appended.push(message);
        return { deduped: false, tsMsgId: `${message.providerTs}#${message.providerSid}` };
      },
    },
    contactsRepo: {
      findByPhone: async (phone) => contactsByPhone.get(phone),
    },
    auditRepo: {
      append: async (entityKey, eventType, payload) => {
        fakes.audits.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
      },
    },
    events,
    rail,
    // Injected so this suite stays in memory: the default receipts service is
    // built over the real repos and would reach for DynamoDB on every send.
    receipts: {
      applyReceipt: async () => ({ outcome: 'dropped', reason: 'not used in this suite' }),
      drainParked: async (providerSid: string) => {
        fakes.drained.push(providerSid);
        return 0;
      },
    },
    now: () => NOW,
  });

  return { ...fakes, send };
}

describe('groupSend - the happy path', () => {
  it('posts through the rail authored by the business number and returns the IMxx', async () => {
    const f = makeFakes();
    const out = await f.send({ conversationId: 'group-1', body: 'on my way' });

    expect(f.posted).toEqual([
      { conversationSid: 'CHrail1', author: '+14045550000', body: 'on my way' },
    ]);
    expect(out).toEqual({
      conversationId: 'group-1',
      providerSid: 'IMposted1',
      tsMsgId: '2026-08-11T13:00:00.500Z#IMposted1',
      status: 'queued',
    });
  });

  it('seeds a queued slot per member, keyed PHONE-scoped so two numbers of one contact stay two slots', async () => {
    const twoNumbersOneContact = [
      member('+16175550111', 'contact-ann', 'Ann'),
      member('+16175550999', 'contact-ann', 'Ann'),
    ];
    const f = makeFakes({
      members: twoNumbersOneContact,
      contacts: [
        consentingContact('contact-ann', '+16175550111'),
        consentingContact('contact-ann', '+16175550999'),
      ],
    });
    await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(f.appended[0]?.deliveryRecipients).toEqual({
      'phone#+16175550111': { status: 'queued' },
      'phone#+16175550999': { status: 'queued' },
    });
  });

  it('appends the message row, the rail SNAPSHOT and the staleness DUE ROW in ONE call', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(f.appended).toHaveLength(1);
    const appended = f.appended[0];
    expect(appended?.conversationId).toBe('group-1');
    expect(appended?.direction).toBe('outbound');
    expect(appended?.providerSid).toBe('IMposted1');
    // The snapshot: the CH we posted into plus the MBxx map AS IT STOOD, so a
    // later rail recreation cannot orphan this message's receipts.
    expect(appended?.groupRailSnapshot).toEqual({
      conversationSid: 'CHrail1',
      participantMap: {
        MBann: 'phone#+16175550111',
        MBmarcus: 'phone#+16175550222',
      },
    });
    // The due row rides the SAME append - not a follow-up write with a crash
    // window, because this sweep is the only detector of a dead receipts webhook.
    const deadline = new Date(NOW.getTime() + GROUP_SEND_STALENESS_MS).toISOString();
    expect(appended?.dueRow?.partition).toBe(GROUP_SEND_DUE_PARTITION);
    expect(appended?.dueRow?.sortKey).toBe(`${deadline}#${GROUP_SEND_DUE_KIND}#IMposted1`);
    expect(appended?.dueRow?.attributes).toMatchObject({
      due_kind: GROUP_SEND_DUE_KIND,
      deadline_at: deadline,
      ref_conversationId: 'group-1',
      provider_sid: 'IMposted1',
    });
    // The back-pointer is built by the EXPORTED builder, not a hand-rolled copy
    // (fix wave 4, X5). It is what the staleness sweep resolves the message by:
    // a drifted key makes every check return `missing`, count as cleared, and
    // report a dead receipts webhook as healthy forever. Asserted THROUGH
    // buildTsMsgId so the two can never be pinned to a stale literal.
    expect(appended?.dueRow?.attributes['ref_tsMsgId']).toBe(
      buildTsMsgId('2026-08-11T13:00:00.500Z', 'IMposted1'),
    );
  });

  it('gives the due row an expires_at horizon FAR past its own deadline (TTL is cleanup, never the alarm)', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'hi' });

    const attrs = f.appended[0]?.dueRow?.attributes ?? {};
    const expiresAtMs = Number(attrs['expires_at']) * 1000;
    const deadlineMs = Date.parse(String(attrs['deadline_at']));
    expect(expiresAtMs - deadlineMs).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });

  it('drains receipts parked against its own IMxx - a receipt CAN beat the append', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.drained).toEqual(['IMposted1']);
  });

  it('touches last activity, audits the send, and emits both SSE events', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'on my way', actorUserId: 'user-cam' });

    expect(f.touched).toEqual([{ previewText: 'on my way', ts: '2026-08-11T13:00:00.500Z' }]);
    expect(f.audits).toEqual([
      {
        entityKey: 'conversations#group-1',
        eventType: 'message_sent',
        payload: {
          providerSid: 'IMposted1',
          automated: false,
          author: 'teammate',
          memberCount: 2,
          actor: 'user-cam',
        },
      },
    ]);
    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted', 'conversation.updated']);
  });
});

describe('groupSend - refusals, in order', () => {
  it('refuses a conversation that does not exist', async () => {
    const f = makeFakes();
    await expect(f.send({ conversationId: 'nope', body: 'hi' })).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });

  it('refuses a thread that is not a group text', async () => {
    const f = makeFakes({ conversation: { type: 'relay_group' } });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      NotAGroupTextError,
    );
  });

  it('refuses an empty roster', async () => {
    const f = makeFakes({ members: [], contacts: [] });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      GroupRosterEmptyError,
    );
  });

  it('refuses more than nine members BEFORE any contact read', async () => {
    const many = Array.from({ length: MAX_SENDABLE_GROUP_MEMBERS + 1 }, (_, i) =>
      member(`+161755501${String(i).padStart(2, '0')}`, `contact-${i}`),
    );
    // Deliberately NO contacts: if the cap check ran after the member reads,
    // this would surface as a consent refusal instead.
    const f = makeFakes({ members: many, contacts: [] });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      GroupTooManyMembersError,
    );
    expect(f.posted).toEqual([]);
  });

  it('refuses when ANY member contact is soft-deleted, and NAMES that member', async () => {
    const deleted = { ...consentingContact('contact-marcus', '+16175550222'), deleted_at: '2026-08-05T00:00:00.000Z' } as ContactItem;
    const f = makeFakes({ contacts: [consentingContact('contact-ann', '+16175550111'), deleted] });
    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupMemberDeletedError);
    expect((err as Error).message).toContain('Marcus');
    expect(f.posted).toEqual([]);
  });

  it('the deleted fence outranks the consent gate (a deleted member is never reported as a consent problem)', async () => {
    const deleted = { contactId: 'contact-marcus', type: 'tenant', phone: '+16175550222', deleted_at: '2026-08-05T00:00:00.000Z' } as ContactItem;
    const f = makeFakes({ contacts: [consentingContact('contact-ann', '+16175550111'), deleted] });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      GroupMemberDeletedError,
    );
  });

  // DEFENSE IN DEPTH. Every creation path (detection T3.4, conversion T7.3)
  // stamps group_participation_at on every member, so this refusal should be
  // unreachable in production - the gap here is constructed by handing the
  // service a contact that never got the stamp.
  it('refuses when a member holds NEITHER consent_method NOR group_participation_at, naming them', async () => {
    const silent = { contactId: 'contact-marcus', type: 'tenant', phone: '+16175550222' } as ContactItem;
    const f = makeFakes({ contacts: [consentingContact('contact-ann', '+16175550111'), silent] });
    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupMemberNoConsentError);
    expect((err as Error).message).toContain('Marcus');
  });

  it('accepts a member whose basis is consent_method alone (the ordinary 1:1 basis still counts)', async () => {
    const inbound = { contactId: 'contact-marcus', type: 'tenant', phone: '+16175550222', consent_method: 'inbound_text' } as ContactItem;
    const f = makeFakes({ contacts: [consentingContact('contact-ann', '+16175550111'), inbound] });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).resolves.toMatchObject({
      providerSid: 'IMposted1',
    });
  });

  it('refuses a member with NO contact record at all (no basis is not a passable basis)', async () => {
    const f = makeFakes({ contacts: [consentingContact('contact-ann', '+16175550111')] });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      GroupMemberNoConsentError,
    );
  });

  it('does NOT exclude a suppressed member app-side - Twilio filters per recipient and the 21610 receipt records it', async () => {
    const optedOut = {
      ...consentingContact('contact-marcus', '+16175550222'),
      sms_opt_out: true,
    } as ContactItem;
    const f = makeFakes({ contacts: [consentingContact('contact-ann', '+16175550111'), optedOut] });
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(Object.keys(f.appended[0]?.deliveryRecipients ?? {})).toEqual([
      'phone#+16175550111',
      'phone#+16175550222',
    ]);
  });
});

describe('groupSend - the rail', () => {
  it('creates the rail inline through ensureGroupRail when the thread has none', async () => {
    const f = makeFakes({
      conversation: { twilio_conversation_sid: undefined, twilio_participant_map: undefined },
      rail: {
        ensureGroupRail: async () => ({
          status: 'created',
          twilioConversationSid: 'CHfresh',
          participantMap: { MBnew: 'phone#+16175550111' },
        }),
      },
    });
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.posted[0]?.conversationSid).toBe('CHfresh');
    expect(f.appended[0]?.groupRailSnapshot?.conversationSid).toBe('CHfresh');
  });

  it('refuses cleanly when no rail can be established, rather than posting nowhere', async () => {
    const f = makeFakes({
      conversation: { twilio_conversation_sid: undefined, twilio_participant_map: undefined },
    });
    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupRailUnavailableError);
    expect(f.railCalls).toEqual(['group-1']);
    expect(f.appended).toEqual([]);
  });

  it('never calls ensureGroupRail when a rail is already attached', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.railCalls).toEqual([]);
  });

  it('refuses when the business number is unconfigured - the rail has no author to post as', async () => {
    const f = makeFakes({ businessPhoneNumber: undefined });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      GroupRailUnavailableError,
    );
  });
});

describe('groupSend - adapter failures become typed refusals', () => {
  it('translates the adapter kill-switch error into the 503-mapped SendRefusedError', async () => {
    const f = makeFakes({
      port: {
        postGroupMessage: async () => {
          throw new AdapterSmsSendingDisabledError('SMS sending is disabled');
        },
      },
    });
    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);
    // The adapter's class is a bare Error; the route only maps SendRefusedError,
    // so an untranslated throw would 500 instead of reporting the kill switch.
    expect(err).toBeInstanceOf(SmsSendingDisabledError);
    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).code).toBe('sms_sending_disabled');
    expect(f.appended).toEqual([]);
  });

  it('translates "no Conversations service" (console driver) into a rail refusal', async () => {
    const f = makeFakes({
      port: {
        postGroupMessage: async () => {
          throw new GroupConversationsUnavailableError('console driver');
        },
      },
    });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      GroupRailUnavailableError,
    );
  });

  it('persists NOTHING when the post itself fails, so no message row exists for a send that never left', async () => {
    const f = makeFakes({
      port: {
        postGroupMessage: async () => {
          throw new Error('twilio exploded');
        },
      },
    });
    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toThrow('twilio exploded');
    expect(f.appended).toEqual([]);
    expect(f.audits).toEqual([]);
  });
});

describe('groupSend - refusal codes are the ones the route maps', () => {
  it('every group refusal is a SendRefusedError with a stable code', () => {
    const codes = [
      new NotAGroupTextError('c').code,
      new GroupRosterEmptyError('c').code,
      new GroupTooManyMembersError('c', 10).code,
      new GroupMemberDeletedError('c', 'Marcus').code,
      new GroupMemberNoConsentError('c', 'Marcus').code,
      new GroupRailUnavailableError('c', 'why').code,
    ];
    expect(codes).toEqual([
      'not_a_group_text',
      'group_roster_empty',
      'group_too_many_members',
      'group_member_deleted',
      'group_member_no_consent',
      'group_rail_unavailable',
    ]);
    expect(new GroupTooManyMembersError('c', 10)).toBeInstanceOf(SendRefusedError);
  });

  it('MAX_SENDABLE_GROUP_MEMBERS is nine - the composer cap and the send cap cannot drift', () => {
    expect(MAX_SENDABLE_GROUP_MEMBERS).toBe(9);
  });
});

describe('messagesRepo due-row helpers', () => {
  it('sorts deadline-first so a range Query finds overdue rows lexicographically', async () => {
    const { groupSendDueSortKey } = await import('../src/repos/messagesRepo.js');
    const early = groupSendDueSortKey('2026-08-11T13:00:00.000Z', 'IMa');
    const late = groupSendDueSortKey('2026-08-11T13:10:00.000Z', 'IMb');
    expect(early < late).toBe(true);
    // The '~' upper bound the sweep uses must include a row due exactly at now.
    expect(early < '2026-08-11T13:00:00.000Z~').toBe(true);
    expect(late < '2026-08-11T13:00:00.000Z~').toBe(false);
  });
});

describe('groupSend - default construction', () => {
  it('is constructible with no deps at all (the route builds it once per router)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      createGroupSendService({
        config: { smsSendingEnabled: true, messagingDriver: 'console' } as AppConfig,
        logger: createLogger({ level: 'silent' }),
      }),
    ).not.toThrow();
    spy.mockRestore();
  });
});
