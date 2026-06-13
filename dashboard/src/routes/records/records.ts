// Shared presentation helpers for the Records screens (Contacts + Properties).
// PURE + unit-testable: human labels for the wire enums, an honest contact name
// (never fabricated), and a rent-range formatter. Kept apart from the views so
// the formatting rules can be tested without rendering.
import type { Contact, ContactType, UnitItem, UnitStatus } from '../../api';

/** Human label for a contact type. */
export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  pm: 'Property manager',
  team_member: 'Team member',
  unknown: 'Unknown',
};

/** The contact types offered as list filters / create options, in UI order. */
export const CONTACT_TYPES: ContactType[] = [
  'tenant',
  'landlord',
  'pm',
  'team_member',
  'unknown',
];

/** Human label for a unit status. */
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  available: 'Available',
  placed: 'Placed',
  inactive: 'Inactive',
};

export const UNIT_STATUSES: UnitStatus[] = ['available', 'placed', 'inactive'];

/** A contact's name from structured fields, or undefined when neither is set.
 *  Honest identity: we never fabricate a name from the phone/type. */
export function contactName(contact: Pick<Contact, 'firstName' | 'lastName'>): string | undefined {
  const parts = [contact.firstName, contact.lastName].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** True when a contact still awaits human triage (honest-identity state). */
export function contactNeedsReview(contact: Pick<Contact, 'type' | 'status'>): boolean {
  return contact.type === 'unknown' || contact.status === 'needs_review';
}

/** A compact rent range string, e.g. "$1,200–$1,500" / "$1,200+" / "Up to
 *  $1,500" / undefined when neither bound is set. */
export function formatRentRange(
  min: number | undefined,
  max: number | undefined,
): string | undefined {
  const fmt = (n: number): string => `$${n.toLocaleString('en-US')}`;
  if (typeof min === 'number' && typeof max === 'number') {
    return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
  }
  if (typeof min === 'number') return `${fmt(min)}+`;
  if (typeof max === 'number') return `Up to ${fmt(max)}`;
  return undefined;
}

/** A one-line summary of a unit's bed/bath/area for list rows. */
export function unitSummaryLine(unit: UnitItem): string {
  const bits: string[] = [];
  if (typeof unit.beds === 'number') bits.push(`${unit.beds} bd`);
  if (typeof unit.baths === 'number') bits.push(`${unit.baths} ba`);
  const where = unit.area ?? unit.subzone ?? unit.jurisdiction;
  if (typeof where === 'string' && where.length > 0) bits.push(where);
  return bits.length > 0 ? bits.join(' · ') : 'No details yet';
}
