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
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MediaAttachment,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { getContext } from '../lib/context.js';
import {
  oneToOneRetryWindowOrigin,
  parseRetryWindowOrigin,
  withinRetrySendWindow,
} from '../lib/retrySendWindow.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const RETRY_SEND_JOB = 'messaging.retrySend';

/**
 * Presign TTL for a re-presigned attachment on an automated retry (design
 * Sec 5/7): 1 hour, matching the manual route + relay legs. A retry is a NEW
 * provider create + fetch, so the URL only needs to outlive that fetch.
 */
export const RETRY_PRESIGN_TTL_SECONDS = 3600;

/** Total send attempts for one logical message are capped at 1 + this. */
export const MAX_SEND_RETRY_ATTEMPTS = 3;

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
  return { providerSid: p.providerSid, conversationId: p.conversationId, attempt: p.attempt };
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
   * retry-send-window D14: reads the recipient the original was fenced to
   * (`recipient_contact_id`), by id, BEFORE the execution marker. Built lazily,
   * and only when a row records a recipient.
   */
  contactsRepo?: ContactsRepo;
  /** The D4 window check's clock (tests pin it); Date.now by default. */
  now?: () => number;
  logger?: Logger;
}

/** Consumer side (worker.ts): register the handler with real (or test) deps. */
export function registerRetrySendJobHandler(deps: RetrySendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/services touch config + DynamoDB only on first job run.
  let sendMessage = deps.sendMessage;
  let messages = deps.messagesRepo;
  let contacts = deps.contactsRepo;
  const now = deps.now ?? Date.now;
  // MediaStore can legitimately resolve to undefined (no MEDIA_BUCKET), so a
  // separate init flag drives the lazy build (not `??=`, which would rebuild).
  let mediaStore = deps.mediaStore;
  let mediaStoreInit = deps.mediaStore !== undefined;

  defineJobHandler(RETRY_SEND_JOB, async (rawPayload) => {
    const payload = parseRetrySendPayload(rawPayload);
    sendMessage ??= createSendMessageService({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }

    const original = await messages.getByProviderSid(payload.providerSid);
    if (!original) {
      log.warn({ providerSid: payload.providerSid }, 'retrySend: original message not found — nothing to retry');
      return;
    }
    if (original.direction !== 'outbound') {
      log.warn({ providerSid: payload.providerSid }, 'retrySend: original message is not outbound — refusing');
      return;
    }

    // retry-send-window D14: the retry is judged against the contact the
    // original was fenced to (share-skip-fix I8), read by id BEFORE the
    // execution marker - a read that throws fails this delivery and SQS
    // redelivers it, instead of dropping the retry behind a marker. A recorded
    // recipient that no longer exists falls back to the phone-matched contact,
    // and sendMessage judges it only while it still holds the thread's number.
    const recipientContactId = original.recipient_contact_id;
    let recipient: ContactItem | undefined;
    if (typeof recipientContactId === 'string' && recipientContactId.length > 0) {
      contacts ??= createContactsRepo({ logger: deps.logger });
      recipient = await contacts.getById(recipientContactId);
      if (recipient === undefined) {
        log.warn(
          { providerSid: payload.providerSid, conversationId: payload.conversationId, recipientContactId },
          'retrySend: recorded recipient no longer exists - retrying to the phone-matched contact',
        );
      }
    }

    // Execution guard (M1.2): SQS is at-least-once — a DeleteMessage
    // failure, visibility overrun, or SIGTERM mid-flight redelivers this
    // job, and re-running it would TEXT THE HUMAN AGAIN. The envelope's
    // jobId (stable across redeliveries; dispatchJob stamps it into the
    // context) is conditionally marked as executed BEFORE the provider
    // send; a duplicate delivery resolves successfully so the consumer
    // deletes the message instead of DLQ-cycling it.
    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const firstExecution = await messages.putJobExecutionMarker(jobId, payload.conversationId);
      if (!firstExecution) {
        log.info(
          { jobId, providerSid: payload.providerSid, conversationId: payload.conversationId },
          'duplicate delivery suppressed',
        );
        return;
      }
    } else {
      // Only reachable when invoked outside dispatchJob (which always
      // stamps a jobId — real or synthesized) — flag it, don't refuse.
      log.warn(
        { providerSid: payload.providerSid },
        'retrySend: no jobId in context — duplicate-delivery guard skipped',
      );
    }

    // retry-send-window D4: the strict window check, right before the send and
    // AFTER the execution marker (a redelivery of a job that ended here ends at
    // the marker). The grace was spent when the webhook scheduled this retry
    // (D3a), so nothing may go out past origin + 15 minutes. The origin is the
    // chain's FIRST send (D2): retry_window_start on a retry row, else this
    // row's own provider_ts - the rule the 30003 decision reads too, one copy
    // in lib/retrySendWindow.ts. A missing or unparseable origin fails OPEN
    // (D5): the retry goes out unwindowed, with a WARN naming the gap.
    const windowStart = oneToOneRetryWindowOrigin(original);
    const originMs = parseRetryWindowOrigin(windowStart);
    if (originMs === undefined) {
      log.warn(
        { providerSid: payload.providerSid, conversationId: payload.conversationId, attempt: payload.attempt },
        'retrySend: no usable window origin - sending without a window check (fail open)',
      );
    } else if (!withinRetrySendWindow({ originMs, nowMs: now() })) {
      log.error(
        {
          providerSid: payload.providerSid,
          conversationId: payload.conversationId,
          attempt: payload.attempt,
          retryDecision: 'window_closed',
        },
        'retrySend: retry window closed - retry chain ended without sending',
      );
      return;
    }

    // PRESIGN PER ATTEMPT (design Sec 5 - the Cameron rule): a retry is a NEW
    // provider create + fetch, so presigned URLs are NEVER replayed. The manual
    // Retry route enforces this; this automated 30003 twin mirrors it exactly.
    // When the original carries media_attachments (the durable s3Keys), re-
    // presign each FRESH and send those (the new message persists these fresh
    // URLs + media_attachments via sendMessage). A message with NO
    // media_attachments (the raw e2e/internal seam) falls back to replaying its
    // raw mediaUrls. If attachments exist but no store is available (degenerate
    // no-MEDIA_BUCKET config), we send WITHOUT media rather than ship an EXPIRED
    // stored token.
    const originalAttachments = mediaAttachmentsOf(original);
    let retryMediaUrls: string[] | undefined;
    let retryAttachments: MediaAttachment[] | undefined;
    if (originalAttachments.length > 0) {
      if (mediaStore) {
        const store = mediaStore; // pin for the closure (mediaStore is a let)
        retryMediaUrls = await Promise.all(
          originalAttachments.map((a) => store.presign(a.s3Key, RETRY_PRESIGN_TTL_SECONDS)),
        );
        retryAttachments = originalAttachments;
        log.info(
          {
            conversationId: payload.conversationId,
            providerSid: payload.providerSid,
            attachmentCount: originalAttachments.length,
            s3Keys: originalAttachments.map((a) => a.s3Key),
          },
          'retrySend: re-presigned attachments fresh (never replaying stored URLs)',
        );
      } else {
        // No store to presign from: NEVER replay the stored presigned URLs (an
        // expired bearer token). Retry the text only. Log IDs/keys/count, no URL.
        log.warn(
          {
            conversationId: payload.conversationId,
            providerSid: payload.providerSid,
            attachmentCount: originalAttachments.length,
            s3Keys: originalAttachments.map((a) => a.s3Key),
          },
          'retrySend: attachments present but no MediaStore - retrying body only, media dropped (never replay stale URLs)',
        );
      }
    } else if (original.mediaUrls !== undefined) {
      retryMediaUrls = original.mediaUrls;
    }

    let outcome;
    try {
      // retry-send-window D14: the retry FOLLOWS THE ORIGINAL SEND. An automated
      // original (a reminder, the missed-call text, an automated share) is
      // retried automated and breaker-metered - a retry storm must still trip
      // the breaker. A person's original is retried as a person's send: manual
      // mode and the breaker do not apply, the consent gate does. A row with no
      // `automated` (sent before this deploy) is retried automated, as before.
      // The retried message keeps the ORIGINAL author (the retry is the same
      // logical message, not a new teammate action).
      //
      // D6: the lineage rides the APPEND - retry_of, retry_attempt and the
      // chain's window origin - so the next 30003 callback reads it from the
      // new row with no annotate-after race.
      outcome = await sendMessage({
        conversationId: payload.conversationId,
        ...(original.body !== undefined && { body: original.body }),
        ...(retryMediaUrls !== undefined && { mediaUrls: retryMediaUrls }),
        ...(retryAttachments !== undefined && { attachments: retryAttachments }),
        automated: original.automated ?? true,
        author: original.author === 'ai' ? 'ai' : 'teammate',
        ...(recipient !== undefined && { recipient }),
        retryOf: original.tsMsgId,
        retryAttempt: payload.attempt,
        ...(typeof windowStart === 'string' && { retryWindowStart: windowStart }),
      });
    } catch (err) {
      if (err instanceof SendRefusedError) {
        // Refusals (opt-out / breaker / manual mode) are by-design outcomes,
        // not job failures — log and stop the chain.
        log.warn(
          { providerSid: payload.providerSid, conversationId: payload.conversationId, refusal: err.code },
          'retrySend: send refused — retry chain stopped',
        );
        return;
      }
      throw err;
    }

    log.info(
      {
        conversationId: payload.conversationId,
        retryOf: original.tsMsgId,
        newProviderSid: outcome.providerSid,
        attempt: payload.attempt,
      },
      'retrySend: message re-sent',
    );
  });
}
