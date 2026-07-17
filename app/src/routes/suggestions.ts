// Conversation-fact-extraction review API (T8): the surface over the pending AI
// suggestions a contact accumulated (services/extraction/apply.ts writes them).
// requireAuth only (the /api mount supplies the gate), mounted in routes/api.ts.
//
//   GET  /api/contacts/:contactId/suggestions
//        -> 200 { suggestions }                            (empty array when none)
//   POST /api/contacts/:contactId/suggestions/:target/accept   (no body)
//        -> 200 { contact, suggestions }                   (updated contact + remaining)
//        -> 400 { error: 'accept_type_via_triage' }        (type is triaged, not accepted here)
//        -> 404 unknown contact or no pending suggestion for target
//        -> 409 { error: 'phone_in_use' }                  (phone target conflict)
//   POST /api/contacts/:contactId/suggestions/:target/dismiss  (no body)
//        -> 200 { suggestions }
//        -> 404 unknown contact / no pending suggestion for target
//
// Accept semantics per target (all audited, all emit suggestion.updated):
//   - the eight ExtractableField values: coerce like apply.ts (voucherSize int,
//     porting boolean), write the value + `<field>_source` provenance carrying
//     `accepted_by`, audit `ai_suggestion_accepted`, delete the suggestion.
//   - 'status': route through the ONE status-transition service
//     (setTenantStatus, source 'ai'); a stale suggestion is still attempted and
//     the service governs validity (a refusal surfaces 409 and KEEPS it).
//   - 'phone': mirror POST /:contactId/phones (E.164 normalize + 409 conflict +
//     addPhone + contact_phone_added audit + number_added milestone).
//   - 'type': 400 accept_type_via_triage (the dashboard triages via PATCH {type}).
//
// PII (doc SS9): responses carry full contacts to the authed client; LOG LINES
// are ids/targets/counts only.
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { appEvents, type EventBus } from '../lib/events.js';
import {
  contactPhones,
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  type PlacementDeadlinesRepo,
} from '../repos/placementDeadlinesRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createStatusTransitionService,
  EntityNotFoundError,
  TransitionRefusedError,
  type StatusTransitionDeps,
  type StatusTransitionService,
} from '../services/statusTransition.js';
import { EXTRACTABLE_FIELDS } from '../services/extraction/schema.js';
import type { ExtractableField } from '../adapters/extraction.js';
import type { TenantStatus } from '../lib/statusModel.js';

export interface SuggestionsRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  extractionRepo?: ExtractionRepo;
  auditRepo?: AuditRepo;
  activityEventsRepo?: ActivityEventsRepo;
  events?: EventBus;
  /** Repos the status-transition service is built from (accept 'status'). */
  placementsRepo?: PlacementsRepo;
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  unitsRepo?: UnitsRepo;
  armStageNudge?: StatusTransitionDeps['armStageNudge'];
  closeRelayForLostPlacement?: StatusTransitionDeps['closeRelayForLostPlacement'];
  /** Test seam: inject the assembled status-transition service directly. */
  statusService?: StatusTransitionService;
}

const EXTRACTABLE = new Set<string>(EXTRACTABLE_FIELDS);

type Coerced = { ok: true; value: unknown } | { ok: false };

/** Coerce a suggestion's string value per field (mirrors apply.ts coerceField). */
function coerceAccept(field: ExtractableField, raw: string): Coerced {
  const t = raw.trim();
  if (field === 'voucherSize') {
    if (!/^\d+$/.test(t)) return { ok: false };
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 12) return { ok: false };
    return { ok: true, value: n };
  }
  if (field === 'porting') {
    if (t === 'true') return { ok: true, value: true };
    if (t === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  if (t.length === 0) return { ok: false };
  return { ok: true, value: t };
}

/** Serialize a contact for the wire with its phones[] (mirror the contacts route). */
function serializeContact(contact: ContactItem): ContactItem & { phones: ReturnType<typeof contactPhones> } {
  return { ...contact, phones: contactPhones(contact) };
}

export function createSuggestionsRouter(deps: SuggestionsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const statusService =
    deps.statusService ??
    createStatusTransitionService({
      placementsRepo: placements,
      placementDeadlinesRepo: placementDeadlines,
      unitsRepo: units,
      contactsRepo: contacts,
      auditRepo: audit,
      activityEventsRepo: activityEvents,
      events,
      ...(deps.logger !== undefined && { logger: deps.logger }),
      ...(deps.armStageNudge !== undefined && { armStageNudge: deps.armStageNudge }),
      ...(deps.closeRelayForLostPlacement !== undefined && {
        closeRelayForLostPlacement: deps.closeRelayForLostPlacement,
      }),
    });

  const router = Router();

  // GET /api/contacts/:contactId/suggestions
  router.get('/contacts/:contactId/suggestions', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const suggestions = await extraction.listSuggestionsByContact(contactId);
    res.json({ suggestions });
  });

  // POST /api/contacts/:contactId/suggestions/:target/accept
  router.post('/contacts/:contactId/suggestions/:target/accept', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    const target = String(req.params['target'] ?? '');
    mergeContext({ contactId });
    const actor = req.user?.userId;

    // `type` is triaged via PATCH { type }, never accepted here.
    if (target === 'type') {
      res.status(400).json({ error: 'accept_type_via_triage' });
      return;
    }

    const suggestion = await extraction.getSuggestion(contactId, target);
    if (!suggestion) {
      res.status(404).json({ error: 'no_pending_suggestion' });
      return;
    }
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    const now = new Date().toISOString();

    // --- 'status' -> the ONE transition service (source 'ai') -----------------
    if (target === 'status') {
      try {
        const updated = await statusService.setTenantStatus(contactId, {
          toStatus: suggestion.suggestedValue as TenantStatus,
          source: 'ai',
          ...(actor !== undefined && { actor }),
        });
        await extraction.deleteSuggestion(contactId, 'status');
        events.emit('suggestion.updated', { contactId });
        const remaining = await extraction.listSuggestionsByContact(contactId);
        log.info({ contactId, target, actor }, 'ai suggestion accepted (status)');
        res.json({ contact: serializeContact(updated), suggestions: remaining });
      } catch (err) {
        // Stale suggestion: the service/allowlist governs validity. Surface the
        // service error and KEEP the suggestion (never a silent delete on refuse).
        if (err instanceof EntityNotFoundError) {
          res.status(404).json({ error: `${err.entity}_not_found` });
          return;
        }
        if (err instanceof TransitionRefusedError) {
          res.status(409).json({ error: err.code });
          return;
        }
        throw err;
      }
      return;
    }

    // --- 'phone' -> mirror POST /:contactId/phones ---------------------------
    if (target === 'phone') {
      const normalized = normalizeToE164(suggestion.suggestedValue);
      if (normalized === undefined) {
        res.status(400).json({ error: 'phone is not a valid phone number' });
        return;
      }
      // Conflict guard (pointer-aware): a number owned by ANOTHER contact -> 409,
      // suggestion KEPT for the human to reconcile.
      const owner = await contacts.findByPhone(normalized);
      if (owner && owner.contactId !== contactId) {
        res.status(409).json({ error: 'phone_in_use' });
        return;
      }
      const alreadyAttached = owner?.contactId === contactId;
      const updated = await contacts.addPhone(contactId, { phone: normalized });
      await audit.append(`contacts#${contactId}`, 'contact_phone_added', {
        ...(actor !== undefined && { actor }),
        phone: normalized,
      });
      // A genuinely new number is a timeline milestone (best-effort - the phone is
      // already saved; a log hiccup must never fail the action).
      if (!alreadyAttached) {
        try {
          await activityEvents.record({ contactId, type: 'number_added', label: 'Number added' });
        } catch (err) {
          log.error({ err, contactId }, 'ai suggestion accept (phone): number_added milestone failed');
        }
      }
      await extraction.deleteSuggestion(contactId, 'phone');
      events.emit('suggestion.updated', { contactId });
      const remaining = await extraction.listSuggestionsByContact(contactId);
      log.info({ contactId, target, actor }, 'ai suggestion accepted (phone)');
      res.json({ contact: serializeContact(updated), suggestions: remaining });
      return;
    }

    // --- field targets (the eight ExtractableField values) -------------------
    if (EXTRACTABLE.has(target)) {
      const field = target as ExtractableField;
      const coerced = coerceAccept(field, suggestion.suggestedValue);
      if (!coerced.ok) {
        res.status(400).json({ error: 'invalid_suggestion_value' });
        return;
      }
      const from = contact[field];
      const patch: Record<string, unknown> = {
        [field]: coerced.value,
        [`${field}_source`]: {
          source: 'ai',
          at: now,
          conversationId: suggestion.conversationId,
          ...(suggestion.tsMsgId !== undefined && { tsMsgId: suggestion.tsMsgId }),
          ...(actor !== undefined && { accepted_by: actor }),
        },
      };
      const updated = await contacts.update(contactId, patch);
      await audit.append(`contacts#${contactId}`, 'ai_suggestion_accepted', {
        ...(actor !== undefined && { actor }),
        target,
        from,
        to: coerced.value,
      });
      await extraction.deleteSuggestion(contactId, target);
      events.emit('suggestion.updated', { contactId });
      const remaining = await extraction.listSuggestionsByContact(contactId);
      log.info({ contactId, target, actor }, 'ai suggestion accepted (field)');
      res.json({ contact: serializeContact(updated), suggestions: remaining });
      return;
    }

    res.status(400).json({ error: 'unknown_target' });
  });

  // POST /api/contacts/:contactId/suggestions/:target/dismiss
  router.post('/contacts/:contactId/suggestions/:target/dismiss', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    const target = String(req.params['target'] ?? '');
    mergeContext({ contactId });
    const actor = req.user?.userId;

    const suggestion = await extraction.getSuggestion(contactId, target);
    if (!suggestion) {
      res.status(404).json({ error: 'no_pending_suggestion' });
      return;
    }
    await audit.append(`contacts#${contactId}`, 'ai_suggestion_dismissed', {
      ...(actor !== undefined && { actor }),
      target,
    });
    await extraction.deleteSuggestion(contactId, target);
    events.emit('suggestion.updated', { contactId });
    const remaining = await extraction.listSuggestionsByContact(contactId);
    log.info({ contactId, target, actor }, 'ai suggestion dismissed');
    res.json({ suggestions: remaining });
  });

  return router;
}
