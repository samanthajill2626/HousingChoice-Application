// Unit tests for the tours status model (lib/toursModel.ts): proves the
// status enum, guards, labels, outcome enum, and reschedulability rule are
// internally consistent. Pure unit test — no I/O, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  AUTO_CLOSE_AFTER_MS,
  AUTO_CLOSE_STATUSES,
  autoCloseDueAtMs,
  canReschedule,
  isAutoCloseDue,
  isStaffTourOutcome,
  isTourOutcome,
  isTourStatus,
  reopenTargetFor,
  STAFF_TOUR_OUTCOMES,
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
  it('contains exactly the three outcomes', () => {
    expect([...TOUR_OUTCOMES]).toEqual(['move_forward', 'not_a_fit', 'no_outcome']);
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

  it('accepts no_outcome (system-only: the auto-close sweep writes it)', () => {
    expect(isTourOutcome('no_outcome')).toBe(true);
  });
});

describe('toursModel — TOUR_OUTCOME_LABELS', () => {
  it('every outcome has a non-empty label', () => {
    for (const o of TOUR_OUTCOMES) {
      expect(typeof TOUR_OUTCOME_LABELS[o]).toBe('string');
      expect(TOUR_OUTCOME_LABELS[o].length).toBeGreaterThan(0);
    }
  });

  it("labels no_outcome as 'No outcome recorded'", () => {
    expect(TOUR_OUTCOME_LABELS.no_outcome).toBe('No outcome recorded');
  });
});

describe('toursModel - STAFF_TOUR_OUTCOMES (the PATCH outcome allowlist)', () => {
  it('is exactly the two outcomes a person may record', () => {
    expect([...STAFF_TOUR_OUTCOMES]).toEqual(['move_forward', 'not_a_fit']);
  });

  it('isStaffTourOutcome accepts both staff outcomes', () => {
    expect(isStaffTourOutcome('move_forward')).toBe(true);
    expect(isStaffTourOutcome('not_a_fit')).toBe(true);
  });

  it('isStaffTourOutcome rejects no_outcome (system-only) and non-outcomes', () => {
    expect(isStaffTourOutcome('no_outcome')).toBe(false);
    expect(isStaffTourOutcome('')).toBe(false);
    expect(isStaffTourOutcome(undefined)).toBe(false);
    expect(isStaffTourOutcome(null)).toBe(false);
    expect(isStaffTourOutcome('converted')).toBe(false);
  });
});

describe('toursModel - auto-close clock', () => {
  // A tour booked a month ahead and never marked: its clock starts at its time.
  const BASE = {
    status: 'scheduled',
    createdAt: '2026-09-01T00:00:00.000Z',
    scheduledAt: '2026-10-01T15:00:00.000Z',
  };
  const DUE = Date.parse('2026-10-15T15:00:00.000Z'); // scheduledAt + 14 days

  // Every shape of case 3-6 below: never a candidate, whatever the clock says.
  const NON_CANDIDATES = [
    { ...BASE, status: 'requested' },
    { ...BASE, status: 'canceled' },
    { ...BASE, status: 'closed' },
    { ...BASE, outcome: 'move_forward' },
    { ...BASE, outcome: 'not_a_fit' },
    { ...BASE, outcome: 'no_outcome' },
    { ...BASE, convertible: true },
    { ...BASE, convertedPlacementId: 'placement-1' },
    { ...BASE, convertedPlacementId: 'pending:abc' },
  ];

  it('1. two weeks exactly, over the three candidate statuses', () => {
    expect(AUTO_CLOSE_AFTER_MS).toBe(1209600000);
    expect([...AUTO_CLOSE_STATUSES]).toEqual(['scheduled', 'toured', 'no_show']);
  });

  it('2. scheduled / toured / no_show are due two weeks after their time', () => {
    for (const status of ['scheduled', 'toured', 'no_show']) {
      expect(autoCloseDueAtMs({ ...BASE, status })).toBe(DUE);
    }
  });

  it('3. requested, canceled and closed are never candidates', () => {
    for (const status of ['requested', 'canceled', 'closed']) {
      expect(autoCloseDueAtMs({ ...BASE, status })).toBeNull();
    }
  });

  it('4. any recorded outcome takes the tour out (Needs placement included)', () => {
    for (const outcome of ['move_forward', 'not_a_fit', 'no_outcome']) {
      expect(autoCloseDueAtMs({ ...BASE, outcome })).toBeNull();
    }
  });

  it('5. convertible: true takes the tour out; convertible: false does not', () => {
    expect(autoCloseDueAtMs({ ...BASE, convertible: true })).toBeNull();
    expect(autoCloseDueAtMs({ ...BASE, convertible: false })).toBe(DUE);
  });

  it('6. a conversion - finished or a pending: claim - takes the tour out', () => {
    expect(autoCloseDueAtMs({ ...BASE, convertedPlacementId: 'placement-1' })).toBeNull();
    expect(autoCloseDueAtMs({ ...BASE, convertedPlacementId: 'pending:abc' })).toBeNull();
  });

  it('7. a mark before the date changes nothing; a later mark restarts the clock', () => {
    expect(autoCloseDueAtMs({ ...BASE, lastMarkedAt: '2026-09-20T00:00:00.000Z' })).toBe(DUE);
    expect(autoCloseDueAtMs({ ...BASE, lastMarkedAt: '2026-10-10T09:00:00.000Z' })).toBe(
      Date.parse('2026-10-24T09:00:00.000Z'),
    );
  });

  it('8. a tour created after its own date counts from its creation', () => {
    expect(autoCloseDueAtMs({ ...BASE, createdAt: '2026-10-05T00:00:00.000Z' })).toBe(
      Date.parse('2026-10-19T00:00:00.000Z'),
    );
  });

  it('9. an undated scheduled / toured / no_show tour counts from its creation, or a later mark', () => {
    for (const status of ['scheduled', 'toured', 'no_show']) {
      const undated = { status, createdAt: '2026-09-01T00:00:00.000Z' };
      for (const tour of [undated, { ...undated, scheduledAt: '' }]) {
        expect(autoCloseDueAtMs(tour)).toBe(Date.parse('2026-09-15T00:00:00.000Z'));
        expect(autoCloseDueAtMs({ ...tour, lastMarkedAt: '2026-09-20T00:00:00.000Z' })).toBe(
          Date.parse('2026-10-04T00:00:00.000Z'),
        );
      }
    }
  });

  it('10. a clock input that is present but unreadable means never closing it', () => {
    expect(autoCloseDueAtMs({ ...BASE, createdAt: 'not-a-date' })).toBeNull();
    expect(autoCloseDueAtMs({ ...BASE, scheduledAt: 'not-a-date' })).toBeNull();
    expect(autoCloseDueAtMs({ ...BASE, scheduledAt: 1234 })).toBeNull();
    expect(autoCloseDueAtMs({ ...BASE, lastMarkedAt: 'not-a-date' })).toBeNull();
    expect(autoCloseDueAtMs({ ...BASE, updatedAt: 'not-a-date' })).toBeNull();
    // Defensive (beyond the spec text): every writer stamps createdAt.
    expect(autoCloseDueAtMs({ status: 'scheduled', scheduledAt: BASE.scheduledAt })).toBeNull();
  });

  it('11. LEGACY FLOOR: with no lastMarkedAt, updatedAt is the mark; once a mark exists it is ignored', () => {
    expect(autoCloseDueAtMs({ ...BASE, updatedAt: '2026-10-08T00:00:00.000Z' })).toBe(
      Date.parse('2026-10-22T00:00:00.000Z'),
    );
    expect(autoCloseDueAtMs({ ...BASE, updatedAt: '2026-09-10T00:00:00.000Z' })).toBe(DUE);
    expect(
      autoCloseDueAtMs({
        ...BASE,
        lastMarkedAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-10-08T00:00:00.000Z',
      }),
    ).toBe(DUE);
    // Not read at all once a mark exists - not even to refuse an unreadable one.
    expect(
      autoCloseDueAtMs({ ...BASE, lastMarkedAt: '2026-09-20T00:00:00.000Z', updatedAt: 'not-a-date' }),
    ).toBe(DUE);
  });

  it('12. isAutoCloseDue: the boundary is inclusive and a non-candidate is never due', () => {
    expect(isAutoCloseDue(BASE, DUE - 1)).toBe(false);
    expect(isAutoCloseDue(BASE, DUE)).toBe(true);
    expect(isAutoCloseDue({ ...BASE, status: 'requested' }, DUE + 1)).toBe(false);
    // The null guard: `null <= n` is true in JavaScript.
    for (const tour of NON_CANDIDATES) {
      expect(isAutoCloseDue(tour, Number.MAX_SAFE_INTEGER)).toBe(false);
    }
  });
});

describe('toursModel - reopenTargetFor', () => {
  it('refuses every status other than closed, whatever else the tour carries', () => {
    for (const status of TOUR_STATUSES.filter((s) => s !== 'closed')) {
      expect(reopenTargetFor({ status })).toEqual({ ok: false, error: 'tour_not_closed' });
      expect(
        reopenTargetFor({
          status,
          outcome: 'no_outcome',
          autoClosedFrom: 'toured',
          convertedPlacementId: 'placement-1',
        }),
      ).toEqual({ ok: false, error: 'tour_not_closed' });
    }
  });

  it('refuses a converted tour - finished or a pending: claim - even when auto-closed', () => {
    for (const convertedPlacementId of ['placement-1', 'pending:x']) {
      expect(reopenTargetFor({ status: 'closed', outcome: 'move_forward', convertedPlacementId })).toEqual({
        ok: false,
        error: 'tour_converted',
      });
      expect(
        reopenTargetFor({
          status: 'closed',
          outcome: 'no_outcome',
          autoClosedFrom: 'scheduled',
          convertedPlacementId,
        }),
      ).toEqual({ ok: false, error: 'tour_converted' });
    }
  });

  it('returns an auto-closed tour to the status it closed from', () => {
    for (const from of ['scheduled', 'toured', 'no_show'] as const) {
      expect(reopenTargetFor({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: from })).toEqual({
        ok: true,
        target: from,
      });
    }
  });

  it('autoClosedFrom wins over a person outcome when both are present', () => {
    expect(
      reopenTargetFor({ status: 'closed', outcome: 'not_a_fit', autoClosedFrom: 'no_show' }),
    ).toEqual({ ok: true, target: 'no_show' });
  });

  it('returns a person-decided tour (not a fit / move forward) to toured', () => {
    for (const outcome of ['not_a_fit', 'move_forward']) {
      expect(reopenTargetFor({ status: 'closed', outcome })).toEqual({ ok: true, target: 'toured' });
    }
  });

  it('refuses a closed tour that carries neither fact (API-only rows) rather than guess', () => {
    expect(reopenTargetFor({ status: 'closed' })).toEqual({ ok: false, error: 'tour_reopen_unsupported' });
    // no_outcome alone is not a person decision: there is no state to return to.
    expect(reopenTargetFor({ status: 'closed', outcome: 'no_outcome' })).toEqual({
      ok: false,
      error: 'tour_reopen_unsupported',
    });
    // autoClosedFrom outside the candidate statuses is not trusted.
    expect(
      reopenTargetFor({ status: 'closed', outcome: 'no_outcome', autoClosedFrom: 'canceled' }),
    ).toEqual({ ok: false, error: 'tour_reopen_unsupported' });
  });
});
