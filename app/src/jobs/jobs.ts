// The TWO gates for all job traffic (binding guideline 2):
//   - enqueue(jobName, payload, opts?)  — producer side
//   - defineJobHandler(jobName, handler) + dispatchJob(rawEvent) — consumer side
// Nothing else may ever talk to EventBridge/SQS or hand events to handlers.
//
// DELAY ROUTING (delay refactor): enqueue() computes the requested delay and
// picks the transport:
//   - delaySeconds <= JOBS_SQS_MAX_DELAY_SECONDS (720, conservative; SQS caps
//     at 900) → the SQS path (OutboundQueueAdapter) with that DelaySeconds.
//     0 = immediate. EXACT backoff — no EventBridge 60s floor.
//   - delaySeconds  > JOBS_SQS_MAX_DELAY_SECONDS → EventBridge Scheduler
//     (SchedulerAdapter.scheduleOnce), the long-horizon branch. In Phase 1
//     EVERY delayed job is <= 240s (retry 60/120/240, relay/broadcast
//     continuations 5/10/20), so they ALL take the SQS path; the EventBridge
//     branch is DORMANT in Phase 1 and kept only for future >12min scheduling
//     (e.g. reminders).
// The worker long-polls the same SQS jobs queue regardless of which producer
// path an envelope took (EventBridge delivers to that same queue).
import { randomUUID } from 'node:crypto';
import type {
  OutboundQueueAdapter,
  SchedulerAdapter,
  ScheduleOnceOptions,
} from '../adapters/scheduler.js';
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

/**
 * Conservative DelaySeconds ceiling for the SQS path (12min). A requested
 * delay at or below this routes through SQS DelaySeconds; above it routes to
 * EventBridge Scheduler. Deliberately below the SQS hard cap (900s) for
 * headroom. In Phase 1 every delayed job is <= 240s, so all take the SQS path.
 */
export const JOBS_SQS_MAX_DELAY_SECONDS = 720;

/** SQS's hard DelaySeconds limit — for reference; the cap above stays under it. */
export const SQS_MAX_DELAY_SECONDS = 900;

export type JobHandler = (payload: unknown) => void | Promise<void>;

// Module-scoped registry + wiring (reset via _resetForTests()).
const registry = new Map<string, JobHandler>();
let scheduler: SchedulerAdapter | undefined;
let outboundQueue: OutboundQueueAdapter | undefined;
let log: Logger = defaultLogger;
// Injected clock for delaySeconds computation (test seam). The codebase injects
// time rather than calling Date.now() directly in scheduled paths (see
// tokenBucket.ts); the enqueue gate follows suit so tests can pin "now".
let now: () => number = Date.now;

/**
 * Wire the EventBridge Scheduler adapter — used ONLY for delays beyond
 * JOBS_SQS_MAX_DELAY_SECONDS (long-horizon jobs; dormant in Phase 1). In-memory
 * locally/in tests, EventBridgeSchedulerAdapter in AWS.
 */
export function configureScheduler(adapter: SchedulerAdapter): void {
  scheduler = adapter;
}

/**
 * Wire the SQS outbound adapter — the path for ALL jobs whose delay is within
 * JOBS_SQS_MAX_DELAY_SECONDS (immediate + short backoff). SQS-direct in AWS,
 * in-process locally/in tests. Skips the EventBridge 60s floor; backoff delays
 * are exact via SQS DelaySeconds.
 */
export function configureOutboundQueue(adapter: OutboundQueueAdapter): void {
  outboundQueue = adapter;
}

/** Test seam: swap the logger used by the gates. */
export function configureJobsLogger(logger: Logger): void {
  log = logger;
}

/** Test seam: pin the clock used to compute delaySeconds from runAt. */
export function configureJobsClock(clock: () => number): void {
  now = clock;
}

export interface EnqueueOptions {
  runAt?: Date;
}

/**
 * Producer gate. Stamps the current correlation context, a W3C traceparent,
 * and an incremented hopCount into a JobEnvelope, then routes by delay:
 *   - delaySeconds <= JOBS_SQS_MAX_DELAY_SECONDS → SQS path (OutboundQueueAdapter)
 *     with that DelaySeconds (0 = immediate). Exact backoff, no 60s floor.
 *   - delaySeconds  > JOBS_SQS_MAX_DELAY_SECONDS → EventBridge Scheduler
 *     (scheduleOnce sets ActionAfterCompletion: DELETE on its one-off schedule —
 *     they don't clean up after themselves). The MIN_SCHEDULE_LEAD_MS clamp
 *     applies on this branch only; it cannot be hit in Phase 1 (no >12min
 *     callers). delaySeconds is computed from runAt against the injected clock,
 *     ceil'd to whole seconds, floored at 0 (a past runAt = immediate).
 */
export async function enqueue(
  jobName: string,
  payload: unknown,
  opts?: EnqueueOptions,
): Promise<JobEnvelope> {
  const delaySeconds = opts?.runAt
    ? Math.max(0, Math.ceil((opts.runAt.getTime() - now()) / 1000))
    : 0;

  const envelope = buildEnvelope(jobName, payload);

  if (delaySeconds <= JOBS_SQS_MAX_DELAY_SECONDS) {
    if (!outboundQueue) {
      throw new Error(
        'jobs.enqueue: no OutboundQueueAdapter configured (call configureOutboundQueue first)',
      );
    }
    await outboundQueue.enqueue(envelope, { delaySeconds });
    log.info(
      { jobName, jobId: envelope.jobId, hopCount: envelope.hopCount, delaySeconds },
      'job enqueued (SQS)',
    );
    return envelope;
  }

  // Long-horizon branch (delay > 12min): EventBridge Scheduler. Dormant in
  // Phase 1 — kept for future >12min scheduling (e.g. reminders).
  if (!scheduler) {
    throw new Error('jobs.enqueue: no SchedulerAdapter configured (call configureScheduler first)');
  }
  const scheduleOpts: ScheduleOnceOptions = {};
  if (opts?.runAt) scheduleOpts.runAt = opts.runAt;
  await scheduler.scheduleOnce(envelope, scheduleOpts);
  log.info(
    {
      jobName,
      jobId: envelope.jobId,
      hopCount: envelope.hopCount,
      delaySeconds,
      runAt: opts?.runAt?.toISOString(),
    },
    'job enqueued (EventBridge, long-horizon)',
  );
  return envelope;
}

/**
 * IMMEDIATE producer gate — thin alias for enqueue() with no runAt
 * (delaySeconds 0 → SQS path, no delay). Kept for the latency-sensitive
 * callers (relay/broadcast primary fan-out, relay intro) that read clearly as
 * "send this now". Identical behavior to enqueue(jobName, payload).
 */
export async function enqueueImmediate(jobName: string, payload: unknown): Promise<JobEnvelope> {
  return enqueue(jobName, payload);
}

/** Build a correlation-stamped JobEnvelope from the current context. */
function buildEnvelope(jobName: string, payload: unknown): JobEnvelope {
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
  return {
    v: JOB_ENVELOPE_VERSION,
    jobId: randomUUID(),
    jobName,
    payload,
    correlationContext,
    traceparent: currentTraceparent(),
    hopCount,
    enqueuedAt: new Date().toISOString(),
  };
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

/** Test seam: clear the registry, scheduler wiring, logger, and clock override. */
export function _resetForTests(): void {
  registry.clear();
  scheduler = undefined;
  outboundQueue = undefined;
  log = defaultLogger;
  now = Date.now;
}
