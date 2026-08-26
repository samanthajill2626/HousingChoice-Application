// M1.5 unit tests: the phone → E.164 normalizer (lib/phone.ts). The dedupe key
// for manual + public contact entry, so its NANP assumption and its rejections
// are both load-bearing.
import { describe, expect, it } from 'vitest';
import {
  formatPhoneForDisplay,
  isE164,
  maskPhonesInText,
  normalizeToE164,
} from '../src/lib/phone.js';

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

describe('formatPhoneForDisplay', () => {
  it('formats a US/Canada (+1) number as (AAA) BBB-CCCC', () => {
    expect(formatPhoneForDisplay('+14049824978')).toBe('(404) 982-4978');
    expect(formatPhoneForDisplay('+15550101234')).toBe('(555) 010-1234');
  });

  it('returns a non-NANP number unchanged (no reformatting of unknown shapes)', () => {
    expect(formatPhoneForDisplay('+442079460958')).toBe('+442079460958');
  });

  it('returns undefined for undefined/empty', () => {
    expect(formatPhoneForDisplay(undefined)).toBeUndefined();
    expect(formatPhoneForDisplay('')).toBeUndefined();
  });
});

// Log-hygiene spec section 4: the server-only masking helper the request-path
// log sinks and the OTel span hooks both call. Its cases are shaped by the
// SINKS - bare path segments, URL-encoded query values, phone: memberKeys.
describe('maskPhonesInText', () => {
  it('masks a bare E.164 path segment to first digit + last two', () => {
    expect(maskPhonesInText('/api/contacts/abc/phones/+14045551234')).toBe(
      '/api/contacts/abc/phones/+1...34',
    );
  });

  it('masks the URL-encoded %2B variant, both casings', () => {
    expect(maskPhonesInText('/x?phone=%2B14045551234')).toBe('/x?phone=%2B1...34');
    expect(maskPhonesInText('/x?phone=%2b14045551234')).toBe('/x?phone=%2b1...34');
  });

  it('masks phone: memberKey segments', () => {
    expect(maskPhonesInText('/api/tours/t1/members/phone:+14045551234')).toBe(
      '/api/tours/t1/members/phone:+1...34',
    );
  });

  it('masks every phone in a multi-phone string (the span case)', () => {
    expect(maskPhonesInText('https://x/a/+14045551234/b?to=%2B15551230000')).toBe(
      'https://x/a/+1...34/b?to=%2B1...00',
    );
  });

  it('passes phone-free text through unchanged', () => {
    const clean = '/api/units?limit=25&status=active';
    expect(maskPhonesInText(clean)).toBe(clean);
  });

  it('does not mask short digit runs that are not phones', () => {
    expect(maskPhonesInText('/api/things/+123')).toBe('/api/things/+123');
  });
});
