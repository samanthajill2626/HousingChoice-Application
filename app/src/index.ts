// app process entrypoint: HTTP/API/webhooks.
//
// OTel must be loaded/started FIRST (before express/http are imported), so
// everything below the startOtel() call uses dynamic imports.
import { startOtel } from './lib/otel.js';

await startOtel();

const { installProcessErrorHandlers } = await import('./lib/errors.js');
const { logger } = await import('./lib/logger.js');
const { loadConfig } = await import('./lib/config.js');
const { newBootId, runWithContext } = await import('./lib/context.js');
const { buildApp } = await import('./app.js');
const { configureOutboundQueue, configureScheduler, dispatchJob } = await import('./jobs/jobs.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();

// jobs.enqueue() needs a SchedulerAdapter (M1.1: the status webhook enqueues
// 30003 retry sends). In AWS, Terraform's jobs module (M1.2) wires
// SCHEDULER_TARGET_ARN (the SQS jobs queue ARN) + SCHEDULER_ROLE_ARN, and
// one-off EventBridge schedules deliver each envelope as an SQS message the
// worker long-polls and dispatches. NODE_ENV=production without them never
// reaches this point — loadConfig() fails fast. Locally both are unset: the
// in-memory adapter accepts envelopes so enqueue never throws, but nothing
// delivers them (deliverAll is test-only) — hence the WARN.
if (config.schedulerTargetArn && config.schedulerRoleArn) {
  const { SchedulerClient } = await import('@aws-sdk/client-scheduler');
  const { EventBridgeSchedulerAdapter } = await import('./adapters/scheduler.js');
  configureScheduler(
    new EventBridgeSchedulerAdapter({
      client: new SchedulerClient({ region: config.awsRegion }),
      targetArn: config.schedulerTargetArn,
      roleArn: config.schedulerRoleArn,
    }),
  );
  runWithContext(bootContext, () => {
    logger.info(
      { schedulerTargetArn: config.schedulerTargetArn },
      'EventBridge scheduler adapter configured — enqueued jobs deliver via SQS to the worker',
    );
  });
} else {
  const { InMemorySchedulerAdapter } = await import('./adapters/scheduler.js');
  configureScheduler(new InMemorySchedulerAdapter());
  runWithContext(bootContext, () => {
    logger.warn(
      'SCHEDULER_TARGET_ARN/SCHEDULER_ROLE_ARN unset — using the in-memory scheduler: enqueued jobs are accepted but NOT delivered (local NODE_ENVs only; production fails fast at loadConfig instead)',
    );
  });
}

// M1.7: the IMMEDIATE job path (relay fan-out) bypasses EventBridge's ~60s
// floor. In AWS the app SendMessages straight to the jobs queue the worker
// long-polls (the worker throttles + dispatches). Locally there is no queue,
// so the app dispatches relay fan-out IN-PROCESS — which means the relay
// handler + the shared A2P token bucket must live here too (the worker process
// is separate locally). Production never registers handlers in the app.
if (config.jobsQueueUrl) {
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  const { SqsOutboundQueueAdapter } = await import('./adapters/scheduler.js');
  configureOutboundQueue(
    new SqsOutboundQueueAdapter({
      client: new SQSClient({ region: config.awsRegion }),
      queueUrl: config.jobsQueueUrl,
      logger,
    }),
  );
} else {
  const { InProcessOutboundQueueAdapter } = await import('./adapters/scheduler.js');
  const { TokenBucket } = await import('./lib/tokenBucket.js');
  const { registerRelayFanOutJobHandler } = await import('./jobs/relayFanOut.js');
  // FIX 6: capacity == the EXACT per-second rate (not ceil — at a fractional
  // rate ceil would let a burst exceed the A2P tier), floored at 1. The bucket
  // starts full → first burst up to `capacity`, then paced at `refillPerSec`/s.
  const a2pBucket = new TokenBucket({
    capacity: Math.max(1, config.a2pRateLimitPerSec),
    refillPerSec: config.a2pRateLimitPerSec,
  });
  registerRelayFanOutJobHandler({ tokenBucket: a2pBucket });
  configureOutboundQueue(
    new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, tokenBucket: a2pBucket }),
  );
  runWithContext(bootContext, () => {
    logger.warn(
      'JOBS_QUEUE_URL unset — relay fan-out runs IN-PROCESS in the app (local dev only; production uses SQS to the worker)',
    );
  });
}

const app = buildApp({ config });

const server = runWithContext(bootContext, () =>
  app.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'app listening');
  }),
);

function shutdown(signal: NodeJS.Signals): void {
  runWithContext(bootContext, () => {
    logger.info({ signal }, 'shutdown signal received — closing server');
    server.close(() => {
      logger.info('server closed — exiting');
      process.exit(0);
    });
    // Don't hang forever on stuck keep-alive sockets.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
