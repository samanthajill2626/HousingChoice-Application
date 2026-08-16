// app process entrypoint: HTTP/API/webhooks.
//
// OTel must be loaded/started FIRST (before express/http are imported), so
// everything below the startOtel() call uses dynamic imports.
// Type-only import: erased at build time, so it cannot pull runtime code in
// ahead of startOtel().
import type { TokenBucket } from './lib/tokenBucket.js';
import { startOtel } from './lib/otel.js';

await startOtel();

const { installProcessErrorHandlers } = await import('./lib/errors.js');
const { logger } = await import('./lib/logger.js');
const { loadConfig } = await import('./lib/config.js');
const { newBootId, runWithContext } = await import('./lib/context.js');
const { buildApp } = await import('./app.js');
const { maybeLoadDevRouter } = await import('./lib/devRoutes.js');
const { dispatchJob } = await import('./jobs/jobs.js');
const { configureJobQueues } = await import('./jobs/queueWiring.js');
const { drainRateLimitedWarns } = await import('./lib/rateLimitedWarn.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();

// jobs.enqueue()'s two delivery paths — SQS DelaySeconds for anything within the
// 12min cap (every Phase-1 delayed job), EventBridge Scheduler beyond it — are
// wired by the SHARED helper BOTH entrypoints call. See jobs/queueWiring.ts for
// why that sharing is load-bearing: this selection used to live only here, and
// the worker's missing copy silently broke every worker-side retry in prod.
//
// LOCAL ONLY (JOBS_QUEUE_URL unset): the app runs jobs IN-PROCESS — immediate
// jobs dispatch now, delayed jobs fire after a real setTimeout — which means ALL
// job handlers + the shared A2P token bucket must live here too (the worker
// process is separate locally). Production never registers handlers in the app,
// so both stay inside this branch.
let a2pBucket: TokenBucket | undefined;
if (!config.jobsQueueUrl) {
  const { sharedA2pBucket } = await import('./lib/tokenBucket.js');
  const { registerAllJobHandlers } = await import('./jobs/registerHandlers.js');
  // FIX 6: capacity == the EXACT per-second rate (not ceil — at a fractional
  // rate ceil would let a burst exceed the A2P tier), floored at 1. The bucket
  // starts full → first burst up to `capacity`, then paced at `refillPerSec`/s.
  // The SAME memoized instance the app's group-send route draws from (fix wave
  // 5, adversarial 34) - a meter that is not shared is not a meter. TRUE OF
  // THIS BRANCH ONLY (fix wave 2, conformance F3): with JOBS_QUEUE_URL set, the
  // jobs run in the WORKER process against the worker's own bucket, so app and
  // worker each meter their own traffic. That is how every metered path in this
  // codebase has always worked; it is stated here so nobody reads this line as
  // a cross-process guarantee.
  a2pBucket = sharedA2pBucket(config.a2pRateLimitPerSec);
  registerAllJobHandlers({ tokenBucket: a2pBucket });
}
const jobQueues = await configureJobQueues({
  config,
  logger,
  dispatch: dispatchJob,
  ...(a2pBucket !== undefined && { tokenBucket: a2pBucket }),
  // LOCAL DEV: fire delayed jobs (backoff continuations) after a real timeout so
  // they actually run on a laptop. unref() so a pending backoff never blocks
  // process exit. Ignored on the SQS path.
  scheduleTimer: (run, delaySeconds) => {
    setTimeout(run, delaySeconds * 1000).unref();
  },
});
// The helper stays silent so its boot lines carry THIS process's correlation id
// (doc section 9 / the orphan-log alarm).
runWithContext(bootContext, () => {
  for (const notice of jobQueues.notices) {
    if (notice.level === 'warn') logger.warn(notice.data ?? {}, notice.message);
    else logger.info(notice.data ?? {}, notice.message);
  }
});

// Native group texting (spec 4.1): GROUP_IDENTITY_EXCLUDED_NUMBERS is part of
// the group-thread IDENTITY contract, so a DEPLOYED stack pins a fingerprint of
// it on first boot and REFUSES to start when the configured list stops matching
// (changing it re-mints every affected group's conversationId - a migration, not
// a config edit). Local/hermetic stacks skip it: reseeds wipe the settings table,
// where the fingerprint would protect nothing and break every lane. Deliberately
// BEFORE the server listens - a stack that would mint wrong ids must not serve.
{
  const { createSettingsRepo } = await import('./repos/settingsRepo.js');
  const { verifyGroupIdentityFingerprint } = await import(
    './services/groupIdentityFingerprint.js'
  );
  await runWithContext(bootContext, async () =>
    verifyGroupIdentityFingerprint({
      store: createSettingsRepo(),
      excludedNumbers: config.groupIdentityExcludedNumbers,
      // Deployed stacks pin NODE_ENV=production (see lib/config.ts).
      deployed: config.nodeEnv === 'production',
      logger,
    }),
  );
}

// One epoch cache shared by the app's auth middleware AND the dev router, so
// /__dev/reseed can clear it after wiping + reseeding the users table.
const { createSessionEpochCache } = await import('./middleware/auth.js');
const sessionEpochCache = createSessionEpochCache();
const devRouter = await maybeLoadDevRouter(config, logger, sessionEpochCache);
// Construct the app INSIDE the boot context so any router-creation log line
// (e.g. the voice founder-triage readiness line) carries the bootId as its
// correlationId. Without this, a construction-time log is an orphan and trips
// the hc-<env>-orphan-logs alarm (binding guideline #4).
const app = runWithContext(bootContext, () =>
  buildApp({ config, devRouter, auth: { sessionEpochCache } }),
);

const server = runWithContext(bootContext, () =>
  app.listen(config.port, () => {
    // Resolved outbound-comms config on the boot line so "why didn't it send" is
    // answerable from the first log (guardrail, design 2026-07-21 D6). Flags and
    // driver names only - never credentials or PII.
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        messagingDriver: config.messagingDriver,
        emailDriver: config.emailDriver,
        smsSendingEnabled: config.smsSendingEnabled,
        emailSendingEnabled: config.emailSendingEnabled,
      },
      'app listening',
    );
  }),
);

function shutdown(signal: NodeJS.Signals): void {
  runWithContext(bootContext, () => {
    // DRAIN THE THROTTLED TALLIES FIRST (fix wave 2, adversarial 26). The
    // trailing flush is an unref'd timer, so a rolling deploy inside the window
    // silently dropped up to 5 minutes of suppressed count - exactly the "task
    // replacement" case the throttle's own docstring names. This is the last
    // moment that loss is preventable.
    drainRateLimitedWarns();
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
