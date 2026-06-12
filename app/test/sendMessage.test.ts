// M1.1 unit tests: outbound send service — opt-out refusal, circuit breaker
// trip (flip to manual + ERROR log), manual-mode semantics, persist-at-send.
// All repos/adapters are in-memory fakes: no DynamoDB, no network.
import { describe, expect, it } from 'vitest';
import type { MessagingAdapter, SendMessageParams } from '../src/adapters/messaging.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessagesRepo, NewMessage } from '../src/repos/messagesRepo.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';
import {
  CircuitBreakerOpenError,
  ContactOptedOutError,
  ConversationNotFoundError,
  ManualModeError,
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
    counterValue: 0,
  };

  const conversationsRepo: ConversationsRepo = {
    createOrGetByParticipantPhone: async () => conversation,
    getById: async (id) => (id === conversation.conversationId ? conversation : undefined),
    touchLastActivity: async (_id, previewText, ts) => {
      fakes.touched.push({ previewText, ts });
    },
    setMode: async (_id, mode) => {
      fakes.modeSets.push(mode);
      conversation.ai_mode = mode;
    },
    incrementAutomatedSendCount: async () => {
      fakes.counterValue += 1;
      return fakes.counterValue;
    },
  };
  const contactsRepo: ContactsRepo = {
    findByPhone: async () => contact,
    setFlag: async () => {},
  };
  const messagesRepo: MessagesRepo = {
    append: async (message) => {
      fakes.appended.push(message);
      return { deduped: false, tsMsgId: buildTsMsgId(message.providerTs, message.providerSid) };
    },
    getByProviderSid: async () => undefined,
    updateDeliveryStatus: async () => true,
    listByConversation: async () => [],
  };
  const adapter: MessagingAdapter = {
    sendMessage: async (params) => {
      fakes.sent.push(params);
      return { providerSid: `SMfake-${fakes.sent.length}`, status: 'queued', providerTs: '2026-06-12T10:00:00.000Z' };
    },
    getMediaStream: async () => {
      throw new Error('not used');
    },
  };

  const capture = createLogCapture();
  const service = createSendMessageService({
    config: loadConfig({ NODE_ENV: 'test', SEND_BREAKER_MAX_PER_MINUTE: '3' }),
    logger: createLogger({ level: 'info', destination: capture.stream }),
    adapter,
    conversationsRepo,
    messagesRepo,
    contactsRepo,
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

  it('allows sends when the phone resolves to no contact yet (auto-capture is M1.2)', async () => {
    const f = makeFakes({ contact: null });
    await expect(f.service({ conversationId: 'conv-1', body: 'x' })).resolves.toMatchObject({
      providerSid: 'SMfake-1',
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
