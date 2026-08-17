// Shared job-queue wiring: the ONE place that decides which OutboundQueueAdapter
// and SchedulerAdapter a process gets. Both entrypoints (index.ts = app,
// worker.ts = worker) call it, so the two can never drift.
//
// WHY THIS MODULE EXISTS (prod incident 2026-08-16): this selection used to live
// inline in index.ts and was simply MISSING from worker.ts. Nothing failed at
// boot - the gap only surfaced when a job handler running in the worker tried to
// enqueue a follow-up job, which threw 'no OutboundQueueAdapter configured'. That
// silently disabled every worker-side continuation and retry: a voicemail's
// reconcile retry (the call bubble hung on "Transcribing..." forever) and a relay
// group's relay.intro hand-off were both observed dying in production. Wiring that
// two processes must share belongs in one function they both call, not in two
// blocks that happen to agree.
//
// OTel: the entrypoints must start OTel before express/http/aws-sdk are imported,
// so every heavy dependency here is imported DYNAMICALLY inside the function and
// the entrypoints import this module dynamically too.
//
// Logging: this function never logs. It RETURNS notices and the caller emits them
// inside its own runWithContext(bootContext), so boot lines carry a correlation id
// and never trip the orphan-log alarm (doc section 9).
import { configureOutboundQueue, configureScheduler } from './jobs.js';
import type { AppConfig } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import type { OutboundSqsClientLike, SchedulerClientLike } from '../adapters/scheduler.js';

/** A boot line for the CALLER to log in its own correlation context. */
export interface BootNotice {
  level: 'info' | 'warn';
  message: string;
  data?: Record<string, unknown>;
}

export interface QueueWiringResult {
  /** 'sqs' when JOBS_QUEUE_URL is set (deployed), 'in-process' otherwise (local). */
  outbound: 'sqs' | 'in-process';
  /** 'eventbridge' when both scheduler ARNs are set, 'in-memory' otherwise. */
  scheduler: 'eventbridge' | 'in-memory';
  notices: BootNotice[];
}

export interface ConfigureJobQueuesDeps {
  config: AppConfig;
  logger: Logger;
  /** dispatchJob - used by the in-process adapter only (local dev / tests). */
  dispatch: (rawEvent: unknown) => Promise<void>;
  /** Shared A2P bucket the in-process adapter meters through (local dev only). */
  tokenBucket?: TokenBucket;
  /**
   * Local dev seam: fire delayed in-process jobs after a real timeout so backoff
   * continuations actually run on a laptop. Tests omit it (deterministic drain).
   */
  scheduleTimer?: (run: () => void, delaySeconds: number) => void;
  /**
   * Injected AWS clients - the same test seam the adapters themselves expose
   * (OutboundSqsClientLike / SchedulerClientLike). Real clients are constructed
   * here when absent; no test ever reaches AWS.
   */
  clients?: { sqs?: OutboundSqsClientLike; scheduler?: SchedulerClientLike };
}

/**
 * Wire jobs.enqueue()'s two delivery paths for this process and report what was
 * chosen. Idempotent per process in practice (each entrypoint calls it once at
 * boot); calling it again simply replaces the adapters.
 */
export async function configureJobQueues(deps: ConfigureJobQueuesDeps): Promise<QueueWiringResult> {
  const { config, logger } = deps;
  const notices: BootNotice[] = [];

  // --- Scheduler: the LONG-HORIZON branch only (delays > 12min; dormant in
  // Phase 1, where every delayed job is <= 240s and takes the SQS path below).
  let scheduler: QueueWiringResult['scheduler'];
  if (config.schedulerTargetArn && config.schedulerRoleArn) {
    const { EventBridgeSchedulerAdapter } = await import('../adapters/scheduler.js');
    let client = deps.clients?.scheduler;
    if (client === undefined) {
      const { SchedulerClient } = await import('@aws-sdk/client-scheduler');
      client = new SchedulerClient({ region: config.awsRegion });
    }
    configureScheduler(
      new EventBridgeSchedulerAdapter({
        client,
        targetArn: config.schedulerTargetArn,
        roleArn: config.schedulerRoleArn,
      }),
    );
    scheduler = 'eventbridge';
    notices.push({
      level: 'info',
      message:
        'EventBridge scheduler adapter configured - used only for >12min long-horizon jobs (dormant in Phase 1); <=12min jobs go via SQS DelaySeconds',
      data: { schedulerTargetArn: config.schedulerTargetArn },
    });
  } else {
    const { InMemorySchedulerAdapter } = await import('../adapters/scheduler.js');
    configureScheduler(new InMemorySchedulerAdapter());
    scheduler = 'in-memory';
    notices.push({
      level: 'warn',
      message:
        'SCHEDULER_TARGET_ARN/SCHEDULER_ROLE_ARN unset - using the in-memory scheduler for the long-horizon branch: enqueued long-horizon jobs are accepted but NOT delivered (local NODE_ENVs only; production fails fast at loadConfig instead)',
    });
  }

  // --- Outbound queue: ALL jobs whose delay is within the SQS DelaySeconds cap
  // (immediate + short backoff). In AWS both processes SendMessage to the queue
  // the worker long-polls; locally there is no queue, so jobs run in-process.
  let outbound: QueueWiringResult['outbound'];
  if (config.jobsQueueUrl) {
    const { SqsOutboundQueueAdapter } = await import('../adapters/scheduler.js');
    let client = deps.clients?.sqs;
    if (client === undefined) {
      const { SQSClient } = await import('@aws-sdk/client-sqs');
      client = new SQSClient({ region: config.awsRegion });
    }
    configureOutboundQueue(
      new SqsOutboundQueueAdapter({ client, queueUrl: config.jobsQueueUrl, logger }),
    );
    outbound = 'sqs';
  } else {
    const { InProcessOutboundQueueAdapter } = await import('../adapters/scheduler.js');
    configureOutboundQueue(
      new InProcessOutboundQueueAdapter({
        dispatch: deps.dispatch,
        logger,
        ...(deps.tokenBucket !== undefined && { tokenBucket: deps.tokenBucket }),
        ...(deps.scheduleTimer !== undefined && { scheduleTimer: deps.scheduleTimer }),
      }),
    );
    outbound = 'in-process';
    notices.push({
      level: 'warn',
      message:
        'JOBS_QUEUE_URL unset - jobs run IN-PROCESS (local dev only; production uses SQS to the worker)',
    });
  }

  return { outbound, scheduler, notices };
}
