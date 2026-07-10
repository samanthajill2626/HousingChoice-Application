// Unit tests for deriveTourSignal (listing-response-tour-chip, spec section 5/7).
//
// deriveTourSignal collapses ALL tours for ONE (unit, tenant) pairing into the
// most-progressed qualifying chip signal. Precedence:
//   toured  (status 'toured', OR 'closed' with convertedPlacementId) > scheduled > requested
// Disqualifying: 'canceled' / 'no_show' / unconverted 'closed' -> no signal.
// Ties WITHIN the winning state: the most recently created qualifying tour wins.
//
// NOTE: the TourStatus union (lib/toursModel.ts) has NO 'confirmed' status - it
// was removed 2026-07-08 ('scheduled' covers it) - so there is no 'confirmed'
// bucket to adjudicate here; a booked tour is already 'scheduled'.
import { describe, expect, it } from 'vitest';
import { deriveTourSignal } from '../src/lib/listingSendTour.js';
import type { TourItem } from '../src/repos/toursRepo.js';

/** Minimal TourItem builder for the pairing (unit-1, tenant-1). */
function tour(overrides: Partial<TourItem> & { tourId: string; status: string }): TourItem {
  return {
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    _schedPartition: 'tours',
    tourType: 'self_guided',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as TourItem;
}

describe('deriveTourSignal - precedence', () => {
  it('returns undefined for no tours', () => {
    expect(deriveTourSignal([])).toBeUndefined();
  });

  it("any 'toured' tour wins as 'toured'", () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-req', status: 'requested' }),
      tour({ tourId: 't-sched', status: 'scheduled' }),
      tour({ tourId: 't-toured', status: 'toured' }),
    ]);
    expect(signal).toEqual({ tourId: 't-toured', state: 'toured' });
  });

  it("a 'closed' tour with convertedPlacementId is the 'toured' floor", () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-closed', status: 'closed', convertedPlacementId: 'placement-9' }),
    ]);
    expect(signal).toEqual({ tourId: 't-closed', state: 'toured' });
  });

  it("a converted-closed tour beats a live 'scheduled' tour (both -> toured wins)", () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-sched', status: 'scheduled' }),
      tour({ tourId: 't-conv', status: 'closed', convertedPlacementId: 'placement-1' }),
    ]);
    expect(signal).toEqual({ tourId: 't-conv', state: 'toured' });
  });

  it("'scheduled' wins over 'requested' when no toured exists", () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-req', status: 'requested' }),
      tour({ tourId: 't-sched', status: 'scheduled' }),
    ]);
    expect(signal).toEqual({ tourId: 't-sched', state: 'scheduled' });
  });

  it("'requested' is the floor when nothing better qualifies", () => {
    const signal = deriveTourSignal([tour({ tourId: 't-req', status: 'requested' })]);
    expect(signal).toEqual({ tourId: 't-req', state: 'requested' });
  });

  it('precedence beats recency: an older toured tour still wins over a newer scheduled', () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-toured', status: 'toured', createdAt: '2026-07-01T00:00:00.000Z' }),
      tour({ tourId: 't-sched', status: 'scheduled', createdAt: '2026-07-09T00:00:00.000Z' }),
    ]);
    expect(signal).toEqual({ tourId: 't-toured', state: 'toured' });
  });
});

describe('deriveTourSignal - disqualifying statuses', () => {
  it("returns undefined when only 'canceled' / 'no_show' / unconverted 'closed' exist", () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-cancel', status: 'canceled' }),
      tour({ tourId: 't-noshow', status: 'no_show' }),
      tour({ tourId: 't-closed', status: 'closed' }), // no convertedPlacementId
    ]);
    expect(signal).toBeUndefined();
  });

  it("an unconverted 'closed' does NOT reach the toured floor (empty convertedPlacementId ignored)", () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-closed', status: 'closed', convertedPlacementId: '' }),
    ]);
    expect(signal).toBeUndefined();
  });

  it('a disqualified tour never masks a qualifying one', () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-cancel', status: 'canceled' }),
      tour({ tourId: 't-req', status: 'requested' }),
    ]);
    expect(signal).toEqual({ tourId: 't-req', state: 'requested' });
  });
});

describe('deriveTourSignal - tie-break within the winning state', () => {
  it('picks the most recently created qualifying tour of the winning state', () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-old', status: 'scheduled', createdAt: '2026-07-01T00:00:00.000Z' }),
      tour({ tourId: 't-new', status: 'scheduled', createdAt: '2026-07-05T00:00:00.000Z' }),
      tour({ tourId: 't-mid', status: 'scheduled', createdAt: '2026-07-03T00:00:00.000Z' }),
    ]);
    expect(signal).toEqual({ tourId: 't-new', state: 'scheduled' });
  });

  it('tie-break applies among toured tours too (newest converted/toured wins)', () => {
    const signal = deriveTourSignal([
      tour({ tourId: 't-toured-old', status: 'toured', createdAt: '2026-07-01T00:00:00.000Z' }),
      tour({ tourId: 't-conv-new', status: 'closed', convertedPlacementId: 'p-2', createdAt: '2026-07-08T00:00:00.000Z' }),
    ]);
    expect(signal).toEqual({ tourId: 't-conv-new', state: 'toured' });
  });
});
