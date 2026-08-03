import { describe, expect, it } from 'vitest';
import {
  clampOutOfQuietHours,
  instantAtLocalTime,
  isQuietTime,
  isValidHhMm,
  isValidIanaTimezone,
  localDateOf,
  quietHoursWindowOf,
  resolveQuietHoursTimezone,
  type QuietHoursWindow,
} from '../src/lib/quietHours.js';

const NY: QuietHoursWindow = {
  enabled: true, start: '21:00', end: '08:00', timezone: 'America/New_York',
};

describe('isQuietTime (wrapping window, America/New_York)', () => {
  it('21:00 ET exactly is quiet (start-inclusive)', () => {
    // 2026-01-15T02:00Z == Jan 14 21:00 EST
    expect(isQuietTime('2026-01-15T02:00:00.000Z', NY)).toBe(true);
  });
  it('20:59 ET is not quiet', () => {
    expect(isQuietTime('2026-01-15T01:59:00.000Z', NY)).toBe(false);
  });
  it('08:00 ET exactly is NOT quiet (end-exclusive)', () => {
    // 2026-01-15T13:00Z == Jan 15 08:00 EST
    expect(isQuietTime('2026-01-15T13:00:00.000Z', NY)).toBe(false);
  });
  it('07:59 ET is quiet', () => {
    expect(isQuietTime('2026-01-15T12:59:00.000Z', NY)).toBe(true);
  });
  it('4am ET is quiet (the motivating bug)', () => {
    expect(isQuietTime('2026-01-15T09:00:00.000Z', NY)).toBe(true);
  });
  it('noon ET is not quiet', () => {
    expect(isQuietTime('2026-01-15T17:00:00.000Z', NY)).toBe(false);
  });
  it('23:00 ET is quiet even though the UTC date has already rolled over', () => {
    // Jan 15 23:00 EST == 2026-01-16T04:00Z - local date Jan 15, UTC date Jan 16
    expect(isQuietTime('2026-01-16T04:00:00.000Z', NY)).toBe(true);
  });
  it('19:00 ET and 20:01 ET on the SAME UTC date are both not quiet', () => {
    expect(isQuietTime('2026-01-16T00:00:00.000Z', NY)).toBe(false); // 19:00 EST Jan 15
    expect(isQuietTime('2026-01-16T01:01:00.000Z', NY)).toBe(false); // 20:01 EST Jan 15
  });
  it('summer (EDT, UTC-4): 22:00 ET is quiet', () => {
    // 2026-07-15T02:00Z == Jul 14 22:00 EDT
    expect(isQuietTime('2026-07-15T02:00:00.000Z', NY)).toBe(true);
  });
  it('disabled window is never quiet', () => {
    expect(isQuietTime('2026-01-15T09:00:00.000Z', { ...NY, enabled: false })).toBe(false);
  });
  it('non-wrapping window (01:00-05:00) is quiet inside, not outside', () => {
    const w: QuietHoursWindow = { ...NY, start: '01:00', end: '05:00' };
    expect(isQuietTime('2026-01-15T08:00:00.000Z', w)).toBe(true);  // 03:00 EST
    expect(isQuietTime('2026-01-15T15:00:00.000Z', w)).toBe(false); // 10:00 EST
  });
  it('start === end is treated as no window (never quiet)', () => {
    const w: QuietHoursWindow = { ...NY, start: '08:00', end: '08:00' };
    expect(isQuietTime('2026-01-15T09:00:00.000Z', w)).toBe(false);
  });
});

describe('clampOutOfQuietHours', () => {
  it('identity outside the window', () => {
    expect(clampOutOfQuietHours('2026-01-15T17:00:00.000Z', NY))
      .toBe('2026-01-15T17:00:00.000Z');
  });
  it('evening side clamps to 08:00 local NEXT day', () => {
    // Jan 14 22:00 EST -> Jan 15 08:00 EST == 13:00Z
    expect(clampOutOfQuietHours('2026-01-15T03:00:00.000Z', NY))
      .toBe('2026-01-15T13:00:00.000Z');
  });
  it('morning side clamps to 08:00 local SAME day', () => {
    // Jan 15 04:00 EST (09:00Z) -> Jan 15 08:00 EST == 13:00Z
    expect(clampOutOfQuietHours('2026-01-15T09:00:00.000Z', NY))
      .toBe('2026-01-15T13:00:00.000Z');
  });
  it('23:00 ET (UTC date already tomorrow) clamps to 08:00 local the next local day', () => {
    // Jan 15 23:00 EST == Jan 16 04:00Z -> Jan 16 08:00 EST == Jan 16 13:00Z
    expect(clampOutOfQuietHours('2026-01-16T04:00:00.000Z', NY))
      .toBe('2026-01-16T13:00:00.000Z');
  });
  it('summer clamp lands 08:00 EDT (12:00Z)', () => {
    // Jul 14 22:00 EDT (02:00Z Jul 15) -> Jul 15 08:00 EDT == 12:00Z
    expect(clampOutOfQuietHours('2026-07-15T02:00:00.000Z', NY))
      .toBe('2026-07-15T12:00:00.000Z');
  });
  it('spring-forward night (Mar 7->8 2026) clamps to 08:00 EDT', () => {
    // Mar 7 21:30 EST == 02:30Z Mar 8 -> Mar 8 08:00 EDT == 12:00Z
    expect(clampOutOfQuietHours('2026-03-08T02:30:00.000Z', NY))
      .toBe('2026-03-08T12:00:00.000Z');
  });
  it('fall-back night (Nov 1 2026): both occurrences of 01:30 clamp to 08:00 EST', () => {
    // 01:30 EDT == 05:30Z and 01:30 EST == 06:30Z; both -> Nov 1 08:00 EST == 13:00Z
    expect(clampOutOfQuietHours('2026-11-01T05:30:00.000Z', NY))
      .toBe('2026-11-01T13:00:00.000Z');
    expect(clampOutOfQuietHours('2026-11-01T06:30:00.000Z', NY))
      .toBe('2026-11-01T13:00:00.000Z');
  });
  it('disabled window is identity', () => {
    expect(clampOutOfQuietHours('2026-01-15T09:00:00.000Z', { ...NY, enabled: false }))
      .toBe('2026-01-15T09:00:00.000Z');
  });
});

describe('helpers', () => {
  it('localDateOf uses the LOCAL date, not the UTC date', () => {
    expect(localDateOf('2026-01-16T04:00:00.000Z', 'America/New_York')).toBe('2026-01-15');
    expect(localDateOf('2026-01-15T17:00:00.000Z', 'America/New_York')).toBe('2026-01-15');
  });
  it('instantAtLocalTime materializes a local wall time as a UTC instant', () => {
    expect(instantAtLocalTime('2026-01-15', '08:00', 'America/New_York'))
      .toBe('2026-01-15T13:00:00.000Z');
    expect(instantAtLocalTime('2026-07-15', '08:00', 'America/New_York'))
      .toBe('2026-07-15T12:00:00.000Z');
  });
  it('quietHoursWindowOf projects settings fields', () => {
    expect(quietHoursWindowOf({
      quietHoursEnabled: true, quietHoursStart: '21:00',
      quietHoursEnd: '08:00', timezone: 'America/New_York',
    })).toEqual(NY);
  });
  it('resolveQuietHoursTimezone returns the org timezone (per-recipient seam)', () => {
    expect(resolveQuietHoursTimezone({ timezone: 'America/New_York' })).toBe('America/New_York');
    expect(resolveQuietHoursTimezone({ timezone: 'America/Chicago' }, { some: 'contact' }))
      .toBe('America/Chicago');
  });
  it('isValidHhMm', () => {
    expect(isValidHhMm('21:00')).toBe(true);
    expect(isValidHhMm('08:05')).toBe(true);
    expect(isValidHhMm('24:00')).toBe(false);
    expect(isValidHhMm('8:00')).toBe(false);
    expect(isValidHhMm('0800')).toBe(false);
    expect(isValidHhMm('')).toBe(false);
  });
  it('isValidIanaTimezone', () => {
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone('')).toBe(false);
  });
});
