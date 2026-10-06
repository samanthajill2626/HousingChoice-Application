// The ONE writer for a tour lifecycle event (moved out of routes/tours.ts so
// the auto-close sweep and the reopen route record exactly what the PATCH
// route records). Three best-effort surfaces: BOTH parties' contact timelines
// (tenant + the unit's landlord, via lib/personEvents), the property's
// Activity card (a `units#<unitId>` audit row), and the tour's own history (a
// `tours#<tourId>` audit row - GET /api/tours/:tourId/activity). NONE may fail
// the caller: state is already persisted. PII-safe logs: ids and type only.
import type { ActivityEventsRepo, ActivityEventType } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { Logger } from './logger.js';
import { recordPersonMilestone, type PersonMilestoneDeps } from './personEvents.js';

export interface TourEventDeps extends PersonMilestoneDeps {
  /**
   * REQUIRED here, although PersonMilestoneDeps leaves it optional: an absent
   * repo silently skips BOTH timeline pins, and every caller of this writer
   * (the tours router, the auto-close sweep, the reopen route) always has one.
   */
  activityEvents: Pick<ActivityEventsRepo, 'record'>;
  audit: AuditRepo;
}

export interface TourEventSubject {
  tenantId: string;
  unitId: string;
  tourId: string;
}

export async function recordTourEvent(
  deps: TourEventDeps,
  tour: TourEventSubject,
  activityType: ActivityEventType,
  auditType: string,
  label: string,
): Promise<void> {
  const log: Logger = deps.log;
  await recordPersonMilestone(deps, {
    tenantId: tour.tenantId,
    unitId: tour.unitId,
    type: activityType,
    label,
    refType: 'tour',
    refId: tour.tourId,
  });
  try {
    await deps.audit.append(`units#${tour.unitId}`, auditType, { tourId: tour.tourId });
  } catch (err) {
    log.error({ err, tourId: tour.tourId }, `${auditType} unit audit failed (best-effort)`);
  }
  try {
    await deps.audit.append(`tours#${tour.tourId}`, auditType, { tourId: tour.tourId });
  } catch (err) {
    log.error({ err, tourId: tour.tourId }, `${auditType} tour audit failed (best-effort)`);
  }
}
