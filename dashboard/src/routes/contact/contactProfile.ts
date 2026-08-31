// contactProfile.ts — shared display helpers for contact type labels and the
// role-vs-type badge rule. Single source of truth for the type label map,
// imported by ContactsList (list badges) and ContactDetail (header pill).
// Also exports normalizeRelationships / normalizeCustomFields: pure helpers
// that strip invalid rows before submitting to the API. Both the Create and
// Edit forms use these to avoid drifting from each other or the backend rules.
import type { Contact, ContactPatch, ContactType, Relationship, CustomField } from '../../api/index.js';

/** Canonical custom-kind role for a property manager. "Property Manager" is a
 *  custom kind on the `landlord` base type (there is no `pm` ContactType). */
export const PM_ROLE = 'Property Manager';

export type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';

export const SUGGESTED_CONTACT_KIND_LABEL: Record<SuggestedContactKind, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  partner: 'Partner',
  property_manager: PM_ROLE,
};

const KIND_PATCH: Record<
  SuggestedContactKind,
  Required<Pick<ContactPatch, 'type' | 'role'>>
> = {
  tenant: { type: 'tenant', role: '' },
  landlord: { type: 'landlord', role: '' },
  partner: { type: 'partner', role: '' },
  property_manager: { type: 'landlord', role: PM_ROLE },
};

export function suggestedContactKindLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(SUGGESTED_CONTACT_KIND_LABEL, value)
    ? SUGGESTED_CONTACT_KIND_LABEL[value as SuggestedContactKind]
    : value;
}

export function patchForSuggestedContactKind(
  kind: SuggestedContactKind,
): Required<Pick<ContactPatch, 'type' | 'role'>> {
  return { ...KIND_PATCH[kind] };
}

/** A human label for a contact's type badge. Single source of truth, imported
 *  by ContactsList (list badges) and ContactDetail (header pill). */
export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  partner: 'Partner',
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
