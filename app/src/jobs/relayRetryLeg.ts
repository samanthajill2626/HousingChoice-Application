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
import { appEvents, type EventBus } from '../lib/events.js';
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
  /**
   * The live-update bus (D16's SSE, extended to the job's terminal closes).
   * Injected for tests exactly as `jobs/voiceTranscript.ts` does it; the
   * singleton is the default, and in the worker process `attachEventBridge`
   * (`worker.ts`) forwards every emit to the app's SSE clients.
   */
  events?: EventBus;
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
 * Registration-scoped backoffs, kept at MODULE scope on purpose - and, since
 * code review R1 (F5), NOT the only place the ladder override can come from.
 *
 * There are TWO topologies and the resolution has to be right in both:
 *
 *   - PRODUCTION. `JOBS_QUEUE_URL` is set, so the app process registers NO
 *     handlers (`index.ts:42`, "Production never registers handlers in the
 *     app") - yet the app process is exactly where `enqueueRelayRetryLeg` runs,
 *     because the status webhook enqueues every rung of the ladder. This store
 *     is therefore EMPTY at the only call site. Nothing was broken by that (the
 *     fallback equals production's 60/120/240), but a backoff handed to
 *     `registerRelayRetryLegJobHandler` would have been silently ignored in
 *     production while appearing to work locally.
 *   - THE HERMETIC LANE (and local `npm run dev`). One process registers the
 *     handler and serves the webhook, so the store IS populated at the call
 *     site and carries the lane's shortened rung to rung 1.
 *
 * `resolveRelayRetryBackoff` below is the single chain both use, which is why
 * the env override is read HERE rather than only at the registration site.
 */
let registeredBackoffMs: ((attempt: number) => number) | undefined;
let registeredTransientBackoffMs: ((pass: number) => number) | undefined;

/** Clear the module-scope backoffs (pairs with jobs.ts `_resetForTests`). */
export function _resetRelayRetryLegForTests(): void {
  registeredBackoffMs = undefined;
  registeredTransientBackoffMs = undefined;
}

/** The lane's ladder override. LANE-ONLY: never set in dev or prod and absent
 *  from every `.env*`, and ignored unless it parses to a positive integer, so a
 *  stray value cannot silently shorten a real ladder. */
const RELAY_RETRY_BACKOFF_ENV_KEY = 'E2E_RELAY_RETRY_BACKOFF_MS';

/**
 * The lane's override, and the TOPOLOGY GUARD that makes "lane-only" structural
 * again (code review R2, W3).
 *
 * The adversarial review recorded, as a property that REDUCED the concern, that
 * this variable set in a deployed environment has no effect on the ladder -
 * because the parse lived at handler registration and the app process registers
 * none. F5 moved the parse into the shared resolution chain, which was right for
 * correctness and deleted that property: in production `registeredBackoffMs` is
 * undefined at the only call site, so the chain fell straight through to the env
 * on every rung, and `E2E_RELAY_RETRY_BACKOFF_MS=1` in the app's environment
 * would have fired all three rungs within milliseconds - texting a member three
 * times.
 *
 * `JOBS_QUEUE_URL` is the discriminator because it IS the topology: production
 * sets it (Terraform's jobs module), and setting it is exactly what makes the
 * app process register no handlers and hand every job to the worker over SQS.
 * The hermetic lane and local `npm run dev` leave it unset and run one process,
 * which is the only topology in which a lane exists at all. Read from
 * `process.env` rather than `config` deliberately: this module is a leaf on the
 * enqueue path and must not pull config validation into it, and the value is
 * only ever tested for presence.
 */
function laneBackoffOverride(): ((attempt: number) => number) | undefined {
  const queueUrl = process.env['JOBS_QUEUE_URL'];
  if (typeof queueUrl === 'string' && queueUrl.length > 0) return undefined;
  const parsed = Number.parseInt(process.env[RELAY_RETRY_BACKOFF_ENV_KEY] ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return () => parsed;
}

/**
 * The retry ladder's backoff, resolved ONE way for every producer:
 *
 *   explicit deps  ??  what registration stored  ??  the lane env override  ??
 *   the shared 60/120/240 default
 *
 * Both `registerRelayRetryLegJobHandler` and the free `enqueueRelayRetryLeg`
 * call it, which is what makes the two topologies above agree. Registration
 * resolves once and stores the result, so the in-process lane reads the env a
 * single time; the app process, which registers nothing, resolves it per
 * enqueue. Exported so a test can assert the chain directly.
 *
 * The third link is topology-guarded (see `laneBackoffOverride`): production
 * sets `JOBS_QUEUE_URL`, so the env override cannot reshape a real ladder even
 * though this chain now runs on production's hot enqueue path.
 */
export function resolveRelayRetryBackoff(
  deps?: Pick<RelayRetryLegJobDeps, 'backoffMs'>,
): (attempt: number) => number {
  return deps?.backoffMs ?? registeredBackoffMs ?? laneBackoffOverride() ?? relayRetryBackoffMs;
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
  const backoff = resolveRelayRetryBackoff(deps);
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
  // Resolved ONCE, through the same chain the free enqueue uses, and stored so
  // rung 1 - which the status WEBHOOK enqueues with no deps object - gets the
  // identical function in the in-process topology. `_resetRelayRetryLegForTests`
  // clears the store between registrations (`defineJobHandler` throws on a
  // second registration of the same name anyway).
  registeredBackoffMs = resolveRelayRetryBackoff(deps);
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
  let events = deps.events;

  defineJobHandler(RELAY_RETRY_LEG_JOB, async (rawPayload) => {
    const payload = parseRelayRetryLegPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    events ??= appEvents;
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
    const eventBus = events;

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
    // Read HERE, where `row` is narrowed: the nested close helpers below cannot
    // see that narrowing (the same reason the repo/adapter locals above exist).
    const rowDirection = row.direction;

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

    /**
     * D16's SSE, extended to the closes that happen INSIDE this job (self-QA
     * finding P1, verified live 2026-09-02).
     *
     * D16 put an emit on the CLAIM because the chip would otherwise read a
     * false terminal state for a whole backoff interval. The mirror-image hole
     * is at the other end: every terminal close this job writes - the four D9
     * gate refusals, `transient_cap`, the job's own `enqueue_failed`, and the
     * `refused`/`filtered`/`suppressed` slots the extracted send unit wrote -
     * used to change the row and announce NOTHING. A refused ladder therefore
     * kept reading `retrying` until some unrelated SSE in some other
     * conversation happened to arrive, and then aged into `not confirmed` at 15
     * minutes - never the refusal reason the job had already stored. D16's own
     * words apply unchanged: a false state, for minutes, on the surface this
     * feature exists to make truthful.
     *
     * ALWAYS the ROOT, never `retryTsMsgId` (adjudication S4's reasoning, at
     * the job end): the ladder's rollup hangs off the root, and on rungs 2-3
     * the retry row's own key addresses a bubble no one is watching. Being the
     * root also makes this emit IDENTICAL in shape to the claim's, which is
     * what lets a client treat the two ends of a ladder the same way. The id is
     * for HONESTY, not routing - the dashboard's consumer is a debounced full
     * refetch that reads no payload field - so a mis-addressed emit would still
     * "work" and would still be wrong.
     *
     * `deliveryStatus: 'failed'` mirrors what the webhook's relay emit passes on
     * a failure; every close routed through here writes a `failed` slot.
     * `direction` comes off the retry ROW, which the claim wrote as a mirror of
     * the original (D2), so it equals the root's direction transitively.
     *
     * NOT called on `sent` (the rung's own Twilio callbacks reach the webhook's
     * emit), on a transient RE-ENQUEUE (nothing terminal happened), or on
     * `skipped_terminal` (the slot was already terminal before this job ran -
     * whoever wrote it announced it then).
     */
    function announceRootClose(): void {
      eventBus.emit('message.persisted', {
        conversationId,
        tsMsgId: rootTsMsgId,
        direction: rowDirection,
        deliveryStatus: 'failed',
      });
    }

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
      // AFTER the durable write, on both close helpers: a client woken by this
      // emit refetches immediately, and it must read the closed slot rather
      // than race the write that closed it.
      announceRootClose();
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
      announceRootClose();
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

    // The fan-out's media-without-store ERROR, twinned (code review R1, F4).
    // `hasForwardableMedia` above folds "no store" into the transport intent, so
    // without this line an MMS retry silently degrades to text - and on a
    // versioned row the seeded `requestedTransport: 'mms'` then sits beside an
    // SMS send with nothing anywhere saying why. Config-dependent (MEDIA_BUCKET
    // unset) and absent from dev and prod, which is exactly why the fan-out logs
    // it: the failure is otherwise invisible. IDs and a count only, no PII.
    if (sourceMedia.length > 0 && store === undefined) {
      log.error(
        { ...memberLog, mediaCount: sourceMedia.length },
        'relayRetryLeg: retry row has media but no MediaStore - resending body only, media dropped',
      );
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
      // The D9 gate above just asked `isMemberSuppressed` for this same member
      // (code review R2, W4). Letting the unit ask again opens a window in which
      // the two answers DISAGREE, and the losing side stamps `contact_opted_out`
      // on this retry row - which `presentRelayDelivery` filters out of its
      // denominator, so a one-member relay group loses its rollup entirely and
      // the row reads "Not sent - opted out" for a leg that was sent. One read,
      // one answer, no window.
      suppressionChecked: true,
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
    // job only emits D23's terminal ERROR, and NO close code - it wrote nothing.
    //
    // `suppressed` IS UNREACHABLE from this job (code review R2, W4). The send
    // above passes `suppressionChecked: true`, so the unit no longer runs the
    // suppression read at all and cannot take that arm; the D9 gate is the only
    // place this ladder decides an opt-out, and it closes with
    // `retry_opted_out`. The arm stays as a defensive ERROR because the outcome
    // union still admits it and a silent fall-through would be worse than a line
    // nobody expects to see.
    //
    // WHAT WAS HERE BEFORE, and why it went: fix wave 1 re-stamped this slot as
    // `retry_opted_out` after the fact, because `contact_opted_out` is filtered
    // out of `presentRelayDelivery`'s denominator (`deliveryStatus.ts:449`, the
    // `fanned` filter) and a one-member relay group would lose its whole rollup.
    // That re-stamp was INERT on the shape every relay source now takes: on a
    // VERSIONED row `applyRecipientSendResult` preserves the FIRST terminal code
    // (`messagesRepo.ts`, `terminalCurrent && statusSame`), so the write was
    // refused and the log still reported a `closeCode` nothing had written.
    // Closing the read window is what actually fixes it.
    log.error(
      {
        ...memberLog,
        retryClaim: outcome.kind === 'filtered' ? 'code_not_retryable' : 'gate_refused',
        errorCode: outcome.errorCode,
        legOutcome: outcome.kind,
      },
      'relayRetryLeg: retry leg ended terminally at the send',
    );
    // The third terminal-close site (finding P1). The slot is closed and this
    // job wrote none of it - which is exactly why the emit cannot live in the
    // two close helpers alone. `sendOneRelayLeg` returned only after its own
    // durable write, so this is still after it.
    announceRootClose();
  });
}
