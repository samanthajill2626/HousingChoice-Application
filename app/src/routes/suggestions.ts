// Durable review API for pending AI suggestions. Every accept/dismiss request
// carries the immutable suggestion identity and resolves through the same
// phase-fenced journal executor.
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { appEvents, type EventBus } from '../lib/events.js';
import {
  contactPhones,
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { createAiRunsRepo, type AiRunsRepo } from '../repos/aiRunsRepo.js';
import {
  createSuggestionResolutionRepo,
  type ResolutionAction,
  type SuggestionResolutionRepo,
} from '../repos/suggestionResolutionRepo.js';
import {
  createSuggestionResolutionService,
  SuggestionResolutionError,
  type SuggestionRequestIdentity,
  type SuggestionResolutionHooks,
  type SuggestionResolutionService,
} from '../services/suggestionResolution.js';
import type { StatusTransitionService } from '../services/statusTransition.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { PlacementsRepo } from '../repos/placementsRepo.js';
import type { PlacementDeadlinesRepo } from '../repos/placementDeadlinesRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';
import type { StatusTransitionDeps } from '../services/statusTransition.js';

export interface SuggestionsRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  extractionRepo?: ExtractionRepo;
  aiRunsRepo?: AiRunsRepo;
  suggestionResolutionRepo?: SuggestionResolutionRepo;
  suggestionResolutionService?: SuggestionResolutionService;
  suggestionResolutionHooks?: SuggestionResolutionHooks;
  resolutionNow?: () => string;
  resolutionLeaseId?: () => string;
  resolutionLeaseMs?: number;
  events?: EventBus;
  // Retained compatibility seams for callers that assemble all route deps.
  auditRepo?: AuditRepo;
  activityEventsRepo?: ActivityEventsRepo;
  placementsRepo?: PlacementsRepo;
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  unitsRepo?: UnitsRepo;
  armStageNudge?: StatusTransitionDeps['armStageNudge'];
  conversationsRepo?: StatusTransitionDeps['conversationsRepo'];
  statusService?: StatusTransitionService;
}

function serializeContact(contact: ContactItem): ContactItem & { phones: ReturnType<typeof contactPhones> } {
  return { ...contact, phones: contactPhones(contact) };
}

function parseIdentity(body: unknown): SuggestionRequestIdentity | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value['createdAt'] !== 'string' || value['createdAt'].length === 0) return undefined;
  if (value['revision'] !== undefined && typeof value['revision'] !== 'string') return undefined;
  if (value['runId'] !== undefined && typeof value['runId'] !== 'string') return undefined;
  return {
    createdAt: value['createdAt'],
    ...(value['revision'] !== undefined && { revision: value['revision'] as string }),
    ...(value['runId'] !== undefined && { runId: value['runId'] as string }),
  };
}

export function createSuggestionsRouter(deps: SuggestionsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const aiRuns = deps.aiRunsRepo ?? createAiRunsRepo({ logger: deps.logger });
  const resolutions = deps.suggestionResolutionRepo
    ?? createSuggestionResolutionRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const service = deps.suggestionResolutionService ?? createSuggestionResolutionService({
    contactsRepo: contacts,
    extractionRepo: extraction,
    aiRunsRepo: aiRuns,
    resolutionRepo: resolutions,
    logger: log,
    ...(deps.resolutionNow !== undefined && { now: deps.resolutionNow }),
    ...(deps.resolutionLeaseId !== undefined && { leaseId: deps.resolutionLeaseId }),
    ...(deps.resolutionLeaseMs !== undefined && { leaseMs: deps.resolutionLeaseMs }),
    ...(deps.suggestionResolutionHooks !== undefined && { hooks: deps.suggestionResolutionHooks }),
  });
  const router = Router();

  router.get('/contacts/:contactId/suggestions', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    // F1: a crash between claim and commit removed the suggestion card, so this
    // ordinary read is the recovery surface - it helps any expired journal of
    // this contact to completion before listing. Strictly best-effort: recovery
    // must never fail or delay-fail the read the dashboard depends on.
    try {
      const recovery = await service.recoverAbandoned(contactId);
      if (recovery.domainCommitted) events.emit('suggestion.updated', { contactId });
    } catch (err) {
      log.warn({ err, contactId }, 'abandoned suggestion resolution recovery failed (best-effort)');
    }
    res.json({ suggestions: await extraction.listSuggestionsByContact(contactId) });
  });

  async function resolve(
    req: AuthedRequest,
    res: import('express').Response,
    action: ResolutionAction,
  ): Promise<void> {
    const contactId = String(req.params['contactId'] ?? '');
    const target = String(req.params['target'] ?? '');
    mergeContext({ contactId });
    const identity = parseIdentity(req.body);
    if (identity === undefined) {
      res.status(400).json({ error: 'invalid_suggestion_identity' });
      return;
    }
    try {
      const outcome = await service.resolve({
        contactId,
        target,
        action,
        identity,
        ...(req.user?.userId !== undefined && { actorId: req.user.userId }),
      });
      const suggestions = await extraction.listSuggestionsByContact(contactId);
      // A helped journal commits a domain effect for somebody else's suggestion,
      // so it needs the same SSE as this request's own completion (adv P3-25).
      if (outcome.completedNow || outcome.helpedCommitted) {
        events.emit('suggestion.updated', { contactId });
      }
      log.info(
        { contactId, target, action, actor: req.user?.userId, replay: !outcome.completedNow },
        'ai suggestion resolution completed',
      );
      if (action === 'accept') {
        const contact = await contacts.getById(contactId);
        if (!contact) {
          res.status(404).json({ error: 'contact_not_found' });
          return;
        }
        res.json({ contact: serializeContact(contact), suggestions });
      } else {
        res.json({ suggestions });
      }
    } catch (error) {
      if (error instanceof SuggestionResolutionError) {
        // The request failed on its OWN identity, but a journal it helped along
        // the way did commit - the contact and the pending list really changed.
        if (error.helpedCommitted) events.emit('suggestion.updated', { contactId });
        res.status(error.status).json({
          error: error.code,
          ...(error.retryable && { retryable: true }),
        });
        return;
      }
      throw error;
    }
  }

  router.post('/contacts/:contactId/suggestions/:target/accept', async (req: AuthedRequest, res) => {
    await resolve(req, res, 'accept');
  });

  router.post('/contacts/:contactId/suggestions/:target/dismiss', async (req: AuthedRequest, res) => {
    await resolve(req, res, 'dismiss');
  });

  return router;
}
