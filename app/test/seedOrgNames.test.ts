// Seeds write exact organization-list NAMES and the org-list item itself
// (clean-org-names spec D2 and section 7). Seeds are direct Puts that bypass
// the write check, so a slug or a spelling here would land in every dev and
// e2e world as a "Not on the list" value; and the lean world is the
// byte-stable e2e world, so the seeded item has fixed ids and timestamps.
import { describe, expect, it } from 'vitest';
import { isOnListFor, KINDS_FOR_FIELD } from '../src/lib/orgNames.js';
import { STARTING_ORG_LIST } from '../src/lib/orgStartingList.js';
import { SEED } from '../src/lib/seedData.js';
import { SEED_AUTHORITY, SEED_ORG_LIST_AT, seedOrgListItem } from '../src/lib/seed/orgList.js';
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
