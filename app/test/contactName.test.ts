// M1.2 — exhaustive unit tests for the "First Last - N Bed" convention
// parser (lib/contactName.ts). Pure function: table-driven, no fakes.
import { describe, expect, it } from 'vitest';
import { parseContactName, type ParsedContactName } from '../src/lib/contactName.js';

describe('parseContactName — conforming strings', () => {
  const cases: [string, ParsedContactName][] = [
    // The canonical convention shape.
    ['John Smith - 3 Bed', { firstName: 'John', lastName: 'Smith', voucherSize: 3 }],
    ['Jane Doe - 1 Bed', { firstName: 'Jane', lastName: 'Doe', voucherSize: 1 }],
    // Case-insensitive size token; name casing is PRESERVED as typed.
    ['john smith - 3 bed', { firstName: 'john', lastName: 'smith', voucherSize: 3 }],
    ['MARIA LOPEZ - 2 BED', { firstName: 'MARIA', lastName: 'LOPEZ', voucherSize: 2 }],
    // Plural and "bedroom" variants.
    ['Anna Reyes - 2 Beds', { firstName: 'Anna', lastName: 'Reyes', voucherSize: 2 }],
    ['Anna Reyes - 2 Bedroom', { firstName: 'Anna', lastName: 'Reyes', voucherSize: 2 }],
    ['Anna Reyes - 2 bedrooms', { firstName: 'Anna', lastName: 'Reyes', voucherSize: 2 }],
    // Studio = voucherSize 0, any casing.
    ['Lily Chen - Studio', { firstName: 'Lily', lastName: 'Chen', voucherSize: 0 }],
    ['Lily Chen - studio', { firstName: 'Lily', lastName: 'Chen', voucherSize: 0 }],
    ['Lily Chen - STUDIO', { firstName: 'Lily', lastName: 'Chen', voucherSize: 0 }],
    // Multi-word last names: first token is the first name, the rest is the last name.
    ['Mary Jane Watson - 2 Bed', { firstName: 'Mary', lastName: 'Jane Watson', voucherSize: 2 }],
    ['Jean Van Der Berg - 4 Bed', { firstName: 'Jean', lastName: 'Van Der Berg', voucherSize: 4 }],
    // Hyphenated names: the LAST hyphen before a valid size token splits.
    ['Anna Smith-Jones - 2 Bed', { firstName: 'Anna', lastName: 'Smith-Jones', voucherSize: 2 }],
    ['Jean-Claude Van Damme - 4 Bed', { firstName: 'Jean-Claude', lastName: 'Van Damme', voucherSize: 4 }],
    ['Mary-Anne Smith-Jones - Studio', { firstName: 'Mary-Anne', lastName: 'Smith-Jones', voucherSize: 0 }],
    // Whitespace slop everywhere.
    ['  Maria   Garcia   -   1   Bed  ', { firstName: 'Maria', lastName: 'Garcia', voucherSize: 1 }],
    ['John Smith -2 Bed', { firstName: 'John', lastName: 'Smith', voucherSize: 2 }],
    ['John Smith- 2 Bed', { firstName: 'John', lastName: 'Smith', voucherSize: 2 }],
    ['John Smith-2Bed', { firstName: 'John', lastName: 'Smith', voucherSize: 2 }],
    // Suffixes/punctuation inside the name part survive as typed.
    ['John Smith Jr. - 2 Bed', { firstName: 'John', lastName: 'Smith Jr.', voucherSize: 2 }],
    ["Mary O'Brien - 3 Bed", { firstName: 'Mary', lastName: "O'Brien", voucherSize: 3 }],
    // Large/two-digit sizes parse (validation is the caller's business).
    ['Big Family - 10 Bed', { firstName: 'Big', lastName: 'Family', voucherSize: 10 }],
    ['Edge Case - 0 Bed', { firstName: 'Edge', lastName: 'Case', voucherSize: 0 }],
  ];

  it.each(cases)('parses %j', (input, expected) => {
    expect(parseContactName(input)).toEqual(expected);
  });
});

describe('parseContactName — non-conforming strings return undefined', () => {
  const cases: string[] = [
    '', // empty
    '   ', // whitespace only
    'John Smith', // no size suffix
    'John Smith - ', // dangling separator
    ' - 2 Bed', // no name
    '- 2 Bed', // no name at all
    'Cher - 2 Bed', // single-token name (convention is First Last)
    'John Smith - Bed', // size without a number (and not Studio)
    'John Smith - three Bed', // spelled-out number
    'John Smith - 2', // number without the Bed token
    'John Smith - 2 Bath', // wrong unit
    'John Smith - 2 Bedz', // trailing garbage on the unit
    'John Smith - Studio apartment', // trailing garbage after Studio
    'John Smith - 123 Bed', // 3+ digits is outside the convention
    'John Smith 2 Bed', // no separator hyphen
    '+15550100001', // a raw phone number
    'STOP', // a keyword, not a name
  ];

  it.each(cases)('rejects %j', (input) => {
    expect(parseContactName(input)).toBeUndefined();
  });
});

describe('parseContactName — purity', () => {
  it('returns a fresh object per call (no shared state)', () => {
    const a = parseContactName('John Smith - 2 Bed');
    const b = parseContactName('John Smith - 2 Bed');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
