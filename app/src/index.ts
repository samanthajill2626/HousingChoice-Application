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

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();
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
