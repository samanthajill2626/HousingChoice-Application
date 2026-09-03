// relay.retryLeg - one rung of the 30003 retry ladder for ONE relay leg.
//
// The claim lives in the status webhook (spec D3): it appends a NEW single-
// recipient source row carrying the lineage of the leg that failed, and enqueues
// this job with that row's key. This handler owns everything after the claim -
// the four send gates, the send itself, the status-preserving activity bump, the
// transient sub-ladder and the terminal closes.
//
// Three things about this file are easy to get wrong and are load-bearing:
//
//   - The per-leg send is NOT reimplemented here. `sendOneRelayLeg` (spec D10)
//     is the fan-out's own loop body, extracted; it presigns, writes the
//     delivery slot AND the `relaysid#` pointer. Nothing here repeats either
//     write, and on its `refused` / `filtered` / `suppressed` outcomes it has
//     ALREADY written a terminal slot with a specific error code - re-closing
//     would overwrite it with a vaguer one.
//   - The transport MODE is read off the RETRY ROW, not the root (spec D2).
//     Every relay source written before 2026-09-02 is legacy, so a retry of an
//     old message is the ordinary case; a versioned slot on a legacy row would
//     drive `markRecipient`'s blind whole-slot write and erase the aggregation
//     state.
//   - The payload carries IDENTIFIERS ONLY - never a body, never a phone. The
//     handler re-reads the row, which is where the raw body, the composed leg
//     copy and the destination DIGEST live (spec D11/D12).
//
// PII (doc S9): member keys go through `logSafeMemberKey`; no phone number and
// no message body ever reaches a log line.
import {
  createMessagingAdapter,
  type CarrierMessageSender,
  type MessagingAdapter,
} from '../adapters/messaging.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { getContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { relayRetryBackoffMs, relayRetryDigest } from '../lib/relayRetryClaim.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { isMemberSuppressed, logSafeMemberKey } from '../services/relayAnnouncements.js';
import {
  MAX_FANOUT_ATTEMPTS,
  fanOutBackoffMs,
  persistRelayRecipientResult,
  sendOneRelayLeg,
  setVersionedAggregationState,
  type RelayLegPayload,
  type RelayTransportMode,
} from './relayFanOut.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const RELAY_RETRY_LEG_JOB = 'relay.retryLeg';

/**
 * One rung, addressed by identifiers ONLY (spec D11). The body, the composed
 * leg copy and the destination digest all live on the retry row, which the
 * handler re-reads consistently - so nothing sensitive rides the queue and a
 * roster change between enqueue and run is still seen by the gates.
 */
export interface RelayRetryLegPayload {
  relayConversationId: string;
  /** The RETRY row's own key (NOT the root's). */
  retryTsMsgId: string;
}

/**
 * Every terminal code this job can write to a retry leg's slot (spec D15/D14/
 * D10). The four `retry_*` values are D9's gate refusals and each has operator
 * copy in the dashboard's internal-code map; `enqueue_failed` and
 * `transient_cap` already existed there and keep their meanings - retries did
 * not run vs. retries ran and the transient budget is spent.
 *
 * `contact_opted_out` is deliberately NOT in this set: the dashboard drops that
 * code from the relay rollup entirely, so a refusal stamped with it would
 * silently vanish from the surface this feature exists to make truthful.
 */
export type RelayRetryCloseCode =
  | 'retry_group_closed'
  | 'retry_member_removed'
  | 'retry_number_changed'
  | 'retry_opted_out'
  | 'enqueue_failed'
  | 'transient_cap';

export interface RelayRetryLegJobDeps {
  adapter?: MessagingAdapter & CarrierMessageSender;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  /** Media bucket store for re-presigning attachments (spec D13). Legitimately
   *  undefined with no MEDIA_BUCKET; lazily built on first job run. */
  mediaStore?: MediaStore;
  /** Shared A2P pacing bucket - one token per real outbound SMS. */
  tokenBucket?: TokenBucket;
  logger?: Logger;
  /**
   * The RETRY ladder's backoff (spec D6): 60s / 120s / 240s. Injected so the
   * hermetic e2e lane can shorten it - CONFIGURATION, not structural absence;
   * production keeps 60/120/240.
   */
  backoffMs?: (attempt: number) => number;
  /**
   * The TRANSIENT sub-ladder's backoff (spec D10) - a different budget and a
   * different shape from the retry ladder. Defaults to the fan-out's own
   * `fanOutBackoffMs` (5s then 10s). No env override reads this today: neither
   * the spec nor the plan asks for one, and the lane's value is the retry rung.
   */
  transientBackoffMs?: (pass: number) => number;
}

/**
 * Registration-scoped backoffs, kept at MODULE scope on purpose.
 *
 * Rung 1 is enqueued by the status WEBHOOK, which holds no deps object, so a
 * backoff that lived only inside the handler closure would never reach it and
 * the lane override would shorten rungs 2-3 while rung 1 still waited 60s.
 * `enqueueRelayRetryLeg` therefore resolves explicit deps first, then whatever
 * registration stored, then the shared default.
 */
let registeredBackoffMs: ((attempt: number) => number) | undefined;
let registeredTransientBackoffMs: ((pass: number) => number) | undefined;

/** Clear the module-scope backoffs (pairs with jobs.ts `_resetForTests`). */
export function _resetRelayRetryLegForTests(): void {
  registeredBackoffMs = undefined;
  registeredTransientBackoffMs = undefined;
}

/**
 * Producer side: schedule ONE rung of the retry ladder. `attempt` is the rung
 * being scheduled (1..MAX_RELAY_RETRY_ATTEMPTS); the delay is that rung's
 * backoff. `runAt` is a Date - `jobs.enqueue` converts it to a delay itself.
 */
export async function enqueueRelayRetryLeg(
  payload: RelayRetryLegPayload,
  attempt: number,
  deps?: Pick<RelayRetryLegJobDeps, 'backoffMs'>,
): Promise<void> {
  const backoff = deps?.backoffMs ?? registeredBackoffMs ?? relayRetryBackoffMs;
  await enqueue(RELAY_RETRY_LEG_JOB, payload, {
    runAt: new Date(Date.now() + backoff(attempt)),
  });
}

function parseRelayRetryLegPayload(payload: unknown): RelayRetryLegPayload {
  const raw = payload as Partial<RelayRetryLegPayload> | null;
  const relayConversationId = raw?.relayConversationId;
  const retryTsMsgId = raw?.retryTsMsgId;
  if (typeof relayConversationId !== 'string' || relayConversationId.length === 0) {
    throw new Error('relayRetryLeg: payload.relayConversationId is required');
  }
  if (typeof retryTsMsgId !== 'string' || retryTsMsgId.length === 0) {
    throw new Error('relayRetryLeg: payload.retryTsMsgId is required');
  }
  return { relayConversationId, retryTsMsgId };
}

/**
 * The log-safe rendering of a STORED member key (doc S9). `relayMemberKey`
 * falls back to `phone#<E164>` for a contact-less member, so the raw stored key
 * can carry a handset - the same reason `logSafeMemberKey` exists for a roster
 * member. This twin takes the string, for the one line that fires before any
 * roster member has been resolved.
 */
function logSafeStoredMemberKey(memberKey: string): string {
  return memberKey.startsWith('phone#') ? 'phone-only-member' : memberKey;
}

/** The lineage a retry row MUST carry for this job to be able to run at all. */
interface RetryRowLineage {
  rootTsMsgId: string;
  memberKey: string;
  destDigest: string;
  legBody: string;
}

function readRetryLineage(row: MessageItem, retryTsMsgId: string): RetryRowLineage {
  const rootTsMsgId = row.relay_retry_of;
  const memberKey = row.relay_retry_member_key;
  const destDigest = row.relay_retry_dest_digest;
  const legBody = row.relay_retry_leg_body;
  const missing: string[] = [];
  if (typeof rootTsMsgId !== 'string' || rootTsMsgId.length === 0) missing.push('relay_retry_of');
  if (typeof memberKey !== 'string' || memberKey.length === 0) missing.push('relay_retry_member_key');
  if (typeof destDigest !== 'string' || destDigest.length === 0) missing.push('relay_retry_dest_digest');
  if (typeof legBody !== 'string') missing.push('relay_retry_leg_body');
  if (missing.length > 0) {
    // A malformed retry row is a PROGRAMMING error - only the claim path writes
    // one. Throwing is safe here precisely because the execution marker is
    // already set: an SQS redelivery no-ops instead of looping.
    throw new Error(
      `relayRetryLeg: retry row ${retryTsMsgId} is missing lineage: ${missing.join(', ')}`,
    );
  }
  return {
    rootTsMsgId: rootTsMsgId as string,
    memberKey: memberKey as string,
    destDigest: destDigest as string,
    legBody: legBody as string,
  };
}

export function registerRelayRetryLegJobHandler(deps: RelayRetryLegJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  registeredBackoffMs = deps.backoffMs ?? relayRetryBackoffMs;
  registeredTransientBackoffMs = deps.transientBackoffMs ?? fanOutBackoffMs;
  const transientBackoff = registeredTransientBackoffMs;

  // Lazy, exactly as the fan-out registrar does: repos and the adapter touch
  // config + DynamoDB only on the first job run.
  let adapter = deps.adapter;
  let conversations = deps.conversationsRepo;
  let messages = deps.messagesRepo;
  let contacts = deps.contactsRepo;
  // MediaStore can legitimately resolve to undefined (no MEDIA_BUCKET), so a
  // separate init flag drives the lazy build (not `??=`, which would rebuild).
  let mediaStore = deps.mediaStore;
  let mediaStoreInit = deps.mediaStore !== undefined;

  defineJobHandler(RELAY_RETRY_LEG_JOB, async (rawPayload) => {
    const payload = parseRelayRetryLegPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }
    // Locals so the nested close helpers below read a NARROWED binding rather
    // than the mutable outer `let` (TypeScript cannot narrow a captured `let`).
    const messagesRepo = messages;
    const conversationsRepo = conversations;
    const contactsRepo = contacts;
    const messagingAdapter = adapter;
    const store = mediaStore;

    const conversationId = payload.relayConversationId;
    const retryTsMsgId = payload.retryTsMsgId;
    const base = {
      event: 'relay_retry_leg',
      relay: true,
      conversationId,
      retryTsMsgId,
    } as const;

    // 1. Duplicate-DELIVERY guard (spec D4). The claim's `sid#` pointer defeats
    // duplicate CALLBACKS; it does nothing for an SQS redelivery, because this
    // handler performs no create. Without the marker a redelivered rung would
    // simply text the member again.
    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messagesRepo.putJobExecutionMarker(jobId, conversationId);
      if (!first) {
        log.info({ ...base, jobId }, 'relay retry leg duplicate delivery suppressed');
        return;
      }
    } else {
      log.warn({ ...base }, 'relayRetryLeg: no jobId in context - duplicate-delivery guard skipped');
    }

    // 2. Re-read the RETRY row CONSISTENTLY (spec D7's read). A transient
    // re-enqueue reads back the slot this same handler just wrote, so an
    // eventually consistent read would intermittently see the pre-write state.
    const row = await messagesRepo.getByTsMsgIdConsistent(conversationId, retryTsMsgId);
    if (!row) {
      throw new Error(`relayRetryLeg: retry row ${conversationId}/${retryTsMsgId} not found`);
    }
    // `relay_retry_of` is used ONLY as a STRING (the digest's first component).
    // The ROOT ROW is deliberately never read: requiring it to be readable would
    // add a close path for a row nothing else on this path needs.
    const { rootTsMsgId, memberKey, destDigest, legBody } = readRetryLineage(row, retryTsMsgId);
    const ladder = { ...base, rootTsMsgId, attempt: row.relay_retry_attempt };

    // 3. Transport MODE from the RETRY ROW itself (spec D2). `sendOneRelayLeg`
    // writes THIS row, whose own schema is what `applyRecipientSendResult`
    // checks - and the versioned arm's intent is COMPUTED, never stored, so it
    // is classified afresh from exactly the input the fan-out uses.
    const sourceMedia = mediaAttachmentsOf(row);
    const transport: RelayTransportMode =
      row.transport_schema_version === TRANSPORT_SCHEMA_VERSION
        ? {
            kind: 'versioned',
            intent: messagingAdapter.classifyMessageTransport({
              hasForwardableMedia: sourceMedia.length > 0 && store !== undefined,
            }),
          }
        : { kind: 'legacy' };

    // The slot coordinates every write below is addressed by. `attempt` is the
    // TRANSIENT pass number of this execution (the fan-out's own convention for
    // this field: the pass, not the retry rung), which is what the extracted
    // unit's transient WARN line reports. The retry rung is `relay_retry_attempt`
    // on the row and is logged separately.
    const transientPass = (typeof row.fanout_attempt === 'number' ? row.fanout_attempt : 0) + 1;
    const legPayload: RelayLegPayload = {
      relayConversationId: conversationId,
      sourceTsMsgId: retryTsMsgId,
      attempt: transientPass,
    };

    /** A pre-send gate refusal: mirrors the extracted unit's `suppressed` arm. */
    async function refuseGate(code: RelayRetryCloseCode): Promise<void> {
      if (transport.kind === 'versioned') {
        await setVersionedAggregationState(messagesRepo, legPayload, memberKey, 'excluded', [
          'excluded',
          'attempted',
        ]);
      }
      await persistRelayRecipientResult(
        messagesRepo,
        legPayload,
        memberKey,
        { status: 'failed', errorCode: code },
        transport,
      );
    }

    /** A POST-send terminal close: mirrors the fan-out's `closeRelay`, which
     *  writes the failed slot and touches no aggregation state. */
    async function closeTerminally(code: RelayRetryCloseCode): Promise<void> {
      await persistRelayRecipientResult(
        messagesRepo,
        legPayload,
        memberKey,
        { status: 'failed', errorCode: code },
        transport,
      );
    }

    // 4. The gates (spec D9), in order. Each refusal writes its OWN close code,
    // emits D23's terminal ERROR with the `gate_refused` cause, and ENDS the
    // chain - no further rung is claimed.
    const conversation = await conversationsRepo.getById(conversationId);
    if (conversation === undefined || conversation.status !== 'open') {
      // Same authoritative check the fan-out uses: `status`, not pool_number
      // presence (a pool number is KEPT on close for burn-multiplexing). An
      // absent conversation is not open either, and the four codes are a closed
      // set - "group closed" is the truthful one of them.
      await refuseGate('retry_group_closed');
      log.error(
        {
          ...ladder,
          memberKey: logSafeStoredMemberKey(memberKey),
          retryClaim: 'gate_refused',
          closeCode: 'retry_group_closed',
          status: conversation?.status,
        },
        'relayRetryLeg: retry refused - relay group is not open',
      );
      return;
    }
    const poolNumber = conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      // An OPEN relay group with no pool number cannot send at all, and no gate
      // code describes it honestly. Throw rather than mis-stamp one of the four.
      throw new Error(`relayRetryLeg: relay conversation ${conversationId} has no pool number`);
    }

    const roster = (conversation.participants ?? []) as ConversationParticipant[];
    const member = roster.find((candidate) => relayMemberKey(candidate) === memberKey);
    if (member === undefined) {
      await refuseGate('retry_member_removed');
      log.error(
        {
          ...ladder,
          memberKey: logSafeStoredMemberKey(memberKey),
          retryClaim: 'gate_refused',
          closeCode: 'retry_member_removed',
        },
        'relayRetryLeg: retry refused - member is no longer on the roster',
      );
      return;
    }
    const memberLog = { ...ladder, memberKey: logSafeMemberKey(member) };

    // Compare DIGESTS, never the raw number (spec D5): the handset is not stored
    // anywhere on the row, and a member whose phone changed must never silently
    // receive an old message at the new number. An unnormalisable current number
    // can produce no matching digest, so it refuses here too.
    const currentE164 = normalizeToE164(member.phone);
    if (currentE164 === undefined || relayRetryDigest(rootTsMsgId, currentE164) !== destDigest) {
      await refuseGate('retry_number_changed');
      log.error(
        { ...memberLog, retryClaim: 'gate_refused', closeCode: 'retry_number_changed' },
        'relayRetryLeg: retry refused - destination number changed since the claim',
      );
      return;
    }

    if (await isMemberSuppressed(contactsRepo, conversationsRepo, member)) {
      await refuseGate('retry_opted_out');
      log.error(
        { ...memberLog, retryClaim: 'gate_refused', closeCode: 'retry_opted_out' },
        'relayRetryLeg: retry refused - member opted out',
      );
      return;
    }

    // 5. The send. This unit presigns per attempt (spec D13), writes the
    // delivery slot AND the `relaysid#` pointer - neither is written again here
    // - and sends the STORED leg copy verbatim (spec D12), so a sender renamed
    // between attempts cannot change the wording mid-ladder.
    const outcome = await sendOneRelayLeg({
      messages: messagesRepo,
      conversations: conversationsRepo,
      contacts: contactsRepo,
      adapter: messagingAdapter,
      mediaStore: store,
      log,
      tokenBucket: deps.tokenBucket,
      payload: legPayload,
      member,
      currentSource: row,
      poolNumber,
      legBody,
      sourceMedia,
      transport,
    });

    // 6. The outcome.
    if (outcome.kind === 'sent') {
      // Spec D16: inbox ORDERING only. Never `touchLastActivity` - it sets
      // status='open' and would resurrect a group closed during the backoff.
      // The preview argument is `undefined` on purpose: the preview belongs to
      // the thread's NEWEST message, which a 60-240s-old retry is not.
      await conversationsRepo.touchLastActivityPreservingStatus(
        conversationId,
        undefined,
        new Date().toISOString(),
      );
      log.info(
        { ...memberLog, providerSid: outcome.providerSid },
        'relayRetryLeg: retry leg sent',
      );
      return;
    }

    if (outcome.kind === 'transient') {
      // Spec D10's SECOND ladder: a 429/30022 re-enqueues the SAME rung on the
      // retry row's OWN pass budget. It consumes no retry rung - the rung is
      // already claimed, this is that rung trying again.
      const claim = await messagesRepo.claimFanoutPass(
        conversationId,
        retryTsMsgId,
        MAX_FANOUT_ATTEMPTS,
      );
      if (claim.outcome !== 'claimed' || claim.attempt >= MAX_FANOUT_ATTEMPTS) {
        // Mirrors the fan-out continuation's two cap branches, which is what
        // keeps `fanOutBackoffMs`'s documented 5s-then-10s shape true.
        await closeTerminally('transient_cap');
        log.error(
          {
            ...memberLog,
            retryClaim: 'cap_exhausted',
            closeCode: 'transient_cap',
            errorCode: outcome.errorCode,
            ...(claim.outcome !== 'missing' && { transientPass: claim.attempt }),
          },
          'relayRetryLeg: transient pass budget exhausted - retry leg closed',
        );
        return;
      }
      try {
        await enqueue(RELAY_RETRY_LEG_JOB, payload, {
          runAt: new Date(Date.now() + transientBackoff(claim.attempt)),
        });
      } catch (err) {
        await closeTerminally('enqueue_failed');
        log.error(
          { ...memberLog, err, retryClaim: 'enqueue_failed', closeCode: 'enqueue_failed' },
          'relayRetryLeg: transient re-enqueue failed - retry leg closed',
        );
        return;
      }
      log.warn(
        { ...memberLog, errorCode: outcome.errorCode, transientPass: claim.attempt },
        'relayRetryLeg: transient send error - same rung re-enqueued',
      );
      return;
    }

    if (outcome.kind === 'skipped_terminal') {
      log.info({ ...memberLog }, 'relayRetryLeg: retry leg already terminal - nothing sent');
      return;
    }

    // `refused`, `suppressed` and `filtered`: the extracted unit ALREADY wrote a
    // terminal slot carrying that arm's specific error code (adjudication S2).
    // Writing one here would replace a precise code with a vaguer one, so this
    // job only emits D23's terminal ERROR.
    log.error(
      {
        ...memberLog,
        retryClaim: outcome.kind === 'filtered' ? 'code_not_retryable' : 'gate_refused',
        errorCode: outcome.errorCode,
        legOutcome: outcome.kind,
      },
      'relayRetryLeg: retry leg ended terminally at the send',
    );
  });
}
