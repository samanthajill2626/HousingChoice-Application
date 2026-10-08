import type { SuggestedContactKind } from '../../adapters/extraction.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import { CASEWORKER_ROLE } from '../../lib/caseworkers.js';

export const PROPERTY_MANAGER_ROLE = 'Property Manager';

// The caseworker preset (spec 2026-10-06 D16) is DEFINED in the leaf
// lib/caseworkers.ts and re-exported here, so both import paths name one
// constant (plan 3.2).
export { CASEWORKER_ROLE };

type ContactKindShape = Pick<ContactItem, 'type'> & { role?: unknown };

export function canonicalSuggestedContactKind(
  contact: ContactKindShape,
): SuggestedContactKind | undefined {
  const role = typeof contact.role === 'string' ? contact.role : '';
  if (contact.type === 'landlord' && role === PROPERTY_MANAGER_ROLE) {
    return 'property_manager';
  }
  // D16: the caseworker preset is still the partner KIND - byte-exact, as the
  // Property Manager preset is - so accepting an AI `partner` suggestion
  // through the caseworker conversion records `accepted`. Any other
  // non-empty partner role stays unsupported.
  if (contact.type === 'partner' && role === CASEWORKER_ROLE) {
    return 'partner';
  }
  if (role !== '') return undefined;
  if (
    contact.type === 'tenant'
    || contact.type === 'landlord'
    || contact.type === 'partner'
  ) {
    return contact.type;
  }
  return undefined;
}
