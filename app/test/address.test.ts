// address lib - zipFive (the relay buy-hint helper). Its contract is "a usable
// ZIP or nothing, NEVER an error": every caller (placements.ts, tours.ts) treats
// undefined as "no geographic hint", and placements.ts calls it UNWRAPPED, so a
// throw here would 500 a relay creation the spec says must never fail on a bad
// address. These cases pin that total-function promise, including the LEGACY
// shapes the write validator did not police (a zip that is not a string).
import { describe, expect, it } from 'vitest';
import { zipFive, type Address } from '../src/lib/address.js';

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
