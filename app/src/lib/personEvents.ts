// Dual-party person milestones (contact-comms-pane, 2026-08-03).
//
// A tour/placement lifecycle event is news for BOTH sides of the deal: the
// TENANT whose tour/placement it is, and the LANDLORD who owns the unit. This
// helper is that pair of writes, once, so tours.ts / placements.ts /
// services/statusTransition.ts do not each re-implement (and drift on) the
// landlord resolve plus the best-effort guarding.
//
// LANDLORD RESOLUTION IS POINT-IN-TIME: the landlord is whoever
// `unit.landlordId` resolves to AT EVENT TIME. A later unit re-assignment
// neither transfers pin history to the new landlord nor strips it from the old
// one. That deliberately differs from the contact timeline's property-audit
// interleave, which walks the CURRENT owner's units retroactively.
//
// Every write is independently guarded and NONE may fail the caller's route -
// the state each event describes is already persisted. A landlord-less unit, a
// missing unit row, or a repo throw simply skips the landlord copy, silently.
//
// PII (activityEventsRepo.ts:19): NEVER log the label - ids/type only.
import type { Logger } from './logger.js';
import type {
  ActivityEventRefType,
  ActivityEventsRepo,
  ActivityEventType,
} from '../repos/activityEventsRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';

export interface PersonMilestoneDeps {
  /**
   * OPTIONAL: the transition service takes its activity-events repo optionally
   * (legacy callers construct it without one), and an absent repo means the
   * whole milestone is skipped - exactly today's behavior there.
   */
  activityEvents?: Pick<ActivityEventsRepo, 'record'>;
  /** Resolves the unit -> its landlord contact. Narrow structural view. */
  units: Pick<UnitsRepo, 'getById'>;
  log: Logger;
}

export interface PersonMilestoneInput {
  /** The tenant contact the event is primarily about. */
  tenantId: string;
  /** The unit whose landlord gets the second copy. */
  unitId: string;
  type: ActivityEventType;
  /** Human text - SERVER-owned, rendered verbatim. Never logged. */
  label: string;
  refType: ActivityEventRefType;
  refId: string;
}

/**
 * Record ONE milestone against the tenant AND the unit's landlord. Both writes
 * are best-effort: this never throws, so callers can await it on a route that
 * has already persisted its state.
 */
export async function recordPersonMilestone(
  deps: PersonMilestoneDeps,
  input: PersonMilestoneInput,
): Promise<void> {
  const { activityEvents, log } = deps;
  if (!activityEvents) return;
  const { tenantId, unitId, type, label, refType, refId } = input;

  if (typeof tenantId === 'string' && tenantId.length > 0) {
    try {
      await activityEvents.record({ contactId: tenantId, type, label, refType, refId });
    } catch (err) {
      log.error({ err, refType, refId }, `${type} milestone record failed (best-effort)`);
    }
  }

  const landlordId = await resolveLandlordId(deps, unitId);
  if (landlordId === undefined) return;
  // De-dupe the degenerate case where one contact is both parties (mirrors the
  // tour relay roster, which gives such a contact ONE slot): one feed, one pin.
  if (landlordId === tenantId) return;
  try {
    await activityEvents.record({ contactId: landlordId, type, label, refType, refId });
  } catch (err) {
    log.error({ err, refType, refId, unitId }, `${type} landlord milestone record failed (best-effort)`);
  }
}

/**
 * The unit's landlord contactId at THIS instant, or undefined when there is
 * none to write to (no unitId, no unit row, a blank landlordId, or a failed
 * read). The read is WRAPPED on its own so an unguarded repo/network throw can
 * never turn a DynamoDB hiccup into a 500 on a request that used to succeed
 * (same reasoning as the tour relay route's ZIP-hint lookup).
 */
async function resolveLandlordId(
  deps: PersonMilestoneDeps,
  unitId: string,
): Promise<string | undefined> {
  if (typeof unitId !== 'string' || unitId.length === 0) return undefined;
  try {
    const unit = await deps.units.getById(unitId);
    return typeof unit?.landlordId === 'string' && unit.landlordId.length > 0
      ? unit.landlordId
      : undefined;
  } catch (err) {
    deps.log.error({ err, unitId }, 'landlord resolve for person milestone failed (best-effort)');
    return undefined;
  }
}
