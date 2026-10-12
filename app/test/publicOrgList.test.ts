// join-housing-authority D1-D3 (docs/superpowers/specs/2026-10-12-join-housing-authority-design.md):
// services/publicOrgList.ts - the public read of the organization list. The
// stored list via peek(), else the starting list IN MEMORY (never a write);
// housing authority names only, unique, sorted case-insensitively.
import { describe, expect, it, vi } from 'vitest';
import type { OrgEntry, OrgKind } from '../src/lib/orgNames.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  PUBLIC_LIST_RATE_LIMIT,
  housingAuthorityNames,
  loadPublicOrgEntries,
} from '../src/services/publicOrgList.js';
import { createOrgListFake } from './helpers/orgListFake.js';

function entry(kind: OrgKind, name: string, orgId = `org-${name}`): OrgEntry {
  return {
    orgId,
    kind,
    name,
    spellings: [],
    createdAt: '2026-10-12T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-10-12T00:00:00.000Z',
    updatedBy: 'test',
  };
}

/** The starting list's housing authority names in D1 order. */
const STARTING_AUTHORITY_NAMES = [
  'Atlanta Housing Authority',
  'Augusta Housing Authority',
  'College Park Housing Authority',
  'Decatur Housing Authority',
  'DeKalb County Housing Authority',
  'East Point Housing Authority',
  'Fulton County Housing Authority',
  'Georgia Department of Community Affairs',
  'Georgia Housing Voucher Program (DBHDD)',
  'Jonesboro Housing Authority',
  'Macon-Bibb County Housing Authority',
  'Marietta Housing Authority',
];

describe('publicOrgList constants (D2, D3)', () => {
  it('the list limit is 60 per 60 000 ms and the refusal code is housing_authority_not_listed', () => {
    expect(PUBLIC_LIST_RATE_LIMIT).toEqual({ max: 60, windowMs: 60_000 });
    expect(HOUSING_AUTHORITY_NOT_LISTED).toBe('housing_authority_not_listed');
  });
});

describe('housingAuthorityNames (D1)', () => {
  it('keeps housing_authority names only and drops agencies and exact duplicates', () => {
    expect(
      housingAuthorityNames([
        entry('housing_authority', 'Decatur Housing Authority'),
        entry('agency', 'Step Up'),
        entry('housing_authority', 'Atlanta Housing Authority'),
        entry('housing_authority', 'Atlanta Housing Authority', 'org-duplicate'),
      ]),
    ).toEqual(['Atlanta Housing Authority', 'Decatur Housing Authority']);
  });

  it('sorts case-insensitively, not by code unit', () => {
    // A plain sort would put "Banana" before "apple" (uppercase sorts first).
    expect(
      housingAuthorityNames([
        entry('housing_authority', 'zeta Housing Authority'),
        entry('housing_authority', 'Banana Housing Authority'),
        entry('housing_authority', 'apple Housing Authority'),
      ]),
    ).toEqual(['apple Housing Authority', 'Banana Housing Authority', 'zeta Housing Authority']);
  });

  it('breaks a case-only tie with a plain compare, whatever the input order', () => {
    const upper = entry('housing_authority', 'ABC Housing Authority');
    const lower = entry('housing_authority', 'abc Housing Authority');
    expect(housingAuthorityNames([lower, upper])).toEqual([
      'ABC Housing Authority',
      'abc Housing Authority',
    ]);
    expect(housingAuthorityNames([upper, lower])).toEqual([
      'ABC Housing Authority',
      'abc Housing Authority',
    ]);
  });

  it('leaves the entries it is given in their order, and no entries gives no names', () => {
    const entries = [entry('housing_authority', 'b Authority'), entry('housing_authority', 'a Authority')];
    housingAuthorityNames(entries);
    expect(entries.map((e) => e.name)).toEqual(['b Authority', 'a Authority']);
    expect(housingAuthorityNames([])).toEqual([]);
  });
});

describe('loadPublicOrgEntries (D1)', () => {
  it('returns the STORED entries when the item exists', async () => {
    const repo = createOrgListFake();
    const stored = [entry('housing_authority', 'Only Housing Authority'), entry('agency', 'Only Agency')];
    await repo.putForSeed({ settingId: 'org-list', version: 3, entries: stored });
    expect(await loadPublicOrgEntries(repo)).toEqual(stored);
  });

  it('falls back to the starting list in memory on an empty store and never creates the item', async () => {
    const repo = createOrgListFake();
    const get = vi.spyOn(repo, 'get');
    const mutate = vi.spyOn(repo, 'mutate');
    const putForSeed = vi.spyOn(repo, 'putForSeed');

    const entries = await loadPublicOrgEntries(repo, () => '2026-10-12T09:00:00.000Z');

    expect(entries.map((e) => [e.kind, e.name])).toEqual(STARTING_ORG_LIST.map((s) => [s.kind, s.name]));
    expect(entries.every((e) => e.createdAt === '2026-10-12T09:00:00.000Z')).toBe(true);
    expect(await repo.peek()).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(putForSeed).not.toHaveBeenCalled();
  });

  it('propagates a read failure (the routes turn it into the generic 500)', async () => {
    const repo = createOrgListFake();
    vi.spyOn(repo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    await expect(loadPublicOrgEntries(repo)).rejects.toThrow('settings table unavailable');
  });

  it('the starting list read through housingAuthorityNames gives the twelve authorities in order', async () => {
    const names = housingAuthorityNames(await loadPublicOrgEntries(createOrgListFake()));
    expect(names).toEqual(STARTING_AUTHORITY_NAMES);
  });
});
