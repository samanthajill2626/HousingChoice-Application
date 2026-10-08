// M1.1 unit tests: outbound send service — opt-out refusal, circuit breaker
// trip (flip to manual + ERROR log), manual-mode semantics, persist-at-send.
// All repos/adapters are in-memory fakes: no DynamoDB, no network.
import { describe, expect, it } from 'vitest';
import type {
  CarrierMessageSender,
  MessagingAdapter,
  MessageTransportFacts,
  PreparedMessageSend,
  SendMessageParams,
} from '../src/adapters/messaging.js';
import type { MessageTransport } from '../src/lib/messageTransport.js';
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
  ContactDeletedError,
  ContactNoConsentError,
  ContactOptedOutError,
  ConversationNotFoundError,
  ManualModeError,
  GroupTextSendNotSupportedError,
  ProviderSendFailedError,
  RelaySendNotSupportedError,
  SendAcceptedNotRecordedError,
  SendNotAttemptedError,
  SendRefusedError,
  SmsSendingDisabledError,
  createSendMessageService,
} from '../src/services/sendMessage.js';
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../src/adapters/messagingErrors.js';
import { bodyFingerprint, recipientDigest } from '../src/lib/sendFingerprint.js';
import { pinnedSender } from '../src/lib/outboundSender.js';
import { previewSendRefusal } from '../src/services/sendRefusalPreview.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { SEND_REFUSAL_CASES, SEND_REFUSAL_PHONE } from './helpers/sendRefusalCases.js';
import { queryUnreadPageFromItems } from './helpers/unreadIndexFake.js';

const ERROR = 50;

interface Fakes {
  conversation: ConversationItem;
  contact: ContactItem | undefined;
  sent: SendMessageParams[];
  classified: MessageTransportFacts[];
  prepared: PreparedMessageSend[];
  appended: NewMessage[];
  touched: { previewText: string | undefined; ts: string }[];
  modeSets: string[];
  auditEvents: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  emitted: { event: AppEventName; payload: unknown }[];
  counterValue: number;
  capture: LogCapture;
  service: ReturnType<typeof createSendMessageService>;
}

function makeFakes(
  overrides: {
    conversation?: Partial<ConversationItem>;
    contact?: ContactItem | null;
    /** Extra env passed to loadConfig (e.g. SMS_SENDING_ENABLED). */
    env?: Record<string, string>;
    actualTransport?: MessageTransport | null;
    sendError?: Error;
    // SOR D3 seams: each throws from the named fake step, on every call.
    getByIdError?: unknown;
    findByPhoneError?: unknown;
    incrementError?: unknown;
    setModeError?: unknown;
    classifyError?: unknown;
    appendError?: unknown;
    touchError?: unknown;
    auditError?: unknown;
  } = {},
): Fakes {
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
      : (overrides.contact ?? {
          contactId: 'contact-1',
          type: 'tenant',
          phone: '+15550100001',
          // Default: a contact WITH recorded consent (a real 1:1 partner) so the
          // happy-path human sends aren't JIT-gated. The JIT-gate tests override
          // with a no-consent contact.
          consent_method: 'inbound_text',
        });

  const fakes = {
    conversation,
    contact,
    sent: [] as SendMessageParams[],
    classified: [] as MessageTransportFacts[],
    prepared: [] as PreparedMessageSend[],
    appended: [] as NewMessage[],
    touched: [] as { previewText: string | undefined; ts: string }[],
    modeSets: [] as string[],
    auditEvents: [] as Fakes['auditEvents'],
    emitted: [] as Fakes['emitted'],
    counterValue: 0,
  };

  const conversationsRepo: ConversationsRepo = {
    createOrGetByParticipantPhone: async () => conversation,
    getById: async (id) => {
      if (overrides.getByIdError !== undefined) throw overrides.getByIdError;
      return id === conversation.conversationId ? conversation : undefined;
    },
    findByParticipantPhone: async () => [conversation],
    findByParticipantEmail: async () => [],
    claimEmailForConversation: async (_email, conversationId) => ({ conversationId }),
    attachEmailToConversation: async (conversationId) => ({ conversationId }),
    createOrGetByParticipantEmail: async () => conversation,
    getReplyToken: async () => 'faketoken',
    findByReplyToken: async () => undefined,
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
    setTypeIfCurrent: async () => {
      throw new Error('setTypeIfCurrent: not used in this suite');
    },
    touchLastActivity: async (_id, previewText, ts) => {
      if (overrides.touchError !== undefined) throw overrides.touchError;
      fakes.touched.push({ previewText, ts });
      conversation.last_activity_at = ts;
      if (previewText !== undefined) conversation.last_message_preview = previewText;
      return conversation;
    },
    // D16's status-preserving twin. Deliberately NOT recorded in
    // `fakes.touched`: that ledger belongs to touchLastActivity, and this
    // suite's assertions read it as "the send bumped the thread".
    touchLastActivityPreservingStatus: async (_id, preview, at) => {
      conversation.last_activity_at = at;
      if (preview !== undefined) conversation.last_message_preview = preview;
      return conversation;
    },
    setParticipantsIfAbsent: async () => true,
    incrementUnread: async () => 1,
    resetUnread: async () => conversation,
    setUnread: async () => conversation,
    // Derived from the one stored conversation rather than stubbed to []: an
    // empty page is indistinguishable from a broken index, and this suite
    // asserts that OUTBOUND sends never touch unread state.
    queryUnreadPage: async (opts) => queryUnreadPageFromItems([conversation], opts),
    listByLastActivity: async () => ({ items: [conversation] }),
    listRelayGroups: async () => ({ items: [], truncated: false }),
    listRelayOptOutAttention: async () => ({ items: [] }),
    setMode: async (_id, mode) => {
      if (overrides.setModeError !== undefined) throw overrides.setModeError;
      fakes.modeSets.push(mode);
      conversation.ai_mode = mode;
    },
    setSmsOptOut: async (_id, value) => {
      conversation.sms_opt_out = value;
    },
    incrementAutomatedSendCount: async () => {
      if (overrides.incrementError !== undefined) throw overrides.incrementError;
      fakes.counterValue += 1;
      return fakes.counterValue;
    },
    // Relay groups (M1.7 / Task 5) — unused by the send service:
    createRelayGroup: async () => conversation,
    getByPoolNumber: async () => undefined,
    getAllByPoolNumber: async () => [],
    setCloseNagNextAt: async () => {},
    claimCloseAnnounce: async () => false,
    addMember: async () => conversation,
    removeMember: async () => conversation,
    setRelayStatus: async () => conversation,
    assignPoolNumberAndOpen: async () => undefined,
    setRelayMemberOptedOut: async () => {},
    clearRelayMemberOptedOut: async () => {},
    rebindOwner: async () => conversation,
    // group_text repo methods are unreachable from this 1:1 suite - throw so an
    // accidental call is loud instead of silently returning a plausible shape.
    createGroupTextThread: async () => {
      throw new Error('createGroupTextThread: not used in this suite');
    },
    listGroupTexts: async () => {
      throw new Error('listGroupTexts: not used in this suite');
    },
    claimRailCreation: async () => {
      throw new Error('claimRailCreation: not used in this suite');
    },
    clearGroupRail: async () => {
      throw new Error('clearGroupRail: not used in this suite');
    },
    recordRailFailure: async () => {
      throw new Error('recordRailFailure: not used in this suite');
    },
    setTwilioConversation: async () => {
      throw new Error('setTwilioConversation: not used in this suite');
    },
    convertRelayGroupToGroupText: async () => {
      throw new Error('convertRelayGroupToGroupText: not used in this suite');
    },
    backfillGroupTextRoster: async () => {
      throw new Error('backfillGroupTextRoster: not used in this suite');
    },
  };
  const contactsRepo: ContactsRepo = {
    findByPhone: async () => {
      if (overrides.findByPhoneError !== undefined) throw overrides.findByPhoneError;
      return contact;
    },
    getById: async (id) => (contact?.contactId === id ? contact : undefined),
    getDisplayById: async (id) => (contact?.contactId === id ? contact : undefined),
    getDisplaysByIds: async (ids) => new Map(
      contact !== undefined && ids.includes(contact.contactId) ? [[contact.contactId, contact]] : [],
    ),
    getManyByIds: async (ids) => new Map(
      contact !== undefined && ids.includes(contact.contactId) ? [[contact.contactId, contact]] : [],
    ),
    listByType: async () => ({ items: [] }),
    listByHousingAuthority: async () => ({ items: [] }),
    create: async (input) => ({ ...input, contactId: input.contactId ?? 'contact-sm-1' }),
    createIfAbsent: async () => true,
    setFlag: async () => {},
    clearFlag: async () => {},
    softDelete: async () => contact!,
    restore: async () => contact!,
    update: async () => contact!,
    addPhone: async () => contact!,
    setPhone: async () => contact!,
    removePhone: async () => contact!,
    touchPhoneLastSeen: async () => {},
    findByEmail: async () => undefined,
    addEmail: async () => contact!,
    setPrimaryEmail: async () => contact!,
    removeEmail: async () => contact!,
    touchEmailLastSeen: async () => {},
    stampGroupParticipation: async () => {
      throw new Error('stampGroupParticipation: not used in this suite');
    },
    rewriteOrgFields: async () => {
      throw new Error('rewriteOrgFields: not used in this suite');
    },
    getRecipientDisplaysByIds: async () => {
      throw new Error('getRecipientDisplaysByIds: not used in this suite');
    },
    findAllByPhone: async () => {
      throw new Error('findAllByPhone: not used in this suite');
    },
    findAllByEmail: async () => {
      throw new Error('findAllByEmail: not used in this suite');
    },
  };
  const messagesRepo: MessagesRepo = {
    append: async (message) => {
      if (overrides.appendError !== undefined) throw overrides.appendError;
      fakes.appended.push(message);
      return {
        deduped: false,
        tsMsgId: buildTsMsgId(message.providerTs, message.providerSid),
        conversationId: message.conversationId,
      };
    },
    getByProviderSid: async () => undefined,
    getByProviderSidConsistent: async () => undefined,
    getByRfcMessageId: async () => undefined,
    recordProviderSidAlias: async () => {},
    updateDeliveryStatus: async () => true,
    updateCallStatus: async () => ({ transitioned: true, row: undefined }),
    setCallRecording: async () => true,
    releaseCallRecording: async () => {},
    setCallTranscript: async () => true,
    setTranscriptPending: async () => false,
    setTranscriptFailed: async () => false,
    upgradeCallOutcomeToVoicemail: async () => false,
    listByConversation: async () => [],
    listByConversationConsistent: async () => [],
    getByTsMsgId: async () => undefined,
    getByTsMsgIdConsistent: async () => undefined,
    getManyByTsMsgIds: async () => new Map(),
    annotateMessage: async () => {},
    // retry-send-adoption (R3, R7) - unused by the send service:
    listRetryChildrenConsistent: async () => [],
    annotateRetryPromise: async () => true,
    // share-sent-outcome D8 - the repair's write; unused by the send service.
    stampRetryAttribution: async () => true,
    putMediaPointers: async () => {},
    listMediaPointers: async () => [],
    putJobExecutionMarker: async () => true,
    getJobExecutionMarker: async () => false,
    // Email orphan-event parking lot (B5) - unused by the SMS send service:
    putParkedEmailEvent: async () => {},
    listParkedEmailEvents: async () => [],
    deleteParkedEmailEvent: async () => {},
    // Relay groups (M1.7) — unused by the send service:
    setMessageActualTransport: async () => 'missing',
    initializeRecipientDelivery: async () => 'missing',
    setRecipientTransportAggregationState: async () => 'missing',
    setRecipientActualTransport: async () => 'missing',
    applyRecipientSendResult: async () => 'missing',
    claimFanoutPass: async () => {
      throw new Error('claimFanoutPass: not used in this suite');
    },
    setRecipientDelivery: async () => {},
    updateRecipientDeliveryStatus: async () => true,
    // SOR Task 6 relay additions - unused by the 1:1 send service:
    closeRelayRecipientIfUnsent: async () => 'missing',
    adoptRelayRecipientIfUnsent: async () => 'missing',
    setRelayRecipientAttemptedAt: async () => {},
    putRelaySidPointer: async () => {},
    claimRelaySidPointer: async () => {
      throw new Error('claimRelaySidPointer: not used in this suite');
    },
    getRelaySidPointer: async () => undefined,
    getRelaySidPointerConsistent: async () => undefined,
    putSystemSidMarker: async () => {},
    getSystemSidMarker: async () => undefined,
    getSystemSidMarkerConsistent: async () => undefined,
    // Group-texting deadline partition (S5) - unreachable from this 1:1 suite.
    listDueRows: async () => [],
    deleteDueRow: async () => {},
    setRecipientDeliverySid: async () => false,
    parkGroupReceipt: async () => true,
    listParkedGroupReceipts: async () => [],
    deleteParkedGroupReceipt: async () => {},
    claimCrossCheckClassic: async () => {
      throw new Error('claimCrossCheckClassic: not used in this suite');
    },
    claimCrossCheckEvent: async () => {
      throw new Error('claimCrossCheckEvent: not used in this suite');
    },
    recordCrossCheckEvent: async () => {
      throw new Error('recordCrossCheckEvent: not used in this suite');
    },
    bumpCrossCheckClassic: async () => {
      throw new Error('bumpCrossCheckClassic: not used in this suite');
    },
    releaseCrossCheckPending: async () => {
      throw new Error('releaseCrossCheckPending: not used in this suite');
    },
    claimOldestCrossCheckPending: async () => {
      throw new Error('claimOldestCrossCheckPending: not used in this suite');
    },
    resolveCrossCheckPending: async () => {
      throw new Error('resolveCrossCheckPending: not used in this suite');
    },
    recordCrossCheckClassicReceipt: async () => {
      throw new Error('recordCrossCheckClassicReceipt: not used in this suite');
    },
    claimCrossCheckClassicInWindow: async () => {
      throw new Error('claimCrossCheckClassicInWindow: not used in this suite');
    },
  };
  const auditRepo: AuditRepo = {
    append: async (entityKey, eventType, payload) => {
      if (overrides.auditError !== undefined) throw overrides.auditError;
      fakes.auditEvents.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
    },
    listByEntity: async () => [],
  };
  const adapter: MessagingAdapter & CarrierMessageSender = {
    classifyMessageTransport(facts) {
      if (overrides.classifyError !== undefined) throw overrides.classifyError;
      fakes.classified.push(facts);
      return Object.freeze({
        requestedTransport: facts.hasForwardableMedia ? 'mms' : 'sms',
      });
    },
    prepareMessageSend(intent, params) {
      const prepared = Object.freeze({ requestedTransport: intent.requestedTransport, params });
      fakes.prepared.push(prepared);
      return prepared;
    },
    async sendPreparedMessage(prepared) {
      if (overrides.sendError !== undefined) throw overrides.sendError;
      fakes.sent.push(prepared.params);
      const actualTransport =
        overrides.actualTransport === undefined
          ? prepared.requestedTransport
          : overrides.actualTransport;
      return {
        providerSid: `SMfake-${fakes.sent.length}`,
        status: 'queued',
        providerTs: '2026-06-12T10:00:00.000Z',
        ...(actualTransport !== null && { actualTransport }),
      };
    },
    sendMessage: async (params) => {
      fakes.sent.push(params);
      return { providerSid: `SMfake-${fakes.sent.length}`, status: 'queued', providerTs: '2026-06-12T10:00:00.000Z' };
    },
    getMediaStream: async () => {
      throw new Error('not used');
    },
    getMediaContentType: async () => undefined,
    getRecordingStream: async () => {
      throw new Error('not used');
    },
    provisionPhoneNumber: async () => ({
      phoneNumber: '+15550109000',
      capabilities: { sms: true, voice: true },
      sid: 'PNfake-sm',
    }),
    setVoiceWebhook: async () => {},
    releasePhoneNumber: async () => {},
    attachToMessagingService: async () => {},
    detachFromMessagingService: async () => {},
    initiateCall: async () => ({ callSid: 'CAfake-sm' }),
    createViTranscript: async () => {
      throw new Error('not used');
    },
    fetchViTranscript: async () => {
      throw new Error('not used');
    },
    listViSentences: async () => {
      throw new Error('not used');
    },
    listMessages: async () => ({ messages: [] }),
    getMessage: async () => undefined,
  };

  const events = createEventBus();
  events.on('conversation.updated', (payload) => fakes.emitted.push({ event: 'conversation.updated', payload }));
  events.on('message.persisted', (payload) => fakes.emitted.push({ event: 'message.persisted', payload }));

  const capture = createLogCapture();
  const service = createSendMessageService({
    config: loadConfig({ NODE_ENV: 'test', SEND_BREAKER_MAX_PER_MINUTE: '3', ...overrides.env }),
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
      transportSchemaVersion: 1,
      requestedTransport: 'sms',
      actualTransport: 'sms',
    });
    expect(f.classified).toEqual([{ hasForwardableMedia: false }]);
    expect(f.prepared).toHaveLength(1);
    expect(f.touched).toEqual([{ previewText: 'hello there', ts: '2026-06-12T10:00:00.000Z' }]);
    expect(outcome).toEqual({
      conversationId: 'conv-1',
      providerSid: 'SMfake-1',
      tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
      status: 'queued',
    });
  });

  it('A2P kill-switch: smsSendingEnabled=false refuses BEFORE the adapter (no real send pre-A2P)', async () => {
    const f = makeFakes({ env: { SMS_SENDING_ENABLED: 'false' } });
    const err = await f.service({ conversationId: 'conv-1', body: 'hello' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendingDisabledError);
    expect(err).toBeInstanceOf(SendRefusedError); // routes map it (→ 503)
    expect((err as SmsSendingDisabledError).code).toBe('sms_sending_disabled');
    // The adapter was NEVER called and nothing was persisted.
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('marks sends with media as mms', async () => {
    const f = makeFakes();
    await f.service({ conversationId: 'conv-1', mediaUrls: ['https://m/1'] });
    expect(f.appended[0]).toMatchObject({
      type: 'mms',
      mediaUrls: ['https://m/1'],
      transportSchemaVersion: 1,
      requestedTransport: 'mms',
      actualTransport: 'mms',
    });
    expect(f.classified).toEqual([{ hasForwardableMedia: true }]);
  });

  it('keeps requested transport when the provider result has no actual evidence', async () => {
    const f = makeFakes({ actualTransport: null });
    await f.service({ conversationId: 'conv-1', body: 'pending evidence' });

    expect(f.appended[0]).toMatchObject({
      transportSchemaVersion: 1,
      requestedTransport: 'sms',
    });
    expect(f.appended[0]).not.toHaveProperty('actualTransport');
  });

  it('does not append a provisional row when the prepared provider send fails', async () => {
    const f = makeFakes({ sendError: new Error('provider unavailable') });

    await expect(
      f.service({ conversationId: 'conv-1', body: 'not accepted' }),
    ).rejects.toThrow('provider unavailable');
    expect(f.classified).toEqual([{ hasForwardableMedia: false }]);
    expect(f.prepared).toHaveLength(1);
    expect(f.appended).toHaveLength(0);
  });

  it('classifies broadcast and retry attempts independently without copying prior actual evidence', async () => {
    const f = makeFakes({ actualTransport: 'sms' });
    await f.service({
      conversationId: 'conv-1',
      body: 'retry body',
      broadcastId: 'broadcast-1',
      retryOf: 'prior-message',
    });

    expect(f.classified).toEqual([{ hasForwardableMedia: false }]);
    expect(f.appended[0]).toMatchObject({
      broadcastId: 'broadcast-1',
      retryOf: 'prior-message',
      transportSchemaVersion: 1,
      requestedTransport: 'sms',
      actualTransport: 'sms',
    });
  });

  it('outbound MMS: persists media_attachments (durable s3Keys) alongside the presigned mediaUrls', async () => {
    const f = makeFakes();
    await f.service({
      conversationId: 'conv-1',
      body: 'here is the flyer',
      mediaUrls: ['https://s3.local/uploads/abc?X-Amz-Signature=deadbeef'],
      attachments: [{ s3Key: 'uploads/abc', contentType: 'image/png' }],
    });
    // media_attachments carries the DURABLE key+type (renders via authed serve);
    // mediaUrls carries the presigned (expiring) fetch URL (historical record).
    expect(f.appended[0]).toMatchObject({
      type: 'mms',
      mediaAttachments: [{ s3Key: 'uploads/abc', contentType: 'image/png' }],
      mediaUrls: ['https://s3.local/uploads/abc?X-Amz-Signature=deadbeef'],
    });
  });

  it('never logs presigned mediaUrls (bearer tokens) on the send path (spec S12)', async () => {
    const f = makeFakes();
    const presigned = 'https://s3.local/uploads/abc?X-Amz-Signature=SECRETSIGNATURE&X-Amz-Expires=3600';
    await f.service({
      conversationId: 'conv-1',
      body: 'flyer',
      mediaUrls: [presigned],
      attachments: [{ s3Key: 'uploads/abc', contentType: 'image/png' }],
    });
    // Flatten every captured log line to text and assert no presigned material
    // (the full URL or its signature query) ever appears.
    const logText = JSON.stringify(f.capture.lines);
    expect(logText).not.toContain('X-Amz-Signature');
    expect(logText).not.toContain('SECRETSIGNATURE');
    expect(logText).not.toContain(presigned);
    // Sanity: the send WAS logged (so the assertion is meaningful, not vacuous).
    expect(f.capture.lines.some((l) => l['msg'] === 'outbound message sent')).toBe(true);
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

  it('refuses a native group_text with its OWN error, never the relay one', async () => {
    // Before the explicit case a group thread fell through to the no-phone check
    // and threw the RELAY error - a misleading message from an accidental path,
    // pointing whoever read it at relay code that is not involved.
    const f = makeFakes({
      conversation: { type: 'group_text', status: 'group_open', participant_phone: undefined },
    });
    const err = await f.service({ conversationId: 'conv-1', body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupTextSendNotSupportedError);
    expect(err).not.toBeInstanceOf(RelaySendNotSupportedError);
    expect((err as GroupTextSendNotSupportedError).code).toBe('group_text_not_supported');
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

  describe('JIT consent gate (A2P/CTIA — proactive human 1:1 send)', () => {
    it('BLOCKS a HUMAN proactive send to a contact with NO consent (nothing sent/persisted)', async () => {
      const f = makeFakes({
        contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001' }, // no consent_method
      });
      await expect(f.service({ conversationId: 'conv-1', body: 'x', automated: false })).rejects.toBeInstanceOf(
        ContactNoConsentError,
      );
      expect(f.sent).toHaveLength(0);
      expect(f.appended).toHaveLength(0);
      expect(f.emitted).toHaveLength(0);
    });

    // group-texting A8, consumer 1 of 6 (sendMessage.ts JIT gate - the one the
    // spec's list omits). A SILENT group member carries group_participation_at
    // and NO consent_method, so the proactive 1:1 gate must still refuse them.
    it('BLOCKS a proactive send to a SILENT GROUP MEMBER (group_participation_at is not consent)', async () => {
      const f = makeFakes({
        contact: {
          contactId: 'contact-1',
          type: 'tenant',
          phone: '+15550100001',
          group_participation_at: '2026-08-10T12:00:00.000Z',
        },
      });
      await expect(
        f.service({ conversationId: 'conv-1', body: 'x', automated: false }),
      ).rejects.toBeInstanceOf(ContactNoConsentError);
      expect(f.sent).toHaveLength(0);
    });

    it('ALLOWS a human send once a GENUINE basis lands beside the group one (no masking)', async () => {
      const f = makeFakes({
        contact: {
          contactId: 'contact-1',
          type: 'tenant',
          phone: '+15550100001',
          group_participation_at: '2026-08-10T12:00:00.000Z',
          consent_method: 'inbound_text',
        },
      });
      await expect(
        f.service({ conversationId: 'conv-1', body: 'x', automated: false }),
      ).resolves.toMatchObject({ providerSid: 'SMfake-1' });
    });

    it('ALLOWS a human send when the contact HAS consent (inbound_text)', async () => {
      const f = makeFakes({
        contact: {
          contactId: 'contact-1',
          type: 'tenant',
          phone: '+15550100001',
          consent_method: 'inbound_text',
        },
      });
      await expect(f.service({ conversationId: 'conv-1', body: 'x', automated: false })).resolves.toMatchObject({
        providerSid: 'SMfake-1',
      });
    });

    it('does NOT gate an AUTOMATED send to a no-consent contact (welcome/missed-call/reminders)', async () => {
      const f = makeFakes({
        contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001' }, // no consent
      });
      await expect(f.service({ conversationId: 'conv-1', body: 'x', automated: true })).resolves.toMatchObject({
        providerSid: 'SMfake-1',
      });
    });

    it('opt-out gate still beats the consent gate (a no-consent + opted-out contact is ContactOptedOutError)', async () => {
      const f = makeFakes({
        contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true },
      });
      await expect(f.service({ conversationId: 'conv-1', body: 'x', automated: false })).rejects.toBeInstanceOf(
        ContactOptedOutError,
      );
    });

    it('share-skip-fix I8: a `recipient` item makes the consent + deleted gates judge THAT contact, not the phone-matched one', async () => {
      // The phone lookup finds a NO-consent duplicate; the caller resolved the
      // real recipient separately and hands it over.
      const f = makeFakes({
        contact: { contactId: 'c-dup', type: 'tenant', phone: '+15550100001' }, // no consent_method
      });
      const real: ContactItem = { contactId: 'c-real', type: 'tenant', phone: '+15550100001', consent_method: 'verbal_in_person' };
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false }),
      ).rejects.toBeInstanceOf(ContactNoConsentError);
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: real }),
      ).resolves.toMatchObject({ providerSid: 'SMfake-1' });
      // A deleted RECIPIENT is refused even when the phone-matched contact is live and consenting.
      const g = makeFakes();
      const gone: ContactItem = { ...real, contactId: 'c-gone', deleted_at: '2026-09-01T00:00:00.000Z' };
      await expect(
        g.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: gone }),
      ).rejects.toBeInstanceOf(ContactDeletedError);
      // The recipient's own opt-out refuses too (either contact's flag wins).
      const h = makeFakes();
      await expect(
        h.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: { ...real, sms_opt_out: true } }),
      ).rejects.toBeInstanceOf(ContactOptedOutError);
    });

    it('share-skip-fix I8: an OPTED-OUT phone-matched contact refuses even when the resolved recipient is clean (Do Not Contact)', async () => {
      // Staff Do Not Contact sets only the phone-matched contact's flag; the
      // caller hands over a different, clean recipient on the same phone. The
      // opt-out gate reads the phone lookup's flag, never only the recipient's.
      const f = makeFakes({
        contact: { contactId: 'c-dnc', type: 'tenant', phone: '+15550100001', consent_method: 'inbound_text', sms_opt_out: true },
      });
      const real: ContactItem = { contactId: 'c-real', type: 'tenant', phone: '+15550100001', consent_method: 'verbal_in_person' };
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: real }),
      ).rejects.toBeInstanceOf(ContactOptedOutError);
      expect(f.sent).toHaveLength(0);
      expect(f.appended).toHaveLength(0);
    });

    it('share-skip-fix I8: a DELETED phone-matched contact does not block a live recipient on the same phone', async () => {
      // The deleted and consent gates judge `recipient ?? phoneContact`, so a
      // soft-deleted duplicate the phone lookup finds first must not refuse the
      // live, consenting recipient the caller resolved.
      const f = makeFakes({
        contact: {
          contactId: 'c-gone',
          type: 'tenant',
          phone: '+15550100001',
          consent_method: 'inbound_text',
          deleted_at: '2026-09-01T00:00:00.000Z',
        },
      });
      const real: ContactItem = { contactId: 'c-real', type: 'tenant', phone: '+15550100001', consent_method: 'verbal_in_person' };
      // Control: with no recipient the phone-matched contact IS judged, and refused.
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false }),
      ).rejects.toBeInstanceOf(ContactDeletedError);
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: real }),
      ).resolves.toMatchObject({ providerSid: 'SMfake-1' });
      expect(f.sent).toHaveLength(1);
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
          // resolved name ride along on every conversation.updated.
          type: 'tenant_1to1',
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

// ---------------------------------------------------------------------------
// Sender pinning (one-to-one-sender-not-pinned-to-ported-number, 2026-08-06).
// The Messaging Service's sender pool holds the main business number AND every
// relay pool number, so leaving `from` off let Twilio pick — a tenant could get
// a 1:1 text from a relay number they have never seen. The service now pins the
// business number (BUSINESS_PHONE_NUMBER) on every unpinned send.
// ---------------------------------------------------------------------------
describe('outbound sender pinning (1:1)', () => {
  const MAIN = '+15550009999';

  it('pins `from` to the business number (BUSINESS_PHONE_NUMBER) on a 1:1 send', async () => {
    const f = makeFakes({ env: { BUSINESS_PHONE_NUMBER: MAIN } });
    await f.service({ conversationId: 'conv-1', body: 'hello there' });
    expect(f.sent).toEqual([{ to: '+15550100001', body: 'hello there', from: MAIN }]);
  });

  it('an explicit `from` (the relay pool number) WINS over the configured default', async () => {
    const f = makeFakes({ env: { BUSINESS_PHONE_NUMBER: MAIN } });
    await f.service({ conversationId: 'conv-1', body: 'relayed', from: '+15550109001' });
    expect(f.sent[0]!.from).toBe('+15550109001');
  });

  it('omits `from` when BUSINESS_PHONE_NUMBER is empty — degrades to the service picking, never throws', async () => {
    const f = makeFakes({ env: { BUSINESS_PHONE_NUMBER: '' } });
    await expect(f.service({ conversationId: 'conv-1', body: 'hello' })).resolves.toMatchObject({
      providerSid: 'SMfake-1',
    });
    expect(f.sent).toEqual([{ to: '+15550100001', body: 'hello' }]);
  });

  // retry-send-adoption R1: the ONE derivation of the pinned sender. The
  // retry job's attempt facts read the same function, so a record's `sender`
  // is the number this service pins.
  it('pinnedSender: an explicit from wins, else the business number, else undefined', () => {
    expect(pinnedSender({ businessPhoneNumber: MAIN }, '+15550109001')).toBe('+15550109001');
    expect(pinnedSender({ businessPhoneNumber: MAIN })).toBe(MAIN);
    expect(pinnedSender({ businessPhoneNumber: MAIN }, undefined)).toBe(MAIN);
    expect(pinnedSender({ businessPhoneNumber: undefined })).toBeUndefined();
    expect(pinnedSender({})).toBeUndefined();
  });
});

describe('deleted-contact send guard (2026-08-03 spec)', () => {
  it('refuses sends to soft-deleted contacts with a typed error (nothing sent, nothing persisted)', async () => {
    const f = makeFakes({
      contact: {
        contactId: 'contact-1',
        type: 'tenant',
        phone: '+15550100001',
        consent_method: 'inbound_text',
        deleted_at: '2026-08-01T00:00:00.000Z',
      },
    });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactDeletedError,
    );
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('also refuses AUTOMATED sends to soft-deleted contacts (no straggler scheduled nudges)', async () => {
    const f = makeFakes({
      contact: {
        contactId: 'contact-1',
        type: 'tenant',
        phone: '+15550100001',
        consent_method: 'inbound_text',
        deleted_at: '2026-08-01T00:00:00.000Z',
      },
    });
    await expect(
      f.service({ conversationId: 'conv-1', body: 'x', automated: true }),
    ).rejects.toBeInstanceOf(ContactDeletedError);
    expect(f.sent).toHaveLength(0);
  });

  it('the opt-out gate still fires first on a contact that is BOTH opted out and deleted', async () => {
    const f = makeFakes({
      contact: {
        contactId: 'contact-1',
        type: 'tenant',
        phone: '+15550100001',
        sms_opt_out: true,
        deleted_at: '2026-08-01T00:00:00.000Z',
      },
    });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).rejects.toBeInstanceOf(
      ContactOptedOutError,
    );
  });
});

// ---------------------------------------------------------------------------
// retry-send-window D3a: PARITY between previewSendRefusal and the real send
// wrapper. ONE table (helpers/sendRefusalCases.ts) drives both: every row runs
// through the pure preview AND through createSendMessageService with this
// file's fakes, and the refusal code must match (undefined = the send went
// out). A gate reordered in or removed from sendMessage turns a row red; a NEW
// gate turns nothing red until a row exercises it - add its row with the gate.
// The same table drives the retry decision's own test
// (test/oneToOneRetryDecision.test.ts), so the decision cannot drift either.
// ---------------------------------------------------------------------------
describe('previewSendRefusal parity with the send wrapper (retry-send-window D3a)', () => {
  it.each(SEND_REFUSAL_CASES)('$name', async (c) => {
    const preview = previewSendRefusal({
      smsSendingEnabled: c.smsSendingEnabled,
      conversation: c.conversation,
      phoneContact: c.phoneContact,
      recipient: c.recipient,
      participantPhone: SEND_REFUSAL_PHONE,
      automated: c.automated,
    });

    const f = makeFakes({
      conversation: c.conversation,
      contact: c.phoneContact ?? null,
      env: { SMS_SENDING_ENABLED: c.smsSendingEnabled ? 'true' : 'false' },
    });
    let thrown: SendRefusedError['code'] | undefined;
    try {
      await f.service({
        conversationId: 'conv-1',
        body: 'parity',
        automated: c.automated,
        recipient: c.recipient,
      });
    } catch (err) {
      if (!(err instanceof SendRefusedError)) throw err;
      thrown = err.code;
    }

    // Compile-time half: every preview code IS a code the wrapper throws.
    const previewAsSendCode: SendRefusedError['code'] | undefined = preview;
    expect(previewAsSendCode).toBe(thrown);
    expect(preview).toBe(c.expected);
    // A refused row never reached the provider; a sent row did, exactly once.
    expect(f.sent).toHaveLength(c.expected === undefined ? 1 : 0);
  });
});

// ---------------------------------------------------------------------------
// retry-send-window D6 + D14 (spec test intention 6a): what the wrapper writes
// at append so a retry can follow the original send. `automated` goes on EVERY
// row (the default false included), the caller's recipient by id only when one
// was named, and the automatic retry's lineage - attempt and window origin - at
// append rather than annotated afterwards.
// ---------------------------------------------------------------------------
describe('append-time retry lineage and the send flags (retry-send-window D6, D14)', () => {
  it('records automated on EVERY append: the default false, an explicit false and true', async () => {
    const f = makeFakes();
    await f.service({ conversationId: 'conv-1', body: 'default' });
    await f.service({ conversationId: 'conv-1', body: 'person', automated: false });
    await f.service({ conversationId: 'conv-1', body: 'machine', automated: true });
    // toHaveProperty WITH the value: an ABSENT flag must fail here, because a
    // row without it is retried as automated (D14's pre-deploy default).
    expect(f.appended[0]).toHaveProperty('automated', false);
    expect(f.appended[1]).toHaveProperty('automated', false);
    expect(f.appended[2]).toHaveProperty('automated', true);
  });

  it('records recipientContactId ONLY when the caller named a recipient', async () => {
    const f = makeFakes();
    const real: ContactItem = {
      contactId: 'c-real',
      type: 'tenant',
      phone: '+15550100001',
      consent_method: 'verbal_in_person',
    };
    await f.service({ conversationId: 'conv-1', body: 'fenced', automated: false, recipient: real });
    await f.service({ conversationId: 'conv-1', body: 'by phone' });
    expect(f.appended[0]).toHaveProperty('recipientContactId', 'c-real');
    expect(f.appended[1]).not.toHaveProperty('recipientContactId');
  });

  it('ignores a named recipient that no longer holds the thread number: judges the phone-matched contact, records none, WARNs (retry-send-window planner review)', async () => {
    // A retry replays the recipient recorded at the original send; that contact
    // may have moved off this number since. The text still goes to the
    // thread's number, so consent is judged on whoever holds it now.
    const holderWithoutConsent: ContactItem = {
      contactId: 'c-holder',
      type: 'tenant',
      phone: '+15550100001',
    };
    const moved: ContactItem = {
      contactId: 'c-moved',
      type: 'tenant',
      phone: '+15550100099',
      consent_method: 'verbal_in_person',
    };
    const refused = makeFakes({ contact: holderWithoutConsent });
    await expect(
      refused.service({ conversationId: 'conv-1', body: 'retry', automated: false, recipient: moved }),
    ).rejects.toMatchObject({ code: 'contact_no_consent' });
    expect(refused.sent).toHaveLength(0);
    expect(
      refused.capture.lines.some(
        (l) =>
          l['recipientContactId'] === 'c-moved' &&
          String(l['msg']).includes('no longer holds this thread number'),
      ),
    ).toBe(true);

    const sent = makeFakes();
    await sent.service({ conversationId: 'conv-1', body: 'retry', automated: false, recipient: moved });
    expect(sent.sent).toHaveLength(1);
    expect(sent.appended[0]).not.toHaveProperty('recipientContactId');
  });

  it('passes retryOf, retryAttempt, retryWindowStart and retryRoot into the append, and none of them on a normal send', async () => {
    const f = makeFakes();
    await f.service({
      conversationId: 'conv-1',
      body: 'retry body',
      automated: true,
      retryOf: '2026-06-12T09:58:00.000Z#SMorig',
      retryAttempt: 2,
      retryWindowStart: '2026-06-12T09:58:00.000Z',
      retryRoot: '2026-06-12T09:58:00.000Z#SMroot',
    });
    await f.service({ conversationId: 'conv-1', body: 'normal' });
    expect(f.appended[0]).toMatchObject({
      retryOf: '2026-06-12T09:58:00.000Z#SMorig',
      retryAttempt: 2,
      retryWindowStart: '2026-06-12T09:58:00.000Z',
      retryRoot: '2026-06-12T09:58:00.000Z#SMroot',
      automated: true,
    });
    for (const field of ['retryOf', 'retryAttempt', 'retryWindowStart', 'retryRoot']) {
      expect(f.appended[1]).not.toHaveProperty(field);
    }
  });

  it('the manual Retry shape (retryOf alone, a person send) carries no attempt and no window origin (D2)', async () => {
    const f = makeFakes();
    await f.service({
      conversationId: 'conv-1',
      body: 'again',
      automated: false,
      retryOf: '2026-06-12T09:58:00.000Z#SMorig',
    });
    expect(f.appended[0]).toMatchObject({ retryOf: '2026-06-12T09:58:00.000Z#SMorig', automated: false });
    expect(f.appended[0]).not.toHaveProperty('retryAttempt');
    expect(f.appended[0]).not.toHaveProperty('retryWindowStart');
  });
});

// ---------------------------------------------------------------------------
// SOR spec D3: the send's NON-refusal failures are typed by WHERE they
// happened, so an adopter can tell "nothing was sent" from "may have been
// sent" from "sent but not recorded". A refusal is never wrapped, and a
// failure after the row is written no longer fails the send.
// ---------------------------------------------------------------------------
describe('typed send errors (spec D3)', () => {
  const base = { conversationId: 'conv-1', body: 'Hey there' };
  const MAIN = '+15550009999';

  it('a DB failure before the provider call is SendNotAttemptedError and sends nothing', async () => {
    const cause = new Error('dynamo down');
    const f = makeFakes({ findByPhoneError: cause });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendNotAttemptedError);
    expect(err).not.toBeInstanceOf(SendRefusedError);
    expect((err as SendNotAttemptedError).cause).toBe(cause);
    expect((err as SendNotAttemptedError).message).toContain('contact read');
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('every other pre-provider step is wrapped the same way: the conversation read, the breaker increment, its trip write, the transport classification', async () => {
    const cases: Array<{ name: string; make: () => Fakes; automated: boolean; step: string }> = [
      { name: 'conversation read', make: () => makeFakes({ getByIdError: new Error('x') }), automated: false, step: 'conversation read' },
      { name: 'breaker increment', make: () => makeFakes({ incrementError: new Error('x') }), automated: true, step: 'breaker' },
      {
        name: 'breaker trip write',
        make: () => {
          const f = makeFakes({ setModeError: new Error('x') });
          f.counterValue = 3; // the next increment is over the cap of 3: the trip branch runs
          return f;
        },
        automated: true,
        step: 'breaker',
      },
      { name: 'transport classification', make: () => makeFakes({ classifyError: new Error('x') }), automated: false, step: 'transport' },
    ];
    for (const c of cases) {
      const f = c.make();
      const err = await f.service({ ...base, automated: c.automated }).catch((e: unknown) => e);
      expect(err, c.name).toBeInstanceOf(SendNotAttemptedError);
      expect((err as Error).message, c.name).toContain(c.step);
      expect(f.sent, c.name).toHaveLength(0);
    }
  });

  it('a refusal is NEVER wrapped', async () => {
    const f = makeFakes({
      contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true },
    });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactOptedOutError);
    expect(err).not.toBeInstanceOf(SendNotAttemptedError);
  });

  it('a refusal thrown INSIDE a wrapped step, or by the provider call, passes through unwrapped', async () => {
    const inStep = makeFakes({ findByPhoneError: new ContactOptedOutError('conv-1') });
    const a = await inStep.service(base).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(ContactOptedOutError);
    expect(a).not.toBeInstanceOf(SendNotAttemptedError);
    const atProvider = makeFakes({ sendError: new SmsSendingDisabledError() });
    const b = await atProvider.service(base).catch((e: unknown) => e);
    expect(b).toBeInstanceOf(SmsSendingDisabledError);
    expect(b).not.toBeInstanceOf(ProviderSendFailedError);
  });

  it('a provider throw becomes ProviderSendFailedError carrying the classification, the cause message, the facts, and the cause code/status as own properties', async () => {
    const cause = Object.assign(new Error('provider unavailable'), { status: 503, code: 20500 });
    const f = makeFakes({ env: { BUSINESS_PHONE_NUMBER: MAIN }, sendError: cause });
    const before = Date.now();
    const err = await f.service(base).catch((e: unknown) => e);
    const after = Date.now();
    expect(err).toBeInstanceOf(ProviderSendFailedError);
    expect(err).not.toBeInstanceOf(SendRefusedError);
    const typed = err as ProviderSendFailedError;
    expect(typed.message).toContain('provider unavailable');
    expect(typed.cause).toBe(cause);
    expect(typed.classification).toEqual({ kind: 'unknown', code: '20500', status: 503 });
    expect(typed.code).toBe(20500);
    expect(typed.status).toBe(503);
    expect(Object.prototype.hasOwnProperty.call(typed, 'code')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(typed, 'status')).toBe(true);
    expect(typed.facts).toEqual({
      recipientDigest: recipientDigest(MAIN, '+15550100001'),
      sender: MAIN,
      bodyHash: bodyFingerprint('Hey there').hash,
      bodyShort: false,
      mediaCount: 0,
    });
    const at = Date.parse(typed.attemptedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(f.appended).toHaveLength(0);
  });

  it('the facts follow the send: no business number means no sender, an explicit from wins, media is counted and a media-only body is short', async () => {
    const unpinned = makeFakes({ sendError: Object.assign(new Error('boom'), { code: 'ECONNRESET' }) });
    const a = (await unpinned.service(base).catch((e: unknown) => e)) as ProviderSendFailedError;
    expect(a).toBeInstanceOf(ProviderSendFailedError);
    expect(a.facts).not.toHaveProperty('sender');
    expect(a.facts.recipientDigest).toBe(recipientDigest(undefined, '+15550100001'));
    expect(a.classification).toEqual({ kind: 'unknown', code: 'ECONNRESET' });
    expect(a.code).toBe('ECONNRESET');
    expect(a.status).toBeUndefined();

    const pinned = makeFakes({ env: { BUSINESS_PHONE_NUMBER: MAIN }, sendError: new Error('boom') });
    const b = (await pinned.service({ ...base, from: '+15550109001' }).catch((e: unknown) => e)) as ProviderSendFailedError;
    expect(b.facts.sender).toBe('+15550109001');
    expect(b.facts.recipientDigest).toBe(recipientDigest('+15550109001', '+15550100001'));
    expect(b.classification).toEqual({ kind: 'unknown' });
    expect(b.code).toBeUndefined();

    const media = makeFakes({ sendError: new Error('boom') });
    const c = (await media
      .service({ conversationId: 'conv-1', mediaUrls: ['https://m/1', 'https://m/2'] })
      .catch((e: unknown) => e)) as ProviderSendFailedError;
    expect(c.facts.mediaCount).toBe(2);
    expect(c.facts.bodyShort).toBe(true);
    expect(c.facts.bodyHash).toBe(bodyFingerprint(undefined).hash);
  });

  it('the adapter kill switch is classified, not refused: rejected with sms_sending_disabled', async () => {
    const f = makeFakes({ sendError: new AdapterSmsSendingDisabledError('SMS sending is disabled') });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSendFailedError);
    expect((err as ProviderSendFailedError).classification).toEqual({ kind: 'rejected', code: 'sms_sending_disabled' });
  });

  it('an append failure after acceptance is SendAcceptedNotRecordedError with the SID', async () => {
    const cause = new Error('TransactionInProgressException');
    const f = makeFakes({ env: { BUSINESS_PHONE_NUMBER: MAIN }, appendError: cause });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendAcceptedNotRecordedError);
    expect(err).not.toBeInstanceOf(ProviderSendFailedError);
    const typed = err as SendAcceptedNotRecordedError;
    expect(typed.providerSid).toBe('SMfake-1');
    expect(typed.providerTs).toBe('2026-06-12T10:00:00.000Z');
    expect(typed.status).toBe('queued');
    expect(typed.cause).toBe(cause);
    expect(typed.message).toContain('SMfake-1');
    expect(typed.facts).toEqual({
      recipientDigest: recipientDigest(MAIN, '+15550100001'),
      sender: MAIN,
      bodyHash: bodyFingerprint('Hey there').hash,
      bodyShort: false,
      mediaCount: 0,
    });
    // The text WAS sent; nothing after the append ran.
    expect(f.sent).toHaveLength(1);
    expect(f.touched).toHaveLength(0);
    expect(f.emitted).toHaveLength(0);
  });

  it('a failure after the row is written does NOT throw: ERROR logged, conversation.updated skipped', async () => {
    const f = makeFakes({ touchError: new Error('touch down') });
    const outcome = await f.service(base);
    expect(outcome).toEqual({
      conversationId: 'conv-1',
      providerSid: 'SMfake-1',
      tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
      status: 'queued',
    });
    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted']);
    // The audit still ran: each post-append step is best-effort on its own.
    expect(f.auditEvents.map((e) => e.eventType)).toEqual(['message_sent']);
    const errors = f.capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('post-append step failed'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ conversationId: 'conv-1', providerSid: 'SMfake-1', step: 'touchLastActivity' });
  });

  it('an audit failure after the row is written does NOT throw either', async () => {
    const f = makeFakes({ auditError: new Error('audit down') });
    await expect(f.service(base)).resolves.toMatchObject({ conversationId: 'conv-1', providerSid: 'SMfake-1' });
    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted', 'conversation.updated']);
    const errors = f.capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('post-append step failed'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ step: 'audit' });
  });
});

// Code review ADV-1 (FW2-1): the caller's last word before the provider call.
// The broadcast fan-out re-arms its send-attempt claim here, so the claim TTL
// is measured from the moment the provider is called, not from the claim.
describe('the pre-send hook (code review ADV-1)', () => {
  const base = { conversationId: 'conv-1', body: 'Hey there' };

  it('runs after every pre-provider step and immediately before the provider call; true lets the send proceed', async () => {
    const f = makeFakes();
    const seen: string[] = [];
    const outcome = await f.service({
      ...base,
      beforeProviderSend: async () => {
        seen.push(`prepared=${f.prepared.length} sent=${f.sent.length}`);
        return true;
      },
    });
    expect(seen).toEqual(['prepared=1 sent=0']);
    expect(f.sent).toHaveLength(1);
    expect(outcome).toMatchObject({ conversationId: 'conv-1', providerSid: 'SMfake-1' });
  });

  it('answering false is SendNotAttemptedError("the attempt was taken over") with no cause: nothing sent, nothing appended', async () => {
    const f = makeFakes();
    const err = await f.service({ ...base, beforeProviderSend: async () => false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendNotAttemptedError);
    expect(err).not.toBeInstanceOf(SendRefusedError);
    expect((err as SendNotAttemptedError).message).toBe('send not attempted: the attempt was taken over');
    expect((err as SendNotAttemptedError).cause).toBeUndefined();
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
    expect(f.emitted).toHaveLength(0);
  });

  it('a hook that throws is SendNotAttemptedError carrying the cause: nothing sent', async () => {
    const cause = new Error('TransactionConflict');
    const f = makeFakes();
    const err = await f.service({
      ...base,
      beforeProviderSend: async () => {
        throw cause;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendNotAttemptedError);
    expect((err as SendNotAttemptedError).cause).toBe(cause);
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('a refused send never reaches the hook (every gate runs first)', async () => {
    const f = makeFakes({
      contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true },
    });
    let called = 0;
    const err = await f.service({
      ...base,
      beforeProviderSend: async () => {
        called += 1;
        return true;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactOptedOutError);
    expect(called).toBe(0);
  });
});
