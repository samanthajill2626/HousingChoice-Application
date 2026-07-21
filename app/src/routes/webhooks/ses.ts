// email-channel B4: the DEV-GATED SES inbound webhook route. Local/e2e only -
// the fake-SES host POSTs an SNS-shaped receipt/event notification here (with
// x-origin-verify) instead of a real SES -> S3 -> SNS -> SQS delivery. In prod,
// inbound mail is SQS-only (the worker's second consumer); this route is NOT
// mounted (see the mount comment in webhooks/index.ts).
//
// PROD SAFETY (plan F15 + phaseA adjudication m6), belt AND braces:
//   1. Mount-time: webhooks/index.ts mounts this router ONLY when
//      config.sesApiBaseUrl is set - and A3's loadConfig THROWS at boot when
//      SES_API_BASE_URL is set under NODE_ENV=production, so a deployed stack can
//      never have sesApiBaseUrl set and thus never mounts the route.
//   2. Request-time (m6): this handler ADDITIONALLY refuses with 404 when
//      config.nodeEnv === 'production', so even a misconfigured mount cannot
//      accept inbound over HTTP in prod.
//
// AUTH: mounted under /webhooks, which sits BEHIND the origin-secret middleware
// (app.ts) - the fake's POST MUST carry x-origin-verify. This route does NOT
// exempt itself (only /health + /__dev/* are exempt).
//
// It shares ONE ingestion service + the SNS/SES parser with the worker consumer
// (services/inboundMailConsumer). A malformed SNS body -> 200 ignored (never a
// 5xx that would drive an SNS retry loop).
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../../lib/config.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { appEvents, type EventBus } from '../../lib/events.js';
import {
  createInboundMailRawStore,
  createMediaStore,
  type MediaStore,
} from '../../adapters/mediaStore.js';
import { createContactsRepo, type ContactsRepo } from '../../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../../repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../../repos/messagesRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../../repos/extractionRepo.js';
import {
  createUnmatchedEmailRepo,
  type UnmatchedEmailRepo,
} from '../../repos/unmatchedEmailRepo.js';
import { ingestInboundEmail, type InboundEmailNotice, type IngestResult } from '../../services/inboundEmail.js';
import { parseSnsSesNotification } from '../../services/sesNotifications.js';
import {
  createSemaphore,
} from '../../lib/semaphore.js';
import {
  runSnsSesNotification,
  defaultApplyEmailEvent,
  INBOUND_MAIL_INGEST_CONCURRENCY,
  type ApplyEmailEvent,
  type IngestInbound,
} from '../../services/inboundMailConsumer.js';

export interface SesWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  /**
   * Pre-bound ingestion seam - tests inject a spy. Default: the real
   * ingestInboundEmail over real deps (mirrors unmatchedEmail.ts). UNDEFINED
   * when INBOUND_MAIL_BUCKET is unset (the raw MIME is unreachable) -> inbound
   * notifications answer 503.
   */
  ingest?: IngestInbound;
  /** B5 wires this; defaults to a log-and-ack (services/inboundMailConsumer). */
  applyEmailEvent?: ApplyEmailEvent;
  // Injectable deps for the DEFAULT ingest construction (unused when `ingest` is
  // injected). These keys mirror TwilioWebhookDeps so the webhooks-router
  // intersection stays conflict-free.
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  extractionRepo?: ExtractionRepo;
  unmatchedEmailRepo?: UnmatchedEmailRepo;
  mediaStore?: MediaStore;
  events?: EventBus;
}

/** Build the default (real) ingestion call, or undefined when no raw store. */
function buildDefaultIngest(deps: SesWebhookDeps, config: AppConfig): IngestInbound | undefined {
  const rawStore = createInboundMailRawStore({ config });
  if (rawStore === undefined) return undefined;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const unmatchedStore = deps.unmatchedEmailRepo ?? createUnmatchedEmailRepo({ logger: deps.logger });
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const events = deps.events ?? appEvents;
  return (notice: InboundEmailNotice): Promise<IngestResult> =>
    ingestInboundEmail(notice, {
      config,
      ...(deps.logger !== undefined && { logger: deps.logger }),
      rawStore,
      unmatchedStore,
      conversations,
      messages,
      contacts,
      extraction,
      events,
      ...(mediaStore !== undefined && { mediaStore }),
    });
}

export function createSesWebhookRouter(deps: SesWebhookDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const logger = deps.logger ?? defaultLogger;
  const ingest = deps.ingest ?? buildDefaultIngest(deps, config);
  const applyEmailEvent = deps.applyEmailEvent ?? defaultApplyEmailEvent(logger);
  // One gate per router instance (per app process) - see inboundMailConsumer.
  const gate = createSemaphore(INBOUND_MAIL_INGEST_CONCURRENCY);

  const router = Router();

  // POST /webhooks/ses/inbound - the SNS-shaped receipt/event notification.
  router.post('/inbound', async (req, res) => {
    // m6 belt+braces: refuse at request time in production (the mount already
    // cannot happen there, since sesApiBaseUrl can't be set - defense in depth).
    if (config.nodeEnv === 'production') {
      res.status(404).json({ error: 'not implemented' });
      return;
    }
    const parsed = parseSnsSesNotification(req.body, logger);
    const result = await runSnsSesNotification(parsed, {
      ...(ingest !== undefined && { ingest }),
      applyEmailEvent,
      gate,
      logger,
    });
    if (result.outcome === 'unavailable') {
      // No inbound raw store configured - the stored raw MIME is unreachable.
      res.status(503).json({ error: 'email_ingest_unavailable' });
      return;
    }
    if (parsed.kind === 'inbound') {
      res.status(200).json({
        outcome: result.outcome,
        ...(result.conversationId !== undefined && { conversationId: result.conversationId }),
        ...(result.unmatchedId !== undefined && { unmatchedId: result.unmatchedId }),
      });
      return;
    }
    // Events + ignored: a bare ack (the SES/SNS delivery just needs a 2xx).
    res.status(200).json({ ok: true, outcome: result.outcome });
  });

  return router;
}
