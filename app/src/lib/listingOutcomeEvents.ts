// The ONE writer for a send-outcome event (last-heard-from spec 5.4 as
// amended by 14.3): listing_declined, listing_decline_cleared,
// listing_interested. Two best-effort surfaces:
//   - the CONTACT's timeline (an activity event, refType 'unit' / refId
//     unitId) - never a landlord copy: a decline is not deal news for the
//     landlord (the dual-party rule, lib/personEvents.ts header);
//   - the property's Activity card: a `units#<unitId>` audit row whose payload
//     holds only keys the Activity projection whitelists (routes/units.ts
//     toUnitActivityEvent): contactId, actor (hoisted to actorId), and tourId
//     on listing_interested so the row links the tour. `by` (staff / engine)
//     is deliberately NOT written: "(auto)" renders on the cards only.
// NEITHER may fail the caller - the outcome is already persisted. Unlike
// lib/tourEvents.ts this needs no tourId and copies no landlord. PII-safe
// logs: ids and type only (the label carries an address - never logged).
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { Logger } from './logger.js';

export type ListingOutcomeEventType = 'listing_declined' | 'listing_decline_cleared' | 'listing_interested';

export async function recordListingOutcomeEvent(
  deps: { activityEvents: ActivityEventsRepo; audit: AuditRepo; logger: Logger },
  input: {
    type: ListingOutcomeEventType;
    contactId: string;
    unitId: string;
    /** The timeline label, address included (Timeline.tsx renders it verbatim). */
    label: string;
    actor?: string;
    tourId?: string;
    at: string;
  },
): Promise<void> {
  const { activityEvents, audit, logger: log } = deps;
  const { type, contactId, unitId, label, actor, tourId, at } = input;
  try {
    await activityEvents.record({ contactId, type, label, refType: 'unit', refId: unitId, at });
  } catch (err) {
    log.error({ err, contactId, unitId, type }, `${type} contact timeline record failed (best-effort)`);
  }
  try {
    await audit.append(`units#${unitId}`, type, {
      contactId,
      ...(actor !== undefined && { actor }),
      ...(tourId !== undefined && { tourId }),
    });
  } catch (err) {
    log.error({ err, contactId, unitId, type }, `${type} unit audit failed (best-effort)`);
  }
}
