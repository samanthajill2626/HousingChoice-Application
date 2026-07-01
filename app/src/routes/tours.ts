// Tours router — first-class Tour entity (Tours feature).
// Mounted under /api/tours, behind requireAuth via the /api mount (app.ts).
// VAs schedule and manage tours, so NO admin gate (same posture as contacts).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt, tourType }  → 201 { tour }
//   GET   /api/tours/:tourId                                         → { tour } | 404
//   GET   /api/tours?tenantId=&unitId=&from=&to=                     → { tours }
//   PATCH /api/tours/:tourId  { scheduledAt?, status?, outcome?, moveForward? }
//                                                                    → { tour } | 404
//
// PATCH supports:
//   - Reschedule: { scheduledAt } — allowed only when canReschedule(current status)
//     or when the status field brings the tour to 'scheduled'.
//   - Status change: { status } — allowlisted via isTourStatus; illegal transitions
//     (e.g. closed → scheduled) are rejected 409.
//   - Exit gate: { outcome, moveForward } — records the navigator decision; sets
//     convertible:true when moveForward is true. Does NOT create a placement or
//     touch tenant status (conversion is a downstream feature).
//
// Validation is a strict field allowlist (unknown fields → 400). Mirror of
// units.ts idioms: error shapes, 404 codes, createXRouter(deps) factory.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  canReschedule,
  isTourOutcome,
  isTourStatus,
  TOUR_STATUSES,
  TOUR_OUTCOMES,
  type TourOutcome,
  type TourStatus,
} from '../lib/toursModel.js';
import {
  createToursRepo,
  type TourItem,
  type ToursRepo,
  type TourType,
} from '../repos/toursRepo.js';

/** The three valid tour types. */
const TOUR_TYPES: readonly TourType[] = ['self_guided', 'landlord_led', 'pm_team'];
const TOUR_TYPE_SET: ReadonlySet<string> = new Set(TOUR_TYPES);

function isTourType(x: unknown): x is TourType {
  return typeof x === 'string' && TOUR_TYPE_SET.has(x);
}

/**
 * Validate that a string is a parseable ISO 8601 datetime.
 * We accept any value that new Date() parses to a finite timestamp — the
 * simplest correct check that covers ISO 8601 extended format strings.
 */
function isValidIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

// Allowed POST body fields (strict allowlist — unknown fields → 400).
const POST_ALLOWED = new Set(['tenantId', 'unitId', 'scheduledAt', 'tourType']);

// Allowed PATCH body fields (strict allowlist).
const PATCH_ALLOWED = new Set(['scheduledAt', 'status', 'outcome', 'moveForward']);

export interface ToursRouterDeps {
  logger?: Logger;
  toursRepo?: ToursRepo;
}

export function createToursRouter(deps: ToursRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });

  const router = Router();

  // POST /api/tours — create a tour. Status defaults to 'scheduled'.
  router.post('/', async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;

    // Unknown-field check (allowlist).
    const unknownFields = Object.keys(b).filter((k) => !POST_ALLOWED.has(k));
    if (unknownFields.length > 0) {
      res.status(400).json({ error: `unknown field(s): ${unknownFields.join(', ')}` });
      return;
    }

    // Required: tenantId
    if (typeof b['tenantId'] !== 'string' || b['tenantId'].length === 0) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    // Required: unitId
    if (typeof b['unitId'] !== 'string' || b['unitId'].length === 0) {
      res.status(400).json({ error: 'unitId is required' });
      return;
    }
    // Required: scheduledAt (valid ISO datetime)
    if (!isValidIso(b['scheduledAt'])) {
      res.status(400).json({ error: 'scheduledAt must be a valid ISO 8601 datetime' });
      return;
    }
    // Required: tourType (allowlisted)
    if (!isTourType(b['tourType'])) {
      res.status(400).json({ error: `tourType must be one of: ${TOUR_TYPES.join(', ')}` });
      return;
    }

    const tour = await tours.create({
      tenantId: b['tenantId'] as string,
      unitId: b['unitId'] as string,
      scheduledAt: b['scheduledAt'] as string,
      tourType: b['tourType'] as TourType,
    });

    log.info({ tourId: tour.tourId, tenantId: tour.tenantId, unitId: tour.unitId }, 'tour created via api');
    res.status(201).json({ tour });
  });

  // GET /api/tours — list tours by tenantId, unitId, or scheduled range (from+to).
  // Priority: tenantId > unitId > from+to (mirrors units.ts filter priority).
  router.get('/', async (req, res) => {
    const tenantId = req.query['tenantId'];
    const unitId = req.query['unitId'];
    const from = req.query['from'];
    const to = req.query['to'];

    let tourList: TourItem[];
    if (typeof tenantId === 'string' && tenantId.length > 0) {
      tourList = await tours.listByTenant(tenantId);
    } else if (typeof unitId === 'string' && unitId.length > 0) {
      tourList = await tours.listByUnit(unitId);
    } else if (
      typeof from === 'string' && from.length > 0 &&
      typeof to === 'string' && to.length > 0
    ) {
      if (!isValidIso(from) || !isValidIso(to)) {
        res.status(400).json({ error: 'from and to must be valid ISO 8601 datetimes' });
        return;
      }
      tourList = await tours.listByScheduledRange(from, to);
    } else {
      res.status(400).json({
        error: 'one of tenantId, unitId, or from+to is required',
      });
      return;
    }

    res.json({ tours: tourList });
  });

  // GET /api/tours/:tourId — one tour. 404 when not found.
  router.get('/:tourId', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    res.json({ tour });
  });

  // PATCH /api/tours/:tourId — partial update with transition guards.
  router.patch('/:tourId', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;

    // Unknown-field check.
    const unknownFields = Object.keys(b).filter((k) => !PATCH_ALLOWED.has(k));
    if (unknownFields.length > 0) {
      res.status(400).json({ error: `unknown field(s): ${unknownFields.join(', ')}` });
      return;
    }

    // Must supply at least one patchable field.
    if (Object.keys(b).length === 0) {
      res.status(400).json({ error: 'patch body must include at least one field' });
      return;
    }

    // Validate individual fields when present.
    const newScheduledAt = b['scheduledAt'];
    const newStatus = b['status'];
    const newOutcome = b['outcome'];
    const newMoveForward = b['moveForward'];

    if (newScheduledAt !== undefined && !isValidIso(newScheduledAt)) {
      res.status(400).json({ error: 'scheduledAt must be a valid ISO 8601 datetime' });
      return;
    }
    if (newStatus !== undefined && !isTourStatus(newStatus)) {
      res.status(400).json({ error: `status must be one of: ${TOUR_STATUSES.join(', ')}` });
      return;
    }
    if (newOutcome !== undefined && !isTourOutcome(newOutcome)) {
      res.status(400).json({ error: `outcome must be one of: ${TOUR_OUTCOMES.join(', ')}` });
      return;
    }
    if (newMoveForward !== undefined && typeof newMoveForward !== 'boolean') {
      res.status(400).json({ error: 'moveForward must be a boolean' });
      return;
    }

    // Fetch the current tour to check transition legality.
    const current = await tours.get(tourId);
    if (!current) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }

    const currentStatus = current.status as TourStatus;

    // --- Status transition guard ---
    // Rules:
    //   - 'closed' is terminal: no status change is allowed from 'closed'.
    //   - The only path back to 'scheduled' is via canReschedule() (i.e. from
    //     scheduled/confirmed/canceled/no_show — NOT from toured or closed).
    if (newStatus !== undefined) {
      const targetStatus = newStatus as TourStatus;

      if (currentStatus === 'closed') {
        // closed is fully terminal — no transitions allowed.
        res.status(409).json({ error: 'illegal_status_transition', detail: `a closed tour cannot be changed (current: closed, requested: ${targetStatus})` });
        return;
      }

      if (targetStatus === 'scheduled' && !canReschedule(currentStatus)) {
        // Only reschedulable statuses may go back to 'scheduled'.
        res.status(409).json({ error: 'illegal_status_transition', detail: `cannot reschedule from status: ${currentStatus}` });
        return;
      }
    }

    // --- Reschedule (scheduledAt only, no status change) ---
    // If only scheduledAt is being changed (not a status transition), the tour
    // must be in a reschedulable state.
    if (newScheduledAt !== undefined && newStatus === undefined) {
      if (!canReschedule(currentStatus)) {
        res.status(409).json({ error: 'illegal_status_transition', detail: `cannot reschedule from status: ${currentStatus}` });
        return;
      }
    }

    // --- Build the patch ---
    // Exit gate: outcome + moveForward → also set convertible.
    const patch: Record<string, unknown> = {};
    if (newScheduledAt !== undefined) patch['scheduledAt'] = newScheduledAt;
    if (newStatus !== undefined) patch['status'] = newStatus;
    if (newOutcome !== undefined) patch['outcome'] = newOutcome;
    if (newMoveForward !== undefined) {
      patch['moveForward'] = newMoveForward;
      // Exit gate: convertible is true iff moveForward is true.
      patch['convertible'] = newMoveForward === true;
    }

    let tour: TourItem;
    try {
      tour = await tours.patch(tourId, patch);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'tour_not_found' });
        return;
      }
      throw err;
    }

    log.info({ tourId, fields: Object.keys(patch).length }, 'tour patched via api');
    res.json({ tour });
  });

  return router;
}
