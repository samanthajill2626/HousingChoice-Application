// address lib - zipFive (the relay buy-hint helper). Its contract is "a usable
// ZIP or nothing, NEVER an error": every caller (placements.ts, tours.ts) treats
// undefined as "no geographic hint", and placements.ts calls it UNWRAPPED, so a
// throw here would 500 a relay creation the spec says must never fail on a bad
// address. These cases pin that total-function promise, including the LEGACY
// shapes the write validator did not police (a zip that is not a string).
import { describe, expect, it } from 'vitest';
import { zipFive, formatAddress, formatStreet, type Address } from '../src/lib/address.js';

describe('zipFive', () => {
  it('returns the 5-digit zip of a structured address', () => {
    expect(zipFive({ line1: '12 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30309' })).toBe(
      '30309',
    );
  });

  it('truncates ZIP+4 to the leading five digits', () => {
    expect(zipFive({ zip: '30309-1234' })).toBe('30309');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(zipFive({ zip: '  30309  ' })).toBe('30309');
  });

  it('returns undefined for a missing, blank or too-short zip', () => {
    expect(zipFive({})).toBeUndefined();
    expect(zipFive({ zip: '' })).toBeUndefined();
    expect(zipFive({ zip: '   ' })).toBeUndefined();
    expect(zipFive({ zip: '303' })).toBeUndefined();
    expect(zipFive({ zip: 'ATL30309' })).toBeUndefined();
  });

  it('returns undefined for a legacy plain-string address and for no address at all', () => {
    expect(zipFive('12 Peachtree St, Atlanta, GA 30309')).toBeUndefined();
    expect(zipFive(undefined)).toBeUndefined();
  });

  it('returns undefined (never throws) when zip is present but NOT a string', () => {
    // Legacy/imported rows predating the write validator can carry a numeric or
    // object zip. `a.zip?.trim()` only guards null/undefined, so an unguarded
    // helper raises "a.zip.trim is not a function" straight through
    // placements.ts's unwrapped call site.
    expect(() => zipFive({ zip: 30309 } as unknown as Address)).not.toThrow();
    expect(zipFive({ zip: 30309 } as unknown as Address)).toBeUndefined();
    expect(zipFive({ zip: { value: '30309' } } as unknown as Address)).toBeUndefined();
    expect(zipFive({ zip: ['30309'] } as unknown as Address)).toBeUndefined();
    expect(zipFive({ zip: null } as unknown as Address)).toBeUndefined();
  });
});

describe('formatStreet', () => {
  it('returns line1 alone', () => {
    expect(formatStreet({ line1: '412 Oak St' })).toBe('412 Oak St');
  });

  it('joins line1 and line2 with a space', () => {
    expect(formatStreet({ line1: '412 Oak St', line2: 'Apt 2' })).toBe('412 Oak St Apt 2');
  });

  it('EXCLUDES city, state and zip from a structured address', () => {
    expect(formatStreet({ line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30312' }))
      .toBe('412 Oak St');
  });

  it('returns a legacy plain-string address verbatim, trimmed', () => {
    // Every seeded unit is this shape - postal noise included, by design (D5).
    expect(formatStreet('  350 Boulevard SE, Atlanta, GA 30312 '))
      .toBe('350 Boulevard SE, Atlanta, GA 30312');
  });

  it('returns empty string for undefined, an empty object, or a blank string', () => {
    expect(formatStreet(undefined)).toBe('');
    expect(formatStreet({})).toBe('');
    expect(formatStreet('   ')).toBe('');
  });

  it('returns empty string (never throws) for a NULL address', () => {
    // The declared type says undefined, but `address: null` is reachable at
    // runtime: the seeds write unit items with a RAW PutCommand (bypassing
    // unitsRepo, which strips nulls), the M1.6 import is unbuilt, and stored rows
    // can be hand-edited. On the reminder paths the containment blocks catch only
    // UncomposableReminderError, so a TypeError from here escapes as a re-listed-
    // forever poll row / a 500 / an emptied timeline bucket.
    expect(() => formatStreet(null as unknown as Address)).not.toThrow();
    expect(formatStreet(null as unknown as Address)).toBe('');
  });

  it('ignores a NON-STRING line1/line2 instead of stringifying it into the copy', () => {
    // A legacy/imported row the write validator never policed. Without the
    // string-typed filter this renders "[object Object]" into a tenant SMS.
    expect(formatStreet({ line1: { length: 5 } } as unknown as Address)).toBe('');
    expect(formatStreet({ line1: 412 } as unknown as Address)).toBe('');
    expect(formatStreet({ line1: '412 Oak St', line2: 7 } as unknown as Address)).toBe('412 Oak St');
  });
});

describe('formatAddress still behaves after the refactor', () => {
  it('joins street with city, state and zip', () => {
    expect(formatAddress({ line1: '412 Oak St', line2: 'Apt 2', city: 'Atlanta', state: 'GA', zip: '30312' }))
      .toBe('412 Oak St Apt 2, Atlanta, GA 30312');
  });

  it('passes a legacy string through', () => {
    expect(formatAddress('350 Boulevard SE, Atlanta, GA 30312'))
      .toBe('350 Boulevard SE, Atlanta, GA 30312');
  });
});
