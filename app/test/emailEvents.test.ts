// B5 unit tests: SES delivery-event application (services/emailEvents.ts) - the
// behavior matrix (delivery/bounce/complaint -> status + suppression + audit),
// the plan-F12 orphan PARKING LOT (park when the SES id has no message yet), the
// exactly-once parked consume, and the SCOPE-6 end-to-end suppression loop
// (bounce -> subsequent send refused 409). All repos are in-memory spies: no
// DynamoDB, no network.
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessageItem, MessagesRepo, ParkedEmailEvent } from '../src/repos/messagesRepo.js';
import type { AuditRepo } from '../src/repos/auditRepo.js';
import type { EmailAdapter } from '../src/adapters/email.js';
import type { EventBus } from '../src/lib/events.js';
import type { SnsSesEvent } from '../src/services/sesNotifications.js';
import {
  PARKED_EMAIL_EVENT_TTL_MS,
  createApplyEmailEvent,
  createApplyParkedEmailEvents,
} from '../src/services/emailEvents.js';
import { EmailSuppressedError, createSendEmailMessageService } from '../src/services/sendEmailMessage.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const logger = createLogger({ destination: createLogCapture().stream });

function event(over: Partial<SnsSesEvent> = {}): SnsSesEvent {
  return {
    kind: 'event',
    eventType: 'Delivery',
    sesMessageId: 'ses-1',
    payload: {},
    ...over,
  } as SnsSesEvent;
}

const OUTBOUND: MessageItem = {
  conversationId: 'conv-1',
  tsMsgId: '2026-07-21T11:00:00.000Z#hc-abc@mail.test',
  type: 'email',
  direction: 'outbound',
  author: 'teammate',
  provider_sid: 'hc-abc@mail.test',
  provider_ts: '2026-07-21T11:00:00.000Z',
  delivery_status: 'sent',
  email_to: ['tenant@x.com'],
} as unknown as MessageItem;

interface Deps {
  message?: MessageItem | undefined;
  contact?: ContactItem | undefined;
  parked?: ParkedEmailEvent | undefined;
  updateReturns?: boolean;
  conversation?: ConversationItem | undefined;
}

function makeApplier(over: Deps = {}) {
  const contact: ContactItem | undefined =
    'contact' in over
      ? over.contact
      : ({ contactId: 'c1', type: 'tenant', email: 'tenant@x.com', emails: [{ email: 'tenant@x.com', primary: true }] } as ContactItem);

  const parkedStore = new Map<string, ParkedEmailEvent>();
  if (over.parked) parkedStore.set(over.parked.sesMessageId, over.parked);

  const getByProviderSid = vi.fn(async (_sid: string) => ('message' in over ? over.message : OUTBOUND));
  const updateDeliveryStatus = vi.fn(async () => over.updateReturns ?? true);
  const putParkedEmailEvent = vi.fn(async (e: ParkedEmailEvent, _opts: { receivedAt: string; expiresAt: number }) => {
    parkedStore.set(e.sesMessageId, e);
  });
  const getParkedEmailEvent = vi.fn(async (sid: string) => parkedStore.get(sid));
  const deleteParkedEmailEvent = vi.fn(async (sid: string) => {
    parkedStore.delete(sid);
  });

  const setFlag = vi.fn(async () => {});
  const findByEmail = vi.fn(async (email: string) => (contact && contact.email === email ? contact : undefined));
  const getById = vi.fn(async (id: string) => (contact?.contactId === id ? contact : undefined));

  const conversationGetById = vi.fn(async () =>
    'conversation' in over
      ? over.conversation
      : ({ conversationId: 'conv-1', participants: [{ contactId: 'c1', phone: '+15550100001' }] } as ConversationItem),
  );
  const append = vi.fn(async () => {});

  const messagesRepo = {
    getByProviderSid,
    updateDeliveryStatus,
    putParkedEmailEvent,
    getParkedEmailEvent,
    deleteParkedEmailEvent,
  } as unknown as MessagesRepo;
  const contactsRepo = { findByEmail, getById, setFlag } as unknown as ContactsRepo;
  const conversationsRepo = { getById: conversationGetById } as unknown as ConversationsRepo;
  const auditRepo = { append } as unknown as AuditRepo;

  const deps = { messagesRepo, contactsRepo, conversationsRepo, auditRepo, logger, now: () => NOW };
  return {
    applyEmailEvent: createApplyEmailEvent(deps),
    applyParkedEmailEvents: createApplyParkedEmailEvents(deps),
    parkedStore,
    getByProviderSid,
    updateDeliveryStatus,
    putParkedEmailEvent,
    getParkedEmailEvent,
    deleteParkedEmailEvent,
    setFlag,
    findByEmail,
    getById,
    conversationGetById,
    append,
  };
}

describe('applyEmailEvent - RESOLVED behavior matrix', () => {
  it('Delivery -> updateDeliveryStatus delivered, no flag, no audit', async () => {
    const f = makeApplier();
    await f.applyEmailEvent(event({ eventType: 'Delivery' }));
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith('ses-1', 'delivered');
    expect(f.setFlag).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it('Bounce Permanent -> undelivered + email_unreachable flag on the recipient + audit', async () => {
    const f = makeApplier();
    await f.applyEmailEvent(event({ eventType: 'Bounce', bounceType: 'Permanent' }));
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith('ses-1', 'undelivered', 'bounce:Permanent');
    expect(f.findByEmail).toHaveBeenCalledWith('tenant@x.com');
    expect(f.setFlag).toHaveBeenCalledWith('c1', 'email_unreachable');
    expect(f.append).toHaveBeenCalledWith(
      'contacts#c1',
      'email_unreachable_recorded',
      expect.objectContaining({ sesMessageId: 'ses-1', conversationId: 'conv-1', bounceType: 'Permanent' }),
    );
  });

  it('Bounce Transient -> undelivered ONLY, no suppression flag', async () => {
    const f = makeApplier();
    await f.applyEmailEvent(event({ eventType: 'Bounce', bounceType: 'Transient' }));
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith('ses-1', 'undelivered', 'bounce:Transient');
    expect(f.setFlag).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it('Complaint -> email_opt_out flag + audit, NO delivery-status change', async () => {
    const f = makeApplier();
    await f.applyEmailEvent(event({ eventType: 'Complaint' }));
    expect(f.updateDeliveryStatus).not.toHaveBeenCalled();
    expect(f.setFlag).toHaveBeenCalledWith('c1', 'email_opt_out');
    expect(f.append).toHaveBeenCalledWith('contacts#c1', 'email_opt_out_recorded', expect.objectContaining({ sesMessageId: 'ses-1' }));
  });

  it('falls back to the conversation contact when findByEmail misses', async () => {
    const f = makeApplier({ contact: { contactId: 'c1', type: 'tenant' } as ContactItem });
    // The contact has no matching email, so findByEmail('tenant@x.com') misses;
    // resolution falls through to the conversation participant + getById.
    await f.applyEmailEvent(event({ eventType: 'Bounce', bounceType: 'Permanent' }));
    expect(f.conversationGetById).toHaveBeenCalled();
    expect(f.getById).toHaveBeenCalledWith('c1');
    expect(f.setFlag).toHaveBeenCalledWith('c1', 'email_unreachable');
  });

  it('suppression with NO resolvable contact still updates status and never throws', async () => {
    const f = makeApplier({ contact: undefined, conversation: undefined });
    await expect(f.applyEmailEvent(event({ eventType: 'Bounce', bounceType: 'Permanent' }))).resolves.toBeUndefined();
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith('ses-1', 'undelivered', 'bounce:Permanent');
    expect(f.setFlag).not.toHaveBeenCalled();
  });

  it('never throws on an out-of-order transition (updateDeliveryStatus returns false)', async () => {
    const f = makeApplier({ updateReturns: false });
    await expect(f.applyEmailEvent(event({ eventType: 'Delivery' }))).resolves.toBeUndefined();
  });
});

describe('applyEmailEvent - F12 orphan parking', () => {
  it('parks the event (with a 7d expires_at) when no message resolves, and applies NOTHING', async () => {
    const f = makeApplier({ message: undefined });
    await f.applyEmailEvent(event({ eventType: 'Bounce', bounceType: 'Permanent' }));
    expect(f.putParkedEmailEvent).toHaveBeenCalledTimes(1);
    const [parked, opts] = f.putParkedEmailEvent.mock.calls[0]!;
    expect(parked).toEqual({ eventType: 'Bounce', sesMessageId: 'ses-1', bounceType: 'Permanent' });
    expect(opts.expiresAt).toBe(Math.floor((NOW.getTime() + PARKED_EMAIL_EVENT_TTL_MS) / 1000));
    // No status/flag/audit while parked - it lands when A5's post-send seam runs.
    expect(f.updateDeliveryStatus).not.toHaveBeenCalled();
    expect(f.setFlag).not.toHaveBeenCalled();
  });

  it('never throws when parking a Delivery orphan', async () => {
    const f = makeApplier({ message: undefined });
    await expect(f.applyEmailEvent(event({ eventType: 'Delivery' }))).resolves.toBeUndefined();
    expect(f.putParkedEmailEvent).toHaveBeenCalledTimes(1);
  });
});

describe('applyParkedEmailEvents - post-send consume (ADJ-7)', () => {
  it('no-ops (single read) when nothing is parked', async () => {
    const f = makeApplier();
    await f.applyParkedEmailEvents('ses-1');
    expect(f.getParkedEmailEvent).toHaveBeenCalledWith('ses-1');
    expect(f.updateDeliveryStatus).not.toHaveBeenCalled();
    expect(f.deleteParkedEmailEvent).not.toHaveBeenCalled();
  });

  it('applies a parked permanent bounce (suppression LANDS) then consumes it exactly once', async () => {
    const f = makeApplier({ parked: { eventType: 'Bounce', sesMessageId: 'ses-1', bounceType: 'Permanent' } });
    await f.applyParkedEmailEvents('ses-1');
    // Suppression landed via the parked event.
    expect(f.updateDeliveryStatus).toHaveBeenCalledWith('ses-1', 'undelivered', 'bounce:Permanent');
    expect(f.setFlag).toHaveBeenCalledWith('c1', 'email_unreachable');
    expect(f.deleteParkedEmailEvent).toHaveBeenCalledWith('ses-1');
    // Second application no-ops (the item was consumed) - exactly-once.
    f.setFlag.mockClear();
    f.deleteParkedEmailEvent.mockClear();
    await f.applyParkedEmailEvents('ses-1');
    expect(f.setFlag).not.toHaveBeenCalled();
    expect(f.deleteParkedEmailEvent).not.toHaveBeenCalled();
  });

  it('leaves the parked item (no delete) when the message still does not resolve', async () => {
    const f = makeApplier({ parked: { eventType: 'Delivery', sesMessageId: 'ses-1' }, message: undefined });
    await f.applyParkedEmailEvents('ses-1');
    expect(f.updateDeliveryStatus).not.toHaveBeenCalled();
    expect(f.deleteParkedEmailEvent).not.toHaveBeenCalled();
    expect(f.parkedStore.has('ses-1')).toBe(true);
  });
});

// SCOPE 6: the whole loop against a SHARED contact - a permanent bounce applied
// via the event pipeline must make the NEXT A5 send refuse with email_suppressed.
describe('suppression end-to-end (bounce -> subsequent send 409)', () => {
  function cfg() {
    return loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 's', EMAIL_FROM_ADDRESS: 'team@mail.test', EMAIL_SENDER_DOMAIN: 'mail.test' });
  }

  it('a permanent bounce sets email_unreachable; the next send is refused', async () => {
    // ONE shared contact object mutated by setFlag and read by the send service.
    const contact: ContactItem = {
      contactId: 'c1',
      type: 'tenant',
      email: 'tenant@x.com',
      emails: [{ email: 'tenant@x.com', primary: true }],
    } as ContactItem;
    const sharedContacts = {
      getById: async (id: string) => (id === 'c1' ? contact : undefined),
      findByEmail: async (email: string) => (email === contact.email ? contact : undefined),
      setFlag: async (_id: string, flag: string) => {
        (contact as Record<string, unknown>)[flag] = true;
      },
      touchEmailLastSeen: async () => {},
    } as unknown as ContactsRepo;

    // The event applier: the bounce's message resolves + names the contact's To.
    const applyEmailEvent = createApplyEmailEvent({
      messagesRepo: {
        getByProviderSid: async () => OUTBOUND,
        updateDeliveryStatus: async () => true,
      } as unknown as MessagesRepo,
      contactsRepo: sharedContacts,
      conversationsRepo: { getById: async () => undefined } as unknown as ConversationsRepo,
      auditRepo: { append: async () => {} } as unknown as AuditRepo,
      logger,
      now: () => NOW,
    });

    // The A5 send service on the SAME contact.
    const send = createSendEmailMessageService({
      config: cfg(),
      logger,
      adapter: { kind: 'console', send: async () => ({ providerMessageId: 'ses-1' }) } as unknown as EmailAdapter,
      conversationsRepo: {
        getById: async () => ({
          conversationId: 'conv-1',
          participants: [{ contactId: 'c1', phone: '+15550100001' }],
          type: 'tenant_1to1',
        }),
        attachEmailToConversation: async (id: string) => ({ conversationId: id }),
        getReplyToken: async () => 'tok',
        touchLastActivity: async () => ({}),
      } as unknown as ConversationsRepo,
      messagesRepo: {
        append: async (m: { providerTs: string; providerSid: string }) => ({ deduped: false, tsMsgId: `${m.providerTs}#${m.providerSid}` }),
        listByConversation: async () => [], // reply-threading read: no prior inbound
        recordProviderSidAlias: async () => {},
        updateDeliveryStatus: async () => true,
      } as unknown as MessagesRepo,
      contactsRepo: sharedContacts,
      events: { emit: () => {} } as unknown as EventBus,
      applyParkedEmailEvents: async () => {},
      now: () => NOW,
    });

    const baseInput = { conversationId: 'conv-1', contactId: 'c1', to: 'tenant@x.com', subject: 'Hi', body: 'B', sentByUserId: 'u1', sentByName: 'Cam' };
    // Send #1 succeeds (contact not yet suppressed).
    await expect(send(baseInput)).resolves.toMatchObject({ status: 'sent' });
    // A permanent bounce arrives for that send.
    await applyEmailEvent(event({ eventType: 'Bounce', bounceType: 'Permanent' }));
    expect(contact.email_unreachable).toBe(true);
    // Send #2 is now refused.
    await expect(send(baseInput)).rejects.toBeInstanceOf(EmailSuppressedError);
  });
});
