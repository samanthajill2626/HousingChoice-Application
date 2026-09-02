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
// THE INLINE BUDGET, MEASURED (fix wave 5, conformance F3). Spec 7 sizes this
// handler at "two bounded writes ... anything heavier moves behind
// jobs.enqueue()", citing Twilio's 5s Conversations-webhook timeout. What one
// `applyReceipt` actually performs, worst case and sequentially:
//   1. the provider-sid read;
//   2. on a miss, a 250ms sleep plus a SECOND read (UNKNOWN_MESSAGE_RETRY_DELAY_MS);
//   3. a conversation read, only when the message's own MBxx snapshot misses;
//   4. on a 21610 leg only: a contact read, a suppression read, a
//      createOrGetByParticipantPhone write, an opt-out write and an audit write;
//   5. the guarded slot update - the authoritative write;
//   6. a re-read plus the aggregate write.
// That is up to ~8 round trips plus one deliberate 250ms sleep: comfortably
// inside 5s at DynamoDB single-digit-ms latencies, and nowhere near "two
// writes". The excess is not incidental - spec 15.2a MANDATES the park-and-retry
// that forces (2), and (4) is the suppression bookkeeping nobody else does.
// Moving any of it behind jobs.enqueue() would break the one property the whole
// path is built on: a receipt is applied, or it is parked, before we ack. So the
// budget prose is superseded here deliberately, and this is the record of it -
// the constraint that actually binds is the 5s wall clock, which is measured
// against, not the write count.
//
// PII (doc 9): ids, codes and counts only.
import { summarizeError } from '../lib/errors.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
import { normalizeTwilioTransportEvidence } from '../adapters/twilioMessageTransport.js';
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
import { deriveGroupDeliveryStatus, SUPPRESSED_ERROR_CODE } from './groupDelivery.js';
import { applyNumberSuppression, readNumberSuppression } from './numberSuppression.js';

/** Twilio's per-recipient opt-out refusal. */
export const OPT_OUT_ERROR_CODE = '21610';

/**
 * What a 21610 leg's slot records instead of the raw Twilio code (S4's open
 * question N11, ruled by the orchestrator). Defined in `services/groupDelivery`
 * so the SEND path can seed the same value for a member it already knows is
 * suppressed (L3), and re-exported here because this module is where the rest of
 * the app has always imported it from.
 */
export { SUPPRESSED_ERROR_CODE };

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

/**
 * How long a park may sit before its eventual drain is worth a WARN.
 *
 * THE COUNTER FOR AN ORPHANED PARK, AND ITS HONEST LIMIT (fix wave 5,
 * conformance F9). A park whose message row NEVER appears is reaped only by the
 * 24h TTL, silently. There is no sweep that could find it: parked receipts live
 * one partition per IMxx (`groupreceipt#<IMxx>`), so enumerating them across
 * messages would be a table scan or a new GSI - neither of which this feature's
 * scale justifies. What IS countable without either is the PAIR of events this
 * module already emits per receipt: `group_receipt_parked` at park time and
 * `group_receipt_drained` at drain time. Their difference over a window is the
 * orphan rate, and it is a CloudWatch metric filter away. This threshold adds
 * the third signal - a park that was drained, but far too late - so a slow
 * append and a never-appended message are distinguishable rather than both
 * being silence.
 */
export const PARKED_RECEIPT_STALE_MS = 15 * 60 * 1000;

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
    | 'getByTsMsgId'
    | 'updateDeliveryStatus'
    | 'updateRecipientDeliveryStatus'
    | 'setRecipientDeliverySid'
    | 'setRecipientActualTransport'
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
  /**
   * SSE bus. A per-recipient delivery move changes what the open group thread
   * renders, so this path has to push it - see the emit in `applyToMessage`.
   */
  events?: EventBus;
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
  const events = deps.events ?? appEvents;
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

  /**
   * Derive and write the message's AGGREGATE `delivery_status` from its slots
   * (spec 4.3 - "the aggregate derives as relay/broadcast conventions do").
   *
   * WHY IT RE-READS. Two receipts for one message land concurrently. Deriving
   * from the copy this call already holds means each one sees only its own
   * transition, both derive `queued`, both skip - and the aggregate stays
   * `queued` on a fully delivered send. That is the broadcast-DLR-rollup race,
   * and it is why this takes one point GET (both key parts are in hand) after
   * its own write has committed: the LAST writer's re-read is after every other
   * writer's commit, so somebody always sees the finished picture. Our own
   * transition is merged in regardless, so an eventually-consistent read can
   * never lose the change we just made.
   *
   * BEST-EFFORT: the per-member slots are the truth the thread renders, and this
   * is a derived summary. A failure here must never fail a receipt that was
   * already applied, so it is logged and swallowed.
   */
  async function rollUpAggregate(
    message: MessageItem,
    applied: { memberKey: string; status: DeliveryStatus; errorCode: string | undefined },
  ): Promise<void> {
    try {
      const fresh = await messages.getByTsMsgId(message.conversationId, message.tsMsgId);
      const slots = { ...(fresh ?? message).delivery_recipients };
      slots[applied.memberKey] = {
        ...slots[applied.memberKey],
        status: applied.status,
        ...(applied.errorCode !== undefined && { errorCode: applied.errorCode }),
      };
      const rollup = deriveGroupDeliveryStatus(Object.values(slots));
      // `queued` is the seeded value: writing it would fail the forward-only
      // guard and log a spurious "would regress" line on every ordinary receipt.
      if (rollup.status === 'queued') return;
      if (rollup.status === (fresh ?? message).delivery_status) return;
      await messages.updateDeliveryStatus(
        (fresh ?? message).provider_sid,
        rollup.status,
        rollup.errorCode,
      );
    } catch (err) {
      log.warn(
        {
          err,
          event: 'group_delivery_rollup_failed',
          conversationId: message.conversationId,
          providerSid: message.provider_sid,
        },
        'group aggregate delivery_status derivation failed - the per-member slots are still correct',
      );
    }
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

    // The source row carries the group adapter's authoritative rail fact. A
    // receipt ChannelMessageSid can corroborate that fact or raise a safe
    // conflict warning, but it can never create or replace it.
    if (
      input.channelMessageSid !== undefined &&
      message.requested_transport !== undefined &&
      message.actual_transport !== undefined
    ) {
      const channelEvidence = normalizeTwilioTransportEvidence({
        direction: 'outbound',
        requestedTransport: message.requested_transport,
        messageSid: input.channelMessageSid,
        authenticatedProviderTraffic: true,
      });
      if (
        channelEvidence.kind === 'conflict' ||
        (channelEvidence.kind === 'observed' &&
          channelEvidence.transport !== message.actual_transport)
      ) {
        log.warn(
          {
            event: 'group_receipt_transport_evidence_conflict',
            providerSid: input.messageSid,
            requestedTransport: message.requested_transport,
            authoritativeTransport: message.actual_transport,
            ...(channelEvidence.kind === 'observed'
              ? {
                  observedTransport: channelEvidence.transport,
                  evidenceSource: channelEvidence.source,
                }
              : {
                  evidenceSource: channelEvidence.source,
                  ...channelEvidence.safeFacts,
                }),
          },
          'group receipt channel evidence conflicted with the authoritative native-group rail',
        );
      }
    }

    const actualOutcome =
      message.actual_transport === undefined
        ? undefined
        : await messages.setRecipientActualTransport(
            message.conversationId,
            message.tsMsgId,
            memberKey,
            message.actual_transport,
          );
    const actualUpdated = actualOutcome === 'updated';

    let effectiveErrorCode = input.errorCode;
    if (input.errorCode === OPT_OUT_ERROR_CODE) {
      // BEST EFFORT, LIKE EVERY OTHER DERIVED BOOKKEEPING STEP IN THIS MODULE
      // (fix wave 5, adversarial 8). recordSuppression performs four to six repo
      // operations, and it runs BEFORE the authoritative slot write. Unguarded,
      // any one of them throwing propagated out of applyReceipt into the route's
      // catch-all, which logs and returns 200 - so the delivery outcome was
      // never written, the receipt was not parked (parking only happens on an
      // unknown IMxx), Twilio did not redeliver because we returned 200 by
      // design, and ten minutes later sweepSendStaleness alarmed
      // `group_send_receipts_stale` at ERROR pointing the operator at a
      // perfectly healthy webhook. The receipt is the fact; the suppression
      // bookkeeping is derived from it, and derived work never takes the fact
      // down with it (see rollUpAggregate, which already says exactly this).
      try {
        await recordSuppression(memberKey, message, input.channelMessageSid);
      } catch (err) {
        log.warn(
          {
            err: summarizeError(err),
            event: 'group_receipt_suppression_failed',
            conversationId: message.conversationId,
            providerSid: input.messageSid,
          },
          'group 21610 suppression bookkeeping failed - the delivery receipt is still applied',
        );
      }
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
    if (applied) {
      // Spec 4.3's aggregate, derived from the slots this transition just moved.
      await rollUpAggregate(message, {
        memberKey,
        status: ruling.status,
        errorCode: effectiveErrorCode,
      });
    }

    // A status no-op does not make the provider SID disposable. Keep this
    // independent of the transport outcome as well, so a transport-only update
    // cannot return before the established sid-if-absent behavior runs.
    if (!applied && input.channelMessageSid !== undefined) {
      await messages.setRecipientDeliverySid(
        message.conversationId,
        message.tsMsgId,
        memberKey,
        input.channelMessageSid,
      );
    }

    if (applied || actualUpdated) {
      // REFRESH THE UI. A per-recipient delivery or transport move re-renders the group
      // thread, exactly as it re-renders the relay thread - the relay status
      // route emits this same event immediately after its own successful
      // transition (routes/webhooks/twilio.ts, "a per-recipient delivery move
      // re-renders the relay thread"). Group did NOT inherit that, and live dev
      // showed the cost: a reply reached both handsets while the open thread
      // read `Delivered 0/2` until the operator refreshed the page.
      //
      // Emitted ONLY on a real transition, so a duplicate/out-of-order receipt
      // costs no SSE traffic. Receipts arrive on the APP process (the
      // Conversations webhook), so this reaches SSE clients directly; the
      // worker-side drains ride the cross-process event bridge as every other
      // worker emit does. `direction` is the message's own - a group send's
      // delivery map hangs off an OUTBOUND row - rather than relay's hard-coded
      // 'inbound', which is true only of a relay SOURCE message.
      events.emit('message.persisted', {
        conversationId: message.conversationId,
        tsMsgId: message.tsMsgId,
        direction: message.direction,
        deliveryStatus:
          applied
            ? ruling.status
            : (message.delivery_recipients?.[memberKey]?.status ?? message.delivery_status),
      });
      return { outcome: 'applied', memberKey };
    }

    return { outcome: 'duplicate', memberKey };
  }

  async function park(
    input: GroupReceiptInput,
    ruling: { status: DeliveryStatus },
  ): Promise<GroupReceiptOutcome> {
    // BEST EFFORT BY CONSTRUCTION, AND NOW MUCH TIGHTER (fix wave 5,
    // adversarial 17). DynamoDB cannot make a Put conditional on a PARTITION's
    // cardinality, only on the item being written - so a true cardinality fence
    // would need a counter item and a transaction on every park, which is real
    // cost on a 5s-budget webhook handler to defend a bound whose only job is
    // stopping row accrual. What the read below now is, instead, is STRONGLY
    // CONSISTENT (see listParkedGroupReceipts), which removes read lag as a way
    // to blow past the cap and leaves only a genuine same-instant interleave.
    // Exceeding the bound by a few rows under that interleave is accepted: the
    // rows carry a 24h TTL and the route is signature-gated, so the harm is
    // bounded either way.
    const existing = await messages.listParkedGroupReceipts(input.messageSid);
    const isNewSlot = !existing.some((p) => p.participantSid === input.participantSid);
    if (isNewSlot && existing.length >= MAX_PARKED_GROUP_RECEIPTS) {
      log.error(
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
      log.error(
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
        // A park that sat far longer than the send path's drain window means the
        // message row took minutes to exist (or never did until the staleness
        // sweep found it). Countable, per receipt (fix wave 5, conformance F9).
        const ageMs = Date.parse(receipt.parkedAt);
        if (Number.isFinite(ageMs) && now().getTime() - ageMs >= PARKED_RECEIPT_STALE_MS) {
          log.warn(
            {
              event: 'group_receipt_park_stale',
              providerSid,
              parkedAt: receipt.parkedAt,
              ageMs: now().getTime() - ageMs,
            },
            'a parked group delivery receipt sat well past its drain window before being applied',
          );
        }
      }
      log.info(
        { event: 'group_receipts_drained', providerSid, drained },
        'parked group delivery receipts applied after the message append',
      );
      return drained;
    },
  };
}
