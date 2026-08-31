import { describe, expect, it } from 'vitest';
import {
  PROPERTY_MANAGER_ROLE,
  canonicalSuggestedContactKind,
} from '../src/services/extraction/contactKinds.js';

describe('canonicalSuggestedContactKind', () => {
  it('keeps the Property Manager preset byte-exact', () => {
    expect(PROPERTY_MANAGER_ROLE).toBe('Property Manager');
  });

  it.each([
    [{ type: 'tenant', role: '' }, 'tenant'],
    [{ type: 'landlord', role: '' }, 'landlord'],
    [{ type: 'partner', role: '' }, 'partner'],
    [{ type: 'landlord', role: 'Property Manager' }, 'property_manager'],
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
    { type: 'unknown', role: '' },
    { type: 'team_member', role: '' },
  ] as const)('does not compare unsupported stored shape %o', (contact) => {
    expect(canonicalSuggestedContactKind(contact)).toBeUndefined();
  });
});
