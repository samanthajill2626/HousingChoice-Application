// relay.retryLeg - one rung of the 30003 retry ladder for ONE relay leg.
//
// The claim lives in the status webhook (spec D3): it appends a NEW single-
// recipient source row carrying the lineage of the leg that failed, and enqueues
// this job with that row's key. This handler owns everything after the claim -
// the four send gates, the send window, the send itself, the status-preserving
// activity bump, the transient sub-ladder and the terminal closes.
//
// Since retry-send-window (its spec D3/D4) the claim PREVIEWS the four gates -
// through the same `evaluateRelayRetryGates` this job runs - and the 15-minute
// send window, and creates a rung it can already see is doomed as CLOSED, never
// enqueued. This job still re-runs every check at send time: a group can close,
// and the window can run out, during the backoff.
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
// Since send-outcome-reconcile (SOR spec D7a, D8, D16) the rung also owns a
// per-rung SEND-ATTEMPT RECORD. The unit claims it after the bounded token
// acquire and before the presign, so a window deadline never holds a claim
// (RSW #5/#6). Every close this job writes that is not its own attempt's -
// the four gate refusals, the window gate, the send deadline and the transient
// arm's three closes - first passes the D8 gate on that record: a live or
// reconciling attempt keeps the slot, a terminal one skips, a stale one is
// taken over into reconcile, and a `redriven` one is closed with the decline.
// An unknown provider outcome or a send that landed unrecorded is handed to
// the send.reconcile job (never re-sent here); a re-driven rung arrives with
// `redrive: true` and runs this same handler, so every job-time gate and the
// window bound it (RSW #1).
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
import { guardWrite } from '../lib/guardWrite.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { relayRetryBackoffMs } from '../lib/relayRetryClaim.js';
import { evaluateRelayRetryGates, type RelayRetryGateCode } from '../lib/relayRetryGates.js';
import {
  parseRetryWindowOrigin,
  RETRY_WINDOW_CLOSED_CODE,
  retryFitsSendWindow,
  retrySendDeadlineMs,
  withinRetrySendWindow,
} from '../lib/retrySendWindow.js';
import { gateFor } from '../lib/sendAttemptGate.js';
import { safeRecipientKey } from '../lib/sendFingerprint.js';
import { ENQUEUE_FAILED_CODE, SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createSendAttemptsRepo,
  type SendAttemptOwner,
  type SendAttemptsRepo,
} from '../repos/sendAttemptsRepo.js';
import { isMemberSuppressed, logSafeMemberKey } from '../services/relayAnnouncements.js';
import {
  MAX_FANOUT_ATTEMPTS,
  fanOutBackoffMs,
  persistRelayRecipientResult,
  sendOneRelayLeg,
  setVersionedAggregationState,
  type RelayLegPayload,
  type RelayLegSendOutcome,
  type RelayTransportMode,
} from './relayFanOut.js';
import { defineJobHandler, enqueue } from './jobs.js';
import { enqueueSendReconcile, reconcileDelayMs, toOwnerRef } from './sendReconcile.js';

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
  /**
   * SOR spec D16: set on the rung the send.reconcile job re-drives after a
   * `never_sent` verdict (it marks the rung's record `redriven` first). Logged,
   * never decided on: a `redriven` record is claimable, and closable by a
   * pre-claim decline, on ANY pass (spec D8), so the record is the test, not
   * this marker - and a transient re-enqueue never carries it.
   */
  redrive?: true;
}

/**
 * Every terminal code this job can write to a retry leg's slot (spec D15/D14/
 * D10). The four gate `retry_*` values are D9's gate refusals - typed once as
 * `RelayRetryGateCode`, beside the shared evaluator that both this job and the
 * status webhook's claim run (retry-send-window D3) - and each has operator
 * copy in the dashboard's internal-code map; `enqueue_failed` and
 * `transient_cap` already existed there and keep their meanings - retries did
 * not run vs. retries ran and the transient budget is spent.
 *
 * `retry_window_closed` (retry-send-window D4) is the send-window close: the
 * window gate below, the send deadline passing while the rung waits on the
 * A2P meter, or a transient re-run that would land past the window.
 * Kept for data and logs; the dashboard's relay join gives it NO display
 * code, so the leg reads as the original 30003 - a plain failed attempt.
 * Typed from RETRY_WINDOW_CLOSED_CODE (lib/retrySendWindow.ts), the app's one
 * copy of the value, which every site below writes and logs.
 *
 * `contact_opted_out` is deliberately NOT in this set: the dashboard drops that
 * code from the relay rollup entirely, so a refusal stamped with it would
 * silently vanish from the surface this feature exists to make truthful.
 *
 * One more code reaches the slot outside these helpers: `send_unconfirmed`
 * (SOR spec D7), written through the conditional relay close when the
 * reconcile hand-off cannot be enqueued (`handOff` below).
 */
export type RelayRetryCloseCode =
  | RelayRetryGateCode
  | 'enqueue_failed'
  | 'transient_cap'
  | typeof RETRY_WINDOW_CLOSED_CODE;

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
   * The per-recipient send-attempt records (SOR spec D8a): the rung's claim,
   * its D8 gate reads and its reconcile hand-off. Lazily built on the first
   * job run when absent; a test passes its fake world's so no job run ever
   * opens a real DynamoDB connection.
   */
  sendAttemptsRepo?: SendAttemptsRepo;
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
  // Rebuilt field by field, so an unknown field never rides along; `redrive`
  // is carried only when it is exactly `true`.
  return { relayConversationId, retryTsMsgId, ...(raw?.redrive === true && { redrive: true as const }) };
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

/** The WARN message each gate refusal logs - one per code, unchanged since the
 *  gates moved into `evaluateRelayRetryGates` (retry-send-window D3). */
const GATE_REFUSAL_MESSAGES: Record<RelayRetryGateCode, string> = {
  retry_group_closed: 'relayRetryLeg: retry refused - relay group is not open',
  retry_member_removed: 'relayRetryLeg: retry refused - member is no longer on the roster',
  retry_number_changed: 'relayRetryLeg: retry refused - destination number changed since the claim',
  retry_opted_out: 'relayRetryLeg: retry refused - member opted out',
};

/** The lineage a retry row MUST carry for this job to be able to run at all -
 *  plus the one field it may lack. */
interface RetryRowLineage {
  rootTsMsgId: string;
  memberKey: string;
  destDigest: string;
  legBody: string;
  /**
   * retry-send-window D2/D5: the ladder's send-window origin as the claim
   * stored it, or undefined. OPTIONAL on purpose - it is NOT in the `missing`
   * list below. That check throws AFTER the execution marker is set, so
   * requiring the field would silently drop every rung claimed before the
   * window shipped; such a rung runs unwindowed instead, with a WARN.
   */
  windowStart: string | undefined;
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
    windowStart: row.relay_retry_window_start,
  };
}

/**
 * The `retryClaim` label of a leg outcome that closed the rung at the send.
 * The unit wrote each of these slots itself: a refusal and the (unreachable
 * here) suppression keep `gate_refused`; a carrier filter or a provider
 * rejection is `code_not_retryable`; a re-drive attempt whose outcome was
 * unknown AGAIN (the unit closed it send_unconfirmed, SOR D13a) is
 * `send_unconfirmed`.
 */
function terminalRetryClaim(outcome: RelayLegSendOutcome): string {
  if (outcome.kind === 'rejected') {
    return outcome.errorCode === SEND_UNCONFIRMED_CODE ? 'send_unconfirmed' : 'code_not_retryable';
  }
  return outcome.kind === 'filtered' ? 'code_not_retryable' : 'gate_refused';
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
  let sendAttempts = deps.sendAttemptsRepo;

  defineJobHandler(RELAY_RETRY_LEG_JOB, async (rawPayload) => {
    const payload = parseRelayRetryLegPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    events ??= appEvents;
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });
    sendAttempts ??= createSendAttemptsRepo({ logger: deps.logger });
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
    const attempts = sendAttempts;

    const conversationId = payload.relayConversationId;
    const retryTsMsgId = payload.retryTsMsgId;
    const base = {
      event: 'relay_retry_leg',
      relay: true,
      conversationId,
      retryTsMsgId,
      // A rung the send.reconcile job re-drove (SOR D16): named on every line.
      ...(payload.redrive === true && { redrive: true }),
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
    const { rootTsMsgId, memberKey, destDigest, legBody, windowStart } = readRetryLineage(
      row,
      retryTsMsgId,
    );
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

    // SOR D8a: THIS rung's send-attempt record - one per retry row and member,
    // which the unit claims and every close below is gated on.
    const rungOwner: SendAttemptOwner = {
      kind: 'relay_rung',
      relayConversationId: conversationId,
      retryTsMsgId,
      memberKey,
    };
    /** The log context of the rung known only by its STORED key (build finding G9). */
    const keyCtx = { ...ladder, recipientKey: safeRecipientKey(memberKey) };

    /**
     * SOR D7/D16: enqueue check 0 of the send.reconcile chain for THIS rung -
     * the owner reference with the hashed member key and the attempt start
     * every record condition keys on. No continuation: a `never_sent` verdict
     * re-drives by enqueueing this same rung with `redrive: true`. The job's
     * only reconcile enqueue - for the unit's hand-off, a send that landed
     * unrecorded and a takeover at a gated close alike. NEVER throws: an
     * enqueue that fails closes the rung unresolved on the spot - the slot
     * `failed` / send_unconfirmed FIRST (conditional: never over a send that
     * landed), then the record done / unresolved with cause enqueue_failed -
     * logs ERROR and announces the root, so nothing waits on a chain that
     * never started (D7, D13a).
     */
    async function handOff(attemptedAt: string): Promise<void> {
      try {
        await enqueueSendReconcile(
          { owner: toOwnerRef(rungOwner), attemptedAt, checkNo: 0 },
          reconcileDelayMs(attemptedAt, 0, Date.now()),
        );
      } catch (err) {
        await guardWrite(log, keyCtx, 'closeUnconfirmed', () =>
          messagesRepo.closeRelayRecipientIfUnsent(conversationId, retryTsMsgId, memberKey, {
            status: 'failed',
            errorCode: SEND_UNCONFIRMED_CODE,
          }),
        );
        await guardWrite(log, keyCtx, 'closeFromReconcile', () =>
          attempts.closeFromReconcile(rungOwner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE }),
        );
        log.error(
          {
            err,
            ...keyCtx,
            retryClaim: 'reconcile_enqueue_failed',
            closeCode: SEND_UNCONFIRMED_CODE,
            cause: ENQUEUE_FAILED_CODE,
          },
          'relayRetryLeg: reconcile enqueue failed - retry leg closed unresolved (send_unconfirmed)',
        );
        announceRootClose();
      }
    }

    /**
     * SOR D8: every close this job writes BEFORE the unit's claim (the four
     * gate refusals, the window gate, the send deadline) or on behalf of an
     * attempt it may not own (the transient arm's three closes, build ruling
     * A4 - a `deferredByClaim` transient means a FOREIGN attempt owns the
     * rung) is a close by a writer other than the rung's own attempt, so it
     * passes the D8 gate first:
     *   - PROCEED (no record, done/retryable, redriven): `write` as today; a
     *     redriven record is then closed done with the close's code as cause
     *     (spec D8: the decline would have applied to the re-drive equally) -
     *     `enqueue_failed` for the job's own enqueue failure, else `refused`
     *     (the cap-close rule, build finding G7).
     *   - DEFER (a live attempt, or a reconcile, owns the rung): WARN, no write.
     *   - SKIP (the attempt is terminal): INFO, no write.
     *   - TAKEN_OVER (a stale attempt, now reconciling): handed to reconcile
     *     here, exactly once; WARN, no write.
     * Returns true only when the close was written; the caller logs its own
     * close line only then. `extra` joins the keep lines (e.g. the `err` of a
     * failed re-enqueue, which would otherwise go unlogged).
     */
    async function closeUnlessOwned(
      code: RelayRetryCloseCode,
      write: (code: RelayRetryCloseCode) => Promise<void>,
      extra: Record<string, unknown> = {},
    ): Promise<boolean> {
      const gate = await gateFor(attempts, rungOwner, Date.now());
      switch (gate.kind) {
        case 'proceed':
          await write(code);
          if (gate.record?.state === 'redriven') {
            await guardWrite(log, keyCtx, 'closeRedriven', () =>
              attempts.closeRedriven(rungOwner, {
                outcome: code === ENQUEUE_FAILED_CODE ? 'enqueue_failed' : 'refused',
                cause: code,
              }),
            );
          }
          return true;
        case 'defer':
          log.warn(
            { ...keyCtx, ...extra, gate: gate.kind, closeCode: code },
            'relayRetryLeg: close not written - another attempt or its reconcile owns the retry leg',
          );
          return false;
        case 'skip':
          log.info(
            { ...keyCtx, ...extra, gate: gate.kind, closeCode: code },
            'relayRetryLeg: close not written - the retry leg attempt is already resolved',
          );
          return false;
        case 'taken_over':
          await handOff(gate.record.attemptedAt);
          log.warn(
            { ...keyCtx, ...extra, gate: gate.kind, closeCode: code },
            'relayRetryLeg: close not written - a stale attempt was taken over into reconcile',
          );
          return false;
      }
    }

    // 4. The gates (spec D9), in order, through the ONE evaluator the status
    // webhook's claim also previews them with (retry-send-window D3), so the
    // claim and this job can never disagree about which gate refuses, or which
    // code wins when two apply. Each refusal writes its OWN close code, logs a
    // WARN with the `gate_refused` cause, and ENDS the chain - no further rung
    // is claimed. WARN, not the spec's D23 ERROR, by Cameron's ruling on the
    // handback's open question Q1 (2026-09-24): a closed group, a removed
    // member, a changed number and an opt-out are deliberate human actions,
    // not faults - the 21610 carve-out's reasoning - and at ERROR an operator
    // who closed a group with several rungs pending could trip the ErrorLogs
    // burst alarm on their own action. The send-time refusal below (e.g.
    // `breaker_open`) is a system condition and stays ERROR.
    const conversation = await conversationsRepo.getById(conversationId);
    const gate = await evaluateRelayRetryGates({
      conversation,
      memberKey,
      rootTsMsgId,
      destDigest,
      // The evaluator reads nothing itself: this is the job's ONE suppression
      // read, the one `suppressionChecked: true` below relies on (R2, W4).
      isSuppressed: (candidate) => isMemberSuppressed(contactsRepo, conversationsRepo, candidate),
    });
    if (gate.refused) {
      // SOR D8: behind the record gate - a live attempt keeps the slot, and a
      // redriven record is closed refused with this code.
      if (!(await closeUnlessOwned(gate.code, refuseGate))) return;
      log.warn(
        {
          ...ladder,
          // The STORED key's log-safe form: equal to `logSafeMemberKey` of the
          // roster member it matches, and the only form left once the member
          // is gone from the roster.
          memberKey: logSafeStoredMemberKey(memberKey),
          retryClaim: 'gate_refused',
          closeCode: gate.code,
          ...(gate.code === 'retry_group_closed' && { status: conversation?.status }),
        },
        GATE_REFUSAL_MESSAGES[gate.code],
      );
      return;
    }
    // An OPEN relay group with no pool number cannot send at all, and no gate
    // code describes it honestly. Throw rather than mis-stamp one of the four.
    // Checked AFTER all four gates (retry-send-window D3, the order the claim
    // previews): an open, pool-less group that ALSO refuses a gate closes with
    // that gate's code instead of throwing. relayRetryLeg.test.ts pins both
    // halves.
    const poolNumber = gate.conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      throw new Error(`relayRetryLeg: relay conversation ${conversationId} has no pool number`);
    }
    const member = gate.member;
    const memberLog = { ...ladder, memberKey: logSafeMemberKey(member) };

    // 4b. The send window (retry-send-window spec D4) - the LAST gate, after
    // the opt-out, so a deliberate human action keeps its own "Not retried -
    // ..." code when both apply. STRICT at send time: the claim already spent
    // RETRY_JOB_GRACE_MS when it scheduled this rung, so the rule here is only
    // "not after origin + 15 minutes". The origin is the one the claim carried
    // on this row (the member's ORIGINAL leg send, spec D2) - never re-derived.
    // A row without a usable one (claimed before the window shipped, or
    // unparseable) is NOT windowed and runs, with a WARN naming the gap (D5).
    //
    // The no-pool-number throw above precedes this gate ON PURPOSE: an open
    // group with no pool number cannot send at all, and its throw after the
    // execution marker strands the rung whatever the window says, so the
    // window gate is never asked to describe it. relayRetryLeg.test.ts pins
    // this order.
    const originMs = parseRetryWindowOrigin(windowStart);
    if (originMs === undefined) {
      log.warn(
        { ...memberLog, windowOrigin: windowStart === undefined ? 'missing' : 'unparseable' },
        'relayRetryLeg: no usable send-window origin on the retry row - window not checked (spec D5)',
      );
    } else if (!withinRetrySendWindow({ originMs, nowMs: Date.now() })) {
      // SOR D8 (RSW #6): a close by a writer other than the rung's attempt,
      // so it follows the record gate like the four refusals above.
      if (!(await closeUnlessOwned(RETRY_WINDOW_CLOSED_CODE, refuseGate))) return;
      // ERROR (D9): the member never got the text - a dead end like the cap,
      // not a human action like the four gates above.
      log.error(
        {
          ...memberLog,
          retryClaim: 'window_closed',
          closeCode: RETRY_WINDOW_CLOSED_CODE,
          windowCheck: 'gate',
        },
        'relayRetryLeg: retry refused - past the 15-minute send window',
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
    // between attempts cannot change the wording mid-ladder. It claims the
    // rung's send-attempt record after the bounded acquire and before the
    // presign (SOR D7a) and never throws: every failure is an outcome kind.
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
      // retry-send-window D4: the window's end, so the unit's wait on the
      // shared A2P meter is BOUNDED by it - a rung queued behind a burst must
      // not go out after origin + 15 minutes. Omitted when the row has no
      // usable origin (D5): that rung is not windowed.
      ...(originMs !== undefined && { sendDeadlineMs: retrySendDeadlineMs(originMs) }),
      sendAttempts: attempts,
      owner: rungOwner,
    });

    // 6. The outcome - EVERY kind the unit can return, handled explicitly
    // (SOR spec D7a, D16). The switch is exhaustive at compile time: a kind
    // added later cannot fall through into a terminal close it did not earn.
    switch (outcome.kind) {
      case 'sent': {
        // Spec D16: inbox ORDERING only. Never `touchLastActivity` - it sets
        // status='open' and would resurrect a group closed during the backoff.
        // The preview argument is `undefined` on purpose: the preview belongs to
        // the thread's NEWEST message, which a 60-240s-old retry is not.
        // Best-effort (SOR D7a): the leg is sent and recorded, so a failed bump
        // is logged and never fails the job.
        try {
          await conversationsRepo.touchLastActivityPreservingStatus(
            conversationId,
            undefined,
            new Date().toISOString(),
          );
        } catch (err) {
          log.error(
            { ...memberLog, err, providerSid: outcome.providerSid },
            'relayRetryLeg: inbox touch after a sent retry leg failed (best-effort) - the leg is sent',
          );
        }
        log.info(
          { ...memberLog, providerSid: outcome.providerSid },
          'relayRetryLeg: retry leg sent',
        );
        return;
      }

      case 'sent_unrecorded':
      case 'handed_to_reconcile': {
        // SOR D7 / D3a: the rung's record is `reconciling` and the reconcile
        // decides - neither a terminal close nor a failure, so no emit.
        // `sent_unrecorded`: the provider ACCEPTED and a record-phase write
        // threw; the known-SID reconcile adopts it and makes the inbox touch
        // then - so NO touch here. `handed_to_reconcile`: the outcome was
        // unknown (`reason: 'unknown'`), or a stale attempt was taken over
        // (`'takeover'`, whose clock `attemptRef` carries).
        const ref = outcome.attemptRef;
        if (ref === undefined) {
          // Unreachable since the unit's record args are required (SOR Task
          // 9); with no attempt to name there is nothing to hand off.
          log.error(
            { ...memberLog, legOutcome: outcome.kind },
            'relayRetryLeg: a hand-off outcome came back without an attempt record - nothing handed off',
          );
          return;
        }
        if (outcome.kind === 'sent_unrecorded') {
          log.error(
            { ...memberLog, providerSid: outcome.providerSid, legOutcome: outcome.kind },
            'relayRetryLeg: retry leg sent but not recorded - its SID goes to reconcile; the inbox touch waits for the adoption',
          );
        } else {
          log.warn(
            { ...memberLog, legOutcome: outcome.kind, reason: outcome.reason },
            'relayRetryLeg: retry leg handed to reconcile - no close; the verdict decides',
          );
        }
        await handOff(ref.attemptedAt);
        return;
      }

      case 'stranded':
        // SOR D7a: the hand-off write itself failed. The record stays
        // `attempting` and the slot untouched; a later claim refuses any
        // re-send while the record is live, and the rung is left for the
        // sweeper (`send-attempt-sweeper`). ERROR only - no close, no
        // enqueue, no emit. `afterSend`: the send is KNOWN to have happened.
        log.error(
          {
            ...memberLog,
            legOutcome: outcome.kind,
            ...(outcome.afterSend === true && { afterSend: true }),
          },
          'relayRetryLeg: retry leg stranded - its hand-off to reconcile was not written; left for the sweeper',
        );
        return;

      case 'transient': {
        // Spec D10's SECOND ladder: a 429/30022 re-enqueues the SAME rung on the
        // retry row's OWN pass budget. It consumes no retry rung - the rung is
        // already claimed, this is that rung trying again.
        //
        // SOR: the same ladder for every transient - the provider's retryable
        // (the unit released its attempt done/retryable), a throw before or
        // after the claim that sent nothing, and `deferredByClaim` (a FOREIGN
        // attempt owns the rung's record and the unit wrote NO slot). So each
        // close below may meet an attempt this pass does not own, and passes
        // the D8 gate first (build ruling A4).
        const byClaim = outcome.deferredByClaim === true ? { deferredByClaim: true } : {};
        const claim = await messagesRepo.claimFanoutPass(
          conversationId,
          retryTsMsgId,
          MAX_FANOUT_ATTEMPTS,
        );
        if (claim.outcome !== 'claimed' || claim.attempt >= MAX_FANOUT_ATTEMPTS) {
          // Mirrors the fan-out continuation's two cap branches, which is what
          // keeps `fanOutBackoffMs`'s documented 5s-then-10s shape true.
          if (!(await closeUnlessOwned('transient_cap', closeTerminally, byClaim))) return;
          log.error(
            {
              ...memberLog,
              retryClaim: 'cap_exhausted',
              closeCode: 'transient_cap',
              errorCode: outcome.errorCode,
              ...(claim.outcome !== 'missing' && { transientPass: claim.attempt }),
              ...byClaim,
            },
            'relayRetryLeg: transient pass budget exhausted - retry leg closed',
          );
          return;
        }
        // retry-send-window D4: re-enqueueing is a SCHEDULING decision, so it
        // meets the claim's rule - the re-run must still fit the window with
        // RETRY_JOB_GRACE_MS to spare. Past it the rung closes here instead of
        // re-enqueueing a pass the job-time gate would only refuse -
        // `closeTerminally` (no aggregation write), exactly as the cap branch
        // above. No origin (D5): unwindowed, as before.
        const transientDelayMs = transientBackoff(claim.attempt);
        if (
          originMs !== undefined &&
          !retryFitsSendWindow({ originMs, nowMs: Date.now(), backoffMs: transientDelayMs })
        ) {
          if (!(await closeUnlessOwned(RETRY_WINDOW_CLOSED_CODE, closeTerminally, byClaim))) return;
          log.error(
            {
              ...memberLog,
              retryClaim: 'window_closed',
              closeCode: RETRY_WINDOW_CLOSED_CODE,
              windowCheck: 'transient_reschedule',
              errorCode: outcome.errorCode,
              transientPass: claim.attempt,
              ...byClaim,
            },
            'relayRetryLeg: a transient re-run would land past the send window - retry leg closed',
          );
          return;
        }
        try {
          // Never `redrive` (SOR D13a): the record, not the marker, tells any
          // pass that the rung is re-driven.
          const again: RelayRetryLegPayload = { relayConversationId: conversationId, retryTsMsgId };
          await enqueue(RELAY_RETRY_LEG_JOB, again, {
            runAt: new Date(Date.now() + transientDelayMs),
          });
        } catch (err) {
          if (!(await closeUnlessOwned('enqueue_failed', closeTerminally, { err, ...byClaim }))) return;
          log.error(
            { ...memberLog, err, retryClaim: 'enqueue_failed', closeCode: 'enqueue_failed', ...byClaim },
            'relayRetryLeg: transient re-enqueue failed - retry leg closed',
          );
          return;
        }
        log.warn(
          { ...memberLog, errorCode: outcome.errorCode, transientPass: claim.attempt, ...byClaim },
          'relayRetryLeg: transient send error - same rung re-enqueued',
        );
        return;
      }

      case 'deadline_exceeded': {
        // retry-send-window D4: the send deadline (origin + 15 minutes) passed
        // while this rung waited on the shared A2P meter. Nothing was sent and
        // nothing written, so this is a PRE-send refusal - `refuseGate`, the
        // same close as the window gate above - and NEVER the transient branch,
        // whose re-enqueue assumes a provider refusal and would try again past
        // the window. ERROR (D9); refuseGate announces the root once. The unit
        // returns this BEFORE its claim, so it holds no record (RSW #5/#6);
        // the close passes the D8 gate like the window gate, and closes a
        // redriven record refused.
        if (!(await closeUnlessOwned(RETRY_WINDOW_CLOSED_CODE, refuseGate))) return;
        log.error(
          {
            ...memberLog,
            retryClaim: 'window_closed',
            closeCode: RETRY_WINDOW_CLOSED_CODE,
            windowCheck: 'send_deadline',
          },
          'relayRetryLeg: send-window deadline passed while waiting for the A2P meter - nothing sent, retry leg closed',
        );
        return;
      }

      case 'skipped_terminal':
        // Nothing done: the slot was terminal, or the rung's attempt record is
        // terminal or owned by its reconcile (a refused claim; `reason:
        // 'unknown'` - a hand-off that lost its fence to a takeover, whose own
        // reconcile owns the record). Whoever closed it announced it.
        log.info(
          { ...memberLog, ...(outcome.reason !== undefined && { reason: outcome.reason }) },
          'relayRetryLeg: retry leg already terminal or owned by its reconcile - nothing sent',
        );
        return;

      case 'rejected':
      case 'refused':
      case 'suppressed':
      case 'filtered':
        // `refused`, `suppressed`, `filtered` and `rejected`: the extracted unit
        // ALREADY wrote a terminal slot carrying that arm's specific error code
        // (adjudication S2) - a `rejected` with no provider code writes none,
        // and the SOR D13a close of a re-drive attempt whose outcome was
        // unknown AGAIN is `rejected` with send_unconfirmed, the slot AND the
        // record already closed by the unit. Writing one here would replace a
        // precise code with a vaguer one, so this job only emits D23's
        // terminal ERROR, and NO close code - it wrote nothing.
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
            retryClaim: terminalRetryClaim(outcome),
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
        return;

      default: {
        const unhandled: never = outcome.kind;
        throw new Error(`relayRetryLeg: unhandled leg outcome ${String(unhandled)}`);
      }
    }
  });
}
