// email-channel B4: the inbound-mail dispatch shared by BOTH delivery
// mechanisms - the worker's second SqsJobConsumer (prod: SES -> S3 -> SNS -> SQS)
// and the dev-gated webhook route (local/e2e: fake-SES POST). ONE code path:
//   parse the SNS/SES envelope (sesNotifications) -> route by kind:
//     inbound  -> ingestInboundEmail, wrapped in a semaphore(2) gate (the
//                 mmsMedia transcode-gate pattern, mmsMedia.ts:45) so a hostile
//                 parse burst cannot pile up CPU in one process.
//     event    -> the injectable applyEmailEvent seam (B5 wires bounce/complaint/
//                 delivery -> status + suppression; default here log-and-acks).
//     ignored  -> ack (return); malformed input is never a retry loop.
//
// CRITICAL (plan B4): SES/SNS notifications are NEVER routed through dispatchJob.
// dispatchJob throws MalformedJobEnvelopeError on an envelope with no `jobName`,
// which the SqsJobConsumer treats as POISON and DELETES - it would silently drop
// inbound mail. This dispatch parses the SNS envelope itself and calls
// ingestInboundEmail directly. A throwing ingest (transient S3) propagates so the
// SqsJobConsumer leaves the message for SQS redelivery / DLQ (never swallowed).
//
// The semaphore lives per delivery mechanism, not process-globally: in prod
// inbound flows ONLY through the worker consumer; in local/e2e ONLY through the
// dev route - the two never co-run for a given environment, so each constructs
// its own gate (worker: createInboundMailDispatch; route: createSesWebhookRouter).
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createSemaphore, type Semaphore } from '../lib/semaphore.js';
import {
  parseSnsSesNotification,
  type SnsSesNotification,
  type SnsSesEvent,
} from './sesNotifications.js';
import type { InboundEmailNotice, IngestResult } from './inboundEmail.js';

/** Concurrent ingests per delivery mechanism (mirrors MMS_TRANSCODE_MAX_CONCURRENT). */
export const INBOUND_MAIL_INGEST_CONCURRENCY = 2;
/**
 * How long a queued ingest waits for a gate slot before giving up. On timeout the
 * gate rejects ('semaphore_timeout') and the dispatch throws - in the worker that
 * is a safe SQS redelivery; in the dev route it surfaces as a 500 the fake reports
 * as appStatus (never a silent drop). Generous vs the 30s in-ingest parse bound.
 */
export const INBOUND_MAIL_GATE_TIMEOUT_MS = 60_000;

/** The B5 seam signature: apply a parsed bounce/complaint/delivery event. */
export type ApplyEmailEvent = (event: SnsSesEvent) => Promise<void>;

/** The pre-bound ingestion call (worker/route bind ingestInboundEmail over deps). */
export type IngestInbound = (notice: InboundEmailNotice) => Promise<IngestResult>;

export interface RunNotificationDeps {
  /**
   * The bound ingestion call. UNDEFINED means the inbound raw store is
   * unconfigured (no INBOUND_MAIL_BUCKET) - an inbound notification then
   * resolves to { outcome: 'unavailable' } (the dev route maps that to 503; the
   * worker never builds a consumer without a raw store, so it never sees it).
   */
  ingest?: IngestInbound;
  applyEmailEvent: ApplyEmailEvent;
  gate: Semaphore;
  gateTimeoutMs?: number;
  logger: Logger;
}

/** A compact summary the dev route serializes; the worker ignores the return. */
export interface RunNotificationResult {
  outcome: IngestResult['outcome'] | 'event' | 'ignored' | 'unavailable';
  conversationId?: string;
  unmatchedId?: string;
}

/**
 * Run one ALREADY-PARSED notification's side effects. Throws ONLY from ingest
 * (transient S3 / gate timeout) - safe for SQS redelivery; the dev route lets it
 * 500. Events + ignored never throw.
 */
export async function runSnsSesNotification(
  parsed: SnsSesNotification,
  deps: RunNotificationDeps,
): Promise<RunNotificationResult> {
  switch (parsed.kind) {
    case 'inbound': {
      if (deps.ingest === undefined) return { outcome: 'unavailable' };
      const notice: InboundEmailNotice = {
        bucket: parsed.bucket,
        key: parsed.key,
        ...(parsed.spamVerdict !== undefined && { spamVerdict: parsed.spamVerdict }),
        ...(parsed.virusVerdict !== undefined && { virusVerdict: parsed.virusVerdict }),
      };
      const release = await deps.gate.acquire(deps.gateTimeoutMs ?? INBOUND_MAIL_GATE_TIMEOUT_MS);
      try {
        const result = await deps.ingest(notice);
        return {
          outcome: result.outcome,
          ...(result.conversationId !== undefined && { conversationId: result.conversationId }),
          ...(result.unmatchedId !== undefined && { unmatchedId: result.unmatchedId }),
        };
      } finally {
        release();
      }
    }
    case 'event': {
      // Never throw on an event: a bad event must not DLQ the message / 500 the
      // route. B5's handler swallows its own errors; the default just logs.
      await deps.applyEmailEvent(parsed);
      return { outcome: 'event' };
    }
    case 'ignored': {
      deps.logger.info({ reason: parsed.reason }, 'inbound email notification ignored');
      return { outcome: 'ignored' };
    }
  }
}

/**
 * The default (B5-unwired) event handler: log-and-ack with IDs only (PII rule).
 * B5 replaces this by injecting `applyEmailEvent` into the worker dispatch AND
 * the dev route.
 */
export function defaultApplyEmailEvent(logger: Logger): ApplyEmailEvent {
  return async (event) => {
    logger.info(
      {
        eventType: event.eventType,
        sesMessageId: event.sesMessageId,
        ...(event.bounceType !== undefined && { bounceType: event.bounceType }),
      },
      'SES event received - no handler wired yet (B5 applies bounce/complaint/delivery)',
    );
  };
}

export interface InboundMailDispatchDeps {
  /** Bound ingestInboundEmail; required (the worker only builds this when a raw store exists). */
  ingest: IngestInbound;
  /** B5 seam; defaults to log-and-ack. */
  applyEmailEvent?: ApplyEmailEvent;
  logger?: Logger;
  /** Injectable gate (tests); defaults to a fresh semaphore(2). */
  gate?: Semaphore;
  gateTimeoutMs?: number;
}

/**
 * Build the `dispatch(rawEvent)` the SqsJobConsumer runs. Parses the SNS/SES
 * envelope and routes it; the return is void (the consumer deletes on success,
 * redelivers on throw).
 */
export function createInboundMailDispatch(
  deps: InboundMailDispatchDeps,
): (rawEvent: unknown) => Promise<void> {
  const logger = deps.logger ?? defaultLogger;
  const gate = deps.gate ?? createSemaphore(INBOUND_MAIL_INGEST_CONCURRENCY);
  const applyEmailEvent = deps.applyEmailEvent ?? defaultApplyEmailEvent(logger);
  return async (rawEvent: unknown): Promise<void> => {
    const parsed = parseSnsSesNotification(rawEvent, logger);
    await runSnsSesNotification(parsed, {
      ingest: deps.ingest,
      applyEmailEvent,
      gate,
      ...(deps.gateTimeoutMs !== undefined && { gateTimeoutMs: deps.gateTimeoutMs }),
      logger,
    });
  };
}
