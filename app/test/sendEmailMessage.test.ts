// A5 unit tests: the outbound EMAIL send service - all six plan behaviors
// (kill-switch, To-on-file + CC validation, suppression, attachment caps, the
// queued->sent optimistic persist, SSE) plus adapter-throw->failed, the claim-
// arbiter redirect, and the ADJ-7 parked-event seam. All repos/adapters/store
// are in-memory spies: no DynamoDB, no network.
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { EmailAdapter } from '../src/adapters/email.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessagesRepo } from '../src/repos/messagesRepo.js';
import type { EventBus } from '../src/lib/events.js';
import { EMAIL_MAX_TOTAL_BYTES } from '../src/lib/mediaTypes.js';
import {
  ContactEmailMissingError,
  EmailAttachmentsTooLargeError,
  EmailSendingDisabledError,
  EmailSuppressedError,
  InvalidAttachmentError,
  InvalidCcError,
  createSendEmailMessageService,
} from '../src/services/sendEmailMessage.js';
import { createLogCapture } from './helpers/logCapture.js';

const NOW = '2026-07-20T12:00:00.000Z';
const logger = createLogger({ destination: createLogCapture().stream });

function cfg(over: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    CF_ORIGIN_SECRET: 's',
    EMAIL_FROM_ADDRESS: 'team@mail.test',
    EMAIL_SENDER_DOMAIN: 'mail.test',
    ...over,
  });
}

interface Over {
  contact?: Partial<ContactItem> | null;
  conversation?: Partial<ConversationItem>;
  env?: Record<string, string>;
  send?: ReturnType<typeof vi.fn>;
  attachReturns?: string;
  mediaStore?: Partial<MediaStore> | null;
  parked?: ReturnType<typeof vi.fn>;
}

function makeFakes(over: Over = {}) {
  const contact: ContactItem | undefined =
    over.contact === null
      ? undefined
      : ({
          contactId: 'c1',
          type: 'tenant',
          email: 'tenant@x.com',
          emails: [{ email: 'tenant@x.com', primary: true }],
          ...over.contact,
        } as ContactItem);
  const conversation: ConversationItem = {
    conversationId: 'conv-1',
    participant_phone: '+15550100001',
    status: 'open',
    last_activity_at: NOW,
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: NOW,
    ...over.conversation,
  };

  const append = vi.fn(async (m: { providerTs: string; providerSid: string }) => ({
    deduped: false,
    tsMsgId: `${m.providerTs}#${m.providerSid}`,
  }));
  const recordProviderSidAlias = vi.fn(async () => {});
  const updateDeliveryStatus = vi.fn(async () => true);
  const send = over.send ?? vi.fn(async () => ({ providerMessageId: 'ses-1' }));
  const attachEmailToConversation = vi.fn(async (id: string) => ({
    conversationId: over.attachReturns ?? id,
  }));
  const getReplyToken = vi.fn(async () => 'tok');
  const touchLastActivity = vi.fn(async () => conversation);
  const touchEmailLastSeen = vi.fn(async () => {});
  const head = vi.fn();
  const getBytes = vi.fn();
  const emit = vi.fn();
  const parked = over.parked ?? vi.fn(async () => {});

  const store =
    over.mediaStore === null ? undefined : ({ head, getBytes, ...over.mediaStore } as unknown as MediaStore);

  const service = createSendEmailMessageService({
    config: cfg(over.env),
    logger,
    adapter: { kind: 'console', send } as unknown as EmailAdapter,
    conversationsRepo: {
      getById: async (id: string) => (id === conversation.conversationId ? conversation : undefined),
      attachEmailToConversation,
      getReplyToken,
      touchLastActivity,
    } as unknown as ConversationsRepo,
    messagesRepo: { append, recordProviderSidAlias, updateDeliveryStatus } as unknown as MessagesRepo,
    contactsRepo: {
      getById: async (id: string) => (contact?.contactId === id ? contact : undefined),
      touchEmailLastSeen,
    } as unknown as ContactsRepo,
    ...(store !== undefined ? { mediaStore: store } : {}),
    events: { emit } as unknown as EventBus,
    applyParkedEmailEvents: parked as unknown as (id: string) => Promise<void>,
    now: () => new Date(NOW),
  });

  return {
    service,
    append,
    recordProviderSidAlias,
    updateDeliveryStatus,
    send,
    attachEmailToConversation,
    getReplyToken,
    touchLastActivity,
    touchEmailLastSeen,
    head,
    getBytes,
    emit,
    parked,
  };
}

function input(over: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    contactId: 'c1',
    to: 'tenant@x.com',
    subject: 'Hello',
    body: 'A message body',
    sentByUserId: 'u1',
    sentByName: 'Cam',
    ...over,
  };
}

describe('sendEmailMessage - behavior 1: kill-switch', () => {
  it('refuses with email_sending_disabled and persists NOTHING when the switch is off', async () => {
    const f = makeFakes({ env: { EMAIL_SENDING_ENABLED: 'false' } });
    await expect(f.service(input())).rejects.toBeInstanceOf(EmailSendingDisabledError);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('refuses when the sender identity is not configured (no sender domain)', async () => {
    const f = makeFakes({ env: { EMAIL_SENDER_DOMAIN: '' } });
    await expect(f.service(input())).rejects.toBeInstanceOf(EmailSendingDisabledError);
    expect(f.append).not.toHaveBeenCalled();
  });
});

describe('sendEmailMessage - behavior 2: To on file + CC validation', () => {
  it('refuses contact_email_missing when To is not one of the contact emails', async () => {
    const f = makeFakes();
    await expect(f.service(input({ to: 'stranger@x.com' }))).rejects.toBeInstanceOf(ContactEmailMissingError);
    expect(f.append).not.toHaveBeenCalled();
  });

  it('normalizes To before matching (upper/whitespace still matches on file)', async () => {
    const f = makeFakes();
    const out = await f.service(input({ to: '  Tenant@X.com  ' }));
    expect(out.status).toBe('sent');
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ email_to: ['tenant@x.com'] }));
  });

  it('refuses invalid_cc on a malformed CC address', async () => {
    const f = makeFakes();
    await expect(f.service(input({ cc: ['ok@x.com', 'not-an-email'] }))).rejects.toBeInstanceOf(InvalidCcError);
    expect(f.append).not.toHaveBeenCalled();
  });

  it('carries validated + normalized CC through to persist and the adapter', async () => {
    const f = makeFakes();
    await f.service(input({ cc: ['CC@X.com'] }));
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ email_cc: ['cc@x.com'] }));
    expect(f.send.mock.calls[0]![0]).toMatchObject({ cc: ['cc@x.com'] });
  });
});

describe('sendEmailMessage - behavior 3: suppression', () => {
  it('refuses email_suppressed when email_opt_out is set', async () => {
    const f = makeFakes({ contact: { email_opt_out: true } as Partial<ContactItem> });
    await expect(f.service(input())).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(f.append).not.toHaveBeenCalled();
  });

  it('refuses email_suppressed when email_unreachable is set', async () => {
    const f = makeFakes({ contact: { email_unreachable: true } as Partial<ContactItem> });
    await expect(f.service(input())).rejects.toBeInstanceOf(EmailSuppressedError);
  });
});

describe('sendEmailMessage - behavior 4: attachments', () => {
  const KEY = 'email-media/u1/aaaaaaaa-0000-0000-0000-000000000000';

  it('HEADs each key, fetches bytes, and passes the ORIGINAL through to the adapter', async () => {
    const f = makeFakes();
    f.head.mockResolvedValue({ contentType: 'application/pdf', size: 1000 });
    f.getBytes.mockResolvedValue(Buffer.from('%PDF-1.4 bytes'));
    await f.service(input({ attachmentKeys: [KEY] }));
    expect(f.getBytes).toHaveBeenCalledWith(KEY);
    expect(f.send.mock.calls[0]![0]).toMatchObject({
      attachments: [
        { filename: 'attachment-1.pdf', contentType: 'application/pdf', content: expect.any(Buffer) },
      ],
    });
  });

  it('refuses email_attachments_too_large when the summed bytes exceed the cap', async () => {
    const f = makeFakes();
    f.head.mockResolvedValue({ contentType: 'application/pdf', size: EMAIL_MAX_TOTAL_BYTES + 1 });
    await expect(f.service(input({ attachmentKeys: [KEY] }))).rejects.toBeInstanceOf(
      EmailAttachmentsTooLargeError,
    );
    expect(f.append).not.toHaveBeenCalled();
  });

  it('refuses invalid_attachment on a missing object', async () => {
    const f = makeFakes();
    f.head.mockResolvedValue(undefined);
    await expect(f.service(input({ attachmentKeys: [KEY] }))).rejects.toBeInstanceOf(InvalidAttachmentError);
  });

  it('refuses invalid_attachment on a foreign key prefix', async () => {
    const f = makeFakes();
    await expect(
      f.service(input({ attachmentKeys: ['uploads/aaaaaaaa-0000-0000-0000-000000000000'] })),
    ).rejects.toBeInstanceOf(InvalidAttachmentError);
    expect(f.append).not.toHaveBeenCalled();
  });
});

describe('sendEmailMessage - behavior 5: optimistic persist + provider ids', () => {
  it('persists queued BEFORE adapter.send, then aliases the SES id + advances to sent', async () => {
    const f = makeFakes();
    const out = await f.service(input());

    // Persist-before-send (ADJ-6 divergence 2).
    expect(f.append.mock.invocationCallOrder[0]).toBeLessThan(f.send.mock.invocationCallOrder[0]!);
    const appendArg = f.append.mock.calls[0]![0] as Record<string, unknown>;
    expect(appendArg).toMatchObject({
      type: 'email',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      email_from: 'team@mail.test',
      email_to: ['tenant@x.com'],
    });
    // provider_sid = our bare RFC id; rfcMessageIdPointer = the same bare id;
    // email_message_id = that id WITH angle brackets.
    const bareId = appendArg['providerSid'] as string;
    expect(bareId).toMatch(/^hc-[0-9a-f-]+@mail\.test$/);
    expect(appendArg['rfcMessageIdPointer']).toBe(bareId);
    expect(appendArg['email_message_id']).toBe(`<${bareId}>`);

    // Post-send: SES-id alias -> this message, then queued->sent.
    expect(f.recordProviderSidAlias).toHaveBeenCalledWith('ses-1', {
      conversationId: 'conv-1',
      tsMsgId: `${NOW}#${bareId}`,
    });
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith(bareId, 'sent');

    // Outcome shape (A6/A7 consume this).
    expect(out).toMatchObject({
      conversationId: 'conv-1',
      providerSid: bareId,
      sesMessageId: 'ses-1',
      emailMessageId: `<${bareId}>`,
      status: 'sent',
      redirected: false,
    });
  });

  it('on adapter throw: advances queued->failed, leaves the message, and rethrows', async () => {
    const send = vi.fn(async () => {
      throw new Error('SES boom');
    });
    const f = makeFakes({ send });
    await expect(f.service(input())).rejects.toThrow('SES boom');
    // The message was persisted (queued) and NOT removed - a visible failed send.
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith(
      expect.stringMatching(/^hc-[0-9a-f-]+@mail\.test$/),
      'failed',
      expect.any(String),
    );
    expect(f.recordProviderSidAlias).not.toHaveBeenCalled();
  });

  it('threads into the arbiter-returned conversation when the address is claimed elsewhere', async () => {
    const f = makeFakes({ attachReturns: 'conv-OTHER' });
    const out = await f.service(input());
    expect(out.conversationId).toBe('conv-OTHER');
    expect(out.redirected).toBe(true);
    expect(f.append).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-OTHER' }));
    expect(f.getReplyToken).toHaveBeenCalledWith('conv-OTHER');
  });

  it('refuses conversation_not_found (404-class) for a missing or relay_group conversation', async () => {
    const missing = makeFakes({ conversation: { conversationId: 'other' } });
    await expect(missing.service(input())).rejects.toMatchObject({ code: 'conversation_not_found' });
    const relay = makeFakes({ conversation: { type: 'relay_group' } });
    await expect(relay.service(input())).rejects.toMatchObject({ code: 'conversation_not_found' });
  });
});

describe('sendEmailMessage - behavior 6 + ADJ-7 seam', () => {
  it('emits SSE, touches the inbox + email lastSeen, and calls the parked-event applier with the SES id', async () => {
    const parked = vi.fn(async () => {});
    const f = makeFakes({ parked });
    await f.service(input());

    expect(f.touchLastActivity).toHaveBeenCalledTimes(1);
    expect(f.touchEmailLastSeen).toHaveBeenCalledWith('c1', 'tenant@x.com', NOW);
    const events = f.emit.mock.calls.map((c) => c[0]);
    expect(events).toContain('message.persisted');
    expect(events).toContain('conversation.updated');
    // ADJ-7: the B5 parking-lot applier is called with the SES MessageId post-send.
    expect(parked).toHaveBeenCalledWith('ses-1');
  });
});
