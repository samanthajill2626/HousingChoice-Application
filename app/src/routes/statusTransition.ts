// Status-model transition routes (NO UI) — the API surface over the ONE
// transition service (services/statusTransition.ts). requireAuth only (matches
// the placements/units/contacts authz posture; the /api mount supplies the gate).
//
//   POST  /api/placements/:placementId/transition  { toStage, source, reason?, lostReason?, finalRent?, inspectionOutcome? } → { placement }
//   PATCH /api/contacts/:contactId/tenant-status { toStatus, source, reason?, porting? }        → { contact }
//   PATCH /api/units/:unitId/listing-status      { toStatus, source, reason? }                  → { unit }
//   GET   /api/placements/:placementId/history                                                  → { history }
//
// Inputs validated with the existing per-route allowlist style. The history
// read returns the entity's provenance trail (auditRepo.listByEntity).
//
// PII (doc §9): responses carry full docs to the authed client; LOG LINES are
// IDs/sources/counts only.
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  isInspectionOutcome,
  isListingStatus,
  isLostReasonCategory,
  isPlacementStage,
  isTransitionSource,
  statusAllowlistFor,
} from '../lib/statusModel.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import {
  createPlacementDeadlinesRepo,
  type PlacementDeadlinesRepo,
} from '../repos/placementDeadlinesRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createStatusTransitionService,
  EntityNotFoundError,
  TransitionRefusedError,
  type StatusTransitionDeps,
  type StatusTransitionService,
} from '../services/statusTransition.js';
import { appEvents, type EventBus } from '../lib/events.js';

export interface StatusTransitionRouterDeps {
  logger?: Logger;
  placementsRepo?: PlacementsRepo;
  /** First-class placement deadlines (placement-deadline-model). */
  placementDeadlinesRepo?: PlacementDeadlinesRepo;
  unitsRepo?: UnitsRepo;
  contactsRepo?: ContactsRepo;
  auditRepo?: AuditRepo;
  events?: EventBus;
  /**
   * Post-Tour & Application choke-point hooks (optional, best-effort). Forwarded
   * straight into the transition service so every stage/status write goes through
   * the ONE service WITH the nudge-arm + lost-relay-close side effects wired.
   */
  armStageNudge?: StatusTransitionDeps['armStageNudge'];
  closeRelayForLostPlacement?: StatusTransitionDeps['closeRelayForLostPlacement'];
  /** Test seam: inject the assembled service directly. */
  service?: StatusTransitionService;
}

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;

export function createStatusTransitionRouter(deps: StatusTransitionRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const placementDeadlines =
    deps.placementDeadlinesRepo ?? createPlacementDeadlinesRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const service =
    deps.service ??
    createStatusTransitionService({
      placementsRepo: placements,
      placementDeadlinesRepo: placementDeadlines,
      unitsRepo: units,
      contactsRepo: contacts,
      auditRepo: audit,
      events,
      ...(deps.logger !== undefined && { logger: deps.logger }),
      ...(deps.armStageNudge !== undefined && { armStageNudge: deps.armStageNudge }),
      ...(deps.closeRelayForLostPlacement !== undefined && {
        closeRelayForLostPlacement: deps.closeRelayForLostPlacement,
      }),
    });

  const router = Router();

  // POST /api/placements/:placementId/transition
  router.post('/placements/:placementId/transition', async (req: AuthedRequest, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (!isPlacementStage(b['toStage'])) {
      res.status(400).json({ error: 'toStage must be a known placement stage' });
      return;
    }
    if (!isTransitionSource(b['source'])) {
      res.status(400).json({ error: 'source must be a known transition source' });
      return;
    }
    if (b['reason'] !== undefined && typeof b['reason'] !== 'string') {
      res.status(400).json({ error: 'reason must be a string' });
      return;
    }
    // lostReason: optional { category?, text? }. A supplied category must be in
    // the enum; text must be a string. Reject anything else (never a silent drop).
    let lostReason: import('../lib/statusModel.js').LostReason | undefined;
    if (b['lostReason'] !== undefined) {
      const lr = b['lostReason'];
      if (typeof lr !== 'object' || lr === null || Array.isArray(lr)) {
        res.status(400).json({ error: 'lostReason must be an object { category?, text? }' });
        return;
      }
      const lrObj = lr as Record<string, unknown>;
      lostReason = {};
      if (lrObj['category'] !== undefined) {
        if (!isLostReasonCategory(lrObj['category'])) {
          res.status(400).json({ error: 'lostReason.category must be a known lost-reason category' });
          return;
        }
        lostReason.category = lrObj['category'];
      }
      if (lrObj['text'] !== undefined) {
        if (typeof lrObj['text'] !== 'string') {
          res.status(400).json({ error: 'lostReason.text must be a string' });
          return;
        }
        lostReason.text = lrObj['text'];
      }
    }
    // finalRent (when supplied) must be a finite number > 0 — a $0 accepted
    // contract rent is invalid for billing (§4 final_rent feeds billing).
    let finalRent: number | undefined;
    if (b['finalRent'] !== undefined) {
      if (typeof b['finalRent'] !== 'number' || !Number.isFinite(b['finalRent']) || b['finalRent'] <= 0) {
        res.status(400).json({ error: 'finalRent must be a finite number > 0' });
        return;
      }
      finalRent = b['finalRent'];
    }
    // inspectionOutcome (when supplied) must be a valid pass/fail (§4). The
    // service writes it only on the inspection-complete move (OUT of
    // awaiting_inspection); we validate the shape here regardless of stage.
    let inspectionOutcome: import('../lib/statusModel.js').InspectionOutcome | undefined;
    if (b['inspectionOutcome'] !== undefined) {
      if (!isInspectionOutcome(b['inspectionOutcome'])) {
        res.status(400).json({ error: 'inspectionOutcome must be pass or fail' });
        return;
      }
      inspectionOutcome = b['inspectionOutcome'];
    }

    // A `lost` move always captures a reason (§7 "pick OR write — always
    // available"): require at least a valid category OR non-empty free text.
    if (b['toStage'] === 'lost') {
      const hasCategory = lostReason?.category !== undefined;
      const hasText = typeof lostReason?.text === 'string' && lostReason.text.trim().length > 0;
      if (!hasCategory && !hasText) {
        res.status(400).json({ error: 'a lost move requires lostReason.category or non-empty lostReason.text' });
        return;
      }
    }

    try {
      const updated = await service.transitionPlacement(placementId, {
        toStage: b['toStage'],
        source: b['source'],
        ...(typeof b['reason'] === 'string' && { reason: b['reason'] }),
        ...(lostReason !== undefined && { lostReason }),
        ...(finalRent !== undefined && { finalRent }),
        ...(inspectionOutcome !== undefined && { inspectionOutcome }),
        ...(req.user?.userId !== undefined && { actor: req.user.userId }),
      });
      log.info({ placementId, toStage: b['toStage'], source: b['source'], actor: req.user?.userId }, 'placement transition via api');
      res.json({ placement: updated });
    } catch (err) {
      handleTransitionError(err, res);
    }
  });

  // GET /api/placements/:placementId/history — the placement's provenance trail.
  router.get('/placements/:placementId/history', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    mergeContext({ placementId });
    const rawLimit = req.query['limit'];
    let limit = DEFAULT_HISTORY_LIMIT;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_LIMIT) {
        res.status(400).json({ error: `limit must be an integer 1..${MAX_HISTORY_LIMIT}` });
        return;
      }
      limit = n;
    }
    const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;
    const history = await audit.listByEntity(`placements#${placementId}`, {
      limit,
      ...(before !== undefined && { before }),
    });
    res.json({ history });
  });

  // PATCH /api/contacts/:contactId/tenant-status
  router.patch('/contacts/:contactId/tenant-status', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (typeof b['toStatus'] !== 'string') {
      res.status(400).json({ error: 'toStatus must be a string' });
      return;
    }
    if (!isTransitionSource(b['source'])) {
      res.status(400).json({ error: 'source must be a known transition source' });
      return;
    }
    if (b['reason'] !== undefined && typeof b['reason'] !== 'string') {
      res.status(400).json({ error: 'reason must be a string' });
      return;
    }
    if (b['porting'] !== undefined && typeof b['porting'] !== 'boolean') {
      res.status(400).json({ error: 'porting must be a boolean' });
      return;
    }

    // TYPE-SCOPED status guard (docs/issues/landlord-lead-status-and-park.md):
    // this route handles ALL contact types, so validate `toStatus` against the
    // STORED contact's own allowlist — a tenant's §5 lifecycle, a landlord's lead
    // lifecycle (LANDLORD_STATUSES), else needs_review|active. Previously it only
    // checked isTenantStatus, so a landlord wrongly accepted tenant-only on_hold/
    // inactive and rejected `parked`. 404 an unknown contact (the setter would).
    const stored = await contacts.getById(contactId);
    if (!stored) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const allow = statusAllowlistFor(stored.type);
    if (!allow.includes(b['toStatus'])) {
      res.status(400).json({ error: `toStatus must be one of: ${allow.join(', ')}` });
      return;
    }

    try {
      const updated = await service.setTenantStatus(contactId, {
        toStatus: b['toStatus'] as import('../lib/statusModel.js').TenantStatus,
        source: b['source'],
        ...(typeof b['reason'] === 'string' && { reason: b['reason'] }),
        ...(typeof b['porting'] === 'boolean' && { porting: b['porting'] }),
        ...(req.user?.userId !== undefined && { actor: req.user.userId }),
      });
      log.info({ contactId, toStatus: b['toStatus'], source: b['source'], actor: req.user?.userId }, 'tenant-status set via api');
      res.json({ contact: updated });
    } catch (err) {
      handleTransitionError(err, res);
    }
  });

  // PATCH /api/units/:unitId/listing-status
  router.patch('/units/:unitId/listing-status', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (!isListingStatus(b['toStatus'])) {
      res.status(400).json({ error: 'toStatus must be a known listing status' });
      return;
    }
    if (!isTransitionSource(b['source'])) {
      res.status(400).json({ error: 'source must be a known transition source' });
      return;
    }
    if (b['reason'] !== undefined && typeof b['reason'] !== 'string') {
      res.status(400).json({ error: 'reason must be a string' });
      return;
    }

    try {
      const updated = await service.setListingStatus(unitId, {
        toStatus: b['toStatus'],
        source: b['source'],
        ...(typeof b['reason'] === 'string' && { reason: b['reason'] }),
        ...(req.user?.userId !== undefined && { actor: req.user.userId }),
      });
      log.info({ unitId, toStatus: b['toStatus'], source: b['source'], actor: req.user?.userId }, 'listing-status set via api');
      res.json({ unit: updated });
    } catch (err) {
      handleTransitionError(err, res);
    }
  });

  return router;
}

/** Map a transition error to its HTTP status (404 unknown, 400 refused, else rethrow). */
function handleTransitionError(err: unknown, res: import('express').Response): void {
  if (err instanceof EntityNotFoundError) {
    res.status(404).json({ error: `${err.entity}_not_found` });
    return;
  }
  if (err instanceof TransitionRefusedError) {
    // Business-rule refusals (bad stage / bad final_rent / bad inspection
    // outcome) → 400. (The 2026-06-19 product decision removed the RTA-in-hand
    // gate, so there is no longer a 409 `rta_gate` refusal.)
    res.status(400).json({ error: err.code });
    return;
  }
  throw err; // Express 5 forwards async throws to the error handler.
}
