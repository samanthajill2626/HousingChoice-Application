// buildContactFile — pure derivations for the contact detail right pane from
// EXISTING endpoints (/api/cases, /api/units). The C4/C5 slices (listings-sent,
// media) aren't here — they 404 until the backend lands and render a pending
// state. These functions back the Cases / Tours / Listings panels with REAL
// data today. Tested in isolation.
import type { CaseItem, UnitItem } from '../../api/index.js';

/** An aggregated tour row for the tenant file: the case tour + which unit. */
export interface TourRow {
  caseId: string;
  unitId: string;
  date: string;
  outcome?: string;
}

/** The tenant's cases (tenantId === contactId). */
export function tenantCases(cases: CaseItem[], contactId: string): CaseItem[] {
  return cases.filter((c) => c.tenantId === contactId);
}

/** Every tour across the tenant's cases, newest-first, carrying its unit. */
export function tenantTours(cases: CaseItem[], contactId: string): TourRow[] {
  const rows: TourRow[] = [];
  for (const c of tenantCases(cases, contactId)) {
    for (const t of c.tours ?? []) {
      rows.push({
        caseId: c.caseId,
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

/** The cases on any of the landlord's units. */
export function landlordCases(
  cases: CaseItem[],
  units: UnitItem[],
  contactId: string,
): CaseItem[] {
  const owned = new Set(landlordUnits(units, contactId).map((u) => u.unitId));
  return cases.filter((c) => owned.has(c.unitId));
}
