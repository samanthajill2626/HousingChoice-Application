// SchedulerAdapter — the ONLY place EventBridge Scheduler is touched.
// jobs.enqueue() delegates here; nothing else may ever call EventBridge
// directly (binding guideline 2).
import {
  CreateScheduleCommand,
  type CreateScheduleCommandOutput,
} from '@aws-sdk/client-scheduler';
import type { JobEnvelope } from '../jobs/types.js';

export interface ScheduleOnceOptions {
  /** When the job should run. Defaults to "now" (immediate one-off). */
  runAt?: Date;
}

export interface SchedulerAdapter {
  scheduleOnce(envelope: JobEnvelope, opts?: ScheduleOnceOptions): Promise<void>;
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

export class EventBridgeSchedulerAdapter implements SchedulerAdapter {
  constructor(private readonly deps: EventBridgeSchedulerAdapterDeps) {}

  async scheduleOnce(envelope: JobEnvelope, opts?: ScheduleOnceOptions): Promise<void> {
    const earliest = Date.now() + MIN_SCHEDULE_LEAD_MS;
    const requested = opts?.runAt?.getTime() ?? 0; // unset = "now" = run ASAP
    const runAt = new Date(Math.max(requested, earliest));
    const command = new CreateScheduleCommand({
      // Schedule names: [0-9a-zA-Z-_.]+, max 64 chars. jobId is a UUID (36).
      Name: `hc-${envelope.jobName.replace(/[^0-9a-zA-Z\-_.]/g, '-')}-${envelope.jobId}`.slice(
        0,
        64,
      ),
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
