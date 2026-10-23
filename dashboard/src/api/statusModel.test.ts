// Drift-guards for the status-model mirror (MIRRORS app/src/lib/statusModel.ts).
// Every enum value must have a display label, and the stage→phase map must be
// total — so a model change that adds a value without a label fails fast here
// rather than rendering blank in the UI.
import { describe, expect, it } from 'vitest';
import {
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  LOST_REASON_CATEGORIES,
  LOST_REASON_CATEGORY_LABELS,
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS,
  contactStatusLabelFor,
  formatLostReason,
  statusOptionsFor,
} from './index.js';

describe('status-model label coverage (drift-guard)', () => {
  it('every placement stage has a label and a phase', () => {
    for (const s of PLACEMENT_STAGES) {
      expect(STAGE_LABELS[s], `label for ${s}`).toBeTruthy();
      expect(PLACEMENT_PHASES, `phase for ${s}`).toContain(STAGE_PHASE[s]);
    }
    expect(Object.keys(STAGE_LABELS)).toHaveLength(PLACEMENT_STAGES.length);
  });

  it('every property status has a label', () => {
    for (const s of LISTING_STATUSES) expect(LISTING_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(LISTING_STATUS_LABELS)).toHaveLength(LISTING_STATUSES.length);
  });

  it('every tenant status has a label', () => {
    for (const s of TENANT_STATUSES) expect(TENANT_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(TENANT_STATUS_LABELS)).toHaveLength(TENANT_STATUSES.length);
  });

  it('every landlord, partner / team member and unknown status has a label (spec 2026-10-23 D1)', () => {
    for (const s of LANDLORD_STATUSES) expect(LANDLORD_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(LANDLORD_STATUS_LABELS)).toHaveLength(LANDLORD_STATUSES.length);
    for (const s of PARTNER_STATUSES) expect(PARTNER_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(PARTNER_STATUS_LABELS)).toHaveLength(PARTNER_STATUSES.length);
    for (const s of UNKNOWN_STATUSES) expect(UNKNOWN_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    expect(Object.keys(UNKNOWN_STATUS_LABELS)).toHaveLength(UNKNOWN_STATUSES.length);
  });

  it('every lost-reason category has a label', () => {
    for (const c of LOST_REASON_CATEGORIES) {
      expect(LOST_REASON_CATEGORY_LABELS[c], `label for ${c}`).toBeTruthy();
    }
    expect(Object.keys(LOST_REASON_CATEGORY_LABELS)).toHaveLength(LOST_REASON_CATEGORIES.length);
  });

  it('counts match the model (7 phases, 18 stages, 7/7/7 enums)', () => {
    expect(PLACEMENT_PHASES).toHaveLength(7);
    expect(PLACEMENT_STAGES).toHaveLength(18);
    expect(LISTING_STATUSES).toHaveLength(7);
    expect(TENANT_STATUSES).toHaveLength(7);
    expect(LOST_REASON_CATEGORIES).toHaveLength(7);
  });
});

describe('formatLostReason', () => {
  it('joins category label + free text', () => {
    expect(formatLostReason({ category: 'landlord_lost_rent', text: 'comp too high' })).toBe(
      "Landlord couldn't get rent — comp too high",
    );
  });
  it('renders category alone, text alone, or empty', () => {
    expect(formatLostReason({ category: 'voucher_expired' })).toBe('Voucher expired');
    expect(formatLostReason({ text: 'just a note' })).toBe('just a note');
    expect(formatLostReason({})).toBe('');
    expect(formatLostReason(undefined)).toBe('');
  });
});

// Spec 2026-10-23 D1/D3: the ONE per-type list the header dropdown and the
// edit form both read.
describe('statusOptionsFor / contactStatusLabelFor (spec 2026-10-23 D1)', () => {
  it.each([
    ['tenant', ['Needs review', 'Onboarding', 'Searching', 'Placing', 'Placed', 'On hold', 'Inactive']],
    ['landlord', ['Needs review', 'Interested', 'Onboarding', 'Active', 'Parked']],
    ['partner', ['Needs review', 'Active', 'Inactive']],
    ['team_member', ['Needs review', 'Active', 'Inactive']],
    ['unknown', ['Needs review', 'Inactive']],
  ] as const)('a %s offers exactly its D1 list, in dropdown order', (type, labels) => {
    expect(statusOptionsFor(type).map((o) => o.label)).toEqual(labels);
  });

  it('values are the stored keys; unknown has no Active', () => {
    expect(statusOptionsFor('partner').map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
    expect(statusOptionsFor('unknown').map((o) => o.value)).toEqual(['needs_review', 'inactive']);
  });

  it('an unset or unrecognized type gets the partner / team member list (the server fallback)', () => {
    expect(statusOptionsFor(undefined).map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
    expect(statusOptionsFor('something_new').map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
  });

  it("labels a status from its own type's map and returns undefined off that list", () => {
    expect(contactStatusLabelFor('partner', 'inactive')).toBe('Inactive');
    expect(contactStatusLabelFor('team_member', 'active')).toBe('Active');
    expect(contactStatusLabelFor('unknown', 'needs_review')).toBe('Needs review');
    expect(contactStatusLabelFor('landlord', 'parked')).toBe('Parked');
    expect(contactStatusLabelFor('tenant', 'on_hold')).toBe('On hold');
    expect(contactStatusLabelFor('unknown', 'active')).toBeUndefined();
    expect(contactStatusLabelFor('landlord', 'on_hold')).toBeUndefined();
    // An inherited object key is not a label.
    expect(contactStatusLabelFor('tenant', 'constructor')).toBeUndefined();
  });
});
