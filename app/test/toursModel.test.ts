// Unit tests for the tours status model (lib/toursModel.ts): proves the
// status enum, guards, labels, outcome enum, and reschedulability rule are
// internally consistent. Pure unit test — no I/O, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  canReschedule,
  isTourOutcome,
  isTourStatus,
  TOUR_OUTCOME_LABELS,
  TOUR_OUTCOMES,
  TOUR_STATUS_LABELS,
  TOUR_STATUSES,
  type TourOutcome,
  type TourStatus,
} from '../src/lib/toursModel.js';

describe('toursModel — TOUR_STATUSES', () => {
  it('contains exactly the six expected statuses in order (requested first)', () => {
    expect([...TOUR_STATUSES]).toEqual([
      'requested',
      'scheduled',
      'toured',
      'no_show',
      'canceled',
      'closed',
    ]);
  });

  it("does NOT contain 'confirmed' (removed 2026-07-08 - scheduled covers it)", () => {
    expect([...TOUR_STATUSES]).not.toContain('confirmed');
    expect(isTourStatus('confirmed')).toBe(false);
  });

  it('status keys are snake_case (no spaces/uppercase)', () => {
    for (const s of TOUR_STATUSES) {
      expect(s).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe('toursModel — isTourStatus guard', () => {
  it('accepts all six valid statuses', () => {
    for (const s of TOUR_STATUSES) {
      expect(isTourStatus(s)).toBe(true);
    }
  });

  it('accepts requested explicitly', () => {
    expect(isTourStatus('requested')).toBe(true);
  });

  it('rejects non-status strings', () => {
    expect(isTourStatus('')).toBe(false);
    expect(isTourStatus('converted')).toBe(false);
    expect(isTourStatus('foo')).toBe(false);
    expect(isTourStatus('Scheduled')).toBe(false);
    expect(isTourStatus('CANCELED')).toBe(false);
    expect(isTourStatus('Requested')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isTourStatus(undefined)).toBe(false);
    expect(isTourStatus(null)).toBe(false);
    expect(isTourStatus(42)).toBe(false);
    expect(isTourStatus({})).toBe(false);
  });
});

describe('toursModel — TOUR_STATUS_LABELS', () => {
  it('every status (including requested) has a non-empty label', () => {
    for (const s of TOUR_STATUSES) {
      expect(typeof TOUR_STATUS_LABELS[s]).toBe('string');
      expect(TOUR_STATUS_LABELS[s].length).toBeGreaterThan(0);
    }
  });

  it('requested label is Requested', () => {
    expect(TOUR_STATUS_LABELS['requested']).toBe('Requested');
  });

  it('labels are sentence-case (first char uppercase)', () => {
    for (const s of TOUR_STATUSES) {
      const label = TOUR_STATUS_LABELS[s];
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });

  it("labels 'requested' as 'Requested' (timeless pre-scheduled state)", () => {
    expect(TOUR_STATUS_LABELS['requested']).toBe('Requested');
  });
});

describe('toursModel — canReschedule', () => {
  it('returns true for reschedulable statuses (requested = booking rides the same guard)', () => {
    const reschedulable: TourStatus[] = ['requested', 'scheduled', 'canceled', 'no_show'];
    for (const s of reschedulable) {
      expect(canReschedule(s)).toBe(true);
    }
  });

  it('returns true for requested (setting a time IS the scheduling step)', () => {
    expect(canReschedule('requested')).toBe(true);
  });

  it('returns false for non-reschedulable statuses', () => {
    const notReschedulable: TourStatus[] = ['toured', 'closed'];
    for (const s of notReschedulable) {
      expect(canReschedule(s)).toBe(false);
    }
  });

  it('covers the exact reschedule set — no extra trues', () => {
    const trueSet = TOUR_STATUSES.filter((s) => canReschedule(s));
    expect(trueSet.sort()).toEqual(
      ['canceled', 'no_show', 'requested', 'scheduled'].sort(),
    );
  });
});

describe('toursModel — TOUR_OUTCOMES', () => {
  it('contains exactly the two outcomes', () => {
    expect([...TOUR_OUTCOMES]).toEqual(['move_forward', 'not_a_fit']);
  });
});

describe('toursModel — isTourOutcome guard', () => {
  it('accepts both valid outcomes', () => {
    const outcomes: TourOutcome[] = ['move_forward', 'not_a_fit'];
    for (const o of outcomes) {
      expect(isTourOutcome(o)).toBe(true);
    }
  });

  it('rejects non-outcome values', () => {
    expect(isTourOutcome('')).toBe(false);
    expect(isTourOutcome('converted')).toBe(false);
    expect(isTourOutcome('move forward')).toBe(false);
    expect(isTourOutcome(undefined)).toBe(false);
    expect(isTourOutcome(null)).toBe(false);
  });
});

describe('toursModel — TOUR_OUTCOME_LABELS', () => {
  it('every outcome has a non-empty label', () => {
    for (const o of TOUR_OUTCOMES) {
      expect(typeof TOUR_OUTCOME_LABELS[o]).toBe('string');
      expect(TOUR_OUTCOME_LABELS[o].length).toBeGreaterThan(0);
    }
  });
});
