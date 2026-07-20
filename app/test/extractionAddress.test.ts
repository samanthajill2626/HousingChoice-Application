// Shared address-parts helpers for the address extraction target (Task 1).
import { describe, expect, it } from 'vitest';
import {
  cleanAddressParts,
  contactAddressToParts,
  formatAddressParts,
  isEmptyAddressValue,
  normalizeAddressForCompare,
} from '../src/services/extraction/address.js';

describe('cleanAddressParts', () => {
  it('keeps trimmed non-empty known parts only', () => {
    expect(
      cleanAddressParts({ line1: ' 535 Seal Pl NE ', line2: '', city: 'Atlanta', state: 'GA', zip: '30328', bogus: 'x' }),
    ).toEqual({ line1: '535 Seal Pl NE', city: 'Atlanta', state: 'GA', zip: '30328' });
  });
  it('returns {} for non-objects', () => {
    expect(cleanAddressParts('535 Seal Pl')).toEqual({});
    expect(cleanAddressParts(undefined)).toEqual({});
  });
  it('clamps parts to 120 chars', () => {
    const long = 'a'.repeat(150);
    expect(cleanAddressParts({ line1: long }).line1).toHaveLength(120);
  });
});

describe('formatAddressParts', () => {
  it('joins non-empty parts in canonical order', () => {
    expect(formatAddressParts({ city: 'Atlanta', line1: '535 Seal Pl NE', zip: '30328', state: 'GA' })).toBe(
      '535 Seal Pl NE, Atlanta, GA, 30328',
    );
  });
  it('is empty for empty parts', () => {
    expect(formatAddressParts({})).toBe('');
  });
});

describe('contactAddressToParts', () => {
  it('reads a stored parts object', () => {
    expect(contactAddressToParts({ line1: '1 Main St', city: 'Atlanta' })).toEqual({ line1: '1 Main St', city: 'Atlanta' });
  });
  it('treats a legacy plain-string address as line1', () => {
    expect(contactAddressToParts('1 Main St, Atlanta GA')).toEqual({ line1: '1 Main St, Atlanta GA' });
  });
});

describe('isEmptyAddressValue', () => {
  it('true for absent / empty object / whitespace parts / empty string', () => {
    expect(isEmptyAddressValue(undefined)).toBe(true);
    expect(isEmptyAddressValue({})).toBe(true);
    expect(isEmptyAddressValue({ line1: '  ' })).toBe(true);
    expect(isEmptyAddressValue('  ')).toBe(true);
  });
  it('false for a real part or non-empty legacy string', () => {
    expect(isEmptyAddressValue({ city: 'Atlanta' })).toBe(false);
    expect(isEmptyAddressValue('1 Main St')).toBe(false);
  });
});

describe('normalizeAddressForCompare', () => {
  it('is case/whitespace/punctuation-insensitive', () => {
    expect(normalizeAddressForCompare('535 Seal Pl NE, Atlanta, GA, 30328')).toBe(
      normalizeAddressForCompare('535  seal pl ne atlanta ga 30328.'),
    );
  });
});
