// Drift-guards for the status-model mirror (MIRRORS app/src/lib/statusModel.ts).
// Every enum value must have a display label, and the stage→phase map must be
// total — so a model change that adds a value without a label fails fast here
// rather than rendering blank in the UI.
import { describe, expect, it } from 'vitest';
import {
  LISTING_STATUSES,
  LISTING_STATUS_LABELS,
  LOST_REASON_CATEGORIES,
  LOST_REASON_CATEGORY_LABELS,
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_LABELS,
  STAGE_PHASE,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  formatLostReason,
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
