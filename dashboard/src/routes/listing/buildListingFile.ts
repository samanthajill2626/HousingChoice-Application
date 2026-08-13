// buildListingFile — pure derivations for the property detail right pane, from
// the unit + EXISTING endpoints (/api/placements, /api/units) + the resolved landlord
// contact. The C3 roster/related endpoint isn't live yet, so these provide the
// honest FALLBACKS the spec calls for:
//   - listingRoster: the unit's contacts[] (C3) when present, else a single
//     landlord row synthesized from `landlordId` + the resolved contact.
//   - placementsOnUnit: REAL — placements whose unitId === this unit.
//   - relatedByLandlord: REAL FALLBACK — other units of the same landlord,
//     excluding self, labelled "Same landlord".
// Tested in isolation so the components stay declarative.
import type {
  PlacementItem,
  Contact,
  RelatedUnit,
  UnitContact,
  UnitItem,
} from '../../api/index.js';
import { contactDisplayName } from '../contact/format.js';

/** A roster row for the Contacts card: a landlord/PM contact on this unit. */
export interface RosterRow {
  contactId: string;
  /** Display name, when known (from the C3 row or the resolved contact). */
  name?: string;
  /** The MACHINE role - what the roster edit-mode role selector reads and what
   *  POST /api/units/:id/contacts takes back. `roleLabel` is its display twin. */
  role: UnitContact['role'];
  /** Human role label, e.g. "Landlord" / "Property manager". */
  roleLabel: string;
  company?: string;
  /** The primary contact: the property's default contact - relay groups
   *  and masked calls. */
  primaryContact: boolean;
  /** True when synthesized from `landlordId` (C3 not live), false from contacts[]. */
  fallback: boolean;
}

/** Human label per roster role — shared with the Activity card's contact rows. */
export const ROLE_LABEL: Record<UnitContact['role'], string> = {
  landlord: 'Landlord',
  pm: 'Property manager',
  owner: 'Owner',
  other: 'Contact',
};

/** The landlord/PM roster for a unit. Prefers the C3 `contacts[]` (primaryContact
 *  first); falls back to a single landlord row from `landlordId` + the resolved
 *  contact when the roster isn't live yet. Empty only when neither exists. */
export function listingRoster(unit: UnitItem, landlord: Contact | null): RosterRow[] {
  if (unit.contacts && unit.contacts.length > 0) {
    return [...unit.contacts]
      .sort((a, b) => Number(b.primaryContact) - Number(a.primaryContact))
      .map((c) => ({
        contactId: c.contactId,
        ...(c.name !== undefined && { name: c.name }),
        role: c.role,
        roleLabel: ROLE_LABEL[c.role],
        ...(c.company !== undefined && { company: c.company }),
        primaryContact: c.primaryContact,
        fallback: false,
      }));
  }

  const landlordId = unit.landlordId;
  if (!landlordId) return [];

  const name =
    landlord && (landlord.firstName || landlord.lastName)
      ? contactDisplayName(landlord.firstName, landlord.lastName, undefined)
      : undefined;
  const company =
    landlord && typeof landlord['company'] === 'string'
      ? (landlord['company'] as string)
      : undefined;

  return [
    {
      contactId: landlordId,
      ...(name !== undefined && { name }),
      role: 'landlord',
      roleLabel: 'Landlord',
      ...(company !== undefined && { company }),
      primaryContact: true,
      fallback: true,
    },
  ];
}

/** The placements on this unit (unitId === this unit). REAL data today. */
export function placementsOnUnit(placements: PlacementItem[], unitId: string): PlacementItem[] {
  return placements.filter((c) => c.unitId === unitId);
}

/** Other units of the same landlord, excluding self, as RelatedUnit rows
 *  labelled "Same landlord". The honest FALLBACK for C3's /related until BE3. */
export function relatedByLandlord(units: UnitItem[], unit: UnitItem): RelatedUnit[] {
  const landlordId = unit.landlordId;
  if (!landlordId) return [];
  return units
    .filter((u) => u.landlordId === landlordId && u.unitId !== unit.unitId)
    .map((u) => ({
      unitId: u.unitId,
      ...(u.address !== undefined && { address: u.address }),
      status: u.status,
      relation: 'same_landlord' as const,
      label: 'Same landlord',
    }));
}
