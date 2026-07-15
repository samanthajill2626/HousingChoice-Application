// todayISODate — the consent date inputs' default. Must be the LOCAL date:
// toISOString() gives the UTC date, which is tomorrow every evening west of
// Greenwich (an 8pm EDT consent capture defaulted to the NEXT day — caught
// live 2026-07-14).
import { describe, expect, it } from 'vitest';
import { consentAtFromDate, todayISODate } from './consentCopy.js';

describe('todayISODate', () => {
  it('returns the LOCAL calendar date, zero-padded', () => {
    expect(todayISODate(new Date(2026, 6, 14, 21, 30))).toBe('2026-07-14');
    expect(todayISODate(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  it('late evening stays on the local date (the UTC-rollover regression)', () => {
    // 23:59 local on July 14 — with a UTC-based implementation this is already
    // July 15 anywhere west of Greenwich.
    expect(todayISODate(new Date(2026, 6, 14, 23, 59))).toBe('2026-07-14');
  });
});

describe('consentAtFromDate', () => {
  it('maps a date input value to the start of that day (UTC instant)', () => {
    expect(consentAtFromDate('2026-07-14')).toBe('2026-07-14T00:00:00.000Z');
  });

  it('falls back to the current instant on empty/garbage', () => {
    for (const bad of ['', 'not-a-date']) {
      const iso = consentAtFromDate(bad);
      expect(new Date(iso).toISOString()).toBe(iso);
    }
  });
});
