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
//   - 'address': write the item's cleaned parts as the contact `address` object
//     + `address_source` provenance carrying `accepted_by`, audit
//     `ai_suggestion_accepted` (FORMATTED from/to strings), delete the
//     suggestion; 400 invalid_suggestion_value when the item carries no parts.
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
import {
  createExtractionRepo,
  type ExtractionRepo,
  type SuggestionItem,
} from '../repos/extractionRepo.js';
import { createAiRunsRepo, type AiRunsRepo } from '../repos/aiRunsRepo.js';
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
  StatusTransitionCommittedError,
  TransitionRefusedError,
  type StatusTransitionDeps,
  type StatusTransitionService,
} from '../services/statusTransition.js';
import { EXTRACTABLE_FIELDS, normalizeSuggestionValue } from '../services/extraction/schema.js';
import {
  cleanAddressParts,
  contactAddressToParts,
  formatAddressParts,
} from '../services/extraction/address.js';
import type { ExtractableField } from '../adapters/extraction.js';
import type { TenantStatus } from '../lib/statusModel.js';
import { isDecisionTarget } from '../services/extraction/runTypes.js';

export interface SuggestionsRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  extractionRepo?: ExtractionRepo;
  aiRunsRepo?: AiRunsRepo;
  auditRepo?: AuditRepo;
  activityEventsRepo?: ActivityEventsRepo;
  events?: EventBus;
  /** Repos the status-transition service is built from (accept 'status'). */
  placementsRepo?: PlacementsRepo;
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  unitsRepo?: UnitsRepo;
  armStageNudge?: StatusTransitionDeps['armStageNudge'];
  /** D5 close-nag arm on terminal placements (relay-number-lifecycle seam). */
  conversationsRepo?: StatusTransitionDeps['conversationsRepo'];
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

/** Stamp a resolved suggestion verdict without changing the human action outcome. */
async function stampVerdict(
  aiRuns: AiRunsRepo,
  log: Logger,
  suggestion: SuggestionItem,
  verdict: 'accepted' | 'dismissed',
  at: string,
  actor: string | undefined,
): Promise<void> {
  if (suggestion.runId === undefined || !isDecisionTarget(suggestion.target)) return;
  try {
    await aiRuns.setVerdict(suggestion.runId, suggestion.target, verdict, {
      at, expectedVerdict: 'pending', freshSuggestionCreatedAt: suggestion.createdAt,
      ...(actor !== undefined && { by: actor }),
    });
  } catch (err) {
    log.warn(
      { contactId: suggestion.ownerContactId, target: suggestion.target, err },
      'ai run verdict stamp failed (best-effort)',
    );
  }
}

async function claimSuggestion(extraction: ExtractionRepo, suggestion: SuggestionItem): Promise<boolean> {
  return extraction.deleteSuggestionIfCurrent(suggestion.ownerContactId, suggestion.target, suggestion.createdAt, suggestion.runId, suggestion.revision);
}

async function restoreClaim(extraction: ExtractionRepo, log: Logger, suggestion: SuggestionItem): Promise<void> {
  try {
    await extraction.restoreSuggestionIfAbsent(suggestion);
  } catch (err) {
    log.warn({ contactId: suggestion.ownerContactId, target: suggestion.target, err }, 'suggestion restore failed (best-effort)');
  }
}

export function createSuggestionsRouter(deps: SuggestionsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const extraction = deps.extractionRepo ?? createExtractionRepo({ logger: deps.logger });
  const aiRuns = deps.aiRunsRepo ?? createAiRunsRepo({ logger: deps.logger });
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
      ...(deps.conversationsRepo !== undefined && { conversationsRepo: deps.conversationsRepo }),
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
      if (!await claimSuggestion(extraction, suggestion)) {
        res.status(409).json({ error: 'suggestion_replaced' });
        return;
      }
      let transitioned = false;
      try {
        const updated = await statusService.setTenantStatus(contactId, {
          toStatus: suggestion.suggestedValue as TenantStatus,
          source: 'ai',
          ...(actor !== undefined && { actor }),
        });
        transitioned = true;
        await stampVerdict(aiRuns, log, suggestion, 'accepted', now, actor);
        events.emit('suggestion.updated', { contactId });
        const remaining = await extraction.listSuggestionsByContact(contactId);
        log.info({ contactId, target, actor }, 'ai suggestion accepted (status)');
        res.json({ contact: serializeContact(updated), suggestions: remaining });
      } catch (err) {
        // Stale suggestion: the service/allowlist governs validity. Surface the
        // service error and KEEP the suggestion (never a silent delete on refuse).
        if (err instanceof EntityNotFoundError) {
          await restoreClaim(extraction, log, suggestion);
          res.status(404).json({ error: `${err.entity}_not_found` });
          return;
        }
        if (err instanceof TransitionRefusedError) {
          await restoreClaim(extraction, log, suggestion);
          res.status(409).json({ error: err.code });
          return;
        }
        if (err instanceof StatusTransitionCommittedError) {
          await stampVerdict(aiRuns, log, suggestion, 'accepted', now, actor);
          throw err;
        }
        if (!transitioned) {
          try {
            const current = await contacts.getById(contactId, { consistentRead: true });
            if (current?.status === suggestion.suggestedValue) {
              await stampVerdict(aiRuns, log, suggestion, 'accepted', now, actor);
            } else {
              await restoreClaim(extraction, log, suggestion);
            }
          } catch {
            log.warn({ target }, 'status recovery read failed; restoring claimed ai suggestion');
            await restoreClaim(extraction, log, suggestion);
          }
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
      if (!await claimSuggestion(extraction, suggestion)) {
        res.status(409).json({ error: 'suggestion_replaced' });
        return;
      }
      let updated: ContactItem;
      try {
        updated = await contacts.addPhone(contactId, { phone: normalized });
      } catch (err) {
        await restoreClaim(extraction, log, suggestion);
        throw err;
      }
      await stampVerdict(aiRuns, log, suggestion, 'accepted', now, actor);
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
      events.emit('suggestion.updated', { contactId });
      const remaining = await extraction.listSuggestionsByContact(contactId);
      log.info({ contactId, target, actor }, 'ai suggestion accepted (phone)');
      res.json({ contact: serializeContact(updated), suggestions: remaining });
      return;
    }

    // --- 'address' -> compound parts write (spec 2026-07-20 SS6) -------------
    if (target === 'address') {
      const parts = cleanAddressParts(suggestion.suggestedAddress);
      const formatted = formatAddressParts(parts);
      if (formatted.length === 0) {
        // A malformed/legacy item (no usable parts) must never half-write an address.
        res.status(400).json({ error: 'invalid_suggestion_value' });
        return;
      }
      const from = formatAddressParts(contactAddressToParts(contact['address']));
      const patch: Record<string, unknown> = {
        address: parts,
        address_source: {
          source: 'ai',
          at: now,
          conversationId: suggestion.conversationId,
          ...(suggestion.tsMsgId !== undefined && { tsMsgId: suggestion.tsMsgId }),
          ...(actor !== undefined && { accepted_by: actor }),
        },
      };
      if (!await claimSuggestion(extraction, suggestion)) {
        res.status(409).json({ error: 'suggestion_replaced' });
        return;
      }
      let updated: ContactItem;
      try {
        updated = await contacts.update(contactId, patch);
      } catch (err) {
        await restoreClaim(extraction, log, suggestion);
        throw err;
      }
      await stampVerdict(aiRuns, log, suggestion, 'accepted', now, actor);
      await audit.append(`contacts#${contactId}`, 'ai_suggestion_accepted', {
        ...(actor !== undefined && { actor }),
        target,
        ...(from.length > 0 && { from }),
        to: formatted,
      });
      events.emit('suggestion.updated', { contactId });
      const remaining = await extraction.listSuggestionsByContact(contactId);
      log.info({ contactId, target, actor }, 'ai suggestion accepted (address)');
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
      if (!await claimSuggestion(extraction, suggestion)) {
        res.status(409).json({ error: 'suggestion_replaced' });
        return;
      }
      let updated: ContactItem;
      try {
        updated = await contacts.update(contactId, patch);
      } catch (err) {
        await restoreClaim(extraction, log, suggestion);
        throw err;
      }
      await stampVerdict(aiRuns, log, suggestion, 'accepted', now, actor);
      await audit.append(`contacts#${contactId}`, 'ai_suggestion_accepted', {
        ...(actor !== undefined && { actor }),
        target,
        from,
        to: coerced.value,
      });
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
    const now = new Date().toISOString();

    const suggestion = await extraction.getSuggestion(contactId, target);
    if (!suggestion) {
      res.status(404).json({ error: 'no_pending_suggestion' });
      return;
    }
    if (!await claimSuggestion(extraction, suggestion)) {
      res.status(409).json({ error: 'suggestion_replaced' });
      return;
    }
    try {
      await audit.append(`contacts#${contactId}`, 'ai_suggestion_dismissed', {
        ...(actor !== undefined && { actor }),
        target,
      });
    // Tombstone the rejected value PERMANENTLY (ruling 2026-07-21): the same
    // normalized value is never re-suggested for this target; a different
    // value still comes through. A human field edit does NOT clear it.
      await extraction.putDismissal(
        contactId,
        target,
        normalizeSuggestionValue(target, suggestion.suggestedValue),
      );
    } catch (err) {
      await restoreClaim(extraction, log, suggestion);
      throw err;
    }
    await stampVerdict(aiRuns, log, suggestion, 'dismissed', now, actor);
    events.emit('suggestion.updated', { contactId });
    const remaining = await extraction.listSuggestionsByContact(contactId);
    log.info({ contactId, target, actor }, 'ai suggestion dismissed');
    res.json({ suggestions: remaining });
  });

  return router;
}
