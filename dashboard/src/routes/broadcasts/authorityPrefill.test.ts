// authorityPrefill tests - matching-blast-rules D3: a property's accepted
// housing authorities mapped to organization-list names the way the server
// maps a filter member (its exact name, the name written differently, or a
// spelling exactly one entry carries), in the property's order,
// de-duplicated; everything else is "unused".
import { describe, expect, it } from 'vitest';
import type { OrgEntry, OrgKind } from '../../api/index.js';
import type { OrgListView } from '../orgs/orgCopy.js';
import { prefillAuthorities } from './authorityPrefill.js';

function entry(orgId: string, kind: OrgKind, name: string, spellings: string[]): OrgEntry {
  return {
    orgId,
    kind,
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}
const ATLANTA = entry('o-atl', 'housing_authority', 'Atlanta Housing Authority', ['AHA', 'Atlanta Housing']);
const AUGUSTA = entry('o-aug', 'housing_authority', 'Augusta Housing Authority', ['AHA']);
const DEKALB = entry('o-dek', 'housing_authority', 'DeKalb County Housing Authority', ['HADC']);
const HOPE = entry('o-hope', 'agency', 'Hope Atlanta', ['HOPE']);
const LIST: OrgListView = { entries: [ATLANTA, AUGUSTA, DEKALB, HOPE], loading: false, error: false };

describe('prefillAuthorities (matching-blast-rules D3)', () => {
  it('keeps an exact list name', () => {
    expect(prefillAuthorities(['DeKalb County Housing Authority'], LIST)).toEqual({
      names: ['DeKalb County Housing Authority'],
      unused: [],
    });
  });

  it('maps a spelling exactly one entry carries, and a name written differently, to the entry name', () => {
    expect(prefillAuthorities(['HADC', 'atlanta housing authority'], LIST)).toEqual({
      names: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      unused: [],
    });
  });

  it('leaves out a shared spelling, an unknown name and an agency - as unused, in the property order', () => {
    expect(prefillAuthorities(['AHA', 'Nowhere Board', 'Hope Atlanta'], LIST)).toEqual({
      names: [],
      unused: ['AHA', 'Nowhere Board', 'Hope Atlanta'],
    });
  });

  it('keeps the property order and drops duplicates and blanks', () => {
    expect(
      prefillAuthorities(
        ['HADC', 'Atlanta Housing Authority', 'DeKalb County Housing Authority', 'Nowhere', ' Nowhere ', '  '],
        LIST,
      ),
    ).toEqual({
      names: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      unused: ['Nowhere'],
    });
  });

  it('maps nothing while the list is unknown - still loading, or failed with nothing in hand', () => {
    expect(prefillAuthorities(['DeKalb County Housing Authority'], { entries: [], loading: true, error: false })).toEqual({
      names: [],
      unused: [],
    });
    expect(prefillAuthorities(['DeKalb County Housing Authority'], { entries: [], loading: false, error: true })).toEqual({
      names: [],
      unused: [],
    });
  });

  it('a property with no accepted authorities prefills nothing', () => {
    expect(prefillAuthorities([], LIST)).toEqual({ names: [], unused: [] });
  });
});
