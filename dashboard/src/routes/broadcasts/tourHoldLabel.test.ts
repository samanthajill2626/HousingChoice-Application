// tourHoldLabel tests - matching-blast-rules D7: every hold kind's label, with
// and without a date. The instants are noon UTC, so the browser-local short
// date (shortDate) is the same calendar day in every US time zone.
import { describe, expect, it } from 'vitest';
import { tourHoldLabel } from './tourHoldLabel.js';

describe('tourHoldLabel', () => {
  it('labels every kind with its date', () => {
    expect(tourHoldLabel({ kind: 'upcoming', tourId: 't1', at: '2026-10-20T12:00:00.000Z' })).toBe('Tour Oct 20');
    expect(tourHoldLabel({ kind: 'not_marked', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe(
      'Tour Oct 9, not marked',
    );
    expect(tourHoldLabel({ kind: 'needs_outcome', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe(
      'Toured Oct 9, needs outcome',
    );
    expect(tourHoldLabel({ kind: 'needs_placement', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe(
      'Toured Oct 9, needs placement',
    );
    expect(tourHoldLabel({ kind: 'no_show', tourId: 't1', at: '2026-10-09T12:00:00.000Z' })).toBe('No show Oct 9');
    expect(tourHoldLabel({ kind: 'requested', tourId: 't1', at: '2026-10-12T12:00:00.000Z' })).toBe(
      'Tour requested Oct 12, no date yet',
    );
  });

  it('drops the date and the space before it when the tour has none', () => {
    expect(tourHoldLabel({ kind: 'upcoming', tourId: 't1' })).toBe('Tour');
    expect(tourHoldLabel({ kind: 'not_marked', tourId: 't1' })).toBe('Tour, not marked');
    expect(tourHoldLabel({ kind: 'needs_outcome', tourId: 't1' })).toBe('Toured, needs outcome');
    expect(tourHoldLabel({ kind: 'needs_placement', tourId: 't1' })).toBe('Toured, needs placement');
    expect(tourHoldLabel({ kind: 'no_show', tourId: 't1' })).toBe('No show');
    expect(tourHoldLabel({ kind: 'requested', tourId: 't1' })).toBe('Tour requested, no date yet');
  });
});
