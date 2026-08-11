// Group delivery receipts (group-texting spec 7, as amended by spec 16.2).
//
// A Conversations `onDeliveryUpdated` event is the ONLY source of per-member
// delivery state for a native group text. The S5-PRE addendum proved live that
// classic Programmable Messaging status callbacks do NOT fire for
// Conversations-originated sends: zero callbacks over a window where both legs
// reached `delivered`. So there is no second channel, no `syssid#` marker to
// write (there is nothing to suppress) and no parked classic DLR - all three
// were dropped from this slice. What remains is this path plus the per-send
// staleness alarm, which is now the only thing that notices if this path dies.
//
// THREE THINGS EACH RECEIPT NEEDS, and where each comes from:
//   IMxx (MessageSid)      -> the message row, via the provider-sid pointer
//   MBxx (ParticipantSid)  -> the member key, via the message's OWN snapshot
//                             first and the thread's current map second
//   Status/ErrorCode       -> an EXPLICIT mapping table, never mapTwilioStatus
//
// WHY NOT `mapTwilioStatus`: it is total, with `default: 'queued'`. Feeding it
// a Conversations status vocabulary it was never written for cannot crash - it
// SILENTLY MISCLASSIFIES, and the misclassification then fails the forward-only
// guard and disappears as an INFO line. A wrong delivery state that leaves no
// trace is worse than a loud drop, so unmapped values are WARNed and counted.
//
// WHY AN EARLY RECEIPT IS PARKED AND NEVER "MAPPED TO QUEUED": the slot is
// SEEDED `queued` at append, and ALLOWED_PRIOR.queued is ['queued_pending'] -
// so `queued` can never be re-applied. A receipt that beats its own append has
// to wait for the append, which is exactly what parking is.
//
// PII (doc 9): ids, codes and counts only.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  type DeliveryStatus,
  type MessageItem,
  type MessagesRepo,
  type ParkedGroupReceipt,
} from '../repos/messagesRepo.js';
import { applyNumberSuppression, readNumberSuppression } from './numberSuppression.js';

/** Twilio's per-recipient opt-out refusal. */
export const OPT_OUT_ERROR_CODE = '21610';

/**
 * What a 21610 leg's slot records instead of the raw Twilio code (S4's open
 * question N11, ruled by the orchestrator). `contact_opted_out` is the value
 * the rest of the app ALREADY reads: the timeline's "N members opted out" note
 * counts it, and the delivery rollup excludes those legs from `delivered N/M`
 * rather than painting the chip red. Leaving the raw `21610` there would render
 * a suppressed member as a hard FAILURE and leave the note silent - a
 * suppression the UI cannot see is not a suppression. The relay fan-out writes
 * this same synthetic code for the same reason.
 */
export const SUPPRESSED_ERROR_CODE = 'contact_opted_out';

/**
 * How long to wait once before deciding an IMxx is genuinely unknown. The send
 * posts and then appends, so the window is milliseconds; this mirrors the
 * classic status route's one-retry seam (webhooks/twilio.ts).
 */
export const UNKNOWN_MESSAGE_RETRY_DELAY_MS = 250;

/**
 * Most parked slots one IMxx may hold. A rail caps at 10 participants, so a
 * legitimate send cannot exceed that; the bound stops a stream of receipts
 * carrying forged ParticipantSids from accruing rows against a message that
 * will never exist.
 */
export const MAX_PARKED_GROUP_RECEIPTS = 10;

/** Cleanup horizon for a parked receipt. TTL is never the drain (spec 15.5). */
export const PARKED_RECEIPT_CLEANUP_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The EXPLICIT Conversations delivery-status map
// ---------------------------------------------------------------------------

type StatusRuling =
  | { kind: 'apply'; status: DeliveryStatus }
  /** Known, but there is nothing to record - counted, not warned. */
  | { kind: 'ignore'; reason: string };

const CONVERSATIONS_DELIVERY_STATUS: Record<string, StatusRuling> = {
  sent: { kind: 'apply', status: 'sent' },
  delivered: { kind: 'apply', status: 'delivered' },
  undelivered: { kind: 'apply', status: 'undelivered' },
  failed: { kind: 'apply', status: 'failed' },
  // `read` is a state PAST delivered that our machine does not model. Mapping
  // it to `delivered` would be a lie on any channel that reports both.
  read: { kind: 'ignore', reason: 'read is past delivered and has no slot state' },
  // Non-terminal. The slot is already seeded `queued` and `queued` can only
  // follow `queued_pending`, so applying these would fail the forward-only
  // guard and emit a "would regress" line for every ordinary send.
  queued: { kind: 'ignore', reason: 'non-terminal; the slot is already seeded queued' },
  sending: { kind: 'ignore', reason: 'non-terminal; the slot is already seeded queued' },
  accepted: { kind: 'ignore', reason: 'non-terminal; the slot is already seeded queued' },
  scheduled: { kind: 'ignore', reason: 'non-terminal; the slot is already seeded queued' },
};

/** The ruling for a raw Conversations status, or undefined when UNMAPPED. */
export function conversationsStatusRuling(status: string): StatusRuling | undefined {
  return CONVERSATIONS_DELIVERY_STATUS[status.trim().toLowerCase()];
}

/**
 * Forward-only ordering used to coalesce within one PARKED slot.
 *
 * DELIBERATELY COARSER than the real slot's guard: every terminal status shares
 * rank 2, so `delivered`, `failed` and `undelivered` are interchangeable here
 * and the last writer wins. A leg reaches exactly one terminal state, so a
 * second terminal for the same MBxx is not a state a carrier produces - and the
 * moment the park drains, `updateRecipientDeliveryStatus`'s prior-status
 * condition applies the strict ordering anyway.
 */
export function receiptRank(status: string): number {
  const ruling = conversationsStatusRuling(status);
  if (ruling === undefined || ruling.kind === 'ignore') return 0;
  return ruling.status === 'sent' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface GroupReceiptInput {
  /** IMxx. */
  messageSid: string;
  /** MBxx. */
  participantSid: string;
  /** RAW Conversations status. */
  status: string;
  errorCode?: string;
  /** The per-member carrier SID (SMxx). */
  channelMessageSid?: string;
  /** CHxx - log context only; attribution goes through the snapshot. */
  conversationSid?: string;
}

export type GroupReceiptOutcome =
  | { outcome: 'applied'; memberKey: string }
  /** The status is known but records nothing (`read`, non-terminal). */
  | { outcome: 'ignored'; reason: string }
  /** Applied nowhere because the transition would regress - a duplicate. */
  | { outcome: 'duplicate'; memberKey: string }
  | { outcome: 'parked' }
  | { outcome: 'dropped'; reason: string };

export interface GroupReceiptsServiceDeps {
  logger?: Logger;
  messagesRepo?: Pick<
    MessagesRepo,
    | 'getByProviderSid'
    | 'updateRecipientDeliveryStatus'
    | 'setRecipientDeliverySid'
    | 'parkGroupReceipt'
    | 'listParkedGroupReceipts'
    | 'deleteParkedGroupReceipt'
  >;
  conversationsRepo?: Pick<
    ConversationsRepo,
    'getById' | 'findByParticipantPhone' | 'createOrGetByParticipantPhone' | 'setSmsOptOut'
  >;
  contactsRepo?: Pick<ContactsRepo, 'findByPhone' | 'setFlag' | 'clearFlag'>;
  auditRepo?: Pick<AuditRepo, 'append'>;
  /** Test seam - keeps the unknown-IMxx retry from costing 250ms per case. */
  unknownMessageRetryDelayMs?: number;
  now?: () => Date;
}

export interface GroupReceiptsService {
  /** Apply ONE `onDeliveryUpdated` event. Never throws for an unknown IMxx. */
  applyReceipt(input: GroupReceiptInput): Promise<GroupReceiptOutcome>;
  /**
   * Drain every receipt parked for an IMxx now that its message row exists.
   * THREE things run it, because one point-in-time call is not a recovery path:
   * the send path immediately after its append (the common case), the park
   * itself when the append commits mid-park, and the T6.4 staleness sweep before
   * it decides a send is stale. Returns how many parked receipts were consumed.
   */
  drainParked(providerSid: string): Promise<number>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createGroupReceiptsService(
  deps: GroupReceiptsServiceDeps = {},
): GroupReceiptsService {
  const log = deps.logger ?? defaultLogger;
  const loggerDep = deps.logger !== undefined ? { logger: deps.logger } : {};
  const messages = deps.messagesRepo ?? createMessagesRepo(loggerDep);
  const conversations = deps.conversationsRepo ?? createConversationsRepo(loggerDep);
  const contacts = deps.contactsRepo ?? createContactsRepo(loggerDep);
  const audit = deps.auditRepo ?? createAuditRepo(loggerDep);
  const retryDelayMs = deps.unknownMessageRetryDelayMs ?? UNKNOWN_MESSAGE_RETRY_DELAY_MS;
  const now = deps.now ?? ((): Date => new Date());

  /**
   * MBxx -> member key. The message's OWN snapshot wins: it is what the rail
   * looked like when THIS message went out, so a recreated rail (fresh MBxx
   * values) cannot make an in-flight message's receipts unattributable. The
   * thread's current map is the fallback for anything sent before snapshots
   * existed or written by a path that did not snapshot.
   */
  async function resolveMemberKey(
    message: MessageItem,
    participantSid: string,
  ): Promise<string | undefined> {
    const snapshot = message.group_participant_map?.[participantSid];
    if (snapshot !== undefined && snapshot.length > 0) return snapshot;
    const conversation = await conversations.getById(message.conversationId);
    const current = conversation?.twilio_participant_map?.[participantSid];
    return current !== undefined && current.length > 0 ? current : undefined;
  }

  /**
   * Number-scoped suppression bookkeeping for a 21610 leg (spec 15.8). The
   * classic /status route does this for 1:1 sends; a Conversations receipt never
   * reaches that route, so if this did not do it, NOBODY would - the member
   * would stay "reachable" everywhere in the app while Twilio refuses them.
   *
   * It goes through the SAME seam the roster chip reads (`readNumberSuppression`
   * / `applyNumberSuppression`), which is the binding constraint recorded in
   * `docs/issues/relay-member-suppression-diverges-from-number-seam.md`: the
   * chip and this path must never disagree about one handset.
   *
   * IDEMPOTENT: a redelivered receipt reads the current state first and writes
   * nothing when the number is already suppressed, so the audit trail records
   * the suppression ONCE.
   */
  async function recordSuppression(
    memberKey: string,
    message: MessageItem,
    channelMessageSid: string | undefined,
  ): Promise<void> {
    const phone = memberKey.startsWith('phone#') ? memberKey.slice('phone#'.length) : undefined;
    if (phone === undefined) {
      log.warn(
        { event: 'group_receipt_suppression_unkeyed', conversationId: message.conversationId },
        'group 21610 receipt: member key is not phone-scoped, suppression bookkeeping skipped',
      );
      return;
    }
    const contact = await contacts.findByPhone(phone);
    const state = await readNumberSuppression(
      { contactsRepo: contacts, conversationsRepo: conversations },
      phone,
      { contact },
    );
    if (state.suppressed) return;
    await applyNumberSuppression(
      { contactsRepo: contacts, conversationsRepo: conversations, auditRepo: audit, logger: log },
      {
        phone,
        suppressed: true,
        contact,
        // LAZY, and materializing the member's OWN 1:1 is correct here: this is
        // a real opt-out and setSmsOptOut needs a target. It is NEVER the group
        // thread (spec 4.4) - a group-origin STOP must not suppress the group.
        conversation: () =>
          conversations.createOrGetByParticipantPhone(phone, conversationTypeFor(contact)),
        source: 'twilio_21610_group',
        ...(channelMessageSid !== undefined && { providerSid: channelMessageSid }),
        auditContext: { groupConversationId: message.conversationId },
      },
    );
  }

  async function applyToMessage(
    message: MessageItem,
    input: GroupReceiptInput,
    ruling: { status: DeliveryStatus },
  ): Promise<GroupReceiptOutcome> {
    const memberKey = await resolveMemberKey(message, input.participantSid);
    if (memberKey === undefined) {
      // A KNOWN message with an UNKNOWN participant: the rail was recreated and
      // this message predates the snapshot, or Twilio sent a participant we
      // never attached. Loud, never silent (spec 7).
      log.warn(
        {
          event: 'group_receipt_unknown_participant',
          conversationId: message.conversationId,
          providerSid: input.messageSid,
        },
        'group delivery receipt for a participant this message cannot resolve - dropped',
      );
      return { outcome: 'dropped', reason: 'unknown_participant' };
    }

    let effectiveErrorCode = input.errorCode;
    if (input.errorCode === OPT_OUT_ERROR_CODE) {
      await recordSuppression(memberKey, message, input.channelMessageSid);
      effectiveErrorCode = SUPPRESSED_ERROR_CODE;
    }

    const applied = await messages.updateRecipientDeliveryStatus(
      message.conversationId,
      message.tsMsgId,
      memberKey,
      ruling.status,
      effectiveErrorCode,
      {
        ...(input.channelMessageSid !== undefined && { sid: input.channelMessageSid }),
        context: 'group',
      },
    );
    if (applied) return { outcome: 'applied', memberKey };

    // The transition was refused as a regression - a duplicate or out-of-order
    // receipt. Its SID is still worth having: keep it if the slot has none.
    if (input.channelMessageSid !== undefined) {
      await messages.setRecipientDeliverySid(
        message.conversationId,
        message.tsMsgId,
        memberKey,
        input.channelMessageSid,
      );
    }
    return { outcome: 'duplicate', memberKey };
  }

  async function park(
    input: GroupReceiptInput,
    ruling: { status: DeliveryStatus },
  ): Promise<GroupReceiptOutcome> {
    const existing = await messages.listParkedGroupReceipts(input.messageSid);
    const isNewSlot = !existing.some((p) => p.participantSid === input.participantSid);
    if (isNewSlot && existing.length >= MAX_PARKED_GROUP_RECEIPTS) {
      log.warn(
        { event: 'group_receipt_park_bounded', providerSid: input.messageSid },
        'group delivery receipt dropped: too many parked receipts already held for this message',
      );
      return { outcome: 'dropped', reason: 'park_bounded' };
    }
    const at = now();
    await messages.parkGroupReceipt(
      {
        messageSid: input.messageSid,
        participantSid: input.participantSid,
        status: input.status,
        ...(input.errorCode !== undefined && { errorCode: input.errorCode }),
        ...(input.channelMessageSid !== undefined && { channelMessageSid: input.channelMessageSid }),
        parkedAt: at.toISOString(),
      },
      {
        rank: receiptRank(input.status),
        expiresAt: Math.floor((at.getTime() + PARKED_RECEIPT_CLEANUP_MS) / 1000),
      },
    );
    log.info(
      { event: 'group_receipt_parked', providerSid: input.messageSid },
      'group delivery receipt arrived before its message - parked for the post-append drain',
    );

    // CLOSE THE LOST-UPDATE WINDOW AT ITS SOURCE. The send drains parked
    // receipts right after its append, and this park can still be IN FLIGHT
    // while that drain lists an empty set - in which case the park lands after
    // the only drain that would ever have run for it. Re-reading the message
    // here means whichever side loses the race still converges: if the append
    // committed while we were parking, we apply the receipt ourselves and
    // consume the row. Without this, the slot reads `Delivered 0/N` forever for
    // a message that WAS delivered, and the staleness alarm fires ten minutes
    // later blaming a webhook that is working perfectly.
    const message = await messages.getByProviderSid(input.messageSid);
    if (message === undefined) return { outcome: 'parked' };
    const applied = await applyToMessage(message, input, ruling);
    await messages.deleteParkedGroupReceipt(input.messageSid, input.participantSid);
    log.info(
      { event: 'group_receipt_park_raced', providerSid: input.messageSid },
      'the message row appeared while its receipt was parking - applied directly and the park consumed',
    );
    return applied;
  }

  async function applyOne(
    input: GroupReceiptInput,
    opts: { allowPark: boolean },
  ): Promise<GroupReceiptOutcome> {
    const ruling = conversationsStatusRuling(input.status);
    if (ruling === undefined) {
      log.warn(
        { event: 'group_receipt_status_unmapped', providerSid: input.messageSid, status: input.status },
        'group delivery receipt carries a status this app does not map - dropped rather than guessed',
      );
      return { outcome: 'dropped', reason: 'unmapped_status' };
    }
    if (ruling.kind === 'ignore') {
      log.info(
        { event: 'group_receipt_status_ignored', providerSid: input.messageSid, status: input.status },
        'group delivery receipt records no slot state',
      );
      return { outcome: 'ignored', reason: ruling.reason };
    }

    let message = await messages.getByProviderSid(input.messageSid);
    if (!message && opts.allowPark) {
      // ONE bounded retry first: the send posts and then appends, so the usual
      // race is milliseconds wide and parking it would be busywork.
      await delay(retryDelayMs);
      message = await messages.getByProviderSid(input.messageSid);
    }
    if (!message) {
      if (!opts.allowPark) return { outcome: 'dropped', reason: 'unknown_message' };
      return park(input, ruling);
    }
    return applyToMessage(message, input, ruling);
  }

  return {
    async applyReceipt(input) {
      return applyOne(input, { allowPark: true });
    },

    async drainParked(providerSid) {
      const parked: ParkedGroupReceipt[] = await messages.listParkedGroupReceipts(providerSid);
      if (parked.length === 0) return 0;
      const message = await messages.getByProviderSid(providerSid);
      if (!message) return 0;
      let drained = 0;
      for (const receipt of parked) {
        const ruling = conversationsStatusRuling(receipt.status);
        if (ruling !== undefined && ruling.kind === 'apply') {
          await applyToMessage(
            message,
            {
              messageSid: providerSid,
              participantSid: receipt.participantSid,
              status: receipt.status,
              ...(receipt.errorCode !== undefined && { errorCode: receipt.errorCode }),
              ...(receipt.channelMessageSid !== undefined && {
                channelMessageSid: receipt.channelMessageSid,
              }),
            },
            ruling,
          );
        }
        await messages.deleteParkedGroupReceipt(providerSid, receipt.participantSid);
        drained += 1;
      }
      log.info(
        { event: 'group_receipts_drained', providerSid, drained },
        'parked group delivery receipts applied after the message append',
      );
      return drained;
    },
  };
}
