import { describe, expect, it } from 'vitest';
import {
  normalizeOrgText,
  isOnListFor,
  KINDS_FOR_FIELD,
  resolveOrgText,
  compoundSpans,
  closeNames,
  type OrgEntry,
} from '../src/lib/orgNames.js';

export function entry(partial: Partial<OrgEntry> & Pick<OrgEntry, 'name' | 'kind'>): OrgEntry {
  return {
    orgId: `id-${partial.name}`,
    spellings: [],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'test',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'test',
    ...partial,
  };
}

const ATLANTA = entry({
  kind: 'housing_authority',
  name: 'Atlanta Housing Authority',
  spellings: ['AHA', 'Atlanta Housing', 'Atlanta (AHA)'],
});
const AUGUSTA = entry({ kind: 'housing_authority', name: 'Augusta Housing Authority', spellings: ['AHA'] });
const DCA = entry({
  kind: 'housing_authority',
  name: 'Georgia Department of Community Affairs',
  spellings: ['DCA', 'Georgia DCA'],
});
const VASH = entry({
  kind: 'agency',
  name: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)',
  spellings: ['HUD-VASH', 'VASH'],
});
const STEP_UP = entry({ kind: 'agency', name: 'Step Up' });
const LIST = [ATLANTA, AUGUSTA, DCA, VASH, STEP_UP];

describe('normalizeOrgText', () => {
  it('lowercases, folds punctuation and underscores to spaces, collapses whitespace', () => {
    expect(normalizeOrgText('  Atlanta (AHA) ')).toBe('atlanta aha');
    expect(normalizeOrgText('atlanta_housing')).toBe('atlanta housing');
    expect(normalizeOrgText('HUD-VASH')).toBe('hud vash');
    expect(normalizeOrgText('Hope & Help, Inc.')).toBe('hope and help inc');
    expect(normalizeOrgText('St. Mary\'s / "Home"')).toBe('st mary s home');
  });
  it('returns an empty string for blank input', () => {
    expect(normalizeOrgText('   ')).toBe('');
  });
});

describe('isOnListFor (spec D3: exact text, right kind)', () => {
  it('is true only for a character-for-character name of an accepted kind', () => {
    expect(isOnListFor(LIST, 'Atlanta Housing Authority', ['housing_authority'])).toBe(true);
    expect(isOnListFor(LIST, 'atlanta housing authority', ['housing_authority'])).toBe(false);
    expect(isOnListFor(LIST, 'AHA', ['housing_authority'])).toBe(false);
    expect(isOnListFor(LIST, 'Step Up', ['housing_authority'])).toBe(false);
    expect(isOnListFor(LIST, 'Step Up', ['agency'])).toBe(true);
  });
  it('maps every field to its kinds', () => {
    expect(KINDS_FOR_FIELD.housingAuthority).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.accepted_authorities).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.audience_filter).toEqual(['housing_authority']);
    expect(KINDS_FOR_FIELD.agency).toEqual(['agency']);
  });
});

describe('resolveOrgText (spec D4)', () => {
  const HA = ['housing_authority'] as const;
  const AG = ['agency'] as const;
  it('matches a name ignoring case and punctuation', () => {
    expect(resolveOrgText(LIST, 'atlanta housing authority', HA)).toEqual({
      status: 'match',
      entry: ATLANTA,
      via: 'name',
    });
  });
  it('matches a unique spelling, including slug-shaped text', () => {
    expect(resolveOrgText(LIST, 'atlanta (aha)', HA)).toEqual({ status: 'match', entry: ATLANTA, via: 'spelling' });
    expect(resolveOrgText(LIST, 'atlanta_housing', HA)).toEqual({ status: 'match', entry: ATLANTA, via: 'spelling' });
  });
  it('a spelling two entries of the kind share is ambiguous, never a match', () => {
    expect(resolveOrgText(LIST, 'AHA', HA)).toEqual({ status: 'ambiguous', candidates: [ATLANTA, AUGUSTA] });
  });
  it('an exact name or spelling of the other kind is other_kind', () => {
    expect(resolveOrgText(LIST, 'HUD VASH', HA)).toEqual({ status: 'other_kind', entries: [VASH] });
    expect(resolveOrgText(LIST, 'Step Up', HA)).toEqual({ status: 'other_kind', entries: [STEP_UP] });
    expect(resolveOrgText(LIST, 'HUD VASH', AG)).toEqual({ status: 'match', entry: VASH, via: 'spelling' });
  });
  it('a value naming entries that no single entry explains is compound', () => {
    expect(resolveOrgText(LIST, 'DCA HUD-VASH', HA)).toEqual({ status: 'compound', spans: [[DCA], [VASH]] });
  });
  it('a value whose spans all fit one entry is not compound', () => {
    expect(resolveOrgText(LIST, 'Atlanta Housing Authority (AHA)', HA).status).toBe('unknown');
  });
  it('blank text is unknown with no close names', () => {
    expect(resolveOrgText(LIST, '   ', HA)).toEqual({ status: 'unknown', close: [] });
  });
});

describe('compoundSpans', () => {
  it('returns null for an exact name or spelling', () => {
    expect(compoundSpans(LIST, 'aha')).toBeNull();
    expect(compoundSpans(LIST, 'atlanta aha')).toBeNull();
  });
  it('takes the longest phrase at each position', () => {
    expect(compoundSpans(LIST, 'atlanta housing authority aha')).toBeNull();
    expect(compoundSpans(LIST, 'georgia dca vash')).toEqual([[DCA], [VASH]]);
  });
  it('needs two or more spans', () => {
    expect(compoundSpans(LIST, 'dca office')).toBeNull();
  });
});

describe('closeNames (prompts only)', () => {
  const HA_ONLY = LIST.filter((e) => e.kind === 'housing_authority');
  it('finds a name from abbreviated words', () => {
    expect(closeNames(HA_ONLY, 'atlanta hsg auth')[0]).toBe(ATLANTA);
  });
  it('finds a name from its initials', () => {
    const decatur = entry({ kind: 'housing_authority', name: 'Decatur Housing Authority' });
    expect(closeNames([...HA_ONLY, decatur], 'dha')).toContain(decatur);
  });
  it('finds a near-miss spelling', () => {
    expect(closeNames(HA_ONLY, 'atlnta housing authority')[0]).toBe(ATLANTA);
  });
  it('ignores matches on generic words alone', () => {
    expect(closeNames(HA_ONLY, 'fulton county')).toEqual([]);
  });
  it('returns at most three', () => {
    expect(closeNames(HA_ONLY, 'atlanta augusta georgia housing').length).toBeLessThanOrEqual(3);
  });
  it('scores nothing for a text longer than 120 characters (no name is that long)', () => {
    // Three of its four words begin words of Atlanta's name - a close name at 120 characters or fewer.
    expect(closeNames(HA_ONLY, `atlanta housing authority ${'x'.repeat(100)}`)).toEqual([]);
    expect(closeNames(HA_ONLY, `atlanta housing authority ${'x'.repeat(90)}`)[0]).toBe(ATLANTA);
  });
});
