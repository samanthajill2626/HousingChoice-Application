// contactProfile.ts — shared display helpers for contact type labels and the
// role-vs-type badge rule. Single source of truth for the type label map,
// imported by ContactsList (list badges) and ContactDetail (header pill).
import type { Contact, ContactType } from '../../api/index.js';

/** A human label for a contact's type badge. `pm` reads as "Property mgr".
 *  VERBATIM from the original TYPE_LABEL in ContactsList — do not change values. */
export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  pm: 'Property mgr',
  team_member: 'Team',
  unknown: 'Unknown',
};

/**
 * Returns the contact's `role` (if non-empty after trim) or falls back to the
 * type label supplied by `typeLabel`. Use for header pills and list badges so a
 * contact with role "Case worker" shows that instead of "Tenant".
 */
export function displayKind(
  contact: Pick<Contact, 'type' | 'role'>,
  typeLabel: (t: ContactType) => string,
): string {
  return contact.role?.trim() || typeLabel(contact.type);
}
