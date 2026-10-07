// The one-time organization-name cleanup (spec 2026-10-06 section 8, D14):
// automatic mappings only. The PURE planners first: what each record would
// become, its audit payloads, its change counts and what it leaves for the
// Settings page's "Not on the list" section.
import { describe, expect, it } from 'vitest';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { planContact, planUnit } from '../scripts/clean-org-names.js';

const LIST_AT = '2026-10-06T00:00:00.000Z';
let ids = 0;
/** The starting list (spec Appendix A). */
const ENTRIES: OrgEntry[] = buildStartingEntries(LIST_AT, () => `org-${(ids += 1)}`);

const NOTHING = { audits: [], changes: {}, leftovers: [] };

describe('planContact (spec section 8: automatic mappings only)', () => {
  it('rewrites a housing authority spelling to the exact name', () => {
    const plan = planContact({ housingAuthority: 'Atlanta (AHA)' }, ENTRIES);
    expect(plan.write).toEqual({
      expect: { housingAuthority: 'Atlanta (AHA)', agency: null },
      next: { housingAuthority: 'Atlanta Housing Authority' },
    });
    expect(plan.audits).toEqual([{ field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority' }]);
    expect(plan.changes).toEqual({ housingAuthorityRewritten: 1 });
    expect(plan.leftovers).toEqual([]);
  });

  it('moves an agency named as the housing authority into an EMPTY agency (absent or "") and removes the housing authority', () => {
    for (const agency of [undefined, ''] as const) {
      const plan = planContact({ housingAuthority: 'Hope Atlanta', ...(agency !== undefined && { agency }) }, ENTRIES);
      expect(plan.write).toEqual({
        expect: { housingAuthority: 'Hope Atlanta', agency: agency ?? null },
        next: { housingAuthority: null, agency: 'HOPE Atlanta' },
      });
      // Strings only (plan 3.8): '' for the removed housing authority and the empty agency.
      expect(plan.audits).toEqual([
        { field: 'housingAuthority', from: 'Hope Atlanta', to: '' },
        { field: 'agency', from: '', to: 'HOPE Atlanta' },
      ]);
      expect(plan.changes).toEqual({ movedToAgency: 1 });
    }
  });

  it('an agency that already names the same organization is compatible: only the housing authority goes', () => {
    const plan = planContact(
      { housingAuthority: 'HUD VASH', agency: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)' },
      ENTRIES,
    );
    expect(plan.write?.next).toEqual({ housingAuthority: null });
    expect(plan.audits).toEqual([{ field: 'housingAuthority', from: 'HUD VASH', to: '' }]);
    expect(plan.changes).toEqual({ movedToAgency: 1 });
  });

  it('counts a conflict and leaves both when agency holds another value', () => {
    const plan = planContact({ housingAuthority: 'HUD VASH', agency: 'Step Up' }, ENTRIES);
    expect(plan.write).toBeUndefined();
    expect(plan.changes).toEqual({ agencyConflicts: 1 });
    expect(plan.leftovers).toEqual([{ field: 'housingAuthority', value: 'HUD VASH', resolution: 'other_kind' }]);
  });

  it('rewrites an agency spelling, and moves a housing-authority agency onto the rewritten one', () => {
    expect(planContact({ agency: 'Caring Works' }, ENTRIES)).toMatchObject({
      write: { expect: { housingAuthority: null, agency: 'Caring Works' }, next: { agency: 'CaringWorks' } },
      audits: [{ field: 'agency', from: 'Caring Works', to: 'CaringWorks' }],
      changes: { agencyRewritten: 1 },
    });
    const both = planContact({ housingAuthority: 'Claratel', agency: 'claratel' }, ENTRIES);
    expect(both.write?.next).toEqual({ housingAuthority: null, agency: 'Claratel Behavioral Health' });
    expect(both.changes).toEqual({ agencyRewritten: 1, movedToAgency: 1 });
  });

  it('leaves ambiguous, compound, unknown and other-kind values for the Settings page, untouched', () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ housingAuthority: 'AHA' }, { field: 'housingAuthority', value: 'AHA', resolution: 'ambiguous' }],
      [{ housingAuthority: 'DCA HUD-VASH' }, { field: 'housingAuthority', value: 'DCA HUD-VASH', resolution: 'compound' }],
      [
        { housingAuthority: 'Smyrna Housing Office' },
        { field: 'housingAuthority', value: 'Smyrna Housing Office', resolution: 'unknown' },
      ],
      [{ agency: 'Atlanta Housing Authority' }, { field: 'agency', value: 'Atlanta Housing Authority', resolution: 'other_kind' }],
    ];
    for (const [contact, leftover] of cases) {
      const plan = planContact(contact, ENTRIES);
      expect(plan.write).toBeUndefined();
      expect(plan.leftovers).toEqual([leftover]);
    }
  });

  it('plans nothing for exact list names and empty values', () => {
    expect(planContact({ housingAuthority: 'Atlanta Housing Authority', agency: 'Mercy Care' }, ENTRIES)).toEqual(NOTHING);
    expect(planContact({ agency: '' }, ENTRIES)).toEqual(NOTHING);
    expect(planContact({}, ENTRIES)).toEqual(NOTHING);
  });

  it('refuses to plan a malformed value (the run counts the record failed)', () => {
    expect(() => planContact({ housingAuthority: 42 }, ENTRIES)).toThrow();
    expect(() => planContact({ agency: ['x'] }, ENTRIES)).toThrow();
  });
});

describe('planUnit', () => {
  it('rewrites members, drops an agency when others remain, and de-duplicates', () => {
    const stored = ['Atlanta Housing', 'Hope Atlanta', 'Atlanta Housing Authority'];
    const plan = planUnit({ accepted_authorities: stored }, ENTRIES);
    expect(plan.write).toEqual({ expected: stored, next: ['Atlanta Housing Authority'] });
    expect(plan.changes).toEqual({ unitMembersRewritten: 1, unitAgencyMembersDropped: 1, unitDuplicatesRemoved: 1 });
    expect(plan.audits).toEqual([
      {
        field: 'accepted_authorities',
        from: 'Atlanta Housing, Hope Atlanta, Atlanta Housing Authority',
        to: 'Atlanta Housing Authority',
      },
    ]);
    expect(plan.leftovers).toEqual([]);
  });

  it('keeps an agency member that is the only one, and reports it', () => {
    const plan = planUnit({ accepted_authorities: ['Step Up'] }, ENTRIES);
    expect(plan.write).toBeUndefined();
    expect(plan.changes).toEqual({ unitAgencyMembersKept: 1 });
    expect(plan.leftovers).toEqual([{ field: 'accepted_authorities', value: 'Step Up', resolution: 'other_kind' }]);
  });

  it('keeps ambiguous and unknown members in place and reports them', () => {
    const plan = planUnit({ accepted_authorities: ['DCA', 'MHA', 'Smyrna Housing Office'] }, ENTRIES);
    expect(plan.write?.next).toEqual(['Georgia Department of Community Affairs', 'MHA', 'Smyrna Housing Office']);
    expect(plan.leftovers).toEqual([
      { field: 'accepted_authorities', value: 'MHA', resolution: 'ambiguous' },
      { field: 'accepted_authorities', value: 'Smyrna Housing Office', resolution: 'unknown' },
    ]);
  });

  it('backfills a jurisdiction-only unit from its resolved value, or the raw value', () => {
    // The audit is about the LIST, which was absent: from '' (plan 3.8) - so
    // even a raw backfill never reads "X -> X" on the property's Activity tab.
    expect(planUnit({ jurisdiction: 'East Point' }, ENTRIES)).toEqual({
      write: { expected: null, next: ['East Point Housing Authority'] },
      audits: [{ field: 'accepted_authorities', from: '', to: 'East Point Housing Authority' }],
      changes: { jurisdictionBackfilled: 1 },
      leftovers: [],
    });
    const raw = planUnit({ jurisdiction: 'Smyrna Housing Office' }, ENTRIES);
    expect(raw.write).toEqual({ expected: null, next: ['Smyrna Housing Office'] });
    expect(raw.audits).toEqual([{ field: 'accepted_authorities', from: '', to: 'Smyrna Housing Office' }]);
    expect(raw.leftovers).toEqual([{ field: 'accepted_authorities', value: 'Smyrna Housing Office', resolution: 'unknown' }]);
  });

  it('never uses jurisdiction once the unit stores a list - even an empty one (ruling R1-F1)', () => {
    expect(planUnit({ accepted_authorities: [], jurisdiction: 'East Point' }, ENTRIES)).toEqual(NOTHING);
  });

  it('plans nothing for a list of exact names', () => {
    expect(
      planUnit({ accepted_authorities: ['Atlanta Housing Authority', 'Georgia Department of Community Affairs'] }, ENTRIES),
    ).toEqual(NOTHING);
  });

  it('refuses to plan a list holding a non-string member', () => {
    expect(() => planUnit({ accepted_authorities: ['Atlanta Housing Authority', 42] }, ENTRIES)).toThrow();
  });
});
