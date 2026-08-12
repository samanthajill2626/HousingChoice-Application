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
const { maybeLoadDevRouter } = await import('./lib/devRoutes.js');
const { configureOutboundQueue, configureScheduler, dispatchJob } = await import('./jobs/jobs.js');
const { drainRateLimitedWarns } = await import('./lib/rateLimitedWarn.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();

// jobs.enqueue() needs a SchedulerAdapter for the LONG-HORIZON branch only
// (delays beyond the SQS DelaySeconds cap — dormant in Phase 1, where every
// delayed job is <= 240s and takes the SQS path below). In AWS, Terraform's
// jobs module (M1.2) wires SCHEDULER_TARGET_ARN (the SQS jobs queue ARN) +
// SCHEDULER_ROLE_ARN, and a long-horizon one-off EventBridge schedule would
// deliver its envelope as an SQS message the worker long-polls and dispatches.
// NODE_ENV=production without them never reaches this point — loadConfig()
// fails fast. Locally both are unset: the in-memory adapter accepts envelopes
// so a future long-horizon enqueue never throws, but nothing delivers them
// (deliverAll is test-only) — hence the WARN.
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
      'EventBridge scheduler adapter configured — used only for >12min long-horizon jobs (dormant in Phase 1); <=12min jobs go via SQS DelaySeconds',
    );
  });
} else {
  const { InMemorySchedulerAdapter } = await import('./adapters/scheduler.js');
  configureScheduler(new InMemorySchedulerAdapter());
  runWithContext(bootContext, () => {
    logger.warn(
      'SCHEDULER_TARGET_ARN/SCHEDULER_ROLE_ARN unset — using the in-memory scheduler for the long-horizon branch: enqueued long-horizon jobs are accepted but NOT delivered (local NODE_ENVs only; production fails fast at loadConfig instead)',
    );
  });
}

// The SQS job path (delay refactor): ALL jobs whose delay is within the SQS
// DelaySeconds cap (immediate + short backoff: retries, relay/broadcast
// continuations) go straight to the jobs queue with DelaySeconds — no
// EventBridge 60s floor, exact backoff. In AWS the app SendMessages to the
// queue the worker long-polls (the worker throttles + dispatches). Locally
// there is no queue, so the app runs jobs IN-PROCESS — immediate jobs dispatch
// now, delayed jobs fire after a real setTimeout — which means ALL job
// handlers + the shared A2P token bucket must live here too (the worker process
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
  const a2pBucket = sharedA2pBucket(config.a2pRateLimitPerSec);
  registerAllJobHandlers({ tokenBucket: a2pBucket });
  configureOutboundQueue(
    new InProcessOutboundQueueAdapter({
      dispatch: dispatchJob,
      tokenBucket: a2pBucket,
      // A swallowed deferred-dispatch failure logs through the app logger.
      logger,
      // LOCAL DEV: fire delayed jobs (backoff continuations) after a real
      // timeout so they actually run on a laptop. unref() so a pending backoff
      // never blocks process exit. Tests omit this seam (deterministic drain).
      scheduleTimer: (run, delaySeconds) => {
        setTimeout(run, delaySeconds * 1000).unref();
      },
    }),
  );
  runWithContext(bootContext, () => {
    logger.warn(
      'JOBS_QUEUE_URL unset — jobs run IN-PROCESS in the app (local dev only; production uses SQS to the worker)',
    );
  });
}

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
