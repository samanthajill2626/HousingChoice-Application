import type { SuggestedContactKind } from '../../adapters/extraction.js';
import type { ContactItem } from '../../repos/contactsRepo.js';

export const PROPERTY_MANAGER_ROLE = 'Property Manager';

type ContactKindShape = Pick<ContactItem, 'type'> & { role?: unknown };

export function canonicalSuggestedContactKind(
  contact: ContactKindShape,
): SuggestedContactKind | undefined {
  const role = typeof contact.role === 'string' ? contact.role : '';
  if (contact.type === 'landlord' && role === PROPERTY_MANAGER_ROLE) {
    return 'property_manager';
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
