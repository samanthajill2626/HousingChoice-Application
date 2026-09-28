// messaging.retrySend — the ONE retry path for transient delivery failures
// (Twilio 30003, doc §7.1 "transient failures get a scheduled retry with
// backoff"). The status webhook enqueues it via jobs.enqueue() (envelope
// machinery — never raw scheduler calls, binding guideline 3); the worker
// registers the handler via registerRetrySendJobHandler().
//
// PII: the payload carries IDs only (provider SID + conversation), never the
// message body — the handler re-reads body/media from the messages table.
// Attempt count rides the payload. The handler passes it into the send with
// retry_of and the chain's window origin (retry_window_start), so the NEW
// message carries all three from its append (retry-send-window D6) - the next
// 30003 callback reads retry_attempt for the cap and retry_window_start for the
// 15-minute window. The retry follows the ORIGINAL send (D14): its `automated`
// flag and its recorded recipient.
//
// THE SEND-ATTEMPT RECORD (retry-send-adoption R1-R3; SOR D8/D8a). The job has
// no run-once marker: it claims a record keyed on the RETRIED ROW and the
// attempt (`retry#<conversationId>#<retriedTsMsgId>#<attempt>`; the chain root
// is a fact on it, never part of the key) before its provider call, re-arms it
// as the call's last step, and resolves EVERY outcome through that record:
// sent, refused, rejected, deferred once, or - when the provider's answer is
// unknown - handed to `send.reconcile`, which adopts the text it finds,
// re-drives the attempt once, or closes it unresolved with the retried row's
// promise withdrawn. Steps before the claim are reads (plus a re-driven
// record's close) and may throw: SQS redelivers and nothing was sent. NOTHING
// throws after the claim - a throw there, behind the marker, was the silently
// lost retry this design removes (retry-send-lost-under-job-marker).
//
// IMPORT CYCLE: this module imports send.reconcile's hand-off helpers, and
// sendReconcile.ts imports this module's producer back (a retry's re-drive).
// Every binding either side imports is used ONLY inside functions, so the ESM
// live bindings are settled before first use; `npm run smoke` proves the
// compiled graph resolves under plain node.
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MediaAttachment,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  createSendAttemptsRepo,
  type AttemptRef,
  type SendAttemptFacts,
  type SendAttemptOutcome,
  type SendAttemptsRepo,
} from '../repos/sendAttemptsRepo.js';
import {
  createSendMessageService,
  ProviderSendFailedError,
  SendAcceptedNotRecordedError,
  SendNotAttemptedError,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { conversationRetryDecline, resolveRetryRoot, retryRecipientKey } from '../services/retryChain.js';
import { refreshRetryPromise, withdrawRetryPromise, type RetryPromiseDeps } from '../services/retryPromiseWrites.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { getContext } from '../lib/context.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { guardWrite } from '../lib/guardWrite.js';
import { pinnedSender } from '../lib/outboundSender.js';
import { gateFor } from '../lib/sendAttemptGate.js';
import { bodyFingerprint, recipientDigest, safeRecipientKey } from '../lib/sendFingerprint.js';
import {
  ENQUEUE_FAILED_CODE,
  SEND_RETRYABLE_CODE,
  SMS_SENDING_DISABLED_CODE,
  type SendFailureClassification,
} from '../lib/sendOutcome.js';
import {
  MAX_SEND_RETRY_ATTEMPTS,
  oneToOneRetryWindowOrigin,
  parseRetryWindowOrigin,
  RETRY_PROMISE_GRACE_MS,
  RETRY_WINDOW_CLOSED_CODE,
  retryFitsSendWindow,
  withinRetrySendWindow,
} from '../lib/retrySendWindow.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { defineJobHandler, enqueue } from './jobs.js';
// The import cycle above: used ONLY inside functions.
import {
  enqueueSendReconcile,
  reconcileCheckDelaysMs,
  reconcileDelayMs,
  toOwnerRef,
  type RetrySendOwner,
} from './sendReconcile.js';

export const RETRY_SEND_JOB = 'messaging.retrySend';

/**
 * Presign TTL for a re-presigned attachment on an automated retry (design
 * Sec 5/7): 1 hour, matching the manual route + relay legs. A retry is a NEW
 * provider create + fetch, so the URL only needs to outlive that fetch.
 */
export const RETRY_PRESIGN_TTL_SECONDS = 3600;

// The retry cap is owned by the import-free leaf lib/retrySendWindow.ts since
// retry-send-adoption; re-exported here so every existing importer (the
// 30003 decision, the tests) keeps resolving it through this module.
export { MAX_SEND_RETRY_ATTEMPTS };

/** Exponential backoff: 60s, 120s, 240s for attempts 1..3. */
export function retryBackoffMs(attempt: number): number {
  return 60_000 * 2 ** (attempt - 1);
}

export interface RetrySendPayload {
  /** Provider SID of the FAILED message being retried. */
  providerSid: string;
  conversationId: string;
  /** 1-based attempt number of THIS retry. */
  attempt: number;
  /**
   * retry-send-adoption R1/R3: set ONLY by the deferral re-enqueue, so the
   * re-claimed run treats its next deferral as terminal. The webhook's initial
   * enqueue and a re-drive never set it; the parser carries `true` and drops
   * any other value.
   */
  deferred?: true;
}

export function parseRetrySendPayload(payload: unknown): RetrySendPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('retrySend: payload is not an object');
  }
  const p = payload as Partial<RetrySendPayload>;
  if (typeof p.providerSid !== 'string' || p.providerSid.length === 0) {
    throw new Error('retrySend: missing providerSid');
  }
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) {
    throw new Error('retrySend: missing conversationId');
  }
  if (typeof p.attempt !== 'number' || !Number.isInteger(p.attempt) || p.attempt < 1) {
    throw new Error('retrySend: invalid attempt');
  }
  if (p.attempt > MAX_SEND_RETRY_ATTEMPTS) {
    throw new Error(`retrySend: attempt ${p.attempt} exceeds cap ${MAX_SEND_RETRY_ATTEMPTS}`);
  }
  return {
    providerSid: p.providerSid,
    conversationId: p.conversationId,
    attempt: p.attempt,
    ...(p.deferred === true && { deferred: true as const }),
  };
}

/**
 * The lane's one-to-one backoff override (retry-send-window D13). LANE-ONLY:
 * set in scripts/e2e-session.mjs's childEnv, never in dev or prod, and absent
 * from every `.env*`. The relay ladder's twin is E2E_RELAY_RETRY_BACKOFF_MS
 * (relayRetryLeg.ts), and this one takes the SAME two guards.
 */
const SEND_RETRY_BACKOFF_ENV_KEY = 'E2E_SEND_RETRY_BACKOFF_MS';

/**
 * retryBackoffMs(attempt) unless the lane override applies: env
 * E2E_SEND_RETRY_BACKOFF_MS (positive integer) honored ONLY when
 * JOBS_QUEUE_URL is unset (the relay seam's guard).
 *
 * JOBS_QUEUE_URL IS the topology: every deployed environment sets it
 * (Terraform's jobs module), and the one-to-one retry is scheduled by the
 * status webhook in the APP process - so without the guard a stray value in a
 * deployed environment would reshape every real retry, texting a tenant again
 * seconds after a failure. The hermetic lane and local dev leave it unset; an
 * EMPTY value counts as unset. Anything that does not parse to a positive
 * integer is ignored. Read from `process.env`, not config, on purpose: this is
 * a leaf on the enqueue path and the queue URL is only tested for presence.
 * The status webhook computes the retry's run time from this one function, so
 * the schedule and the promise it writes share the lane's value.
 */
export function resolveSendRetryBackoffMs(attempt: number): number {
  const queueUrl = process.env['JOBS_QUEUE_URL'];
  if (typeof queueUrl !== 'string' || queueUrl.length === 0) {
    const parsed = Number.parseInt(process.env[SEND_RETRY_BACKOFF_ENV_KEY] ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return retryBackoffMs(attempt);
}

/**
 * Producer side (status webhook): schedule ONE retry at an explicit run time.
 * The caller decides `runAt` (now plus the resolved backoff) and writes the
 * same instant as the failed message's `retry_due_at`, so the promise on
 * screen and the job's schedule are one value (retry-send-window D7).
 * `payload.attempt` rides along for the job's cap; it no longer picks the
 * delay here.
 */
export async function enqueueSendRetry(payload: RetrySendPayload, runAt: Date): Promise<void> {
  await enqueue(RETRY_SEND_JOB, payload, { runAt });
}

/**
 * retry-send-adoption R1: what a retry of `original` WILL SEND. `attachments`
 * are re-presigned fresh later (never a stored URL); `rawMediaUrls` are
 * replayed as stored (the internal/e2e seam, a row with no attachments);
 * `droppedAttachments` means the row has attachments but no MediaStore exists,
 * so the retry goes body only. `mediaCount` is the attempt fact.
 */
export interface RetryMediaPlan {
  attachments?: MediaAttachment[];
  rawMediaUrls?: string[];
  mediaCount: number;
  droppedAttachments: boolean;
}

/** R1: what the retry WILL SEND, decided synchronously so the claim's mediaCount is known before the presign (retrySend.ts's media rule as built). */
export function planRetryMedia(original: MessageItem, hasStore: boolean): RetryMediaPlan {
  const attachments = mediaAttachmentsOf(original);
  if (attachments.length > 0) {
    return hasStore
      ? { attachments, mediaCount: attachments.length, droppedAttachments: false }
      : { mediaCount: 0, droppedAttachments: true };
  }
  if (original.mediaUrls !== undefined) {
    return { rawMediaUrls: original.mediaUrls, mediaCount: original.mediaUrls.length, droppedAttachments: false };
  }
  return { mediaCount: 0, droppedAttachments: false };
}

/**
 * Step 6, PREPARE (R1): mint the media the plan decided on. PRESIGN PER
 * ATTEMPT (design Sec 5 - the Cameron rule): a retry is a NEW provider create
 * + fetch, so a stored presigned URL (a short-lived bearer token) is NEVER
 * replayed - the durable attachments are re-presigned fresh and ride along so
 * the new row persists them. A row with no attachments replays its raw
 * mediaUrls (the internal/e2e seam, the durable truth there). Attachments with
 * no store go body only, never with an expired token. The claim already
 * recorded `plan.mediaCount`; this returns exactly that much media. A throw
 * here is the prepare-phase deferral (R3).
 */
async function presignRetryMedia(
  plan: RetryMediaPlan,
  retried: MessageItem,
  store: MediaStore | undefined,
  log: Logger,
  ctx: Record<string, unknown>,
): Promise<{ mediaUrls?: string[]; attachments?: MediaAttachment[] }> {
  if (plan.attachments !== undefined) {
    // planRetryMedia hands attachments back only when it was told a store exists.
    if (store === undefined) throw new Error('retrySend: the media plan has attachments but there is no MediaStore');
    const attachments = plan.attachments;
    const mediaUrls = await Promise.all(attachments.map((a) => store.presign(a.s3Key, RETRY_PRESIGN_TTL_SECONDS)));
    log.info(
      { ...ctx, attachmentCount: attachments.length, s3Keys: attachments.map((a) => a.s3Key) },
      'retrySend: re-presigned attachments fresh (never replaying stored URLs)',
    );
    return { mediaUrls, attachments };
  }
  if (plan.droppedAttachments) {
    // No store to presign from: retry the text only. IDs, keys and a count - never a URL.
    const dropped = mediaAttachmentsOf(retried);
    log.warn(
      { ...ctx, attachmentCount: dropped.length, s3Keys: dropped.map((a) => a.s3Key) },
      'retrySend: attachments present but no MediaStore - retrying body only, media dropped (never replay stale URLs)',
    );
    return {};
  }
  return plan.rawMediaUrls !== undefined ? { mediaUrls: plan.rawMediaUrls } : {};
}

/** A log context: ids only - the owner through safeRecipientKey, never a phone or a body (R9). */
type Ctx = Record<string, unknown>;

/** retry-send-adoption R3: the record cause of a deferral that would have been the attempt's second (its payload carried `deferred`). */
const DEFERRAL_CAP_CAUSE = 'deferral_cap';
/** retry-send-adoption R2 step 4a: the record cause of a re-driven attempt a manual Retry of the same row superseded. */
const MANUAL_RETRY_SUPERSEDED_CAUSE = 'manual_retry_superseded';

export interface RetrySendJobDeps {
  sendMessage?: SendMessageService;
  messagesRepo?: MessagesRepo;
  /**
   * Media bucket store for re-presigning the original's durable s3Keys on an
   * automated retry (outbound MMS). Undefined when MEDIA_BUCKET is unset (a
   * no-bucket dev loop). Lazily created on first job run. Threaded exactly like
   * relayFanOut's mediaStore dep.
   */
  mediaStore?: MediaStore;
  /**
   * retry-send-window D14: reads the recipient the retried row was fenced to
   * (`recipient_contact_id`), by id, BEFORE the claim. Built lazily, and only
   * when a row records a recipient.
   */
  contactsRepo?: ContactsRepo;
  /**
   * retry-send-adoption R2 step 3: the thread. Its participant_phone derives
   * the attempt's recipient key (when the row records no recipient) and its
   * digest; a thread the retry cannot address is a designed decline.
   */
  conversationsRepo?: ConversationsRepo;
  /** retry-send-adoption R1/R2: the per-(retried row, attempt) send-attempt records - the claim is this job's duplicate guard. */
  sendAttemptsRepo?: SendAttemptsRepo;
  /** The sender the attempt's facts pin (pinnedSender: the business number, exactly as sendMessage pins it). */
  config?: AppConfig;
  /** The bus the promise REFRESH / WITHDRAW announce the retried row on (message.persisted). */
  events?: EventBus;
  /** The job's clock - the window checks, the gate, the claim, the re-arm and a deferral's run time (tests pin it); Date.now by default. */
  now?: () => number;
  logger?: Logger;
}

/** Consumer side (worker.ts): register the handler with real (or test) deps. */
export function registerRetrySendJobHandler(deps: RetrySendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? Date.now;
  const nowIso = (): string => new Date(now()).toISOString();
  // Lazy: repos/services touch config + DynamoDB only on first job run.
  let sendMessage = deps.sendMessage;
  let messages = deps.messagesRepo;
  let contacts = deps.contactsRepo;
  let conversations = deps.conversationsRepo;
  let attempts = deps.sendAttemptsRepo;
  let config = deps.config;
  const events = deps.events ?? appEvents;
  // MediaStore can legitimately resolve to undefined (no MEDIA_BUCKET), so a
  // separate init flag drives the lazy build (not `??=`, which would rebuild).
  let mediaStore = deps.mediaStore;
  let mediaStoreInit = deps.mediaStore !== undefined;

  // registered WITHOUT the run-once marker (R2): the claim is the duplicate guard.
  defineJobHandler(RETRY_SEND_JOB, async (rawPayload) => {
    const payload = parseRetrySendPayload(rawPayload);
    // Each lazy dep is bound to a CONST once resolved, so the arms below close
    // over a narrowed value (a nested function cannot narrow an outer `let`).
    const sendService = (sendMessage ??= createSendMessageService({ logger: deps.logger }));
    const messagesRepo = (messages ??= createMessagesRepo({ logger: deps.logger }));
    const conversationsRepo = (conversations ??= createConversationsRepo({ logger: deps.logger }));
    const attemptsRepo = (attempts ??= createSendAttemptsRepo({ logger: deps.logger }));
    const appConfig = (config ??= loadConfig());
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }
    const store = mediaStore;
    const base: Ctx = { providerSid: payload.providerSid, conversationId: payload.conversationId, attempt: payload.attempt };

    // 1. THE RETRIED ROW (spec section 0), read CONSISTENTLY: the promise writes
    // below are conditioned on the retry_due_at this read saw (plan deviation 3).
    const retried = await messagesRepo.getByProviderSidConsistent(payload.providerSid);
    if (!retried) {
      log.warn(base, 'retrySend: original message not found - nothing to retry');
      return;
    }
    if (retried.direction !== 'outbound') {
      log.warn(base, 'retrySend: original message is not outbound - refusing');
      return;
    }
    // The attempt's owner, its reconcile and its send all address the RETRIED
    // row's thread: a payload naming another one is malformed, never sent.
    if (retried.conversationId !== payload.conversationId) {
      log.warn(
        { ...base, rowConversationId: retried.conversationId },
        'retrySend: the payload names another conversation than the retried row - refusing',
      );
      return;
    }
    const retryRoot = await resolveRetryRoot(messagesRepo, retried);
    // RSW D2: the chain's FIRST send - retry_window_start on a retry row, else
    // this row's own provider_ts (the rule the 30003 decision reads too).
    const windowStart = oneToOneRetryWindowOrigin(retried);
    const originMs = parseRetryWindowOrigin(windowStart);
    const ctx: Ctx = { ...base, retriedTsMsgId: retried.tsMsgId, retryRoot };

    // 2. RSW D14: the retry is judged against the contact the retried row was
    // fenced to (share-skip-fix I8), read by id BEFORE the claim - a read that
    // throws fails this delivery and SQS redelivers it. A recorded recipient
    // that no longer exists falls back to the phone-matched contact, and
    // sendMessage judges it only while it still holds the thread's number.
    const recipientContactId = retried.recipient_contact_id;
    let recipient: ContactItem | undefined;
    if (typeof recipientContactId === 'string' && recipientContactId.length > 0) {
      const contactsRepo = (contacts ??= createContactsRepo({ logger: deps.logger }));
      recipient = await contactsRepo.getById(recipientContactId);
      if (recipient === undefined) {
        log.warn(
          { ...ctx, recipientContactId },
          'retrySend: recorded recipient no longer exists - retrying to the phone-matched contact',
        );
      }
    }

    // 3. THE THREAD: the attempt's facts, and a DESIGNED decline - never a
    // throw - for a thread the retry cannot address, in the webhook decision's
    // own vocabulary (RSW D11). Nothing is claimed; the promise expires.
    const conversation = await conversationsRepo.getById(payload.conversationId);
    const decline = conversationRetryDecline(conversation);
    const participantPhone = conversation?.participant_phone;
    // R1: from IMMUTABLE data - the recorded recipient, else the thread's number.
    const recipientKey = retryRecipientKey(retried, conversation);
    if (decline !== undefined || participantPhone === undefined || recipientKey === undefined) {
      log.warn({ ...ctx, reason: decline ?? 'not_one_to_one' }, 'retrySend: conversation not retryable');
      return;
    }
    const owner: RetrySendOwner = {
      kind: 'retry_send',
      conversationId: payload.conversationId,
      retriedTsMsgId: retried.tsMsgId,
      attempt: payload.attempt,
      recipientKey,
      retryRoot,
    };
    const octx: Ctx = { ...ctx, recipientKey: safeRecipientKey(recipientKey) };
    const promise: RetryPromiseDeps = { messages: messagesRepo, events, log };

    // 4. AN EXISTING ATTEMPT IS RESOLVED FIRST (R2; SOR D8 through the shared
    // gate, before the window): a stale attempting record is taken over by the
    // gate itself and handed off here, exactly once; a fresh attempting or a
    // reconciling record defers; a terminal one skips. Absent, done/retryable
    // (a deferral re-run) and redriven (a re-drive) proceed - this run MAY
    // send, so both gates below run, every time.
    const gate = await gateFor(attemptsRepo, owner, now());
    if (gate.kind === 'taken_over') {
      log.info({ ...octx, gate: gate.kind }, 'retrySend: a stale attempt was taken over into reconcile');
      await handOff(owner, gate.record.attemptedAt, retried, octx);
      return;
    }
    if (gate.kind === 'defer') {
      log.info({ ...octx, gate: gate.kind }, 'retrySend: a concurrent delivery owns this attempt');
      return;
    }
    if (gate.kind === 'skip') {
      log.info({ ...octx, gate: gate.kind }, 'retrySend: this attempt is already resolved');
      return;
    }
    const existing = gate.record;
    // THE PRE-ADOPTION BELT (plan deviation 10; the planner's ruling on build
    // worklist item 24). With NO record, a jobId the pre-adoption code already
    // ran - it wrote the run-once marker before its provider call - is an SQS
    // redelivery across the deploy whose first run may have sent (an unknown
    // or unrecorded outcome was rethrown), so it is NOT re-sent. READ, never
    // written: every post-deploy job, deferral and re-drive carries a fresh
    // jobId and meets no marker. An eventually consistent Get is enough - the
    // marker was written at least one visibility timeout before a redelivery.
    if (existing === undefined) {
      const jobId = getContext()?.jobId;
      if (typeof jobId === 'string' && jobId.length > 0 && (await messagesRepo.getJobExecutionMarker(jobId))) {
        log.info({ ...octx, jobId }, 'retrySend: pre-adoption delivery already ran this job - not re-sent');
        return;
      }
    }
    const redriven = existing?.state === 'redriven';

    // 4a. A MANUAL RETRY SUPERSEDES THE CHAIN (R2): a staff Retry of this same
    // failed row - a child with retry_of and no retry_attempt - already went
    // out. ONE consistent Query on the row's retrychild# partition (R7), never
    // a scan of the thread. An automatic child (this chain's) does not count.
    const children = await messagesRepo.listRetryChildrenConsistent(payload.conversationId, retried.tsMsgId);
    if (children.some((child) => child.retryAttempt === undefined)) {
      await declineBeforeClaim(owner, redriven, MANUAL_RETRY_SUPERSEDED_CAUSE, octx);
      log.info({ ...octx, cause: MANUAL_RETRY_SUPERSEDED_CAUSE }, 'retrySend: a manual retry superseded this attempt');
      return;
    }

    // 4b. RSW D4: the strict window, right before the claim. The grace was
    // spent when the webhook scheduled this retry (D3a), so nothing may go out
    // past origin + 15 minutes. A missing or unparseable origin fails OPEN
    // (D5): the retry goes out unwindowed, with a WARN naming the gap.
    if (originMs === undefined) {
      log.warn(octx, 'retrySend: no usable window origin - sending without a window check (fail open)');
    } else if (!withinRetrySendWindow({ originMs, nowMs: now() })) {
      await declineBeforeClaim(owner, redriven, RETRY_WINDOW_CLOSED_CODE, octx);
      log.error(
        { ...octx, retryDecision: 'window_closed', cause: RETRY_WINDOW_CLOSED_CODE },
        'retrySend: retry window closed - retry chain ended without sending',
      );
      return;
    }

    // 5. CLAIM (SOR D8a) - the duplicate guard this job has instead of the
    // run-once marker. The facts are what a reconcile matches this attempt on:
    // the number the send pins, the thread's number, the retried body, and the
    // media count the plan decided BEFORE any presign.
    const plan = planRetryMedia(retried, store !== undefined);
    const sender = pinnedSender(appConfig);
    const fp = bodyFingerprint(retried.body);
    const facts: SendAttemptFacts = {
      recipientDigest: recipientDigest(sender, participantPhone),
      ...(sender !== undefined && { sender }),
      bodyHash: fp.hash,
      bodyShort: fp.short,
      mediaCount: plan.mediaCount,
    };
    const claim = await attemptsRepo.claim(owner, facts, nowIso());
    if (claim.outcome === 'refused') {
      // fresh: a concurrent delivery claimed between the gate and here; else resolved or reconciling.
      log.info(
        { ...octx, state: claim.record.state, fresh: claim.fresh },
        'retrySend: claim refused - another delivery owns this attempt or it is resolved',
      );
      return;
    }
    if (claim.outcome === 'takeover') {
      // A stale attempt: its call died or overran. The outcome is unknown - reconcile it, never re-send.
      if (await attemptsRepo.takeOver(owner, claim.record)) await handOff(owner, claim.record.attemptedAt, retried, octx);
      else log.info(octx, 'retrySend: takeover lost - another writer moved the stale attempt');
      return;
    }
    let ref: AttemptRef = { attemptNo: claim.record.attemptNo, attemptedAt: claim.record.attemptedAt };
    // SOR D13a: a re-driven attempt (claimed from redriven) gets no second reconcile.
    const secondUnknownWouldClose = claim.record.redriveCount >= 1;
    let phase: 'prepare' | 'sending' | 'record' = 'prepare';
    let takenOver = false;
    try {
      // 6. PREPARE: the media the plan decided on, minted now.
      const media = await presignRetryMedia(plan, retried, store, log, octx);

      // 7. SEND. The retry FOLLOWS THE RETRIED SEND (RSW D14): an automated
      // original (a reminder, the missed-call text, an automated share) is
      // retried automated and breaker-metered - a retry storm must still trip
      // the breaker; a person's is retried as a person's send (manual mode and
      // the breaker do not apply, the consent gate does); a row with no
      // `automated` (sent before RSW) is retried automated. It keeps the
      // original author. The lineage rides the APPEND (RSW D6) with the chain
      // root and the share stamp copied from the retried row (R7), and the
      // claim is RE-ARMED as the last step before the provider call (SOR D8a,
      // code review ADV-1): a lost re-arm sends nothing.
      phase = 'sending';
      const sent = await sendService({
        conversationId: payload.conversationId,
        ...(retried.body !== undefined && { body: retried.body }),
        ...(media.mediaUrls !== undefined && { mediaUrls: media.mediaUrls }),
        ...(media.attachments !== undefined && { attachments: media.attachments }),
        automated: retried.automated ?? true,
        author: retried.author === 'ai' ? 'ai' : 'teammate',
        ...(recipient !== undefined && { recipient }),
        retryOf: retried.tsMsgId,
        retryAttempt: payload.attempt,
        ...(typeof windowStart === 'string' && { retryWindowStart: windowStart }),
        retryRoot,
        ...(retried.broadcast_id !== undefined && { broadcastId: retried.broadcast_id }),
        beforeProviderSend: async () => {
          const rearmed = await attemptsRepo.rearm(owner, ref, nowIso());
          if (rearmed === undefined) {
            takenOver = true;
            return false;
          }
          ref = rearmed;
          return true;
        },
      });

      // 8. RECORD: sendMessage appended the retry row with its lineage; close
      // the attempt. A LOST fence means a takeover moved the record to
      // reconciling during the send - its reconcile finds the row through its
      // sid# pointer as `mine` and repairs. A THROWN write leaves the record
      // attempting for the sweeper (guardWrite's ERROR). Neither is
      // sent_unrecorded: the row exists. No promise write - the retried row's
      // retry_due_at expires on RSW's clock.
      phase = 'record';
      let fenced = false;
      const wrote = await guardWrite(log, octx, 'finishAttempt', async () => {
        fenced = await attemptsRepo.finishAttempt(owner, ref, { outcome: 'sent', sid: sent.providerSid });
      });
      if (wrote && !fenced) {
        log.warn({ ...octx, sid: sent.providerSid }, 'retrySend: attempt fence lost after a recorded send; the takeover reconcile repairs');
      }
      log.info({ ...octx, retryOf: retried.tsMsgId, newProviderSid: sent.providerSid, outcome: 'sent' }, 'retrySend: message re-sent');
    } catch (err) {
      // From here on this attempt HOLDS the claim: every write is a failure-arm
      // write fenced on `held`, and nothing below throws.
      const held = ref;
      if (phase === 'record') {
        log.error({ err, ...octx }, 'retrySend: a record-phase step threw after the send - the attempt stays attempting for the sweeper');
        return;
      }
      if (phase === 'prepare') {
        // Nothing was sent: the attempt's single deferral.
        await deferOrEnd(owner, held, retried, SEND_RETRYABLE_CODE, err, octx);
        return;
      }
      // phase === 'sending': the wrapper throws a refusal or one of its three typed failures.
      if (err instanceof SendRefusedError) {
        // A by-design refusal (opt-out, deleted, consent, manual mode, breaker,
        // and the wrapper's own kill switch, which extends SendRefusedError).
        await refuse(owner, held, err.code, octx);
        return;
      }
      if (err instanceof SendNotAttemptedError) {
        if (takenOver) {
          // The re-arm found the attempt taken over: its reconcile owns it. Nothing sent, nothing written.
          log.info(octx, 'retrySend: attempt taken over before the send - not sent; the takeover owns it');
          return;
        }
        // The wrapper failed before its provider call: nothing was sent.
        await deferOrEnd(owner, held, retried, SEND_RETRYABLE_CODE, err, octx);
        return;
      }
      if (err instanceof SendAcceptedNotRecordedError) {
        // The provider ACCEPTED the retry and the append failed: it WAS sent. Its SID goes to reconcile, which adopts it.
        log.error(
          { err, ...octx, sid: err.providerSid },
          'retrySend: sent_unrecorded - the retry was sent but not recorded; its SID goes to reconcile',
        );
        await handToReconcile(owner, held, retried, octx, err.providerSid);
        return;
      }
      // The provider call itself threw (SOR D1/D2): classified; anything unclassified is unknown.
      const classification: SendFailureClassification =
        err instanceof ProviderSendFailedError ? err.classification : { kind: 'unknown' };
      if (classification.kind === 'rejected') {
        if (classification.code === SMS_SENDING_DISABLED_CODE) {
          // Plan deviation 2: the ADAPTER's kill switch is a refusal, not a provider rejection.
          await refuse(owner, held, SMS_SENDING_DISABLED_CODE, octx);
          return;
        }
        // The record keeps what a code-less 4xx has: its HTTP status. No `err`
        // on the line: a Twilio rejection message can quote the number.
        const cause = classification.code ?? (classification.status !== undefined ? String(classification.status) : undefined);
        await finish(owner, held, { outcome: 'rejected', ...(cause !== undefined && { cause }) }, octx);
        log.error(
          {
            ...octx,
            errorCode: classification.code,
            status: classification.status,
            outcome: 'rejected',
            ...(cause !== undefined && { cause }),
          },
          'retrySend: retry chain ended - provider rejected the retry',
        );
        return;
      }
      if (classification.kind === 'retryable') {
        await deferOrEnd(owner, held, retried, classification.code ?? SEND_RETRYABLE_CODE, err, octx);
        return;
      }
      await onUnknown(owner, held, retried, secondUnknownWouldClose, err, octx);
    }

    // ---- The arms' writes (R3). Function declarations, hoisted: every call
    // above happens after the consts they close over are bound. Each fenced
    // write captures its fence answer INSIDE guardWrite and logs a lost fence
    // itself (plan deviation 6: guardWrite answers whether the write RESOLVED,
    // not whether its fence won); a thrown write is guardWrite's ERROR. None
    // of them throws.

    /** ONE fenced close of this attempt: 'won'; 'lost' (resolved, but a takeover owns the record); 'failed' (the write threw). */
    async function finish(
      owner: RetrySendOwner,
      ref: AttemptRef,
      result: { outcome: SendAttemptOutcome; sid?: string; cause?: string },
      octx: Ctx,
    ): Promise<'won' | 'lost' | 'failed'> {
      let won = false;
      const wrote = await guardWrite(log, octx, 'finishAttempt', async () => {
        won = await attemptsRepo.finishAttempt(owner, ref, result);
      });
      if (!wrote) return 'failed';
      if (!won) {
        log.info(
          { ...octx, outcome: result.outcome, ...(result.cause !== undefined && { cause: result.cause }) },
          'retrySend: attempt close lost its fence - the takeover owns the record',
        );
        return 'lost';
      }
      return 'won';
    }

    /** A refusal: the record done/refused with the code; the promise expires on RSW's clock. WARN, as before. */
    async function refuse(owner: RetrySendOwner, ref: AttemptRef, code: string, octx: Ctx): Promise<void> {
      await finish(owner, ref, { outcome: 'refused', cause: code }, octx);
      log.warn({ ...octx, refusal: code, outcome: 'refused', cause: code }, 'retrySend: send refused - retry chain stopped');
    }

    /**
     * A decline before the claim (4a, 4b): a REDRIVEN record is closed
     * done/refused with the cause (SOR D8 rev 11 - the reconcile never revisits
     * a redriven record, so it would strand); on done/retryable or no record
     * nothing is written (a redelivery re-runs the same decline). The close is
     * a step BEFORE the claim, so it is NOT a failure-arm write (code review
     * r1 C-1): a close that throws fails the delivery, SQS redelivers it, and
     * the redelivery re-runs this idempotent decline (R2).
     */
    async function declineBeforeClaim(owner: RetrySendOwner, redriven: boolean, cause: string, octx: Ctx): Promise<void> {
      if (!redriven) return;
      if (!(await attemptsRepo.closeRedriven(owner, { outcome: 'refused', cause }))) {
        log.info({ ...octx, cause }, 'retrySend: decline not recorded - another delivery re-claimed the re-driven attempt');
      }
    }

    /**
     * R3 deferred: the attempt's SINGLE deferral. ENQUEUE FIRST (the same
     * payload with `deferred: true`, at the RSW backoff), then release the
     * record retryable, then REFRESH the promise to the run time. TERMINAL -
     * done/refused, never claimable again - when this run was itself the
     * deferred one (deferral_cap) or the run time would fall past the window.
     * A LOST release refreshes nothing: a takeover owns the record and its
     * reconcile refreshes for itself. A THROWN release may or may not have
     * committed, and the deferred job IS live, so the promise is refreshed and
     * the possible strand named at ERROR: the deferred run meets its own stale
     * record (a takeover past the claim TTL) or, under a backoff shorter than
     * the TTL, defers and strands for the sweeper.
     */
    async function deferOrEnd(
      owner: RetrySendOwner,
      ref: AttemptRef,
      retried: MessageItem,
      cause: string,
      err: unknown,
      octx: Ctx,
    ): Promise<void> {
      const backoffMs = resolveSendRetryBackoffMs(payload.attempt);
      const nowMs = now();
      if (payload.deferred === true) {
        await finish(owner, ref, { outcome: 'refused', cause: DEFERRAL_CAP_CAUSE }, octx);
        log.error({ err, ...octx, cause: DEFERRAL_CAP_CAUSE, outcome: 'refused' }, 'retrySend: retry deferred twice - chain ended');
        return;
      }
      if (originMs !== undefined && !retryFitsSendWindow({ originMs, nowMs, backoffMs })) {
        await finish(owner, ref, { outcome: 'refused', cause: RETRY_WINDOW_CLOSED_CODE }, octx);
        log.error(
          { err, ...octx, cause: RETRY_WINDOW_CLOSED_CODE, outcome: 'refused' },
          'retrySend: retry window closed - a deferred re-run would land past the window; chain ended',
        );
        return;
      }
      const runAt = new Date(nowMs + backoffMs);
      try {
        await enqueueSendRetry(
          { providerSid: payload.providerSid, conversationId: payload.conversationId, attempt: payload.attempt, deferred: true },
          runAt,
        );
      } catch (enqueueErr) {
        // Nothing was sent and nothing is scheduled: the chain ends; the promise expires.
        await finish(owner, ref, { outcome: 'refused', cause: ENQUEUE_FAILED_CODE }, octx);
        log.error(
          { err: enqueueErr, ...octx, cause: ENQUEUE_FAILED_CODE, outcome: 'refused' },
          'retrySend: retry re-schedule failed - chain ended',
        );
        return;
      }
      const released = await finish(owner, ref, { outcome: 'retryable', cause }, octx);
      if (released === 'lost') return;
      await refreshRetryPromise(promise, retried, runAt.toISOString(), octx);
      if (released === 'failed') {
        log.error(
          { err, ...octx, cause, runAt: runAt.toISOString() },
          'retrySend: retry re-scheduled but its record release threw - the record may still be attempting; the deferred run meets whatever it left (a takeover past the claim TTL, else a strand for the sweeper)',
        );
        return;
      }
      log.warn(
        { err, ...octx, cause, runAt: runAt.toISOString(), outcome: 'retryable' },
        'retrySend: retry deferred - re-scheduled',
      );
    }

    /**
     * Enqueue check 0 of the send.reconcile chain (never throws) and REFRESH the
     * promise to cover the whole schedule. An enqueue that fails closes the
     * attempt unresolved (a send may have happened) and WITHDRAWS the promise -
     * "retry not confirmed" - only when that close won.
     */
    async function handOff(owner: RetrySendOwner, attemptedAt: string, retried: MessageItem, octx: Ctx): Promise<void> {
      try {
        await enqueueSendReconcile(
          { owner: toOwnerRef(owner), attemptedAt, checkNo: 0 },
          reconcileDelayMs(attemptedAt, 0, now()),
        );
      } catch (err) {
        let closed = false;
        const wrote = await guardWrite(log, octx, 'closeFromReconcile', async () => {
          closed = await attemptsRepo.closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE });
        });
        const line = { err, ...octx, attemptedAt, cause: ENQUEUE_FAILED_CODE, outcome: 'unresolved' };
        if (!wrote || !closed) {
          log.error(line, 'retrySend: reconcile enqueue failed and its unresolved close was lost or failed - the record decides');
          return;
        }
        // ONE close line either way, stating what the WITHDRAW did (code review
        // r1 C-5): a lost or failed one - the helper logged its own ERROR - is
        // never reported as withdrawn.
        const withdrawn = await withdrawRetryPromise(promise, retried, octx);
        log.error(
          line,
          withdrawn === 'written' || withdrawn === 'already'
            ? 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise is withdrawn'
            : 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise withdrawal failed - the record decides',
        );
        return;
      }
      const lastCheckMs = reconcileCheckDelaysMs()[2] ?? 0;
      await refreshRetryPromise(
        promise,
        retried,
        new Date(Date.parse(attemptedAt) + lastCheckMs + RETRY_PROMISE_GRACE_MS).toISOString(),
        octx,
      );
      log.info({ ...octx, attemptedAt }, 'retrySend: retry outcome unknown - handed to reconcile');
    }

    /** Move THIS attempt to reconciling (with the SID when one is known) and hand it off; the fence's answer decides (the broadcast idiom). */
    async function handToReconcile(
      owner: RetrySendOwner,
      ref: AttemptRef,
      retried: MessageItem,
      octx: Ctx,
      sid?: string,
    ): Promise<void> {
      let handed = false;
      const wrote = await guardWrite(log, octx, 'handToReconcile', async () => {
        handed = await attemptsRepo.handToReconcile(owner, ref, sid);
      });
      if (wrote && handed) {
        await handOff(owner, ref.attemptedAt, retried, octx);
        return;
      }
      if (wrote) log.info(octx, 'retrySend: hand-off fence lost - the takeover owns the record');
      // Not written: the record stays attempting for the sweeper (guardWrite logged the ERROR).
    }

    /** R3 unknown: hand the attempt to reconcile - unless it was already re-driven once (SOR D13a): then close it unresolved and WITHDRAW. */
    async function onUnknown(
      owner: RetrySendOwner,
      ref: AttemptRef,
      retried: MessageItem,
      secondUnknownWouldClose: boolean,
      err: unknown,
      octx: Ctx,
    ): Promise<void> {
      if (secondUnknownWouldClose) {
        const closed = await finish(owner, ref, { outcome: 'unresolved', cause: 'second_unknown' }, octx);
        const line = { err, ...octx, cause: 'second_unknown', outcome: 'unresolved' };
        if (closed !== 'won') {
          log.error(line, 'retrySend: unknown send outcome after a re-drive - its unresolved close was lost or failed; the record decides');
          return;
        }
        // ONE close line either way, stating what the WITHDRAW did (code review
        // r1 C-5): a lost or failed one - the helper logged its own ERROR - is
        // never reported as withdrawn.
        const withdrawn = await withdrawRetryPromise(promise, retried, octx);
        log.error(
          line,
          withdrawn === 'written' || withdrawn === 'already'
            ? 'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise is withdrawn'
            : 'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise withdrawal failed - the record decides',
        );
        return;
      }
      log.info({ err, ...octx }, 'retrySend: unknown send outcome - handing the attempt to reconcile');
      await handToReconcile(owner, ref, retried, octx);
    }
  });
}
