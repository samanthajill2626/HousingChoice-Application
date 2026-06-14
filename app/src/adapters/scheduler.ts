// SchedulerAdapter — the ONLY place EventBridge Scheduler is touched.
// jobs.enqueue() delegates here ONLY for long-horizon delays (> the SQS
// DelaySeconds cap, JOBS_SQS_MAX_DELAY_SECONDS in jobs.ts); nothing else may
// ever call EventBridge directly (binding guideline 2). All ≤12min jobs
// (immediate + short backoff) flow through the OutboundQueueAdapter below as
// an SQS SendMessage with DelaySeconds — no EventBridge hop.
import {
  CreateScheduleCommand,
  type CreateScheduleCommandOutput,
} from '@aws-sdk/client-scheduler';
import {
  SendMessageCommand,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import type { JobEnvelope } from '../jobs/types.js';

export interface ScheduleOnceOptions {
  /** When the job should run. Defaults to "now" (immediate one-off). */
  runAt?: Date;
}

export interface SchedulerAdapter {
  scheduleOnce(envelope: JobEnvelope, opts?: ScheduleOnceOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// OutboundQueueAdapter — the SQS-native job path (M1.7 + delay refactor).
//
// jobs.enqueue() routes EVERY job whose delay is within the SQS DelaySeconds
// cap (JOBS_SQS_MAX_DELAY_SECONDS, 12min) through here — immediate (delay 0)
// AND short-backoff (retry 60/120/240s, relay/broadcast continuations
// 5/10/20s) alike. Only delays beyond that cap fall through to EventBridge
// Scheduler (future long-horizon jobs; no Phase-1 callers). This bypasses
// EventBridge's ~60s delivery floor entirely, so relay fan-out reaches the
// other members within seconds and backoff delays are exact (no 60s floor):
//   - production  → SQS SendMessage straight to the jobs queue with
//                   DelaySeconds (the worker already long-polls it; no
//                   EventBridge hop). DelaySeconds 0 = immediate.
//   - local/tests → an immediate (delaySeconds 0) job dispatches IN-PROCESS so
//                   relay fan-out actually runs on a laptop and in the suite; a
//                   delayed job is RECORDED for deterministic test draining
//                   (deliverDelayed) and, in local dev, fired after a real
//                   setTimeout so backoff continuations still run on a laptop.
// A2P PACING (FIX 6): the shared TokenBucket is metered PER OUTBOUND MESSAGE
// inside the relay.fanOut HANDLER (one acquire(1) per recipient — the correct
// A2P meter, one token per real SMS). The in-process adapter ALSO acquires one
// token before an immediate dispatch as a coarse admission gate on the laptop
// path; the SQS producer does NOT throttle (the handler does). Net: the
// combined outbound rate stays under the registered tier.
// ---------------------------------------------------------------------------

export interface EnqueueQueueOptions {
  /**
   * Seconds SQS holds the message before the worker can receive it (0..900;
   * jobs.enqueue() never sends > JOBS_SQS_MAX_DELAY_SECONDS = 720). Defaults
   * to 0 (immediate).
   */
  delaySeconds?: number;
}

export interface OutboundQueueAdapter {
  /**
   * Hand an envelope to the worker queue. delaySeconds 0 = immediate;
   * delaySeconds > 0 = SQS holds it that long before delivery (exact backoff,
   * no EventBridge 60s floor).
   */
  enqueue(envelope: JobEnvelope, opts?: EnqueueQueueOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapter — local dev (M0.3 dev loop) and tests.
// ---------------------------------------------------------------------------

export interface ScheduledItem {
  envelope: JobEnvelope;
  runAt?: Date;
}

export class InMemorySchedulerAdapter implements SchedulerAdapter {
  readonly scheduled: ScheduledItem[] = [];

  async scheduleOnce(envelope: JobEnvelope, opts?: ScheduleOnceOptions): Promise<void> {
    this.scheduled.push({ envelope, runAt: opts?.runAt });
  }

  /**
   * Test/dev helper: drain the queue through a dispatch fn. Envelopes are
   * round-tripped through JSON to simulate the EventBridge wire format.
   */
  async deliverAll(dispatch: (rawEvent: unknown) => Promise<void>): Promise<void> {
    while (this.scheduled.length > 0) {
      const item = this.scheduled.shift();
      if (!item) break;
      await dispatch(JSON.parse(JSON.stringify(item.envelope)) as unknown);
    }
  }
}

/** A delayed in-process job recorded for deterministic draining (tests). */
export interface DelayedItem {
  envelope: JobEnvelope;
  delaySeconds: number;
}

/**
 * In-process outbound adapter — local dev + tests (M1.7 + delay refactor).
 *
 * IMMEDIATE (delaySeconds 0): dispatches the envelope through `dispatch`
 * (dispatchJob) RIGHT NOW, after the shared token bucket admits it, so relay
 * fan-out actually runs without SQS/EventBridge.
 *
 * DELAYED (delaySeconds > 0): RECORDED in `delayed[]` so tests stay
 * deterministic (drain synchronously via deliverDelayed — never a real sleep,
 * matching InMemorySchedulerAdapter.deliverAll). In LOCAL DEV an injected
 * `scheduleTimer` (real setTimeout, wired in index.ts) ALSO fires the dispatch
 * after the delay so backoff continuations run on a laptop; tests omit it, so
 * delayed jobs only accumulate in `delayed[]`.
 *
 * The envelope is JSON round-tripped to match the wire format the SQS path
 * delivers. A dispatch failure propagates to the caller (the webhook logs it
 * but still acks Twilio).
 */
export class InProcessOutboundQueueAdapter implements OutboundQueueAdapter {
  /** Delayed jobs recorded for deterministic test draining (deliverDelayed). */
  readonly delayed: DelayedItem[] = [];

  constructor(
    private readonly deps: {
      dispatch: (rawEvent: unknown) => Promise<void>;
      tokenBucket?: TokenBucket;
      /**
       * LOCAL DEV ONLY: schedule `run` after `delaySeconds` (real setTimeout in
       * index.ts). Omitted in tests so delayed jobs stay deterministic — they
       * just accumulate in `delayed[]` for deliverDelayed to drain.
       */
      scheduleTimer?: (run: () => void, delaySeconds: number) => void;
    },
  ) {}

  async enqueue(envelope: JobEnvelope, opts?: EnqueueQueueOptions): Promise<void> {
    const delaySeconds = opts?.delaySeconds ?? 0;
    const wire = JSON.parse(JSON.stringify(envelope)) as unknown;
    if (delaySeconds <= 0) {
      await this.deps.tokenBucket?.acquire(1);
      await this.deps.dispatch(wire);
      return;
    }
    // Delayed: record for deterministic test draining; optionally fire later
    // (local dev) via the injected real-timer seam.
    this.delayed.push({ envelope, delaySeconds });
    if (this.deps.scheduleTimer) {
      this.deps.scheduleTimer(() => {
        void this.deps.dispatch(wire);
      }, delaySeconds);
    }
  }

  /**
   * Test/dev helper: drain recorded DELAYED jobs through a dispatch fn,
   * synchronously and with no real sleep (the delaySeconds is recorded for
   * assertions, not awaited). Mirrors InMemorySchedulerAdapter.deliverAll.
   */
  async deliverDelayed(dispatch: (rawEvent: unknown) => Promise<void>): Promise<void> {
    while (this.delayed.length > 0) {
      const item = this.delayed.shift();
      if (!item) break;
      await dispatch(JSON.parse(JSON.stringify(item.envelope)) as unknown);
    }
  }
}

// ---------------------------------------------------------------------------
// EventBridge Scheduler adapter — production path (M1.2).
//
// Target = the SQS jobs queue: for SQS targets, Target.Input becomes the SQS
// message BODY verbatim, so the worker's long-poll receives the JSON
// JobEnvelope exactly as enqueued and hands it to dispatchJob().
// ---------------------------------------------------------------------------

/** Minimal client surface so tests can inject a fake (no AWS calls). */
export interface SchedulerClientLike {
  send(command: CreateScheduleCommand): Promise<CreateScheduleCommandOutput>;
}

export interface EventBridgeSchedulerAdapterDeps {
  /** Injected so unit tests can use a fake; real SchedulerClient in prod. */
  client: SchedulerClientLike;
  /** Target ARN the schedule delivers to — the jobs QUEUE ARN (Terraform jobs module -> SCHEDULER_TARGET_ARN). */
  targetArn: string;
  /** IAM role Scheduler assumes to sqs:SendMessage (Terraform jobs module -> SCHEDULER_ROLE_ARN). */
  roleArn: string;
  /** Optional schedule group (default group when unset). */
  groupName?: string;
}

/**
 * Minimum lead time for one-off schedules. EventBridge Scheduler REJECTS
 * `at(...)` times in the past (ValidationException) — and "now" truncated to
 * the second is already in the past by the time CreateSchedule lands — so
 * immediate/near-term enqueues are clamped to now + this lead. 60s matches
 * Scheduler's ~minute-level delivery granularity and means "run ASAP" fires
 * on the service's first realistic slot; backoff retries (60s+) pass through
 * unclamped.
 */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

/** EventBridge `at(...)` expressions take `yyyy-mm-ddThh:mm:ss` (UTC, no ms/zone). */
function toAtExpression(runAt: Date): string {
  return `at(${runAt.toISOString().slice(0, 19)})`;
}

/** Schedule names allow [0-9a-zA-Z-_.]+ up to this length. */
const MAX_SCHEDULE_NAME_LENGTH = 64;

/**
 * Schedule name: `hc-<jobName>-<jobId>`. The jobId (UUID) is the UNIQUE
 * tail and must survive whole — two long-named jobs whose names only differ
 * past the cap would otherwise collide on CreateSchedule — so length is
 * absorbed by truncating the jobName segment, never the jobId.
 */
function scheduleName(envelope: JobEnvelope): string {
  const sanitized = envelope.jobName.replace(/[^0-9a-zA-Z\-_.]/g, '-');
  const maxNameSegment = MAX_SCHEDULE_NAME_LENGTH - 'hc-'.length - 1 - envelope.jobId.length;
  return `hc-${sanitized.slice(0, Math.max(maxNameSegment, 0))}-${envelope.jobId}`;
}

export class EventBridgeSchedulerAdapter implements SchedulerAdapter {
  constructor(private readonly deps: EventBridgeSchedulerAdapterDeps) {}

  async scheduleOnce(envelope: JobEnvelope, opts?: ScheduleOnceOptions): Promise<void> {
    const earliest = Date.now() + MIN_SCHEDULE_LEAD_MS;
    const requested = opts?.runAt?.getTime() ?? 0; // unset = "now" = run ASAP
    const runAt = new Date(Math.max(requested, earliest));
    const command = new CreateScheduleCommand({
      Name: scheduleName(envelope),
      GroupName: this.deps.groupName,
      ScheduleExpression: toAtExpression(runAt),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      // One-off schedules do NOT clean up after themselves — DELETE is
      // mandatory (binding guideline 2).
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: this.deps.targetArn,
        RoleArn: this.deps.roleArn,
        Input: JSON.stringify(envelope),
      },
    });
    await this.deps.client.send(command);
  }
}

// ---------------------------------------------------------------------------
// SQS outbound adapter — production path for ALL ≤12min jobs (M1.7 + delay
// refactor).
//
// SendMessage the JSON envelope straight to the jobs queue the worker already
// long-polls (SqsJobConsumer), bypassing EventBridge entirely (no 60s floor),
// with DelaySeconds for short-backoff jobs (0 = immediate). SQS hard-caps
// DelaySeconds at 900; jobs.enqueue() routes anything above
// JOBS_SQS_MAX_DELAY_SECONDS (720) to EventBridge instead, so a value > 900
// never reaches here. A2P pacing is metered INSIDE the relay.fanOut /
// broadcast.send handler (acquire(1) per recipient — see worker.ts), NOT here,
// so this producer does not throttle: it just enqueues.
// ---------------------------------------------------------------------------

/** SQS rejects DelaySeconds above this hard cap. */
export const SQS_HARD_MAX_DELAY_SECONDS = 900;

/** Minimal SQS client surface so tests inject a fake (no AWS calls). */
export interface OutboundSqsClientLike {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

export interface SqsOutboundQueueAdapterDeps {
  client: OutboundSqsClientLike;
  /** The jobs queue URL (config.jobsQueueUrl / JOBS_QUEUE_URL). */
  queueUrl: string;
  logger?: Logger;
}

export class SqsOutboundQueueAdapter implements OutboundQueueAdapter {
  private readonly log: Logger;

  constructor(private readonly deps: SqsOutboundQueueAdapterDeps) {
    this.log = deps.logger ?? defaultLogger;
  }

  async enqueue(envelope: JobEnvelope, opts?: EnqueueQueueOptions): Promise<void> {
    // Defensive clamp: jobs.enqueue() already keeps this within
    // JOBS_SQS_MAX_DELAY_SECONDS, but never let a bad value 400 the Send.
    const delaySeconds = Math.max(
      0,
      Math.min(Math.floor(opts?.delaySeconds ?? 0), SQS_HARD_MAX_DELAY_SECONDS),
    );
    await this.deps.client.send(
      new SendMessageCommand({
        QueueUrl: this.deps.queueUrl,
        MessageBody: JSON.stringify(envelope),
        DelaySeconds: delaySeconds,
      }),
    );
    this.log.info(
      { jobName: envelope.jobName, jobId: envelope.jobId, delaySeconds },
      'job enqueued (SQS)',
    );
  }
}
