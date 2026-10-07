import { describe, expect, it } from 'vitest';
import {
  normalizeOrgText,
  isOnListFor,
  KINDS_FOR_FIELD,
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
