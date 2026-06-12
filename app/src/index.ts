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
const { configureScheduler } = await import('./jobs/jobs.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();

// jobs.enqueue() needs a SchedulerAdapter (M1.1: the status webhook enqueues
// 30003 retry sends). EventBridge when Terraform has wired the target/role
// ARNs; until then (and locally) the in-memory adapter accepts envelopes so
// enqueue never throws — undelivered, since no event source exists yet.
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
} else {
  const { InMemorySchedulerAdapter } = await import('./adapters/scheduler.js');
  configureScheduler(new InMemorySchedulerAdapter());
  runWithContext(bootContext, () => {
    logger.warn(
      'SCHEDULER_TARGET_ARN/SCHEDULER_ROLE_ARN unset — using the in-memory scheduler: enqueued jobs are accepted but NOT delivered to the worker (EventBridge wiring is a later milestone)',
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
