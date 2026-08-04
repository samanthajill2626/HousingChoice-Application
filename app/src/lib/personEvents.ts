// Dual-party person milestones (contact-comms-pane, 2026-08-03).
//
// A tour/placement lifecycle event is news for BOTH sides of the deal: the
// TENANT whose tour/placement it is, and the LANDLORD who owns the unit. This
// helper is that pair of writes, once, so tours.ts / placements.ts /
// services/statusTransition.ts do not each re-implement (and drift on) the
// landlord resolve plus the best-effort guarding.
//
// LANDLORD RESOLUTION IS POINT-IN-TIME, PERMANENTLY: the landlord is whoever
// `unit.landlordId` resolves to AT EVENT TIME, and the pin never moves after
// that. Re-assigning `unit.landlordId` later does NOT hand existing tour /
// placement pins to the new landlord and does not strip them from the old one:
// the landlord who owned the unit at event time keeps them forever, and the new
// landlord's contact page shows nothing that happened before the re-assignment
// (a property changing management companies is the everyday case). That is the
// standing product rule, not a migration artifact - routes/contactTimeline.ts's
// LANDLORD_FEED_TYPES note states the same rule on the read side.
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
  // A blank tenant suppresses the WHOLE milestone, landlord copy included - the
  // pre-existing semantics of the recorders this helper absorbed
  // (placements.ts recordPlacementMilestone / statusTransition.ts
  // recordStageMilestone both opened with this guard). It returns BEFORE the
  // landlord resolve, so an unusable input costs no unit read either. In
  // practice unreachable (every route requires a tenantId), which is exactly why
  // it should stay a hard stop rather than a half-written pair.
  if (typeof tenantId !== 'string' || tenantId.length === 0) return;

  try {
    await activityEvents.record({ contactId: tenantId, type, label, refType, refId });
  } catch (err) {
    log.error({ err, refType, refId }, `${type} milestone record failed (best-effort)`);
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
