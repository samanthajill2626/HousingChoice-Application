import { describe, expect, it } from 'vitest';
import {
  normalizeOrgText,
  isOnListFor,
  KINDS_FOR_FIELD,
  resolveOrgText,
  compoundSpans,
  closeNames,
  checkScalarWrite,
  checkListWrite,
  checkNewName,
  checkSpelling,
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

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** The invisible format characters normalizeOrgText removes (review LOW-1). */
const ORG_FORMAT_CODES = [
  0xad,
  ...range(0x200b, 0x200f),
  ...range(0x202a, 0x202e),
  ...range(0x2060, 0x2064),
  ...range(0x2066, 0x206f),
  0xfeff,
];

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
  // Review LOW-1: an iPhone's smart punctuation types U+2019 for an
  // apostrophe, and a pasted name can hide an invisible character - neither
  // may make a visually identical name compare different.
  it('folds typographic quotes and dashes to their ASCII forms first', () => {
    expect(normalizeOrgText('St. Jude\u2019s')).toBe(normalizeOrgText("St. Jude's"));
    for (const single of ['\u2018', '\u2019', '\u201a', '\u201b', '\u2032']) {
      expect(normalizeOrgText(`St. Jude${single}s`)).toBe('st jude s');
    }
    for (const double of ['\u201c', '\u201d', '\u201e', '\u2033']) {
      expect(normalizeOrgText(`${double}Home${double}`)).toBe(normalizeOrgText('"Home"'));
    }
    expect(normalizeOrgText('Macon\u2013Bibb')).toBe(normalizeOrgText('Macon-Bibb'));
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212']) {
      expect(normalizeOrgText(`Macon${dash}Bibb`)).toBe('macon bibb');
    }
  });
  it('ignores invisible format characters - a zero-width space or a soft hyphen inside a word', () => {
    expect(normalizeOrgText('Atl\u200banta Housing')).toBe(normalizeOrgText('Atlanta Housing'));
    expect(normalizeOrgText('Hous\u00ading Authority')).toBe(normalizeOrgText('Housing Authority'));
    for (const code of ORG_FORMAT_CODES) {
      expect(normalizeOrgText(`Atl${String.fromCharCode(code)}anta`), code.toString(16)).toBe('atlanta');
    }
  });
  it('so a curly-apostrophe or soft-hyphen twin of a listed name IS that name, never a new one', () => {
    const jude = entry({ kind: 'agency', name: "St. Jude's Recovery Center" });
    expect(checkNewName([jude], 'St. Jude\u2019s Recovery Center')).toEqual({ code: 'org_name_taken', entry: jude });
    expect(resolveOrgText([jude], 'St. Jude\u2019s Recovery Cen\u00adter', ['agency'])).toMatchObject({
      status: 'match',
      entry: jude,
    });
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

describe('checkScalarWrite (D5)', () => {
  it('passes an unchanged value even when it is not on the list', () => {
    expect(checkScalarWrite(LIST, 'housingAuthority', 'atlanta_housing', 'atlanta_housing')).toEqual({
      ok: true,
      value: 'atlanta_housing',
    });
  });
  it('clears on blank', () => {
    expect(checkScalarWrite(LIST, 'housingAuthority', '  ', 'Atlanta Housing Authority')).toEqual({ ok: true, value: null });
  });
  it('stores an exact name as is and a unique spelling as its name', () => {
    expect(checkScalarWrite(LIST, 'housingAuthority', 'Atlanta Housing Authority', undefined)).toEqual({
      ok: true,
      value: 'Atlanta Housing Authority',
    });
    expect(checkScalarWrite(LIST, 'housingAuthority', 'Georgia DCA', undefined)).toEqual({
      ok: true,
      value: 'Georgia Department of Community Affairs',
    });
  });
  it('refuses ambiguous, other-kind, compound and unknown text with details', () => {
    const amb = checkScalarWrite(LIST, 'housingAuthority', 'AHA', undefined);
    expect(amb.ok).toBe(false);
    if (!amb.ok) {
      expect(amb.error.error).toBe('org_not_on_list');
      expect(amb.error.field).toBe('housingAuthority');
      expect(amb.error.candidates.map((c) => c.name)).toEqual([ATLANTA.name, AUGUSTA.name]);
    }
    const other = checkScalarWrite(LIST, 'housingAuthority', 'Step Up', undefined);
    expect(!other.ok && other.error.otherKind?.map((c) => c.name)).toEqual(['Step Up']);
    const comp = checkScalarWrite(LIST, 'housingAuthority', 'DCA VASH', undefined);
    expect(!comp.ok && comp.error.compound?.length).toBe(2);
    const unk = checkScalarWrite(LIST, 'agency', 'Nowhere Org', undefined);
    expect(!unk.ok && unk.error.close).toEqual([]);
  });
});

describe('checkListWrite (D5 per member)', () => {
  it('keeps members the record already holds and the legacy jurisdiction', () => {
    expect(checkListWrite(LIST, 'accepted_authorities', ['atlanta_housing', 'Old Place'], ['atlanta_housing'], 'Old Place')).toEqual({
      ok: true,
      value: ['atlanta_housing', 'Old Place'],
    });
  });
  it('compares held members after trimming both sides', () => {
    expect(checkListWrite(LIST, 'accepted_authorities', ['Old Place'], ['  Old Place '], undefined)).toEqual({
      ok: true,
      value: ['Old Place'],
    });
    expect(checkListWrite(LIST, 'accepted_authorities', ['Old Place'], [], ' Old Place ')).toEqual({
      ok: true,
      value: ['Old Place'],
    });
  });
  it('resolves new members, trims and de-duplicates', () => {
    expect(checkListWrite(LIST, 'accepted_authorities', [' Georgia DCA ', 'Georgia Department of Community Affairs', ''], [], undefined)).toEqual({
      ok: true,
      value: ['Georgia Department of Community Affairs'],
    });
  });
  it('refuses the first new member that does not resolve', () => {
    const r = checkListWrite(LIST, 'accepted_authorities', ['Atlanta Housing Authority', 'Step Up'], [], undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.text).toBe('Step Up');
  });
});

describe('checkNewName (D13, D12 rename rule)', () => {
  it('accepts a fresh name', () => {
    expect(checkNewName(LIST, 'Marietta Housing Authority')).toBeNull();
  });
  it('refuses blank, too long, nothing left once normalized, taken by any name or spelling of either kind, and compound', () => {
    expect(checkNewName(LIST, '  ')).toEqual({ code: 'org_name_empty' });
    expect(checkNewName(LIST, 'x'.repeat(121))).toEqual({ code: 'org_name_too_long' });
    // Spec D13: a name that normalizes to '' could never be matched or settled.
    expect(checkNewName(LIST, '-')).toEqual({ code: 'org_name_invalid' });
    expect(checkNewName(LIST, ' ( ) ')).toEqual({ code: 'org_name_invalid' });
    expect(checkNewName(LIST, 'atlanta housing')).toEqual({ code: 'org_name_taken', entry: ATLANTA });
    expect(checkNewName(LIST, 'Step up')).toEqual({ code: 'org_name_taken', entry: STEP_UP });
    expect(checkNewName(LIST, 'DCA VASH')).toEqual({ code: 'org_name_compound', spans: [[DCA], [VASH]] });
  });
  it('a rename may take one of the entry\'s own spellings', () => {
    expect(checkNewName(LIST, 'Atlanta Housing', { excludeOrgId: ATLANTA.orgId })).toBeNull();
  });
});

describe('checkSpelling (D12)', () => {
  it('accepts a fresh spelling', () => {
    expect(checkSpelling(LIST, DCA, 'GA Dept of Community Affairs')).toBeNull();
  });
  it('names every problem', () => {
    expect(checkSpelling(LIST, DCA, ' ')).toEqual({ problem: 'empty' });
    expect(checkSpelling(LIST, DCA, ' - ')).toEqual({ problem: 'empty' }); // nothing left once normalized
    expect(checkSpelling(LIST, DCA, 'y'.repeat(121))).toEqual({ problem: 'too_long' });
    expect(checkSpelling(LIST, DCA, 'georgia dca')).toEqual({ problem: 'duplicate' });
    expect(checkSpelling(LIST, DCA, 'Step Up')).toEqual({ problem: 'equals_name', entries: [STEP_UP] });
    expect(checkSpelling(LIST, DCA, 'VASH')).toEqual({ problem: 'cross_kind', entries: [VASH] });
    expect(checkSpelling(LIST, DCA, 'Atlanta Housing VASH')).toEqual({ problem: 'compound' });
    expect(checkSpelling(LIST, DCA, 'AHA')).toEqual({ problem: 'shared_same_kind', entries: [ATLANTA, AUGUSTA] });
  });
  it('reports a full entry', () => {
    const full = entry({ kind: 'agency', name: 'Full', spellings: Array.from({ length: 20 }, (_, i) => `s${i}`) });
    expect(checkSpelling([...LIST, full], full, 'one more')).toEqual({ problem: 'too_many' });
  });
});
