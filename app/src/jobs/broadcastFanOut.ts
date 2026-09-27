// broadcast.send (M1.8a) - fan a filtered share-broadcast ("Share Properties")
// out to each matching TENANT's 1:1 conversation, throttled and idempotent.
//
// Modeled on relayFanOut.ts, but the unit differs: a broadcast sends a 1:1
// message to EACH tenant (its own conversation) via the sendMessage wrapper -
// not a relay fan-out from a pool number.
//
// Each recipient is ONE unit with three phases (SOR spec D7a), run inside one
// try/catch that tracks the phase, so nothing in the unit throws out of the
// loop and a failure is handled by WHERE it happened:
//   - PREPARE: skip a TERMINAL slot (sent/delivered/failed/skipped - the
//     per-recipient idempotency layer); resolve the contact; the five fences
//     (no contact/phone -> failed no_contact; opted out -> skipped opted_out;
//     unreachable -> skipped unreachable; soft-deleted -> skipped
//     contact_deleted; no consent -> skipped no_consent - NO token, NO send),
//     each behind the D8 gate so a fence never overwrites a recipient another
//     attempt owns; the tenant's conversation and the rendered body; then the
//     CLAIM on the recipient's send-attempt record (D8a), immediately before
//     the send - a fresh foreign attempt defers the recipient, a terminal one
//     skips it, a stale one is taken over into reconcile. The send wrapper
//     re-arms the claim as its last step before the provider call (code
//     review ADV-1): an attempt taken over meanwhile is not sent. A throw here
//     sent nothing: the recipient is deferred to the continuation.
//   - SEND: sendMessage into the tenant's 1:1 conversation, STAMPED with
//     broadcast_id so the delivery callback can roll delivered/failed into the
//     broadcast stats. A share the dashboard created (created_via 'dashboard')
//     is a PERSON'S send (automated false: the switch and the breaker do not
//     apply); any other share is automated. The fenced contact rides along as
//     `recipient`, so the wrapper's deleted + consent gates judge THAT contact
//     (share-skip-fix I8). A failure is classified (D1-D6): a refusal skips the
//     recipient with its code, bucketed consent / opt-out / other
//     (share-skip-fix D7); `rejected` fails it with the provider code (30007
//     never retried; 30005/30006 also flag the contact sms_unreachable);
//     `retryable` defers it to the backed-off continuation (capped at
//     MAX_BROADCAST_ATTEMPTS); `unknown` hands it to the send.reconcile job
//     (D7) - the slot stays `queued` and only the verdict writes it.
//   - RECORD: the slot `sent` and its stats bump in ONE conditional write,
//     BEFORE the A2P token (a fast delivery callback must find the slot), then
//     the record done/sent. A failure here is `sent_unrecorded`: the text went
//     out, so the recipient is handed to reconcile WITH its SID and never
//     re-sent (D3a). The token acquire, the listing_sent milestone and the
//     listing-send row are best-effort.
//
// A refused or skipped recipient spends NO token. Every failure-arm write goes
// through guardWrite: a lost write is logged at ERROR and the attempt record
// decides. The outage brake (D9): three consecutive `unknown` outcomes end the
// pass early - every recipient not yet attempted is deferred to the
// continuation and one WARN (event `outage_brake`) names the count.
//
// Idempotency (SQS at-least-once + our own continuation re-enqueues):
//   - the job execution marker guards the WHOLE job per envelope jobId;
//   - per recipient, a TERMINAL broadcast slot is SKIPPED, and the claim on
//     the send-attempt record refuses a second attempt while one is open or
//     after one sent, so a redelivered / continuation job never double-sends.
//
// PII (doc Sec 9): NEVER log bodies/phones/names - broadcastId / recipient keys
// (through safeRecipientKey) / counts / SIDs only, correlated via the pino
// mixin (relayFanOut precedent).
import { mapTwilioStatus } from '../adapters/messaging.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { getContext } from '../lib/context.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { guardWrite } from '../lib/guardWrite.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { gateFor } from '../lib/sendAttemptGate.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import { buildUnitMergeContext, renderBody } from '../lib/mergeFields.js';
import { bodyFingerprint, recipientDigest, safeRecipientKey } from '../lib/sendFingerprint.js';
import {
  ENQUEUE_FAILED_CODE,
  isProviderCode,
  OUTAGE_BRAKE_UNKNOWN_STREAK,
  SEND_RETRYABLE_CODE,
  SEND_UNCONFIRMED_CODE,
  SMS_SENDING_DISABLED_CODE,
  TRANSIENT_CAP_CODE,
  type SendFailureClassification,
} from '../lib/sendOutcome.js';
import {
  createBroadcastsRepo,
  deriveBroadcastStats,
  isNoConsentCode,
  isOptedOutCode,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastStats,
  type BroadcastsRepo,
} from '../repos/broadcastsRepo.js';
import {
  contactHoldsPhone,
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import type { FanoutClaimResult } from '../repos/fanoutClaim.js';
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../repos/messagesRepo.js';
import {
  createSendAttemptsRepo,
  type AttemptRef,
  type SendAttemptOwner,
  type SendAttemptsRepo,
} from '../repos/sendAttemptsRepo.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';
import {
  createListingSendsRepo,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createSendMessageService,
  ProviderSendFailedError,
  SendAcceptedNotRecordedError,
  SendNotAttemptedError,
  SendRefusedError,
  type SendMessageOutcome,
  type SendMessageService,
} from '../services/sendMessage.js';
import { defineJobHandler, enqueue } from './jobs.js';
import { enqueueSendReconcile, reconcileDelayMs, toOwnerRef } from './sendReconcile.js';

export const BROADCAST_SEND_JOB = 'broadcast.send';

/** Continuation cap: a transient failure re-enqueues at most this many times. */
export const MAX_BROADCAST_ATTEMPTS = 3;

/**
 * Exponential backoff for the transient-failure continuation, as a function of
 * the pass it is waiting FOR: 5s, 10s, 20s for attempts 1, 2, 3.
 *
 * The LIVE ladder waits 10s then 20s, because the continuation is scheduled with
 * `nextAttempt` - it waits its OWN backoff, not the finished pass's. The twin in
 * relayFanOut is called with the CURRENT attempt and so waits 5s then 10s; that
 * difference is deliberate and preserved (design D7/D11). Read the call site
 * before changing either.
 */
export function broadcastBackoffMs(attempt: number): number {
  return 5_000 * 2 ** (attempt - 1);
}

/** Twilio carrier-filtering: NEVER retry. */
const CARRIER_FILTERED_CODE = '30007';
/** Invalid number / landline: flag the contact unreachable, never retry. */
const UNREACHABLE_CODES = new Set(['30005', '30006']);

/** SOR D16a: `last_error` (the results header shows it verbatim) when no text was confirmed at all. */
const UNCONFIRMED_LAST_ERROR = "Couldn't confirm any text went out";
/** `last_error` when no recipient was reached and at least one really failed. */
const ALL_FAILED_LAST_ERROR = 'all recipients failed';

export interface BroadcastSendPayload {
  broadcastId: string;
  /** Remaining contactKeys (continuation); absent = all from the snapshot. */
  recipientKeys?: string[];
  /** 1-based continuation attempt (absent = first run, treated as 1). */
  attempt?: number;
  /**
   * SOR D13a/D16: a RE-DRIVE pass - the reconcile ruled one recipient
   * never_sent and re-drove it. Such a pass claims no ladder rung up front
   * (only after its loop, and only for a transient remainder), so a spent
   * ladder cannot close the recipient before it is tried. A transient
   * continuation never carries it: the gate and the claim treat a `redriven`
   * record the same on every pass.
   */
  redrive?: true;
}

export function parseBroadcastSendPayload(payload: unknown): BroadcastSendPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('broadcastFanOut: payload is not an object');
  }
  const p = payload as Partial<BroadcastSendPayload>;
  if (typeof p.broadcastId !== 'string' || p.broadcastId.length === 0) {
    throw new Error('broadcastFanOut: missing broadcastId');
  }
  const attempt =
    typeof p.attempt === 'number' && Number.isInteger(p.attempt) && p.attempt >= 1 ? p.attempt : 1;
  const recipientKeys =
    Array.isArray(p.recipientKeys) && p.recipientKeys.every((k) => typeof k === 'string')
      ? p.recipientKeys
      : undefined;
  return {
    broadcastId: p.broadcastId,
    attempt,
    ...(recipientKeys !== undefined && { recipientKeys }),
    ...(p.redrive === true && { redrive: true as const }),
  };
}

/** Terminal recipient slot states never re-sent (idempotency). */
function isTerminal(status: BroadcastRecipient['status'] | undefined): boolean {
  return (
    status === 'sent' || status === 'delivered' || status === 'failed' || status === 'skipped'
  );
}

/**
 * S2: emit a live-progress SSE tick from the fan-out loop. Called after EVERY
 * bumpStats so the detail page's chips and recipient rows update roughly once a
 * second (bounded by A2P pacing; no server debounce needed). The stats are
 * DERIVED (S4) from the ALL_NEW item bumpStats returns (zero extra reads), and
 * the status is that item's status ('sending' mid-run). R2: only ever called
 * AFTER the slot write + bumpStats have persisted, so the emitted stats reflect
 * the committed state.
 *
 * NOTE: in DEPLOYED envs the fan-out runs in the worker process; these emits
 * cross the event bridge (lib/eventBridge.ts -> POST /internal/events) to the
 * app's SSE clients whenever EVENT_BRIDGE_URL is set (all deployed envs +
 * local runners). S3 polling + the DLR-rollup emits (webhooks = app process)
 * remain the liveness backstop for bare unset-URL runs.
 *
 * Exported for the send.reconcile job (SOR D15, D16): its adoption and its
 * closes move a slot too, and emit the same DERIVED stats.
 */
export function emitBroadcastProgress(events: EventBus, broadcastId: string, item: BroadcastItem): void {
  events.emit('broadcast.updated', {
    broadcastId,
    status: item.status,
    stats: deriveBroadcastStats(item),
  });
}

/** The broadcast member of the send-attempt owner union. */
type BroadcastOwner = Extract<SendAttemptOwner, { kind: 'broadcast' }>;

/** One pre-send fence: the slot it writes and the stats bucket it bumps (share-skip-fix D7). */
interface Fence {
  status: 'failed' | 'skipped';
  code: string;
  bucket: keyof BroadcastStats;
  note?: { level: 'warn' | 'info'; msg: string };
}

const NO_CONTACT_FENCE: Fence = {
  status: 'failed',
  code: 'no_contact',
  bucket: 'failed',
  note: { level: 'warn', msg: 'broadcastFanOut: recipient has no resolvable contact/phone - marked failed' },
};

/**
 * The four fences a resolved contact can meet, in today's order. TCPA first
 * fence: opted-out / unreachable (sendMessage's opt-out gate is the second
 * fence); opt-out wins when both flags are set. share-skip-fix I8: a
 * soft-deleted recipient is unreachable through this path, judged on the
 * RESOLVED contact after the opt-out fence and before the consent fence. A2P /
 * CTIA consent fence (spec Sec 4): a broadcast cannot pop a JIT modal
 * mid-fan-out, so a no-consent recipient is EXCLUDED here and counted
 * separately (skipped_no_consent) so the results view can prompt staff to
 * record consent.
 */
function fenceFor(contact: ContactItem): Fence | undefined {
  if (contact.sms_opt_out === true) return { status: 'skipped', code: 'opted_out', bucket: 'skipped_opted_out' };
  if (contact.sms_unreachable === true) return { status: 'skipped', code: 'unreachable', bucket: 'skipped_other' };
  if (isDeleted(contact)) {
    return {
      status: 'skipped',
      code: 'contact_deleted',
      bucket: 'skipped_other',
      note: { level: 'info', msg: 'broadcastFanOut: recipient contact is soft-deleted - skipped' },
    };
  }
  if (!hasSmsConsent(contact)) {
    return {
      status: 'skipped',
      code: 'no_consent',
      bucket: 'skipped_no_consent',
      note: { level: 'info', msg: 'broadcastFanOut: recipient has no recorded consent - skipped' },
    };
  }
  return undefined;
}

export interface BroadcastSendJobDeps {
  config?: AppConfig;
  broadcastsRepo?: BroadcastsRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  unitsRepo?: UnitsRepo;
  sendMessageService?: SendMessageService;
  /** BE2/C2: emit a `listing_sent` milestone per recipient actually sent. */
  activityEventsRepo?: ActivityEventsRepo;
  /** BE4/C4: record the listing-send row per recipient sent (when unit-targeted). */
  listingSendsRepo?: ListingSendsRepo;
  /** WS2: write a `broadcast_sent` unit-audit row on fan-out completion (best-effort). */
  auditRepo?: AuditRepo;
  /** Shared A2P token bucket (worker boot). Optional — tests may omit pacing. */
  tokenBucket?: TokenBucket;
  /**
   * The per-recipient send-attempt records (SOR spec D8a): claimed before
   * every send and read by the D8 gate. A test passes its fake world's so no
   * job run ever opens a real DynamoDB connection.
   */
  sendAttemptsRepo?: SendAttemptsRepo;
  events?: EventBus;
  logger?: Logger;
}

export function registerBroadcastSendJobHandler(deps: BroadcastSendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/services/config touch DynamoDB only on first job run.
  let config = deps.config;
  let broadcasts = deps.broadcastsRepo;
  let contacts = deps.contactsRepo;
  let conversations = deps.conversationsRepo;
  let units = deps.unitsRepo;
  let sendMessage = deps.sendMessageService;
  let sendAttempts = deps.sendAttemptsRepo;
  const events = deps.events ?? appEvents;

  defineJobHandler(BROADCAST_SEND_JOB, async (rawPayload) => {
    const payload = parseBroadcastSendPayload(rawPayload);
    config ??= loadConfig();
    broadcasts ??= createBroadcastsRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    units ??= createUnitsRepo({ logger: deps.logger });
    sendAttempts ??= createSendAttemptsRepo({ logger: deps.logger });
    const messages: MessagesRepo =
      deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
    const activityEvents: ActivityEventsRepo =
      deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
    const listingSends: ListingSendsRepo =
      deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
    const audit: AuditRepo = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
    sendMessage ??= createSendMessageService({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      messagesRepo: messages,
      contactsRepo: contacts,
      events,
    });

    // Whole-job duplicate-delivery guard (existing pattern): conditionally mark
    // this envelope jobId executed BEFORE any send. A redelivery resolves as a
    // no-op so the consumer deletes the message. Per-recipient terminal skips
    // are the second layer (a continuation reuses recipientKeys).
    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.broadcastId);
      if (!first) {
        log.info({ jobId, broadcastId: payload.broadcastId }, 'broadcast send duplicate delivery suppressed');
        return;
      }
    } else {
      log.warn(
        { broadcastId: payload.broadcastId },
        'broadcastFanOut: no jobId in context — duplicate-delivery guard skipped',
      );
    }

    // A continuation or a re-drive decides from a strongly consistent snapshot
    // (SOR D11, D16): the pass before it, or the reconcile, wrote the slots it
    // reads. The first pass keeps the cheap read.
    const broadcast =
      payload.recipientKeys !== undefined
        ? await broadcasts.getByIdConsistent(payload.broadcastId)
        : await broadcasts.getById(payload.broadcastId);
    if (!broadcast) {
      log.warn({ broadcastId: payload.broadcastId }, 'broadcastFanOut: broadcast not found — nothing to send');
      return;
    }

    // Pin the lazily-initialised repo. Capturing the reassignable `let` inside a
    // closure loses TS's non-undefined narrowing wherever that closure sits,
    // because the compiler cannot prove the binding is still set when it runs.
    // `snapshot` is the same pin for the point-in-time item: a hoisted function
    // declaration does not inherit the `if (!broadcast) return` narrowing.
    const repo = broadcasts;
    const snapshot = broadcast;
    // The same pins for the recipient unit's closures (build finding T7-4).
    const attempts = sendAttempts;
    const contactStore = contacts;
    const conversationStore = conversations;
    const send = sendMessage;
    const businessNumber = config.businessPhoneNumber;
    // The hoisted close function below reads this, so it is declared above it (TDZ).
    let claim: FanoutClaimResult | undefined;

    /**
     * M5 D8: terminal-close every still-open recipient in `recipientKeys` with
     * `code`, then finalize ONCE. Three situations need this and they are not
     * one code path - the cap reached mid-ladder (close A), a pass beginning
     * with the ladder already spent (close B), and a continuation the queue
     * refused (close C, D9) - but all three must leave the SAME terminal shape:
     * no recipient left `queued`, the persisted counters reconciled, the row no
     * longer `sending`, and one operator ERROR line naming the reason (D10).
     *
     * SOR D8: this is a close by a writer OTHER than the recipient's own
     * attempt, so each key passes the D8 gate first: an absent, done/retryable
     * or redriven record is closed (a redriven one's record too, FIRST, and
     * its slot only when that close won - code review C-4 / R-a; `code` keeps
     * the caller's reason, `transient_cap` or `enqueue_failed`); a stale
     * attempting record is taken over and handed to reconcile (so a recipient
     * whose release write failed still reaches a verdict at the cap); a live
     * or terminal one is left to its owner, and finalize then defers while its
     * slot is still queued. The slot close itself is conditional on `queued`.
     * Each key is its own try/catch: one failure never skips the rest, the
     * operator line, or finalize (build finding T7-9).
     */
    async function closeBroadcast(
      recipientKeys: string[],
      code: string,
      cause?: unknown,
    ): Promise<void> {
      for (const contactKey of recipientKeys) {
        // Both call sites pass an already-non-terminal set; re-checked against
        // the pass snapshot so a future caller cannot double-count a slot.
        if (isTerminal(snapshot.recipients?.[contactKey]?.status)) continue;
        const owner: BroadcastOwner = { kind: 'broadcast', broadcastId: payload.broadcastId, contactKey };
        const ctx = recipientCtx(contactKey);
        try {
          const gate = await gateFor(attempts, owner, Date.now());
          if (gate.kind === 'taken_over') {
            await handOff(owner, gate.record.attemptedAt);
            continue;
          }
          if (gate.kind !== 'proceed') {
            log.info({ ...ctx, gate: gate.kind, closeCode: code }, 'broadcastFanOut: close left the recipient to its own attempt');
            continue;
          }
          // Code review C-4 / R-a: a redriven record closes FIRST, and the slot
          // only when that won - a pass that re-claimed it since keeps it.
          if (
            gate.record?.state === 'redriven' &&
            !(await attempts.closeRedriven(owner, {
              outcome: code === ENQUEUE_FAILED_CODE ? 'enqueue_failed' : 'refused',
              cause: code,
            }))
          ) {
            log.info({ ...ctx, closeCode: code }, 'broadcastFanOut: close not written - another pass re-claimed the re-driven recipient');
            continue;
          }
          const closed = await repo.closeRecipientIfQueued(payload.broadcastId, contactKey, code, 'failed');
          if (closed.moved && closed.item) emitBroadcastProgress(events, payload.broadcastId, closed.item);
        } catch (err) {
          log.error({ err, ...ctx, label: 'capClose' }, 'broadcastFanOut: closing one recipient failed; the rest still close');
        }
      }
      // D10: the ONE operator line carries the DURABLE pass number, never the
      // envelope's. On the LADDER closes (A and B) that is the number the close
      // was decided on - `capped` the unchanged stored count (close B: 3 beside
      // a first-pass envelope's 1), `claimed` the number this pass took; on
      // close C the queue refusal decided it and the claimed pass is context
      // only. The envelope value stays alongside, renamed, for correlation only
      // - the two must not be confusable.
      const fanoutAttempt =
        claim !== undefined && claim.outcome !== 'missing' ? claim.attempt : undefined;
      log.error(
        {
          broadcastId: payload.broadcastId,
          deferred: recipientKeys.length,
          closeCode: code,
          fanoutAttempt,
          envelopeAttempt: payload.attempt,
          ...(cause !== undefined && { err: cause }),
        },
        'broadcastFanOut: fan-out closed - remaining recipients marked failed',
      );
      await finalize(repo, events, payload.broadcastId, log, audit);
    }

    // Resolve the unit-derived merge context ONCE (constant for the broadcast);
    // only [TenantName] is per-recipient.
    const unit =
      typeof broadcast.unitId === 'string' && broadcast.unitId.length > 0
        ? await units.getById(broadcast.unitId)
        : undefined;
    const unitContext = buildUnitMergeContext(unit, config.publicBaseUrl);

    // The recipient set: the continuation's remaining keys, else every key from
    // the persisted snapshot.
    const allKeys = Object.keys(broadcast.recipients ?? {});
    const keys =
      payload.recipientKeys !== undefined
        ? allKeys.filter((k) => payload.recipientKeys!.includes(k))
        : allKeys;

    // M5 D1/D6: claim this pass on the DURABLE item before any send. The count
    // used to live in the enqueued envelope, so it only advanced when the queue
    // accepted the continuation - a broken queue froze it and the cap below
    // could never be reached. Claimed here, BELOW the duplicate-delivery guard
    // and only when this pass will actually attempt a send: a job that sends
    // nothing must not spend a rung, and a redelivery must not either.
    // SOR D13a: a RE-DRIVE pass claims nothing up front - only after its loop,
    // and only if it has a transient remainder - so a spent ladder cannot
    // close the re-driven recipient before it is tried.
    const pending = keys.filter((k) => !isTerminal(broadcast.recipients?.[k]?.status));
    if (pending.length > 0 && payload.redrive !== true) {
      claim = await repo.claimFanoutPass(payload.broadcastId, MAX_BROADCAST_ATTEMPTS);
      if (claim.outcome === 'missing') {
        log.warn(
          { broadcastId: payload.broadcastId },
          'broadcastFanOut: broadcast vanished before the pass claim - nothing to send',
        );
        return;
      }
      if (claim.outcome === 'capped') {
        // Close B: the ladder was already spent when this pass began, so there
        // is nothing to attempt and nothing further will arrive.
        await closeBroadcast(pending, TRANSIENT_CAP_CODE);
        return;
      }
    }
    // pending.length === 0 -> nothing to send; fall through to the trailing
    // finalize without consuming a rung.

    const transientRemaining: string[] = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let handedCount = 0;

    /** The log context of one recipient: its key through safeRecipientKey, never a raw phone key. */
    function recipientCtx(contactKey: string): { broadcastId: string; recipientKey: string } {
      return { broadcastId: payload.broadcastId, recipientKey: safeRecipientKey(contactKey) };
    }

    /**
     * A deferral's slot write: a CONDITIONAL move from `queued` only, with an
     * EMPTY stats delta - never a blind setRecipient, which could revert a
     * fence's `skipped` or a foreign attempt's `sent`.
     */
    function deferSlot(contactKey: string, errorCode: string): Promise<unknown> {
      return repo.recordRecipientOutcome(payload.broadcastId, contactKey, { status: 'queued', errorCode }, {}, ['queued']);
    }

    /**
     * Enqueue check 0 of the send.reconcile chain for one recipient (D7). NEVER
     * throws: an enqueue that fails closes the recipient unresolved on the spot
     * - the slot `failed` / send_unconfirmed FIRST, then the record done /
     * unresolved (D7, D13a) - so nothing waits on a chain that never started.
     * A slot close that throws leaves the record `reconciling` (code review
     * C-2): no pass can act on it, so it is the sweeper's, and not carried.
     */
    async function handOff(owner: BroadcastOwner, attemptedAt: string): Promise<void> {
      const ctx = recipientCtx(owner.contactKey);
      try {
        await enqueueSendReconcile(
          { owner: toOwnerRef(owner), attemptedAt, checkNo: 0 },
          reconcileDelayMs(attemptedAt, 0, Date.now()),
        );
      } catch (err) {
        const slotClosed = await guardWrite(log, ctx, 'closeUnconfirmed', async () => {
          const closed = await repo.closeRecipientIfQueued(
            payload.broadcastId,
            owner.contactKey,
            SEND_UNCONFIRMED_CODE,
            'unconfirmed',
          );
          if (closed.moved && closed.item) emitBroadcastProgress(events, payload.broadcastId, closed.item);
        });
        if (slotClosed) {
          await guardWrite(log, ctx, 'closeFromReconcile', () =>
            attempts.closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE }),
          );
        }
        log.error(
          { err, ...ctx, cause: ENQUEUE_FAILED_CODE },
          slotClosed
            ? 'broadcastFanOut: reconcile enqueue failed - recipient closed unresolved (send_unconfirmed)'
            : 'broadcastFanOut: reconcile enqueue failed and its unresolved close failed - the record stays reconciling for the sweeper',
        );
      }
    }

    /**
     * Move this attempt to `reconciling` (with the SID when one is known) and
     * hand it off. Build finding G5: guardWrite's `true` means the write
     * RESOLVED, not that its fence won - so the fence's own answer decides:
     * written AND won -> hand off; written but LOST (a takeover already owns
     * the record and handed it off itself) -> nothing to do; not written ->
     * STRANDED: the record stays `attempting`, the recipient is carried with no
     * slot write, and a later pass's claim takes the stale record over.
     */
    async function handToReconcile(owner: BroadcastOwner, ref: AttemptRef, sid?: string): Promise<void> {
      const ctx = recipientCtx(owner.contactKey);
      let handed = false;
      const wrote = await guardWrite(log, ctx, 'handToReconcile', async () => {
        handed = await attempts.handToReconcile(owner, ref, sid);
      });
      if (wrote && handed) {
        handedCount += 1;
        await handOff(owner, ref.attemptedAt);
        return;
      }
      if (wrote) {
        log.info({ ...ctx }, 'broadcastFanOut: hand-off fence lost - the takeover owns the record');
        return;
      }
      transientRemaining.push(owner.contactKey);
    }

    /**
     * Release THIS attempt as retryable and defer the recipient (D6, D7a):
     * the slot `queued` + code first, then the record done/retryable.
     */
    async function deferClaimed(owner: BroadcastOwner, ref: AttemptRef, code: string): Promise<void> {
      const ctx = recipientCtx(owner.contactKey);
      await guardWrite(log, ctx, 'deferSlot', () => deferSlot(owner.contactKey, code));
      transientRemaining.push(owner.contactKey);
      await guardWrite(log, ctx, 'finishAttempt', () =>
        attempts.finishAttempt(owner, ref, { outcome: 'retryable', cause: code }),
      );
    }

    /**
     * A fence's decline, behind the D8 gate: the fence writes its slot only
     * when no live attempt owns the recipient. A redriven record reached here
     * (on the re-drive pass or on any continuation that still carries the key)
     * is closed done/refused with the fence's code - FIRST, the slot only when
     * that close won (code review C-4 / R-a).
     */
    async function declineAtFence(owner: BroadcastOwner, fence: Fence): Promise<void> {
      const ctx = recipientCtx(owner.contactKey);
      const gate = await gateFor(attempts, owner, Date.now());
      if (gate.kind === 'skip') {
        log.info({ ...ctx, fence: fence.code }, 'broadcastFanOut: fence not written - the recipient attempt is terminal');
        return;
      }
      if (gate.kind === 'defer') {
        if (payload.recipientKeys !== undefined) transientRemaining.push(owner.contactKey);
        log.info({ ...ctx, fence: fence.code }, 'broadcastFanOut: fence deferred - another attempt owns the recipient');
        return;
      }
      if (gate.kind === 'taken_over') {
        await handOff(owner, gate.record.attemptedAt);
        return;
      }
      // Code review C-3 and C-4 / R-a: PREPARE writes, not failure arms - a
      // throw reaches the unit's prepare catch, which defers and carries. A
      // redriven record closes FIRST; a pass that re-claimed it since keeps
      // the recipient, so the fence writes nothing and does not carry it.
      if (gate.record?.state === 'redriven' && !(await attempts.closeRedriven(owner, { outcome: 'refused', cause: fence.code }))) {
        log.info({ ...ctx, fence: fence.code }, 'broadcastFanOut: fence not written - another pass re-claimed the re-driven recipient');
        return;
      }
      await recordRecipient(repo, payload.broadcastId, owner.contactKey, { status: fence.status, errorCode: fence.code });
      emitBroadcastProgress(
        events,
        payload.broadcastId,
        await repo.bumpStats(payload.broadcastId, { [fence.bucket]: 1, queued: -1 }),
      );
      if (fence.status === 'failed') failedCount += 1;
      else skippedCount += 1;
      if (fence.note?.level === 'warn') log.warn({ ...ctx }, fence.note.msg);
      else if (fence.note?.level === 'info') log.info({ ...ctx }, fence.note.msg);
    }

    /**
     * A provider rejection (D5): the recipient fails with the provider code; the
     * record closes rejected - only once the slot write RESOLVED (code review
     * C-2): a slot write that threw leaves the attempt open and the recipient
     * carried, so a later pass meets it (deferred while fresh; taken over into
     * reconcile when stale at the cap).
     */
    async function onRejected(
      owner: BroadcastOwner,
      ref: AttemptRef,
      contact: ContactItem,
      classification: SendFailureClassification,
    ): Promise<void> {
      const ctx = recipientCtx(owner.contactKey);
      const code = classification.code;
      let slotWritten: boolean;
      if (code === CARRIER_FILTERED_CODE || (code !== undefined && UNREACHABLE_CODES.has(code))) {
        // Today's two arms, writes unchanged.
        slotWritten = await guardWrite(log, ctx, 'rejectSlot', async () => {
          await recordRecipient(repo, payload.broadcastId, owner.contactKey, { status: 'failed', errorCode: code });
          emitBroadcastProgress(
            events,
            payload.broadcastId,
            await repo.bumpStats(payload.broadcastId, { failed: 1, queued: -1 }),
          );
        });
        if (code === CARRIER_FILTERED_CODE) {
          log.error({ ...ctx, errorCode: code }, 'broadcastFanOut: carrier filtering (30007) - recipient failed, NOT retried');
        } else {
          // TODO(mms-silent-drop-dish-textnow): scope BOTH codes to SMS legs if
          // broadcasts ever carry media. The status webhook's twin arm
          // (routes/webhooks/twilio.ts) no longer accepts EITHER 30005 or 30006
          // from an MMS leg as evidence about SMS reachability - prod 2026-08-24
          // had a Verizon mobile deliver 10/10 texts while 6/6 of its MMS died
          // 30005, and 30006's "unreachable carrier" half is message-type-
          // specific too. This arm is SAFE ONLY BECAUSE the sendMessage call
          // passes no mediaUrls or attachments, so every broadcast leg is typed
          // 'sms'. Per-recipient media on broadcasts is an OPEN proposal
          // (docs/issues/broadcast-mms.md); the day it lands, this line
          // re-creates the false positive that wrongly flagged two prod
          // contacts sms_unreachable.
          // Flag the contact unreachable (prompt voice; never retry SMS).
          try {
            await contactStore.setFlag(contact.contactId, 'sms_unreachable');
          } catch (flagErr) {
            log.error({ err: flagErr, ...ctx }, 'broadcastFanOut: failed to flag contact sms_unreachable');
          }
          log.warn({ ...ctx, errorCode: code }, 'broadcastFanOut: invalid number/landline - recipient failed, contact flagged unreachable');
        }
      } else {
        // An HTTP status is NEVER a slot code (D10, D23): a rejection with no
        // provider code fails the slot with no errorCode; the kill switch's
        // token has prose, so it is kept.
        const slotCode = isProviderCode(code) || code === SMS_SENDING_DISABLED_CODE ? code : undefined;
        slotWritten = await guardWrite(log, ctx, 'rejectSlot', async () => {
          const moved = await repo.recordRecipientOutcome(
            payload.broadcastId,
            owner.contactKey,
            { status: 'failed', ...(slotCode !== undefined && { errorCode: slotCode }) },
            { failed: 1, queued: -1 },
            ['queued'],
          );
          if (moved.moved && moved.item) emitBroadcastProgress(events, payload.broadcastId, moved.item);
        });
        log.warn(
          { ...ctx, errorCode: code, status: classification.status },
          'broadcastFanOut: send rejected by the provider - recipient failed, NOT retried',
        );
      }
      if (!slotWritten) {
        transientRemaining.push(owner.contactKey);
        return;
      }
      // The record's cause keeps what the slot may not: the HTTP status of a code-less 4xx.
      const cause = code ?? (classification.status !== undefined ? String(classification.status) : undefined);
      await guardWrite(log, ctx, 'finishAttempt', () =>
        attempts.finishAttempt(owner, ref, { outcome: 'rejected', ...(cause !== undefined && { cause }) }),
      );
      failedCount += 1;
    }

    /**
     * An UNKNOWN provider outcome (D7): the recipient is handed to the
     * reconcile job and its slot is left `queued`. On an attempt whose record
     * was already re-driven once (D13a) there is no second reconcile: it closes
     * unresolved on the spot.
     */
    async function onUnknown(owner: BroadcastOwner, ref: AttemptRef, secondUnknownWouldClose: boolean, err: unknown): Promise<void> {
      const ctx = recipientCtx(owner.contactKey);
      if (secondUnknownWouldClose) {
        const slotClosed = await guardWrite(log, ctx, 'closeUnconfirmed', async () => {
          const closed = await repo.closeRecipientIfQueued(
            payload.broadcastId,
            owner.contactKey,
            SEND_UNCONFIRMED_CODE,
            'unconfirmed',
          );
          if (closed.moved && closed.item) emitBroadcastProgress(events, payload.broadcastId, closed.item);
        });
        if (!slotClosed) {
          // Code review C-2: the attempt stays open and the recipient is carried.
          transientRemaining.push(owner.contactKey);
          log.error(
            { err, ...ctx, cause: 'second_unknown' },
            'broadcastFanOut: unknown send outcome after a re-drive - its unresolved close failed; the attempt stays open and the recipient is carried',
          );
          return;
        }
        await guardWrite(log, ctx, 'finishAttempt', () =>
          attempts.finishAttempt(owner, ref, { outcome: 'unresolved', cause: 'second_unknown' }),
        );
        log.error(
          { err, ...ctx, cause: 'second_unknown' },
          'broadcastFanOut: unknown send outcome after a re-drive - recipient closed unresolved (send_unconfirmed)',
        );
        return;
      }
      log.warn({ err, ...ctx }, 'broadcastFanOut: unknown send outcome - recipient handed to reconcile');
      await handToReconcile(owner, ref);
    }

    /** Best-effort follow-ups of a RECORDED send (D7a): each is isolated and none throws. */
    async function afterSend(contact: ContactItem, contactKey: string): Promise<void> {
      const ctx = recipientCtx(contactKey);
      // A2P meter: ONE token per REAL outbound SMS. Acquired AFTER the slot
      // write, the token still gates the NEXT send (post-send pacing), so the
      // shared ~1/s bucket still rate-limits the fan-out.
      try {
        await deps.tokenBucket?.acquire(1);
      } catch (acquireErr) {
        log.warn({ err: acquireErr, ...ctx }, 'broadcastFanOut: A2P token acquire failed after a recorded send (best-effort pacing)');
      }
      await recordPropertySent({ activityEvents, listingSends }, log, ctx, {
        contactId: contact.contactId,
        unitId: snapshot.unitId,
        broadcastId: payload.broadcastId,
      });
    }

    /**
     * ONE recipient, start to finish (spec D7a). One try/catch tracks the
     * phase, and the phase decides the catch: a throw at 'sending' or later is
     * NEVER turned into a re-send; a throw in 'prepare' sent nothing and defers
     * the recipient. Returns whether this was an UNKNOWN provider outcome (the
     * D9 streak's input). Never throws.
     */
    async function runRecipient(contactKey: string): Promise<'unknown' | 'other'> {
      const owner: BroadcastOwner = { kind: 'broadcast', broadcastId: payload.broadcastId, contactKey };
      const ctx = recipientCtx(contactKey);
      let phase: 'prepare' | 'sending' | 'record' = 'prepare';
      let ref: AttemptRef | undefined;
      let contact: ContactItem | undefined;
      let outcome: SendMessageOutcome | undefined;
      let secondUnknownWouldClose = false;
      let takenOver = false;
      try {
        // PREPARE. Resolve the contact (the snapshot holds keys; re-read flags
        // fresh so a STOP since send-time is honored), then the fences.
        contact = await resolveContact(contactStore, contactKey);
        if (contact === undefined || typeof contact.phone !== 'string' || contact.phone.length === 0) {
          await declineAtFence(owner, NO_CONTACT_FENCE);
          return 'other';
        }
        const fence = fenceFor(contact);
        if (fence !== undefined) {
          await declineAtFence(owner, fence);
          return 'other';
        }
        // Resolve/find the tenant's 1:1 conversation by phone, then send INTO it.
        const conversation = await conversationStore.createOrGetByParticipantPhone(contact.phone, 'tenant_1to1');
        const body = renderBody(snapshot.body_template, unitContext, firstNameOf(contact));
        // CLAIM (D8a), immediately before the send: the facts a reconcile
        // matches on - the destination sendMessage texts and the sender it pins.
        const fp = bodyFingerprint(body);
        const attempt = await attempts.claim(
          owner,
          {
            recipientDigest: recipientDigest(businessNumber, conversation.participant_phone ?? contact.phone),
            ...(businessNumber !== undefined && { sender: businessNumber }),
            bodyHash: fp.hash,
            bodyShort: fp.short,
            mediaCount: 0,
          },
          new Date().toISOString(),
        );
        if (attempt.outcome === 'refused') {
          // A live foreign attempt (fresh): defer - carried only by a
          // continuation. Terminal or reconciling: skip - never carried.
          if (attempt.fresh && payload.recipientKeys !== undefined) transientRemaining.push(contactKey);
          log.info(
            { ...ctx, state: attempt.record.state, fresh: attempt.fresh },
            'broadcastFanOut: claim refused - another attempt owns the recipient or it is resolved',
          );
          return 'other';
        }
        if (attempt.outcome === 'takeover') {
          // A stale attempt: a process died mid-send, or the call overran. The
          // outcome is unknown - take it over into reconcile, never re-send.
          if (await attempts.takeOver(owner, attempt.record)) await handOff(owner, attempt.record.attemptedAt);
          else log.info({ ...ctx }, 'broadcastFanOut: takeover lost - another writer moved the stale attempt');
          return 'other';
        }
        ref = { attemptNo: attempt.record.attemptNo, attemptedAt: attempt.record.attemptedAt };
        secondUnknownWouldClose = attempt.record.redriveCount >= 1;

        // SEND. sendMessage runs FIRST - it may throw SendRefusedError (opt-out
        // / deleted / consent, or manual / breaker on an automated share)
        // BEFORE any adapter send, and a refusal spends NO token.
        // share-skip-fix D4: a share the dashboard created is a PERSON'S send -
        // the switch and the breaker do not apply; kill switch, opt-out,
        // deleted and consent still do (the wrapper's gates). Anything else
        // (a pre-2026-09-25 draft, a future engine) stays automated.
        phase = 'sending';
        outcome = await send({
          conversationId: conversation.conversationId,
          body,
          author: 'teammate',
          automated: snapshot.created_via !== 'dashboard',
          // I8: the fenced recipient, so a duplicate contact on the same phone
          // cannot make the wrapper refuse (or admit) the wrong person.
          recipient: contact,
          broadcastId: payload.broadcastId,
          // Code review ADV-1: re-arm the claim as the LAST step before the
          // provider call. A lost re-arm - the attempt was taken over - sends
          // nothing; a throw is a SendNotAttemptedError (deferred below).
          beforeProviderSend: async () => {
            const rearmed = await attempts.rearm(owner, ref!, new Date().toISOString());
            if (rearmed === undefined) {
              takenOver = true;
              return false;
            }
            ref = rearmed;
            return true;
          },
        });

        // RECORD. The slot (conversationId+tsMsgId, status 'sent') and its
        // stats bump in ONE conditional write, BEFORE the A2P pacing acquire:
        // the provider's delivery status callback can fire within the ~1s
        // token gap, and the /status rollup matches THIS message to its slot
        // by conversationId+tsMsgId - the slot must exist first. The live
        // 'sent' tick follows it. Then the record done/sent.
        phase = 'record';
        const recorded = await repo.recordRecipientOutcome(
          payload.broadcastId,
          contactKey,
          { conversationId: outcome.conversationId, tsMsgId: outcome.tsMsgId, status: 'sent' },
          { sent: 1, queued: -1 },
          ['queued'],
        );
        if (recorded.moved && recorded.item) emitBroadcastProgress(events, payload.broadcastId, recorded.item);
        if (!(await attempts.finishAttempt(owner, ref, { outcome: 'sent', sid: outcome.providerSid }))) {
          // Plan deviation 3: the slot is not rolled back - the takeover's
          // reconcile finds the SID through the pointer and repairs.
          log.warn(
            { ...ctx, providerSid: outcome.providerSid },
            'broadcastFanOut: attempt fence lost after the slot write; the takeover reconcile repairs',
          );
        }
        sentCount += 1;
        await afterSend(contact, contactKey);
        return 'other';
      } catch (err) {
        if (phase === 'prepare') {
          if (ref !== undefined) {
            // Defensive: nothing runs between the claim and the send today.
            await deferClaimed(owner, ref, SEND_RETRYABLE_CODE);
            return 'other';
          }
          // Nothing was sent and no attempt of ours exists: defer.
          await guardWrite(log, ctx, 'deferSlot', () => deferSlot(contactKey, SEND_RETRYABLE_CODE));
          transientRemaining.push(contactKey);
          log.warn({ err, ...ctx }, 'broadcastFanOut: prepare failed - recipient deferred to the continuation');
          return 'other';
        }
        // From here on this attempt holds the claim: `ref` is set.
        const held = ref!;
        if (phase === 'record') {
          // The send HAPPENED and its SID is known; a record-phase write
          // threw. Never classified, never re-sent (D3a): handed to reconcile
          // WITH the SID, whose adoption re-runs those writes idempotently.
          log.error(
            { err, ...ctx, providerSid: outcome!.providerSid },
            'broadcastFanOut: sent_unrecorded - recipient sent but not recorded; its SID goes to reconcile',
          );
          await handToReconcile(owner, held, outcome!.providerSid);
          return 'other';
        }
        // phase === 'sending': sendMessage throws refusals and the three typed errors.
        if (err instanceof SendRefusedError) {
          // A by-design refusal for THIS recipient: opt-out / deleted /
          // consent, or manual / breaker on an AUTOMATED share. A skip (no
          // token spent), filed in the bucket its code selects.
          const code = err.code;
          const bucket: keyof BroadcastStats = isNoConsentCode(code)
            ? 'skipped_no_consent'
            : isOptedOutCode(code)
              ? 'skipped_opted_out'
              : 'skipped_other';
          const slotWritten = await guardWrite(log, { ...ctx, refusal: code }, 'refusedSlot', async () => {
            await recordRecipient(repo, payload.broadcastId, contactKey, { status: 'skipped', errorCode: code });
            emitBroadcastProgress(
              events,
              payload.broadcastId,
              await repo.bumpStats(payload.broadcastId, { [bucket]: 1, queued: -1 }),
            );
          });
          if (!slotWritten) {
            // Code review C-2: the attempt stays open and the recipient is carried.
            transientRemaining.push(contactKey);
            return 'other';
          }
          await guardWrite(log, ctx, 'finishAttempt', () =>
            attempts.finishAttempt(owner, held, { outcome: 'refused', cause: code }),
          );
          skippedCount += 1;
          log.warn({ ...ctx, refusal: code }, 'broadcastFanOut: send refused - recipient skipped, continuing');
          return 'other';
        }
        if (err instanceof SendNotAttemptedError) {
          if (takenOver) {
            // ADV-1: the re-arm found the attempt taken over - its reconcile
            // owns it. Nothing sent, nothing written, not carried.
            log.info({ ...ctx }, 'broadcastFanOut: attempt taken over before the send - not sent; the takeover owns it');
            return 'other';
          }
          // The wrapper failed before its provider call: nothing was sent.
          log.warn({ err, ...ctx }, 'broadcastFanOut: send not attempted - recipient deferred to the continuation');
          await deferClaimed(owner, held, SEND_RETRYABLE_CODE);
          return 'other';
        }
        if (err instanceof SendAcceptedNotRecordedError) {
          log.error(
            { err, ...ctx, providerSid: err.providerSid },
            'broadcastFanOut: sent_unrecorded - recipient sent but not recorded; its SID goes to reconcile',
          );
          await handToReconcile(owner, held, err.providerSid);
          return 'other';
        }
        // Anything else at 'sending' is unknown (D2): the reconcile decides.
        const classification: SendFailureClassification =
          err instanceof ProviderSendFailedError ? err.classification : { kind: 'unknown' };
        if (classification.kind === 'rejected') {
          await onRejected(owner, held, contact!, classification);
          return 'other';
        }
        if (classification.kind === 'retryable') {
          // Defer to a backed-off continuation; the slot stays 'queued' with
          // the provider code, or send_retryable when there is none (a network
          // string never reaches a slot, D6). No stats move, so no tick.
          const code = classification.code;
          const slotCode = isProviderCode(code) ? code! : SEND_RETRYABLE_CODE;
          log.warn(
            { ...ctx, errorCode: slotCode, attempt: payload.attempt },
            'broadcastFanOut: transient send error - deferring recipient to the continuation',
          );
          await deferClaimed(owner, held, slotCode);
          return 'other';
        }
        await onUnknown(owner, held, secondUnknownWouldClose, err);
        return 'unknown';
      }
    }

    // D9 outage brake: consecutive UNKNOWN outcomes in THIS pass. Any other
    // outcome - sent, rejected, retryable, refused, a skip, a deferral - resets
    // it; a hand-off and a stranded unknown both count (the provider answered
    // nothing either way). Once braked, every recipient not yet attempted in
    // this pass is deferred, whatever its record says.
    let unknownStreak = 0;
    let braked = false;
    let untried = 0;
    for (const contactKey of keys) {
      // Already terminal - never re-send. Checked BEFORE the brake, so a
      // terminal key is never carried (build finding T7-12).
      if (isTerminal(broadcast.recipients[contactKey]?.status)) continue;
      if (braked) {
        transientRemaining.push(contactKey);
        untried += 1;
        continue;
      }
      if ((await runRecipient(contactKey)) === 'unknown') {
        unknownStreak += 1;
        if (unknownStreak >= OUTAGE_BRAKE_UNKNOWN_STREAK) braked = true;
      } else {
        unknownStreak = 0;
      }
    }
    if (braked) {
      log.warn(
        {
          event: 'outage_brake',
          broadcastId: payload.broadcastId,
          untried,
          deferred: transientRemaining.length,
          attempt: payload.attempt,
        },
        'broadcastFanOut: outage brake - consecutive unknown send outcomes; the untried remainder is deferred',
      );
    }

    log.info(
      {
        broadcastId: payload.broadcastId,
        recipientCount: keys.length,
        sentCount,
        skippedCount,
        failedCount,
        handed: handedCount,
        deferred: transientRemaining.length,
        attempt: payload.attempt,
      },
      'broadcast send pass complete',
    );

    // Transient continuation: re-enqueue the remaining recipients with backoff,
    // capped. The cap closes AT the last rung, not beyond it: close A fires on
    // `claim.attempt >= MAX_BROADCAST_ATTEMPTS`, so the pass that spends the
    // final rung is the one that marks the still-deferred recipients failed
    // (no silent black hole, and no fourth pass exists to do it later).
    if (transientRemaining.length > 0) {
      if (claim === undefined) {
        // Reached only by a RE-DRIVE pass (every other pass with a
        // non-terminal key claimed above): it claims its rung now, because it
        // has a remainder to defer, and takes the same branches the up-front
        // claim takes - never a close for want of a claim.
        claim = await repo.claimFanoutPass(payload.broadcastId, MAX_BROADCAST_ATTEMPTS);
        if (claim.outcome === 'missing') {
          log.warn(
            { broadcastId: payload.broadcastId },
            'broadcastFanOut: broadcast vanished before the pass claim - nothing to defer',
          );
          return;
        }
        if (claim.outcome === 'capped') {
          await closeBroadcast(transientRemaining, TRANSIENT_CAP_CODE);
          return;
        }
      }
      if (claim.outcome !== 'claimed') {
        // Unreachable by construction: the up-front claim returned above on
        // `missing` and `capped`. Narrowed rather than asserted, and closed
        // rather than ignored, so D8 holds even if the impossible ever happens.
        await closeBroadcast(transientRemaining, TRANSIENT_CAP_CODE);
        return;
      }
      // The claimed pass number is the durable one; the envelope's `attempt` is
      // advisory from M5 on.
      const nextAttempt = claim.attempt + 1;
      if (claim.attempt >= MAX_BROADCAST_ATTEMPTS) {
        // Close A: this pass WAS the last rung, so no continuation follows and
        // the still-deferred recipients close here (no silent black hole).
        await closeBroadcast(transientRemaining, TRANSIENT_CAP_CODE);
        return;
      }
      try {
        await enqueue(
          BROADCAST_SEND_JOB,
          {
            broadcastId: payload.broadcastId,
            attempt: nextAttempt,
            recipientKeys: transientRemaining,
          } satisfies BroadcastSendPayload,
          // The continuation runs AS nextAttempt, so it waits ITS OWN backoff
          // (attempt 1->2 waits the 2nd-step delay = 10s, 2->3 = 20s). Using
          // the current attempt's delay here would under-wait by one step.
          { runAt: new Date(Date.now() + broadcastBackoffMs(nextAttempt)) },
        );
      } catch (err) {
        // Close C (D9): the queue refused the continuation, so nothing will come
        // back - a redelivery of THIS envelope is suppressed by the job marker
        // above. Close now instead of leaving the broadcast 'sending' forever.
        // The reason is its OWN code (D10): retries never ran here.
        await closeBroadcast(transientRemaining, ENQUEUE_FAILED_CODE, err);
        return;
      }
      // A continuation is still pending - do NOT finalize yet.
      return;
    }

    // No recipients remain open in this pass -> finalize (D16a): it defers
    // itself while any slot is still queued (a recipient being reconciled).
    await finalize(repo, events, payload.broadcastId, log, audit);
  });
}

/**
 * Resolve the contact behind a contactKey (contactId else `phone#<E164>`).
 * Strongly consistent where the repo offers it (build finding T10-3): a
 * contactId is a primary-key read, read consistently so a STOP or a number
 * change since send time is seen; the phone lookup has no consistent form.
 * Exported for the send.reconcile job, which re-reads the recipient's CURRENT
 * number through it (spec D12) and adopts onto the same contact (D15).
 */
export async function resolveContact(
  contacts: ContactsRepo,
  contactKey: string,
): Promise<ContactItem | undefined> {
  if (contactKey.startsWith('phone#')) {
    return contacts.findByPhone(contactKey.slice('phone#'.length));
  }
  return contacts.getById(contactKey, { consistentRead: true });
}

/**
 * The two rows a SENT property writes (BE2/C2, BE4/C4) - the pass after a
 * recorded send and the reconcile's adoption of a sent or delivered message
 * (SOR D15) alike. Each is best-effort: a failure is logged at ERROR and never
 * fails the send (the SMS is out and its slot recorded).
 */
async function recordPropertySent(
  repos: { activityEvents: ActivityEventsRepo; listingSends: ListingSendsRepo },
  log: Logger,
  ctx: Record<string, unknown>,
  args: { contactId: string; unitId: string | undefined; broadcastId: string },
): Promise<void> {
  // BE2/C2: a delivered property is a `listing_sent` milestone on the
  // tenant's timeline. Prefer the unit (the thing sent) as the deep-link
  // target; fall back to the broadcast when the broadcast has no unitId.
  const unitId = args.unitId;
  const hasUnit = typeof unitId === 'string' && unitId.length > 0;
  try {
    await repos.activityEvents.record({
      contactId: args.contactId,
      type: 'listing_sent',
      label: 'Property sent',
      refType: hasUnit ? 'unit' : 'broadcast',
      refId: hasUnit ? unitId : args.broadcastId,
    });
  } catch (milestoneErr) {
    log.error(
      { err: milestoneErr, ...ctx },
      'broadcastFanOut: recording listing_sent milestone failed (best-effort)',
    );
  }
  // BE4/C4: record the unit<->contact listing-send row so the "Sent to
  // tenants" / "Properties sent" pages light up. ONLY when the broadcast
  // targets a unit (a unit-less broadcast records nothing - there is no
  // property to attribute). Idempotent: the upsert is safe on a redelivery.
  if (hasUnit) {
    try {
      await repos.listingSends.recordSend({
        contactId: args.contactId,
        unitId,
        via: 'broadcast',
        broadcastId: args.broadcastId,
      });
    } catch (sendErr) {
      log.error(
        { err: sendErr, ...ctx },
        'broadcastFanOut: recording listing-send row failed (best-effort)',
      );
    }
  }
}

/**
 * What the send.reconcile job's adoption of a broadcast recipient reads and
 * writes (SOR spec D15): the reads the pass makes and the writes its success
 * path - the send wrapper's append, the slot, the rows a sent property writes
 * - would have made.
 */
export interface AdoptDeps {
  broadcasts: BroadcastsRepo;
  contacts: ContactsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  activityEvents: ActivityEventsRepo;
  listingSends: ListingSendsRepo;
  audit: AuditRepo;
  events: EventBus;
  log: Logger;
}

/** The message the provider holds, as the reconcile read it (spec D17), for one broadcast recipient. */
export interface AdoptBroadcastArgs {
  broadcastId: string;
  contactKey: string;
  providerSid: string;
  /** The provider's CREATION time - the clock the send wrapper stamps as provider_ts. */
  providerTs: string;
  /** The provider's RAW status (mapTwilioStatus maps it). */
  providerStatus: string;
  errorCode?: string;
  body: string;
  mediaCount: number;
  /** The provider's date_sent, when it has one (the slot's carrierSentAt). */
  sentAt?: string;
}

/**
 * Is this 1:1 row THIS broadcast recipient's (plan Task 7, R2 #18)? Two shares
 * to one tenant share a conversation, and two contacts on one phone in ONE
 * share share it too - so the row must carry this share's `broadcast_id` AND
 * name no other contact: its `recipient_contact_id` absent (the send wrapper
 * records one only while the named contact holds the thread's number), this
 * contact, or the row this recipient's slot already carries.
 */
export function isBroadcastRowFor(
  row: Pick<MessageItem, 'broadcast_id' | 'recipient_contact_id' | 'tsMsgId'>,
  owner: { broadcastId: string; contactId: string | undefined; slotTsMsgId: string | undefined },
): boolean {
  if (row.broadcast_id !== owner.broadcastId) return false;
  return (
    row.recipient_contact_id === undefined ||
    row.recipient_contact_id === owner.contactId ||
    (owner.slotTsMsgId !== undefined && owner.slotTsMsgId === row.tsMsgId)
  );
}

/**
 * SOR spec D15: record a message the provider ALREADY holds for one broadcast
 * recipient, the way the pass's success path would have. Called by the
 * send.reconcile job inside its candidate loop (and for a known SID); every
 * write is idempotent, conditional or forward-only, so a re-run completes
 * rather than duplicates.
 *
 * In this order:
 *   1. FIRST the SID claim: the 1:1 row the send wrapper would have appended -
 *      the share's stamp, `automated` from the share's `created_via` (a
 *      dashboard share is a person's send), `recipient_contact_id` only while
 *      the contact holds the thread's number - deduped on the SID. A dedupe is
 *      not by itself "lost": the stored row is read consistently and a row
 *      that is not this recipient's (isBroadcastRowFor) is `other_owner` -
 *      someone else's message; the caller takes the next candidate.
 *   2. THEN the slot, from `queued` only, with its conversationId + tsMsgId so
 *      later receipts roll up, and its stats bump in the same write. The slot
 *      status is the owner's own mapping: accepted/queued/sending/sent ->
 *      `sent`, delivered/read -> `delivered`, undelivered/failed/canceled ->
 *      `failed` with the provider's code; `carrierSentAt` from the provider's
 *      date_sent. A slot that is no longer queued did not move: `skipped`.
 *   3. THEN, only because the slot moved: the derived progress tick, the
 *      message_sent audit row (only for a row this call appended - a row
 *      that was there already was audited by the send wrapper that wrote
 *      it), the status-preserving inbox touch (never backwards), the emits,
 *      and - only for an adopted sent/delivered - the
 *      listing_sent milestone and the listing-send row. An adopted failure
 *      takes the pass's own arm for 30005/30006 (flag the contact
 *      sms_unreachable) and WARNs: the webhook's side effects for the code
 *      (the 30003 ladder, 21610 bookkeeping, the metric) never ran for it.
 *      Each is best-effort (logged at ERROR): a retry would find the slot
 *      moved and skip them anyway.
 */
export async function adoptBroadcastRecipient(
  deps: AdoptDeps,
  args: AdoptBroadcastArgs,
): Promise<'adopted' | 'other_owner' | 'skipped'> {
  const { broadcastId, contactKey, providerSid } = args;
  const ctx = { broadcastId, recipientKey: safeRecipientKey(contactKey), providerSid };
  const broadcast = await deps.broadcasts.getByIdConsistent(broadcastId);
  if (broadcast === undefined) {
    throw new Error(`adoptBroadcastRecipient: broadcast ${broadcastId} not found`);
  }
  const contact = await resolveContact(deps.contacts, contactKey);
  if (contact === undefined || typeof contact.phone !== 'string' || contact.phone.length === 0) {
    // The pass fences a phone-less recipient before any claim, so a record
    // cannot exist for one; refuse to guess where the message belongs.
    throw new Error('adoptBroadcastRecipient: the recipient has no resolvable contact phone');
  }
  const conversation = await deps.conversations.createOrGetByParticipantPhone(contact.phone, 'tenant_1to1');
  const participantPhone = conversation.participant_phone ?? contact.phone;
  const automated = broadcast.created_via !== 'dashboard';
  const rowStatus = mapTwilioStatus(args.providerStatus);
  const failed = rowStatus === 'failed' || rowStatus === 'undelivered';
  const errorCode = failed ? args.errorCode : undefined;
  const transport = args.mediaCount > 0 ? 'mms' : 'sms';

  // 1. The SID claim.
  const appended = await deps.messages.append({
    conversationId: conversation.conversationId,
    providerSid,
    providerTs: args.providerTs,
    type: transport,
    direction: 'outbound',
    author: 'teammate',
    body: args.body,
    deliveryStatus: rowStatus,
    ...(errorCode !== undefined && { errorCode }),
    transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
    requestedTransport: transport,
    broadcastId,
    automated,
    ...(contactHoldsPhone(contact, participantPhone) && { recipientContactId: contact.contactId }),
  });
  if (appended.deduped) {
    const row = await deps.messages.getByProviderSidConsistent(providerSid);
    if (row === undefined) {
      throw new Error(`adoptBroadcastRecipient: the row for ${providerSid} deduped but cannot be read back`);
    }
    const mine = isBroadcastRowFor(row, {
      broadcastId,
      contactId: contact.contactId,
      slotTsMsgId: broadcast.recipients?.[contactKey]?.tsMsgId,
    });
    if (!mine) return 'other_owner';
  }

  // 2. The slot, from queued only, with its bump in the same write.
  const slotStatus: 'sent' | 'delivered' | 'failed' = failed ? 'failed' : rowStatus === 'delivered' ? 'delivered' : 'sent';
  const delta: Partial<BroadcastStats> =
    slotStatus === 'failed'
      ? { failed: 1, queued: -1 }
      : slotStatus === 'delivered'
        ? { delivered: 1, queued: -1 }
        : { sent: 1, queued: -1 };
  const recorded = await deps.broadcasts.recordRecipientOutcome(
    broadcastId,
    contactKey,
    {
      conversationId: appended.conversationId,
      tsMsgId: appended.tsMsgId,
      status: slotStatus,
      ...(errorCode !== undefined && { errorCode }),
      ...(args.sentAt !== undefined && { carrierSentAt: args.sentAt }),
    },
    delta,
    ['queued'],
  );
  if (!recorded.moved) return 'skipped';

  // 3. Only because the slot moved.
  if (recorded.item) emitBroadcastProgress(deps.events, broadcastId, recorded.item);
  // The send wrapper's audit row, once per message: a row that was ALREADY
  // there (the pass's slot write threw after sendMessage had appended - and
  // audited - it) carries its audit row already.
  if (!appended.deduped) {
    try {
      await deps.audit.append(`conversations#${appended.conversationId}`, 'message_sent', {
        providerSid,
        automated,
        author: 'teammate',
      });
    } catch (err) {
      deps.log.error({ err, ...ctx }, 'broadcastFanOut: adoption audit row failed (best-effort)');
    }
  }
  // The status-preserving touch with no preview (the relay retry job's
  // shape): never moves the inbox backwards (a read-then-write guard, build
  // finding T10-12 - accepted residue).
  let touched: ConversationItem | undefined;
  try {
    const current =
      appended.conversationId === conversation.conversationId
        ? conversation
        : await deps.conversations.getById(appended.conversationId);
    if (current !== undefined && (current.last_activity_at ?? '') < args.providerTs) {
      touched = await deps.conversations.touchLastActivityPreservingStatus(appended.conversationId, undefined, args.providerTs);
    }
  } catch (err) {
    deps.log.error({ err, ...ctx }, 'broadcastFanOut: adoption inbox touch failed (best-effort)');
  }
  deps.events.emit('message.persisted', {
    conversationId: appended.conversationId,
    tsMsgId: appended.tsMsgId,
    direction: 'outbound',
    deliveryStatus: rowStatus,
  });
  if (touched !== undefined) deps.events.emit('conversation.updated', toConversationUpdatedEvent(touched));
  if (slotStatus !== 'failed') {
    // A message the carrier says never arrived must not count as a property sent.
    await recordPropertySent(deps, deps.log, ctx, {
      contactId: contact.contactId,
      unitId: broadcast.unitId,
      broadcastId,
    });
    return 'adopted';
  }
  if (errorCode !== undefined && UNREACHABLE_CODES.has(errorCode)) {
    // The pass's own arm (every broadcast leg is SMS - see its
    // TODO(mms-silent-drop-dish-textnow) note in onRejected).
    try {
      await deps.contacts.setFlag(contact.contactId, 'sms_unreachable');
    } catch (flagErr) {
      deps.log.error({ err: flagErr, ...ctx }, 'broadcastFanOut: failed to flag contact sms_unreachable');
    }
  }
  deps.log.warn(
    { ...ctx, event: 'send_reconcile', deliveryStatus: rowStatus, errorCode },
    'broadcastFanOut: adopted terminal failure - webhook side effects skipped',
  );
  return 'adopted';
}

/** Resolved first name for [TenantName], or undefined. */
function firstNameOf(contact: ContactItem): string | undefined {
  const v = contact['firstName'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Persist one recipient's slot on the broadcast. */
async function recordRecipient(
  broadcasts: BroadcastsRepo,
  broadcastId: string,
  contactKey: string,
  recipient: BroadcastRecipient,
): Promise<void> {
  await broadcasts.setRecipient(broadcastId, contactKey, recipient);
}

/**
 * Spec D16a: finalize is idempotent, decides on a strongly consistent read,
 * and holds its own open-check. It returns without writing while ANY
 * recipient slot is still `queued` (a reconciling, re-driven or in-flight
 * recipient is a queued slot, so no attempt-record read is needed here), and
 * otherwise flips the status on the condition `status = sending` - ONLY the
 * writer that wins the flip writes the `broadcast_sent` unit audit row and
 * emits the terminal event. So every writer that could be the last (the pass,
 * a continuation, a cap-close, a reconcile verdict) simply calls this after
 * its own writes, and N callers produce one finalize.
 *
 * The terminal status is decided from the RECIPIENTS MAP just read, never from
 * the persisted counters (the callback rollup and the reconcile verdicts do
 * not keep `stats.failed` in step): `failed` when no recipient reached sent or
 * delivered AND at least one failed or is unconfirmed, else `sent`; skipped
 * recipients count for neither side.
 */
export async function finalize(
  broadcasts: BroadcastsRepo,
  events: EventBus,
  broadcastId: string,
  log: Logger,
  audit: AuditRepo,
): Promise<void> {
  const fresh = await broadcasts.getByIdConsistent(broadcastId);
  if (!fresh) {
    log.warn({ broadcastId }, 'broadcastFanOut: broadcast vanished before finalize');
    return;
  }
  const slots = Object.values(fresh.recipients ?? {});
  const open = slots.filter((slot) => slot.status === 'queued').length;
  if (open > 0) {
    log.info({ broadcastId, open }, 'broadcastFanOut: finalize deferred - recipients still open');
    return;
  }
  const stats = deriveBroadcastStats(fresh);
  const reachedAny = stats.sent + (stats.sending ?? 0) + stats.delivered > 0;
  const failedAny = stats.failed + (stats.unconfirmed ?? 0) > 0;
  const status: 'sent' | 'failed' = !reachedAny && failedAny ? 'failed' : 'sent';
  const lastError =
    status === 'failed' ? (stats.failed === 0 ? UNCONFIRMED_LAST_ERROR : ALL_FAILED_LAST_ERROR) : undefined;
  const { won, item: finalItem } = await broadcasts.finalizeStatus(broadcastId, status, lastError);
  if (!won) {
    log.info({ broadcastId, status: finalItem.status }, 'broadcastFanOut: finalize already done - nothing to write');
    return;
  }
  // WS2: surface the send on the targeted property's Activity card. Best-effort:
  // an audit failure must NEVER fail the fan-out (state is already persisted). A
  // unit-less broadcast writes nothing. PII-safe log: ids/counts only.
  if (typeof finalItem.unitId === 'string' && finalItem.unitId.length > 0) {
    try {
      await audit.append(`units#${finalItem.unitId}`, 'broadcast_sent', { broadcastId, tenantCount: slots.length });
    } catch (err) {
      log.error({ err, broadcastId }, 'broadcast_sent unit audit failed (best-effort)');
    }
  }
  // S2/S4: the terminal emit carries DERIVED disjoint stats (not the persisted
  // cumulative counters), so the final chips reconcile to the recipients map.
  emitBroadcastProgress(events, broadcastId, finalItem);
  // share-skip-fix D7: the line reports the DERIVED stats - the persisted
  // counters are cumulative and, on a legacy row, lack skipped_other, while
  // every other surface (SSE, results, list) already reads the derived buckets.
  const derived = deriveBroadcastStats(finalItem);
  log.info(
    {
      broadcastId,
      status: finalItem.status,
      sent: derived.sent,
      sending: derived.sending ?? 0,
      delivered: derived.delivered,
      failed: derived.failed,
      unconfirmed: derived.unconfirmed ?? 0,
      skipped_opted_out: derived.skipped_opted_out,
      skipped_no_consent: derived.skipped_no_consent,
      skipped_other: derived.skipped_other ?? 0,
    },
    'broadcast send finalized',
  );
}
