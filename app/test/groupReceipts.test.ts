// T5.3: the group delivery-receipts pipeline.
//
// The addendum proved classic status callbacks do NOT fire for
// Conversations-originated sends, so this path is the ONLY source of per-member
// delivery state - and every hole in it is silent by construction. The matrix
// below is the forward-only guard, the park-and-drain race, the two MBxx
// resolution sources, and the 21610 bookkeeping nobody else does.
import { describe, expect, it } from 'vitest';
import { createEventBus, type AppEventName } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { DeliveryStatus, MessageItem, ParkedGroupReceipt } from '../src/repos/messagesRepo.js';
import { allowedPriorStatuses } from '../src/repos/messagesRepo.js';
import {
  conversationsStatusRuling,
  createGroupReceiptsService,
  receiptRank,
  SUPPRESSED_ERROR_CODE,
} from '../src/services/groupReceipts.js';
import { applyNumberSuppression } from '../src/services/numberSuppression.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const WARN = 40;

const ANN_KEY = 'phone#+16175550111';
const MARCUS_KEY = 'phone#+16175550222';

interface Fakes {
  message: MessageItem | undefined;
  messages: MessageItem[];
  parked: Map<string, Map<string, { receipt: ParkedGroupReceipt; rank: number }>>;
  conversations: Map<string, ConversationItem>;
  contacts: ContactItem[];
  flagWrites: { contactId: string; flag: string; value: boolean }[];
  optOutSets: { conversationId: string; value: boolean }[];
  audits: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  createdOneToOnes: string[];
  /** SSE events this service emitted (the UI-refresh push, fix wave 5 L2). */
  emitted: { event: AppEventName; payload: unknown }[];
  /** `onPark` fires INSIDE parkGroupReceipt - models the append committing
   *  mid-park. Held in its own object because makeFakes returns a SPREAD copy,
   *  so a field set on the result would never reach the closure. */
  hooks: { onPark?: () => void };
  capture: LogCapture;
  service: ReturnType<typeof createGroupReceiptsService>;
}

function outboundGroupMessage(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    conversationId: 'group-1',
    tsMsgId: '2026-08-11T13:00:00.500Z#IMposted1',
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'on my way',
    provider_sid: 'IMposted1',
    provider_ts: '2026-08-11T13:00:00.500Z',
    delivery_status: 'queued',
    created_at: '2026-08-11T13:00:00.500Z',
    delivery_recipients: {
      [ANN_KEY]: { status: 'queued' },
      [MARCUS_KEY]: { status: 'queued' },
    },
    group_conversation_sid: 'CHrail1',
    group_participant_map: { MBann: ANN_KEY, MBmarcus: MARCUS_KEY },
    ...overrides,
  };
}

function makeFakes(
  overrides: {
    message?: MessageItem | undefined;
    conversation?: Partial<ConversationItem>;
    contacts?: ContactItem[];
  } = {},
): Fakes {
  const message = 'message' in overrides ? overrides.message : outboundGroupMessage();
  const messages = message === undefined ? [] : [message];
  const parked = new Map<string, Map<string, { receipt: ParkedGroupReceipt; rank: number }>>();
  const conversation: ConversationItem = {
    conversationId: 'group-1',
    type: 'group_text',
    status: 'group_open',
    ai_mode: 'auto',
    created_at: '2026-08-01T00:00:00.000Z',
    last_activity_at: '2026-08-10T00:00:00.000Z',
    twilio_conversation_sid: 'CHrail1',
    twilio_participant_map: { MBann: ANN_KEY, MBmarcus: MARCUS_KEY },
    ...overrides.conversation,
  };
  const conversations = new Map<string, ConversationItem>([['group-1', conversation]]);
  const contacts = overrides.contacts ?? [];
  const hooks: { onPark?: () => void } = {};
  const capture = createLogCapture();

  const fakes = {
    message,
    messages,
    parked,
    conversations,
    contacts,
    flagWrites: [] as Fakes['flagWrites'],
    optOutSets: [] as Fakes['optOutSets'],
    audits: [] as Fakes['audits'],
    createdOneToOnes: [] as string[],
    emitted: [] as Fakes['emitted'],
    hooks,
    capture,
  };

  const events = createEventBus();
  for (const name of ['message.persisted', 'conversation.updated'] as AppEventName[]) {
    events.on(name, (payload: unknown) => fakes.emitted.push({ event: name, payload }));
  }

  const service = createGroupReceiptsService({
    events,
    logger: createLogger({ level: 'info', destination: capture.stream }),
    unknownMessageRetryDelayMs: 0,
    now: () => new Date('2026-08-11T13:05:00.000Z'),
    messagesRepo: {
      getByProviderSid: async (sid) => messages.find((m) => m.provider_sid === sid),
      getByTsMsgId: async (conversationId, tsMsgId) =>
        messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId),
      // The AGGREGATE writer (spec 4.3). Forward-only, exactly like the repo, so
      // a test can prove the derivation never regresses a finished message.
      updateDeliveryStatus: async (sid, status, errorCode) => {
        const item = messages.find((m) => m.provider_sid === sid);
        if (!item) return false;
        if (!allowedPriorStatuses(status).includes(item.delivery_status as DeliveryStatus)) {
          return false;
        }
        item.delivery_status = status;
        if (errorCode !== undefined) item.error_code = errorCode;
        return true;
      },
      updateRecipientDeliveryStatus: async (
        conversationId,
        tsMsgId,
        memberKey,
        status,
        errorCode,
        opts,
      ) => {
        const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
        const slot = item?.delivery_recipients?.[memberKey];
        if (!item || !slot) return false;
        if (!allowedPriorStatuses(status).includes(slot.status)) return false;
        item.delivery_recipients = {
          ...item.delivery_recipients,
          [memberKey]: {
            ...slot,
            status,
            ...(errorCode !== undefined && { errorCode }),
            ...(status === 'delivered' && { deliveredAt: '2026-08-11T13:05:00.000Z' }),
            ...(opts?.sid !== undefined && { sid: opts.sid }),
          },
        };
        return true;
      },
      setRecipientDeliverySid: async (conversationId, tsMsgId, memberKey, sid) => {
        const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
        const slot = item?.delivery_recipients?.[memberKey];
        if (!item || !slot || slot.sid !== undefined) return false;
        item.delivery_recipients = { ...item.delivery_recipients, [memberKey]: { ...slot, sid } };
        return true;
      },
      parkGroupReceipt: async (receipt, opts) => {
        hooks.onPark?.();
        const slots = parked.get(receipt.messageSid) ?? new Map();
        const existing = slots.get(receipt.participantSid);
        if (existing !== undefined && existing.rank > opts.rank) return false;
        slots.set(receipt.participantSid, { receipt: { ...receipt }, rank: opts.rank });
        parked.set(receipt.messageSid, slots);
        return true;
      },
      listParkedGroupReceipts: async (messageSid) => {
        const slots = parked.get(messageSid);
        return slots === undefined ? [] : [...slots.values()].map((v) => ({ ...v.receipt }));
      },
      deleteParkedGroupReceipt: async (messageSid, participantSid) => {
        parked.get(messageSid)?.delete(participantSid);
      },
    },
    conversationsRepo: {
      getById: async (id) => conversations.get(id),
      findByParticipantPhone: async (phone) =>
        [...conversations.values()].filter((c) => c.participant_phone === phone),
      createOrGetByParticipantPhone: async (phone, type) => {
        const existing = [...conversations.values()].find((c) => c.participant_phone === phone);
        if (existing) return existing;
        const created: ConversationItem = {
          conversationId: `1to1-${phone}`,
          participant_phone: phone,
          type,
          status: 'open',
          ai_mode: 'auto',
          created_at: '2026-08-11T13:05:00.000Z',
          last_activity_at: '2026-08-11T13:05:00.000Z',
        };
        conversations.set(created.conversationId, created);
        fakes.createdOneToOnes.push(created.conversationId);
        return created;
      },
      setSmsOptOut: async (conversationId, value) => {
        fakes.optOutSets.push({ conversationId, value });
        const conv = conversations.get(conversationId);
        if (conv) conv.sms_opt_out = value;
      },
    },
    contactsRepo: {
      findByPhone: async (phone) =>
        contacts.find((c) => c.phone === phone || c.phones?.some((p) => p.phone === phone)),
      setFlag: async (contactId, flag) => {
        fakes.flagWrites.push({ contactId, flag, value: true });
        const c = contacts.find((x) => x.contactId === contactId);
        if (c) c.sms_opt_out = true;
      },
      clearFlag: async (contactId, flag) => {
        fakes.flagWrites.push({ contactId, flag, value: false });
        const c = contacts.find((x) => x.contactId === contactId);
        if (c) c.sms_opt_out = false;
      },
    },
    auditRepo: {
      append: async (entityKey, eventType, payload) => {
        fakes.audits.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
      },
    },
  });

  return { ...fakes, service };
}

function slot(f: Fakes, key: string) {
  return f.messages[0]?.delivery_recipients?.[key];
}

describe('the explicit Conversations status map', () => {
  it('maps the four terminal-ish statuses onto our delivery machine', () => {
    expect(conversationsStatusRuling('sent')).toEqual({ kind: 'apply', status: 'sent' });
    expect(conversationsStatusRuling('delivered')).toEqual({ kind: 'apply', status: 'delivered' });
    expect(conversationsStatusRuling('undelivered')).toEqual({ kind: 'apply', status: 'undelivered' });
    expect(conversationsStatusRuling('failed')).toEqual({ kind: 'apply', status: 'failed' });
  });

  it('IGNORES the non-terminal ones rather than mapping them to queued', () => {
    // `queued` can only follow `queued_pending`, and a group slot is SEEDED
    // `queued` - so mapping these through would emit a "would regress" line for
    // every ordinary send and record nothing.
    for (const status of ['queued', 'sending', 'accepted', 'scheduled']) {
      expect(conversationsStatusRuling(status)?.kind).toBe('ignore');
    }
    expect(allowedPriorStatuses('queued')).toEqual(['queued_pending']);
  });

  it('IGNORES `read` rather than calling it delivered', () => {
    expect(conversationsStatusRuling('read')?.kind).toBe('ignore');
  });

  it('returns undefined for an unmapped value (the whole point of not using mapTwilioStatus)', () => {
    expect(conversationsStatusRuling('teleported')).toBeUndefined();
  });

  it('ranks statuses forward-only for parked coalescing', () => {
    expect(receiptRank('queued')).toBe(0);
    expect(receiptRank('sent')).toBe(1);
    expect(receiptRank('delivered')).toBe(2);
    expect(receiptRank('failed')).toBe(2);
  });
});

describe('applying a receipt', () => {
  it('resolves MBxx through the message SNAPSHOT and applies the status + the channel SID', async () => {
    const f = makeFakes();
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'sent',
      channelMessageSid: 'SMann',
    });
    expect(out).toEqual({ outcome: 'applied', memberKey: ANN_KEY });
    expect(slot(f, ANN_KEY)).toEqual({ status: 'sent', sid: 'SMann' });
  });

  it('falls back to the THREAD map when the message has no snapshot', async () => {
    const f = makeFakes({
      message: outboundGroupMessage({ group_participant_map: undefined }),
    });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'delivered',
    });
    expect(out).toEqual({ outcome: 'applied', memberKey: MARCUS_KEY });
  });

  it('prefers the SNAPSHOT over a thread map that was rebuilt by a rail recreation', async () => {
    // Same MBxx, re-pointed at a different member after a recreate. The
    // snapshot is what THIS message went out with, so it must win.
    const f = makeFakes({
      conversation: { twilio_participant_map: { MBann: MARCUS_KEY } },
    });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
    });
    expect(out).toEqual({ outcome: 'applied', memberKey: ANN_KEY });
    expect(slot(f, MARCUS_KEY)?.status).toBe('queued');
  });

  it('WARNs and drops a known message with an unresolvable participant - never a silent drop', async () => {
    const f = makeFakes();
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBstranger',
      status: 'delivered',
    });
    expect(out).toEqual({ outcome: 'dropped', reason: 'unknown_participant' });
    expect(
      f.capture.atLevel(WARN).some((l) => l['event'] === 'group_receipt_unknown_participant'),
    ).toBe(true);
  });

  it('WARNs and drops an UNMAPPED status instead of silently misclassifying it', async () => {
    const f = makeFakes();
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'teleported',
    });
    expect(out).toEqual({ outcome: 'dropped', reason: 'unmapped_status' });
    expect(
      f.capture.atLevel(WARN).some((l) => l['event'] === 'group_receipt_status_unmapped'),
    ).toBe(true);
    expect(slot(f, ANN_KEY)?.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// The UI push (fix wave 5, L2)
// ---------------------------------------------------------------------------
describe('the SSE push that makes the rollup live', () => {
  it('EMITS message.persisted on every successful transition, so the open thread re-renders', async () => {
    // THE LIVE DEFECT. This path updated `delivery_recipients` and emitted
    // NOTHING, so a group thread sat at `Delivered 0/2` until the operator
    // reloaded the page - while the relay status route has always emitted here.
    // The e2e spec could not see it because it reloaded inside its own poll.
    // This test FAILS if the emit is removed.
    const f = makeFakes();
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
      channelMessageSid: 'SMann',
    });

    expect(f.emitted).toEqual([
      {
        event: 'message.persisted',
        payload: {
          conversationId: 'group-1',
          tsMsgId: '2026-08-11T13:00:00.500Z#IMposted1',
          direction: 'outbound',
          deliveryStatus: 'delivered',
        },
      },
    ]);
  });

  it('emits ONCE PER MEMBER as each leg lands, which is what moves 0/2 to 2/2 live', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBmarcus', status: 'delivered' });

    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted', 'message.persisted']);
  });

  it('emits NOTHING for a refused transition, an ignored status or an unknown message', async () => {
    // Only a real state move changes what the thread renders; a duplicate
    // receipt or a `read` must not cost SSE traffic on every send.
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    f.emitted.length = 0;

    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'sent' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBmarcus', status: 'read' });
    await f.service.applyReceipt({ messageSid: 'IMnosuch', participantSid: 'MBann', status: 'delivered' });

    expect(f.emitted).toEqual([]);
  });

  it('emits when a PARKED receipt finally drains - the late path pushes too', async () => {
    // The park-and-drain route reaches applyToMessage by a different door; if
    // the emit sat at the caller instead, this receipt would land silently.
    const f = makeFakes({ message: undefined });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    expect(f.emitted).toEqual([]);

    f.messages.push(outboundGroupMessage());
    await f.service.drainParked('IMposted1');

    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted']);
  });
});

// ---------------------------------------------------------------------------
// LIVE QA ROUND 2, L4 - the aggregate delivery_status
// ---------------------------------------------------------------------------
//
// LIVE: both outbound group messages read `delivery_status: queued` with every
// per-member slot `delivered`. Neither groupSend nor this service ever wrote the
// field, though spec 4.3 requires it to derive as relay/broadcast conventions
// do. It survived review because the thread view reads the SLOTS, so the wrong
// aggregate is invisible exactly where a human would have noticed it.
describe('the AGGREGATE delivery_status (spec 4.3, L4)', () => {
  const aggregate = (f: Fakes): string | undefined =>
    f.messages.find((m) => m.provider_sid === 'IMposted1')?.delivery_status;

  it('stays `queued` while a leg is still queued - nothing is asserted early', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    expect(aggregate(f)).toBe('queued');
  });

  it('moves to `sent` once every leg has left Twilio', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'sent' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBmarcus', status: 'sent' });
    expect(aggregate(f)).toBe('sent');
  });

  it('FINALIZES at `delivered` when every leg lands - the live defect', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBmarcus', status: 'delivered' });
    expect(aggregate(f)).toBe('delivered');
  });

  it('finalizes AROUND a suppressed leg rather than waiting for a receipt that never comes', async () => {
    // The L3 seed: Twilio skipped this participant, so the aggregate must not
    // count them - otherwise one opted-out member freezes every send at queued.
    const f = makeFakes({
      message: outboundGroupMessage({
        delivery_recipients: {
          [ANN_KEY]: { status: 'queued' },
          [MARCUS_KEY]: { status: 'undelivered', errorCode: SUPPRESSED_ERROR_CODE },
        },
      }),
    });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    expect(aggregate(f)).toBe('delivered');
  });

  it('reports a real carrier failure, with its code', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '30007',
    });
    const message = f.messages.find((m) => m.provider_sid === 'IMposted1');
    expect(message?.delivery_status).toBe('failed');
    expect(message?.error_code).toBe('30007');
  });

  it('a 21610 leg does NOT make the message a failure', async () => {
    // The synthetic code exists precisely so a suppression is not painted as a
    // hard failure. A group text that reached everybody else is `delivered`.
    const f = makeFakes({ contacts: [] });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'undelivered',
      errorCode: '21610',
    });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    expect(aggregate(f)).toBe('delivered');
  });
});

describe('the forward-only guard', () => {
  it('REJECTS delivered -> sent', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'sent',
    });
    expect(out).toEqual({ outcome: 'duplicate', memberKey: ANN_KEY });
    expect(slot(f, ANN_KEY)?.status).toBe('delivered');
  });

  it('REJECTS failed -> sent', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'failed' });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'sent',
    });
    expect(out.outcome).toBe('duplicate');
    expect(slot(f, ANN_KEY)?.status).toBe('failed');
  });

  it('a DUPLICATE receipt is idempotent and still contributes its channel SID', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    expect(slot(f, ANN_KEY)?.sid).toBeUndefined();

    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
      channelMessageSid: 'SMann',
    });
    expect(out.outcome).toBe('duplicate');
    expect(slot(f, ANN_KEY)).toEqual({
      status: 'delivered',
      deliveredAt: '2026-08-11T13:05:00.000Z',
      sid: 'SMann',
    });
  });

  it('never overwrites a sid the slot already carries', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
      channelMessageSid: 'SMfirst',
    });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
      channelMessageSid: 'SMsecond',
    });
    expect(slot(f, ANN_KEY)?.sid).toBe('SMfirst');
  });

  it('each member advances independently - one delivered leg does not touch the other slot', async () => {
    const f = makeFakes();
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    expect(slot(f, MARCUS_KEY)).toEqual({ status: 'queued' });
  });
});

describe('park and drain (a receipt CAN beat the append)', () => {
  it('parks a receipt for an unknown IMxx instead of dropping it', async () => {
    const f = makeFakes({ message: undefined });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'sent',
      channelMessageSid: 'SMann',
    });
    expect(out).toEqual({ outcome: 'parked' });
    expect(f.parked.get('IMposted1')?.size).toBe(1);
  });

  it('parks one slot PER PARTICIPANT - a second member never overwrites the first', async () => {
    const f = makeFakes({ message: undefined });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'sent' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBmarcus', status: 'delivered' });
    expect([...(f.parked.get('IMposted1')?.keys() ?? [])]).toEqual(['MBann', 'MBmarcus']);
  });

  it('coalesces FORWARD-ONLY within a parked slot - a late `sent` cannot undo a parked `delivered`', async () => {
    const f = makeFakes({ message: undefined });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'sent' });
    expect(f.parked.get('IMposted1')?.get('MBann')?.receipt.status).toBe('delivered');
  });

  it('drains every parked slot once the message exists, then clears the park', async () => {
    const f = makeFakes({ message: undefined });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
      channelMessageSid: 'SMann',
    });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBmarcus', status: 'sent' });

    // The append lands.
    f.messages.push(outboundGroupMessage());

    const drained = await f.service.drainParked('IMposted1');
    expect(drained).toBe(2);
    expect(f.parked.get('IMposted1')?.size).toBe(0);
    expect(f.messages[0]?.delivery_recipients?.[ANN_KEY]).toMatchObject({
      status: 'delivered',
      sid: 'SMann',
    });
    expect(f.messages[0]?.delivery_recipients?.[MARCUS_KEY]?.status).toBe('sent');
  });

  it('drains OUT OF ORDER receipts to the furthest-forward state', async () => {
    const f = makeFakes({ message: undefined });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'delivered' });
    await f.service.applyReceipt({ messageSid: 'IMposted1', participantSid: 'MBann', status: 'sent' });
    f.messages.push(outboundGroupMessage());
    await f.service.drainParked('IMposted1');
    expect(f.messages[0]?.delivery_recipients?.[ANN_KEY]?.status).toBe('delivered');
  });

  it('draining with nothing parked is a cheap no-op', async () => {
    const f = makeFakes();
    expect(await f.service.drainParked('IMposted1')).toBe(0);
  });

  // THE DEFECT THIS PINS (fix wave 4, X2/C2). The park and the send's own drain
  // race with no synchronisation: the park PutItem can still be IN FLIGHT while
  // `drainParked` lists an empty set, so the park lands AFTER the only drain
  // that would ever have run for it. The receipt was then stranded until its 24h
  // TTL - the slot reading `Delivered 0/N` forever for a message that WAS
  // delivered, and the staleness alarm ten minutes later blaming a Conversations
  // webhook that is working perfectly. Whichever side loses the race must still
  // converge, so the parking side re-reads once and applies what it just parked.
  it('APPLIES a receipt whose message row appears while the park is in flight', async () => {
    const f = makeFakes({ message: undefined });
    // The append commits mid-park - exactly the window the send's drain misses.
    f.hooks.onPark = () => {
      f.messages.push(outboundGroupMessage());
    };

    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
      channelMessageSid: 'SMann',
    });

    expect(out).toEqual({ outcome: 'applied', memberKey: ANN_KEY });
    expect(f.messages[0]?.delivery_recipients?.[ANN_KEY]).toMatchObject({
      status: 'delivered',
      sid: 'SMann',
    });
    // ...and the park row is consumed, so a later drain cannot re-apply it.
    expect(f.parked.get('IMposted1')?.size ?? 0).toBe(0);
  });

  it('leaves the receipt parked when the message still does not exist after the park', async () => {
    const f = makeFakes({ message: undefined });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'delivered',
    });
    expect(out).toEqual({ outcome: 'parked' });
    expect(f.parked.get('IMposted1')?.size).toBe(1);
  });

  it('BOUNDS the park: past the cap a receipt is dropped with a counter, never accrued forever', async () => {
    const f = makeFakes({ message: undefined });
    for (let i = 0; i < 10; i += 1) {
      await f.service.applyReceipt({
        messageSid: 'IMposted1',
        participantSid: `MB${i}`,
        status: 'sent',
      });
    }
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBeleventh',
      status: 'sent',
    });
    expect(out).toEqual({ outcome: 'dropped', reason: 'park_bounded' });
    expect(
      f.capture.atLevel(WARN).some((l) => l['event'] === 'group_receipt_park_bounded'),
    ).toBe(true);
  });

  it('an IGNORED status for an unknown message is dropped WITHOUT parking (nothing would ever apply)', async () => {
    const f = makeFakes({ message: undefined });
    const out = await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBann',
      status: 'queued',
    });
    expect(out.outcome).toBe('ignored');
    expect(f.parked.size).toBe(0);
  });
});

describe('21610 - the suppression bookkeeping nobody else does', () => {
  const marcusContact = (): ContactItem =>
    ({ contactId: 'contact-marcus', type: 'tenant', phone: '+16175550222' }) as ContactItem;

  it('records number-scoped suppression through the SAME seam the roster chip reads', async () => {
    const f = makeFakes({ contacts: [marcusContact()] });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '21610',
      channelMessageSid: 'SMmarcus',
    });

    expect(f.flagWrites).toEqual([
      { contactId: 'contact-marcus', flag: 'sms_opt_out', value: true },
    ]);
    // The member's OWN 1:1 is what gets the conversation flag - NEVER the group.
    expect(f.optOutSets).toEqual([{ conversationId: '1to1-+16175550222', value: true }]);
    expect(f.conversations.get('group-1')?.sms_opt_out).toBeUndefined();
    expect(f.audits[0]).toMatchObject({
      entityKey: 'contacts#contact-marcus',
      eventType: 'sms_opt_out_recorded',
      payload: { source: 'twilio_21610_group', groupConversationId: 'group-1' },
    });
  });

  it('NORMALIZES the slot error code to contact_opted_out so the UI actually shows it', async () => {
    const f = makeFakes({ contacts: [marcusContact()] });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '21610',
    });
    // The raw 21610 would render as a hard FAILURE in the delivery rollup and
    // leave the "N members opted out" note silent - the note counts exactly this
    // synthetic code, which the relay fan-out already writes.
    expect(slot(f, MARCUS_KEY)).toMatchObject({
      status: 'failed',
      errorCode: SUPPRESSED_ERROR_CODE,
    });
  });

  it('is IDEMPOTENT - a redelivered 21610 writes the suppression and its audit exactly once', async () => {
    const f = makeFakes({ contacts: [marcusContact()] });
    const receipt = {
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '21610',
    };
    await f.service.applyReceipt(receipt);
    await f.service.applyReceipt(receipt);
    expect(f.flagWrites).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
  });

  it('a later START restores through the same seam', async () => {
    const f = makeFakes({ contacts: [marcusContact()] });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '21610',
    });
    expect(f.contacts[0]?.sms_opt_out).toBe(true);

    // What the inbound START path does (services/numberSuppression.ts), driven
    // directly so the restoration is proven against the SAME state this wrote.
    await applyNumberSuppression(
      {
        contactsRepo: {
          setFlag: async (contactId, flag) => {
            f.flagWrites.push({ contactId, flag, value: true });
          },
          clearFlag: async (contactId, flag) => {
            f.flagWrites.push({ contactId, flag, value: false });
            const c = f.contacts.find((x) => x.contactId === contactId);
            if (c) c.sms_opt_out = false;
          },
        },
        conversationsRepo: {
          setSmsOptOut: async (conversationId, value) => {
            f.optOutSets.push({ conversationId, value });
            const conv = f.conversations.get(conversationId);
            if (conv) conv.sms_opt_out = value;
          },
        },
        auditRepo: { append: async () => {} },
      },
      {
        phone: '+16175550222',
        suppressed: false,
        contact: f.contacts[0],
        conversation: async () => f.conversations.get('1to1-+16175550222') as ConversationItem,
        source: 'inbound_keyword',
      },
    );

    expect(f.contacts[0]?.sms_opt_out).toBe(false);
    expect(f.conversations.get('1to1-+16175550222')?.sms_opt_out).toBe(false);
  });

  it('records nothing but still applies the status when the number has no contact record', async () => {
    const f = makeFakes({ contacts: [] });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '21610',
    });
    expect(f.flagWrites).toEqual([]);
    expect(slot(f, MARCUS_KEY)?.errorCode).toBe(SUPPRESSED_ERROR_CODE);
  });

  it('a NON-21610 failure keeps its real Twilio code (only suppression is normalized)', async () => {
    const f = makeFakes({ contacts: [marcusContact()] });
    await f.service.applyReceipt({
      messageSid: 'IMposted1',
      participantSid: 'MBmarcus',
      status: 'failed',
      errorCode: '30007',
    });
    expect(slot(f, MARCUS_KEY)?.errorCode).toBe('30007');
    expect(f.flagWrites).toEqual([]);
  });
});
