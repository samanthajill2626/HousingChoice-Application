// matrix.ts — deterministic coverage generators for the 'full' seed profile.
//
// Every enum value for placements (stages), units (listing statuses), tenants,
// landlords, and tours appears ≥2 times. IDs use a fixed pattern:
//   <entity>-mx-<state>-NN   e.g. tenant-mx-searching-01, placement-mx-send-application-01
// Names come from fixed pools (never Math.random).
//
// DATES: placements are NOW-RELATIVE and coherent by construction — matrixItems
// takes an injected `now` (as seedLive does) and derives every placement date
// from it (stage_entered_at, created_at, next_deadline_at, moved_in ordering).
// TOURS + their reminder ladders are ALSO now-relative (buildToursMatrix(now)):
// upcoming tours are future-dated with a pending day_before that never live-fires,
// past tours have all-terminal reminders — every instant derived from `now` by
// real date arithmetic. Given a fixed `now` the output is deterministic. All
// other standalone builders keep their fixed-past ISO constants.
//
// §7 tripwire: every placement's linked tenant + unit carry the status that
// deriveStatuses(stage) produces, with status_source:'derived'.
//
// Invariant: a 'requested' tour has ZERO reminder rows; a 'no_show' tour has a
// no_show_checkin reminder row with sentAt set (archive — written directly for
// historical tours since the reminder worker never ran for them).

import { PLACEMENT_STAGES, LISTING_STATUSES, TENANT_STATUSES, LANDLORD_STATUSES, STAGE_PHASE, STAGE_STUCK_THRESHOLDS, deriveStatuses, type PlacementStage, type PlacementPhase } from '../statusModel.js';
import { TOUR_STATUSES, type TourStatus } from '../toursModel.js';
import { deadlineIdFor } from '../../repos/placementDeadlinesRepo.js';

// ---------------------------------------------------------------------------
// Fixed past dates (byte-stable)
// ---------------------------------------------------------------------------
const D = {
  T0: '2026-01-01T10:00:00.000Z',
  T1: '2026-01-15T10:00:00.000Z',
  T2: '2026-02-01T10:00:00.000Z',
  T3: '2026-02-15T10:00:00.000Z',
  T4: '2026-03-01T10:00:00.000Z',
  T5: '2026-03-15T10:00:00.000Z',
  T6: '2026-04-01T10:00:00.000Z',
  T7: '2026-04-15T10:00:00.000Z',
  T8: '2026-05-01T10:00:00.000Z',
  T9: '2026-05-15T10:00:00.000Z',
  TA: '2026-05-20T10:00:00.000Z',
  TB: '2026-05-25T10:00:00.000Z',
};

// A pool of past timestamps to index by counter for variety
const PAST_DATES = Object.values(D);
const pastDate = (i: number) => PAST_DATES[i % PAST_DATES.length]!;

// ---------------------------------------------------------------------------
// Fixed name pools
// ---------------------------------------------------------------------------
const TENANT_FIRST = ['Amara', 'Devon', 'Priya', 'Kwame', 'Luz', 'Terrence', 'Nadia', 'Elijah', 'Fatima', 'Roland', 'Chloe', 'Darius', 'Ingrid', 'Moses', 'Vera', 'Clarence', 'Simone', 'Obinna', 'Harriet', 'Leroy'];
const TENANT_LAST = ['Osei', 'Brooks', 'Patel', 'Mensah', 'Reyes', 'Watson', 'Kim', 'Johnson', 'Hassan', 'Pierce', 'Grant', 'Ahmed', 'Lindqvist', 'Adeyemi', 'Cruz', 'Dupont', 'Winters', 'Eze', 'Young', 'Bailey'];
const LANDLORD_FIRST = ['Victor', 'Sandra', 'Douglas', 'Yvette', 'Curtis', 'Miriam', 'Walter', 'Sonia', 'Gerald', 'Diana', 'Bernard', 'Ursula', 'Raymond', 'Gladys', 'Chester'];
const LANDLORD_LAST = ['Holt', 'Figueroa', 'Chambers', 'Payne', 'Lawson', 'Ruiz', 'Fleming', 'Parks', 'Garrett', 'Walsh', 'Fitzgerald', 'Swann', 'Drummond', 'Lowe', 'Harrington'];

const firstName = (pool: string[], i: number) => pool[i % pool.length]!;
const lastName = (pool: string[], i: number) => pool[(i + 5) % pool.length]!;

// ---------------------------------------------------------------------------
// Fixed phone pools (matrices use +15550200XXX range; never collides with lean)
// ---------------------------------------------------------------------------
// Base phone numbers for contacts (not personas, no fake-twilio entry required)
const phoneBase = (n: number) => `+1555020${String(n).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// Housing authorities + addresses + beds + tour_process
// ---------------------------------------------------------------------------
const AUTHORITIES = ['atlanta_housing', 'ga_dca', 'dekalb_housing', 'fulton_housing', 'gwinnett_housing', 'cobb_housing'] as const;
type Authority = typeof AUTHORITIES[number];

const auth = (i: number): Authority => AUTHORITIES[i % AUTHORITIES.length]!;

const ADDRESSES = [
  '210 Auburn Ave NE, Atlanta, GA 30303',
  '1850 Campbellton Rd SW, Atlanta, GA 30311',
  '432 Memorial Dr SE, Atlanta, GA 30316',
  '700 Joe Frank Harris Pkwy, Cartersville, GA 30120',
  '55 Park Pl NE, Atlanta, GA 30303',
  '99 Piedmont Ave NE, Atlanta, GA 30309',
  '301 University Ave SW, Atlanta, GA 30310',
  '1200 Ralph D. Abernathy Blvd SW, Atlanta, GA 30310',
  '4500 Flat Shoals Pkwy, Decatur, GA 30034',
  '2200 Candler Rd, Decatur, GA 30032',
  '800 Glynn St N, Fayetteville, GA 30214',
  '505 Woodstock Rd, Roswell, GA 30075',
];
const addr = (i: number) => ADDRESSES[i % ADDRESSES.length]!;

const BED_SIZES = [1, 2, 3, 4] as const;
const beds = (i: number) => BED_SIZES[i % BED_SIZES.length]!;

const TOUR_PROCESSES = [
  'Self-guided lockbox; available Mon-Fri 9-5. Text to request code.',
  'Contact landlord at least 24h in advance to schedule a walkthrough.',
  'Property manager leads all tours; call to book.',
  'Self-guided with lockbox combo sent day of tour.',
  'Landlord-led; evenings and weekends available.',
  'PM team shows the unit; call office to set time.',
];
const tourProcess = (i: number) => TOUR_PROCESSES[i % TOUR_PROCESSES.length]!;

// ---------------------------------------------------------------------------
// Consent methods distributed on matrix contacts.
// All 8 ConsentMethod values must appear ≥1 in the full profile. Matrix
// guarantees all 8 independently — cast (Task 3) will also cover many of them
// (inbound_text/inbound_call/web_form/verbal_phone), but matrix doesn't rely
// on cast being implemented to satisfy the coverage test.
// ---------------------------------------------------------------------------
const MATRIX_CONSENT_METHODS = [
  'verbal_in_person',
  'paper_form',
  'imported',
  'client_inbound',
  'web_form',
  'inbound_text',
  'inbound_call',
  'verbal_phone',
] as const;
const matrixConsent = (i: number) => MATRIX_CONSENT_METHODS[i % MATRIX_CONSENT_METHODS.length]!;

// ---------------------------------------------------------------------------
// Deadline types
// ---------------------------------------------------------------------------
// The three live deadline types (placement-deadline-model): tour_reminder /
// stuck_placement are retired (tours are first-class; stuck is derived).
const DEADLINE_TYPES = ['rta_window', 'voucher_expiration', 'follow_up'] as const;
type DeadlineType = typeof DEADLINE_TYPES[number];

// A PLACEMENT deadline is never a tour_reminder — tours own that type. Making it
// a distinct type means the phase→type map below CANNOT even reference it.
type PlacementDeadlineType = Exclude<DeadlineType, 'tour_reminder'>;

/**
 * Phase → the deadline types that are plausible for a placement in that phase
 * (findings §A "deadline TYPE by phase"). Only the three LIVE deadline types
 * survive (placement-deadline-model): `tour_reminder` is a tours concept and
 * `stuck_placement` is now DERIVED from time-in-stage (never a stored deadline) —
 * both are structurally absent from PlacementDeadlineType. `rta_window` appears
 * ONLY in the RTA phase. Adding a new PlacementPhase is a typecheck error here —
 * coverage by construction.
 */
export const PHASE_DEADLINE_TYPES: Readonly<Record<PlacementPhase, readonly PlacementDeadlineType[]>> = {
  'Application': ['voucher_expiration', 'follow_up'],
  'RTA': ['rta_window', 'voucher_expiration', 'follow_up'],
  'Inspection': ['follow_up'],
  'Rent Determination': ['follow_up'],
  'Contract': ['follow_up'],
  'Administrative': ['follow_up'],
  'Closure': ['follow_up'],
};

// ---------------------------------------------------------------------------
// Now-relative date toolkit (deterministic given `now`)
// ---------------------------------------------------------------------------
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const daysAgo = (now: Date, d: number): string => new Date(now.getTime() - d * DAY_MS).toISOString();
const daysFromNow = (now: Date, d: number): string => new Date(now.getTime() + d * DAY_MS).toISOString();
const hoursFromNow = (now: Date, h: number): string => new Date(now.getTime() + h * HOUR_MS).toISOString();

/** Σ of the stuck thresholds of every stage strictly BEFORE `stage` in the ladder. */
function priorStagesBacklogMs(stage: PlacementStage): number {
  const idx = PLACEMENT_STAGES.indexOf(stage);
  let sum = 0;
  for (let i = 0; i < idx; i++) {
    sum += STAGE_STUCK_THRESHOLDS[PLACEMENT_STAGES[i]!] ?? 0;
  }
  return sum;
}

/**
 * created_at = the day the placement journey began = `stage_entered_at` minus the
 * summed stuck-thresholds of all prior stages (a realistic backdated journey).
 * For `send_application` (first stage) the backlog is 0 → created_at == entry.
 */
function journeyStart(stageEnteredAt: Date, stage: PlacementStage): string {
  return new Date(stageEnteredAt.getTime() - priorStagesBacklogMs(stage)).toISOString();
}

// ---------------------------------------------------------------------------
// Per-placement showcase ROLE (deliberate deadline×stuck quadrants)
// ---------------------------------------------------------------------------
// Each active (stage, rep) is assigned a deterministic role that decides which
// deadline×stuck quadrant the placement demonstrates on the Today board. The
// curated map below hand-places a small set of rows so ALL FOUR quadrants are
// covered — deadline-not-stuck (due_hard/due_followup/upcoming), stuck-no-deadline
// (stuck_only), both, and neither (calm). Everything NOT in the map defaults to
// `upcoming` for rep 1 and `calm` for rep 2, so most placements are off-board and
// the board reads cleanly. Roles:
//   - due_hard    → needs_you_now, NOT stuck: overdue hard clock (rta_window/voucher).
//   - due_followup→ follow_ups, NOT stuck: overdue follow_up, NOT attention-flagged.
//   - stuck_only  → follow_ups via DERIVED stuck; NO deadline item.
//   - both        → needs_you_now (overdue hard clock) + follow_ups (derived stuck).
//   - upcoming    → off-board calm: a future (not-due) deadline.
//   - calm        → off-board: neither a deadline nor stuck.
type PlacementRole = 'due_hard' | 'due_followup' | 'stuck_only' | 'both' | 'upcoming' | 'calm';

const ROLE_MAP: Partial<Record<PlacementStage, Partial<Record<number, PlacementRole>>>> = {
  send_application: { 1: 'due_hard' }, //                      App  → voucher overdue (needs)
  awaiting_completion: { 1: 'due_followup', 2: 'both' }, //    App  → follow_up overdue (follow); voucher overdue + stuck (both)
  collect_rta: { 1: 'due_hard' }, //                          RTA  → rta_window overdue (needs)
  review_rta: { 1: 'stuck_only' }, //                         RTA  → stuck, NO deadline (follow)
  awaiting_landlord_submission: { 2: 'due_hard' }, //         RTA  → rta_window overdue (needs)
  awaiting_authority_approval: { 1: 'both' }, //             RTA  → rta_window overdue + stuck (both)
  awaiting_inspection: { 1: 'stuck_only' }, //               Insp → stuck, NO deadline (follow)
  determine_rent: { 2: 'stuck_only' }, //                    Rent → stuck, NO deadline (follow)
  complete_paperwork: { 1: 'due_followup' }, //              Admin→ follow_up overdue (follow)
};

/** The curated role for (stage, rep); default rep1→upcoming, rep2→calm. */
function roleFor(stage: PlacementStage, rep: number): PlacementRole {
  return ROLE_MAP[stage]?.[rep] ?? (rep === 1 ? 'upcoming' : 'calm');
}

// ---------------------------------------------------------------------------
// Attention reasons (phase-scoped — findings §A5)
// ---------------------------------------------------------------------------
/**
 * The set of plausible attention reasons for a placement in `stage`:
 * - "Voucher expiring" — any pre-move-in stage (all active stages qualify).
 * - "Inspection overdue" — ONLY the Inspection phase.
 * - "RTA window closing" — ONLY the RTA phase.
 * - "Landlord unreachable" — ONLY where the landlord is the blocking actor
 *   (RTA submission / rent acceptance / HAP contract).
 * The generator AND the coherence test both read this single source of truth.
 */
export function attentionReasonPool(stage: PlacementStage): string[] {
  const phase = STAGE_PHASE[stage];
  const pool = ['Voucher expiring soon — expedite'];
  if (phase === 'Inspection') pool.push('Inspection overdue — reschedule required');
  if (phase === 'RTA') pool.push('RTA window closing — escalate');
  if (
    stage === 'awaiting_landlord_submission' ||
    stage === 'awaiting_rent_acceptance' ||
    stage === 'awaiting_hap_contract'
  ) {
    pool.push('Landlord unreachable — follow up immediately');
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Park reasons for parked landlords
// ---------------------------------------------------------------------------
const PARK_REASONS = [
  'Declined — a property manager, not the owner',
  'Out of service area',
  'Never signed the contract after 3 follow-ups',
  'Rent too high — above payment standard',
];
const parkReason = (i: number) => PARK_REASONS[i % PARK_REASONS.length]!;

// ---------------------------------------------------------------------------
// Lost reasons
// ---------------------------------------------------------------------------
const LOST_CATEGORIES_A = ['stalled', 'no_contact', 'landlord_lost_rent', 'landlord_lost_inspection'] as const;
const LOST_CATEGORIES_B = ['tenant_withdrew', 'voucher_expired', 'other'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stableId(prefix: string, tag: string, n: number): string {
  return `${prefix}-mx-${tag.replace(/_/g, '-')}-${String(n).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Matrix builders
// ---------------------------------------------------------------------------

interface PlacementGroup {
  tenantId: string;
  unitId: string;
  placementId: string;
  stage: PlacementStage;
  tenant: Record<string, unknown>;
  unit: Record<string, unknown>;
  placement: Record<string, unknown>;
  /** First-class placementDeadlines item (placement-deadline-model), when armed. */
  deadline?: Record<string, unknown>;
}

/**
 * Build the 2-per-stage placement matrix: 16 active stages ×2, moved_in ×2, lost ×2.
 * Each placement gets its own tenant + unit with deriveStatuses applied.
 *
 * NOW-RELATIVE + coherent by construction (findings §A "Correct-by-construction"):
 *   - stage_entered_at = now − (a plausible time in the current stage).
 *   - created_at = journeyStart(stage_entered_at, stage) (backdated over prior
 *     stages; == stage_entered_at only for send_application).
 *   - Each active placement gets a deterministic showcase ROLE (per (stage,rep))
 *     so the Today board deliberately demonstrates the deadline×stuck quadrants:
 *     due_hard / due_followup / stuck_only / both / upcoming / calm. Most rows are
 *     calm/upcoming (off-board) so Today reads cleanly; `stuck_only`/`calm` carry
 *     NO placementDeadlines item (stuck is DERIVED from time-in-stage).
 *   - When a deadline IS armed: type ∈ PHASE_DEADLINE_TYPES[phase] (never
 *     tour_reminder; rta_window only in RTA); `at` ≥ stage_entered_at. A
 *     voucher_expiration deadline is materialized from the tenant's
 *     voucher_expiration_date (== the deadline `at`).
 *   - attention is DECOUPLED from overdue-ness: flagged only on the `both` rows +
 *     the first `due_hard` row (already in needs_you_now); reason ∈
 *     attentionReasonPool(stage).
 */
function buildPlacementsMatrix(now: Date): PlacementGroup[] {
  const groups: PlacementGroup[] = [];
  let counter = 0;
  // Attention is decoupled from overdue-ness: flag ONLY the `both` rows (always)
  // and the FIRST `due_hard` row (they're already in needs_you_now, overdue hard
  // clocks). An overdue `due_followup` must NOT be flagged — it lands in follow_ups
  // ONLY. This flips false→true the first time a due_hard row is seen (deterministic
  // iteration order ⇒ always the same row: send_application/1).
  let dueHardAttentionAssigned = false;

  // Active stages (not terminals)
  const activeStages = PLACEMENT_STAGES.filter((s) => s !== 'moved_in' && s !== 'lost');
  for (const stage of activeStages) {
    for (let rep = 1; rep <= 2; rep++) {
      counter++;
      const tag = stage; // e.g. 'send_application'
      const tenantId = stableId('tenant', tag, rep);
      const unitId = stableId('unit', tag, rep);
      const placementId = stableId('placement', tag, rep);
      const derived = deriveStatuses(stage);
      const phase = STAGE_PHASE[stage];

      // Curated showcase ROLE → which deadline×stuck quadrant this placement
      // demonstrates (deliberate coverage; most rows are calm/upcoming so the board
      // reads cleanly). See ROLE_MAP + role mechanics above.
      const role = roleFor(stage, rep);
      // HARD(phase): the "hard clock" deadline type — rta_window in RTA, else
      // voucher_expiration. Every role that uses HARD sits on an App/RTA stage per
      // the curated map, so this is always a phase-valid type.
      const hardType: PlacementDeadlineType = phase === 'RTA' ? 'rta_window' : 'voucher_expiration';
      const stuckThresholdMs = STAGE_STUCK_THRESHOLDS[stage] ?? 0;

      // Role → (stage_entered_at, optional deadline type/at, attention, voucher date).
      // All now-relative + deterministic. Invariants held by construction:
      //   deadline.at ≥ stage_entered_at; created_at = journeyStart ≤ stage_entered_at;
      //   attention rows are always overdue; voucher_expiration_date ⟺ voucher deadline.
      let stageEnteredAt: Date;
      let deadlineType: PlacementDeadlineType | undefined;
      let deadlineAt: string | undefined;
      let attention = false;
      let voucherExpirationDate: string | undefined;

      switch (role) {
        case 'due_hard': {
          // needs_you_now, NOT stuck: entered 2d ago (< every threshold) with an
          // overdue hard clock. The FIRST due_hard row is attention-flagged.
          stageEnteredAt = new Date(now.getTime() - 2 * DAY_MS);
          deadlineType = hardType;
          deadlineAt = hoursFromNow(now, -12); // now − 12h (overdue → surfaces)
          if (hardType === 'voucher_expiration') voucherExpirationDate = deadlineAt;
          if (!dueHardAttentionAssigned) {
            attention = true;
            dueHardAttentionAssigned = true;
          }
          break;
        }
        case 'due_followup': {
          // follow_ups, NOT stuck: an overdue follow_up that is NOT attention-flagged
          // (the fix — an overdue follow_up lands in follow_ups ONLY, not needs_you_now).
          stageEnteredAt = new Date(now.getTime() - 2 * DAY_MS);
          deadlineType = 'follow_up';
          deadlineAt = daysAgo(now, 1); // now − 1d (overdue)
          break;
        }
        case 'stuck_only': {
          // follow_ups via DERIVED stuck; NO deadline item. Age > threshold ⇒ stuck.
          stageEnteredAt = new Date(now.getTime() - (stuckThresholdMs + 3 * DAY_MS));
          break;
        }
        case 'both': {
          // needs_you_now (overdue hard clock) + follow_ups (derived stuck). Always
          // attention-flagged (it's already in needs_you_now, overdue).
          stageEnteredAt = new Date(now.getTime() - (stuckThresholdMs + 3 * DAY_MS));
          deadlineType = hardType;
          deadlineAt = hoursFromNow(now, -12); // now − 12h (overdue)
          if (hardType === 'voucher_expiration') voucherExpirationDate = deadlineAt;
          attention = true;
          break;
        }
        case 'upcoming': {
          // Off-board calm: a phase-appropriate deadline comfortably in the future
          // (not on Today). Spread the type across the phase set for coverage.
          stageEnteredAt = new Date(now.getTime() - 2 * DAY_MS);
          const validTypes = PHASE_DEADLINE_TYPES[phase];
          deadlineType = validTypes[counter % validTypes.length]!;
          deadlineAt = daysFromNow(now, 14 + (counter % 14)); // 2-4 weeks out
          if (deadlineType === 'voucher_expiration') voucherExpirationDate = deadlineAt;
          break;
        }
        case 'calm':
        default: {
          // Off-board: neither a deadline nor stuck.
          stageEnteredAt = new Date(now.getTime() - 2 * DAY_MS);
          break;
        }
      }

      const stageEnteredIso = stageEnteredAt.toISOString();
      const createdAt = journeyStart(stageEnteredAt, stage);

      const placementBase: Record<string, unknown> = {
        placementId,
        tenantId,
        unitId,
        stage,
        stage_entered_at: stageEnteredIso,
        stage_source: 'manual',
        created_at: createdAt,
        // No raw next_deadline slot (placement-deadline-model): the flat
        // next_deadline_type/at are COMPUTED at read time from the first-class
        // placementDeadlines item (when present).
      };

      // Deadlines are first-class placementDeadlines items (placement-deadline-model),
      // built ONLY when the role calls for one. stuck_only/calm carry NO item — the
      // stuck signal is DERIVED from time-in-stage, and calm is genuinely off-board.
      // `deadlineType` is always a LIVE type (rta_window / voucher_expiration /
      // follow_up); tours own tour_reminder, which can never appear here.
      let deadline: Record<string, unknown> | undefined;
      if (deadlineType !== undefined && deadlineAt !== undefined) {
        deadline = {
          deadlineId: deadlineIdFor(placementId, deadlineType),
          placementId,
          type: deadlineType,
          at: deadlineAt,
          _deadlinePartition: 'deadlines',
          createdAt,
          updatedAt: createdAt,
        };
      }

      if (attention) {
        const pool = attentionReasonPool(stage);
        placementBase['attention'] = { reason: pool[counter % pool.length]!, at: deadlineAt };
      }

      const tenant: Record<string, unknown> = {
        contactId: tenantId,
        type: 'tenant',
        status: derived.tenantStatus,
        status_source: 'derived',
        phone: phoneBase(counter),
        firstName: firstName(TENANT_FIRST, counter),
        lastName: lastName(TENANT_LAST, counter + 3),
        voucherSize: beds(counter),
        housingAuthority: auth(counter),
        porting: counter % 3 === 0,
        consent_method: matrixConsent(counter),
        consent_at: createdAt,
        created_at: createdAt,
      };
      // Voucher coherence: set voucher_expiration_date ONLY when this placement
      // carries a voucher_expiration deadline, pinned to the deadline instant
      // (materialized-from-field coherence). No blanket counter%3 line any more.
      if (voucherExpirationDate !== undefined) {
        tenant['voucher_expiration_date'] = voucherExpirationDate;
      }

      groups.push({
        tenantId,
        unitId,
        placementId,
        stage,
        ...(deadline !== undefined ? { deadline } : {}),
        tenant,
        unit: {
          unitId,
          landlordId: 'contact-landlord-0001', // lean anchor landlord
          status: derived.listingStatus,
          status_source: 'derived',
          jurisdiction: auth(counter),
          address: addr(counter),
          beds: beds(counter),
          rent_min: 1200 + counter * 25,
          rent_max: 1200 + counter * 25 + 100,
          deposit: 1200 + counter * 25,
          pets: counter % 2 === 0 ? 'No pets' : 'Cats OK',
          tour_process: tourProcess(counter),
          created_at: createdAt,
        },
        placement: placementBase,
      });
    }
  }

  // moved_in ×2 — recent-past ordering: created_at ≤ lease_date ≤ move_in_date ≤ now.
  for (let rep = 1; rep <= 2; rep++) {
    counter++;
    const stage: PlacementStage = 'moved_in';
    const tenantId = stableId('tenant', stage, rep);
    const unitId = stableId('unit', stage, rep);
    const placementId = stableId('placement', stage, rep);
    const derived = deriveStatuses(stage);
    // Moved in ~2-3 weeks ago; lease signed ~2 weeks before that.
    const moveInDate = daysAgo(now, 12 + rep * 4).slice(0, 10); // date-only (rep1: 16d, rep2: 20d ago)
    const leaseDate = daysAgo(now, 26 + rep * 4).slice(0, 10); // date-only (rep1: 30d, rep2: 34d ago)
    // Entered the terminal moved_in stage at move-in; journey began well before.
    const stageEnteredAt = new Date(`${moveInDate}T10:00:00.000Z`);
    const createdAt = journeyStart(stageEnteredAt, stage);
    groups.push({
      tenantId,
      unitId,
      placementId,
      stage,
      tenant: {
        contactId: tenantId,
        type: 'tenant',
        status: derived.tenantStatus, // 'placed'
        status_source: 'derived',
        phone: phoneBase(counter),
        firstName: firstName(TENANT_FIRST, counter),
        lastName: lastName(TENANT_LAST, counter),
        voucherSize: beds(counter),
        housingAuthority: auth(counter),
        porting: false,
        consent_method: matrixConsent(counter),
        consent_at: createdAt,
        move_in_date: moveInDate,
        created_at: createdAt,
      },
      unit: {
        unitId,
        landlordId: 'contact-landlord-0001',
        status: derived.listingStatus, // 'occupied'
        status_source: 'derived',
        jurisdiction: auth(counter),
        address: addr(counter),
        beds: beds(counter),
        rent_min: 1400 + rep * 50,
        rent_max: 1400 + rep * 50,
        deposit: 1400 + rep * 50,
        pets: 'No pets',
        final_rent: 1400 + rep * 50,
        tour_process: tourProcess(counter),
        created_at: createdAt,
      },
      placement: {
        placementId,
        tenantId,
        unitId,
        stage,
        stage_entered_at: stageEnteredAt.toISOString(),
        stage_source: 'manual',
        move_in_date: moveInDate,
        lease_date: leaseDate,
        created_at: createdAt,
      },
    });
  }

  // lost ×2 — distinct reason categories; became lost recently after a long journey.
  for (let rep = 1; rep <= 2; rep++) {
    counter++;
    const stage: PlacementStage = 'lost';
    const tenantId = stableId('tenant', stage, rep);
    const unitId = stableId('unit', stage, rep);
    const placementId = stableId('placement', stage, rep);
    const derived = deriveStatuses(stage);
    const stageEnteredAt = new Date(now.getTime() - (5 + rep * 3) * DAY_MS); // 8-11 days ago
    const createdAt = journeyStart(stageEnteredAt, stage);
    // Alternate category sets for the two lost placements
    const lostCategory = rep === 1 ? LOST_CATEGORIES_A[0] : LOST_CATEGORIES_B[0];
    const lostText = rep === 1
      ? 'Tenant went 3+ weeks without response; closing the file.'
      : 'Tenant decided to stay in current housing situation.';
    groups.push({
      tenantId,
      unitId,
      placementId,
      stage,
      tenant: {
        contactId: tenantId,
        type: 'tenant',
        status: derived.tenantStatus, // 'searching'
        status_source: 'derived',
        phone: phoneBase(counter),
        firstName: firstName(TENANT_FIRST, counter),
        lastName: lastName(TENANT_LAST, counter),
        voucherSize: beds(counter),
        housingAuthority: auth(counter),
        porting: rep === 2,
        consent_method: matrixConsent(counter),
        consent_at: createdAt,
        created_at: createdAt,
      },
      unit: {
        unitId,
        landlordId: 'contact-landlord-0001',
        status: derived.listingStatus, // 'available'
        status_source: 'derived',
        jurisdiction: auth(counter),
        address: addr(counter),
        beds: beds(counter),
        rent_min: 1300 + rep * 75,
        rent_max: 1300 + rep * 75 + 50,
        deposit: 1300 + rep * 75,
        pets: 'No pets',
        tour_process: tourProcess(counter),
        created_at: createdAt,
      },
      placement: {
        placementId,
        tenantId,
        unitId,
        stage,
        stage_entered_at: stageEnteredAt.toISOString(),
        stage_source: 'manual',
        lost_reason: { category: lostCategory, text: lostText },
        created_at: createdAt,
      },
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Units matrix — every LISTING_STATUS ×2 net of placement-derived ones,
// plus ~6 available tourable units + 1 off_market + 2 on_hold
// ---------------------------------------------------------------------------
interface UnitGroup {
  unit: Record<string, unknown>;
}

function buildUnitsMatrix(placementGroups: PlacementGroup[]): UnitGroup[] {
  // Collect what statuses the placements already produce
  const statusCounts: Record<string, number> = {};
  for (const pg of placementGroups) {
    const s = pg.unit['status'] as string;
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const groups: UnitGroup[] = [];
  let counter = 0;

  // For each LISTING_STATUS, top up to ≥2 standalone units
  for (const status of LISTING_STATUSES) {
    const existing = statusCounts[status] ?? 0;
    const needed = Math.max(0, 2 - existing);
    for (let rep = 1; rep <= needed; rep++) {
      counter++;
      const unitId = stableId('unit', status, rep + 10); // offset to avoid collision
      const isManualPin = status === 'on_hold' || status === 'off_market';
      const unit: Record<string, unknown> = {
        unitId,
        landlordId: 'contact-landlord-0001',
        status,
        status_source: isManualPin ? 'manual' : 'derived',
        jurisdiction: auth(counter),
        address: addr(counter),
        beds: beds(counter),
        rent_min: 1100 + counter * 30,
        rent_max: 1100 + counter * 30 + 150,
        deposit: 1100 + counter * 30,
        pets: counter % 2 === 0 ? 'No pets' : 'Small dogs OK',
        tour_process: tourProcess(counter),
        created_at: pastDate(counter),
      };
      groups.push({ unit });
    }
  }

  // ~6 explicitly tourable 'available' units (distinct from any produced above)
  // spread across authorities, beds 1-4, and all three tour-process types
  const tourableSpecs = [
    { authority: 'atlanta_housing', beds: 1, processType: 'self_guided' },
    { authority: 'ga_dca', beds: 2, processType: 'landlord_led' },
    { authority: 'dekalb_housing', beds: 3, processType: 'pm_team' },
    { authority: 'fulton_housing', beds: 4, processType: 'self_guided' },
    { authority: 'gwinnett_housing', beds: 2, processType: 'landlord_led' },
    { authority: 'cobb_housing', beds: 3, processType: 'pm_team' },
  ] as const;

  const TOURL_PROCESSES_BY_TYPE: Record<string, string> = {
    self_guided: 'Self-guided lockbox; available daily 8am-6pm. Text for the code.',
    landlord_led: 'Contact landlord 24h ahead to schedule a guided walkthrough.',
    pm_team: 'Property management team shows the unit; call to set appointment.',
  };

  for (let i = 0; i < tourableSpecs.length; i++) {
    const spec = tourableSpecs[i]!;
    counter++;
    const unitId = `unit-mx-tourable-${String(i + 1).padStart(2, '0')}`;
    groups.push({
      unit: {
        unitId,
        landlordId: 'contact-landlord-0001',
        status: 'available',
        status_source: 'manual',
        jurisdiction: spec.authority,
        address: addr(counter),
        beds: spec.beds,
        rent_min: 1150 + i * 75,
        rent_max: 1150 + i * 75 + 100,
        deposit: 1150 + i * 75,
        pets: i % 2 === 0 ? 'No pets' : 'Cats & small dogs OK',
        tour_process: TOURL_PROCESSES_BY_TYPE[spec.processType],
        created_at: pastDate(counter),
      },
    });
  }

  // Ensure 1 off_market + 2 on_hold are pinned manual (may already be in LISTING_STATUSES loop)
  // Add explicit ones with status_source:'manual' to be sure
  const offMarketId = 'unit-mx-off-market-01';
  const alreadyHasOffMarket = groups.some((g) => g.unit['unitId'] === offMarketId || (g.unit['status'] === 'off_market' && g.unit['status_source'] === 'manual'));
  if (!alreadyHasOffMarket) {
    counter++;
    groups.push({
      unit: {
        unitId: offMarketId,
        landlordId: 'contact-landlord-0001',
        status: 'off_market',
        status_source: 'manual',
        jurisdiction: 'atlanta_housing',
        address: addr(counter),
        beds: 2,
        rent_min: 1500,
        rent_max: 1500,
        deposit: 1500,
        pets: 'No pets',
        tour_process: 'Unit not currently available.',
        created_at: D.T0,
      },
    });
  }

  for (let rep = 1; rep <= 2; rep++) {
    const onHoldId = `unit-mx-on-hold-${String(rep).padStart(2, '0')}`;
    const alreadyHasOnHold = groups.some((g) => g.unit['unitId'] === onHoldId);
    if (!alreadyHasOnHold) {
      counter++;
      groups.push({
        unit: {
          unitId: onHoldId,
          landlordId: 'contact-landlord-0001',
          status: 'on_hold',
          status_source: 'manual',
          jurisdiction: auth(counter),
          address: addr(counter),
          beds: beds(counter),
          rent_min: 1350 + rep * 50,
          rent_max: 1350 + rep * 50 + 100,
          deposit: 1350 + rep * 50,
          pets: 'No pets',
          tour_process: tourProcess(counter),
          created_at: D.T1,
        },
      });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Standalone tenants — every TENANT_STATUS ×2 net of placement-derived ones
// ---------------------------------------------------------------------------
interface TenantGroup {
  tenant: Record<string, unknown>;
}

function buildTenantsMatrix(placementGroups: PlacementGroup[]): TenantGroup[] {
  // Count statuses already produced by placements
  const statusCounts: Record<string, number> = {};
  for (const pg of placementGroups) {
    const s = pg.tenant['status'] as string;
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const groups: TenantGroup[] = [];
  let counter = 0;

  // Statuses whose `-standalone-01` contactId is HARDCODED by other builders
  // (the tours pool, broadcast recipients, listing sends, activity events).
  // Those cross-references must ALWAYS resolve, so these statuses create at
  // least one standalone row even when placements already satisfy the >=2
  // floor - otherwise the referenced contact simply does not exist and every
  // surface that joins it (the /tours list, broadcast results, timelines)
  // renders a dangling raw id / 404s on click-through.
  const GUARANTEED_STANDALONE: ReadonlySet<string> = new Set(['searching', 'placing']);

  for (const status of TENANT_STATUSES) {
    const existing = statusCounts[status] ?? 0;
    const needed = Math.max(GUARANTEED_STANDALONE.has(status) ? 1 : 0, 2 - existing);
    for (let rep = 1; rep <= needed; rep++) {
      counter++;
      const tenantId = `tenant-mx-${status.replace(/_/g, '-')}-standalone-${String(rep).padStart(2, '0')}`;
      const isOverrideState = status === 'on_hold' || status === 'inactive';
      const tenant: Record<string, unknown> = {
        contactId: tenantId,
        type: 'tenant',
        status,
        status_source: isOverrideState ? 'manual' : 'derived',
        phone: phoneBase(200 + counter),
        firstName: firstName(TENANT_FIRST, 100 + counter),
        lastName: lastName(TENANT_LAST, 100 + counter),
        voucherSize: beds(counter + 1),
        housingAuthority: auth(counter + 2),
        porting: counter % 4 === 0,
        consent_method: matrixConsent(counter + 1),
        consent_at: pastDate(counter),
        created_at: pastDate(counter),
      };
      if (status === 'on_hold') {
        tenant['preferences_notes'] = 'Awaiting RTA; tenant will re-engage when voucher is in hand.';
      }
      groups.push({ tenant });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Standalone landlords — every LANDLORD_STATUS ×2 net of placement-derived
// (placements don't derive landlord status, so all 4 ×2 = 8 standalone rows)
// ---------------------------------------------------------------------------
interface LandlordGroup {
  landlord: Record<string, unknown>;
}

function buildLandlordsMatrix(): LandlordGroup[] {
  const groups: LandlordGroup[] = [];
  let counter = 0;

  for (const status of LANDLORD_STATUSES) {
    for (let rep = 1; rep <= 2; rep++) {
      counter++;
      const landlordId = `landlord-mx-${status.replace(/_/g, '-')}-${String(rep).padStart(2, '0')}`;
      const landlord: Record<string, unknown> = {
        contactId: landlordId,
        type: 'landlord',
        status,
        phone: phoneBase(400 + counter),
        firstName: firstName(LANDLORD_FIRST, counter),
        lastName: lastName(LANDLORD_LAST, counter),
        contract_status: status === 'active' ? 'signed' : 'unsigned',
        registered_landlord: counter % 2 === 0,
        rta_within_48h: counter % 3 !== 0,
        pass_inspection_first_try: counter % 4 !== 0,
        income_includes_voucher: counter % 2 === 1,
        consent_method: matrixConsent(counter + 2),
        consent_at: pastDate(counter),
        created_at: pastDate(counter),
      };
      if (status === 'parked') {
        landlord['park_reason'] = parkReason(counter);
      }
      groups.push({ landlord });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Tours matrix — every TOUR_STATUS ×2, NOW-RELATIVE + coherent by construction
// (findings §B). Every tour's whole timeline is derived from the injected `now`
// by real date arithmetic — never the fixed pastDate pool (which reordered time
// via index wraparound and live-fired stale reminders).
//
// Per status:
//   - requested  — TIMELESS: no scheduledAt, ZERO reminder rows (invariant).
//   - scheduled  - UPCOMING (scheduledAt = now + Ndays): a SENT
//     confirmation (armed at creation) + a PENDING day_before whose dueAt =
//     scheduledAt - 24h >= now, so listDue(now) never returns it (no live-fire).
//   - toured/no_show/canceled/closed — recent PAST (scheduledAt = now − Ndays):
//     ALL reminders terminal. day_before sent at its dueAt (= scheduledAt − 24h);
//     no_show adds a sent no_show_checkin at scheduledAt + 30m; canceled's
//     day_before is canceled (canceledAt between its dueAt and scheduledAt).
//   - toured/closed carry the exit-gate shape the route + cast + conversion read:
//     outcome + moveForward, updatedAt advanced past scheduledAt (decision recorded
//     post-visit). convertible is true ONLY for a `toured` tour (the ready-to-convert
//     state); a `closed` tour is terminal and is NEVER convertible — otherwise its
//     "Start placement" button (gated only on convertible===true &&
//     convertedPlacementId===undefined, no status gate) would create an orphan placement.
//
// Invariants (asserted in seedMatrixCoherence.test.ts): requested ⇒ 0 reminders;
// createdAt ≤ scheduledAt; per reminder createdAt ≤ dueAt ≤ (sentAt ?? canceledAt
// ?? ∞); and the load-bearing one — NO pending reminder has dueAt < now.
// ---------------------------------------------------------------------------
interface TourGroup {
  tour: Record<string, unknown>;
  reminders: Record<string, unknown>[];
}

// Upcoming statuses are future-dated; the rest of the non-requested statuses are
// recent-past. Day offsets are indexed by (rep - 1) for per-rep variety.
const UPCOMING_TOUR_STATUSES: ReadonlySet<TourStatus> = new Set<TourStatus>(['scheduled']);
const UPCOMING_TOUR_DAYS: Partial<Record<TourStatus, readonly [number, number]>> = {
  scheduled: [3, 5],
};
const PAST_TOUR_DAYS: Partial<Record<TourStatus, readonly [number, number]>> = {
  toured: [4, 6],
  no_show: [3, 5],
  canceled: [5, 7],
  closed: [8, 10],
};

function buildToursMatrix(now: Date, availableUnitIds: string[], searchingTenantIds: string[]): TourGroup[] {
  const groups: TourGroup[] = [];
  const nowMs = now.getTime();
  let counter = 0;
  let unitIdx = 0;
  let tenantIdx = 0;

  const pickUnit = () => availableUnitIds[unitIdx++ % Math.max(1, availableUnitIds.length)] ?? 'unit-mx-tourable-01';
  const pickTenant = () => searchingTenantIds[tenantIdx++ % Math.max(1, searchingTenantIds.length)] ?? 'tenant-mx-searching-standalone-01';

  const iso = (msVal: number) => new Date(msVal).toISOString();

  for (const status of TOUR_STATUSES) {
    for (let rep = 1; rep <= 2; rep++) {
      counter++;
      const tourId = `tour-mx-${status.replace(/_/g, '-')}-${String(rep).padStart(2, '0')}`;
      const unitId = pickUnit();
      const tenantId = pickTenant();
      const tourType = counter % 3 === 0 ? 'pm_team' : counter % 3 === 1 ? 'landlord_led' : 'self_guided';
      const reminders: Record<string, unknown>[] = [];

      // --- requested: timeless, zero reminders (invariant) -------------------
      if (status === 'requested') {
        const createdAt = iso(nowMs - (2 + rep) * DAY_MS); // 3-4 days ago
        groups.push({
          tour: { tourId, tenantId, unitId, status, tourType, createdAt, updatedAt: createdAt },
          reminders,
        });
        continue;
      }

      // --- non-requested: a real scheduled time + a coherent reminder ladder --
      const upcoming = UPCOMING_TOUR_STATUSES.has(status);
      let scheduledMs: number;
      let createdMs: number;
      if (upcoming) {
        const off = UPCOMING_TOUR_DAYS[status]![rep - 1]!;
        scheduledMs = nowMs + off * DAY_MS;      // future
        createdMs = nowMs - (2 + rep) * DAY_MS;  // booked a few days ago
      } else {
        const off = PAST_TOUR_DAYS[status]![rep - 1]!;
        scheduledMs = nowMs - off * DAY_MS;      // recent past
        createdMs = scheduledMs - (2 + rep) * DAY_MS; // booked before the tour
      }
      const scheduledAt = iso(scheduledMs);
      const createdAt = iso(createdMs);
      const dayBeforeDueAt = iso(scheduledMs - 24 * HOUR_MS); // computeDueAt('day_before') parity

      const tour: Record<string, unknown> = {
        tourId,
        tenantId,
        unitId,
        status,
        tourType,
        createdAt,
        updatedAt: createdAt,
        scheduledAt,
        _schedPartition: 'tours', // sparse byScheduledAt GSI membership
      };

      // Confirmation is armed at creation and sent immediately — always terminal.
      reminders.push({
        reminderId: `rem-mx-${tourId}-conf`,
        tourId,
        kind: 'confirmation',
        dueAt: createdAt,
        sentAt: createdAt,
        _reminderPartition: 'reminders',
        createdAt,
      });

      if (upcoming) {
        // day_before is PENDING but its dueAt (scheduledAt − 24h) is ≥ now, so
        // listDue(now) never returns it — the live-fire bug cannot recur.
        reminders.push({
          reminderId: `rem-mx-${tourId}-dbf`,
          tourId,
          kind: 'day_before',
          dueAt: dayBeforeDueAt,
          // sentAt / canceledAt absent = pending (dueAt is in the future)
          _reminderPartition: 'reminders',
          createdAt,
        });
      } else if (status === 'canceled') {
        // Canceled between the day_before due instant and the scheduled time: the
        // pending day_before was canceled (never sent). canceledAt sits between its
        // dueAt and scheduledAt (and after createdAt).
        const canceledAt = iso(scheduledMs - 6 * HOUR_MS);
        reminders.push({
          reminderId: `rem-mx-${tourId}-dbf`,
          tourId,
          kind: 'day_before',
          dueAt: dayBeforeDueAt,
          canceledAt,
          _reminderPartition: 'reminders',
          createdAt,
        });
        tour['canceledAt'] = canceledAt;
        tour['updatedAt'] = canceledAt;
      } else {
        // toured / no_show / closed — day_before was SENT at its due instant.
        reminders.push({
          reminderId: `rem-mx-${tourId}-dbf`,
          tourId,
          kind: 'day_before',
          dueAt: dayBeforeDueAt,
          sentAt: dayBeforeDueAt,
          _reminderPartition: 'reminders',
          createdAt,
        });
        tour['updatedAt'] = scheduledAt;

        if (status === 'no_show') {
          const checkinDueAt = iso(scheduledMs + 30 * MINUTE_MS); // computeDueAt('no_show_checkin')
          reminders.push({
            reminderId: `rem-mx-${tourId}-nsc`,
            tourId,
            kind: 'no_show_checkin',
            dueAt: checkinDueAt,
            sentAt: checkinDueAt,
            _reminderPartition: 'reminders',
            createdAt,
          });
          tour['updatedAt'] = checkinDueAt;
        } else {
          // toured / closed carry the exit-gate decision the route/conversion read.
          // The decision is recorded POST-visit (exit gate), so updatedAt advances a
          // few hours past the scheduled visit — still comfortably ≤ now.
          const moveForward = rep === 1;
          tour['updatedAt'] = iso(scheduledMs + (2 + rep) * HOUR_MS);
          tour['outcome'] = moveForward ? 'move_forward' : 'not_a_fit';
          tour['moveForward'] = moveForward;
          // convertible ONLY for a `toured` (ready-to-convert) tour. A `closed` tour is
          // terminal/already-decided and must NEVER be convertible: both
          // placements.ts POST /placements/from-tour (L516) and TourDetail's
          // "Start placement" button (L484) gate SOLELY on
          // `convertible===true && convertedPlacementId===undefined` — no status gate —
          // so a convertible closed tour would show a live button and create an orphan
          // placement. The ready-to-convert state is modeled by `toured` rep1.
          tour['convertible'] = status === 'toured' && moveForward;
        }
      }

      groups.push({ tour, reminders });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Pool numbers backing relay conversations
// ---------------------------------------------------------------------------
const POOL_NUMBERS = ['+15550190101', '+15550190102'] as const;

function buildPoolNumbers(): Record<string, unknown>[] {
  return POOL_NUMBERS.map((num, i) => ({
    poolNumber: num,
    lifecycle_state: 'assigned',
    quarantine_until: '0000-00-00T00:00:00.000Z', // sentinel for byLifecycleState GSI
    voice_capable: true,
    sms_capable: true,
    provisioned_via: 'console',
    assigned_conversation_id: `conv-mx-relay-${String(i + 1).padStart(2, '0')}`,
    provisioned_at: D.T2,
    assigned_at: D.T2,
  }));
}

// ---------------------------------------------------------------------------
// Relay group conversations backed by pool numbers
// ---------------------------------------------------------------------------
function buildRelayConversations(): Record<string, unknown>[] {
  return POOL_NUMBERS.map((num, i) => ({
    conversationId: `conv-mx-relay-${String(i + 1).padStart(2, '0')}`,
    participant_phone: num, // byParticipantPhone = pool number for relay groups
    pool_number: num, // byPoolNumber GSI
    status: 'open',
    relay_status: 'relay_group#open', // byRelayStatus GSI HASH (sparse; relay only)
    last_activity_at: D.T3,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [],
    owner: { type: 'tour', id: `tour-mx-scheduled-${String(i + 1).padStart(2, '0')}` },
    created_at: D.T2,
  }));
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------
function buildBroadcasts(): Record<string, unknown>[] {
  return [
    {
      broadcastId: 'broadcast-mx-sent-01',
      status: 'sent',
      created_by: 'user-0001',
      created_at: D.T4,
      unitId: 'unit-mx-tourable-01',
      audience_filter: {
        contact_type: 'tenant',
        housing_authority: 'atlanta_housing',
        bedroomSize: 1,
        excludeOptedOut: true,
        excludeUnreachable: true,
      },
      body_template: 'Hi {firstName}! A new 1BR in Atlanta is available — reply to learn more.',
      stats: {
        audience: 10,
        sent: 7,
        delivered: 6,
        failed: 1,
        skipped_opted_out: 1,
        skipped_no_consent: 2,
        queued: 0,
      },
      recipients: {
        'tenant-mx-searching-standalone-01': { status: 'delivered' },
      },
    },
    {
      broadcastId: 'broadcast-mx-draft-01',
      status: 'draft',
      created_by: 'user-0002',
      created_at: D.T5,
      unitId: 'unit-mx-tourable-02',
      audience_filter: {
        contact_type: 'tenant',
        housing_authority: 'ga_dca',
        bedroomSize: 2,
        excludeOptedOut: true,
        excludeUnreachable: false,
      },
      body_template: 'Hi {firstName}! A 2BR in DeKalb is now available — text back if interested.',
      stats: { audience: 0, sent: 0, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      recipients: {},
    },
  ];
}

// ---------------------------------------------------------------------------
// Listing sends
// ---------------------------------------------------------------------------
function buildListingSends(): Record<string, unknown>[] {
  return [
    {
      unitId: 'unit-mx-tourable-01',
      contactId: 'tenant-mx-searching-standalone-01',
      sentAt: D.T6,
      response: 'interested',
      via: 'broadcast',
      broadcastId: 'broadcast-mx-sent-01',
      created_at: D.T6,
    },
    {
      unitId: 'unit-mx-tourable-02',
      contactId: 'tenant-mx-searching-standalone-01',
      sentAt: D.T7,
      response: 'no_reply',
      via: 'individual',
      created_at: D.T7,
    },
    {
      unitId: 'unit-mx-tourable-03',
      contactId: 'tenant-mx-placing-standalone-01',
      sentAt: D.T8,
      response: 'not_a_fit',
      via: 'individual',
      created_at: D.T8,
    },
  ];
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
function buildInvoices(): Record<string, unknown>[] {
  return [
    {
      invoiceId: 'invoice-mx-draft-01',
      landlordId: 'contact-landlord-0001',
      status: 'draft',
      amount_cents: 175000,
      placementId: 'placement-mx-awaiting-move-in-01',
      due_at: '2026-09-01',
      created_at: D.T9,
    },
    {
      invoiceId: 'invoice-mx-paid-01',
      landlordId: 'contact-landlord-0001',
      status: 'paid',
      amount_cents: 185000,
      placementId: 'placement-mx-moved-in-01',
      due_at: '2026-05-15',
      sent_at: D.T8,
      paid_at: D.TA,
      created_at: D.T8,
    },
  ];
}

// ---------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------
function buildActivityEvents(): Record<string, unknown>[] {
  const ev = (contactId: string, at: string, type: string, label: string, refType?: string, refId?: string): Record<string, unknown> => {
    const eventId = `evt-mx-${type.replace(/_/g, '-')}-${contactId.slice(-4)}`;
    return {
      contactId,
      tsEventId: `${at}#${eventId}`,
      eventId,
      at,
      type,
      label,
      ...(refType ? { refType } : {}),
      ...(refId ? { refId } : {}),
      created_at: at,
    };
  };
  return [
    ev('tenant-mx-send-application-01', D.T0, 'placement_opened', 'Placement opened', 'placement', 'placement-mx-send-application-01'),
    ev('tenant-mx-awaiting-inspection-01', D.T2, 'stage_changed', 'Moved to Awaiting inspection', 'placement', 'placement-mx-awaiting-inspection-01'),
    ev('tenant-mx-moved-in-01', D.TA, 'placement_closed', 'Moved in', 'placement', 'placement-mx-moved-in-01'),
    ev('tenant-mx-searching-standalone-01', D.T6, 'listing_sent', 'Property sent', 'unit', 'unit-mx-tourable-01'),
  ];
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------
function buildSettings(): Record<string, unknown>[] {
  return [
    {
      settingId: 'org',
      welcomeText: 'Welcome to Housing Choice! You\'re now set up to receive new property listings that match your voucher. Reply STOP to opt out, HELP for help.',
      quickReplies: ['Please text me', "I'll call you back soon", 'What\'s your timeline?'],
      missedCallAutoText: 'Housing Choice: Sorry we missed your call! Please text us your full name, voucher size, and housing authority to get started. Reply STOP to opt out.',
      missedCallAutoTextEnabled: true,
      preRingPauseSeconds: 2,
    },
  ];
}

// ---------------------------------------------------------------------------
// Additional VA user
// ---------------------------------------------------------------------------
function buildUsers(): Record<string, unknown>[] {
  return [
    {
      userId: 'user-0003',
      email: 'va2@example.com',
      role: 'va',
      name: 'Alex Chen',
      google_sub: 'google-oauth2|seed-va2',
      scopes: ['conversations:rw', 'contacts:rw'],
      created_at: D.T0,
    },
  ];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Cross-cutting story-snapshot items that complement the lean seed + cast.
 * Merged on top of SEED + castItems() by seedAll('full').
 *
 * Every PLACEMENT_STAGE ×2, LISTING_STATUS ×2, TENANT_STATUS ×2,
 * LANDLORD_STATUS ×2, TOUR_STATUS ×2 are guaranteed in the FULL profile
 * (lean provides the pinned trio; cast adds more; matrix tops up to ≥2).
 *
 * §7 tripwire: every placement's tenant + unit carry deriveStatuses(stage)
 * output with status_source:'derived'.
 *
 * Reminder invariant: 'requested' tours → zero reminder rows; all other
 * tours with sentAt reminders are valid archive writes (the worker already ran).
 */
export function matrixItems(now: Date = new Date()): Record<string, Record<string, unknown>[]> {
  const placementGroups = buildPlacementsMatrix(now);

  // Collect available unit IDs for tours to reference
  const unitGroups = buildUnitsMatrix(placementGroups);
  const availableUnitIds = [
    ...unitGroups.filter((g) => g.unit['status'] === 'available').map((g) => g.unit['unitId'] as string),
    'unit-mx-tourable-01', 'unit-mx-tourable-02', 'unit-mx-tourable-03',
    'unit-mx-tourable-04', 'unit-mx-tourable-05', 'unit-mx-tourable-06',
  ];

  // Searching tenant IDs for tours to reference
  const tenantGroups = buildTenantsMatrix(placementGroups);
  const searchingTenantIds = [
    ...placementGroups.filter((g) => g.stage === 'lost').map((g) => g.tenantId),
    ...tenantGroups.filter((g) => g.tenant['status'] === 'searching').map((g) => g.tenant['contactId'] as string),
    'tenant-mx-searching-standalone-01',
  ];

  const tourGroups = buildToursMatrix(now, availableUnitIds, searchingTenantIds);
  const landlordGroups = buildLandlordsMatrix();

  // Flatten everything by table
  const contacts: Record<string, unknown>[] = [
    ...placementGroups.map((g) => g.tenant),
    ...tenantGroups.map((g) => g.tenant),
    ...landlordGroups.map((g) => g.landlord),
  ];

  const units: Record<string, unknown>[] = [
    ...placementGroups.map((g) => g.unit),
    ...unitGroups.map((g) => g.unit),
  ];

  const placements: Record<string, unknown>[] = placementGroups.map((g) => g.placement);
  const placementDeadlines: Record<string, unknown>[] = placementGroups
    .filter((g) => g.deadline !== undefined)
    .map((g) => g.deadline as Record<string, unknown>);
  const tours: Record<string, unknown>[] = tourGroups.map((g) => g.tour);
  const tourReminders: Record<string, unknown>[] = tourGroups.flatMap((g) => g.reminders);

  return {
    contacts,
    units,
    placements,
    placementDeadlines,
    tours,
    tourReminders,
    pool_numbers: buildPoolNumbers(),
    conversations: buildRelayConversations(),
    broadcasts: buildBroadcasts(),
    listing_sends: buildListingSends(),
    invoices: buildInvoices(),
    activity_events: buildActivityEvents(),
    settings: buildSettings(),
    users: buildUsers(),
  };
}
