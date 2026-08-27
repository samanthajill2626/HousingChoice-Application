import { describe, expect, it } from 'vitest';
import { computeDueAt } from '../src/jobs/tourReminders.js';
import { quietHoursWindowOf } from '../src/lib/quietHours.js';

const WINDOW = quietHoursWindowOf({
  quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '08:00',
  timezone: 'America/New_York',
});
const NOW = '2026-07-01T12:00:00.000Z'; // far before every fixture tour

describe('computeDueAt (raw - the caller clamps)', () => {
  const TOUR = '2026-07-23T19:00:00.000Z'; // Thu Jul 23, 15:00 EDT

  it('confirmation is the arm instant, unchanged in Phase A', () => {
    expect(computeDueAt('confirmation', TOUR, NOW, WINDOW)).toBe(NOW);
  });
  it('day_before is 19:30 ORG-LOCAL the evening before the tour LOCAL date', () => {
    expect(computeDueAt('day_before', TOUR, NOW, WINDOW)).toBe('2026-07-22T23:30:00.000Z');
  });
  it('day_before in winter (EST) crosses the UTC midnight correctly', () => {
    // Tour Jan 20 15:00 EST; 19:30 EST Jan 19 = 00:30Z Jan 20.
    expect(computeDueAt('day_before', '2026-01-20T20:00:00.000Z', NOW, WINDOW))
      .toBe('2026-01-20T00:30:00.000Z');
  });
  it('the 19:30 anchor holds across the spring-forward transition (offset flips, wall time does not)', () => {
    // America/New_York springs forward 2026-03-08. A tour on Mar 9 anchors
    // day_before at 19:30 EDT (UTC-4) ON the transition day; a tour on Mar 6
    // anchors at 19:30 EST (UTC-5). A naive fixed-offset derivation gets one
    // of these wrong by an hour.
    expect(computeDueAt('day_before', '2026-03-09T16:00:00.000Z', NOW, WINDOW))
      .toBe('2026-03-08T23:30:00.000Z'); // 19:30 EDT Mar 8
    expect(computeDueAt('day_before', '2026-03-06T16:00:00.000Z', NOW, WINDOW))
      .toBe('2026-03-06T00:30:00.000Z'); // 19:30 EST Mar 5
  });
  it('morning_of is four hours before the tour', () => {
    expect(computeDueAt('morning_of', TOUR, NOW, WINDOW)).toBe('2026-07-23T15:00:00.000Z');
  });
  it('en_route is one hour before (unchanged)', () => {
    expect(computeDueAt('en_route', TOUR, NOW, WINDOW)).toBe('2026-07-23T18:00:00.000Z');
  });
  it('no_show_checkin is thirty minutes after (unchanged)', () => {
    expect(computeDueAt('no_show_checkin', TOUR, NOW, WINDOW)).toBe('2026-07-23T19:30:00.000Z');
  });
});
