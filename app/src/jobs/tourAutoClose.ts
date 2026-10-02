// Tour auto-close (Sam #18, 2026-10-01; spec
// docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md).
//
// A tour that still has no outcome two weeks after its clock start (see
// lib/toursModel.ts autoCloseDueAtMs) closes ON ITS OWN with outcome
// `no_outcome`. SILENT by construction: these deps hold no messaging adapter
// and no send service, so nothing here can text anyone. It never marks a
// no-show, never touches tenant status or placements.
//
// One conditional write per tour (toursRepo.autoCloseIf): a staff change that
// lands between our read and our write wins, and we skip the tour this run.
// Only the WINNER of that write runs the side effects - reminder sweep,
// activity, relay close-nag, events - each best-effort.
//
// The injected `now` decides only WHICH tours are due; every stamp is wall
// clock (repo convention). Runs on the worker's own 15-minute poll and on the
// hermetic dev tick (POST /__dev/tour-auto-close/tick).
import { randomUUID } from 'node:crypto';
import { AUTO_CLOSE_STATUSES, isAutoCloseDue } from '../lib/toursModel.js';
import type { EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { recordTourEvent } from '../lib/tourEvents.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import type { TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import type { TourItem, ToursRepo } from '../repos/toursRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';
import { armRelayCloseNagIfOpen } from '../services/relayCloseNag.js';

/** The worker poll's own cadence - a two-week rule needs no 30 s tick. */
export const TOUR_AUTO_CLOSE_INTERVAL_MS = 15 * 60 * 1000;

/** Person-timeline label (server-owned, rendered verbatim). */
export const TOUR_AUTO_CLOSED_LABEL = 'Tour closed automatically: no outcome recorded after two weeks';

export interface TourAutoCloseDeps {
  toursRepo: ToursRepo;
  tourRemindersRepo: TourRemindersRepo;
  conversationsRepo: ConversationsRepo;
  unitsRepo: UnitsRepo;
  auditRepo: AuditRepo;
  /** REQUIRED (not optional): without it recordPersonMilestone silently skips
   *  every tenant and landlord "Tour closed automatically" pin (spec 4 /
   *  10.1), and nothing else would catch the omission. */
  activityEventsRepo: ActivityEventsRepo;
  events: EventBus;
  logger?: Logger;
}

export interface TourAutoCloseOptions {
  /** Dev tick only: consider ONLY these tours (each read consistently). */
  tourIds?: readonly string[];
}

export interface TourAutoCloseSummary {
  scanned: number;
  due: number;
  closed: number;
  lost: number;
  failed: number;
}

async function loadCandidates(deps: TourAutoCloseDeps, opts: TourAutoCloseOptions): Promise<TourItem[]> {
  if (opts.tourIds !== undefined) {
    const found = await Promise.all(opts.tourIds.map((id) => deps.toursRepo.get(id, { consistentRead: true })));
    return found.filter((t): t is TourItem => t !== undefined);
  }
  const pages = await Promise.all(AUTO_CLOSE_STATUSES.map((status) => deps.toursRepo.listByStatus(status)));
  return pages.flat();
}

export async function runTourAutoClose(
  nowIso: string,
  deps: TourAutoCloseDeps,
  opts: TourAutoCloseOptions = {},
): Promise<TourAutoCloseSummary> {
  const log = deps.logger ?? defaultLogger;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error('runTourAutoClose: now must be an ISO 8601 instant');
  const candidates = await loadCandidates(deps, opts);
  const summary: TourAutoCloseSummary = { scanned: candidates.length, due: 0, closed: 0, lost: 0, failed: 0 };

  for (const tour of candidates) {
    if (!isAutoCloseDue(tour, nowMs)) continue;
    summary.due += 1;
    const rotation = randomUUID();
    let closed: TourItem | undefined;
    try {
      closed = await deps.toursRepo.autoCloseIf(tour, rotation);
    } catch (err) {
      summary.failed += 1;
      log.error({ err, tourId: tour.tourId }, 'tour auto-close write failed');
      continue;
    }
    if (closed === undefined) {
      summary.lost += 1;
      continue;
    }
    summary.closed += 1;
    log.info({ tourId: tour.tourId, from: tour.status }, 'tour closed automatically (no outcome after two weeks)');
    await afterClose(closed, rotation, deps, log);
  }

  if (summary.closed > 0 || summary.failed > 0) log.info({ ...summary }, 'tour auto-close run');
  return summary;
}

/** The winner's side effects - each best-effort, none may stop the run. */
async function afterClose(tour: TourItem, rotation: string, deps: TourAutoCloseDeps, log: Logger): Promise<void> {
  try {
    await deps.tourRemindersRepo.deleteSupersededForTour(tour.tourId, rotation);
  } catch (err) {
    log.error({ err, tourId: tour.tourId }, 'tour auto-close: reminder sweep failed (rows stay refused by the rotated pointer)');
  }
  await recordTourEvent(
    { activityEvents: deps.activityEventsRepo, units: deps.unitsRepo, audit: deps.auditRepo, log },
    { tenantId: tour.tenantId, unitId: tour.unitId, tourId: tour.tourId },
    'tour_auto_closed',
    'tour_auto_closed',
    TOUR_AUTO_CLOSED_LABEL,
  );
  await armRelayCloseNagIfOpen({ conversationsRepo: deps.conversationsRepo, logger: log }, tour.groupThreadId, 'tour');
  deps.events.emit('tour.updated', { tourId: tour.tourId, status: 'closed' });
  deps.events.emit('scheduled.updated', { contactId: tour.tenantId });
}
