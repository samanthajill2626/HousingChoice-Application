// Seeds write exact organization-list NAMES and the org-list item itself
// (clean-org-names spec D2 and section 7). Seeds are direct Puts that bypass
// the write check, so a slug or a spelling here would land in every dev and
// e2e world as a "Not on the list" value; and the lean world is the
// byte-stable e2e world, so the seeded item has fixed ids and timestamps.
import { describe, expect, it } from 'vitest';
import { isOnListFor, KINDS_FOR_FIELD, type OrgKind } from '../src/lib/orgNames.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import { SEED } from '../src/lib/seedData.js';
import { SEED_AUTHORITY, SEED_ORG_LIST_AT, seedOrgListItem } from '../src/lib/seed/orgList.js';
import { castItems } from '../src/lib/seed/cast.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { ORG_LIST_SETTING_ID } from '../src/repos/orgListRepo.js';

/** The seeded list: every seeded value must be an exact name on it. */
const ENTRIES = seedOrgListItem().entries;

describe('the seeded org-list item (spec D2)', () => {
  it('is the starting list with fixed ids and timestamps - byte-stable across builds', () => {
    const item = seedOrgListItem();
    expect(JSON.stringify(seedOrgListItem())).toBe(JSON.stringify(item));
    expect(item.settingId).toBe(ORG_LIST_SETTING_ID);
    expect(item.version).toBe(1);
    expect(item.lastRewrite).toBeUndefined();
    expect(item.entries.map((e) => e.name)).toEqual(STARTING_ORG_LIST.map((s) => s.name));
    expect(item.entries.map((e) => e.orgId)).toEqual(
      STARTING_ORG_LIST.map((_, i) => `org-seed-${String(i + 1).padStart(2, '0')}`),
    );
    for (const e of item.entries) {
      expect([e.createdAt, e.updatedAt, e.createdBy]).toEqual([SEED_ORG_LIST_AT, SEED_ORG_LIST_AT, 'system']);
    }
  });

  it('is written by the lean seed, beside the org settings row', () => {
    const settings = SEED['settings'] ?? [];
    expect(settings.filter((r) => r['settingId'] === ORG_LIST_SETTING_ID)).toEqual([seedOrgListItem()]);
    expect(settings.some((r) => r['settingId'] === 'org')).toBe(true);
  });

  it('every authority name the seeds use is a housing authority on the seeded list', () => {
    for (const name of Object.values(SEED_AUTHORITY)) {
      expect(isOnListFor(ENTRIES, name, KINDS_FOR_FIELD.housingAuthority), name).toBe(true);
    }
  });
});

type SeedRow = Record<string, unknown>;
type OrgValueField =
  | 'housingAuthority'
  | 'agency'
  | 'authorities_served'
  | 'accepted_authorities'
  | 'jurisdiction'
  | 'audience_filter';

/** The kinds each seeded field accepts (authorities_served: a landlord's housing authorities). */
const FIELD_KINDS: Readonly<Record<OrgValueField, readonly OrgKind[]>> = {
  housingAuthority: KINDS_FOR_FIELD.housingAuthority,
  agency: KINDS_FOR_FIELD.agency,
  authorities_served: KINDS_FOR_FIELD.housingAuthority,
  accepted_authorities: KINDS_FOR_FIELD.accepted_authorities,
  jurisdiction: KINDS_FOR_FIELD.accepted_authorities,
  audience_filter: KINDS_FOR_FIELD.audience_filter,
};

const rowsOf = (tables: object, base: string): SeedRow[] =>
  (tables as Record<string, SeedRow[] | undefined>)[base] ?? [];
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every organization value in a seed's table map, with the field it sits in. */
function orgValues(tables: object): Array<{ field: OrgValueField; value: unknown }> {
  const out: Array<{ field: OrgValueField; value: unknown }> = [];
  for (const c of rowsOf(tables, 'contacts')) {
    if (c['housingAuthority'] !== undefined) out.push({ field: 'housingAuthority', value: c['housingAuthority'] });
    if (c['agency'] !== undefined) out.push({ field: 'agency', value: c['agency'] });
    for (const v of listOf(c['authorities_served'])) out.push({ field: 'authorities_served', value: v });
  }
  for (const u of rowsOf(tables, 'units')) {
    for (const v of listOf(u['accepted_authorities'])) out.push({ field: 'accepted_authorities', value: v });
    if (u['jurisdiction'] !== undefined) out.push({ field: 'jurisdiction', value: u['jurisdiction'] });
  }
  for (const b of rowsOf(tables, 'broadcasts')) {
    const filter = b['audience_filter'] as { housing_authority?: unknown } | undefined;
    if (filter?.housing_authority !== undefined) {
      out.push({ field: 'audience_filter', value: filter.housing_authority });
    }
  }
  return out;
}

/** The values that are NOT an exact list name of their field's kind - must be none. */
function offList(tables: object): string[] {
  return orgValues(tables)
    .filter(({ field, value }) => typeof value !== 'string' || !isOnListFor(ENTRIES, value, FIELD_KINDS[field]))
    .map(({ field, value }) => `${field}: ${JSON.stringify(value)}`);
}

/** The retired seed slugs (spec section 7). */
const RETIRED_SLUG = /atlanta_housing|ga_dca|dekalb_housing|fulton_housing|gwinnett_housing|cobb_housing/;

describe('the lean seed holds list names only (spec section 7)', () => {
  it('every housing authority, accepted authority and authorities_served member is an exact list name', () => {
    expect(orgValues(SEED).length).toBeGreaterThan(0);
    expect(offList(SEED)).toEqual([]);
  });

  it('no retired slug is left in the lean seed', () => {
    expect(JSON.stringify(SEED)).not.toMatch(RETIRED_SLUG);
  });
});

describe('the full profile (cast, live) holds list names only', () => {
  const NOW = new Date('2026-10-06T12:00:00.000Z');

  it('cast', () => {
    const items = castItems();
    expect(orgValues(items).length).toBeGreaterThan(0);
    expect(offList(items)).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(RETIRED_SLUG);
  });

  it('live', () => {
    const items = buildLiveStaticItems(NOW);
    expect(orgValues(items).length).toBeGreaterThan(0);
    expect(offList(items)).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(RETIRED_SLUG);
  });
});

describe('the matrix holds list names only, broadcast filters included', () => {
  const items = matrixItems(new Date('2026-10-06T12:00:00.000Z'));

  it('every value is an exact list name', () => {
    expect(orgValues(items).length).toBeGreaterThan(0);
    expect(offList(items)).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(RETIRED_SLUG);
  });

  it('the seeded broadcasts filter on list names (the draft is re-checked at preview - spec D7)', () => {
    const filters = rowsOf(items, 'broadcasts').map(
      (b) => (b['audience_filter'] as { housing_authority?: unknown } | undefined)?.housing_authority,
    );
    expect(filters).toEqual([SEED_AUTHORITY.atlanta, SEED_AUTHORITY.dca]);
  });
});
