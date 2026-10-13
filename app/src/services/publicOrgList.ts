// The PUBLIC read of the organization list (join-housing-authority spec
// docs/superpowers/specs/2026-10-12-join-housing-authority-design.md D1-D3).
// One source and one rule for the two public uses: GET
// /public/housing-authorities (the /join form's dropdown) and the sign-up's
// list check in POST /public/housing-fair (routes/public.ts).
//
// NEVER WRITES. The org list repo's get() creates the stored item from the
// starting list on an empty store; the public, unauthenticated surface must
// not be what creates it. So this reads with peek() and, when no item is
// stored, builds the starting list IN MEMORY - the same names get() would
// store - and leaves the store empty.
import { randomUUID } from 'node:crypto';
import { KINDS_FOR_FIELD, type OrgEntry } from '../lib/orgNames.js';
import { buildStartingEntries } from '../lib/orgStartingList.js';
import type { OrgListRepo } from '../repos/orgListRepo.js';

/** D2: the list read's own per-IP limit (hard-coded, the /unit-media precedent). */
export const PUBLIC_LIST_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

/** D3: the distinct refusal code for a housing authority that is not on the list. */
export const HOUSING_AUTHORITY_NOT_LISTED = 'housing_authority_not_listed' as const;

/** D1: the stored list via peek(), else the starting list in memory. Never writes. */
export async function loadPublicOrgEntries(
  repo: OrgListRepo,
  now: () => string = () => new Date().toISOString(),
): Promise<readonly OrgEntry[]> {
  const stored = await repo.peek();
  if (stored !== null) return stored.entries;
  return buildStartingEntries(now(), () => randomUUID());
}

/**
 * D1: the exact stored `name` of every housing authority entry - no ids,
 * spellings, notes, audit fields or agencies - unique, sorted
 * case-insensitively in English collation (localeCompare 'en', sensitivity
 * 'base'), with a plain code-unit compare breaking ties so the order is total.
 * The kinds are KINDS_FOR_FIELD.housingAuthority: the same kinds the sign-up's
 * list check (isOnListFor) accepts, so every name served here is accepted there.
 */
export function housingAuthorityNames(entries: readonly OrgEntry[]): string[] {
  const kinds = KINDS_FOR_FIELD.housingAuthority;
  const names = new Set<string>();
  for (const entry of entries) {
    if (kinds.includes(entry.kind)) names.add(entry.name);
  }
  return [...names].sort(
    (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0),
  );
}
