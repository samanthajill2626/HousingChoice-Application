// contactProfile.ts — shared display helpers for contact type labels and the
// role-vs-type badge rule. Single source of truth for the type label map,
// imported by ContactsList (list badges) and ContactDetail (header pill).
// Also exports normalizeRelationships / normalizeCustomFields: pure helpers
// that strip invalid rows before submitting to the API. Both the Create and
// Edit forms use these to avoid drifting from each other or the backend rules.
import type { Contact, ContactType, Relationship, CustomField } from '../../api/index.js';

/** Canonical custom-kind role for a property manager. "Property Manager" is a
 *  custom kind on the `landlord` base type (there is no `pm` ContactType). */
export const PM_ROLE = 'Property Manager';

/** A human label for a contact's type badge. Single source of truth, imported
 *  by ContactsList (list badges) and ContactDetail (header pill). */
export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
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

/**
 * Filters relationship rows to keep only those where BOTH `role` AND `name`
 * are non-empty after trim. For each kept row, `contactId` is included only
 * when it is a non-empty string — the key is omitted entirely otherwise.
 * Matches the backend's accept rules so the FE never sends rows the API would
 * 400/drop.
 */
export function normalizeRelationships(rows: Relationship[]): Relationship[] {
  return rows
    .filter((r) => r.role.trim() !== '' && r.name.trim() !== '')
    .map((r) => {
      const row: Relationship = { role: r.role, name: r.name };
      if (r.contactId) row.contactId = r.contactId;
      return row;
    });
}

/**
 * Filters custom-field rows to drop those whose `label` is empty after trim.
 * The `value` is kept as-is (no trimming — whitespace may be intentional).
 * Matches the backend's accept rules so the FE never sends rows the API would
 * 400/drop.
 */
export function normalizeCustomFields(rows: CustomField[]): CustomField[] {
  return rows.filter((f) => f.label.trim() !== '');
}
