import { describe, it, expect } from 'vitest';
import { evaluateScheduledSendSuppression, isKillSwitchOff, isOptedOut, isManualMode } from '../src/services/scheduledSendSuppression.js';
import type { MessagingAdapter, SendMessageParams } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';
import { createEventBus } from '../src/lib/events.js';
import type { AuditRepo } from '../src/repos/auditRepo.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessagesRepo, NewMessage } from '../src/repos/messagesRepo.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';
import {
  RelaySendNotSupportedError,
  createSendMessageService,
} from '../src/services/sendMessage.js';

describe('suppression predicates', () => {
  it('kill switch: only explicit false suppresses', () => {
    expect(isKillSwitchOff(false)).toBe(true);
    expect(isKillSwitchOff(true)).toBe(false);
    expect(isKillSwitchOff(undefined)).toBe(false); // absent ⇒ enabled (mirrors sendMessage === false)
  });
  it('opt-out: either flag suppresses', () => {
    expect(isOptedOut(true, false)).toBe(true);
    expect(isOptedOut(false, true)).toBe(true);
    expect(isOptedOut(false, false)).toBe(false);
    expect(isOptedOut(undefined, undefined)).toBe(false);
  });
  it('manual mode', () => {
    expect(isManualMode('manual')).toBe(true);
    expect(isManualMode('auto')).toBe(false);
    expect(isManualMode(undefined)).toBe(false);
  });
});

describe('evaluateScheduledSendSuppression precedence', () => {
  const base = { smsSendingEnabled: true, convOptOut: false, contactOptOut: false, aiMode: 'auto' as string | undefined };
  it('returns undefined when nothing suppresses', () => {
    expect(evaluateScheduledSendSuppression(base)).toBeUndefined();
  });
  it('kill switch wins first', () => {
    expect(evaluateScheduledSendSuppression({ ...base, smsSendingEnabled: false, convOptOut: true }))
      .toEqual({ reason: 'sms_sending_disabled' });
  });
  it('opt-out before manual', () => {
    expect(evaluateScheduledSendSuppression({ ...base, contactOptOut: true, aiMode: 'manual' }))
      .toEqual({ reason: 'contact_opted_out' });
  });
  it('manual mode', () => {
    expect(evaluateScheduledSendSuppression({ ...base, aiMode: 'manual' })).toEqual({ reason: 'manual_mode' });
  });
  it('stale stage (nudge)', () => {
    expect(evaluateScheduledSendSuppression({ ...base, staleStage: true })).toEqual({ reason: 'stale_stage' });
  });
});

// --- M1 regression: sendMessage gate ORDER is unchanged after predicate extraction.
// A trimmed clone of app/test/sendMessage.test.ts's in-memory fixture (repos/adapter
// are fakes: no DynamoDB, no network) — just enough to drive two ordering proofs.
function makeSendFakes(
  overrides: {
    conversation?: Partial<ConversationItem>;
    contact?: ContactItem | null;
    env?: Record<string, string>;
  } = {},
) {
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
          consent_method: 'inbound_text',
        });

  const sent: SendMessageParams[] = [];
  const appended: NewMessage[] = [];
  let counterValue = 0;

  const conversationsRepo: ConversationsRepo = {
    createOrGetByParticipantPhone: async () => conversation,
    getById: async (id) => (id === conversation.conversationId ? conversation : undefined),
    findByParticipantPhone: async () => [conversation],
    setType: async (_id, type) => {
      conversation.type = type;
      return conversation;
    },
    applyTriage: async () => conversation,
    touchLastActivity: async (_id, previewText, ts) => {
      conversation.last_activity_at = ts;
      if (previewText !== undefined) conversation.last_message_preview = previewText;
      return conversation;
    },
    setParticipantsIfAbsent: async () => true,
    incrementUnread: async () => 1,
    resetUnread: async () => conversation,
    listByLastActivity: async () => ({ items: [conversation] }),
    listRelayGroups: async () => ({ items: [], truncated: false }),
    setMode: async (_id, mode) => {
      conversation.ai_mode = mode;
    },
    setSmsOptOut: async (_id, value) => {
      conversation.sms_opt_out = value;
    },
    incrementAutomatedSendCount: async () => {
      counterValue += 1;
      return counterValue;
    },
    createRelayGroup: async () => conversation,
    getByPoolNumber: async () => undefined,
    getAllByPoolNumber: async () => [],
    setCloseNagNextAt: async () => {},
    claimCloseAnnounce: async () => false,
    addMember: async () => conversation,
    removeMember: async () => conversation,
    setRelayStatus: async () => conversation,
    setRelayMemberOptedOut: async () => {},
    clearRelayMemberOptedOut: async () => {},
    rebindOwner: async () => conversation,
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
    softDelete: async () => contact!,
    restore: async () => contact!,
    update: async () => contact!,
    addPhone: async () => contact!,
    setPhone: async () => contact!,
    removePhone: async () => contact!,
    touchPhoneLastSeen: async () => {},
  };
  const messagesRepo: MessagesRepo = {
    append: async (message) => {
      appended.push(message);
      return { deduped: false, tsMsgId: buildTsMsgId(message.providerTs, message.providerSid) };
    },
    getByProviderSid: async () => undefined,
    updateDeliveryStatus: async () => true,
    updateCallStatus: async () => true,
    setCallRecording: async () => true,
    releaseCallRecording: async () => {},
    setCallTranscript: async () => true,
    setTranscriptPending: async () => false,
    setTranscriptFailed: async () => false,
    upgradeCallOutcomeToVoicemail: async () => false,
    listByConversation: async () => [],
    annotateMessage: async () => {},
    putJobExecutionMarker: async () => true,
    setRecipientDelivery: async () => {},
    updateRecipientDeliveryStatus: async () => true,
    putRelaySidPointer: async () => {},
    getRelaySidPointer: async () => undefined,
    putSystemSidMarker: async () => {},
    getSystemSidMarker: async () => undefined,
  };
  const auditRepo: AuditRepo = {
    append: async () => {},
    listByEntity: async () => [],
  };
  const adapter: MessagingAdapter = {
    sendMessage: async (params) => {
      sent.push(params);
      return { providerSid: `SMfake-${sent.length}`, status: 'queued', providerTs: '2026-06-12T10:00:00.000Z' };
    },
    getMediaStream: async () => {
      throw new Error('not used');
    },
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
  };

  const service = createSendMessageService({
    config: loadConfig({ NODE_ENV: 'test', SEND_BREAKER_MAX_PER_MINUTE: '3', ...overrides.env }),
    adapter,
    conversationsRepo,
    messagesRepo,
    contactsRepo,
    auditRepo,
    events: createEventBus(),
  });

  return { service, sent, appended };
}

describe('sendMessage gate ordering (M1 regression)', () => {
  it('relay guard beats the opt-out gate: a relay_group whose contact is ALSO opted out throws RELAY, not opt-out', async () => {
    const f = makeSendFakes({
      conversation: { type: 'relay_group', pool_number: '+15550109000' },
      contact: { contactId: 'contact-1', type: 'tenant', phone: '+15550100001', sms_opt_out: true },
    });
    const err = await f.service({ conversationId: 'conv-1', body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelaySendNotSupportedError);
    expect((err as RelaySendNotSupportedError).code).toBe('relay_not_supported');
    expect(f.sent).toHaveLength(0);
    expect(f.appended).toHaveLength(0);
  });

  it('manual-mode refusal is automated-only: a HUMAN send (automated:false) into an ai_mode:manual conversation SUCCEEDS', async () => {
    const f = makeSendFakes({ conversation: { ai_mode: 'manual' } });
    await expect(f.service({ conversationId: 'conv-1', body: 'human', automated: false })).resolves.toMatchObject({
      providerSid: 'SMfake-1',
    });
    expect(f.sent).toHaveLength(1);
  });
});
