// history.ts — deterministic lifecycle-history generator for the FULL seed profile.
//
// The clean-slate seed sets every entity to its END state but wrote almost no
// lifecycle *history* (whole seed = 2 audit_events + 4 activity_events), so three
// dashboard history surfaces render blank (research §SEED-GAP):
//   • Placement "History" panel      ← audit_events `placements#<id>`
//   • Property "Activity" card       ← audit_events `units#<id>`
//   • Contact Timeline milestones    ← activity_events (Task 2 — not here)
//
// This module is a PURE POST-PASS over the assembled FULL item map. It walks each
// entity's canonical enum (statusModel.ts — never a hardcoded list) from the start
// element to its current one, one hop per consecutive pair, and emits AUDIT rows
// that FAITHFULLY MIRROR what services/statusTransition.ts writes at runtime:
//   • placement hop  → `placements#<id>` `placement_stage_changed`
//                      {actor?, from, to, source, reason?, lost_reason_category?}
//   • derived tenant → `contacts#<tenantId>` `tenant_status_changed` {from,to,source:'derived'} (NO actor)
//   • derived unit   → `units#<unitId>`      `listing_status_changed` {from,to,source:'derived'} (NO actor)
//   • unit publish   → `units#<unitId>`      `listing_status_changed` {from:'setup',to:'available',source:'manual',actor}
//   • standalone contact status ladder → `contacts#<id>` `tenant_status_changed` (setTenantStatus is the ONE
//     status write for ALL contact types — tenant AND landlord — so a landlord status change ALSO emits
//     `tenant_status_changed`, verified at routes/statusTransition.ts:190→service setTenantStatus:383).
//
// DETERMINISM: no Math.random / no `new Date()` in the generator core. Timestamps
// walk BACKWARD from each entity's stored anchor via a plausible per-stage duration
// table, so the FINAL hop equals the anchor and earlier hops strictly increase
// before it (§4.2). Fixed anchors (lean/cast/matrix) ⇒ byte-stable rows; a later
// live caller (Task 3) injects now-relative anchors and gets now-relative rows for
// free by calling the SAME per-entity generators (entityHistory / *History).
//
// SK shape mirrors auditRepo.append: `<ISO>#<8hex>` (deterministic hash here, not a
// random UUID) so rows on one entityKey sort correctly under the newest-first
// (ScanIndexForward:false) read. `actorId` is hoisted from `payload.actor` exactly
// as auditRepo.append does (omitted for derived/system rows).
//
// SINGLE SOURCE OF TRUTH (§4.7): in the full profile this module OWNS all
// lifecycle-class rows — historyItems() supersedes the pre-existing hand-authored
// lifecycle rows (lean's one placement_stage_changed) via dedupe, while leaving
// non-lifecycle rows (lean's dead contact.profile_edited) untouched. The LEAN
// profile never calls this module, so its byte-stable world is preserved.

import {
  PLACEMENT_STAGES,
  TENANT_STATUSES,
  LANDLORD_STATUSES,
  LISTING_STATUSES,
  STAGE_LABELS,
  TERMINAL_STAGES,
  deriveStatuses,
  type PlacementStage,
  type TenantStatus,
  type ListingStatus,
} from '../statusModel.js';
import { TOUR_STATUS_LABELS, type TourStatus } from '../toursModel.js';

// ---------------------------------------------------------------------------
// Row shape (mirrors auditRepo.AuditEvent / what auditRepo.append writes)
// ---------------------------------------------------------------------------

export interface AuditRow {
  entityKey: string;
  /** SK: `<ISO>#<8hex>` — chronological string sort, collision-safe (auditRepo shape). */
  ts: string;
  event_type: string;
  /** byActor GSI hash, hoisted from payload.actor; absent for system/derived rows. */
  actorId?: string;
  payload: Record<string, unknown>;
  // Index signature so an AuditRow[] flows into the seedAll `tables` map (whose
  // values are Record<string, unknown>[]) without a lossy cast — matches auditRepo.AuditEvent.
  [key: string]: unknown;
}

/** The three lifecycle-trail event_types this module OWNS in the full profile (§4.7). */
export const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'placement_stage_changed',
  'tenant_status_changed',
  'listing_status_changed',
]);

/**
 * The tour lifecycle audit event_types this module OWNS on `tours#<tourId>` in
 * the full profile. MIRRORS the live writer's recordTourEvent set + the
 * group-opened / converted milestones (routes/tours.ts, routes/placements.ts)
 * AND the dashboard's tourActivityFormat.ts TOUR_EVENT_LABELS keys - seeded
 * rows use ONLY these so no unknown-type fallback ever renders. Used for the
 * entity-scoped supersede of pre-existing tours# rows in historyItems.
 */
export const TOUR_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'tour_scheduled',
  'tour_rescheduled',
  'tour_took_place',
  'tour_no_show',
  'tour_canceled',
  'tour_outcome',
  'tour_group_opened',
  'tour_converted',
]);

// ---------------------------------------------------------------------------
// Activity-milestone row shape (mirrors activityEventsRepo.ActivityEventItem —
// what activityEventsRepo.record persists; PK contactId, SK `<ISO at>#<eventId>`).
// These feed the Contact Timeline "milestone" items (research §SURFACES.2).
// ---------------------------------------------------------------------------

export interface ActivityRow {
  /** PK — the contact this milestone belongs to. */
  contactId: string;
  /** SK — `<ISO at>#<eventId>` (chronological, paginates backward). */
  tsEventId: string;
  /** Deterministic `evt-…` id (NOT random — byte-stable, mirrors matrix's evt-mx-…). */
  eventId: string;
  /** ISO 8601 — when the milestone happened (the timeline sort key). */
  at: string;
  /** ActivityEventType (activityEventsRepo.ts:33). */
  type: string;
  /** Human label as the REAL writer formats it (never invented). */
  label: string;
  /** Deep-link target type (activityEventsRepo ActivityEventRefType). */
  refType?: string;
  refId?: string;
  /** ISO 8601 — audit furniture; matrix seeds this equal to `at`, we mirror that. */
  created_at: string;
  // Index signature so an ActivityRow[] flows into the seedAll `tables` map.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Fixed constants
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The pinned seed actor for MANUAL hops (matches lean.ts's audit rows, which use
 * the founder user-0001 as the acting user). Derived/system rows carry NO actor.
 */
const SEED_ACTOR = 'user-0001';

/**
 * Plausible per-stage durations (DAYS spent IN a stage before advancing OUT of it,
 * §4.2). Used to space hop timestamps by walking backward from the anchor. Terminal
 * stages never act as a "from" for a real hop, so their value is unused (0).
 */
const STAGE_DURATION_DAYS: Readonly<Record<PlacementStage, number>> = {
  send_application: 2,
  awaiting_receipt: 3,
  awaiting_completion: 4,
  awaiting_approval: 5,
  collect_rta: 3,
  review_rta: 2,
  send_rta_to_landlord: 2,
  awaiting_landlord_submission: 5,
  awaiting_authority_approval: 7,
  schedule_inspection: 4,
  awaiting_inspection: 8,
  determine_rent: 3,
  awaiting_rent_acceptance: 4,
  awaiting_hap_contract: 10,
  complete_paperwork: 5,
  awaiting_move_in: 7,
  moved_in: 0,
  lost: 0,
};

/** A unit is published (setup → available) this many days before its placement is created. */
const PUBLISH_GAP_DAYS = 3;

/**
 * A `lost` placement's plausible "lost-from" stage, keyed by lost-reason category
 * (§4.3 — a lost placement walks an active prefix then → lost). Deterministic and
 * realistic (e.g. a failed inspection dies at `awaiting_inspection`).
 */
const LOST_FROM_STAGE: Readonly<Record<string, PlacementStage>> = {
  no_contact: 'awaiting_receipt',
  stalled: 'awaiting_landlord_submission',
  voucher_expired: 'awaiting_authority_approval',
  tenant_withdrew: 'schedule_inspection',
  landlord_lost_inspection: 'awaiting_inspection',
  landlord_lost_rent: 'awaiting_rent_acceptance',
  other: 'send_rta_to_landlord',
};
const LOST_FROM_DEFAULT: PlacementStage = 'send_rta_to_landlord';

// Tenant linear progression (the first 5 of TENANT_STATUSES; on_hold/inactive are
// override branches, NOT linear — statusModel TENANT_OVERRIDE_STATES).
const TENANT_LINEAR = TENANT_STATUSES.filter((s) => s !== 'on_hold' && s !== 'inactive');
const TENANT_OVERRIDES: ReadonlySet<string> = new Set(['on_hold', 'inactive']);
/** Where an on_hold/inactive tenant branched from (a searching tenant put on hold). */
const TENANT_BRANCH_FROM = 'searching';
const TENANT_STATUS_DURATION_DAYS: Readonly<Record<string, number>> = {
  needs_review: 1,
  onboarding: 4,
  searching: 6,
  placing: 7,
  placed: 0,
  on_hold: 0,
  inactive: 0,
};

// Landlord linear progression (needs_review -> interested -> onboarding -> active;
// parked is a branch off 'interested').
const LANDLORD_LINEAR = LANDLORD_STATUSES.filter((s) => s !== 'parked');
const LANDLORD_OVERRIDES: ReadonlySet<string> = new Set(['parked']);
const LANDLORD_BRANCH_FROM = 'interested';
const LANDLORD_STATUS_DURATION_DAYS: Readonly<Record<string, number>> = {
  needs_review: 1,
  interested: 5,
  onboarding: 4,
  active: 0,
  parked: 0,
};

// Non-tenant/non-landlord contacts (team_member/unknown): needs_review → active.
const OTHER_LINEAR = ['needs_review', 'active'] as const;
const OTHER_STATUS_DURATION_DAYS: Readonly<Record<string, number>> = {
  needs_review: 2,
  active: 0,
};

// Listing progression (setup → available → under_application → finalizing → occupied;
// on_hold/off_market are override branches — LISTING_OVERRIDE_STATES).
const LISTING_LINEAR = LISTING_STATUSES.filter((s) => s !== 'on_hold' && s !== 'off_market');
const LISTING_OVERRIDES: ReadonlySet<string> = new Set(['on_hold', 'off_market']);
const LISTING_BRANCH_FROM = 'available';
const LISTING_STATUS_DURATION_DAYS: Readonly<Record<string, number>> = {
  setup: 3,
  available: 6,
  under_application: 8,
  finalizing: 6,
  occupied: 0,
  on_hold: 0,
  off_market: 0,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Deterministic 8-hex FNV-1a hash — the byte-stable analog of append's uuid8 suffix. */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Build the SK `<ISO>#<8hex>`; the hash seeds off the row identity so it's stable + unique. */
function sk(isoTs: string, seed: string): string {
  return `${isoTs}#${hash8(seed)}`;
}

/**
 * Given an anchor ISO (the FINAL step's timestamp) and the per-hop gap in days
 * (gapDays[k] = days between step k and step k+1), return each step's ISO with the
 * final == anchor and all earlier strictly increasing before it. `steps = gapDays.length + 1`.
 */
function hopTimestamps(anchorIso: string, gapDays: number[]): string[] {
  const anchorMs = Date.parse(anchorIso);
  const n = gapDays.length + 1;
  const ms = new Array<number>(n);
  ms[n - 1] = anchorMs;
  for (let k = n - 2; k >= 0; k--) {
    ms[k] = ms[k + 1]! - gapDays[k]! * DAY_MS;
  }
  return ms.map((m) => new Date(m).toISOString());
}

/** Construct one audit row, hoisting payload.actor → top-level actorId (auditRepo parity). */
function makeRow(
  entityKey: string,
  isoTs: string,
  eventType: string,
  payload: Record<string, unknown>,
): AuditRow {
  const actor = payload['actor'];
  const actorId = typeof actor === 'string' ? actor : undefined;
  const seed = `${entityKey}|${eventType}|${isoTs}|${String(payload['from'] ?? '')}|${String(payload['to'] ?? '')}`;
  return {
    entityKey,
    ts: sk(isoTs, seed),
    event_type: eventType,
    ...(actorId !== undefined && { actorId }),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Per-entity generators (also the live-reuse surface — Task 3)
// ---------------------------------------------------------------------------

/**
 * The placement's full audit trail: `placement_stage_changed` rows over the
 * canonical stage walk, PLUS the interleaved DERIVED tenant/unit side-effects that
 * `applyDerivation` fires at runtime, PLUS the unit's `setup → available` publish
 * hop. Faithful mirror of statusTransition.transitionPlacement's writes.
 *
 * The stage walk is `PLACEMENT_STAGES.slice(0, idx+1)` for a non-`lost` target (so
 * `moved_in` walks the whole active ladder + `→ moved_in`); a `lost` target walks a
 * plausible active prefix (by lost-reason category) then `→ lost` with
 * `lost_reason_category` on the final hop.
 *
 * Derived rows compare deriveStatuses() across the walk (baseline tenant
 * `needs_review`, baseline unit `available` = freshly published) and emit ONLY on a
 * genuine flip — matching the service's no-op skip. They share the stage-entry
 * timestamp of the hop that caused them (the create instant for the first flip).
 */
/** The shared stage-walk + per-hop instant computation (§4.6). */
interface PlacementWalk {
  placementId: string;
  tenantId: string;
  unitId: string;
  /** The ordered stage sequence from the start element to the current one. */
  walk: PlacementStage[];
  /** T[k] = ISO instant the placement entered walk[k]; T[last] == the stored anchor. */
  T: string[];
  /** The lost-reason category (present only for a `lost` placement that has one). */
  lostCategory?: string;
}

/**
 * ONE stage-walk + per-hop instant computation, shared by BOTH the audit trail
 * (placementHistory) and the timeline milestones (placementMilestones), so the
 * two surfaces tell one coherent, SAME-CLOCK story (§4.6): each milestone's `at`
 * equals the matching audit hop instant because they are the same `T[k]`. The
 * walk is `PLACEMENT_STAGES.slice(0, idx+1)` for a non-`lost` target; a `lost`
 * target walks a plausible active prefix (by lost-reason category) then `→ lost`.
 * Returns null for a pointer/invalid placement.
 */
function placementWalk(placement: Record<string, unknown>): PlacementWalk | null {
  const placementId = String(placement['placementId'] ?? '');
  const tenantId = String(placement['tenantId'] ?? '');
  const unitId = String(placement['unitId'] ?? '');
  const stage = String(placement['stage'] ?? '') as PlacementStage;
  const anchor = String(placement['stage_entered_at'] ?? placement['created_at'] ?? '');
  if (placementId === '' || anchor === '' || PLACEMENT_STAGES.indexOf(stage) < 0) return null;

  const category = (placement['lost_reason'] as Record<string, unknown> | undefined)?.['category'];
  let walk: PlacementStage[];
  if (stage === 'lost') {
    const lostFrom =
      (typeof category === 'string' && LOST_FROM_STAGE[category]) || LOST_FROM_DEFAULT;
    const prefix = PLACEMENT_STAGES.slice(0, PLACEMENT_STAGES.indexOf(lostFrom) + 1) as PlacementStage[];
    walk = [...prefix, 'lost'];
  } else {
    walk = PLACEMENT_STAGES.slice(0, PLACEMENT_STAGES.indexOf(stage) + 1) as PlacementStage[];
  }
  // Timestamp each stage entry, anchored to stage_entered_at, spaced by durations.
  const gapDays = walk.slice(0, -1).map((s) => Math.max(1, STAGE_DURATION_DAYS[s] || 1));
  const T = hopTimestamps(anchor, gapDays); // T[k] = entered walk[k]; T[last] = anchor
  return {
    placementId,
    tenantId,
    unitId,
    walk,
    T,
    ...(typeof category === 'string' && { lostCategory: category }),
  };
}

export function placementHistory(placement: Record<string, unknown>): AuditRow[] {
  const w = placementWalk(placement);
  if (w === null) return [];
  const { placementId, tenantId, unitId, walk, T, lostCategory } = w;

  const rows: AuditRow[] = [];

  // 3) placement_stage_changed rows (one per consecutive pair).
  for (let k = 0; k < walk.length - 1; k++) {
    const from = walk[k]!;
    const to = walk[k + 1]!;
    const payload: Record<string, unknown> = { actor: SEED_ACTOR, from, to, source: 'manual' };
    if (to === 'lost' && typeof lostCategory === 'string') {
      payload['lost_reason_category'] = lostCategory;
    }
    rows.push(makeRow(`placements#${placementId}`, T[k + 1]!, 'placement_stage_changed', payload));
  }

  // 4) Unit publish hop (setup → available, manual) — the unit was published BEFORE
  //    the placement was created (baseline for derivation = 'available').
  const publishIso = new Date(Date.parse(T[0]!) - PUBLISH_GAP_DAYS * DAY_MS).toISOString();
  if (unitId !== '') {
    rows.push(
      makeRow(`units#${unitId}`, publishIso, 'listing_status_changed', {
        actor: SEED_ACTOR,
        from: 'setup',
        to: 'available',
        source: 'manual',
      }),
    );
  }

  // 5) DERIVED side-effects: walk the derived-status sequence and emit on each flip.
  //    Baselines: tenant needs_review (pre-placement), unit available (just published).
  let prevTenant: TenantStatus | 'needs_review' = 'needs_review';
  let prevUnit: ListingStatus = 'available';
  for (let k = 0; k < walk.length; k++) {
    const d = deriveStatuses(walk[k]!);
    if (tenantId !== '' && d.tenantStatus !== prevTenant) {
      rows.push(
        makeRow(`contacts#${tenantId}`, T[k]!, 'tenant_status_changed', {
          from: prevTenant,
          to: d.tenantStatus,
          source: 'derived',
        }),
      );
      prevTenant = d.tenantStatus;
    }
    if (unitId !== '' && d.listingStatus !== prevUnit) {
      rows.push(
        makeRow(`units#${unitId}`, T[k]!, 'listing_status_changed', {
          from: prevUnit,
          to: d.listingStatus,
          source: 'derived',
        }),
      );
      prevUnit = d.listingStatus;
    }
  }

  return rows;
}

/**
 * A NON-placement-linked contact's status ladder on `contacts#<id>`. A contact with
 * no driving placement can only reach a non-start status by an explicit MANUAL
 * write (setTenantStatus — derivation requires a placement), so every hop is
 * `source:'manual'` with the seed actor. Override branches (tenant on_hold/inactive,
 * landlord parked) show the linear prefix then the branch hop. `park_reason` rides
 * the parked hop as `reason` — the exact field setTenantStatus logs (park_reason is
 * persisted onto the contact, NOT into the audit payload).
 *
 * event_type is always `tenant_status_changed` — the shared setter emits it for
 * EVERY contact type (tenant AND landlord). Returns [] for a contact still at its
 * start status (needs_review) or a non-status pointer row.
 */
export function standaloneContactHistory(contact: Record<string, unknown>): AuditRow[] {
  const contactId = String(contact['contactId'] ?? '');
  const status = contact['status'];
  if (contactId === '' || contactId.startsWith('phoneref#') || typeof status !== 'string') return [];

  const type = String(contact['type'] ?? '');
  let linear: readonly string[];
  let overrides: ReadonlySet<string>;
  let branchFrom: string;
  let durations: Readonly<Record<string, number>>;
  if (type === 'tenant') {
    linear = TENANT_LINEAR;
    overrides = TENANT_OVERRIDES;
    branchFrom = TENANT_BRANCH_FROM;
    durations = TENANT_STATUS_DURATION_DAYS;
  } else if (type === 'landlord') {
    linear = LANDLORD_LINEAR;
    overrides = LANDLORD_OVERRIDES;
    branchFrom = LANDLORD_BRANCH_FROM;
    durations = LANDLORD_STATUS_DURATION_DAYS;
  } else {
    linear = OTHER_LINEAR;
    overrides = new Set<string>();
    branchFrom = 'needs_review';
    durations = OTHER_STATUS_DURATION_DAYS;
  }

  // Build the ladder up to the stored status.
  let ladder: string[];
  if (overrides.has(status)) {
    const branchIdx = linear.indexOf(branchFrom);
    ladder = [...linear.slice(0, branchIdx + 1), status];
  } else {
    const idx = linear.indexOf(status);
    if (idx < 0) return []; // unknown status → no trail
    ladder = linear.slice(0, idx + 1);
  }
  if (ladder.length < 2) return []; // at start (needs_review only) → no trail

  const anchor = String(contact['consent_at'] ?? contact['created_at'] ?? '');
  if (anchor === '') return [];
  const gapDays = ladder.slice(0, -1).map((s) => Math.max(1, durations[s] || 1));
  const T = hopTimestamps(anchor, gapDays);

  const parkReason = contact['park_reason'];
  const rows: AuditRow[] = [];
  for (let k = 0; k < ladder.length - 1; k++) {
    const from = ladder[k]!;
    const to = ladder[k + 1]!;
    const payload: Record<string, unknown> = { actor: SEED_ACTOR, from, to, source: 'manual' };
    if (to === 'parked' && typeof parkReason === 'string' && parkReason.length > 0) {
      payload['reason'] = parkReason;
    }
    rows.push(makeRow(`contacts#${contactId}`, T[k + 1]!, 'tenant_status_changed', payload));
  }
  return rows;
}

/**
 * A NON-placement-linked unit's status ladder on `units#<id>`. The `setup →
 * available` publish hop is the one explicit manual write; the progression hops
 * (available → under_application → finalizing → occupied) are `source:'derived'`
 * (no actor) — they normally trail a placement, and a placement-less unit that
 * nonetheless sits at a progression state was previously placed. Override branches
 * (on_hold/off_market) are a manual hop after the publish. Returns [] for a `setup`
 * unit (still at start).
 */
export function standaloneUnitHistory(unit: Record<string, unknown>): AuditRow[] {
  const unitId = String(unit['unitId'] ?? '');
  const status = unit['status'];
  if (unitId === '' || typeof status !== 'string' || status === 'setup') return [];

  const listingLinear = LISTING_LINEAR as readonly string[];
  let ladder: string[];
  if (LISTING_OVERRIDES.has(status)) {
    const branchIdx = listingLinear.indexOf(LISTING_BRANCH_FROM);
    ladder = [...listingLinear.slice(0, branchIdx + 1), status];
  } else {
    const idx = listingLinear.indexOf(status);
    if (idx < 0) return [];
    ladder = listingLinear.slice(0, idx + 1);
  }
  if (ladder.length < 2) return [];

  const anchor = String(unit['created_at'] ?? unit['updatedAt'] ?? '');
  if (anchor === '') return [];
  const gapDays = ladder.slice(0, -1).map((s) => Math.max(1, LISTING_STATUS_DURATION_DAYS[s] || 1));
  const T = hopTimestamps(anchor, gapDays);

  const rows: AuditRow[] = [];
  for (let k = 0; k < ladder.length - 1; k++) {
    const from = ladder[k]!;
    const to = ladder[k + 1]!;
    // setup→available is the manual publish; an available→override branch is manual;
    // available→under_application→finalizing→occupied are derived progression.
    const manual = from === 'setup' || LISTING_OVERRIDES.has(to);
    const payload: Record<string, unknown> = manual
      ? { actor: SEED_ACTOR, from, to, source: 'manual' }
      : { from, to, source: 'derived' };
    rows.push(makeRow(`units#${unitId}`, T[k + 1]!, 'listing_status_changed', payload));
  }
  return rows;
}

/** Dispatcher for live reuse (Task 3): run the right per-entity generator by kind. */
export function entityHistory(
  entity: Record<string, unknown>,
  ctx: { kind: 'placement' | 'contact' | 'unit' },
): AuditRow[] {
  switch (ctx.kind) {
    case 'placement':
      return placementHistory(entity);
    case 'contact':
      return standaloneContactHistory(entity);
    case 'unit':
      return standaloneUnitHistory(entity);
  }
}

// ---------------------------------------------------------------------------
// Activity-milestone generators (Contact Timeline surface, §4.6) — FAITHFUL
// MIRRORS of the real writers' type/label/refType (never invented):
//   • placement_opened  routes/placements.ts:465  ("Placement opened", ref placement)
//   • stage_changed     routes/placements.ts:556  ("Stage → <label>",  ref placement)
//   • placement_closed  routes/placements.ts:552  ("Placement closed - <stage>[ - <cat>]")
//   • listing_sent      jobs/broadcastFanOut.ts:309 ("Property sent", ref unit)
//   • number_added      routes/contacts.ts:1473    ("Number added", no ref)
//   • tour_scheduled/tour_took_place — tours emit NO milestone at runtime today
//     (research §WRITE-SHAPES.3: tour_took_place retired, tour_scheduled only from the
//     legacy placement tour_date path). We materialize them directly from the tour
//     entity so a tenant's timeline reflects their tour journey; labels follow the
//     legacy `Tour scheduled - <date>` shape (placements.ts:565) and the repo's own
//     documented `Tour took place - Toured` example (activityEventsRepo.ts:59).
// Deterministic evt-* ids (hash8 of row identity) — the byte-stable analog of the
// repo's random `evt-<uuid>`, extending matrix's deterministic evt-mx-… pattern.
// ---------------------------------------------------------------------------

/**
 * Construct one activity-milestone row with a deterministic evt-* id (byte-stable).
 * `salt` disambiguates rows that would otherwise share every id input — e.g. two
 * non-primary phones added at the same instant on one contact (same contactId/type/
 * at/label, no ref) would collide on eventId → one silently overwrites the other on
 * Put. It is appended to the id hash ONLY when provided, so every existing caller
 * (no salt) keeps its historical byte-stable eventId unchanged.
 */
function makeActivityRow(
  contactId: string,
  at: string,
  type: string,
  label: string,
  ref?: { refType: string; refId: string },
  salt?: string,
): ActivityRow {
  const idParts = [contactId, type, at, ref?.refId ?? '', label];
  if (salt !== undefined) idParts.push(salt);
  const eventId = `evt-${hash8(idParts.join('|'))}`;
  return {
    contactId,
    tsEventId: `${at}#${eventId}`,
    eventId,
    at,
    type,
    label,
    ...(ref !== undefined && { refType: ref.refType, refId: ref.refId }),
    created_at: at,
  };
}

/**
 * The terminal-stage `Placement closed - …` reason suffix, CATEGORY-ONLY — a
 * verbatim mirror of routes/placements.ts:539-548 (never fold the free text, which
 * is PII, into a stored label; when only text exists use the static "reason on file").
 */
function closedReasonSuffix(placement: Record<string, unknown>, stage: PlacementStage): string {
  if (stage !== 'lost') return '';
  const lr = placement['lost_reason'];
  if (typeof lr !== 'object' || lr === null) return '';
  const cat = (lr as Record<string, unknown>)['category'];
  const text = (lr as Record<string, unknown>)['text'];
  const reasonText =
    typeof cat === 'string' && cat.length > 0
      ? cat
      : typeof text === 'string' && text.length > 0
        ? 'reason on file'
        : '';
  return reasonText.length > 0 ? ` - ${reasonText}` : '';
}

/**
 * A placement-linked tenant's milestone timeline: `placement_opened` at hop 0
 * (the create instant), a `stage_changed` at each non-terminal stage entry, and a
 * `placement_closed` at a terminal (`moved_in`/`lost`). Each `at` is the SAME
 * `T[k]` the audit trail uses (placementWalk), so the person-timeline and the
 * placement drawer share one clock (§4.6). Returns [] for a pointer/invalid placement.
 */
export function placementMilestones(placement: Record<string, unknown>): ActivityRow[] {
  const w = placementWalk(placement);
  if (w === null || w.tenantId === '') return [];
  const { placementId, tenantId, walk, T } = w;
  const ref = { refType: 'placement', refId: placementId };
  const rows: ActivityRow[] = [];
  // POST /api/placements → placement_opened on the tenant's timeline (create instant).
  rows.push(makeActivityRow(tenantId, T[0]!, 'placement_opened', 'Placement opened', ref));
  // Each subsequent stage entry → the PATCH milestone (stage_changed, or a terminal close).
  for (let k = 1; k < walk.length; k++) {
    const stage = walk[k]!;
    const at = T[k]!;
    if (TERMINAL_STAGES.has(stage)) {
      const reason = closedReasonSuffix(placement, stage);
      rows.push(
        makeActivityRow(tenantId, at, 'placement_closed', `Placement closed - ${STAGE_LABELS[stage]}${reason}`, ref),
      );
    } else {
      rows.push(makeActivityRow(tenantId, at, 'stage_changed', `Stage → ${STAGE_LABELS[stage]}`, ref));
    }
  }
  return rows;
}

/**
 * Tour statuses in which the tenant PHYSICALLY toured (a `tour_took_place`
 * milestone is warranted). `no_show`/`canceled` did NOT take place;
 * `scheduled` has not yet. `closed` follows a real tour, so it counts.
 */
const TOUR_TOOK_PLACE: ReadonlySet<TourStatus> = new Set<TourStatus>(['toured', 'closed']);

/**
 * A tour-owning tenant's milestones: `tour_scheduled` once the tour has a
 * scheduled time (a timeless `requested` tour → none), and `tour_took_place` when
 * the tour actually happened (toured/closed). Keyed on the tour's `tenantId`.
 * refType `tour` (the tour itself) — mirrors the real writer recordTourEvent
 * (routes/tours.ts), so the milestone deep-links to /tours/<id>, not the property.
 */
export function tourMilestones(tour: Record<string, unknown>): ActivityRow[] {
  const tenantId = String(tour['tenantId'] ?? '');
  const tourId = String(tour['tourId'] ?? '');
  const status = String(tour['status'] ?? '') as TourStatus;
  const scheduledAt = tour['scheduledAt'];
  const createdAt = String(tour['createdAt'] ?? tour['updatedAt'] ?? '');
  if (tenantId === '' || !(status in TOUR_STATUS_LABELS)) return [];
  const hasSchedule = typeof scheduledAt === 'string' && scheduledAt.length > 0;
  if (!hasSchedule) return []; // requested (timeless) → no scheduled/took-place milestones
  const ref = tourId !== '' ? { refType: 'tour', refId: tourId } : undefined;
  const rows: ActivityRow[] = [];
  // The booking happened at tour creation (these seed tours are created already-
  // scheduled); label follows the legacy `Tour scheduled - <date>` shape.
  const bookedAt = createdAt !== '' ? createdAt : scheduledAt;
  rows.push(
    makeActivityRow(tenantId, bookedAt, 'tour_scheduled', `Tour scheduled - ${scheduledAt.slice(0, 10)}`, ref),
  );
  if (TOUR_TOOK_PLACE.has(status)) {
    // The tour happened at its scheduled time; label = the `toured` transition.
    rows.push(
      makeActivityRow(tenantId, scheduledAt, 'tour_took_place', `Tour took place - ${TOUR_STATUS_LABELS['toured']}`, ref),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tour audit-trail generator (`tours#<tourId>` rows) - the tour detail page's
// own lifecycle history (GET /api/tours/:id/activity), interleaved into all
// three conversation panes + the Activity card. FAITHFUL MIRROR of the live
// writer's event vocabulary + per-status sequences (spec section 3, derived
// from recordTourEvent + group-opened/converted call sites). NO actor - these
// are archive writes describing actions the API never ran (same posture as the
// seeded reminder rows that carry sentAt directly). The instants agree with
// tourMilestones (booking = createdAt, took_place = scheduledAt) so the tenant
// timeline and the tour trail tell one same-clock story.
// ---------------------------------------------------------------------------

/** A small fixed spacing used to place appendix rows strictly after the visit. */
const TOUR_APPENDIX_OFFSET_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * One seeded tour's `tours#<tourId>` audit trail. Per-status base sequence
 * (spec section 3):
 *   requested -> [] scheduling rows (timeless create emits nothing) - but the
 *                group_opened appendix STILL applies: the provisioning route has
 *                NO status gate (only the double-provision 409), so a requested
 *                tour with a provisioned group carries exactly [tour_group_opened]
 *   scheduled -> [tour_scheduled @ booking]
 *   toured    -> [tour_scheduled @ booking, tour_took_place @ scheduledAt]
 *   no_show   -> [tour_scheduled @ booking, tour_no_show  @ scheduledAt]
 *   canceled  -> [tour_scheduled @ booking, tour_canceled @ cancel instant]
 *   closed    -> [tour_scheduled @ booking, tour_took_place @ scheduledAt]  (a closed tour happened)
 * PLUS per-field appendices:
 *   groupThreadId        -> tour_group_opened @ booking, { tourId, conversationId }
 *                           (ANY status incl. requested, where booking = createdAt)
 *   outcome              -> tour_outcome @ outcome instant (after took_place;
 *                           unreachable on requested - the exit gate 409s unless toured)
 *   convertedPlacementId -> tour_converted @ conversion instant, { tourId, placementId }
 *                           (unreachable on requested - conversion requires toured)
 *
 * Instants: booking = createdAt (createdAt <= booking < scheduledAt); took_place/
 * no_show = scheduledAt; canceled = the row's own canceledAt when present else a
 * deterministic instant between booking and scheduledAt (never after scheduledAt);
 * outcome = updatedAt when later than scheduledAt else scheduledAt + a small fixed
 * offset; converted = after the outcome/visit. Rows are emitted in monotonically
 * non-decreasing instant order with distinct SK suffixes (event_type differs, so
 * two rows sharing an instant get distinct hashes).
 *
 * Defensive: a tour with no tourId, an unknown status, or a non-requested status
 * lacking a scheduledAt contributes NO rows (seed guards own shape validation).
 */
export function tourTrail(tour: Record<string, unknown>): AuditRow[] {
  const tourId = String(tour['tourId'] ?? '');
  const status = String(tour['status'] ?? '');
  if (tourId === '' || !(status in TOUR_STATUS_LABELS)) return [];
  // requested is TIMELESS: zero SCHEDULING rows (the runtime writer emits
  // nothing on a timeless create) - but a provisioned group thread still has
  // its tour_group_opened row: the provisioning route has NO status gate (its
  // only guard is the double-provision 409). The outcome/converted appendices
  // are structurally unreachable here (exit gate / conversion require toured),
  // so a requested tour emits exactly [] or [tour_group_opened].
  if (status === 'requested') {
    const requestedGroupId = tour['groupThreadId'];
    if (typeof requestedGroupId !== 'string' || requestedGroupId.length === 0) return [];
    // The booking-equivalent instant on a timeless tour: its createdAt.
    const requestedAt = String(tour['createdAt'] ?? tour['updatedAt'] ?? '');
    const requestedMs = Date.parse(requestedAt);
    if (Number.isNaN(requestedMs)) return [];
    return [
      makeRow(`tours#${tourId}`, new Date(requestedMs).toISOString(), 'tour_group_opened', {
        tourId,
        conversationId: requestedGroupId,
      }),
    ];
  }

  const scheduledAtRaw = tour['scheduledAt'];
  const scheduledAt =
    typeof scheduledAtRaw === 'string' && scheduledAtRaw.length > 0 ? scheduledAtRaw : '';
  if (scheduledAt === '') return []; // non-requested tour without a schedule -> skip
  const schedMs = Date.parse(scheduledAt);
  if (Number.isNaN(schedMs)) return [];

  // booking = createdAt (mirror tourMilestones' fallback so the two align).
  const createdAt = String(tour['createdAt'] ?? tour['updatedAt'] ?? '');
  const booking = createdAt !== '' ? createdAt : scheduledAt;
  const bookingMs = Date.parse(booking);
  if (Number.isNaN(bookingMs)) return [];

  const entityKey = `tours#${tourId}`;

  // Build descriptors (instant + a stable priority to order same-instant rows),
  // then sort so the emitted array is monotonically non-decreasing.
  interface Desc {
    ms: number;
    prio: number;
    type: string;
    payload: Record<string, unknown>;
  }
  const descs: Desc[] = [];

  // tour_scheduled @ booking - every non-requested tour was booked.
  descs.push({ ms: bookingMs, prio: 0, type: 'tour_scheduled', payload: { tourId } });

  // group_opened appendix (at/near booking - the group is provisioned at
  // coordination time, before the visit). tours#-ONLY; no actor (archive write).
  const groupThreadId = tour['groupThreadId'];
  if (typeof groupThreadId === 'string' && groupThreadId.length > 0) {
    descs.push({
      ms: bookingMs,
      prio: 1,
      type: 'tour_group_opened',
      payload: { tourId, conversationId: groupThreadId },
    });
  }

  // Status body.
  if (status === 'toured' || status === 'closed') {
    descs.push({ ms: schedMs, prio: 2, type: 'tour_took_place', payload: { tourId } });
  } else if (status === 'no_show') {
    descs.push({ ms: schedMs, prio: 2, type: 'tour_no_show', payload: { tourId } });
  } else if (status === 'canceled') {
    const canceledAtRaw = tour['canceledAt'];
    let cancelMs =
      typeof canceledAtRaw === 'string' && canceledAtRaw.length > 0 && !Number.isNaN(Date.parse(canceledAtRaw))
        ? Date.parse(canceledAtRaw)
        : Math.floor((bookingMs + schedMs) / 2); // deterministic mid-instant
    if (cancelMs > schedMs) cancelMs = schedMs; // never after it would have happened
    if (cancelMs < bookingMs) cancelMs = bookingMs; // never before booking
    descs.push({ ms: cancelMs, prio: 2, type: 'tour_canceled', payload: { tourId } });
  }
  // scheduled: no body row beyond tour_scheduled.

  // outcome appendix (after took_place): updatedAt when later than scheduledAt,
  // else scheduledAt + a small fixed offset.
  const outcome = tour['outcome'];
  let outcomeMs: number | undefined;
  if (typeof outcome === 'string' && outcome.length > 0) {
    const updatedMs = Date.parse(String(tour['updatedAt'] ?? ''));
    outcomeMs =
      !Number.isNaN(updatedMs) && updatedMs > schedMs ? updatedMs : schedMs + TOUR_APPENDIX_OFFSET_MS;
    descs.push({ ms: outcomeMs, prio: 3, type: 'tour_outcome', payload: { tourId } });
  }

  // converted appendix (after took_place, the final chapter): after the outcome
  // instant when present, else after the visit.
  const convertedPlacementId = tour['convertedPlacementId'];
  if (typeof convertedPlacementId === 'string' && convertedPlacementId.length > 0) {
    const base = outcomeMs !== undefined ? outcomeMs : schedMs;
    descs.push({
      ms: base + TOUR_APPENDIX_OFFSET_MS,
      prio: 4,
      type: 'tour_converted',
      payload: { tourId, placementId: convertedPlacementId },
    });
  }

  descs.sort((a, b) => a.ms - b.ms || a.prio - b.prio);
  return descs.map((d) => makeRow(entityKey, new Date(d.ms).toISOString(), d.type, d.payload));
}

/**
 * A listing-send row -> a `listing_sent` milestone ("Property sent", ref unit),
 * anchored at the send's `sentAt`. Faithful to broadcastFanOut.ts:308 (send).
 */
export function listingSendMilestones(send: Record<string, unknown>): ActivityRow[] {
  const contactId = String(send['contactId'] ?? '');
  const unitId = String(send['unitId'] ?? '');
  const at = String(send['sentAt'] ?? send['created_at'] ?? '');
  if (contactId === '' || at === '') return [];
  const rows: ActivityRow[] = [];
  const ref = unitId !== '' ? { refType: 'unit', refId: unitId } : undefined;
  rows.push(makeActivityRow(contactId, at, 'listing_sent', 'Property sent', ref));
  return rows;
}

/**
 * A multi-phone contact → one `number_added` milestone per NON-primary number
 * ("Number added", no ref — routes/contacts.ts:1471-1474). The primary number is
 * the original capture, not an "add". Anchored at each phone's `firstSeenAt`
 * (falling back to the contact anchor). Single-phone contacts → [].
 */
export function contactPhoneMilestones(contact: Record<string, unknown>): ActivityRow[] {
  const contactId = String(contact['contactId'] ?? '');
  if (contactId === '' || contactId.startsWith('phoneref#')) return [];
  const phones = contact['phones'];
  if (!Array.isArray(phones) || phones.length < 2) return [];
  const anchor = String(contact['consent_at'] ?? contact['created_at'] ?? '');
  const rows: ActivityRow[] = [];
  phones.forEach((p, i) => {
    if (typeof p !== 'object' || p === null) return;
    const rec = p as Record<string, unknown>;
    if (rec['primary'] === true) return; // primary = original capture, not an "add"
    const at = String(rec['firstSeenAt'] ?? anchor);
    if (at === '') return;
    // Salt the id with the phone value + loop index so two non-primary phones that
    // share a firstSeenAt (or both fall back to the same anchor) yield DISTINCT
    // eventIds — otherwise they collide and one silently overwrites the other on Put.
    const salt = `${String(rec['phone'] ?? '')}#${i}`;
    rows.push(makeActivityRow(contactId, at, 'number_added', 'Number added', undefined, salt));
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Pure post-pass over the assembled FULL item map. Generates the lifecycle audit
 * trails for every placement (+ its derived tenant/unit side-effects), every
 * standalone (non-placement-linked) contact, and every standalone unit, then
 * DEDUPES against the pre-existing audit rows so this module is the single source
 * of truth for lifecycle-class rows (§4.7): pre-existing lifecycle-class rows are
 * dropped (superseded); all other pre-existing rows (e.g. lean's dead
 * contact.profile_edited) are preserved verbatim.
 *
 * `activity_events` (Task 2, §4.6): the person-centric Contact Timeline milestones
 * — placement_opened/stage_changed/placement_closed per placement (same clock as
 * the audit trail via placementWalk), tour_scheduled/tour_took_place per tour,
 * listing_sent per listing-send, number_added per multi-phone
 * contact. Superseded ENTITY-SCOPED against the pre-existing matrix rows (§4.7):
 * pre-existing activity rows are dropped for any contact this module covers, and
 * preserved for contacts it does not.
 */
export function historyItems(tables: Record<string, Record<string, unknown>[]>): {
  audit_events: AuditRow[];
  activity_events: ActivityRow[];
} {
  const placements = tables['placements'] ?? [];
  const contacts = tables['contacts'] ?? [];
  const units = tables['units'] ?? [];
  const tours = tables['tours'] ?? [];
  const listingSends = tables['listing_sends'] ?? [];
  const preAudit = tables['audit_events'] ?? [];
  const preActivity = tables['activity_events'] ?? [];

  const placementTenantIds = new Set(placements.map((p) => String(p['tenantId'] ?? '')));
  const placementUnitIds = new Set(placements.map((p) => String(p['unitId'] ?? '')));

  const generated: AuditRow[] = [];
  for (const p of placements) generated.push(...placementHistory(p));
  for (const c of contacts) {
    const id = String(c['contactId'] ?? '');
    if (id === '' || placementTenantIds.has(id)) continue; // placement-linked → derived trail already emitted
    generated.push(...standaloneContactHistory(c));
  }
  for (const u of units) {
    const id = String(u['unitId'] ?? '');
    if (id === '' || placementUnitIds.has(id)) continue; // placement-linked → derived trail already emitted
    generated.push(...standaloneUnitHistory(u));
  }
  // Tour lifecycle trails (`tours#<tourId>`) - every tour in the assembled map.
  for (const t of tours) generated.push(...tourTrail(t));

  // Dedupe: this module owns all lifecycle-class rows in the full profile — but only
  // for entities it actually regenerates. Drop a pre-existing lifecycle row ONLY when
  // the generator emitted at least one row for that same entityKey (its full trail
  // supersedes the hand-authored hop). A hand-authored lifecycle row on an entity the
  // generator produces NO rows for (e.g. a contact ending at needs_review → empty
  // trail) is preserved, so we never silently lose it. Non-lifecycle rows are always
  // kept verbatim.
  const regeneratedEntityKeys = new Set(generated.map((r) => r.entityKey));
  const keptPre = preAudit.filter((r) => {
    const type = String(r['event_type']);
    // Lifecycle-class rows (placement/tenant/unit trails) AND tour lifecycle
    // rows are OWNED here: a pre-existing one is superseded only for an entity
    // this pass actually regenerated; foreign rows are preserved verbatim.
    const isOwned = LIFECYCLE_EVENT_TYPES.has(type) || TOUR_EVENT_TYPES.has(type);
    return !isOwned || !regeneratedEntityKeys.has(String(r['entityKey']));
  }) as AuditRow[];

  // ---- activity_events (Contact Timeline milestones, §4.6) ----
  const generatedActivity: ActivityRow[] = [];
  for (const p of placements) generatedActivity.push(...placementMilestones(p));
  for (const t of tours) generatedActivity.push(...tourMilestones(t));
  for (const s of listingSends) generatedActivity.push(...listingSendMilestones(s));
  for (const c of contacts) generatedActivity.push(...contactPhoneMilestones(c));

  // Dedupe/supersede (§4.7): a pre-existing activity row is dropped for any contact
  // this module produced ≥1 milestone for (its regenerated timeline is authoritative);
  // pre-existing rows for contacts we do NOT cover are preserved verbatim.
  const coveredContactIds = new Set(generatedActivity.map((r) => r.contactId));
  const keptPreActivity = preActivity.filter(
    (r) => !coveredContactIds.has(String(r['contactId'])),
  ) as ActivityRow[];

  return {
    audit_events: [...keptPre, ...generated],
    activity_events: [...keptPreActivity, ...generatedActivity],
  };
}
