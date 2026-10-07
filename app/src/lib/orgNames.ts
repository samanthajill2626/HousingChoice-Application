// The organization lists (housing authorities and agencies) - the PURE rules.
// Spec: docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// (D3 on the list, D4 matching, D5 write checks, D12 spellings, D13 limits).
// No I/O here: repos/orgListRepo.ts stores the list and services/orgNames.ts
// applies these rules to writes.

export type OrgKind = 'housing_authority' | 'agency';

export interface OrgEntry {
  orgId: string;
  kind: OrgKind;
  /** The stored full name. Records hold this exact text (spec D3). */
  name: string;
  /** Alternate spellings; shared only with entries of the SAME kind (D4). */
  spellings: string[];
  notes?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** The record fields that hold organization names (branch A). */
export type OrgField = 'housingAuthority' | 'agency' | 'accepted_authorities' | 'audience_filter';

export const KINDS_FOR_FIELD: Readonly<Record<OrgField, readonly OrgKind[]>> = {
  housingAuthority: ['housing_authority'],
  accepted_authorities: ['housing_authority'],
  audience_filter: ['housing_authority'],
  agency: ['agency'],
};

export const ORG_NAME_MAX = 120;
export const ORG_SPELLING_MAX = 120;
export const ORG_SPELLINGS_PER_ENTRY_MAX = 20;
export const ORG_NOTES_MAX = 500;

/**
 * The comparison form only - never stored. Lowercase; `&` to "and"; the
 * characters . , ( ) - / ' " _ to spaces; collapse whitespace; trim (D4).
 */
export function normalizeOrgText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,()\-\/'"_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * D3: a stored value is on the list for a field exactly when it is
 * character-for-character the name of an entry of an accepted kind.
 */
export function isOnListFor(
  entries: readonly OrgEntry[],
  value: string,
  kinds: readonly OrgKind[],
): boolean {
  return entries.some((e) => kinds.includes(e.kind) && e.name === value);
}
