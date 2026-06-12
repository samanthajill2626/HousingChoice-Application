// The TWO gates for all job traffic (binding guideline 2):
//   - enqueue(jobName, payload, opts?)  — producer side
//   - defineJobHandler(jobName, handler) + dispatchJob(rawEvent) — consumer side
// Nothing else may ever talk to EventBridge or hand events to handlers.
import { randomUUID } from 'node:crypto';
import type { SchedulerAdapter, ScheduleOnceOptions } from '../adapters/scheduler.js';
import {
  currentTraceparent,
  generateTraceparent,
  getContext,
  newJobRunId,
  runWithContext,
  type CorrelationContext,
} from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { JOB_ENVELOPE_VERSION, type JobEnvelope } from './types.js';

/** Runaway-loop guard: a job chain may not exceed this many hops. */
export const MAX_HOP_COUNT = 10;

export type JobHandler = (payload: unknown) => void | Promise<void>;

// Module-scoped registry + wiring (reset via _resetForTests()).
const registry = new Map<string, JobHandler>();
let scheduler: SchedulerAdapter | undefined;
let log: Logger = defaultLogger;

/** Wire the scheduler adapter (in-memory locally; EventBridge in AWS). */
export function configureScheduler(adapter: SchedulerAdapter): void {
  scheduler = adapter;
}

/** Test seam: swap the logger used by the gates. */
export function configureJobsLogger(logger: Logger): void {
  log = logger;
}

export interface EnqueueOptions {
  runAt?: Date;
}

/**
 * Producer gate. Stamps the current correlation context, a W3C traceparent,
 * and an incremented hopCount into a JobEnvelope, then delegates to the
 * SchedulerAdapter (which sets ActionAfterCompletion: DELETE on one-off
 * EventBridge schedules — they don't clean up after themselves).
 */
export async function enqueue(
  jobName: string,
  payload: unknown,
  opts?: EnqueueOptions,
): Promise<JobEnvelope> {
  if (!scheduler) {
    throw new Error('jobs.enqueue: no SchedulerAdapter configured (call configureScheduler first)');
  }

  const ctx = getContext() ?? {};
  const hopCount = (ctx.hopCount ?? 0) + 1;
  if (hopCount > MAX_HOP_COUNT) {
    throw new Error(
      `jobs.enqueue('${jobName}'): hopCount ${hopCount} exceeds MAX_HOP_COUNT ${MAX_HOP_COUNT} — runaway job loop guard`,
    );
  }

  // Stamp correlation fields only — jobRunId is per-run and generated fresh
  // at dispatch; hopCount/traceparent travel as top-level envelope fields.
  const correlationContext: CorrelationContext = {
    ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    ...(ctx.conversationId !== undefined && { conversationId: ctx.conversationId }),
    ...(ctx.tenantId !== undefined && { tenantId: ctx.tenantId }),
    ...(ctx.caseId !== undefined && { caseId: ctx.caseId }),
  };

  const envelope: JobEnvelope = {
    v: JOB_ENVELOPE_VERSION,
    jobId: randomUUID(),
    jobName,
    payload,
    correlationContext,
    traceparent: currentTraceparent(),
    hopCount,
    enqueuedAt: new Date().toISOString(),
  };

  const scheduleOpts: ScheduleOnceOptions = {};
  if (opts?.runAt) scheduleOpts.runAt = opts.runAt;
  await scheduler.scheduleOnce(envelope, scheduleOpts);
  log.info({ jobName, jobId: envelope.jobId, hopCount, runAt: opts?.runAt?.toISOString() }, 'job enqueued');
  return envelope;
}

/** Consumer gate, part 1: register a handler. Handlers receive (payload) only. */
export function defineJobHandler(jobName: string, handler: JobHandler): void {
  if (registry.has(jobName)) {
    throw new Error(`defineJobHandler: handler already registered for '${jobName}'`);
  }
  registry.set(jobName, handler);
}

export function registeredJobNames(): string[] {
  return [...registry.keys()];
}

/**
 * Thrown by dispatchJob() when the raw event is truly UNDISPATCHABLE: not an
 * object, no resolvable jobName (missing/unknown), or no payload object to
 * hand a handler. Marker for POISON messages: redelivery can never fix
 * these, so transport consumers (the worker's SqsJobConsumer) delete instead
 * of cycling the message to the DLQ. Handler failures stay plain errors and
 * DO retry. Dispatchable payloads that merely lack the correlation envelope
 * are NOT malformed — they run under a synthesized context (doc §9).
 */
export class MalformedJobEnvelopeError extends Error {}

/** True when every envelope field (incl. the correlation set) is present and valid. */
function isCompleteEnvelope(e: Partial<JobEnvelope>): e is JobEnvelope {
  return (
    e.v === JOB_ENVELOPE_VERSION &&
    typeof e.jobId === 'string' &&
    e.jobId.length > 0 &&
    typeof e.jobName === 'string' &&
    e.jobName.length > 0 &&
    typeof e.correlationContext === 'object' &&
    e.correlationContext !== null &&
    typeof e.traceparent === 'string' &&
    typeof e.hopCount === 'number' &&
    Number.isInteger(e.hopCount) &&
    e.hopCount >= 1 &&
    typeof e.enqueuedAt === 'string'
  );
}

/**
 * Validate a raw wire event into a runnable envelope (doc §9):
 *   - complete envelope            → run as-is
 *   - dispatchable but envelope-less (registered jobName + payload object,
 *     correlation fields missing/invalid) → SYNTHESIZE a fresh context
 *     (new jobId/traceparent, originType `synthesized`) and run anyway —
 *     never blind, never dropped
 *   - undispatchable (not an object / missing or unknown jobName / no
 *     payload object)              → MalformedJobEnvelopeError (poison)
 */
function validateEnvelope(rawEvent: unknown): { envelope: JobEnvelope; synthesized: boolean } {
  if (typeof rawEvent !== 'object' || rawEvent === null) {
    throw new MalformedJobEnvelopeError('dispatchJob: event is not an object');
  }
  const e = rawEvent as Partial<JobEnvelope>;
  if (typeof e.jobName !== 'string' || e.jobName.length === 0) {
    throw new MalformedJobEnvelopeError('dispatchJob: missing jobName');
  }
  if (!registry.has(e.jobName)) {
    throw new MalformedJobEnvelopeError(
      `dispatchJob: no handler registered for job '${e.jobName}'`,
    );
  }
  if (isCompleteEnvelope(e)) return { envelope: e, synthesized: false };
  if (typeof e.payload !== 'object' || e.payload === null) {
    throw new MalformedJobEnvelopeError('dispatchJob: payload is not an object');
  }
  return {
    envelope: {
      v: JOB_ENVELOPE_VERSION,
      jobId: randomUUID(),
      jobName: e.jobName,
      payload: e.payload,
      correlationContext: {},
      traceparent: generateTraceparent(),
      hopCount: 1,
      enqueuedAt: new Date().toISOString(),
    },
    synthesized: true,
  };
}

/**
 * Consumer gate, part 2: dispatch a raw event from the wire.
 * Validates the envelope (undispatchable event => logged error + throw;
 * envelope-less-but-dispatchable => synthesized context + WARN, doc §9),
 * generates a FRESH jobRunId, re-hydrates AsyncLocalStorage with the
 * envelope's correlation context + the new jobRunId + the stable jobId
 * BEFORE any business logic, times the handler, and logs
 * start/success/failure (failure with full stack).
 */
export async function dispatchJob(rawEvent: unknown): Promise<void> {
  let envelope: JobEnvelope;
  let synthesized: boolean;
  try {
    ({ envelope, synthesized } = validateEnvelope(rawEvent));
  } catch (err) {
    log.error({ err }, 'dispatchJob: malformed job envelope rejected');
    throw err;
  }

  // validateEnvelope guarantees registration — this lookup cannot miss.
  const handler = registry.get(envelope.jobName)!;

  const jobRunId = newJobRunId();
  const ctx: CorrelationContext = {
    ...envelope.correlationContext,
    jobRunId,
    jobId: envelope.jobId,
    hopCount: envelope.hopCount,
    traceparent: envelope.traceparent,
    ...(synthesized && { originType: 'synthesized' as const }),
  };

  await runWithContext(ctx, async () => {
    const startedAt = performance.now();
    if (synthesized) {
      // §9 mandate: a dispatchable payload with no correlation envelope is
      // run, not dropped — flagged loudly so the producer gets fixed.
      log.warn(
        { jobName: envelope.jobName, jobId: envelope.jobId },
        'envelope-less payload — context synthesized',
      );
    }
    log.info({ jobName: envelope.jobName, jobId: envelope.jobId, hopCount: envelope.hopCount }, 'job started');
    try {
      await handler(envelope.payload);
      log.info(
        { jobName: envelope.jobName, jobId: envelope.jobId, durationMs: Math.round(performance.now() - startedAt) },
        'job succeeded',
      );
    } catch (err) {
      log.error(
        {
          err,
          jobName: envelope.jobName,
          jobId: envelope.jobId,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'job failed',
      );
      throw err;
    }
  });
}

/** Test seam: clear the registry, scheduler wiring, and logger override. */
export function _resetForTests(): void {
  registry.clear();
  scheduler = undefined;
  log = defaultLogger;
}
