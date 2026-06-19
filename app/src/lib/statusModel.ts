// THE centralized status-model knowledge (STATUS-MODEL.md §9): the ONE ordered
// stage list, the phase map, the display-label map, the derivation map, the
// terminal set, the tenant/listing status enums, the transition-source
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
// SCOPE NOTE: the workflow record is the `case` entity in code/data (CaseItem,
// casesRepo, caseId). "Placement" is the DOMAIN label for that record (per the
// glossary/STATUS-MODEL.md); the future `case`→`placement` rename is OUT OF
// SCOPE — "placement" appears here only in human-facing names, never as a code
// identifier that touches the data layer.

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
  awaiting_receipt: 'Awaiting receipt',
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

// --- Listing lifecycle (coarse, mostly derived; §6) -------------------------
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
 * The ONLY publicly-shareable listing status (§6: `available` gates the public
 * flyer). Kept here so the central model owns it; unitsRepo re-exports it.
 */
export const SHAREABLE: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['available']);

// --- Transition sources + precedence (§8) -----------------------------------
// `derived` (from the placement) is the LOWEST precedence; an explicit
// manual/ai/automation/import write pins and wins (last-writer-wins among the
// non-derived sources). A `derived` write applies ONLY when the stored source
// is `derived` or unset.
export const TRANSITION_SOURCES = ['derived', 'import', 'automation', 'ai', 'manual'] as const;

export type TransitionSource = (typeof TRANSITION_SOURCES)[number];

const TRANSITION_SOURCE_SET: ReadonlySet<string> = new Set(TRANSITION_SOURCES);

/**
 * Source precedence rank. `derived` is strictly lowest (0); ALL non-derived
 * sources are equal-rank (1) — last-writer-wins among them. A new `derived`
 * write may overwrite a stored value ONLY when the stored value is `derived` or
 * unset (see services/statusTransition.ts `applyDerivation`).
 */
export const SOURCE_PRECEDENCE: Readonly<Record<TransitionSource, number>> = {
  derived: 0,
  import: 1,
  automation: 1,
  ai: 1,
  manual: 1,
};

/**
 * Whether a write FROM `incoming` may overwrite a value last written by
 * `stored` (undefined stored source = unset, treated as lowest). A non-derived
 * incoming always wins (last-writer-wins); a derived incoming wins ONLY over an
 * unset/derived stored source.
 */
export function canOverwrite(
  incoming: TransitionSource,
  stored: TransitionSource | undefined,
): boolean {
  if (incoming !== 'derived') return true; // explicit write always pins/wins
  // derived: applies only when nothing has pinned the value yet.
  return stored === undefined || stored === 'derived';
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

// --- Derivation (§7): placement phase/stage → coarse tenant/listing statuses -
/** The derived coarse statuses a placement in a given phase/stage implies. */
export interface DerivedStatuses {
  tenantStatus: TenantStatus;
  listingStatus: ListingStatus;
}

/**
 * Derive the coarse tenant + listing statuses implied by a placement stage
 * (§7 table). `lost` resolves to the "bounce back" pair (tenant→searching,
 * listing→available) — but the SERVICE applies it ONLY when no OTHER active
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
  // Contract + Administrative ⇒ listing Finalizing (tenant still Placing).
  if (phase === 'Contract' || phase === 'Administrative') {
    return { tenantStatus: 'placing', listingStatus: 'finalizing' };
  }
  // Application … Rent Determination ⇒ tenant Placing, listing Under application.
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

export function isListingStatus(x: unknown): x is ListingStatus {
  return typeof x === 'string' && LISTING_STATUS_SET.has(x);
}

export function isLostReasonCategory(x: unknown): x is LostReasonCategory {
  return typeof x === 'string' && LOST_REASON_CATEGORY_SET.has(x);
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
