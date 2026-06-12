// worker process entrypoint: job handlers.
//
// OTel must be loaded/started FIRST, so everything below the startOtel()
// call uses dynamic imports.
//
// Real event sources (EventBridge Scheduler -> worker) arrive in later
// milestones; the M0.3 dev loop may drive dispatchJob() via the
// InMemorySchedulerAdapter. For now the worker just registers handlers and
// stays alive.
import { startOtel } from './lib/otel.js';

await startOtel();

const { installProcessErrorHandlers } = await import('./lib/errors.js');
const { logger } = await import('./lib/logger.js');
const { newBootId, runWithContext } = await import('./lib/context.js');
const { defineJobHandler, registeredJobNames } = await import('./jobs/jobs.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

// PLACEHOLDER handler — demo no-op so the registry isn't empty. Remove once
// real job handlers land (Phase 1). Dispatch-time logs use the JOB context
// (fresh jobRunId), not the boot context.
defineJobHandler('noop.ping', (payload) => {
  logger.info({ payload }, 'noop.ping handled (placeholder)');
});

runWithContext(bootContext, () => {
  logger.info(
    { handlers: registeredJobNames() },
    `worker ready - job handlers registered: [${registeredJobNames().join(', ')}]`,
  );
});

// Keep the process alive until a shutdown signal arrives.
const keepAlive = setInterval(() => {
  /* heartbeat seam — intentionally idle until real event sources land */
}, 60_000);

function shutdown(signal: NodeJS.Signals): void {
  runWithContext(bootContext, () => {
    logger.info({ signal }, 'shutdown signal received — worker exiting');
    clearInterval(keepAlive);
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
