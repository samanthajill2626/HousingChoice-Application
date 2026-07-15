// Placement nudges endpoints (placement-detail-hub, Task 2).
//
//   GET   /api/placements/:placementId/nudges
//        -> { nudges: PlacementNudgeView[] }  (sorted dueAt DESCENDING)
//   PATCH /api/placements/:placementId/nudges/:nudgeId  { canceled: boolean }
//        -> { nudge: PlacementNudgeView } | 409 (already sent, or the cancel/
//           restore raced the poll's claim -> the honest current state returns)
//
// Mounted under /api/placements (behind requireAuth via the /api mount), a
// SIBLING router to the placements CRUD router: its only paths are the
// /:placementId/nudges* segments, DISTINCT from the placements router's
// /:placementId (a single-segment match, never /:placementId/nudges), so the two
// never collide — the same split tourReminders.ts uses under /api/tours.
//
// GET surfaces each armed application-nudge rung's state
// (upcoming|sent|canceled|skipped) so the detail hub can show WHAT scheduled
// texts are queued, which fired, and which the poll retired unsent.
// PATCH is the operator's per-rung cancel/un-cancel: atomic conditional writes
// (repo cancel/uncancel), so a cancel racing the poll's send claim resolves to
// exactly one outcome — a lost race 409s with the row's real state instead of
// lying. Restoring a PAST-DUE rung is allowed and fires on the next poll tick.
//
// recipient is DERIVED from kind per the nudge ladder (NUDGE_RUNGS in
// jobs/placementNudges.ts): the approval_check + rta_window_closing rungs route
// to the landlord, every other rung to the tenant. The cancel/restore emit keys
// scheduled.updated on the RECIPIENT's contactId (tenant -> placement.tenantId;
// landlord -> unit.landlordId via a best-effort unitsRepo lookup, falling back to
// the tenant when unresolvable — the dashboard panels refetch on ANY
// scheduled.updated regardless).
//
// PII (doc §9): the response carries state/ids to the authed client; log lines
// stay ids/counts only.
import { json, Router } from 'express';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { NUDGE_RUNGS } from '../jobs/placementNudges.js';
import {
  createPlacementNudgesRepo,
  type NudgeKind,
  type NudgeSkipReason,
  type PlacementNudgeItem,
  type PlacementNudgesRepo,
} from '../repos/placementNudgesRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';

export interface PlacementNudgesRouterDeps {
  logger?: Logger;
  placementsRepo?: PlacementsRepo;
  placementNudgesRepo?: PlacementNudgesRepo;
  /** Landlord resolution: a landlord-routed nudge keys its emit on unit.landlordId. */
  unitsRepo?: UnitsRepo;
  /** Live-update bus (defaults to appEvents): a cancel/restore emits
   *  scheduled.updated so the Deadlines-and-nudges card + the timelines' Upcoming
   *  buckets refetch. */
  events?: EventBus;
}

/** One nudge rung as the dashboard renders it. */
export interface PlacementNudgeView {
  nudgeId: string;
  placementId: string;
  kind: NudgeKind;
  /** The party a rung's automated text goes to, derived from kind (NUDGE_RUNGS). */
  recipient: 'tenant' | 'landlord';
  /** ISO 8601 — when the rung is/was scheduled to fire. */
  dueAt: string;
  /** 'skipped' = the poll retired the rung UNSENT (stale stage / undeliverable
   *  recipient) — see skipReason. Distinct from 'sent' so the card never
   *  reports a text the recipient did not get. */
  state: 'upcoming' | 'sent' | 'canceled' | 'skipped';
  sentAt?: string;
  canceledAt?: string;
  skippedAt?: string;
  skipReason?: NudgeSkipReason;
}

// kind -> recipient, derived ONCE from the single-source nudge ladder so it can
// never drift from the poll's routing (jobs/placementNudges.ts). A kind absent
// from the ladder falls back to 'tenant' (the ladder's default routing).
const RECIPIENT_BY_KIND = Object.fromEntries(
  Object.values(NUDGE_RUNGS)
    .filter(
      (rung): rung is { kind: NudgeKind; recipient: 'tenant' | 'landlord'; delayMs: number } =>
        rung !== undefined,
    )
    .map((rung) => [rung.kind, rung.recipient]),
) as Partial<Record<NudgeKind, 'tenant' | 'landlord'>>;

const recipientOf = (kind: NudgeKind): 'tenant' | 'landlord' => RECIPIENT_BY_KIND[kind] ?? 'tenant';

/** canceledAt wins over sentAt/skippedAt (terminal markers are mutually
 *  exclusive by the repo's conditional writes, but be safe). */
function stateOf(row: PlacementNudgeItem): PlacementNudgeView['state'] {
  if (row.canceledAt !== undefined) return 'canceled';
  if (row.skippedAt !== undefined) return 'skipped';
  if (row.sentAt !== undefined) return 'sent';
  return 'upcoming';
}

/** Project one stored row -> its wire view. */
function viewOf(row: PlacementNudgeItem): PlacementNudgeView {
  return {
    nudgeId: row.nudgeId,
    placementId: row.placementId,
    kind: row.kind,
    recipient: recipientOf(row.kind),
    dueAt: row.dueAt,
    state: stateOf(row),
    ...(row.sentAt !== undefined && { sentAt: row.sentAt }),
    ...(row.canceledAt !== undefined && { canceledAt: row.canceledAt }),
    ...(row.skippedAt !== undefined && { skippedAt: row.skippedAt }),
    ...(row.skipReason !== undefined && { skipReason: row.skipReason }),
  };
}

export function createPlacementNudgesRouter(deps: PlacementNudgesRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const nudges = deps.placementNudgesRepo ?? createPlacementNudgesRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  const router = Router();

  /**
   * Resolve the RECIPIENT contactId a cancel/restore emit keys on: a tenant rung
   * -> placement.tenantId; a landlord rung -> unit.landlordId (best-effort lookup).
   * Falls back to the tenant when the unit/landlord is unresolvable — the panels
   * refetch on ANY scheduled.updated, so the tenantId is a sufficient hint.
   */
  async function recipientContactId(
    row: PlacementNudgeItem,
    placement: { tenantId: string; unitId: string },
  ): Promise<string> {
    if (recipientOf(row.kind) === 'tenant') return placement.tenantId;
    try {
      const unit = await units.getById(placement.unitId);
      if (unit && typeof unit.landlordId === 'string' && unit.landlordId.length > 0) {
        return unit.landlordId;
      }
    } catch (err) {
      log.warn(
        { err, placementId: row.placementId, kind: row.kind },
        'placement nudge: landlord lookup failed for emit — falling back to tenant',
      );
    }
    return placement.tenantId;
  }

  // PATCH /:placementId/nudges/:nudgeId { canceled } — operator cancel/restore of
  // ONE rung (see file header for race + past-due semantics).
  router.patch('/:placementId/nudges/:nudgeId', json(), async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    const nudgeId = String(req.params['nudgeId'] ?? '');
    const canceled = (req.body as { canceled?: unknown } | undefined)?.canceled;
    if (typeof canceled !== 'boolean') {
      res.status(400).json({ error: 'canceled (boolean) is required' });
      return;
    }

    const placement = await placements.getById(placementId);
    if (!placement) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const rows = await nudges.listByPlacement(placementId);
    if (!rows.some((r) => r.nudgeId === nudgeId)) {
      res.status(404).json({ error: 'nudge_not_found' });
      return;
    }

    const won = canceled
      ? await nudges.cancel(nudgeId, new Date().toISOString())
      : await nudges.uncancel(nudgeId);

    // Re-read for the HONEST post-write state (also what a lost race reports:
    // e.g. the poll claimed the row between our list and the conditional write).
    const after = (await nudges.listByPlacement(placementId)).find((r) => r.nudgeId === nudgeId)!;
    if (!won) {
      log.info(
        { placementId, nudgeId, wanted: canceled ? 'cancel' : 'restore', state: stateOf(after) },
        'placement nudge cancel/restore lost the claim — reporting current state',
      );
      res.status(409).json({
        error: canceled ? 'nudge_not_cancelable' : 'nudge_not_restorable',
        nudge: viewOf(after),
      });
      return;
    }

    // Same live-surface nudge the poll's claim emits: the card + the timelines'
    // Upcoming buckets refetch. Keyed on the RECIPIENT's contactId.
    const contactId = await recipientContactId(after, placement);
    events.emit('scheduled.updated', { contactId });
    log.info(
      { placementId, nudgeId, kind: after.kind, canceled },
      canceled ? 'placement nudge canceled via api' : 'placement nudge restored via api',
    );
    res.json({ nudge: viewOf(after) });
  });

  // GET /:placementId/nudges — the detail hub's read of the armed rung ladder.
  router.get('/:placementId/nudges', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');

    const placement = await placements.getById(placementId);
    if (!placement) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }

    const rows = await nudges.listByPlacement(placementId);
    const nudgeViews: PlacementNudgeView[] = rows
      .map(viewOf)
      // DESCENDING by dueAt (newest-due first — the card leads with the latest rung).
      .sort((a, b) => (a.dueAt < b.dueAt ? 1 : a.dueAt > b.dueAt ? -1 : 0));

    log.info({ placementId, count: nudgeViews.length }, 'placement nudges read');
    res.json({ nudges: nudgeViews });
  });

  return router;
}
