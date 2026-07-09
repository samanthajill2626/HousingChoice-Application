// messaging.retrySend — the ONE retry path for transient delivery failures
// (Twilio 30003, doc §7.1 "transient failures get a scheduled retry with
// backoff"). The status webhook enqueues it via jobs.enqueue() (envelope
// machinery — never raw scheduler calls, binding guideline 3); the worker
// registers the handler via registerRetrySendJobHandler().
//
// PII: the payload carries IDs only (provider SID + conversation), never the
// message body — the handler re-reads body/media from the messages table.
// Attempt count rides the payload; the handler stamps retry_attempt onto the
// NEW message so the next 30003 callback can see how deep the chain is.
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MediaAttachment,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { getContext } from '../lib/context.js';
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

/** Producer side (status webhook): schedule ONE backed-off retry. */
export async function enqueueSendRetry(payload: RetrySendPayload): Promise<void> {
  await enqueue(RETRY_SEND_JOB, payload, {
    runAt: new Date(Date.now() + retryBackoffMs(payload.attempt)),
  });
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
  logger?: Logger;
}

/** Consumer side (worker.ts): register the handler with real (or test) deps. */
export function registerRetrySendJobHandler(deps: RetrySendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/services touch config + DynamoDB only on first job run.
  let sendMessage = deps.sendMessage;
  let messages = deps.messagesRepo;
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
      // automated: true on purpose — retries are machine-initiated and
      // breaker-metered by design (a retry storm must trip the breaker).
      // The retried message keeps the ORIGINAL author (the retry is the same
      // logical message, not a new teammate action).
      outcome = await sendMessage({
        conversationId: payload.conversationId,
        ...(original.body !== undefined && { body: original.body }),
        ...(retryMediaUrls !== undefined && { mediaUrls: retryMediaUrls }),
        ...(retryAttachments !== undefined && { attachments: retryAttachments }),
        automated: true,
        author: original.author === 'ai' ? 'ai' : 'teammate',
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

    // Lineage: the new message records what it retried and how deep the
    // chain is — the next 30003 callback reads retry_attempt for the cap.
    // Accepted risk: if this annotate loses the race to the NEXT 30003
    // callback for the new SID, that callback sees no retry_attempt and the
    // chain counter resets — the 60s+ backoff makes that window unrealistic.
    await messages.annotateMessage(payload.conversationId, outcome.tsMsgId, {
      retryOf: original.tsMsgId,
      retryAttempt: payload.attempt,
    });
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
