// SES delivery-event application (email-channel v1, Task B5): turn a parsed
// bounce/complaint/delivery notification into delivery-status + contact
// suppression, with the plan-F12 orphan-event PARKING LOT for the fast-bounce
// race. Consumed by BOTH delivery mechanisms (the worker's inbound SQS consumer
// and the dev-gated webhook route) via the B4 applyEmailEvent seam, and by A5's
// post-send applyParkedEmailEvents seam (ADJ-7).
//
// Behavior matrix (each an emailEvents.test.ts case):
//   Delivery              -> updateDeliveryStatus 'delivered'.
//   Bounce (any)          -> updateDeliveryStatus 'undelivered'.
//   Bounce 'Permanent'    -> ALSO set email_unreachable on the recipient contact
//                            + an audit event.
//   Bounce 'Transient'    -> status only (a retryable soft bounce; no flag).
//   Complaint             -> set email_opt_out on the contact + audit (no status
//                            change: a complaint means it WAS delivered).
// The forward-only delivery machine (updateDeliveryStatus) already SWALLOWS the
// ConditionalCheckFailedException on an out-of-order transition (delivered-after-
// undelivered), so this service never needs its own catch - it mirrors how the
// twilio DLR handlers treat a regressive callback.
//
// ORPHAN PARKING (plan F12): an outbound email persists under our OWN RFC id and
// only gets a `sid#<sesId>` alias AFTER adapter.send returns (A5). A fast bounce
// (or a crash between send-return and the alias write) can therefore arrive
// before getByProviderSid(sesId) resolves. Such an event is PARKED (not dropped);
// A5's post-send applyParkedEmailEvents applies + consumes it. Exactly-once: the
// DELETE is the consume marker; we apply-THEN-conditional-delete (crash-safe: a
// crash after apply re-applies harmlessly, the status machine being forward-only
// and the flag sets idempotent - delete-first would lose the event on a crash).
//
// PII (doc Sec 9): log ids/eventType only - never addresses/subject/body.
import type { Logger } from '../lib/logger.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { SesEventType, SnsSesEvent } from './sesNotifications.js';
import {
  createMessagesRepo,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createContactsRepo,
  type ContactFlag,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';

/** Parked-event TTL: 7 days (plan F12). A backstop for an event that never gets
 *  consumed (e.g. a bounce for a message this stack never actually sent) - the
 *  normal path deletes the item the moment A5's post-send seam applies it. */
export const PARKED_EMAIL_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EmailEventDeps {
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  auditRepo?: AuditRepo;
  logger?: Logger;
  /** Injected clock (tests + deterministic expires_at). */
  now?: () => Date;
}

/** The minimal event shape the applier acts on (SnsSesEvent satisfies it, and the
 *  parked record is re-hydrated into it). */
interface EmailEventCore {
  eventType: SesEventType;
  sesMessageId: string;
  bounceType?: string;
}

interface EventContext {
  messages: MessagesRepo;
  contacts: ContactsRepo;
  conversations: ConversationsRepo;
  audit: AuditRepo;
  log: Logger;
  now: () => Date;
}

function buildContext(deps: EmailEventDeps): EventContext {
  return {
    messages: deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger }),
    contacts: deps.contactsRepo ?? createContactsRepo({ logger: deps.logger }),
    conversations: deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger }),
    audit: deps.auditRepo ?? createAuditRepo({ logger: deps.logger }),
    log: deps.logger ?? defaultLogger,
    now: deps.now ?? (() => new Date()),
  };
}

/**
 * Resolve the contact owning the message's recipient address. PRIMARY: the
 * message's first To recipient via contacts.findByEmail (pointer-aware, so a
 * secondary address still resolves). FALLBACK: the conversation's contact (its
 * participants roster) - covers a message whose recipient address was later
 * removed from the contact.
 */
async function resolveRecipientContact(
  ctx: EventContext,
  message: MessageItem,
): Promise<ContactItem | undefined> {
  const recipient = Array.isArray(message.email_to) ? message.email_to[0] : undefined;
  if (typeof recipient === 'string' && recipient.length > 0) {
    const byEmail = await ctx.contacts.findByEmail(recipient);
    if (byEmail) return byEmail;
  }
  const conversation = await ctx.conversations.getById(message.conversationId);
  const contactId = conversation?.participants?.find((p) => p.contactId)?.contactId;
  if (contactId !== undefined) return ctx.contacts.getById(contactId);
  return undefined;
}

/** Set a suppression flag on the recipient contact + append an audit event. */
async function suppressContact(
  ctx: EventContext,
  message: MessageItem,
  event: EmailEventCore,
  flag: Extract<ContactFlag, 'email_opt_out' | 'email_unreachable'>,
  auditType: string,
): Promise<void> {
  const contact = await resolveRecipientContact(ctx, message);
  if (!contact) {
    ctx.log.warn(
      { sesMessageId: event.sesMessageId, flag },
      'email suppression event has no resolvable contact to flag - status updated only',
    );
    return;
  }
  await ctx.contacts.setFlag(contact.contactId, flag);
  await ctx.audit.append(`contacts#${contact.contactId}`, auditType, {
    sesMessageId: event.sesMessageId,
    conversationId: message.conversationId,
    ...(event.bounceType !== undefined && { bounceType: event.bounceType }),
  });
  ctx.log.info({ contactId: contact.contactId, sesMessageId: event.sesMessageId, flag }, 'email suppression recorded');
}

/** Apply an event to an ALREADY-RESOLVED message (shared by the live + parked
 *  paths). Idempotent: the status machine is forward-only, flag sets are no-ops
 *  once set (so a re-apply from a redelivery/parked-race is harmless). */
async function applyResolvedEvent(ctx: EventContext, event: EmailEventCore, message: MessageItem): Promise<void> {
  const sesId = event.sesMessageId;
  switch (event.eventType) {
    case 'Delivery':
      await ctx.messages.updateDeliveryStatus(sesId, 'delivered');
      return;
    case 'Bounce':
      // Every bounce -> undelivered; a bounceType rides as the errorCode for
      // display. A PERMANENT bounce also suppresses the address.
      await ctx.messages.updateDeliveryStatus(
        sesId,
        'undelivered',
        event.bounceType !== undefined ? `bounce:${event.bounceType}` : 'bounce',
      );
      if (event.bounceType === 'Permanent') {
        await suppressContact(ctx, message, event, 'email_unreachable', 'email_unreachable_recorded');
      }
      return;
    case 'Complaint':
      // A complaint means it WAS delivered - no status regression, just opt-out.
      await suppressContact(ctx, message, event, 'email_opt_out', 'email_opt_out_recorded');
      return;
  }
}

/**
 * The B4 applyEmailEvent seam: resolve the message via the SES MessageId (the A5
 * `sid#<sesId>` alias). RESOLVED -> apply. UNRESOLVED (F12 orphan) -> park + return
 * (never throw on an event: a throw would DLQ real mail / 5xx-retry the route).
 */
export function createApplyEmailEvent(deps: EmailEventDeps = {}): (event: SnsSesEvent) => Promise<void> {
  const ctx = buildContext(deps);
  return async function applyEmailEvent(event: SnsSesEvent): Promise<void> {
    const message = await ctx.messages.getByProviderSid(event.sesMessageId);
    if (!message) {
      const expiresAt = Math.floor((ctx.now().getTime() + PARKED_EMAIL_EVENT_TTL_MS) / 1000);
      await ctx.messages.putParkedEmailEvent(
        {
          eventType: event.eventType,
          sesMessageId: event.sesMessageId,
          ...(event.bounceType !== undefined && { bounceType: event.bounceType }),
        },
        { receivedAt: ctx.now().toISOString(), expiresAt },
      );
      ctx.log.info(
        { sesMessageId: event.sesMessageId, eventType: event.eventType },
        'SES event has no message yet (orphan) - parked for A5 post-send apply',
      );
      return;
    }
    await applyResolvedEvent(ctx, event, message);
  };
}

/**
 * The A5 post-send seam (ADJ-7): after A5 writes the `sid#<sesId>` alias, apply
 * any event parked for that SES id, then CONSUME it. Common case: nothing parked
 * -> a single cheap read. Exactly-once: apply-THEN-conditional-delete (see the
 * module header). The message alias exists by the time A5 calls us; if somehow
 * not, we leave the parked item for a later retry rather than lose it.
 */
export function createApplyParkedEmailEvents(deps: EmailEventDeps = {}): (sesMessageId: string) => Promise<void> {
  const ctx = buildContext(deps);
  return async function applyParkedEmailEvents(sesMessageId: string): Promise<void> {
    const parked = await ctx.messages.getParkedEmailEvent(sesMessageId);
    if (!parked) return;
    const message = await ctx.messages.getByProviderSid(sesMessageId);
    if (!message) {
      ctx.log.warn(
        { sesMessageId },
        'parked SES event still has no resolvable message - leaving parked (will retry)',
      );
      return;
    }
    await applyResolvedEvent(
      ctx,
      {
        eventType: parked.eventType as SesEventType,
        sesMessageId: parked.sesMessageId,
        ...(parked.bounceType !== undefined && { bounceType: parked.bounceType }),
      },
      message,
    );
    await ctx.messages.deleteParkedEmailEvent(sesMessageId);
    ctx.log.info({ sesMessageId, eventType: parked.eventType }, 'parked SES event applied + consumed');
  };
}
