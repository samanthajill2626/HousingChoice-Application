// buildContactFile — pure derivations for the contact detail right pane from
// EXISTING endpoints (/api/placements, /api/units). The C4/C5 slices (listings-sent,
// media) aren't here — they 404 until the backend lands and render a pending
// state. These functions back the Placements / Properties panels with REAL
// data today. Tested in isolation.
//
// Tours are now first-class entities loaded via GET /api/tours?tenantId= (tenant)
// or GET /api/tours?unitId= (landlord/staff). TenantFile and LandlordFile each
// fetch tours directly; this module no longer derives them from placement.tours[].
import type { PlacementItem, UnitItem } from '../../api/index.js';

/** The tenant's placements (tenantId === contactId). */
export function tenantPlacements(placements: PlacementItem[], contactId: string): PlacementItem[] {
  return placements.filter((c) => c.tenantId === contactId);
}

/** The units this landlord owns (landlordId === contactId). */
export function landlordUnits(units: UnitItem[], contactId: string): UnitItem[] {
  return units.filter((u) => u.landlordId === contactId);
}

/** The placements on any of the landlord's units. */
export function landlordPlacements(
  placements: PlacementItem[],
  units: UnitItem[],
  contactId: string,
): PlacementItem[] {
  const owned = new Set(landlordUnits(units, contactId).map((u) => u.unitId));
  return placements.filter((c) => owned.has(c.unitId));
}
