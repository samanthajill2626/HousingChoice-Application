// WP1 B1 spec D5.1 / D5.3 (plan ruling PR5): the leaf that names a property by
// its address, tells whether a line of text names it, and spots a street
// address for the run record's unlabeledAddressLines count.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address } from '../src/lib/address.js';
import { STREET_SUFFIXES, hasStreetAddress, labelMatches, propertyLabel } from '../src/lib/propertyLabel.js';

describe('propertyLabel', () => {
  it('is "<line 1>, <city>" - state and zip are not part of the label', () => {
    const address: Address = { line1: '123 Main St', city: 'Decatur', state: 'GA', zip: '30030' };
    expect(propertyLabel({ address })).toBe('123 Main St, Decatur');
  });

  it('includes line 2 when present - units in one building share line 1', () => {
    const address: Address = { line1: '9 Oak Ave', line2: 'Apt 2', city: 'Atlanta' };
    expect(propertyLabel({ address })).toBe('9 Oak Ave Apt 2, Atlanta');
  });

  // PR45: spec D5.1's "toSingleLine defense" is this one-space flattening in
  // the leaf (lib/singleLine.ts toOneLine, which writes " / ", is not used:
  // the leaf imports nothing).
  it('is ONE line: each part trimmed, newlines, tabs and space runs become one space', () => {
    const address: Address = { line1: '  123  Main St\r\n', line2: '\tApt\n2 ', city: ' Decatur ' };
    expect(propertyLabel({ address })).toBe('123 Main St Apt 2, Decatur');
  });

  it('is undefined when line 1 or the city is empty after trimming', () => {
    expect(propertyLabel({ address: { line1: '   ', city: 'Decatur' } })).toBeUndefined();
    expect(propertyLabel({ address: { line1: '123 Main St', city: '\n' } })).toBeUndefined();
    expect(propertyLabel({ address: { line1: '123 Main St', line2: 'Apt 2' } })).toBeUndefined();
  });

  it('is undefined with no structured address: absent, null, or a legacy plain string', () => {
    expect(propertyLabel({})).toBeUndefined();
    expect(propertyLabel({ address: null })).toBeUndefined();
    expect(propertyLabel({ address: '123 Main St, Decatur, GA' })).toBeUndefined();
  });

  it('reads a part that is not a string as empty', () => {
    expect(propertyLabel({ address: { line1: '123 Main St', line2: 7, city: 'Decatur' } })).toBe('123 Main St, Decatur');
    expect(propertyLabel({ address: { line1: 123, city: 'Decatur' } })).toBeUndefined();
  });
});

describe('labelMatches', () => {
  const MAIN = '123 Main St, Decatur';
  const UNIT = '123 Main St Apt 2, Decatur';

  it('folds case, the characters . , # and spacing on both sides', () => {
    expect(labelMatches('123 MAIN ST,   DECATUR: likes it', MAIN)).toBe(true);
    expect(labelMatches('Toured 123 Main St., Decatur yesterday', MAIN)).toBe(true);
  });

  it('finds the label at the start, in the middle, or inside punctuation', () => {
    expect(labelMatches('123 Main St, Decatur', MAIN)).toBe(true);
    expect(labelMatches('No to 123 Main St, Decatur - too far from work', MAIN)).toBe(true);
    expect(labelMatches('(123 Main St, Decatur) on the fence', MAIN)).toBe(true);
  });

  it('only at a BOUNDARY: 12 Main is not inside 112 Main, Decatur is not inside Decaturville', () => {
    expect(labelMatches('112 Main St, Decatur: likes it', '12 Main St, Decatur')).toBe(false);
    expect(labelMatches('123 Main St, Decaturville: likes it', MAIN)).toBe(false);
  });

  it('matches the line-2 form written with an extra comma', () => {
    expect(labelMatches('123 Main St, Apt 2, Decatur: wants to see it', UNIT)).toBe(true);
  });

  it('does not match a different line 2, nor the building label inside a unit line', () => {
    expect(labelMatches('123 Main St Apt 3, Decatur: wants to see it', UNIT)).toBe(false);
    expect(labelMatches('123 Main St Apt 2, Decatur: likes it', MAIN)).toBe(false);
  });

  it('folds no abbreviation: St and Street differ, #2 and Apt 2 differ', () => {
    expect(labelMatches('123 Main Street, Decatur: likes it', MAIN)).toBe(false);
    expect(labelMatches('123 Main St #2, Decatur: likes it', UNIT)).toBe(false);
  });

  it('an empty label matches nothing', () => {
    expect(labelMatches('anything at all', '')).toBe(false);
    expect(labelMatches('anything at all', ' ., # ')).toBe(false);
  });
});

describe('hasStreetAddress (the unlabeledAddressLines pattern, spec D5.3)', () => {
  it('a house number, one to four words, then a street suffix', () => {
    for (const line of [
      'Asked about 77 Pine Rd',
      'liked 12 Main St.',
      '7 Martin Luther King Jr Dr',
      '1200 Peachtree Industrial Blvd: no',
      'Toured 5 Old Mill Way today',
      'Saw 40 Elm Terrace',
    ]) {
      expect(hasStreetAddress(line), line).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(hasStreetAddress('12 MAIN STREET')).toBe(true);
    expect(hasStreetAddress('12 main st')).toBe(true);
  });

  it('knows exactly the spec D5.3 suffixes, each one on its own', () => {
    expect([...STREET_SUFFIXES].sort()).toEqual([
      'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
      'ct', 'court', 'blvd', 'boulevard', 'way', 'pl', 'place', 'cir', 'circle',
      'pkwy', 'parkway', 'hwy', 'highway', 'ter', 'terrace', 'trl', 'trail',
    ].sort());
    for (const suffix of STREET_SUFFIXES) expect(hasStreetAddress(`10 Main ${suffix}`), suffix).toBe(true);
  });

  it('is false for a count, a missing number, zero or five words, or a suffix inside a word', () => {
    for (const line of [
      'prefers 3 bedrooms',
      'Household of 4',
      'moved 3 times',
      'Main St, Decatur',
      '12 St',
      '1 a b c d e St',
      '123 Main Streetcar stop',
    ]) {
      expect(hasStreetAddress(line), line).toBe(false);
    }
  });
});

describe('lib/propertyLabel.ts is a leaf (plan ruling PR5)', () => {
  it('imports nothing', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'propertyLabel.ts');
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\sfrom\s+['"]/);
  });
});
