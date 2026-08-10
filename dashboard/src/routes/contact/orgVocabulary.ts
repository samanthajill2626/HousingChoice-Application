// HAND-MIRROR of the canonical spellings in app/src/lib/import/apply.ts
// (CANONICAL_AUTHORITY) - keep in sync by hand; no cross-workspace import exists,
// so there is deliberately no mechanical drift guard. Taxonomy and the drift
// record: docs/issues/housing-authority-free-text-drift.md.
//
// The importer's 13 canonical values split by KIND (founder taxonomy, 2026-08-09):
// a housing AUTHORITY issues the voucher, determines rent and pays the landlord;
// an AGENCY is a helper organization that assists the tenant. A tenant can hold
// one of each, which is why they are two fields and two suggestion lists.
// `Georgia Housing Voucher (GHV)` belongs to neither list - it is a program name
// the importer still emits into housingAuthority (open data decision in the drift
// issue), so suggesting it here would spread a value the model is retiring.

/** The eight authority-kind canonical spellings, offered on the tenant's
 *  "Housing authority" input. Free text is still accepted - the datalist
 *  suggests, it never constrains. */
export const AUTHORITY_SUGGESTIONS = [
  'Atlanta (AHA)',
  'Jonesboro (JHA)',
  'Dekalb County Housing',
  'DCA',
  'Fulton County',
  'Clayton County',
  'East Point',
  'McDonough',
] as const;

/** The four agency-kind canonical spellings, offered on the tenant's "Agency"
 *  input. Same rule: suggestions only, free text accepted. */
export const AGENCY_SUGGESTIONS = ['HUD VASH', 'Claratel', 'Hope Atlanta', 'Step Up'] as const;

/**
 * Normalize a typed organization name to its EFFECTIVE value: trim the ends and
 * collapse every interior whitespace run to one space. `Atlanta  (AHA)` and
 * `Atlanta (AHA)` are the same authority and must not become two facet chips
 * with split counts.
 *
 * Used on BOTH sides of the edit form's dirty check, not just the outgoing
 * value - see the PROVENANCE note at the housingAuthority diff in
 * ContactEditForm.
 */
export function collapseOrgInput(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}
