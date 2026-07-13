// Unit tests for the centralized status model (lib/statusModel.ts): proves the
// ONE ordered stage list, the phase/label/threshold maps, the derivation table,
// the terminal set, the guards, and the source-precedence ordering are
// internally consistent — the invariants every transition relies on.
import { describe, expect, it } from 'vitest';
import {
  deriveStatuses,
  isListingOverrideStatus,
  isLandlordStatus,
  isListingStatus,
  isLostReasonCategory,
  isPlacementStage,
  isTenantOverrideStatus,
  isTenantStatus,
  isTransitionSource,
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  LISTING_OVERRIDE_STATES,
  LISTING_STATUSES,
  LOST_REASON_CATEGORIES,
  phaseForStage,
  PLACEMENT_DERIVATION,
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  SOURCE_PRECEDENCE,
  STAGE_LABELS,
  STAGE_PHASE,
  STAGE_STUCK_THRESHOLDS,
  TENANT_OVERRIDE_STATES,
  TENANT_STATUSES,
  TERMINAL_STAGES,
  TRANSITION_SOURCES,
  type PlacementStage,
} from '../src/lib/statusModel.js';

const NON_TERMINAL = PLACEMENT_STAGES.filter((s) => !TERMINAL_STAGES.has(s));

describe('statusModel — stages, phases, labels, thresholds', () => {
  it('every stage has a phase that is a known phase', () => {
    for (const stage of PLACEMENT_STAGES) {
      const phase = STAGE_PHASE[stage];
      expect(phase).toBeDefined();
      expect(PLACEMENT_PHASES).toContain(phase);
    }
  });

  it('every stage has a non-empty display label', () => {
    for (const stage of PLACEMENT_STAGES) {
      expect(typeof STAGE_LABELS[stage]).toBe('string');
      expect(STAGE_LABELS[stage].length).toBeGreaterThan(0);
    }
  });

  it('keeps RTA/HAP acronyms all-caps in labels', () => {
    expect(STAGE_LABELS.awaiting_authority_approval).toBe('Awaiting authority approval');
    expect(STAGE_LABELS.send_rta_to_landlord).toBe('Send RTA to landlord');
    expect(STAGE_LABELS.collect_rta).toBe('Collect RTA');
    expect(STAGE_LABELS.awaiting_hap_contract).toBe('Awaiting HAP contract');
  });

  it('every NON-terminal stage has a positive stuck threshold; terminals have none', () => {
    for (const stage of NON_TERMINAL) {
      const t = STAGE_STUCK_THRESHOLDS[stage];
      expect(typeof t).toBe('number');
      expect(t!).toBeGreaterThan(0);
    }
    expect(STAGE_STUCK_THRESHOLDS.moved_in).toBeUndefined();
    expect(STAGE_STUCK_THRESHOLDS.lost).toBeUndefined();
  });

  it('the terminal set is exactly {moved_in, lost}', () => {
    expect([...TERMINAL_STAGES].sort()).toEqual(['lost', 'moved_in']);
  });

  it('stage keys are snake_case (no spaces/uppercase)', () => {
    for (const stage of PLACEMENT_STAGES) {
      expect(stage).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe('statusModel — derivation (§7)', () => {
  it('every stage resolves a derivation with valid tenant + listing statuses', () => {
    for (const stage of PLACEMENT_STAGES) {
      const d = PLACEMENT_DERIVATION[stage];
      expect(d).toBeDefined();
      expect(TENANT_STATUSES).toContain(d.tenantStatus);
      expect(LISTING_STATUSES).toContain(d.listingStatus);
      // The materialized table matches the function.
      expect(d).toEqual(deriveStatuses(stage));
    }
  });

  it('Application…Rent Determination ⇒ placing / under_application', () => {
    for (const stage of ['send_application', 'collect_rta', 'awaiting_inspection', 'determine_rent'] as PlacementStage[]) {
      expect(deriveStatuses(stage)).toEqual({ tenantStatus: 'placing', listingStatus: 'under_application' });
    }
  });

  it('Contract + Administrative + Closure(awaiting_move_in) ⇒ placing / finalizing', () => {
    expect(deriveStatuses('awaiting_hap_contract')).toEqual({ tenantStatus: 'placing', listingStatus: 'finalizing' });
    expect(deriveStatuses('complete_paperwork')).toEqual({ tenantStatus: 'placing', listingStatus: 'finalizing' });
    // awaiting_move_in is the non-terminal Closure stage — a deal in final move-in
    // prep is Finalizing, not Under application (§3/§6 listing lifecycle).
    expect(deriveStatuses('awaiting_move_in')).toEqual({ tenantStatus: 'placing', listingStatus: 'finalizing' });
  });

  it('moved_in ⇒ placed / occupied; lost ⇒ searching / available', () => {
    expect(deriveStatuses('moved_in')).toEqual({ tenantStatus: 'placed', listingStatus: 'occupied' });
    expect(deriveStatuses('lost')).toEqual({ tenantStatus: 'searching', listingStatus: 'available' });
  });

  it('NO derivation output is an OVERRIDE/exit state (derivation never pins; 2026-06-19 decision)', () => {
    // Override/exit states (listing on_hold/off_market, tenant on_hold/inactive)
    // are produced ONLY by explicit writes — derivation must never yield one, or
    // a placement progression could silently push an entity into an override.
    for (const stage of PLACEMENT_STAGES) {
      const d = PLACEMENT_DERIVATION[stage];
      expect(isListingOverrideStatus(d.listingStatus), `${stage} → listing`).toBe(false);
      expect(isTenantOverrideStatus(d.tenantStatus), `${stage} → tenant`).toBe(false);
    }
  });
});

describe('statusModel — guards reject junk', () => {
  it('isPlacementStage', () => {
    expect(isPlacementStage('send_application')).toBe(true);
    expect(isPlacementStage('touring')).toBe(false); // legacy stage gone
    expect(isPlacementStage('placed')).toBe(false); // a tenant status
    expect(isPlacementStage('')).toBe(false);
    expect(isPlacementStage(42)).toBe(false);
    expect(isPlacementStage(undefined)).toBe(false);
  });

  it('isTenantStatus / isListingStatus', () => {
    expect(isTenantStatus('searching')).toBe(true);
    expect(isTenantStatus('available')).toBe(false); // a listing status
    expect(isListingStatus('available')).toBe(true);
    expect(isListingStatus('searching')).toBe(false);
    expect(isListingStatus('placed')).toBe(false); // not a listing status (occupied)
  });

  it('isLandlordStatus: the landlord lead lifecycle only (rejects tenant-only + junk)', () => {
    for (const s of LANDLORD_STATUSES) {
      expect(isLandlordStatus(s)).toBe(true);
    }
    expect([...LANDLORD_STATUSES].sort()).toEqual([
      'active',
      'interested',
      'needs_review',
      'onboarding',
      'parked',
    ]);
    // Tenant-only lifecycle values are NOT landlord statuses (the leak we close).
    expect(isLandlordStatus('on_hold')).toBe(false);
    expect(isLandlordStatus('inactive')).toBe(false);
    expect(isLandlordStatus('searching')).toBe(false);
    expect(isLandlordStatus('bogus')).toBe(false);
    expect(isLandlordStatus(undefined)).toBe(false);
  });

  it('landlord lifecycle ORDER: onboarding sits between interested and active', () => {
    // The lead lifecycle order is load-bearing (menus/badges render from it):
    // needs_review -> interested -> onboarding -> active, with terminal parked.
    expect([...LANDLORD_STATUSES]).toEqual([
      'needs_review',
      'interested',
      'onboarding',
      'active',
      'parked',
    ]);
    const idx = (s: string) => LANDLORD_STATUSES.indexOf(s as (typeof LANDLORD_STATUSES)[number]);
    expect(idx('interested')).toBeLessThan(idx('onboarding'));
    expect(idx('onboarding')).toBeLessThan(idx('active'));
  });

  it('landlord labels: onboarding is "Onboarding"; every status has a label', () => {
    expect(LANDLORD_STATUS_LABELS.onboarding).toBe('Onboarding');
    for (const s of LANDLORD_STATUSES) {
      expect(typeof LANDLORD_STATUS_LABELS[s]).toBe('string');
      expect(LANDLORD_STATUS_LABELS[s].length).toBeGreaterThan(0);
    }
  });

  it('isLostReasonCategory / isTransitionSource', () => {
    expect(isLostReasonCategory('voucher_expired')).toBe(true);
    expect(isLostReasonCategory('nope')).toBe(false);
    expect(isTransitionSource('derived')).toBe(true);
    expect(isTransitionSource('manual')).toBe(true);
    expect(isTransitionSource('robot')).toBe(false);
  });
});

describe('statusModel — source precedence (audit/provenance only, §8)', () => {
  it('derived is strictly lowest; all non-derived are equal rank', () => {
    // SOURCE_PRECEDENCE is now PROVENANCE/audit metadata only — it no longer
    // gates derivation (that is STATE-based; see the override-state tests below).
    expect(SOURCE_PRECEDENCE.derived).toBe(0);
    for (const s of TRANSITION_SOURCES.filter((x) => x !== 'derived')) {
      expect(SOURCE_PRECEDENCE[s]).toBe(1);
    }
  });
});

describe('statusModel — override/exit states pin against derivation (2026-06-19 decision)', () => {
  it('the override-state sets are exactly the §5/§6 overrides + exits', () => {
    expect([...LISTING_OVERRIDE_STATES].sort()).toEqual(['off_market', 'on_hold']);
    expect([...TENANT_OVERRIDE_STATES].sort()).toEqual(['inactive', 'on_hold']);
  });

  it('isListingOverrideStatus: only on_hold/off_market pin; baseline states do not', () => {
    for (const s of ['on_hold', 'off_market'] as const) {
      expect(isListingOverrideStatus(s)).toBe(true);
    }
    for (const s of ['setup', 'available', 'under_application', 'finalizing', 'occupied'] as const) {
      expect(isListingOverrideStatus(s)).toBe(false);
    }
    expect(isListingOverrideStatus(undefined)).toBe(false);
  });

  it('isTenantOverrideStatus: only on_hold/inactive pin; baseline states do not', () => {
    for (const s of ['on_hold', 'inactive'] as const) {
      expect(isTenantOverrideStatus(s)).toBe(true);
    }
    for (const s of ['needs_review', 'onboarding', 'searching', 'placing', 'placed'] as const) {
      expect(isTenantOverrideStatus(s)).toBe(false);
    }
    expect(isTenantOverrideStatus(undefined)).toBe(false);
  });
});

describe('statusModel — lost reason categories', () => {
  it('matches the §7 set', () => {
    expect([...LOST_REASON_CATEGORIES].sort()).toEqual(
      [
        'landlord_lost_inspection',
        'landlord_lost_rent',
        'no_contact',
        'other',
        'stalled',
        'tenant_withdrew',
        'voucher_expired',
      ].sort(),
    );
  });
});

describe('statusModel — phaseForStage helper', () => {
  it('returns the phase for a known stage, undefined for junk', () => {
    expect(phaseForStage('awaiting_hap_contract')).toBe('Contract');
    expect(phaseForStage('send_application')).toBe('Application');
    expect(phaseForStage('bogus')).toBeUndefined();
  });
});
