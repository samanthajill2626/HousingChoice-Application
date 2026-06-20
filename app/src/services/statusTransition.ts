// THE one status-transition service (STATUS-MODEL.md §8/§9): EVERY status/stage
// transition routes through here so denormalization, provenance, derivation,
// source-precedence, final_rent, the Lost bounce-back, and the time-in-stage
// nudge all live in ONE place. (RTA-in-hand is NOT gated — 2026-06-19 product
// decision: it's a manual prerequisite, the admin advances the tenant.) All
// stage/status knowledge is read from lib/statusModel.ts (no duplicated lists).
//
// The workflow record is the `placement` entity in code/data
// (placementsRepo/placementId). DI like the other services
// (createStatusTransitionService({...})).
//
// PII (doc §9): logs are IDs/sources/counts only — never names/phones/bodies,
// never the lost-reason free text.
import { mergeContext } from '../lib/context.js';
import { toPlacementUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  deriveStatuses,
  isInspectionOutcome,
  isListingOverrideStatus,
  isLostReasonCategory,
  isPlacementStage,
  isTenantOverrideStatus,
  STAGE_STUCK_THRESHOLDS,
  TERMINAL_STAGES,
  type InspectionOutcome,
  type ListingStatus,
  type LostReason,
  type PlacementStage,
  type TenantStatus,
  type TransitionSource,
} from '../lib/statusModel.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import { type PlacementItem, type PlacementsRepo } from '../repos/placementsRepo.js';
import { type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';

/** The hard-clock deadline types that must NOT be clobbered by a stuck nudge. */
const HARD_CLOCK_DEADLINE_TYPES: ReadonlySet<string> = new Set([
  'rta_window',
  'voucher_expiration',
  'tour_reminder',
]);

export interface StatusTransitionDeps {
  placementsRepo: PlacementsRepo;
  unitsRepo: UnitsRepo;
  contactsRepo: ContactsRepo;
  auditRepo: AuditRepo;
  events: EventBus;
  logger?: Logger;
}

export interface TransitionPlacementInput {
  toStage: PlacementStage;
  source: TransitionSource;
  reason?: string;
  /** Structured Lost reason (only meaningful when toStage === 'lost'). */
  lostReason?: LostReason;
  /**
   * The ACCEPTED rent. Supplied on the rent-acceptance move — the transition
   * OUT of `awaiting_rent_acceptance` (the landlord accepts the determined
   * rent) — and written onto the unit as `final_rent` (§4). Ignored on any
   * other move.
   */
  finalRent?: number;
  /**
   * The inspection's pass/fail OUTCOME (§4). Supplied on the inspection-complete
   * move — the transition OUT of `awaiting_inspection` — and written onto the
   * placement as `inspection_outcome`. Ignored on any other move. A `fail` does NOT
   * force a particular next stage (not a strict state machine); the admin routes
   * the card.
   */
  inspectionOutcome?: InspectionOutcome;
  /** The acting user (userId) — indexed onto the audit row's byActor GSI (§8). */
  actor?: string;
}

export interface SetTenantStatusInput {
  toStatus: TenantStatus;
  source: TransitionSource;
  reason?: string;
  /** Update the porting flag in the same write (an informational §5 flag — never a gate). */
  porting?: boolean;
  /** The acting user (userId) — indexed onto the audit row's byActor GSI (§8). */
  actor?: string;
}

export interface SetListingStatusInput {
  toStatus: ListingStatus;
  source: TransitionSource;
  reason?: string;
  /** The acting user (userId) — indexed onto the audit row's byActor GSI (§8). */
  actor?: string;
}

/** A transition was rejected by a business rule (e.g. an unknown stage). */
export class TransitionRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionRefusedError';
  }
}

/** A referenced entity (placement/contact/unit) does not exist. */
export class EntityNotFoundError extends Error {
  constructor(
    readonly entity: 'placement' | 'contact' | 'unit',
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = 'EntityNotFoundError';
  }
}

export interface StatusTransitionService {
  /** Move a placement to `toStage` (denormalize + provenance + derivation + nudge). */
  transitionPlacement(placementId: string, input: TransitionPlacementInput): Promise<PlacementItem>;
  /** Explicit tenant-status write (incl. manual drop-out; no RTA-in-hand gate — 2026-06-19). */
  setTenantStatus(contactId: string, input: SetTenantStatusInput): Promise<ContactItem>;
  /** Explicit listing-status write. */
  setListingStatus(unitId: string, input: SetListingStatusInput): Promise<UnitItem>;
}

export function createStatusTransitionService(
  deps: StatusTransitionDeps,
): StatusTransitionService {
  const { placementsRepo, unitsRepo, contactsRepo, auditRepo, events } = deps;
  const log = deps.logger ?? defaultLogger;

  /**
   * Derived TENANT-status write (load → override-gate → no-op-gate →
   * update+audit). Best-effort: a failure NEVER throws out of the placement
   * transition. The write is skipped entirely (no update, no audit) when EITHER
   * the current status is an override/exit state (on_hold/inactive — PINNED) OR
   * the derived value already equals the current status (idempotent: a
   * mid-pipeline advance whose coarse status is unchanged must not rewrite
   * provenance or spam history). Only a genuine CHANGE stamps `status_source:
   * 'derived'` and appends a `tenant_status_changed` audit row (NO actor —
   * derived is system; payload {from,to,source:'derived'}, matching the explicit
   * setter's event-type/shape).
   */
  async function deriveTenantStatus(tenantId: string, toStatus: TenantStatus): Promise<void> {
    try {
      const contact = await contactsRepo.getById(tenantId);
      if (!contact) return;
      const current = contact.status as TenantStatus | undefined;
      if (isTenantOverrideStatus(current)) return; // override-pinned → no write/no audit
      if (current === toStatus) return; // no-op → idempotent, no provenance rewrite
      await contactsRepo.update(tenantId, { status: toStatus, status_source: 'derived' });
      await auditRepo.append(`contacts#${tenantId}`, 'tenant_status_changed', {
        ...(current !== undefined && { from: current }),
        to: toStatus,
        source: 'derived',
      });
    } catch (err) {
      log.error({ err, tenantId }, 'derivation: tenant status write failed (best-effort)');
    }
  }

  /**
   * Derived LISTING-status write — symmetric to deriveTenantStatus (override set
   * is on_hold/off_market). Same load → override-gate → no-op-gate →
   * update+audit, best-effort, NO actor, event-type `listing_status_changed`.
   */
  async function deriveListingStatus(unitId: string, toStatus: ListingStatus): Promise<void> {
    try {
      const unit = await unitsRepo.getById(unitId);
      if (!unit) return;
      const current = unit.status as ListingStatus | undefined;
      if (isListingOverrideStatus(current)) return; // override-pinned → no write/no audit
      if (current === toStatus) return; // no-op → idempotent, no provenance rewrite
      await unitsRepo.update(unitId, { status: toStatus, status_source: 'derived' });
      await auditRepo.append(`units#${unitId}`, 'listing_status_changed', {
        ...(current !== undefined && { from: current }),
        to: toStatus,
        source: 'derived',
      });
    } catch (err) {
      log.error({ err, unitId }, 'derivation: listing status write failed (best-effort)');
    }
  }

  async function applyDerivation(
    tenantId: string,
    unitId: string,
    derived: { tenantStatus: TenantStatus; listingStatus: ListingStatus },
  ): Promise<void> {
    await deriveTenantStatus(tenantId, derived.tenantStatus);
    await deriveListingStatus(unitId, derived.listingStatus);
  }

  /**
   * Schedule (or clear) the time-in-stage "stuck" nudge for a placement (§8).
   * A placement has only ONE next_deadline slot, so we NEVER clobber a pending
   * HARD-CLOCK deadline (rta_window/voucher_expiration/tour_reminder) — the
   * stuck nudge is set only when no hard-clock deadline is currently pending.
   * Terminal stages clear any pending stuck nudge. (See
   * docs/issues/case-single-next-deadline-slot.md.)
   */
  async function scheduleStuckNudge(stored: PlacementItem, toStage: PlacementStage): Promise<void> {
    const pendingType = stored.next_deadline_type;
    if (TERMINAL_STAGES.has(toStage)) {
      // Closure: the placement is closed (moved_in/lost) — ANY pending deadline
      // is now moot (a stuck nudge OR a hard-clock rta_window/voucher_expiration/
      // tour_reminder), so clear the single next_deadline slot unconditionally.
      // Leaving a stale hard-clock deadline on a closed placement would fire a
      // nudge for a deal that no longer exists.
      if (pendingType !== undefined) {
        await placementsRepo.setNextDeadline(stored.placementId, null);
      }
      return;
    }
    const threshold = STAGE_STUCK_THRESHOLDS[toStage];
    if (threshold === undefined) return; // no threshold for this stage
    // A hard-clock deadline owns the single slot — never overwrite it.
    if (typeof pendingType === 'string' && HARD_CLOCK_DEADLINE_TYPES.has(pendingType)) {
      log.info(
        { placementId: stored.placementId, pendingType },
        'stuck nudge deferred: a hard-clock deadline holds the next_deadline slot',
      );
      return;
    }
    const at = new Date(Date.now() + threshold).toISOString();
    await placementsRepo.setNextDeadline(stored.placementId, { type: 'stuck_placement', at });
  }

  return {
    async transitionPlacement(placementId, input) {
      const { toStage, source, reason, lostReason, finalRent, inspectionOutcome, actor } = input;
      if (!isPlacementStage(toStage)) {
        throw new TransitionRefusedError('bad_stage', `unknown placement stage: ${String(toStage)}`);
      }
      const existing = await placementsRepo.getById(placementId);
      if (!existing) throw new EntityNotFoundError('placement', placementId);
      const from = existing.stage;
      const now = new Date().toISOString();

      // 1) Denormalize the stage + provenance onto the placement.
      const patch: Record<string, unknown> = {
        stage: toStage,
        stage_entered_at: now,
        stage_source: source,
      };

      // 2) Lost (from ANY stage): store the structured reason (pick or write).
      if (toStage === 'lost') {
        const lr: LostReason = {};
        if (lostReason?.category !== undefined && isLostReasonCategory(lostReason.category)) {
          lr.category = lostReason.category;
        }
        if (typeof lostReason?.text === 'string' && lostReason.text.length > 0) {
          lr.text = lostReason.text;
        }
        patch.lost_reason = lr;
      }

      // 2b) inspection_outcome (§4): the inspection's pass/fail is recorded on
      // the inspection-complete move — the transition OUT of
      // `awaiting_inspection` — when an outcome is supplied (mirrors how
      // finalRent is gated on `from === 'awaiting_rent_acceptance'`). Validate
      // defensively (the route validates too). It does NOT gate routing: a
      // `fail` does not force a particular next stage (not a strict state
      // machine) — the admin routes the card; we only persist the result.
      if (from === 'awaiting_inspection' && inspectionOutcome !== undefined) {
        if (!isInspectionOutcome(inspectionOutcome)) {
          throw new TransitionRefusedError('bad_inspection_outcome', 'inspectionOutcome must be pass or fail');
        }
        patch.inspection_outcome = inspectionOutcome;
      }

      const updated = await placementsRepo.update(placementId, patch);

      // 3) Provenance trail (IDs/source/actor only — never the lost-reason text).
      // `actor` (userId) is hoisted to the byActor GSI by auditRepo.append, so a
      // status change is queryable by who made it (§8).
      await auditRepo.append(`placements#${placementId}`, 'placement_stage_changed', {
        ...(actor !== undefined && { actor }),
        from,
        to: toStage,
        source,
        ...(reason !== undefined && { reason }),
        ...(toStage === 'lost' && updated.lost_reason?.category !== undefined && {
          lost_reason_category: updated.lost_reason.category,
        }),
      });

      // 4) final_rent (§4): written when `Awaiting rent acceptance` CLEARS — the
      // landlord accepts the determined rent — i.e. on the transition OUT of
      // `awaiting_rent_acceptance` (typically → awaiting_hap_contract). The
      // accepted amount arrives as the explicit `finalRent` arg on that move.
      // A move OUT of awaiting_rent_acceptance to the TERMINAL `lost` is a deal
      // dying, NOT a rent acceptance, so it must never write final_rent (it
      // would stamp a billing amount onto a unit whose placement just failed).
      // (The route already rejects finalRent <= 0 / NaN; we re-guard defensively.)
      if (from === 'awaiting_rent_acceptance' && toStage !== 'lost' && typeof finalRent === 'number') {
        if (!Number.isFinite(finalRent) || finalRent <= 0) {
          throw new TransitionRefusedError('bad_final_rent', 'finalRent must be a finite number > 0');
        }
        try {
          await unitsRepo.update(existing.unitId, { final_rent: finalRent });
        } catch (err) {
          log.error({ err, unitId: existing.unitId }, 'final_rent write failed');
        }
      }

      // 5) Derivation (§7). For `lost`, bounce tenant→searching / listing→
      //    available ONLY when no OTHER active (non-terminal) placement exists
      //    on that tenant/unit; otherwise the existing derivation stands.
      if (toStage === 'lost') {
        const tenantClear = await noOtherActivePlacement(existing.tenantId, placementId, 'tenant');
        const unitClear = await noOtherActivePlacement(existing.unitId, placementId, 'unit');
        const derived = deriveStatuses('lost'); // searching / available
        // The lost-bounce is a DERIVED write: it goes through the SAME shared
        // helpers as applyDerivation, so it inherits the identical override-gate
        // (a manually On-hold/Inactive tenant or On-hold/Off-market listing STAYS
        // pinned), the no-op guard, and the {from,to,source:'derived'} audit.
        // Only clear the side that has no OTHER active placement.
        if (tenantClear) await deriveTenantStatus(existing.tenantId, derived.tenantStatus);
        if (unitClear) await deriveListingStatus(existing.unitId, derived.listingStatus);
      } else {
        await applyDerivation(existing.tenantId, existing.unitId, deriveStatuses(toStage));
      }

      // 6) Time-in-stage nudge (uses the FRESH item so next_deadline_type is current).
      await scheduleStuckNudge(updated, toStage);

      // Emit + log (the legacy CRUD path emits placement.updated; mirror it, no PII).
      mergeContext({ placementId });
      const final = (await placementsRepo.getById(placementId)) ?? updated;
      events.emit('placement.updated', toPlacementUpdatedEvent(final));
      log.info({ placementId, from, to: toStage, source, ...(actor !== undefined && { actor }) }, 'placement stage transitioned');
      return final;
    },

    async setTenantStatus(contactId, input) {
      const { toStatus, source, reason, porting, actor } = input;
      const contact = await contactsRepo.getById(contactId);
      if (!contact) throw new EntityNotFoundError('contact', contactId);
      // The tenant lifecycle lives on the unified `status` field (§5).
      const from = contact.status;

      // RTA-in-hand is NOT gated here (product decision 2026-06-19): it is a
      // manual business prerequisite — the admin advances the tenant to
      // `searching` once it's satisfied, or moves them to `on_hold` if not. So
      // `setTenantStatus` always applies (subject only to the entity existing);
      // `porting` is an informational flag set in the same write, never a gate.
      const patch: Record<string, unknown> = {
        status: toStatus,
        status_source: source,
      };
      if (porting !== undefined) patch.porting = porting === true;
      const updated = await contactsRepo.update(contactId, patch);

      await auditRepo.append(`contacts#${contactId}`, 'tenant_status_changed', {
        ...(actor !== undefined && { actor }),
        from,
        to: toStatus,
        source,
        ...(reason !== undefined && { reason }),
      });
      mergeContext({ contactId });
      log.info({ contactId, from, to: toStatus, source, ...(actor !== undefined && { actor }) }, 'tenant status set');
      return updated;
    },

    async setListingStatus(unitId, input) {
      const { toStatus, source, reason, actor } = input;
      const unit = await unitsRepo.getById(unitId);
      if (!unit) throw new EntityNotFoundError('unit', unitId);
      const from = unit.status;

      const updated = await unitsRepo.update(unitId, {
        status: toStatus,
        status_source: source,
      });
      await auditRepo.append(`units#${unitId}`, 'listing_status_changed', {
        ...(actor !== undefined && { actor }),
        from,
        to: toStatus,
        source,
        ...(reason !== undefined && { reason }),
      });
      log.info({ unitId, from, to: toStatus, source, ...(actor !== undefined && { actor }) }, 'listing status set');
      return updated;
    },
  };

  /**
   * True when NO placement OTHER than `excludePlacementId` is active
   * (non-terminal) on the given tenant/unit — i.e. it is safe to bounce the
   * coarse status back to searching/available. A bounded GSI Query
   * (listByTenant/listByUnit).
   */
  async function noOtherActivePlacement(
    id: string,
    excludePlacementId: string,
    side: 'tenant' | 'unit',
  ): Promise<boolean> {
    // PAGINATE the byTenant/byUnit GSI: a single Query returns at most 1MB of
    // items, so a tenant/unit with many historical placements could span pages.
    // Stop early the moment an active OTHER placement is found; otherwise follow
    // lastEvaluatedKey until it is undefined — never decide "no other active
    // placement" off a partial page (a false negative would wrongly bounce a
    // still-active tenant/unit back to searching/available).
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const opts = { ...(exclusiveStartKey !== undefined && { exclusiveStartKey }) };
      const page =
        side === 'tenant'
          ? await placementsRepo.listByTenant(id, opts)
          : await placementsRepo.listByUnit(id, opts);
      if (page.items.some((c) => c.placementId !== excludePlacementId && !TERMINAL_STAGES.has(c.stage))) {
        return false; // there IS another active placement → do NOT bounce
      }
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return true;
  }
}
