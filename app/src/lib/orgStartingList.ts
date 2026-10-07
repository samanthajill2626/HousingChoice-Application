// The STARTING organization list (spec Appendix A). It seeds an EMPTY store
// once (repos/orgListRepo.ts) and the seeds' explicit put. After an
// environment has its `org-list` item, editing this file changes NOTHING
// there - change names through Settings > Housing authorities & agencies.
import type { OrgEntry, OrgKind } from './orgNames.js';

export interface StartingOrg {
  kind: OrgKind;
  name: string;
  spellings: string[];
  notes?: string;
}

export const STARTING_ORG_LIST: readonly StartingOrg[] = [
  {
    kind: 'housing_authority',
    name: 'Atlanta Housing Authority',
    spellings: ['AHA', 'Atlanta Housing', 'Housing Authority of the City of Atlanta', 'Atlanta (AHA)', 'Atlanta, aha, Atlanta housing'],
  },
  {
    kind: 'housing_authority',
    name: 'Georgia Department of Community Affairs',
    spellings: ['DCA', 'Georgia DCA', 'GA DCA', 'Department of Community Affairs', 'DCA, Department of Community Affairs', 'McDonough', 'Henry County', 'Clayton'],
    notes: 'Runs vouchers in 149 of Georgia\'s 159 counties (not Fulton, DeKalb, Clayton, Cobb, Bibb, Chatham, Glynn, Muscogee, Richmond or Sumter). North Regional Office in Atlanta.',
  },
  {
    kind: 'housing_authority',
    name: 'Georgia Housing Voucher Program (DBHDD)',
    spellings: ['GHV', 'GHVP', 'DBHDD', 'Georgia Housing Voucher', 'Georgia Housing Voucher (GHV)'],
    notes: 'Statewide supportive housing voucher run by the Department of Behavioral Health and Developmental Disabilities. DBHDD\'s contractor pays landlords; the tenant\'s provider agency requests the unit inspection.',
  },
  {
    kind: 'housing_authority',
    name: 'DeKalb County Housing Authority',
    spellings: ['HADC', 'Housing Authority of DeKalb County', 'Dekalb County Housing', 'Dekalb Housing'],
  },
  { kind: 'housing_authority', name: 'Decatur Housing Authority', spellings: ['Housing Authority of the City of Decatur'] },
  { kind: 'housing_authority', name: 'Marietta Housing Authority', spellings: ['MHA', 'Cobb County'] },
  {
    kind: 'housing_authority',
    name: 'Jonesboro Housing Authority',
    spellings: [
      'JHA',
      'Jonesboro (JHA)',
      'Jonesboro housing',
      'Jonesboro, JHA, Jonesboro housing',
      'Clayton County',
      'Housing Authority of Clayton County',
    ],
  },
  { kind: 'housing_authority', name: 'East Point Housing Authority', spellings: ['EPHA', 'East Point', 'Eastpoint Housing Authority'] },
  {
    kind: 'housing_authority',
    name: 'College Park Housing Authority',
    spellings: ['Housing Authority of the City of College Park', 'College Park'],
  },
  { kind: 'housing_authority', name: 'Macon-Bibb County Housing Authority', spellings: ['Macon Housing Authority', 'MHA'] },
  { kind: 'housing_authority', name: 'Augusta Housing Authority', spellings: ['AHA'] },
  {
    kind: 'housing_authority',
    name: 'Fulton County Housing Authority',
    spellings: ['Housing Authority of Fulton County', 'Fulton County', 'Fulton, Fulton County'],
    notes: 'Runs vouchers for Fulton County outside the City of Atlanta (Atlanta Housing Authority covers the city).',
  },
  {
    kind: 'agency',
    name: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)',
    spellings: ['HUD-VASH', 'VASH'],
    notes: 'National program. The voucher comes from a housing authority; the case manager comes from the local VA medical center.',
  },
  { kind: 'agency', name: 'Step Up', spellings: [] },
  { kind: 'agency', name: 'Claratel Behavioral Health', spellings: ['Claratel', 'DeKalb Community Service Board'] },
  { kind: 'agency', name: 'View Point Health', spellings: ['Viewpoint Health'] },
  { kind: 'agency', name: 'HOPE Atlanta', spellings: ['Travelers Aid'] },
  { kind: 'agency', name: 'Mercy Care', spellings: [] },
  { kind: 'agency', name: 'CaringWorks', spellings: ['Caring Works'] },
];

/** The starting list as stored entries. */
export function buildStartingEntries(now: string, newId: () => string): OrgEntry[] {
  return STARTING_ORG_LIST.map((s) => ({
    orgId: newId(),
    kind: s.kind,
    name: s.name,
    spellings: [...s.spellings],
    ...(s.notes !== undefined && { notes: s.notes }),
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
  }));
}
