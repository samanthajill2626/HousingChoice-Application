// SchedulerAdapter — the ONLY place EventBridge Scheduler is touched.
// jobs.enqueue() delegates here; nothing else may ever call EventBridge
// directly (binding guideline 2).
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
// OutboundQueueAdapter — the IMMEDIATE job path (M1.7).
//
// jobs.enqueue() routes future-scheduled jobs through EventBridge Scheduler,
// which floors delivery at ~60s (MIN_SCHEDULE_LEAD_MS) — far too slow for
// relay fan-out, where a member texts the pool number and the other members
// expect the relay within seconds. enqueueImmediate() routes here instead:
//   - production  → SQS SendMessage straight to the jobs queue (the worker
//                   already long-polls it; no EventBridge hop, no 60s floor).
//   - local/tests → dispatch the job IN-PROCESS so relay fan-out actually
//                   runs on a laptop and in the suite (the in-memory scheduler
//                   only RECORDS envelopes — see worker.ts).
// A2P PACING (FIX 6): the shared TokenBucket is metered PER OUTBOUND MESSAGE
// inside the relay.fanOut HANDLER (one acquire(1) per recipient — the correct
// A2P meter, one token per real SMS). The in-process immediate adapter ALSO
// acquires one token before dispatch as a coarse admission gate on the laptop
// path; the SQS producer does NOT throttle (the handler does). Net: the
// combined outbound rate stays under the registered tier.
// ---------------------------------------------------------------------------

export interface OutboundQueueAdapter {
  /** Hand an envelope to the worker for IMMEDIATE execution (no schedule delay). */
  enqueueImmediate(envelope: JobEnvelope): Promise<void>;
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

/**
 * In-process immediate adapter — local dev + tests (M1.7). Dispatches the
 * envelope through `dispatch` (dispatchJob) RIGHT NOW, after the shared token
 * bucket admits it, so relay fan-out actually runs without SQS/EventBridge.
 * The envelope is JSON round-tripped to match the wire format the SQS path
 * delivers. A dispatch failure propagates to the caller (the webhook logs it
 * but still acks Twilio).
 */
export class InProcessOutboundQueueAdapter implements OutboundQueueAdapter {
  constructor(
    private readonly deps: {
      dispatch: (rawEvent: unknown) => Promise<void>;
      tokenBucket?: TokenBucket;
    },
  ) {}

  async enqueueImmediate(envelope: JobEnvelope): Promise<void> {
    await this.deps.tokenBucket?.acquire(1);
    await this.deps.dispatch(JSON.parse(JSON.stringify(envelope)) as unknown);
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
// SQS immediate adapter — production immediate path (M1.7).
//
// SendMessage the JSON envelope straight to the jobs queue the worker already
// long-polls (SqsJobConsumer), bypassing EventBridge entirely (no 60s floor).
// A2P pacing for the SQS path is metered INSIDE the relay.fanOut handler
// (acquire(1) per recipient — see worker.ts / relayFanOut.ts), NOT here, so
// this producer does not throttle: it just enqueues.
// ---------------------------------------------------------------------------

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

  async enqueueImmediate(envelope: JobEnvelope): Promise<void> {
    await this.deps.client.send(
      new SendMessageCommand({
        QueueUrl: this.deps.queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );
    this.log.info(
      { jobName: envelope.jobName, jobId: envelope.jobId },
      'job enqueued (immediate, SQS)',
    );
  }
}
