// orgSelection tests - the URL scheme of Settings > Housing authorities &
// agencies (design review 2026-10-07 Option B) and its search matching.
import { describe, expect, it } from 'vitest';
import type { NotOnListRow, OrgEntry } from '../../api/index.js';
import {
  entryHref,
  entryMatches,
  listHref,
  readOrgLocation,
  selectionKey,
  valueHref,
  valueMatches,
} from './orgSelection.js';

const params = (query: string): URLSearchParams => new URLSearchParams(query);

describe('readOrgLocation', () => {
  it('reads a contact organization value (caseworkers spec D17): its field is a record field too', () => {
    expect(readOrgLocation(undefined, params('view=not-on-list&field=organization&value=Kite+Ade')).selection).toEqual({
      type: 'value',
      field: 'organization',
      value: 'Kite Ade',
    });
    const url = new URL(valueHref('organization', 'Kite Ade'), 'http://x');
    expect(readOrgLocation(undefined, url.searchParams).selection).toEqual({
      type: 'value',
      field: 'organization',
      value: 'Kite Ade',
    });
  });
  it('reads the view, defaulting to Housing authorities', () => {
    expect(readOrgLocation(undefined, params(''))).toEqual({ view: 'housing-authorities', selection: null });
    expect(readOrgLocation(undefined, params('view=agencies'))).toEqual({ view: 'agencies', selection: null });
    expect(readOrgLocation(undefined, params('view=nonsense'))).toEqual({
      view: 'housing-authorities',
      selection: null,
    });
  });

  it('reads an entry from the path and a value from the query', () => {
    expect(readOrgLocation('o-atl', params('')).selection).toEqual({ type: 'entry', orgId: 'o-atl' });
    expect(readOrgLocation(undefined, params('view=not-on-list&field=agency&value=Step-Up')).selection).toEqual({
      type: 'value',
      field: 'agency',
      value: 'Step-Up',
    });
  });

  it('ignores a value outside "Not on the list" and a field that is not a record field', () => {
    expect(readOrgLocation(undefined, params('field=agency&value=x')).selection).toBeNull();
    expect(readOrgLocation(undefined, params('view=not-on-list&field=nope&value=x')).selection).toBeNull();
  });

  it('treats an empty value as no selection (code review r1 M4)', () => {
    expect(readOrgLocation(undefined, params('view=not-on-list&field=agency&value=')).selection).toBeNull();
    expect(readOrgLocation(undefined, params('view=not-on-list&field=agency&value=')).view).toBe('not-on-list');
    // A value of spaces is a real stored value (a placeholder), kept as is.
    expect(readOrgLocation(undefined, params('view=not-on-list&field=agency&value=+')).selection).toEqual({
      type: 'value',
      field: 'agency',
      value: ' ',
    });
  });

  it("keeps an entry link's view, so a gone agency stays on its list (r1 M3)", () => {
    expect(readOrgLocation('o-gone', params('view=agencies'))).toEqual({
      view: 'agencies',
      selection: { type: 'entry', orgId: 'o-gone' },
    });
  });
});

describe('the hrefs', () => {
  it('leave the default view out', () => {
    expect(listHref('housing-authorities')).toBe('/settings/organizations');
    expect(listHref('not-on-list')).toBe('/settings/organizations?view=not-on-list');
  });

  it('escape an id in the path', () => {
    expect(entryHref('a/b')).toBe('/settings/organizations/a%2Fb');
  });

  it("carry an agency's list in its link; a housing authority's link stays bare (r1 M3)", () => {
    expect(entryHref('o-step', 'agency')).toBe('/settings/organizations/o-step?view=agencies');
    expect(entryHref('o-atl', 'housing_authority')).toBe('/settings/organizations/o-atl');
  });

  it('carry any value text through the query and read it back unchanged', () => {
    for (const value of ['Atlanta, aha, Atlanta housing', 'A&B / C?', ' - ', '100% Aid#1']) {
      const href = valueHref('housingAuthority', value);
      const url = new URL(href, 'http://x');
      expect(url.pathname).toBe('/settings/organizations');
      expect(readOrgLocation(undefined, url.searchParams).selection).toEqual({
        type: 'value',
        field: 'housingAuthority',
        value,
      });
    }
  });

  it('give an entry and a value distinct keys', () => {
    expect(selectionKey({ type: 'entry', orgId: 'x' })).not.toBe(
      selectionKey({ type: 'value', field: 'agency', value: 'x' }),
    );
    expect(selectionKey(null)).toBeNull();
  });
});

describe('the search', () => {
  const atlanta = {
    orgId: 'o-atl',
    kind: 'housing_authority',
    name: 'Atlanta Housing Authority',
    spellings: ['AHA', 'Atlanta, aha, Atlanta housing'],
  } as OrgEntry;

  it('matches a name or a spelling, ignoring case and punctuation', () => {
    expect(entryMatches(atlanta, '')).toBe(true);
    expect(entryMatches(atlanta, 'housing auth')).toBe(true);
    expect(entryMatches(atlanta, 'ATLANTA-HOUSING')).toBe(true);
    expect(entryMatches(atlanta, 'aha, atlanta')).toBe(true);
    expect(entryMatches(atlanta, 'dekalb')).toBe(false);
  });

  it('matches a value by its text; a punctuation-only query matches it as typed', () => {
    const row = (value: string): NotOnListRow =>
      ({ field: 'housingAuthority', value, count: 1, deletedCount: 0, resolution: { status: 'unknown' } }) as NotOnListRow;
    expect(valueMatches(row('Fulton Cnty Housing'), 'cnty')).toBe(true);
    expect(valueMatches(row('-'), '-')).toBe(true);
    expect(valueMatches(row('AHA'), '-')).toBe(false);
  });
});
