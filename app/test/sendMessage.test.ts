// M1.1 unit tests: outbound send service — opt-out refusal, circuit breaker
// trip (flip to manual + ERROR log), manual-mode semantics, persist-at-send.
// All repos/adapters are in-memory fakes: no DynamoDB, no network.
import { describe, expect, it } from 'vitest';
import type { MessagingAdapter, SendMessageParams } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';
import { createEventBus, type AppEventName } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import type { AuditRepo } from '../src/repos/auditRepo.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessagesRepo, NewMessage } from '../src/repos/messagesRepo.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';
import {
  CircuitBreakerOpenError,
  ContactOptedOutError,
  ConversationNotFoundError,
  ManualModeError,
  RelaySendNotSupportedError,
  createSendMessageService,
} from '../src/services/sendMessage.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const ERROR = 50;

interface Fakes {
  conversation: ConversationItem;
  contact: ContactItem | undefined;
  sent: SendMessageParams[];
  appended: NewMessage[];
  touched: { previewText: string | undefined; ts: string }[];
  modeSets: string[];
  auditEvents: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  emitted: { event: AppEventName; payload: unknown }[];
  counterValue: number;
  capture: LogCapture;
  service: ReturnType<typeof createSendMessageService>;
}

function makeFakes(overrides: { conversation?: Partial<ConversationItem>; contact?: ContactItem | null } = {}): Fakes {
  const conversation: ConversationItem = {
    conversationId: 'conv-1',
    participant_phone: '+15550100001',
    status: 'open',
    last_activity_at: '2026-06-12T09:00:00.000Z',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-12T09:00:00.000Z',
    ...overrides.conversation,
  };
  const contact: ContactItem | undefined =
    overrides.contact === null
      ? undefined
      : (overrides.contact ?? { contactId: 'contact-1', type: 'tenant', phone: '+15550100001' });

  const fakes = {
    conversation,
    contact,
    sent: [] as SendMessageParams[],
    appended: [] as NewMessage[],
    touched: [] as { previewText: string | undefined; ts: string }[],
    modeSets: [] as string[],
    auditEvents: [] as Fakes['auditEvents'],
    emitted: [] as Fakes['emitted'],
    counterValue: 0,
  };

  const conversationsRepo: ConversationsRepo = {
    createOrGetByParticipantPhone: async () => conversation,
    getById: async (id) => (id === conversation.conversationId ? conversation : undefined),
    findByParticipantPhone: async () => [conversation],
    setType: async (_id, type) => {
      conversation.type = type;
      return conversation;
    },
    applyTriage: async (_id, fields) => {
      if (fields.type !== undefined) conversation.type = fields.type;
      if (fields.displayName !== undefined && fields.displayName !== null) {
        conversation.participant_display_name = fields.displayName;
      }
      return conversation;
    },
    touchLastActivity: async (_id, previewText, ts) => {
      fakes.touched.push({ previewText, ts });
      conversation.last_activity_at = ts;
      if (previewText !== undefined) conversation.last_message_preview = previewText;
      return conversation;
    },
    setParticipantsIfAbsent: async () => true,
    incrementUnread: async () => 1,
    resetUnread: async () => conversation,
    setAssignment: async () => ({ conversation, previousAssigneeUserId: null }),
    listByLastActivity: async () => ({ items: [conversation] }),
    setMode: async (_id, mode) => {
      fakes.modeSets.push(mode);
      conversation.ai_mode = mode;
    },
    setSmsOptOut: async (_id, value) => {
      conversation.sms_opt_out = value;
    },
    incrementAutomatedSendCount: async () => {
      fakes.counterValue += 1;
      return fakes.counterValue;
    },
    // Relay groups (M1.7) — unused by the send service:
    createRelayGroup: async () => conversation,
    getByPoolNumber: async () => undefined,
    addMember: async () => conversation,
    removeMember: async () => conversation,
    setRelayStatus: async () => conversation,
  };
  const contactsRepo: ContactsRepo = {
    findByPhone: async () => contact,
    getById: async (id) => (contact?.contactId === id ? contact : undefined),
    listByType: async () => ({ items: [] }),
    listByHousingAuthority: async () => ({ items: [] }),
    create: async (input) => ({ ...input, contactId: input.contactId ?? 'contact-sm-1' }),
    createIfAbsent: async () => true,
    setFlag: async () => {},
    clearFlag: async () => {},
    update: async () => contact!,
  };
  const messagesRepo: MessagesRepo = {
    append: async (message) => {
      fakes.appended.push(message);
      return { deduped: false, tsMsgId: buildTsMsgId(message.providerTs, message.providerSid) };
    },
    getByProviderSid: async () => undefined,
    updateDeliveryStatus: async () => true,
    updateCallStatus: async () => true,
    listByConversation: async () => [],
    annotateMessage: async () => {},
    putJobExecutionMarker: async () => true,
    // Relay groups (M1.7) — unused by the send service:
    setRecipientDelivery: async () => {},
    updateRecipientDeliveryStatus: async () => true,
    putRelaySidPointer: async () => {},
    getRelaySidPointer: async () => undefined,
  };
  const auditRepo: AuditRepo = {
    append: async (entityKey, eventType, payload) => {
      fakes.auditEvents.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
    },
  };
  const adapter: MessagingAdapter = {
    sendMessage: async (params) => {
      fakes.sent.push(params);
      return { providerSid: `SMfake-${fakes.sent.length}`, status: 'queued', providerTs: '2026-06-12T10:00:00.000Z' };
    },
    getMediaStream: async () => {
      throw new Error('not used');
    },
    provisionPhoneNumber: async () => ({
      phoneNumber: '+15550109000',
      capabilities: { sms: true, voice: true },
      sid: 'PNfake-sm',
    }),
    setVoiceWebhook: async () => {},
    initiateCall: async () => ({ callSid: 'CAfake-sm' }),
  };

  const events = createEventBus();
  events.on('conversation.updated', (payload) => fakes.emitted.push({ event: 'conversation.updated', payload }));
  events.on('message.persisted', (payload) => fakes.emitted.push({ event: 'message.persisted', payload }));

  const capture = createLogCapture();
  const service = createSendMessageService({
    config: loadConfig({ NODE_ENV: 'test', SEND_BREAKER_MAX_PER_MINUTE: '3' }),
    logger: createLogger({ level: 'info', destination: capture.stream }),
    adapter,
    conversationsRepo,
    messagesRepo,
    contactsRepo,
    auditRepo,
    events,
  });

  // NOTE: the closures above mutate `fakes` — return it (augmented), never a copy.
  return Object.assign(fakes, { capture, service });
}

describe('sendMessage service', () => {
  it('sends, persists at send time (outbound/teammate, provider SID + ts), and touches last activity', async () => {
    const f = makeFakes();
    const outcome = await f.service({ conversationId: 'conv-1', body: 'hello there' });

    expect(f.sent).toEqual([{ to: '+15550100001', body: 'hello there' }]);
    expect(f.appended).toHaveLength(1);
    expect(f.appended[0]).toMatchObject({
      conversationId: 'conv-1',
      providerSid: 'SMfake-1',
      providerTs: '2026-06-12T10:00:00.000Z',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
    });
    expect(f.touched).toEqual([{ previewText: 'hello there', ts: '2026-06-12T10:00:00.000Z' }]);
    expect(outcome).toEqual({
      conversationId: 'conv-1',
      providerSid: 'SMfake-1',
      tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
      status: 'queued',
    });
  });

  it('marks sends with media as mms', async () => {
    const f = makeFakes();
    await f.service({ conversationId: 'conv-1', mediaUrls: ['https://m/1'] });
    expect(f.appended[0]).toMatchObject({ type: 'mms', mediaUrls: ['https://m/1'] });
  });

  it('throws ConversationNotFoundError for unknown conversations (nothing sent)', async () => {
    const f = makeFakes();
    await expect(f.service({ conversationId: 'conv-nope', body: 'x' })).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
    expect(f.sent).toHaveLength(0);
  });

  it('FIX 2: refuses a relay_group conversation (defense in depth) — never texts the pool number', async () => {
    const f = makeFakes({ conversation: { type: 'relay_group', pool_number: '+15550109000' } });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      RelaySendNotSupportedError,
    );
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('refuses sends to sms_opt_out contacts with a typed error (nothing sent, nothing persisted)', async () => {
    const f = makeFakes({
      contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true },
    });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('refuses sends when the CONVERSATION has sms_opt_out — even with no contact record (STOP from unknown phone)', async () => {
    const f = makeFakes({ conversation: { sms_opt_out: true }, contact: null });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('allows sends when the phone resolves to no contact yet (auto-capture is M1.2)', async () => {
    const f = makeFakes({ contact: null });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).resolves.toMatchObject({
      providerSid: 'SMfake-1',
    });
  });

  it('writes a message_sent audit event after a successful send (IDs only, never the body)', async () => {
    const f = makeFakes();
    await f.service({ conversationId: 'conv-1', body: 'audit me' });
    expect(f.auditEvents).toEqual([
      {
        entityKey: 'conversations#conv-1',
        eventType: 'message_sent',
        payload: { providerSid: 'SMfake-1', automated: false, author: 'teammate' },
      },
    ]);
    expect(JSON.stringify(f.auditEvents)).not.toContain('audit me');
  });

  it('emits message.persisted + conversation.updated after a successful send (M1.2 SSE), unread untouched', async () => {
    const f = makeFakes({ conversation: { unread_count: 2 } });
    await f.service({ conversationId: 'conv-1', body: 'live update' });

    expect(f.emitted).toEqual([
      {
        event: 'message.persisted',
        payload: {
          conversationId: 'conv-1',
          tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
          direction: 'outbound',
          deliveryStatus: 'queued',
        },
      },
      {
        event: 'conversation.updated',
        payload: {
          conversationId: 'conv-1',
          last_activity_at: '2026-06-12T10:00:00.000Z',
          // Outbound sends never touch unread_count — the event carries the
          // existing value through.
          unread_count: 2,
          preview: 'live update',
          // M1.4 wire fields (shared builder): the thread's current type +
          // assignment + resolved name ride along on every conversation.updated.
          type: 'tenant_1to1',
          assignment: null,
          participant_display_name: null,
        },
      },
    ]);
  });

  it('emits NOTHING when the send is refused (opt-out gate)', async () => {
    const f = makeFakes({
      contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true },
    });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
    expect(f.emitted).toHaveLength(0);
  });

  it('persists + audits the caller-supplied author (ai) — the Phase 2 seam', async () => {
    const f = makeFakes();
    await f.service({ conversationId: 'conv-1', body: 'from the ai', automated: true, author: 'ai' });
    expect(f.appended[0]).toMatchObject({ author: 'ai' });
    expect(f.auditEvents[0]).toMatchObject({
      eventType: 'message_sent',
      payload: { providerSid: 'SMfake-1', automated: true, author: 'ai' },
    });
  });

  describe('circuit breaker (automated sends, cap 3/min in this suite)', () => {
    it('lets automated sends through up to the cap, then trips: manual flip + ERROR log + typed error', async () => {
      const f = makeFakes();
      for (let i = 0; i < 3; i++) {
        await f.service({ conversationId: 'conv-1', body: `auto ${i}`, automated: true });
      }
      expect(f.sent).toHaveLength(3);

      await expect(
        f.service({ conversationId: 'conv-1', body: 'auto 4', automated: true }),
      ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

      expect(f.sent).toHaveLength(3); // the tripping send never reached the provider
      expect(f.modeSets).toEqual(['manual']);
      // The mode flip is an audit-trail event (§5) — alongside the three
      // message_sent events from the allowed sends.
      expect(f.auditEvents.filter((e) => e.eventType === 'mode_changed')).toEqual([
        {
          entityKey: 'conversations#conv-1',
          eventType: 'mode_changed',
          payload: { from: 'auto', to: 'manual', reason: 'breaker_trip' },
        },
      ]);
      // The trip line must be ERROR level — that's what the hc-<env>-error-logs
      // alarm picks up.
      const errors = f.capture.atLevel(ERROR);
      expect(errors).toHaveLength(1);
      expect(errors[0]!['msg']).toContain('circuit breaker TRIPPED');
      expect(errors[0]!['conversationId']).toBe('conv-1');
    });

    it('refuses automated sends while in manual mode (ManualModeError), without counting', async () => {
      const f = makeFakes({ conversation: { ai_mode: 'manual' } });
      await expect(
        f.service({ conversationId: 'conv-1', body: 'auto', automated: true }),
      ).rejects.toBeInstanceOf(ManualModeError);
      expect(f.counterValue).toBe(0);
      expect(f.sent).toHaveLength(0);
    });

    it('still allows MANUAL human sends in manual mode and never counts them', async () => {
      const f = makeFakes({ conversation: { ai_mode: 'manual' } });
      await expect(f.service({ conversationId: 'conv-1', body: 'human' })).resolves.toMatchObject({
        providerSid: 'SMfake-1',
      });
      expect(f.counterValue).toBe(0);
    });
  });
});
