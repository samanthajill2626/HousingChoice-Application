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
  GroupConversationsAuthorRejectedError,
  GroupConversationsUnavailableError,
  type GroupConversationRef,
  type GroupConversationsPort,
  type GroupParticipantRef,
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
  GroupSendBusyError,
  GroupSendFailedError,
  GroupTooManyMembersError,
  NotAGroupTextError,
  MAX_SENDABLE_GROUP_MEMBERS,
  type GroupSendServiceDeps,
} from '../src/services/groupSend.js';
import {
  createGroupRailService,
  type GroupRailEnsurer,
  type GroupRailServiceDeps,
} from '../src/services/groupRail.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';

const NOW = new Date('2026-08-11T13:00:00.000Z');

/**
 * Fake clock + sleep for a REAL TokenBucket (the same shape tokenBucket.test.ts
 * uses): sleeping advances the clock and records the wait, so what a send SPENDS
 * on the A2P meter is observable without stubbing the bucket's arithmetic.
 */
function fakeBucketTime() {
  let nowMs = 0;
  const waits: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      waits.push(ms);
      nowMs += ms;
    },
    get waits() {
      return waits;
    },
  };
}

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
    /** 1:1 threads the number-scoped suppression seam reads (T3.5). A SECONDARY
     *  number carries its opt-out here, never on the contact flag. */
    oneToOneThreads?: ConversationItem[];
    /** Make the suppression READ throw, to prove the send survives it. */
    failSuppressionRead?: boolean;
    /** phone -> the contact it resolves to, for numbers that are NOT that
     *  contact's primary (an attached second handset). */
    attachedNumbers?: Record<string, ContactItem>;
    /** Extra service deps passed through verbatim (the A2P meter seam). */
    deps?: Partial<GroupSendServiceDeps>;
    /** The closed-rail drop, so a test can watch the heal sequence. */
    clearGroupRail?: (conversationId: string, expectedSid: string) => Promise<boolean>;
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
    // A rail VERIFIED for the default business number below - the state every
    // rail reaches after one ensure. Tests of the unverified case clear it.
    twilio_projected_address: '+14045550000',
    ...overrides.conversation,
  };
  const contacts =
    overrides.contacts ??
    members.map((m) => consentingContact(m.contactId, m.phone));
  const contactsByPhone = new Map(contacts.map((c) => [c.phone ?? '', c]));
  // POINTER-AWARE lookups: an ATTACHED second number resolves to the contact
  // whose PRIMARY is a different number. That asymmetry is the whole reason
  // suppression is number-scoped, so a fake that cannot express it cannot test it.
  for (const [phone, contact] of Object.entries(overrides.attachedNumbers ?? {})) {
    contactsByPhone.set(phone, contact);
  }

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
    removeConversation: async () => {
      throw new Error('groupSend must never delete a rail directly - that is ensureGroupRail');
    },
    addProjectedParticipant: async () => {
      throw new Error('groupSend must never attach the author directly - that is ensureGroupRail');
    },
    removeParticipant: async () => {
      throw new Error('groupSend must never detach a participant directly - that is ensureGroupRail');
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
    ...overrides.deps,
    config,
    logger: createLogger({ level: 'silent' }),
    groupConversations: port,
    conversationsRepo: {
      getById: async (id) => (id === conversation.conversationId ? conversation : undefined),
      touchLastActivity: async (_id, previewText, ts) => {
        fakes.touched.push({ previewText, ts });
        return conversation;
      },
      // The READ half of the number-scoped suppression seam. It must NEVER see
      // the group thread itself (spec 4.4 forbids sms_opt_out on a group), which
      // is structurally guaranteed here: a group_text carries no participant_phone.
      findByParticipantPhone: async (phone) => {
        if (overrides.failSuppressionRead === true) throw new Error('index unavailable');
        return (overrides.oneToOneThreads ?? []).filter((c) => c.participant_phone === phone);
      },
      clearGroupRail: overrides.clearGroupRail ?? (async () => true),
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
    // WHO SAID THIS (fix wave 5, adversarial 12). Attribution on a multi-party
    // timeline resolves from `relay_sender_key` by ONE rule; every other
    // multi-party writer sets it and this one did not, so the optimistic "Team"
    // chip the composer rendered VANISHED the moment the SSE-debounced refetch
    // replaced the bubble with the server row.
    expect(appended?.relaySenderKey).toBe('team');
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

  it('does NOT exclude a suppressed member app-side - the post still addresses the whole conversation', async () => {
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
    // ONE post, into the rail, with no per-member addressing anywhere: dropping
    // a participant would be a roster change, and a roster change is a NEW
    // thread identity (spec 4.1) that forks every other member's handset thread.
    expect(f.posted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LIVE QA ROUND 2, L3 - the known-suppressed member's slot
// ---------------------------------------------------------------------------
//
// GROUND TRUTH, established live against the Messages API: after a member opted
// out, a group send produced NO Twilio message record for that leg at all.
// Conversations SKIPS the participant - no leg, no delivery attempt, no 21610,
// and therefore NO RECEIPT, EVER. A slot seeded `queued` for them can never
// move, so the per-send staleness sweep raised a FALSE "group delivery receipts
// silent - check Conversations service webhook config" ERROR on every send to
// that group, pointing the operator at a perfectly healthy webhook.
describe('groupSend - seeding a KNOWN-suppressed member terminal (L3)', () => {
  const optedOutPrimary = {
    ...consentingContact('contact-marcus', '+16175550222'),
    sms_opt_out: true,
  } as ContactItem;

  it('seeds the suppressed member TERMINAL and everyone else queued', async () => {
    const f = makeFakes({
      contacts: [consentingContact('contact-ann', '+16175550111'), optedOutPrimary],
    });
    await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(f.appended[0]?.deliveryRecipients).toEqual({
      'phone#+16175550111': { status: 'queued' },
      'phone#+16175550222': { status: 'undelivered', errorCode: 'contact_opted_out' },
    });
  });

  it('leaves EVERY slot queued when nobody is suppressed', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.appended[0]?.deliveryRecipients).toEqual({
      'phone#+16175550111': { status: 'queued' },
      'phone#+16175550222': { status: 'queued' },
    });
    expect(f.appended[0]?.deliveryStatus).toBe('queued');
  });

  it('reads suppression at the NUMBER scope, not the contact - a secondary number counts', async () => {
    // The contact flag is authoritative for the PRIMARY number only; a member
    // who silenced a SECOND handset carries it on that number's own 1:1 thread.
    // Missing that leaves exactly the stuck slot the alarm then blames on a
    // webhook.
    const f = makeFakes({
      members: [ANN, member('+16175550999', 'contact-marcus', 'Marcus second')],
      contacts: [
        consentingContact('contact-ann', '+16175550111'),
        consentingContact('contact-marcus', '+16175550222'),
      ],
      // +16175550999 is Marcus's SECOND handset: it resolves to his contact,
      // whose own `phone` (the primary) is a different number entirely.
      attachedNumbers: {
        '+16175550999': consentingContact('contact-marcus', '+16175550222'),
      },
      oneToOneThreads: [
        {
          conversationId: 'one-to-one-marcus-second',
          type: 'tenant',
          status: 'open',
          ai_mode: 'auto',
          created_at: '2026-08-01T00:00:00.000Z',
          last_activity_at: '2026-08-01T00:00:00.000Z',
          participant_phone: '+16175550999',
          sms_opt_out: true,
        } as unknown as ConversationItem,
      ],
    });
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.appended[0]?.deliveryRecipients?.['phone#+16175550999']).toEqual({
      status: 'undelivered',
      errorCode: 'contact_opted_out',
    });
  });

  it('falls back to `queued` when the suppression read FAILS, never to a wrong label', async () => {
    // A stuck slot is recoverable (the operator re-sends); telling staff a
    // reachable member opted out is not. The send itself must survive either way.
    const f = makeFakes({
      contacts: [
        consentingContact('contact-ann', '+16175550111'),
        consentingContact('contact-marcus', '+16175550222'),
      ],
      failSuppressionRead: true,
    });
    const out = await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(out.providerSid).toBe('IMposted1');
    expect(f.appended[0]?.deliveryRecipients).toEqual({
      'phone#+16175550111': { status: 'queued' },
      'phone#+16175550222': { status: 'queued' },
    });
  });

  it('derives the AGGREGATE as undelivered when EVERY member is suppressed (L4)', async () => {
    // Nothing was sent to anyone, and no receipt will ever arrive to say so, so
    // leaving the message `queued` would be a send that never finishes.
    const f = makeFakes({
      contacts: [
        { ...consentingContact('contact-ann', '+16175550111'), sms_opt_out: true } as ContactItem,
        optedOutPrimary,
      ],
    });
    const out = await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.appended[0]?.deliveryStatus).toBe('undelivered');
    expect(f.appended[0]?.errorCode).toBe('contact_opted_out');
    expect(out.status).toBe('undelivered');
    expect(f.emitted.find((e) => e.event === 'message.persisted')?.payload).toMatchObject({
      deliveryStatus: 'undelivered',
    });
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

  it('never calls ensureGroupRail when a VERIFIED rail is already attached', async () => {
    const f = makeFakes();
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.railCalls).toEqual([]);
  });

  // THE DEFECT THESE PIN (prod incident 2026-08-17). A stamped sid whose map
  // covered the roster was posted to BLIND. 135 of 136 prod rails did not carry
  // the current business number as a participant (132 never had one; 3 carried
  // the released pre-port number), so every staff reply was 50513 -> a bare
  // `group_send_failed` 503, forever, while inbound kept flowing through the SMS
  // webhook and the thread looked perfectly alive.
  it('routes a rail NOT verified for the current business number through ensureGroupRail BEFORE posting', async () => {
    const f = makeFakes({
      // The 132: stamped, roster covered, author never verified.
      conversation: { twilio_projected_address: undefined },
      rail: {
        ensureGroupRail: async () => ({
          status: 'created',
          twilioConversationSid: 'CHrail1',
          participantMap: { MBann: 'phone#+16175550111', MBmarcus: 'phone#+16175550222' },
        }),
      },
    });
    await f.send({ conversationId: 'group-1', body: 'hi' });
    // Same rail, verified first, then posted into exactly once.
    expect(f.posted.map((p) => p.conversationSid)).toEqual(['CHrail1']);
  });

  it('routes a rail verified for a PREVIOUS business number through ensureGroupRail too', async () => {
    const f = makeFakes({
      // The 3: verified for the temp number, then BUSINESS_PHONE_NUMBER changed.
      conversation: { twilio_projected_address: '+19387775065' },
      rail: {
        ensureGroupRail: async () => ({
          status: 'created',
          twilioConversationSid: 'CHrail1',
          participantMap: { MBann: 'phone#+16175550111', MBmarcus: 'phone#+16175550222' },
        }),
      },
    });
    await f.send({ conversationId: 'group-1', body: 'hi' });
    expect(f.posted.map((p) => p.conversationSid)).toEqual(['CHrail1']);
  });

  it('refuses when the unverified rail cannot be verified, rather than posting into it blind', async () => {
    const f = makeFakes({ conversation: { twilio_projected_address: undefined } });
    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupRailUnavailableError);
    expect(f.railCalls).toEqual(['group-1']);
    expect(f.posted).toEqual([]);
    expect(f.appended).toEqual([]);
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
    // NOTHING RAW LEAVES THE POST CATCH (fix wave 5, adversarial 4). A Twilio
    // SDK network failure is a bare AxiosError whose enumerable `config` carries
    // the Authorization header and the POST body - `Author=+1...&Body=<the full
    // message text>`. Rethrowing it unchanged sent it past api.ts's
    // SendRefusedError-only catch into the Express handler's `log.error({ err })`,
    // which serializes every enumerable key straight into CloudWatch. It is now
    // wrapped in a domain refusal carrying a SUMMARY and no config - which also
    // means the route maps it instead of 500ing.
    const err: Error & { code?: string } = await f
      .send({ conversationId: 'group-1', body: 'hi' })
      .then(
        () => new Error('expected a throw'),
        (e: unknown) => e as Error & { code?: string },
      );
    // The CODE changed in fix wave 2 (adversarial 2 / conformance F4): a generic
    // post failure is a RETRYABLE send failure, not "this thread has no rail".
    expect(err).toBeInstanceOf(GroupSendFailedError);
    expect(err.code).toBe('group_send_failed');
    expect(err.message).not.toContain('twilio exploded'); // the raw message is not the wrapper's
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
      new GroupSendFailedError('c', 'why').code,
      new GroupSendBusyError('c').code,
    ];
    expect(codes).toEqual([
      'not_a_group_text',
      'group_roster_empty',
      'group_too_many_members',
      'group_member_deleted',
      'group_member_no_consent',
      'group_rail_unavailable',
      'group_send_failed',
      'group_send_busy',
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

// THE DEFECT THIS PINS (fix wave 5, adversarial 34). relayFanOut draws ONE
// token per member from the shared A2P bucket sized to keep combined outbound
// under the registered tier; broadcasts and missed-call auto-text draw from the
// same one. A group post drew NOTHING and Twilio fanned it out to up to NINE
// handsets, so a burst of group replies ate the throughput those paths are
// being paced against.
describe('groupSend - the A2P meter', () => {
  /**
   * A REAL bucket on a fake clock, wrapped only to RECORD the draws.
   *
   * The wave-1 tests injected `{ acquire: async (n) => draws.push(n) }`, which
   * records the requested count and performs no arithmetic - so they proved the
   * call site passes N and could not see that the bucket charged 1 (it clamped
   * to capacity, and capacity is 1 at the shipped default rate). This wrapper
   * delegates to the real TokenBucket, so what is asserted is what is SPENT.
   */
  function meteredBucket(opts: { capacity: number; refillPerSec: number }) {
    const clock = fakeBucketTime();
    const real = new TokenBucket({
      capacity: opts.capacity,
      refillPerSec: opts.refillPerSec,
      now: clock.now,
      sleep: clock.sleep,
      maxJitterMs: 0,
    });
    const draws: number[] = [];
    return {
      clock,
      draws,
      bucket: {
        acquire: async (n = 1, o: { timeoutMs?: number } = {}) => {
          draws.push(n);
          await real.acquire(n, o);
        },
      },
    };
  }

  it('SPENDS one token per member - a nine-member post costs nine, not one', async () => {
    // THE DEFECT (fix wave 2, adversarial 3 / conformance F3). `acquire(9)` was
    // clamped to capacity, and capacity is `max(1, A2P_RATE_LIMIT_PER_SEC)` with
    // a shipped default of 1.0 - so nine carrier messages drew ONE token. At
    // 1/sec a nine-token draw with a full bucket costs 8 refills of real waiting;
    // one token would cost none.
    const metered = meteredBucket({ capacity: 1, refillPerSec: 1 });
    const nine = Array.from({ length: 9 }, (_, i) =>
      member(`+161755501${String(i).padStart(2, '0')}`, `contact-${i}`, `Member ${i}`),
    );
    const f = makeFakes({
      members: nine,
      contacts: nine.map((m) => consentingContact(m.contactId, m.phone)),
      deps: { tokenBucket: metered.bucket },
    });

    await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(metered.draws).toEqual([9]);
    // Eight one-second refills: the ninth message really was paced.
    expect(metered.clock.waits.reduce((a, b) => a + b, 0)).toBe(8000);
  });

  it('spends NOTHING on a send that is going to be refused', async () => {
    const metered = meteredBucket({ capacity: 4, refillPerSec: 4 });
    const f = makeFakes({
      conversation: { participants: [] },
      deps: { tokenBucket: metered.bucket },
    });

    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toThrow();
    expect(metered.draws).toEqual([]);
  });

  it('spends NOTHING when the A2P kill switch is going to refuse the post', async () => {
    // The meter used to be drawn BEFORE the kill switch, which lives inside the
    // adapter (fix wave 2, adversarial 16). Under the pre-A2P prod posture
    // (SMS_SENDING_ENABLED=false) EVERY attempt spent throughput and then
    // refused - the one configuration where nothing may be spent at all.
    const metered = meteredBucket({ capacity: 4, refillPerSec: 4 });
    const f = makeFakes({
      smsSendingEnabled: false,
      deps: { tokenBucket: metered.bucket },
    });

    await expect(f.send({ conversationId: 'group-1', body: 'hi' })).rejects.toBeInstanceOf(
      SmsSendingDisabledError,
    );
    expect(metered.draws).toEqual([]);
  });

  it('the HEAL RETRY draws again - one request never puts 2N messages on the wire for N tokens', async () => {
    // The meter was drawn once, before the first post (fix wave 3, conformance
    // 4). On the closed-rail heal path the retry emits a SECOND full fan-out of
    // N carrier messages, so a single request was the one place that could
    // outrun the tier the meter exists to hold.
    //
    // The ensurer is stubbed here ON PURPOSE and the scope is the METER: what is
    // asserted is that a second post is preceded by a second draw. That the heal
    // itself works is proven separately against the REAL ensureGroupRail (see
    // 'a CLOSED rail is DELETED and rebuilt through the REAL ensureGroupRail').
    const metered = meteredBucket({ capacity: 4, refillPerSec: 4 });
    let attempts = 0;
    const f = makeFakes({
      deps: { tokenBucket: metered.bucket },
      port: {
        postGroupMessage: async () => {
          attempts += 1;
          if (attempts === 1) throw new GroupConversationsUnavailableError('the rail is closed or gone');
          return { messageSid: 'IMhealed1', dateCreated: '2026-08-11T13:00:01.000Z' };
        },
      },
      rail: {
        ensureGroupRail: async () => ({
          status: 'created',
          twilioConversationSid: 'CHrail2',
          participantMap: { MBann2: 'phone#+16175550111', MBmarcus2: 'phone#+16175550222' },
        }),
      },
      clearGroupRail: async () => true,
    });

    await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(attempts).toBe(2);
    expect(metered.draws).toEqual([2, 2]);
  });

  it('REFUSES with a staff-facing busy error rather than parking the request forever', async () => {
    // `acquire` never rejects and serialises waiters FIFO, so an interactive
    // send behind a queue held an Express request open with no bound at all.
    const metered = meteredBucket({ capacity: 1, refillPerSec: 0.01 }); // 100s per token
    const f = makeFakes({ deps: { tokenBucket: metered.bucket } });

    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).code).toBe('group_send_busy');
  });
});

describe('groupSend - a failed post says WHICH kind of failure it was', () => {
  it('a TRANSIENT post failure is retryable, NOT "this thread has no rail"', async () => {
    // Wave 1 translated EVERY non-kill-switch failure into
    // `group_rail_unavailable` (fix wave 2, adversarial 2 / conformance F4). A
    // network timeout, a 429 or a 500 then told staff the thread has no rail -
    // the thread's rail is fine and retrying is the correct response.
    const f = makeFakes({
      port: {
        postGroupMessage: async () => {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        },
      },
    });

    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).code).toBe('group_send_failed');
  });

  // THESE TWO TESTS DRIVE THE REAL `ensureGroupRail` (fix wave 4, H1), and that
  // is the point of them.
  //
  // They used to hand `rail:` a stub. The first returned `{status:'created'}`
  // for a closed rail - an outcome the real service COULD NOT PRODUCE: it
  // adopted the same closed Conversation by UniqueName and recorded
  // `rail_failed`. The second went further and froze the defect as its fixture,
  // asserting the refusal for the literal reason `Conversation CHrail1 is
  // closed`. Between them the "closed rails are healed" claim passed for three
  // waves while every real closed rail was permanently inbound-only. A stub can
  // only ever prove the call site; the recovery is a property of the two
  // together, so the two are wired together here.
  //
  // `port` is shared by the send service and the rail service, exactly as the
  // process shares one adapter. The default fake's "groupSend must never create
  // a rail directly" guard is deliberately overridden below, because the create
  // now happens INSIDE ensureGroupRail - which is what that guard is protecting.

  /** The thread row as it stands after `healRail`'s clear: rail-less. */
  function railLessThread(): ConversationItem {
    return {
      conversationId: 'group-1',
      type: 'group_text',
      status: 'group_open',
      created_at: '2026-08-01T00:00:00.000Z',
      last_activity_at: '2026-08-10T00:00:00.000Z',
      participants: [ANN, MARCUS],
    } as ConversationItem;
  }

  /** The REAL ensureGroupRail over a port fake and an in-memory thread row. */
  function realRailOver(port: GroupConversationsPort, thread: ConversationItem): GroupRailEnsurer {
    let row: ConversationItem = thread;
    const repo = {
      async getById(id: string) {
        return id === row.conversationId ? { ...row } : undefined;
      },
      async claimRailCreation(_id: string, claim: { token: string; at: string }) {
        row = { ...row, rail_creating: { ...claim } };
        return { claimed: true, item: { ...row } };
      },
      async setTwilioConversation(
        _id: string,
        sid: string,
        map: Record<string, string>,
        token: string,
        projectedAddress: string,
      ) {
        if (row.rail_creating?.token !== token) return undefined;
        const next = {
          ...row,
          twilio_conversation_sid: sid,
          twilio_participant_map: map,
          twilio_projected_address: projectedAddress,
        };
        delete next.rail_creating;
        row = next;
        return { ...next };
      },
      async recordRailFailure(_id: string, reason: string, at: string) {
        const next = { ...row, rail_failed: { at, reason } };
        delete next.rail_creating;
        row = next;
      },
    };
    return createGroupRailService({
      conversationsRepo: repo as unknown as GroupRailServiceDeps['conversationsRepo'],
      groupConversations: port,
      businessNumber: '+14045550000',
      logger: createLogger({ level: 'silent' }),
    });
  }

  it('a CLOSED rail is DELETED and rebuilt through the REAL ensureGroupRail, then the post retried', async () => {
    // A closed Conversation KEEPS its UniqueName, and our UniqueName is the
    // conversationId - so the adopt half found the same dead resource on every
    // retry. Reclaiming the name by deleting it is the whole heal.
    let live: GroupConversationRef | undefined = {
      conversationSid: 'CHrail1',
      uniqueName: 'group-1',
      state: 'closed',
    };
    const removed: string[] = [];
    const postedTo: string[] = [];
    const cleared: { conversationId: string; sid: string }[] = [];

    const port: GroupConversationsPort = {
      fetchByUniqueName: async () => live,
      removeConversation: async (sid) => {
        removed.push(sid);
        live = undefined;
        return true;
      },
      createConversationWithParticipants: async (input) => ({
        conversation: { conversationSid: 'CHrail2', uniqueName: input.uniqueName, state: 'active' },
        participants: [
          { participantSid: 'MBbiz2', projectedAddress: '+14045550000' },
          { participantSid: 'MBann2', address: ANN.phone },
          { participantSid: 'MBmarcus2', address: MARCUS.phone },
        ],
        failures: [],
      }),
      fetchParticipants: async () => {
        throw new Error('the create already read the participants back');
      },
      addParticipants: async () => {
        throw new Error('a freshly created rail is not short of anyone');
      },
      addProjectedParticipant: async () => {
        throw new Error('a freshly bulk-created rail already carries its author');
      },
      removeParticipant: async () => {
        throw new Error('nothing stale on a fresh rail');
      },
      postGroupMessage: async (input) => {
        postedTo.push(input.conversationSid);
        // The refusal Twilio really returns for a post into a closed rail.
        if (input.conversationSid === 'CHrail1') {
          throw new GroupConversationsUnavailableError('the rail is closed or gone');
        }
        return { messageSid: 'IMhealed1', dateCreated: '2026-08-11T13:00:01.000Z' };
      },
    };

    const f = makeFakes({
      port,
      rail: realRailOver(port, railLessThread()),
      clearGroupRail: async (conversationId, sid) => {
        cleared.push({ conversationId, sid });
        return true;
      },
    });

    const out = await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(cleared).toEqual([{ conversationId: 'group-1', sid: 'CHrail1' }]);
    // The dead Conversation was deleted rather than re-adopted. Without this the
    // whole send refuses, which is what it did in production.
    expect(removed).toEqual(['CHrail1']);
    // The retry posted into the NEW rail, and the snapshot records that one.
    expect(postedTo).toEqual(['CHrail1', 'CHrail2']);
    expect(f.appended[0]?.groupRailSnapshot?.conversationSid).toBe('CHrail2');
    expect(f.appended[0]?.groupRailSnapshot?.participantMap).toEqual({
      MBann2: 'phone#+16175550111',
      MBmarcus2: 'phone#+16175550222',
    });
    expect(out.providerSid).toBe('IMhealed1');
  });

  it('a CLOSED rail that cannot be rebuilt refuses as rail-unavailable, loudly', async () => {
    // The refusal is now driven by a cause that is really permanent - Twilio
    // refusing the create - rather than by a stub asserting the very bug ("the
    // adopted Conversation is closed") as though it were correct behavior.
    const port: GroupConversationsPort = {
      fetchByUniqueName: async () => ({
        conversationSid: 'CHrail1',
        uniqueName: 'group-1',
        state: 'closed',
      }),
      removeConversation: async () => true,
      createConversationWithParticipants: async () => {
        throw Object.assign(new Error('Invalid messaging binding address'), {
          code: 50407,
          status: 400,
        });
      },
      fetchParticipants: async () => [],
      addParticipants: async () => [],
      addProjectedParticipant: async () => {
        throw new Error('never reached - the create refused first');
      },
      removeParticipant: async () => true,
      postGroupMessage: async () => {
        throw new GroupConversationsUnavailableError('the rail is closed or gone');
      },
    };

    const f = makeFakes({
      port,
      rail: realRailOver(port, railLessThread()),
      clearGroupRail: async () => true,
    });

    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).code).toBe('group_rail_unavailable');
  });

  // THE DEFECT THIS PINS (prod incident 2026-08-17), Twilio's-word variant. The
  // row can SAY the rail is verified (a hand repair reverted, a participant
  // removed in the console, an older build's stamp) and Twilio still refuse the
  // author with 50513. The refusal is healed like a closed rail - drop the
  // stored rail, re-adopt the SAME live conversation through the REAL
  // ensureGroupRail, attach the business number, retry - and NOTHING is deleted,
  // because the rail is alive and its members are attached.
  it('an AUTHOR-REFUSED rail (50513) is re-adopted, its business number attached, and the post retried', async () => {
    const attached: string[] = [];
    const postedAs: { sid: string; author: string }[] = [];
    const cleared: string[] = [];
    let railParticipants: GroupParticipantRef[] = [
      { participantSid: 'MBann', address: ANN.phone },
      { participantSid: 'MBmarcus', address: MARCUS.phone },
    ];

    const port: GroupConversationsPort = {
      // ALIVE - the adopt half finds it and must keep it.
      fetchByUniqueName: async () => ({ conversationSid: 'CHrail1', uniqueName: 'group-1', state: 'active' }),
      removeConversation: async () => {
        throw new Error('an author refusal must never delete a live rail');
      },
      createConversationWithParticipants: async () => {
        throw new Error('an author refusal must never mint a second rail');
      },
      fetchParticipants: async () => railParticipants,
      addParticipants: async () => {
        throw new Error('the roster is fully attached');
      },
      addProjectedParticipant: async (_sid, businessNumber) => {
        attached.push(businessNumber);
        const ref = { participantSid: 'MBbiz', projectedAddress: businessNumber };
        railParticipants = [...railParticipants, ref];
        return ref;
      },
      removeParticipant: async () => {
        throw new Error('nothing stale to remove');
      },
      postGroupMessage: async (input) => {
        postedAs.push({ sid: input.conversationSid, author: input.author });
        // Twilio's 50513 until the business number is a participant.
        if (!railParticipants.some((p) => p.projectedAddress === input.author)) {
          throw new GroupConversationsAuthorRejectedError('author is not among the participants');
        }
        return { messageSid: 'IMhealed2', dateCreated: '2026-08-11T13:00:02.000Z' };
      },
    };

    const f = makeFakes({
      port,
      // The row SAYS verified; Twilio disagrees.
      rail: realRailOver(port, railLessThread()),
      clearGroupRail: async (_conversationId, sid) => {
        cleared.push(sid);
        return true;
      },
    });

    const out = await f.send({ conversationId: 'group-1', body: 'hi' });

    expect(cleared).toEqual(['CHrail1']);
    expect(attached).toEqual(['+14045550000']);
    // Same rail both times: refused, repaired, accepted.
    expect(postedAs).toEqual([
      { sid: 'CHrail1', author: '+14045550000' },
      { sid: 'CHrail1', author: '+14045550000' },
    ]);
    expect(f.appended[0]?.groupRailSnapshot?.conversationSid).toBe('CHrail1');
    expect(out.providerSid).toBe('IMhealed2');
  });

  it('an author refusal that SURVIVES the repair refuses as rail-unavailable rather than looping', async () => {
    const port: GroupConversationsPort = {
      fetchByUniqueName: async () => ({ conversationSid: 'CHrail1', uniqueName: 'group-1', state: 'active' }),
      removeConversation: async () => true,
      createConversationWithParticipants: async () => {
        throw new Error('never');
      },
      fetchParticipants: async () => [
        { participantSid: 'MBann', address: ANN.phone },
        { participantSid: 'MBmarcus', address: MARCUS.phone },
      ],
      addParticipants: async () => [],
      addProjectedParticipant: async (_sid, businessNumber) => ({
        participantSid: 'MBbiz',
        projectedAddress: businessNumber,
      }),
      removeParticipant: async () => true,
      postGroupMessage: async () => {
        throw new GroupConversationsAuthorRejectedError('still refused');
      },
    };
    const f = makeFakes({
      port,
      rail: realRailOver(port, railLessThread()),
      clearGroupRail: async () => true,
    });

    const err = await f.send({ conversationId: 'group-1', body: 'hi' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).code).toBe('group_rail_unavailable');
    expect(f.appended).toEqual([]);
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
