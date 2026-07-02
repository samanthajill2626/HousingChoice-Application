// Pinned case table — mirrors app/test/phone.test.ts exactly.
// Every input→expected pair here must match the app's test.  If either file
// drifts (logic change without a test update, or test update without a logic
// change in both files), a test will fail here OR there — that is the point.
import { describe, expect, it } from 'vitest';
import { formatPhoneDisplay, isE164, normalizeToE164 } from './phone.js';

describe('normalizeToE164', () => {
  it('passes through an already-canonical E.164 number', () => {
    expect(normalizeToE164('+15550101234')).toBe('+15550101234');
  });

  it('assumes +1 for a bare 10-digit NANP number, stripping formatting', () => {
    expect(normalizeToE164('5550101234')).toBe('+15550101234');
    expect(normalizeToE164('(555) 010-1234')).toBe('+15550101234');
    expect(normalizeToE164('555.010.1234')).toBe('+15550101234');
    expect(normalizeToE164(' 555 010 1234 ')).toBe('+15550101234');
  });

  it('handles an 11-digit number with a leading country 1', () => {
    expect(normalizeToE164('15550101234')).toBe('+15550101234');
    expect(normalizeToE164('1 (555) 010-1234')).toBe('+15550101234');
  });

  it('keeps an explicit + international number after stripping separators', () => {
    expect(normalizeToE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizeToE164('+1 (555) 010-1234')).toBe('+15550101234');
  });

  it('rejects ambiguous / malformed input (never guesses a country)', () => {
    for (const bad of [
      '', // empty
      '   ', // whitespace only
      '5550123', // too short (7 digits)
      '012345678', // 9 digits, not NANP-shaped
      'not a phone',
      '+', // bare plus
      '+0123456789', // E.164 first digit must be non-zero
      '++15550101234',
      '555010123456789012', // too long
    ]) {
      expect(normalizeToE164(bad), bad).toBeUndefined();
    }
  });
});

describe('isE164', () => {
  it('accepts canonical, rejects formatted', () => {
    expect(isE164('+15550101234')).toBe(true);
    expect(isE164('15550101234')).toBe(false);
    expect(isE164('(555) 010-1234')).toBe(false);
  });
});

describe('formatPhoneDisplay', () => {
  it('formats a US/Canada (+1) number as (AAA) BBB-CCCC', () => {
    expect(formatPhoneDisplay('+14049824978')).toBe('(404) 982-4978');
    expect(formatPhoneDisplay('+15550101234')).toBe('(555) 010-1234');
  });

  it('returns a non-NANP number unchanged (no reformatting of unknown shapes)', () => {
    expect(formatPhoneDisplay('+442079460958')).toBe('+442079460958');
  });

  it('returns empty string for undefined/empty (dashboard contract; app returns undefined)', () => {
    expect(formatPhoneDisplay(undefined)).toBe('');
    expect(formatPhoneDisplay('')).toBe('');
  });
});
