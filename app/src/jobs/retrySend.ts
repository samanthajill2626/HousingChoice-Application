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
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const RETRY_SEND_JOB = 'messaging.retrySend';

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
  logger?: Logger;
}

/** Consumer side (worker.ts): register the handler with real (or test) deps. */
export function registerRetrySendJobHandler(deps: RetrySendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/services touch config + DynamoDB only on first job run.
  let sendMessage = deps.sendMessage;
  let messages = deps.messagesRepo;

  defineJobHandler(RETRY_SEND_JOB, async (rawPayload) => {
    const payload = parseRetrySendPayload(rawPayload);
    sendMessage ??= createSendMessageService({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });

    const original = await messages.getByProviderSid(payload.providerSid);
    if (!original) {
      log.warn({ providerSid: payload.providerSid }, 'retrySend: original message not found — nothing to retry');
      return;
    }
    if (original.direction !== 'outbound') {
      log.warn({ providerSid: payload.providerSid }, 'retrySend: original message is not outbound — refusing');
      return;
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
        ...(original.mediaUrls !== undefined && { mediaUrls: original.mediaUrls }),
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
