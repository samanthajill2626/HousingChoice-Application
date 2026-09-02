// Unit tests for the shared voice MASKING helpers (lib/voiceMasking.ts). The
// masked label is PERSISTED as call_party_label and SPOKEN to the callee in the
// whisper, so no rung of it may ever carry an unmasked surname.
import { describe, expect, it } from 'vitest';
import { shortNameFromFull } from '../src/lib/voiceMasking.js';

describe('shortNameFromFull', () => {
  it('masks a stored full name the way contactShortName masks a contact', () => {
    expect(shortNameFromFull('Bob Builder')).toBe('Bob B.');
    expect(shortNameFromFull('Bob')).toBe('Bob');
    expect(shortNameFromFull('  Ada   Lovelace-Byron ')).toBe('Ada L.');
    expect(shortNameFromFull('')).toBeUndefined();
    expect(shortNameFromFull(undefined)).toBeUndefined();
  });
});
