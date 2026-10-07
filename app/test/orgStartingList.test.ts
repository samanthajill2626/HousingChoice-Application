import { describe, expect, it } from 'vitest';
import { STARTING_ORG_LIST, buildStartingEntries } from '../src/lib/orgStartingList.js';
import {
  checkNewName,
  checkSpelling,
  resolveOrgText,
  type OrgEntry,
} from '../src/lib/orgNames.js';

const NOW = '2026-10-06T00:00:00.000Z';
let n = 0;
const entries: OrgEntry[] = buildStartingEntries(NOW, () => `org-${(n += 1)}`);
const byName = (name: string): OrgEntry => {
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`missing ${name}`);
  return e;
};
const HA = ['housing_authority'] as const;
const AG = ['agency'] as const;

describe('STARTING_ORG_LIST conforms to the rules', () => {
  it('every name is valid against the others', () => {
    for (const e of entries) expect(checkNewName(entries, e.name, { excludeOrgId: e.orgId })).toBeNull();
  });
  it('the only shared spellings are AHA and MHA, each within one kind', () => {
    const shared = new Map<string, string[]>();
    for (const e of entries) {
      for (const s of e.spellings) {
        const without = { ...e, spellings: e.spellings.filter((x) => x !== s) };
        const problem = checkSpelling(entries.map((x) => (x.orgId === e.orgId ? without : x)), without, s);
        if (problem === null) continue;
        expect(problem.problem).toBe('shared_same_kind');
        shared.set(s, [...(shared.get(s) ?? []), e.name]);
      }
    }
    expect([...shared.keys()].sort()).toEqual(['AHA', 'MHA']);
  });
  it('builds entries with ids, timestamps and system authorship', () => {
    expect(entries.every((e) => e.orgId.startsWith('org-') && e.createdAt === NOW && e.createdBy === 'system')).toBe(true);
    expect(entries.length).toBe(STARTING_ORG_LIST.length);
  });
});

describe('old values resolve as spec Appendix A says', () => {
  const cases: Array<[string, readonly ('housing_authority' | 'agency')[], string]> = [
    ['Atlanta (AHA)', HA, 'Atlanta Housing Authority'],
    ['Atlanta, aha, Atlanta housing', HA, 'Atlanta Housing Authority'],
    ['atlanta_housing', HA, 'Atlanta Housing Authority'],
    ['Jonesboro (JHA)', HA, 'Jonesboro Housing Authority'],
    ['Dekalb County Housing', HA, 'DeKalb County Housing Authority'],
    ['dekalb_housing', HA, 'DeKalb County Housing Authority'],
    ['Georgia Housing Voucher (GHV)', HA, 'Georgia Housing Voucher Program (DBHDD)'],
    ['DCA', HA, 'Georgia Department of Community Affairs'],
    ['ga_dca', HA, 'Georgia Department of Community Affairs'],
    ['East Point', HA, 'East Point Housing Authority'],
    ['College Park', HA, 'College Park Housing Authority'],
    ['HUD VASH', AG, 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)'],
    ['Claratel', AG, 'Claratel Behavioral Health'],
    ['Hope Atlanta', AG, 'HOPE Atlanta'],
    ['Step Up', AG, 'Step Up'],
  ];
  it.each(cases)('%s -> %s', (text, kinds, name) => {
    const r = resolveOrgText(entries, text, kinds);
    expect(r.status).toBe('match');
    if (r.status === 'match') expect(r.entry.name).toBe(name);
  });
  it('agency names in a housing authority field are the other kind', () => {
    for (const t of ['HUD VASH', 'Claratel', 'Hope Atlanta', 'Step Up']) {
      expect(resolveOrgText(entries, t, HA).status).toBe('other_kind');
    }
  });
  it('bare AHA and MHA are ambiguous by design', () => {
    expect(resolveOrgText(entries, 'AHA', HA).status).toBe('ambiguous');
    expect(resolveOrgText(entries, 'MHA', HA).status).toBe('ambiguous');
  });
  it('DCA HUD-VASH is compound', () => {
    const r = resolveOrgText(entries, 'DCA HUD-VASH', HA);
    expect(r.status).toBe('compound');
    if (r.status === 'compound') {
      expect(r.spans.map((s) => s.map((e) => e.name))).toEqual([
        ['Georgia Department of Community Affairs'],
        ['HUD-Veterans Affairs Supportive Housing (HUD-VASH)'],
      ]);
    }
  });
  // Sam's answers (2026-10-06 meeting, spec section 13): the old county values
  // map to the authority that runs those vouchers.
  const samMappings: Array<[string, string]> = [
    ['Fulton County', 'Fulton County Housing Authority'],
    ['Fulton, Fulton County', 'Fulton County Housing Authority'],
    ['Housing Authority of Fulton County', 'Fulton County Housing Authority'],
    ['McDonough', 'Georgia Department of Community Affairs'],
    ['Henry County', 'Georgia Department of Community Affairs'],
    ['Clayton County', 'Jonesboro Housing Authority'],
    ['Housing Authority of Clayton County', 'Jonesboro Housing Authority'],
    // The retired alias map read a bare `clayton` as Clayton County, and
    // Jonesboro Housing Authority is that county's only voucher administrator
    // (DCA does not serve Clayton County) - Cameron, 2026-10-07, reversing
    // the launch-gate default of DCA (the Rabun County city is not in this
    // caseload).
    ['Clayton', 'Jonesboro Housing Authority'],
    ['Cobb County', 'Marietta Housing Authority'],
  ];
  it.each(samMappings)('%s -> %s (Sam, 2026-10-06)', (text, name) => {
    const r = resolveOrgText(entries, text, HA);
    expect(r.status === 'match' && r.entry.name).toBe(name);
  });
  it('the slug and the public-housing authority\'s full name stay off the list', () => {
    for (const t of ['fulton_housing', 'McDonough Housing Authority']) {
      expect(resolveOrgText(entries, t, HA).status).not.toBe('match');
    }
  });
});

it('every entry carries notes only within the cap', () => {
  expect(byName('Georgia Department of Community Affairs').notes?.length ?? 0).toBeLessThanOrEqual(500);
});
