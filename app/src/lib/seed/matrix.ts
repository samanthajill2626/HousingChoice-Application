// matrix.ts — deterministic coverage generators for the 'full' seed profile.
//
// Every enum value for placements (stages), units (listing statuses), tenants,
// landlords, and tours appears ≥2 times. IDs use a fixed pattern:
//   <entity>-mx-<state>-NN   e.g. tenant-mx-searching-01, placement-mx-send-application-01
// Names come from fixed pools (never Math.random). Dates are fixed past ISO
// constants (nothing relative to now — that is Task 4's live.ts).
//
// §7 tripwire: every placement's linked tenant + unit carry the status that
// deriveStatuses(stage) produces, with status_source:'derived'.
//
// Invariant: a 'requested' tour has ZERO reminder rows; a 'no_show' tour has a
// no_show_checkin reminder row with sentAt set (archive — written directly for
// historical tours since the reminder worker never ran for them).

import { PLACEMENT_STAGES, LISTING_STATUSES, TENANT_STATUSES, LANDLORD_STATUSES, deriveStatuses, type PlacementStage } from '../statusModel.js';
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
  'Self-guided lockbox; available Mon–Fri 9–5. Text to request code.',
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
const deadlineType = (i: number): DeadlineType => DEADLINE_TYPES[i % DEADLINE_TYPES.length]!;

// Paired deadline dates (past, fixed)
const DEADLINE_DATES = [
  '2026-01-10T13:00:00.000Z',
  '2026-01-25T13:00:00.000Z',
  '2026-02-10T13:00:00.000Z',
  '2026-02-25T13:00:00.000Z',
  '2026-03-10T13:00:00.000Z',
];
const deadlineAt = (i: number) => DEADLINE_DATES[i % DEADLINE_DATES.length]!;

// ---------------------------------------------------------------------------
// Attention reasons
// ---------------------------------------------------------------------------
const ATTENTION_REASONS = [
  'Voucher expiring soon — expedite',
  'Landlord unreachable — follow up immediately',
  'Inspection overdue — reschedule required',
  'RTA window closing — escalate',
];
const attentionReason = (i: number) => ATTENTION_REASONS[i % ATTENTION_REASONS.length]!;

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
 * Build the 2-per-stage placement matrix: 17 active stages ×2, moved_in ×2, lost ×2.
 * Each placement gets its own tenant + unit with deriveStatuses applied.
 */
function buildPlacementsMatrix(): PlacementGroup[] {
  const groups: PlacementGroup[] = [];
  let counter = 0;

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
      const fi = counter;
      const li = counter + 3;
      const createdAt = pastDate(counter);
      const hasDeadline = counter % 2 === 0; // alternate which rows have a deadline
      const hasAttention = counter % 5 === 0; // ~20% of rows carry attention

      const placementBase: Record<string, unknown> = {
        placementId,
        tenantId,
        unitId,
        stage,
        stage_entered_at: createdAt,
        stage_source: 'manual',
        created_at: createdAt,
      };

      // Deadlines are first-class placementDeadlines items now. When this row has
      // one, build the item (deterministic id) instead of a stored next_deadline
      // slot. All matrix rows are non-terminal here (moved_in/lost handled below),
      // and their stage_entered_at is months in the past — so they ALSO derive as
      // "stuck" in Today, exercising derived-stuck coverage without extra fixtures.
      let deadline: Record<string, unknown> | undefined;
      if (hasDeadline) {
        const dt = deadlineType(counter);
        const at = deadlineAt(counter);
        deadline = {
          deadlineId: deadlineIdFor(placementId, dt),
          placementId,
          type: dt,
          at,
          _deadlinePartition: 'deadlines',
          createdAt,
          updatedAt: createdAt,
        };
      }

      if (hasAttention) {
        placementBase['attention'] = { reason: attentionReason(counter), at: createdAt };
      }

      // Cover the voucher-sync source field on ~1/3 of tenants (a fixed future
      // date; distinct from the deadline TYPE and from voucherSize).
      const tenant: Record<string, unknown> = {
        contactId: tenantId,
        type: 'tenant',
        status: derived.tenantStatus,
        status_source: 'derived',
        phone: phoneBase(counter),
        firstName: firstName(TENANT_FIRST, fi),
        lastName: lastName(TENANT_LAST, fi),
        voucherSize: beds(counter),
        housingAuthority: auth(counter),
        porting: counter % 3 === 0,
        consent_method: matrixConsent(counter),
        consent_at: createdAt,
        created_at: createdAt,
      };
      if (counter % 3 === 0) tenant['voucher_expiration_date'] = '2026-09-30T00:00:00.000Z';

      groups.push({
        tenantId,
        unitId,
        placementId,
        stage,
        ...(deadline !== undefined && { deadline }),
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

  // moved_in ×2
  for (let rep = 1; rep <= 2; rep++) {
    counter++;
    const stage: PlacementStage = 'moved_in';
    const tenantId = stableId('tenant', stage, rep);
    const unitId = stableId('unit', stage, rep);
    const placementId = stableId('placement', stage, rep);
    const derived = deriveStatuses(stage);
    const createdAt = pastDate(counter);
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
        move_in_date: '2026-05-01',
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
        stage_entered_at: createdAt,
        stage_source: 'manual',
        move_in_date: '2026-05-01',
        lease_date: '2026-04-15',
        created_at: createdAt,
      },
    });
  }

  // lost ×2 — distinct reason categories
  for (let rep = 1; rep <= 2; rep++) {
    counter++;
    const stage: PlacementStage = 'lost';
    const tenantId = stableId('tenant', stage, rep);
    const unitId = stableId('unit', stage, rep);
    const placementId = stableId('placement', stage, rep);
    const derived = deriveStatuses(stage);
    const createdAt = pastDate(counter);
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
        stage_entered_at: createdAt,
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
  // spread across authorities, beds 1–4, and all three tour-process types
  const tourableSpecs = [
    { authority: 'atlanta_housing', beds: 1, processType: 'self_guided' },
    { authority: 'ga_dca', beds: 2, processType: 'landlord_led' },
    { authority: 'dekalb_housing', beds: 3, processType: 'pm_team' },
    { authority: 'fulton_housing', beds: 4, processType: 'self_guided' },
    { authority: 'gwinnett_housing', beds: 2, processType: 'landlord_led' },
    { authority: 'cobb_housing', beds: 3, processType: 'pm_team' },
  ] as const;

  const TOURL_PROCESSES_BY_TYPE: Record<string, string> = {
    self_guided: 'Self-guided lockbox; available daily 8am–6pm. Text for the code.',
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

  for (const status of TENANT_STATUSES) {
    const existing = statusCounts[status] ?? 0;
    const needed = Math.max(0, 2 - existing);
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
// Tours matrix — every TOUR_STATUS ×2
// 'no_show' tours include a sent no_show_checkin reminder row.
// 'requested' tours have ZERO reminder rows.
// Other terminal/past tours have sent reminder rows.
// ---------------------------------------------------------------------------
interface TourGroup {
  tour: Record<string, unknown>;
  reminders: Record<string, unknown>[];
}

function buildToursMatrix(availableUnitIds: string[], searchingTenantIds: string[]): TourGroup[] {
  const groups: TourGroup[] = [];
  let counter = 0;
  let unitIdx = 0;
  let tenantIdx = 0;

  const pickUnit = () => availableUnitIds[unitIdx++ % Math.max(1, availableUnitIds.length)] ?? 'unit-mx-tourable-01';
  const pickTenant = () => searchingTenantIds[tenantIdx++ % Math.max(1, searchingTenantIds.length)] ?? 'tenant-mx-searching-standalone-01';

  for (const status of TOUR_STATUSES) {
    for (let rep = 1; rep <= 2; rep++) {
      counter++;
      const tourId = `tour-mx-${status.replace(/_/g, '-')}-${String(rep).padStart(2, '0')}`;
      const unitId = pickUnit();
      const tenantId = pickTenant();
      const createdAt = pastDate(counter);
      const reminders: Record<string, unknown>[] = [];

      const tour: Record<string, unknown> = {
        tourId,
        tenantId,
        unitId,
        status,
        tourType: counter % 3 === 0 ? 'pm_team' : counter % 3 === 1 ? 'landlord_led' : 'self_guided',
        createdAt,
        updatedAt: createdAt,
        _schedPartition: 'tours', // needed for byScheduledAt GSI when scheduledAt present
      };

      if (status === 'requested') {
        // INVARIANT: no scheduledAt, no reminder rows
        delete tour['_schedPartition']; // omit — no scheduledAt on requested
      } else {
        // All non-requested tours have a scheduled time (past)
        const scheduledAt = pastDate(counter + 1);
        tour['scheduledAt'] = scheduledAt;

        if (status === 'no_show') {
          // Write a sent no_show_checkin reminder row (archive; sentAt set)
          const remId = `rem-mx-${tourId}-nsc`;
          reminders.push({
            reminderId: remId,
            tourId,
            kind: 'no_show_checkin',
            dueAt: scheduledAt, // sent around the scheduled time + 30m (simplified to same ts)
            sentAt: pastDate(counter + 2),
            _reminderPartition: 'reminders',
            createdAt,
          });
        } else if (status === 'scheduled' || status === 'confirmed') {
          // Scheduled/confirmed: write pending reminder rows (dueAt in future relative to a past creation)
          // We still use past dates for byte stability, but sentAt is absent (pending)
          const remId1 = `rem-mx-${tourId}-conf`;
          reminders.push({
            reminderId: remId1,
            tourId,
            kind: 'confirmation',
            dueAt: pastDate(counter),
            sentAt: pastDate(counter), // sent immediately on creation
            _reminderPartition: 'reminders',
            createdAt,
          });
          const remId2 = `rem-mx-${tourId}-dbf`;
          reminders.push({
            reminderId: remId2,
            tourId,
            kind: 'day_before',
            dueAt: pastDate(counter + 1),
            // sentAt absent = pending
            _reminderPartition: 'reminders',
            createdAt,
          });
        } else if (status === 'toured') {
          tour['outcome'] = rep === 1 ? 'move_forward' : 'not_a_fit';
          tour['moveForward'] = rep === 1;
          tour['convertible'] = rep === 1;
          // Archived — write a sent confirmation reminder
          reminders.push({
            reminderId: `rem-mx-${tourId}-conf`,
            tourId,
            kind: 'confirmation',
            dueAt: pastDate(counter),
            sentAt: pastDate(counter),
            _reminderPartition: 'reminders',
            createdAt,
          });
        } else if (status === 'closed') {
          tour['outcome'] = rep === 1 ? 'move_forward' : 'not_a_fit';
          tour['moveForward'] = rep === 1;
          reminders.push({
            reminderId: `rem-mx-${tourId}-conf`,
            tourId,
            kind: 'confirmation',
            dueAt: pastDate(counter),
            sentAt: pastDate(counter),
            _reminderPartition: 'reminders',
            createdAt,
          });
        } else if (status === 'canceled') {
          reminders.push({
            reminderId: `rem-mx-${tourId}-conf`,
            tourId,
            kind: 'confirmation',
            dueAt: pastDate(counter),
            canceledAt: pastDate(counter + 1),
            _reminderPartition: 'reminders',
            createdAt,
          });
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
export function matrixItems(): Record<string, Record<string, unknown>[]> {
  const placementGroups = buildPlacementsMatrix();

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

  const tourGroups = buildToursMatrix(availableUnitIds, searchingTenantIds);
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
