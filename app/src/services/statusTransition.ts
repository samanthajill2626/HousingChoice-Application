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
  LANDLORD_STATUS_LABELS,
  STAGE_LABELS,
  TENANT_STATUS_LABELS,
  TERMINAL_STAGES,
  type InspectionOutcome,
  type LandlordStatus,
  type ListingStatus,
  type LostReason,
  type PlacementStage,
  type TenantStatus,
  type TransitionSource,
} from '../lib/statusModel.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import { type PlacementItem, type PlacementsRepo } from '../repos/placementsRepo.js';
import {
  soonestDeadline,
  type PlacementDeadlinesRepo,
} from '../repos/placementDeadlinesRepo.js';
import { type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';

/**
 * The RTA submission hard clock (Post-Tour & Application): entering
 * `awaiting_landlord_submission` gives the landlord 48h to submit the RTA.
 */
const RTA_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface StatusTransitionDeps {
  placementsRepo: PlacementsRepo;
  /** First-class placement deadlines (placement-deadline-model): arm/retire/clear. */
  placementDeadlinesRepo: PlacementDeadlinesRepo;
  unitsRepo: UnitsRepo;
  contactsRepo: ContactsRepo;
  auditRepo: AuditRepo;
  events: EventBus;
  logger?: Logger;
  /**
   * OPTIONAL best-effort hook (Post-Tour & Application): re-key the stage-keyed
   * application nudge ladder to `toStage` on every placement move. Receives the
   * POST-transition placement + the transition `nowIso`. A failure is caught +
   * logged and NEVER fails the transition; absent, the transition is unchanged.
   */
  armStageNudge?: (placement: PlacementItem, toStage: PlacementStage, nowIso: string) => Promise<void>;
  /**
   * OPTIONAL best-effort hook (Post-Tour & Application): close the placement's
   * masked relay thread when the deal is LOST. Invoked ONLY on a move to `lost`,
   * with the POST-transition placement. Best-effort like `armStageNudge`.
   */
  closeRelayForLostPlacement?: (placement: PlacementItem) => Promise<void>;
  /** Contact-timeline milestone emitter (best-effort). Optional — absent in legacy callers. */
  activityEventsRepo?: ActivityEventsRepo;
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
  /**
   * The LANDLORD-scheduled inspection date (Approval & Move-in). Supplied on the
   * move INTO the inspection wait — the transition OUT of `schedule_inspection` —
   * and written onto the placement as `inspection_date`. Ignored on any other move.
   */
  inspectionDate?: string;
  /**
   * The authority's DETERMINED rent (Approval & Move-in). Supplied on the move OUT
   * of `determine_rent` and written onto the placement as `rent_determined`.
   * Distinct from `finalRent` (the ACCEPTED amount). Ignored on any other move.
   */
  rentDetermined?: number;
  /** The acting user (userId) — indexed onto the audit row's byActor GSI (§8). */
  actor?: string;
}

export interface SetTenantStatusInput {
  /**
   * The target contact status. Despite the route/method name, this setter is the
   * ONE explicit contact-status write for ALL contact types — a tenant's §5
   * lifecycle (TenantStatus) OR a landlord's lead lifecycle (LandlordStatus,
   * e.g. interested/parked). The ROUTE validates the value against the stored
   * contact's type-scoped allowlist (statusModel.statusAllowlistFor) before it
   * reaches here; this setter writes it generically onto the unified `status`.
   */
  toStatus: TenantStatus | LandlordStatus;
  source: TransitionSource;
  /**
   * Free-text reason for the change. Audit-logged for every move; ALSO persisted
   * onto the contact as `park_reason` when `toStatus === 'parked'` (a landlord
   * decline/not-a-fit/never-signed terminal — docs/issues/landlord-lead-status-
   * and-park.md).
   */
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
  /** Explicit property-status write. */
  setListingStatus(unitId: string, input: SetListingStatusInput): Promise<UnitItem>;
  /**
   * Best-effort derive coarse tenant+property statuses for a stage (override-gated,
   * source 'derived'). Used by placement CREATE (a non-transition). Never throws.
   */
  deriveForStage(tenantId: string, unitId: string, stage: PlacementStage): Promise<void>;
}

export function createStatusTransitionService(
  deps: StatusTransitionDeps,
): StatusTransitionService {
  const { placementsRepo, placementDeadlinesRepo, unitsRepo, contactsRepo, auditRepo, events } = deps;
  const { armStageNudge, closeRelayForLostPlacement, activityEventsRepo } = deps;
  const log = deps.logger ?? defaultLogger;

  const statusLabel = (contactType: string | undefined, status: string): string =>
    (contactType === 'landlord'
      ? (LANDLORD_STATUS_LABELS as Record<string, string>)[status]
      : (TENANT_STATUS_LABELS as Record<string, string>)[status]) ?? status;

  // Best-effort contact-timeline milestone on a REAL status change. Never throws
  // out of the operator action; PII-safe log (ids/type only, never the label).
  async function recordStatusMilestone(contactId: string, contactType: string | undefined, to: string): Promise<void> {
    if (!activityEventsRepo || typeof contactId !== 'string' || contactId.length === 0) return;
    try {
      await activityEventsRepo.record({ contactId, type: 'contact_status_changed', label: `Status → ${statusLabel(contactType, to)}` });
    } catch (err) {
      log.error({ err, contactId }, 'contact_status_changed milestone record failed (best-effort)');
    }
  }

  // Best-effort placement stage milestone on a REAL stage move. A terminal move
  // posts `placement_closed` (with the VALIDATED lost CATEGORY only — never the
  // free text); a non-terminal move posts `stage_changed`. Never throws out of
  // the transition; PII-safe log (ids only, never the label).
  async function recordStageMilestone(
    tenantId: string,
    placementId: string,
    toStage: PlacementStage,
    lostCategory: string | undefined,
    lostHasText: boolean,
  ): Promise<void> {
    if (!activityEventsRepo || typeof tenantId !== 'string' || tenantId.length === 0) return;
    try {
      if (TERMINAL_STAGES.has(toStage)) {
        const reason = lostCategory && lostCategory.length > 0 ? ` - ${lostCategory}` : (lostHasText ? ' - reason on file' : '');
        await activityEventsRepo.record({ contactId: tenantId, type: 'placement_closed', label: `Placement closed - ${STAGE_LABELS[toStage]}${reason}`, refType: 'placement', refId: placementId });
      } else {
        await activityEventsRepo.record({ contactId: tenantId, type: 'stage_changed', label: `Stage → ${STAGE_LABELS[toStage]}`, refType: 'placement', refId: placementId });
      }
    } catch (err) {
      log.error({ err, placementId }, 'placement stage milestone record failed (best-effort)');
    }
  }

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
      // Contact-timeline milestone on the DERIVED status change (guards above
      // already skipped override-pinned + no-op). A landlord is never on the
      // derived tenant path, so contact.type keys the tenant labels correctly.
      await recordStatusMilestone(tenantId, contact.type, toStatus);
    } catch (err) {
      log.error({ err, tenantId }, 'derivation: tenant status write failed (best-effort)');
    }
  }

  /**
   * Derived PROPERTY-status write — symmetric to deriveTenantStatus (override set
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

  return {
    async transitionPlacement(placementId, input) {
      const { toStage, source, reason, lostReason, finalRent, inspectionOutcome, inspectionDate, rentDetermined, actor } = input;
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

      // Approval & Move-in: the LANDLORD-scheduled inspection date is recorded on
      // the move INTO the inspection wait (OUT of `schedule_inspection`), the same
      // "captured on the relevant move" shape as inspection_outcome/final_rent.
      if (from === 'schedule_inspection' && inspectionDate !== undefined) {
        if (typeof inspectionDate !== 'string' || inspectionDate.length === 0) {
          throw new TransitionRefusedError('bad_inspection_date', 'inspectionDate must be a non-empty date string');
        }
        patch.inspection_date = inspectionDate;
      }
      // The authority's DETERMINED rent is recorded on the move OUT of
      // `determine_rent`. Distinct from final_rent (the ACCEPTED amount written to
      // the unit on the awaiting_rent_acceptance exit, unchanged below).
      if (from === 'determine_rent' && rentDetermined !== undefined) {
        if (!Number.isFinite(rentDetermined) || rentDetermined <= 0) {
          throw new TransitionRefusedError('bad_rent_determined', 'rentDetermined must be a finite number > 0');
        }
        patch.rent_determined = rentDetermined;
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

      // 3b) Contact-timeline milestone on a REAL stage move (idempotent: only when
      // the stage actually changed). Reads the VALIDATED stored lost reason
      // (updated.lost_reason) — category ONLY, never the free text — mirroring
      // placements.ts. Best-effort: never fails the transition.
      if (from !== updated.stage) {
        await recordStageMilestone(
          existing.tenantId,
          placementId,
          toStage,
          updated.lost_reason?.category,
          typeof updated.lost_reason?.text === 'string' && updated.lost_reason.text.length > 0,
        );
      }

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

      // 5) Derivation (§7). For `lost`, bounce tenant→searching / property→
      //    available ONLY when no OTHER active (non-terminal) placement exists
      //    on that tenant/unit; otherwise the existing derivation stands.
      if (toStage === 'lost') {
        const tenantClear = await noOtherActivePlacement(existing.tenantId, placementId, 'tenant');
        const unitClear = await noOtherActivePlacement(existing.unitId, placementId, 'unit');
        const derived = deriveStatuses('lost'); // searching / available
        // The lost-bounce is a DERIVED write: it goes through the SAME shared
        // helpers as applyDerivation, so it inherits the identical override-gate
        // (a manually On-hold/Inactive tenant or On-hold/Off-market property STAYS
        // pinned), the no-op guard, and the {from,to,source:'derived'} audit.
        // Only clear the side that has no OTHER active placement.
        if (tenantClear) await deriveTenantStatus(existing.tenantId, derived.tenantStatus);
        if (unitClear) await deriveListingStatus(existing.unitId, derived.listingStatus);
      } else {
        await applyDerivation(existing.tenantId, existing.unitId, deriveStatuses(toStage));
      }

      // 6) Deadline items (placement-deadline-model). Each deadline type is its
      // OWN placementDeadlines row keyed by (placement, type), so arming/retiring
      // one NEVER touches another — the old single-slot clobber arbitration is
      // gone. The internal "stuck" signal is NOT a deadline here: it is DERIVED
      // from time-in-stage in today.ts, so it fires independently of any hard
      // clock and nothing is armed for it.
      //   - Terminal → clear ALL of the placement's deadlines (a closed deal has
      //     no live clocks; belt to today.ts's read-time TERMINAL skip).
      //   - Entering awaiting_landlord_submission → arm the rta_window 48h clock.
      //   - Leaving awaiting_landlord_submission → retire the stage-scoped
      //     rta_window (it exists only WHILE the placement sits in that stage).
      // voucher_expiration is TENANT-level (contact-edit / create-path), NOT
      // stage-scoped, so a stage move never re-arms or retires it here.
      if (TERMINAL_STAGES.has(toStage)) {
        await placementDeadlinesRepo.clearForPlacement(placementId);
      } else if (toStage === 'awaiting_landlord_submission') {
        await placementDeadlinesRepo.arm(
          placementId,
          'rta_window',
          new Date(Date.parse(now) + RTA_WINDOW_MS).toISOString(),
        );
      } else if (from === 'awaiting_landlord_submission') {
        await placementDeadlinesRepo.retire(placementId, 'rta_window');
      }

      // 7) Best-effort choke-point hooks (Post-Tour & Application). Both OPTIONAL
      // and wrapped so a hook failure NEVER fails the transition. They run AFTER
      // the stage patch + derived writes, on the POST-transition placement.
      //  - closeRelayForLostPlacement: close the masked relay thread on a lost deal.
      //  - armStageNudge: re-key the stage-application nudge ladder to the new stage.
      if (toStage === 'lost' && closeRelayForLostPlacement !== undefined) {
        try {
          await closeRelayForLostPlacement(updated);
        } catch (err) {
          log.error({ err, placementId }, 'lost relay-close hook failed (best-effort)');
        }
      }
      if (armStageNudge !== undefined) {
        try {
          await armStageNudge(updated, toStage, now);
        } catch (err) {
          log.error({ err, placementId }, 'stage-nudge arm hook failed (best-effort)');
        }
      }

      // Emit + log (the legacy CRUD path emits placement.updated; mirror it, no PII).
      // Attach the COMPUTED soonest deadline (the flat wire shape is preserved;
      // its source is now the placementDeadlines items, not a stored slot).
      mergeContext({ placementId });
      const final = (await placementsRepo.getById(placementId)) ?? updated;
      const deadlines = await placementDeadlinesRepo.listByPlacement(placementId);
      events.emit('placement.updated', toPlacementUpdatedEvent(final, soonestDeadline(deadlines)));
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
      // park_reason (docs/issues/landlord-lead-status-and-park.md): the move to
      // the terminal `parked` (a landlord decline/not-a-fit/never-signed) captures
      // the supplied reason as a first-class field on the contact. Only written on
      // the `parked` move — other statuses leave any existing park_reason untouched.
      if (toStatus === 'parked' && reason !== undefined) patch.park_reason = reason;
      const updated = await contactsRepo.update(contactId, patch);

      await auditRepo.append(`contacts#${contactId}`, 'tenant_status_changed', {
        ...(actor !== undefined && { actor }),
        from,
        to: toStatus,
        source,
        ...(reason !== undefined && { reason }),
      });
      // Contact-timeline milestone on a REAL status change (explicit path). The
      // type-keyed label map picks LANDLORD_STATUS_LABELS vs TENANT_STATUS_LABELS.
      if (from !== toStatus) await recordStatusMilestone(contactId, contact.type, toStatus);
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

    async deriveForStage(tenantId, unitId, stage) {
      // Create is a NON-transition: it has no from-stage and offers no terminal,
      // so (unlike transitionPlacement's `lost` branch) there is no
      // no-other-active-placement gate — we derive deriveStatuses(stage) straight
      // through the SAME override-gated, no-op-gated, best-effort, {from,to,
      // source:'derived'}-audited helpers (parity with transitionPlacement step 5).
      await applyDerivation(tenantId, unitId, deriveStatuses(stage));
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
