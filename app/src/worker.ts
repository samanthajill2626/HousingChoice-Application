// worker process entrypoint: job handlers + the SQS jobs consumer (M1.2).
//
// OTel must be loaded/started FIRST, so everything below the startOtel()
// call uses dynamic imports.
//
// Delivery path in AWS (delay refactor): app jobs.enqueue() ->
//   - <=12min delay: SQS SendMessage with DelaySeconds straight to the jobs
//     queue (immediate + short backoff — the Phase-1 path); or
//   - >12min delay: EventBridge Scheduler one-off schedule
//     (ActionAfterCompletion DELETE) that delivers to the SAME jobs queue
//     (long-horizon; dormant in Phase 1)
// -> SQS jobs queue -> the long-poll loop below -> dispatchJob() (envelope
// gate: validates, mints jobRunId, rehydrates correlation context) ->
// registered handler. The worker polls the same queue regardless of producer.
import type { SqsJobConsumer } from './adapters/sqsJobConsumer.js';
import { startOtel } from './lib/otel.js';

await startOtel();

const { installProcessErrorHandlers } = await import('./lib/errors.js');
const { logger } = await import('./lib/logger.js');
const { loadConfig } = await import('./lib/config.js');
const { newBootId, runWithContext } = await import('./lib/context.js');
const { dispatchJob, registeredJobNames } = await import('./jobs/jobs.js');
const { registerAllJobHandlers } = await import('./jobs/registerHandlers.js');
const { TokenBucket } = await import('./lib/tokenBucket.js');

// Process-lifecycle correlation: boot/shutdown log lines carry this bootId as
// their correlationId so container starts never trip the orphan-log alarm.
const bootContext = { bootId: newBootId() };

installProcessErrorHandlers(logger, bootContext);

const config = loadConfig();

// Cross-process event bridge (lib/eventBridge.ts): forward EVERY emit on this
// worker's in-process bus to the app process, whose SSE clients are the ones
// that matter. Attached ONLY here - the app never forwards (no echo path).
// Unset EVENT_BRIDGE_URL (bare local runs) -> emits stay in-process, exactly
// the pre-bridge behavior.
if (config.eventBridgeUrl) {
  const { attachEventBridge, deriveBridgeToken } = await import('./lib/eventBridge.js');
  const { appEvents } = await import('./lib/events.js');
  attachEventBridge(appEvents, {
    targetUrl: config.eventBridgeUrl,
    bridgeToken: deriveBridgeToken(config.sessionSecret),
    originSecret: config.cfOriginSecret,
    logger,
  });
  runWithContext(bootContext, () => {
    // Operational, non-secret (the URL names a container/port, never a token).
    logger.info(
      { target: config.eventBridgeUrl },
      'event bridge attached - worker emits forward to the app process',
    );
  });
}

// The shared A2P token bucket — ONE instance, sized from config
// (a2pRateLimitPerSec, default ~1 msg/sec), shared across relay fan-out +
// broadcast + missed-call auto-text so the COMBINED outbound rate stays under
// the registered tier. BURST vs SUSTAINED (FIX 6): capacity == the per-second
// rate (the EXACT value, not ceil — at a fractional rate like 0.5/s, ceil would
// let a 1-token burst exceed the tier), floored at 1 so a sub-1/s rate can still
// admit a single message. The bucket starts full, so the first burst is up to
// `capacity` messages immediately; thereafter sends are paced at `refillPerSec`
// tokens/sec (the sustained A2P rate).
const a2pBucket = new TokenBucket({
  capacity: Math.max(1, config.a2pRateLimitPerSec),
  refillPerSec: config.a2pRateLimitPerSec,
});

// Register EVERY job handler (retrySend, relay fan-out + intro, broadcast,
// missed-call auto-text) through the single shared registry — the worker
// dispatches them off the SQS consumer below; the app's local in-process path
// (index.ts) calls the SAME function, so the two processes can never drift.
registerAllJobHandlers({ tokenBucket: a2pBucket });

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

// Inbound-email delivery (email-channel B4): a SECOND SqsJobConsumer on the
// dedicated inbound-mail queue. In AWS the SES receipt rule writes raw MIME to S3
// and fans an SNS notification into INBOUND_MAIL_QUEUE_URL; this consumer's
// dispatch parses the SNS/SES envelope and hands inbound receipts to the
// channel-agnostic ingestion service (semaphore(2)-gated inside the dispatch).
//
// The SNS envelope is NEVER routed through dispatchJob: it carries no jobName, so
// dispatchJob would reject it as a MalformedJobEnvelope and the SqsJobConsumer
// would DELETE it as poison - silently dropping inbound mail. Hence this
// dedicated dispatch. Skipped ENTIRELY when INBOUND_MAIL_QUEUE_URL is unset
// (ADJ-11: no local SQS - local/e2e inbound arrives via the fake-SES POST to the
// dev webhook route instead).
let inboundMailConsumer: SqsJobConsumer | undefined;
if (config.inboundMailQueueUrl) {
  const { createInboundMailRawStore, createMediaStore } = await import('./adapters/mediaStore.js');
  const rawStore = createInboundMailRawStore({ config });
  if (rawStore === undefined) {
    runWithContext(bootContext, () =>
      logger.warn(
        'INBOUND_MAIL_QUEUE_URL is set but INBOUND_MAIL_BUCKET is not - inbound-mail consumer NOT started (the raw MIME would be unreachable)',
      ),
    );
  } else {
    const { createConversationsRepo } = await import('./repos/conversationsRepo.js');
    const { createMessagesRepo } = await import('./repos/messagesRepo.js');
    const { createContactsRepo } = await import('./repos/contactsRepo.js');
    const { createExtractionRepo } = await import('./repos/extractionRepo.js');
    const { createUnmatchedEmailRepo } = await import('./repos/unmatchedEmailRepo.js');
    const { createAuditRepo } = await import('./repos/auditRepo.js');
    const { appEvents } = await import('./lib/events.js');
    const { ingestInboundEmail } = await import('./services/inboundEmail.js');
    const { createInboundMailDispatch } = await import('./services/inboundMailConsumer.js');
    const { createApplyEmailEvent } = await import('./services/emailEvents.js');
    const { SQSClient } = await import('@aws-sdk/client-sqs');
    const { SqsJobConsumer } = await import('./adapters/sqsJobConsumer.js');

    const mediaStore = createMediaStore({ config });
    const conversations = createConversationsRepo({ logger });
    const messages = createMessagesRepo({ logger });
    const contacts = createContactsRepo({ logger });
    const ingestDeps = {
      config,
      logger,
      rawStore,
      unmatchedStore: createUnmatchedEmailRepo({ logger }),
      conversations,
      messages,
      contacts,
      extraction: createExtractionRepo({ logger }),
      events: appEvents,
      ...(mediaStore !== undefined && { mediaStore }),
    };
    // B5: bounce/complaint/delivery events -> delivery status + suppression (+ the
    // F12 orphan parking lot). Shares the consumer's repos so the SES-id alias and
    // the parking-lot writes see one table view.
    const applyEmailEvent = createApplyEmailEvent({
      conversationsRepo: conversations,
      messagesRepo: messages,
      contactsRepo: contacts,
      auditRepo: createAuditRepo({ logger }),
      logger,
    });
    inboundMailConsumer = new SqsJobConsumer({
      client: new SQSClient({ region: config.awsRegion }),
      queueUrl: config.inboundMailQueueUrl,
      dispatch: createInboundMailDispatch({
        ingest: (notice) => ingestInboundEmail(notice, ingestDeps),
        applyEmailEvent,
        logger,
      }),
      // Pull at most 2 per poll (adv Q3): ingest shares a semaphore(2) with a
      // 60s gate + 30s parse, so a default batch of 10 on a 120s visibility
      // timeout could see a queued message redeliver WHILE in-flight. Matching
      // the poll size to the concurrency closes that visibility-overrun window.
      maxMessagesPerPoll: 2,
      baseContext: bootContext,
      logger,
    });
    inboundMailConsumer.start();
    runWithContext(bootContext, () =>
      logger.info(
        { inboundMailQueueUrl: config.inboundMailQueueUrl },
        'inbound-mail consumer started - polling for SES receipt/event notifications',
      ),
    );
  }
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

// Tour-reminder poll: runs every 60s, stateless (state is the DynamoDB rows).
// Dynamic imports mirror the SQS consumer pattern above — DynamoDB client is
// created lazily (at first poll) so the worker boots fast and errors surface
// at poll time, not boot time. The setInterval is .unref()'d so it doesn't
// prevent process exit on shutdown.
{
  const { createTourRemindersRepo } = await import('./repos/tourRemindersRepo.js');
  const { createToursRepo } = await import('./repos/toursRepo.js');
  const { createContactsRepo } = await import('./repos/contactsRepo.js');
  const { createConversationsRepo } = await import('./repos/conversationsRepo.js');
  const { createMessagesRepo } = await import('./repos/messagesRepo.js');
  const { createSendMessageService } = await import('./services/sendMessage.js');
  const { createMessagingAdapter } = await import('./adapters/messaging.js');
  const { runDueTourReminders } = await import('./jobs/tourReminders.js');

  const tourReminderDeps = {
    tourRemindersRepo: createTourRemindersRepo({ logger }),
    toursRepo: createToursRepo({ logger }),
    contactsRepo: createContactsRepo({ logger }),
    conversationsRepo: createConversationsRepo({ logger }),
    // GROUP-route rungs persist a system announcement row in the relay thread
    // (sendRelayAnnouncement) — messagesRepo backs that persistence.
    messagesRepo: createMessagesRepo({ logger }),
    sendMessageService: createSendMessageService({ config, logger }),
    // GROUP-route reminders (landlord_led/pm_team with a group thread) send
    // directly per member from the pool number — same construction the relay
    // handlers use (createMessagingAdapter honors MESSAGING_RECORD_OUTBOX, so
    // hermetic-e2e group sends stay outbox-visible).
    adapter: createMessagingAdapter({ config, logger }),
    // Same shared A2P bucket every other worker send path meters through
    // (relay fan-out/intro, broadcast) — the COMBINED outbound rate must stay
    // under the registered tier; group reminder rungs are N member sends each.
    tokenBucket: a2pBucket,
    logger,
  };

  setInterval(() => {
    const now = new Date().toISOString();
    void runDueTourReminders(now, tourReminderDeps).catch((err: unknown) => {
      logger.error({ err }, 'tour reminder poll error');
    });
  }, config.workerPollIntervalMs).unref();
}

// Placement application-nudge poll: same stateless 60s cadence as the
// tour-reminder poll above (state is the DynamoDB placementNudges rows). Deps
// are built once, lazily imported like the tour block; the 1:1 nudge send goes
// through sendMessageService only (no messaging adapter — landlord/tenant rungs
// route to a 1:1 conversation, never a group fan-out). .unref()'d so it never
// holds the process open on shutdown.
{
  const { createPlacementNudgesRepo } = await import('./repos/placementNudgesRepo.js');
  const { createPlacementsRepo } = await import('./repos/placementsRepo.js');
  const { createContactsRepo } = await import('./repos/contactsRepo.js');
  const { createUnitsRepo } = await import('./repos/unitsRepo.js');
  const { createConversationsRepo } = await import('./repos/conversationsRepo.js');
  const { createSendMessageService } = await import('./services/sendMessage.js');
  const { appEvents } = await import('./lib/events.js');
  const { runDuePlacementNudges } = await import('./jobs/placementNudges.js');

  const placementNudgeDeps = {
    placementNudgesRepo: createPlacementNudgesRepo({ logger }),
    placementsRepo: createPlacementsRepo({ logger }),
    contactsRepo: createContactsRepo({ logger }),
    unitsRepo: createUnitsRepo({ logger }),
    conversationsRepo: createConversationsRepo({ logger }),
    sendMessageService: createSendMessageService({ config, logger }),
    // The bridge (lib/eventBridge.ts) forwards these claim-skip pokes to app
    // SSE clients when EVENT_BRIDGE_URL is set; an unbridged emit is a no-op.
    events: appEvents,
    logger,
  };

  setInterval(() => {
    const now = new Date().toISOString();
    void runDuePlacementNudges(now, placementNudgeDeps).catch((err: unknown) => {
      logger.error({ err }, 'placement nudge poll error');
    });
  }, config.workerPollIntervalMs).unref();
}

// Conversation-fact-extraction poll: same stateless 60s cadence (state is the
// DynamoDB ai_extraction rows). Gated on config.aiExtractionEnabled - dormant
// when the feature flag is off (default in deployed envs). Deps built once,
// lazily imported like the polls above; the driver is selected from config
// (anthropic in prod / console in dev / fake in e2e). .unref()'d so it never
// holds the process open on shutdown.
//
// Cross-process bridge (lib/eventBridge.ts): apply.ts's `suggestion.updated`
// emit lands on THIS worker's bus and - when EVENT_BRIDGE_URL is set (all
// deployed envs + local runners) - forwards to the app process's SSE clients.
// Bare unset-URL runs keep the old visible-on-next-fetch behavior.
if (config.aiExtractionEnabled) {
  const { createExtractionRepo } = await import('./repos/extractionRepo.js');
  const { createConversationsRepo } = await import('./repos/conversationsRepo.js');
  const { createMessagesRepo } = await import('./repos/messagesRepo.js');
  const { createContactsRepo } = await import('./repos/contactsRepo.js');
  const { createAuditRepo } = await import('./repos/auditRepo.js');
  const { createExtractionDriver } = await import('./adapters/extraction.js');
  const { appEvents } = await import('./lib/events.js');
  const { runDueExtractions } = await import('./jobs/extraction.js');

  const extractionRepo = createExtractionRepo({ logger });
  const contactsRepo = createContactsRepo({ logger });
  const extractionDeps = {
    repo: extractionRepo,
    conversations: createConversationsRepo({ logger }),
    messages: createMessagesRepo({ logger }),
    contacts: contactsRepo,
    driver: createExtractionDriver({
      driver: config.extractionDriver,
      model: config.aiExtractionModel,
      ...(config.anthropicApiKey !== undefined && { apiKey: config.anthropicApiKey }),
      ...(config.anthropicApiBaseUrl !== undefined && { apiBaseUrl: config.anthropicApiBaseUrl }),
    }),
    applyDeps: {
      contacts: contactsRepo,
      extraction: extractionRepo,
      audit: createAuditRepo({ logger }),
      events: appEvents,
      logger,
      now: () => new Date().toISOString(),
    },
    config,
    logger,
  };

  setInterval(() => {
    const now = new Date().toISOString();
    void runDueExtractions(now, extractionDeps).catch((err: unknown) => {
      logger.error({ err }, 'extraction poll error');
    });
  }, config.workerPollIntervalMs).unref();
}

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
      // Drain BOTH consumers (jobs + inbound-mail) concurrently.
      await Promise.all([consumer?.stop(), inboundMailConsumer?.stop()]);
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
