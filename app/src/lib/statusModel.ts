// THE centralized status-model knowledge (STATUS-MODEL.md §9): the ONE ordered
// stage list, the phase map, the display-label map, the derivation map, the
// terminal set, the tenant/property status enums, the transition-source
// precedence, the lost-reason categories, and the per-stage stuck thresholds.
//
// Pure constants/maps/guards — NO I/O. Every status transition routes through
// services/statusTransition.ts, which reads ONLY from here, so a model change
// (add/reorder/relabel a stage, retune a threshold, change a derivation) lands
// in exactly one place (§9: "Keep all stage knowledge centralized").
//
// CASING: stored stage keys are snake_case (the `byStage` GSI partition key is
// already snake_case, e.g. `rta_submitted`). Human labels live ONLY in the
// label maps below — never re-derive a label from a key at a call site.
//
// NAMING: the workflow record is the `placement` entity in code/data
// (PlacementItem, placementsRepo, placementId), matching the glossary/
// STATUS-MODEL.md domain label.

// --- Placement phases (board columns; Title Case display) -------------------
// Ordered glance-level columns (§4). `RTA` is an acronym and stays all-caps.
export const PLACEMENT_PHASES = [
  'Application',
  'RTA',
  'Inspection',
  'Rent Determination',
  'Contract',
  'Administrative',
  'Closure',
] as const;

export type PlacementPhase = (typeof PLACEMENT_PHASES)[number];

// --- Placement stages (THE ordered stage list; snake_case stored keys) ------
// One flat ordered ladder (§4). This is NOT a strict state machine — stages can
// be skipped/jumped, and `lost` is reachable from ANY stage (§4, §9). The two
// terminals (`moved_in`, `lost`) sit at the end.
export const PLACEMENT_STAGES = [
  // Application
  'send_application',
  'awaiting_receipt',
  'awaiting_completion',
  'awaiting_approval',
  // RTA
  'collect_rta',
  'review_rta',
  'send_rta_to_landlord',
  'awaiting_landlord_submission',
  'awaiting_authority_approval',
  // Inspection
  'schedule_inspection',
  'awaiting_inspection',
  // Rent Determination
  'determine_rent',
  'awaiting_rent_acceptance',
  // Contract
  'awaiting_hap_contract',
  // Administrative
  'complete_paperwork',
  // Closure
  'awaiting_move_in',
  'moved_in', // ✓ terminal
  'lost', // ✕ terminal (reachable from any stage)
] as const;

export type PlacementStage = (typeof PLACEMENT_STAGES)[number];

const PLACEMENT_STAGE_SET: ReadonlySet<string> = new Set(PLACEMENT_STAGES);

/** stage → its phase (the board column it belongs to). */
export const STAGE_PHASE: Readonly<Record<PlacementStage, PlacementPhase>> = {
  send_application: 'Application',
  awaiting_receipt: 'Application',
  awaiting_completion: 'Application',
  awaiting_approval: 'Application',
  collect_rta: 'RTA',
  review_rta: 'RTA',
  send_rta_to_landlord: 'RTA',
  awaiting_landlord_submission: 'RTA',
  awaiting_authority_approval: 'RTA',
  schedule_inspection: 'Inspection',
  awaiting_inspection: 'Inspection',
  determine_rent: 'Rent Determination',
  awaiting_rent_acceptance: 'Rent Determination',
  awaiting_hap_contract: 'Contract',
  complete_paperwork: 'Administrative',
  awaiting_move_in: 'Closure',
  moved_in: 'Closure',
  lost: 'Closure',
};

/**
 * stage → sentence-case display label (§2 naming conventions). Only `RTA`/`HAP`
 * stay all-caps; everything else is sentence-case (first word capitalized).
 * The only past-tense labels in the system are the two terminals.
 */
export const STAGE_LABELS: Readonly<Record<PlacementStage, string>> = {
  send_application: 'Send application',
  awaiting_receipt: 'Awaiting receipt confirmation',
  awaiting_completion: 'Awaiting completion',
  awaiting_approval: 'Awaiting approval',
  collect_rta: 'Collect RTA',
  review_rta: 'Review RTA',
  send_rta_to_landlord: 'Send RTA to landlord',
  awaiting_landlord_submission: 'Awaiting landlord submission',
  awaiting_authority_approval: 'Awaiting authority approval',
  schedule_inspection: 'Schedule inspection',
  awaiting_inspection: 'Awaiting inspection',
  determine_rent: 'Determine rent',
  awaiting_rent_acceptance: 'Awaiting rent acceptance',
  awaiting_hap_contract: 'Awaiting HAP contract',
  complete_paperwork: 'Complete paperwork',
  awaiting_move_in: 'Awaiting move-in',
  moved_in: 'Moved in', // ✓ terminal (past tense by design)
  lost: 'Lost', // ✕ terminal (past tense by design)
};

/** Terminal stages — a placement here is no longer active on the boards. */
export const TERMINAL_STAGES: ReadonlySet<PlacementStage> = new Set<PlacementStage>([
  'moved_in',
  'lost',
]);

// --- Inspection outcome (§4: the Inspection phase carries a pass/fail) -------
// A first-class pass/fail result recorded on the placement when the inspection
// completes (the move OUT of `awaiting_inspection`). The model is NOT a strict
// state machine — a `fail` does NOT force a particular next stage; the admin
// routes the card (reschedule, → lost, etc.). Stored on the placement as the
// snake_case flexible-doc attribute `inspection_outcome`.
export const INSPECTION_OUTCOMES = ['pass', 'fail'] as const;

export type InspectionOutcome = (typeof INSPECTION_OUTCOMES)[number];

const INSPECTION_OUTCOME_SET: ReadonlySet<string> = new Set(INSPECTION_OUTCOMES);

// --- Tenant lifecycle (coarse; §5) ------------------------------------------
// These are the values a TENANT contact's single `status` field holds (the one
// type-scoped lifecycle, NOT a second field — see contactsRepo.ContactItem.status
// and STATUS-MODEL.md §5). Non-tenant contacts use needs_review|active instead.
// `porting` is a SEPARATE boolean flag on the tenant, never a status value.
export const TENANT_STATUSES = [
  'needs_review',
  'onboarding',
  'searching',
  'placing',
  'placed',
  'on_hold',
  'inactive',
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

const TENANT_STATUS_SET: ReadonlySet<string> = new Set(TENANT_STATUSES);

export const TENANT_STATUS_LABELS: Readonly<Record<TenantStatus, string>> = {
  needs_review: 'Needs review',
  onboarding: 'Onboarding',
  searching: 'Searching',
  placing: 'Placing',
  placed: 'Placed',
  on_hold: 'On hold',
  inactive: 'Inactive',
};

// --- Landlord lead lifecycle (type=landlord) --------------------------------
// A landlord contact carries its own lead lifecycle on the SAME `status` field
// tenants use (type-scoped — STATUS-MODEL §5 / docs/issues/landlord-lead-status-
// and-park.md). `needs_review` is the auto-capture/triage front door; a lead
// worth pursuing is `interested`; a SIGNED landlord whose properties we are
// bringing in is `onboarding`; a landlord with onboarded properties is `active`;
// a declined/not-a-fit/backed-out lead is the terminal `parked` (with a
// `park_reason` captured on the move, reachable from ANY state). Landlord
// statuses are DISJOINT from tenant-only values (on_hold/inactive/searching/...):
// a landlord must never be pushed into a tenant lifecycle state (the
// `/tenant-status` type-guard leak this set closes).
export const LANDLORD_STATUSES = ['needs_review', 'interested', 'onboarding', 'active', 'parked'] as const;

export type LandlordStatus = (typeof LANDLORD_STATUSES)[number];

const LANDLORD_STATUS_SET: ReadonlySet<string> = new Set(LANDLORD_STATUSES);

export const LANDLORD_STATUS_LABELS: Readonly<Record<LandlordStatus, string>> = {
  needs_review: 'Needs review',
  interested: 'Interested',
  onboarding: 'Onboarding',
  active: 'Active',
  parked: 'Parked',
};

/**
 * Status allowlist for contact types WITHOUT a lifecycle (team_member/unknown):
 * the simple `needs_review` (auto-capture stub) → `active` (resolved). Tenant and
 * landlord have their own richer lifecycles above; see {@link statusAllowlistFor}.
 */
export const NON_TENANT_STATUSES = ['needs_review', 'active'] as const;

/**
 * The single source of truth for the type-scoped status allowlist. A TENANT
 * carries its §5 lifecycle (TENANT_STATUSES); a LANDLORD carries the lead
 * lifecycle (LANDLORD_STATUSES); every other type (team_member/unknown) carries
 * the simple needs_review|active. Used by BOTH status-setting paths (the generic
 * contact PATCH and the `/tenant-status` transition route) so a landlord can
 * never be pushed into a tenant-only state.
 */
export function statusAllowlistFor(type: string | undefined): readonly string[] {
  if (type === 'tenant') return TENANT_STATUSES;
  if (type === 'landlord') return LANDLORD_STATUSES;
  return NON_TENANT_STATUSES;
}

// --- Property lifecycle (coarse, mostly derived; §6) -------------------------
export const LISTING_STATUSES = [
  'setup',
  'available',
  'under_application',
  'finalizing',
  'occupied',
  'on_hold',
  'off_market',
] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];

const LISTING_STATUS_SET: ReadonlySet<string> = new Set(LISTING_STATUSES);

export const LISTING_STATUS_LABELS: Readonly<Record<ListingStatus, string>> = {
  setup: 'Setup',
  available: 'Available',
  under_application: 'Under application',
  finalizing: 'Finalizing',
  occupied: 'Occupied',
  on_hold: 'On hold',
  off_market: 'Off market',
};

/**
 * The ONLY publicly-shareable property status (§6: `available` gates the public
 * flyer). Kept here so the central model owns it; unitsRepo re-exports it.
 */
export const SHAREABLE: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['available']);

// --- Transition sources + precedence (§8) -----------------------------------
// `*_source` is recorded for PROVENANCE/audit on every status write (who/what
// last wrote the value). It NO LONGER gates derivation: per the 2026-06-19
// decision (docs/issues/status-pin-vs-terminal-derivation.md) derivation is
// gated on the entity's current STATE, not its source — only OVERRIDE/exit
// states pin against derivation (see the override-state sets below), while
// baseline progression states stay derivation-eligible regardless of who last
// wrote them. The source enum + precedence rank are kept purely for audit.
export const TRANSITION_SOURCES = ['derived', 'import', 'automation', 'ai', 'manual'] as const;

export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

const TRANSITION_SOURCE_SET: ReadonlySet<string> = new Set(TRANSITION_SOURCES);

/**
 * Source precedence rank, kept for PROVENANCE/audit only (NOT a derivation
 * gate). `derived` is lowest (0); ALL non-derived sources are equal-rank (1).
 * Derivation gating is now STATE-based (see {@link isListingOverrideStatus} /
 * {@link isTenantOverrideStatus}), so this rank no longer decides whether a
 * derived write applies — it is retained so the source ordering stays
 * inspectable for audit/provenance.
 */
export const SOURCE_PRECEDENCE: Readonly<Record<TransitionSource, number>> = {
  derived: 0,
  import: 1,
  automation: 1,
  ai: 1,
  manual: 1,
};

// --- Override/exit states that PIN against derivation (§5/§6) ---------------
// The 2026-06-19 decision: derivation is gated on the entity's current STATE,
// not its source. A `derived` write (from placement→tenant/property derivation)
// MAY overwrite the entity's current status UNLESS the current status is one of
// these OVERRIDE/exit states, in which case the derived write is BLOCKED (the
// state is "pinned"). All BASELINE progression states (property: setup,
// available, under_application, finalizing, occupied; tenant: needs_review,
// onboarding, searching, placing, placed) stay derivation-eligible regardless
// of who last wrote them. Override/exit states are only ever produced by
// EXPLICIT writes — derivation never outputs them (see deriveStatuses /
// PLACEMENT_DERIVATION, asserted in the model test).
//
// Property overrides/exit (§6: "ovr: On hold", "term: Off market").
export const LISTING_OVERRIDE_STATES: ReadonlySet<ListingStatus> = new Set<ListingStatus>([
  'on_hold',
  'off_market',
]);

// Tenant overrides/exit (§5: "overrides: On hold", "terminal: Inactive").
export const TENANT_OVERRIDE_STATES: ReadonlySet<TenantStatus> = new Set<TenantStatus>([
  'on_hold',
  'inactive',
]);

/** True when a property status PINS against derivation (an override/exit state). */
export function isListingOverrideStatus(s: ListingStatus | undefined): boolean {
  return s !== undefined && LISTING_OVERRIDE_STATES.has(s);
}

/** True when a tenant status PINS against derivation (an override/exit state). */
export function isTenantOverrideStatus(s: TenantStatus | undefined): boolean {
  return s !== undefined && TENANT_OVERRIDE_STATES.has(s);
}

// --- Lost reason categories (§7: pick OR free-write) ------------------------
export const LOST_REASON_CATEGORIES = [
  'stalled',
  'no_contact',
  'landlord_lost_rent',
  'landlord_lost_inspection',
  'tenant_withdrew',
  'voucher_expired',
  'other',
] as const;

export type LostReasonCategory = (typeof LOST_REASON_CATEGORIES)[number];

const LOST_REASON_CATEGORY_SET: ReadonlySet<string> = new Set(LOST_REASON_CATEGORIES);

// --- Per-stage "stuck too long" thresholds (§8 time-in-stage; §9 tunable) ---
// FOUNDER-TUNABLE engineering defaults (see docs/issues/stuck-case-thresholds-
// need-tuning.md). Values are MILLISECONDS; the day counts are documented
// inline. Terminal stages have NO threshold (a closed placement never nudges).
const DAY_MS = 24 * 60 * 60 * 1000;

export const STAGE_STUCK_THRESHOLDS: Readonly<Partial<Record<PlacementStage, number>>> = {
  send_application: 3 * DAY_MS,
  awaiting_receipt: 5 * DAY_MS,
  awaiting_completion: 7 * DAY_MS,
  awaiting_approval: 7 * DAY_MS,
  collect_rta: 5 * DAY_MS,
  review_rta: 3 * DAY_MS,
  send_rta_to_landlord: 3 * DAY_MS,
  awaiting_landlord_submission: 7 * DAY_MS,
  awaiting_authority_approval: 10 * DAY_MS,
  schedule_inspection: 5 * DAY_MS,
  awaiting_inspection: 10 * DAY_MS,
  determine_rent: 5 * DAY_MS,
  awaiting_rent_acceptance: 7 * DAY_MS,
  awaiting_hap_contract: 14 * DAY_MS,
  complete_paperwork: 10 * DAY_MS,
  awaiting_move_in: 14 * DAY_MS,
  // moved_in / lost: terminal, no threshold.
};

// --- Derivation (§7): placement phase/stage → coarse tenant/property statuses -
/** The derived coarse statuses a placement in a given phase/stage implies. */
export interface DerivedStatuses {
  tenantStatus: TenantStatus;
  listingStatus: ListingStatus;
}

/**
 * Derive the coarse tenant + property statuses implied by a placement stage
 * (§7 table). `lost` resolves to the "bounce back" pair (tenant→searching,
 * property→available) — but the SERVICE applies it ONLY when no OTHER active
 * placement exists on that tenant/unit (see statusTransition.ts). The derived
 * value is the lowest-precedence input; an explicit pin still wins (§8).
 */
export function deriveStatuses(stage: PlacementStage): DerivedStatuses {
  if (stage === 'moved_in') {
    return { tenantStatus: 'placed', listingStatus: 'occupied' };
  }
  if (stage === 'lost') {
    return { tenantStatus: 'searching', listingStatus: 'available' };
  }
  const phase = STAGE_PHASE[stage];
  // Contract + Administrative + Closure (Awaiting move-in) ⇒ property Finalizing
  // (tenant still Placing). `moved_in`/`lost` already returned above, so the only
  // Closure stage reaching here is the non-terminal `awaiting_move_in` — a deal in
  // final move-in prep is Finalizing, not Under application (§3/§6 property lifecycle).
  if (phase === 'Contract' || phase === 'Administrative' || phase === 'Closure') {
    return { tenantStatus: 'placing', listingStatus: 'finalizing' };
  }
  // Application … Rent Determination ⇒ tenant Placing, property Under application.
  return { tenantStatus: 'placing', listingStatus: 'under_application' };
}

/**
 * The full stage→derivation map, materialized from deriveStatuses for every
 * stage (§7). Exported as PLACEMENT_DERIVATION so the model's derivation
 * knowledge is a single inspectable table (the service still calls
 * deriveStatuses for the run-time decision).
 */
export const PLACEMENT_DERIVATION: Readonly<Record<PlacementStage, DerivedStatuses>> =
  Object.fromEntries(PLACEMENT_STAGES.map((s) => [s, deriveStatuses(s)])) as Record<
    PlacementStage,
    DerivedStatuses
  >;

// --- Type guards / helpers --------------------------------------------------

/** Is `x` a known placement stage (route allowlist for the byStage key)? */
export function isPlacementStage(x: unknown): x is PlacementStage {
  return typeof x === 'string' && PLACEMENT_STAGE_SET.has(x);
}

export function isTenantStatus(x: unknown): x is TenantStatus {
  return typeof x === 'string' && TENANT_STATUS_SET.has(x);
}

export function isLandlordStatus(x: unknown): x is LandlordStatus {
  return typeof x === 'string' && LANDLORD_STATUS_SET.has(x);
}

export function isListingStatus(x: unknown): x is ListingStatus {
  return typeof x === 'string' && LISTING_STATUS_SET.has(x);
}

export function isLostReasonCategory(x: unknown): x is LostReasonCategory {
  return typeof x === 'string' && LOST_REASON_CATEGORY_SET.has(x);
}

export function isInspectionOutcome(x: unknown): x is InspectionOutcome {
  return typeof x === 'string' && INSPECTION_OUTCOME_SET.has(x);
}

export function isTransitionSource(x: unknown): x is TransitionSource {
  return typeof x === 'string' && TRANSITION_SOURCE_SET.has(x);
}

/** The phase a stage belongs to (undefined for an unknown stage). */
export function phaseForStage(stage: string): PlacementPhase | undefined {
  return isPlacementStage(stage) ? STAGE_PHASE[stage] : undefined;
}

/** Structured Lost reason (§7): a category pick AND/OR free text. */
export interface LostReason {
  category?: LostReasonCategory;
  text?: string;
}
