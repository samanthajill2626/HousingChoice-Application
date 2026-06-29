// buildContactFile — pure derivations for the contact detail right pane from
// EXISTING endpoints (/api/placements, /api/units). The C4/C5 slices (listings-sent,
// media) aren't here — they 404 until the backend lands and render a pending
// state. These functions back the Placements / Tours / Properties panels with REAL
// data today. Tested in isolation.
import type { PlacementItem, UnitItem } from '../../api/index.js';

/** An aggregated tour row for the tenant file: the placement tour + which unit. */
export interface TourRow {
  placementId: string;
  unitId: string;
  date: string;
  outcome?: string;
}

/** The tenant's placements (tenantId === contactId). */
export function tenantPlacements(placements: PlacementItem[], contactId: string): PlacementItem[] {
  return placements.filter((c) => c.tenantId === contactId);
}

/** Every tour across the tenant's placements, newest-first, carrying its unit. */
export function tenantTours(placements: PlacementItem[], contactId: string): TourRow[] {
  const rows: TourRow[] = [];
  for (const c of tenantPlacements(placements, contactId)) {
    for (const t of c.tours ?? []) {
      rows.push({
        placementId: c.placementId,
        unitId: c.unitId,
        date: t.date,
        ...(t.outcome !== undefined && { outcome: t.outcome }),
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
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
