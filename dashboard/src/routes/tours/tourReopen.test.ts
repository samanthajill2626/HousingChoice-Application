// tourReopen tests - the dashboard mirror of the server's reopenTargetFor
// (app/src/lib/toursModel.ts, spec 7.2; table from app/test/toursModel.test.ts).
// The tour page offers Reopen exactly when POST /api/tours/:tourId/reopen would
// accept it, so every row here must answer what the server answers: a target
// where it reopens, null where it refuses (tour_not_closed, tour_converted,
// tour_reopen_unsupported). Plus the confirm dialog's three body strings
// (spec 9.2), byte for byte.
import { describe, expect, it } from 'vitest';
import { TOUR_STATUS_LABELS, type Tour, type TourStatus } from '../../api/index.js';
import { REOPEN_BODY, reopenTargetOf } from './tourReopen.js';

function makeTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-1',
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    scheduledAt: '2026-06-20T15:00:00Z',
    tourType: 'self_guided',
    status: 'closed',
    ...over,
  };
}

/** Every status but closed, from the exhaustive label map (no hand-kept list). */
const NOT_CLOSED = (Object.keys(TOUR_STATUS_LABELS) as TourStatus[]).filter((s) => s !== 'closed');

describe('tourReopen - reopenTargetOf', () => {
  it('refuses every status other than closed, whatever else the tour carries', () => {
    expect(NOT_CLOSED).toHaveLength(5);
    for (const status of NOT_CLOSED) {
      expect(reopenTargetOf(makeTour({ status }))).toBeNull();
      expect(
        reopenTargetOf(
          makeTour({
            status,
            outcome: 'no_outcome',
            autoClosedFrom: 'toured',
            convertedPlacementId: 'placement-1',
          }),
        ),
      ).toBeNull();
    }
  });

  it('refuses a converted tour - finished or a pending: claim - even when auto-closed', () => {
    for (const convertedPlacementId of ['placement-1', 'pending:x']) {
      expect(
        reopenTargetOf(
          makeTour({ outcome: 'move_forward', moveForward: true, convertible: true, convertedPlacementId }),
        ),
      ).toBeNull();
      expect(
        reopenTargetOf(makeTour({ outcome: 'no_outcome', autoClosedFrom: 'scheduled', convertedPlacementId })),
      ).toBeNull();
    }
  });

  it('returns an auto-closed tour to the status it closed from', () => {
    for (const from of ['scheduled', 'toured', 'no_show'] as const) {
      expect(reopenTargetOf(makeTour({ outcome: 'no_outcome', autoClosedFrom: from }))).toBe(from);
    }
  });

  it('autoClosedFrom wins over a person outcome when both are present', () => {
    expect(reopenTargetOf(makeTour({ outcome: 'not_a_fit', autoClosedFrom: 'no_show' }))).toBe('no_show');
  });

  it('returns a person-decided tour (not a fit / move forward) to toured', () => {
    expect(reopenTargetOf(makeTour({ outcome: 'not_a_fit', moveForward: false }))).toBe('toured');
    // The convertible, unconverted case the kebab carries (spec 9.2).
    expect(
      reopenTargetOf(makeTour({ outcome: 'move_forward', moveForward: true, convertible: true })),
    ).toBe('toured');
  });

  it('refuses a closed tour that carries neither fact (API-only rows) rather than guess', () => {
    expect(reopenTargetOf(makeTour())).toBeNull();
    // no_outcome alone is not a person decision: there is no state to return to.
    expect(reopenTargetOf(makeTour({ outcome: 'no_outcome' }))).toBeNull();
    // autoClosedFrom outside the candidate statuses is not trusted. 'canceled'
    // is off the typed union, so the row is built through unknown.
    expect(
      reopenTargetOf({ ...makeTour({ outcome: 'no_outcome' }), autoClosedFrom: 'canceled' } as unknown as Tour),
    ).toBeNull();
    expect(
      reopenTargetOf({ ...makeTour({ outcome: 'no_outcome' }), autoClosedFrom: 'closed' } as unknown as Tour),
    ).toBeNull();
  });
});

describe('tourReopen - REOPEN_BODY', () => {
  it('says where each target goes and that nothing is sent (spec 9.2, exact copy)', () => {
    expect(REOPEN_BODY).toEqual({
      toured: 'This tour goes back to Toured so you can record a different outcome. Nothing is sent.',
      no_show: 'This tour goes back to No show so you can reschedule it. Nothing is sent.',
      scheduled:
        'This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent.',
    });
  });
});
