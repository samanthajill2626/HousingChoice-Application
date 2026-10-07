// The organization list in the seeded worlds (clean-org-names spec D2 and
// section 7).
//
// Seeds write EXACT LIST NAMES - never a slug, never a spelling. Seeds are
// direct Puts that bypass the write check, so anything else would show up in
// every dev and e2e world as a "Not on the list" value. The retired slugs map
// as spec section 7 says; each SEED_AUTHORITY member names the slug it
// replaced.
//
// The seeded `org-list` item is the starting list (lib/orgStartingList.ts)
// with FIXED ids, a fixed timestamp and version 1: the lean world is the
// byte-stable e2e world, and a runtime uuid or clock here would make every
// reseed write a different item. seedAll writes it with its ordinary
// UNCONDITIONAL Put, which is also what overwrites an item a reader created
// from the starting list while /__dev/reseed had the settings table empty
// (lib/devReset.ts clears every table, then seeds).
//
// The repo import is TYPE-ONLY on purpose: every seed imports this module
// (including the performance seed the e2e workspace loads), so it stays free
// of the repo's runtime dependencies. app/test/seedOrgNames.test.ts pins the
// literal id against ORG_LIST_SETTING_ID.
import type { OrgListItem } from '../../repos/orgListRepo.js';
import { buildStartingEntries } from '../orgStartingList.js';

/** When the seeded list was "created": fixed (the lean seed's T0), so the item is byte-stable. */
export const SEED_ORG_LIST_AT = '2026-06-01T14:00:00.000Z';

/** The housing authority NAMES the seeds use, keyed by the slug they replaced. */
export const SEED_AUTHORITY = {
  /** was `atlanta_housing` */
  atlanta: 'Atlanta Housing Authority',
  /** was `ga_dca`, and `gwinnett_housing` (Gwinnett County vouchers are DCA's - spec 1.3) */
  dca: 'Georgia Department of Community Affairs',
  /** was `dekalb_housing` */
  dekalb: 'DeKalb County Housing Authority',
  /** was `cobb_housing` (Cobb County vouchers are Marietta Housing Authority's - spec 1.3) */
  marietta: 'Marietta Housing Authority',
  /** was `fulton_housing` */
  fulton: 'Fulton County Housing Authority',
} as const;

/** The seeded `org-list` item: the starting list with fixed ids (org-seed-01, org-seed-02, ...). */
export function seedOrgListItem(): OrgListItem {
  let n = 0;
  return {
    settingId: 'org-list',
    version: 1,
    entries: buildStartingEntries(SEED_ORG_LIST_AT, () => `org-seed-${String((n += 1)).padStart(2, '0')}`),
  };
}

/** The same item as a seed row (the SEED map holds plain records). */
export function seedOrgListRow(): Record<string, unknown> {
  return { ...seedOrgListItem() };
}
