import { describe, expect, it } from 'vitest';
import {
  CASEWORKER_ROLE,
  PROPERTY_MANAGER_ROLE,
  canonicalSuggestedContactKind,
} from '../src/services/extraction/contactKinds.js';

describe('canonicalSuggestedContactKind', () => {
  it('keeps the Property Manager preset byte-exact', () => {
    expect(PROPERTY_MANAGER_ROLE).toBe('Property Manager');
  });

  it('keeps the Caseworker preset byte-exact (spec 2026-10-06 D16)', () => {
    expect(CASEWORKER_ROLE).toBe('Caseworker');
  });

  it.each([
    [{ type: 'tenant', role: '' }, 'tenant'],
    [{ type: 'landlord', role: '' }, 'landlord'],
    [{ type: 'partner', role: '' }, 'partner'],
    [{ type: 'landlord', role: 'Property Manager' }, 'property_manager'],
    // D16: a caseworker is still the partner KIND, so the conversion's type
    // drain records an AI `partner` suggestion as accepted.
    [{ type: 'partner', role: 'Caseworker' }, 'partner'],
    [{ type: 'tenant' }, 'tenant'],
  ] as const)('maps %o to %s', (contact, expected) => {
    expect(canonicalSuggestedContactKind(contact)).toBe(expected);
  });

  it.each([
    { type: 'tenant', role: 'Case Manager' },
    { type: 'landlord', role: 'Leasing Agent' },
    { type: 'landlord', role: ' Property Manager' },
    { type: 'landlord', role: 'Property Manager ' },
    { type: 'landlord', role: 'property manager' },
    { type: 'landlord', role: 'PROPERTY MANAGER' },
    { type: 'landlord', role: '   ' },
    { type: 'partner', role: 'Inspector' },
    // Byte-exact, as the Property Manager preset is (D16): the looser
    // isCaseworkerRole / mentions tiers never reach the canonicalizer.
    { type: 'partner', role: 'caseworker' },
    { type: 'partner', role: 'CASEWORKER' },
    { type: 'partner', role: ' Caseworker' },
    { type: 'partner', role: 'Caseworker ' },
    { type: 'partner', role: 'Case worker' },
    { type: 'partner', role: 'Case Manager' },
    { type: 'tenant', role: 'Caseworker' },
    { type: 'landlord', role: 'Caseworker' },
    { type: 'unknown', role: 'Caseworker' },
    { type: 'unknown', role: '' },
    { type: 'team_member', role: '' },
  ] as const)('does not compare unsupported stored shape %o', (contact) => {
    expect(canonicalSuggestedContactKind(contact)).toBeUndefined();
  });
});
