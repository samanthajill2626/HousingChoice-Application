// worker process entrypoint: job handlers + the SQS jobs consumer (M1.2).
//
// OTel must be loaded/started FIRST, so everything below the startOtel()
// call uses dynamic imports.
//
// Delivery path in AWS: app jobs.enqueue() -> EventBridge Scheduler one-off
// schedule (ActionAfterCompletion DELETE) -> SQS jobs queue -> the long-poll
// loop below -> dispatchJob() (envelope gate: validates, mints jobRunId,
// rehydrates correlation context) -> registered handler.
import type { SqsJobConsumer } from './adapters/sqsJobConsumer.js';
import { startOtel } from './lib/otel.js';

await startOtel();

const { installProcessErrorHandlers } = await import('./lib/errors.js');
const { logger } = await import('./lib/logger.js');
const { loadConfig } = await import('./lib/config.js');
const { newBootId, runWithContext } = await import('./lib/context.js');
const { dispatchJob, registeredJobNames } = await import('./jobs/jobs.js');
const { registerRetrySendJobHandler } = await import('./jobs/retrySend.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();

// M1.1: transient-delivery-failure (30003) retry sends, enqueued by the
// Twilio status webhook. Dispatch-time logs use the JOB context (fresh
// jobRunId rehydrated from the envelope), not the boot context.
registerRetrySendJobHandler();

// M1.2: the delivery loop. In AWS, JOBS_QUEUE_URL is set (Terraform jobs
// module -> Parameter Store -> deploy-hydrated .env) and the worker
// long-polls the jobs queue. NODE_ENV=production without it never reaches
// this point — loadConfig() fails fast.
//
// Local dev (JOBS_QUEUE_URL unset): NO poll loop. The app process runs the
// InMemorySchedulerAdapter, which only RECORDS envelopes — nothing calls its
// deliverAll() outside tests — so locally enqueued jobs are accepted but
// never executed in-process or here; the app boot WARN says exactly that.
let consumer: SqsJobConsumer | undefined;
if (config.jobsQueueUrl) {
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  const { SqsJobConsumer } = await import('./adapters/sqsJobConsumer.js');
  consumer = new SqsJobConsumer({
    client: new SQSClient({ region: config.awsRegion }),
    queueUrl: config.jobsQueueUrl,
    dispatch: dispatchJob,
    baseContext: bootContext,
    logger,
  });
  consumer.start();
}

// The deploy health gate greps for the 'worker ready' line — keep it intact.
// The queue URL is operational config (never a credential), so it may appear.
runWithContext(bootContext, () => {
  logger.info(
    { handlers: registeredJobNames(), jobsQueueUrl: config.jobsQueueUrl },
    `worker ready - job handlers registered: [${registeredJobNames().join(', ')}]` +
      (config.jobsQueueUrl
        ? ` - polling ${config.jobsQueueUrl}`
        : ' - JOBS_QUEUE_URL unset: jobs are not delivered (local dev)'),
  );
});

// Keep the process alive until a shutdown signal arrives (also covers the
// local mode where no poll loop is running).
const keepAlive = setInterval(() => {
  /* heartbeat seam — the poll loop does the real work in AWS */
}, 60_000);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  runWithContext(bootContext, () => {
    logger.info({ signal }, 'shutdown signal received — worker draining');
  });
  clearInterval(keepAlive);
  // docker compose SIGKILLs after its stop grace period anyway — don't let a
  // stuck handler outlive it (same 10s bound as the app process).
  setTimeout(() => process.exit(0), 10_000).unref();
  void (async () => {
    try {
      // Stop polling, finish in-flight jobs (and their deletes), then exit.
      await consumer?.stop();
    } finally {
      runWithContext(bootContext, () => {
        logger.info('worker drained — exiting');
      });
      process.exit(0);
    }
  })();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
