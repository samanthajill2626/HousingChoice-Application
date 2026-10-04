// unitListFacets - the pure engine behind the Properties list's filters and its
// by-housing-authority summary (docs/superpowers/specs/
// 2026-10-01-properties-available-view-design.md). Written test-first: these
// assertions are the module's specification.
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import { NONE_KEY } from '../contacts/tenantFacets.js';
import {
  applyUnitListFilters,
  applyUnitListSelection,
  authorityOptions,
  buildAuthoritySummary,
  countSelection,
  defaultStatus,
  isDefaultSelection,
  matchesAuthority,
  matchesVoucher,
  parseUnitListSelection,
  pruneSelection,
  unitAuthorityKeys,
  unitVoucherBuckets,
  type UnitListSelection,
} from './unitListFacets.js';

let seq = 0;
/** A unit fixture with a stable id and a run-unique address line. */
const u = (over: Partial<UnitItem>): UnitItem =>
  ({
    unitId: `u${++seq}`,
    landlordId: 'l1',
    status: 'available',
    address: { line1: `${seq} Fixture St` },
    ...over,
  }) as UnitItem;

const sel = (over: Partial<UnitListSelection> = {}): UnitListSelection => ({
  status: 'available',
  ha: new Set<string>(),
  voucher: new Set<string>(),
  q: '',
  ...over,
});

describe('defaultStatus', () => {
  it('opens the Active tab on Available and the Deleted tab on every status', () => {
    expect(defaultStatus('active')).toBe('available');
    expect(defaultStatus('deleted')).toBe('all');
  });
});

describe('parseUnitListSelection', () => {
  it('an empty query reads as the view default with no facets', () => {
    const active = parseUnitListSelection(new URLSearchParams(''), 'active');
    expect(active.status).toBe('available');
    expect([...active.ha]).toEqual([]);
    expect([...active.voucher]).toEqual([]);
    expect(active.q).toBe('');
    expect(parseUnitListSelection(new URLSearchParams(''), 'deleted').status).toBe('all');
  });
  it('reads every status value and all; an unknown status falls back to the default', () => {
    expect(parseUnitListSelection(new URLSearchParams('status=setup'), 'active').status).toBe('setup');
    expect(parseUnitListSelection(new URLSearchParams('status=all'), 'active').status).toBe('all');
    expect(parseUnitListSelection(new URLSearchParams('status=bogus'), 'active').status).toBe('available');
    expect(parseUnitListSelection(new URLSearchParams('status=bogus'), 'deleted').status).toBe('all');
  });
  it('reads repeated facets; unknown voucher values drop one by one; empty values are ignored', () => {
    const parsed = parseUnitListSelection(
      new URLSearchParams('voucher=2&voucher=7&voucher=4plus&voucher=__none__&ha=dca&ha=&ha=atlanta+housing'),
      'active',
    );
    expect([...parsed.voucher]).toEqual(['2', '4plus', NONE_KEY]);
    expect([...parsed.ha]).toEqual(['dca', 'atlanta housing']);
  });
  it('reads the raw search text', () => {
    expect(parseUnitListSelection(new URLSearchParams('q=peach+tree'), 'active').q).toBe('peach tree');
  });
});

describe('applyUnitListSelection', () => {
  it('omits the view default and every empty facet', () => {
    const params = new URLSearchParams();
    applyUnitListSelection(params, sel(), 'active');
    expect(params.toString()).toBe('');
    applyUnitListSelection(params, sel({ status: 'all' }), 'deleted');
    expect(params.toString()).toBe('');
  });
  it('writes a non-default status, repeated facets, and the search; leaves other params alone', () => {
    const params = new URLSearchParams('keep=1&status=occupied&ha=old');
    applyUnitListSelection(
      params,
      sel({ status: 'setup', voucher: new Set(['2', '3']), ha: new Set(['dca']), q: 'oak' }),
      'active',
    );
    expect(params.get('keep')).toBe('1');
    expect(params.get('status')).toBe('setup');
    expect(params.getAll('voucher')).toEqual(['2', '3']);
    expect(params.getAll('ha')).toEqual(['dca']);
    expect(params.get('q')).toBe('oak');
  });
  it('round-trips through parse', () => {
    const original = sel({ status: 'all', voucher: new Set(['0', NONE_KEY]), ha: new Set(['a b']), q: 'x y' });
    const params = new URLSearchParams();
    applyUnitListSelection(params, original, 'active');
    const back = parseUnitListSelection(params, 'active');
    expect(back.status).toBe('all');
    expect([...back.voucher]).toEqual(['0', NONE_KEY]);
    expect([...back.ha]).toEqual(['a b']);
    expect(back.q).toBe('x y');
  });
  it('writes Available explicitly on the Deleted tab (not its default there)', () => {
    const params = new URLSearchParams();
    applyUnitListSelection(params, sel({ status: 'available' }), 'deleted');
    expect(params.get('status')).toBe('available');
  });
});

describe('unitAuthorityKeys', () => {
  it('lists each DISTINCT non-empty normalized key once, legacy jurisdiction included', () => {
    expect(unitAuthorityKeys(u({ accepted_authorities: ['DCA', 'dca', ' DCA ', 'Atlanta (AHA)'] }))).toEqual([
      'dca',
      'atlanta (aha)',
    ]);
    expect(unitAuthorityKeys(u({ jurisdiction: 'atlanta_housing' }))).toEqual(['atlanta housing']);
    expect(unitAuthorityKeys(u({ accepted_authorities: ['  '] }))).toEqual([]);
    expect(unitAuthorityKeys(u({}))).toEqual([]);
  });
});

describe('authorityOptions', () => {
  it('one option per key, labelled with the most frequent STORED spelling, sorted by key', () => {
    const { options, hasUnrecorded } = authorityOptions([
      u({ accepted_authorities: ['DCA'] }),
      u({ accepted_authorities: ['dca'] }),
      u({ accepted_authorities: ['DCA', 'atlanta_housing'] }),
    ]);
    expect(options).toEqual([
      { key: 'atlanta housing', label: 'atlanta_housing' },
      { key: 'dca', label: 'DCA' },
    ]);
    expect(hasUnrecorded).toBe(false);
  });
  it('flags a unit with no authority (absent, empty list, or whitespace only)', () => {
    expect(authorityOptions([u({ accepted_authorities: ['DCA'] }), u({})]).hasUnrecorded).toBe(true);
    expect(authorityOptions([u({ accepted_authorities: [] })]).hasUnrecorded).toBe(true);
    expect(authorityOptions([u({ accepted_authorities: [' '] })]).hasUnrecorded).toBe(true);
  });
});

describe('pruneSelection', () => {
  const authority = authorityOptions([u({ accepted_authorities: ['DCA'] })]);
  it('drops an authority key no chip shows (a stale link, or a view whose units lack it)', () => {
    const pruned = pruneSelection(sel({ ha: new Set(['dca', 'gone']) }), authority);
    expect([...pruned.ha]).toEqual(['dca']);
  });
  it('keeps Not recorded only while some unit has no authority', () => {
    expect([...pruneSelection(sel({ ha: new Set([NONE_KEY]) }), authority).ha]).toEqual([]);
    const withUnrecorded = authorityOptions([u({ accepted_authorities: ['DCA'] }), u({})]);
    expect([...pruneSelection(sel({ ha: new Set([NONE_KEY]) }), withUnrecorded).ha]).toEqual([NONE_KEY]);
  });
  it('leaves status, voucher and search untouched', () => {
    const pruned = pruneSelection(sel({ status: 'setup', voucher: new Set(['2']), q: 'oak' }), authority);
    expect(pruned.status).toBe('setup');
    expect([...pruned.voucher]).toEqual(['2']);
    expect(pruned.q).toBe('oak');
  });
});

describe('unitVoucherBuckets / matchesVoucher', () => {
  it('a single number and a list both bucket; 5 is 4+', () => {
    expect([...unitVoucherBuckets(u({ voucher_size_accepted: 2 }))]).toEqual(['2']);
    expect([...unitVoucherBuckets(u({ voucher_size_accepted: [2, 3] as unknown as number }))]).toEqual(['2', '3']);
    expect([...unitVoucherBuckets(u({ voucher_size_accepted: 5 }))]).toEqual(['4plus']);
    expect([...unitVoucherBuckets(u({}))]).toEqual([]);
  });
  it('a list matches ANY of its sizes and nothing else', () => {
    const both = u({ voucher_size_accepted: [2, 3] as unknown as number });
    expect(matchesVoucher(both, new Set(['2']))).toBe(true);
    expect(matchesVoucher(both, new Set(['3']))).toBe(true);
    expect(matchesVoucher(both, new Set(['4plus']))).toBe(false);
    expect(matchesVoucher(both, new Set([NONE_KEY]))).toBe(false);
  });
  it('Not recorded matches only a unit with no usable size; an empty selection matches all', () => {
    expect(matchesVoucher(u({}), new Set([NONE_KEY]))).toBe(true);
    expect(matchesVoucher(u({ voucher_size_accepted: Number.NaN }), new Set([NONE_KEY]))).toBe(true);
    expect(matchesVoucher(u({}), new Set(['2']))).toBe(false);
    expect(matchesVoucher(u({}), new Set<string>())).toBe(true);
  });
  it('never falls back to beds', () => {
    expect(matchesVoucher(u({ beds: 2 }), new Set(['2']))).toBe(false);
    expect(matchesVoucher(u({ beds: 2 }), new Set([NONE_KEY]))).toBe(true);
  });
});

describe('matchesAuthority', () => {
  it('matches when ANY accepted authority is selected; Not recorded matches only an unrecorded unit', () => {
    const multi = u({ accepted_authorities: ['DCA', 'Atlanta (AHA)'] });
    expect(matchesAuthority(multi, new Set(['atlanta (aha)']))).toBe(true);
    expect(matchesAuthority(multi, new Set(['fulton county']))).toBe(false);
    expect(matchesAuthority(multi, new Set([NONE_KEY]))).toBe(false);
    expect(matchesAuthority(u({}), new Set([NONE_KEY]))).toBe(true);
    expect(matchesAuthority(u({}), new Set<string>())).toBe(true);
  });
});

describe('applyUnitListFilters', () => {
  const avail2 = u({ status: 'available', voucher_size_accepted: 2, accepted_authorities: ['DCA'], address: { line1: '1 Oak Ave' } });
  const avail3 = u({ status: 'available', voucher_size_accepted: 3, accepted_authorities: ['DCA'], address: { line1: '2 Elm St' } });
  const setup2 = u({ status: 'setup', voucher_size_accepted: 2, accepted_authorities: ['Fulton'], address: { line1: '3 Oak Ct' } });
  const units = [avail2, avail3, setup2];
  it('ANDs status, voucher, authority and search', () => {
    expect(applyUnitListFilters(units, sel())).toEqual([avail2, avail3]);
    expect(applyUnitListFilters(units, sel({ status: 'all', voucher: new Set(['2']) }))).toEqual([avail2, setup2]);
    expect(applyUnitListFilters(units, sel({ status: 'all', ha: new Set(['fulton']) }))).toEqual([setup2]);
    expect(applyUnitListFilters(units, sel({ status: 'all', q: '  OAK ' }))).toEqual([avail2, setup2]);
    expect(applyUnitListFilters(units, sel({ status: 'setup', ha: new Set(['dca']) }))).toEqual([]);
  });
});

describe('buildAuthoritySummary', () => {
  const units = [
    u({ status: 'available', accepted_authorities: ['DCA'], voucher_size_accepted: 2 }),
    u({ status: 'available', accepted_authorities: ['DCA', 'Atlanta (AHA)'], voucher_size_accepted: 3 }),
    u({ status: 'setup', accepted_authorities: ['dca'], voucher_size_accepted: 2 }),
    u({ status: 'setup', accepted_authorities: [] }),
    u({ status: 'occupied', accepted_authorities: ['Fulton County'] }),
    u({ status: 'available', accepted_authorities: ['DCA', 'dca'] }),
  ];
  const authority = authorityOptions(units);

  it('counts each property ONCE in All and under EVERY authority it accepts', () => {
    const summary = buildAuthoritySummary(units, new Set<string>(), authority);
    expect(summary.all).toEqual({ available: 3, comingSoon: 2 });
    expect(summary.rows).toEqual([
      { key: 'atlanta (aha)', label: 'Atlanta (AHA)', available: 1, comingSoon: 0 },
      // Two spellings of DCA on one unit count that unit once.
      { key: 'dca', label: 'DCA', available: 3, comingSoon: 1 },
      { key: NONE_KEY, label: 'No authority recorded', available: 0, comingSoon: 1 },
    ]);
  });
  it('hides an authority whose Available and Coming soon counts are both zero', () => {
    const keys = buildAuthoritySummary(units, new Set<string>(), authority).rows.map((r) => r.key);
    expect(keys).not.toContain('fulton county');
  });
  it('follows the voucher selection only', () => {
    const summary = buildAuthoritySummary(units, new Set(['2']), authority);
    expect(summary.all).toEqual({ available: 1, comingSoon: 1 });
    expect(summary.rows).toEqual([{ key: 'dca', label: 'DCA', available: 1, comingSoon: 1 }]);
  });
  it('counts the available/coming-soon units a size filter left out for recording no size', () => {
    // 2-BR: the setup unit with no authority and the available DCA unit with no
    // size are unrecorded; the 3-BR unit is left out too, but it RECORDS a size;
    // the occupied unit is outside the summary altogether.
    expect(buildAuthoritySummary(units, new Set(['2']), authority).unrecordedExcluded).toBe(2);
  });
  it('excludes nothing unrecorded with no voucher filter, or with Not recorded selected', () => {
    expect(buildAuthoritySummary(units, new Set<string>(), authority).unrecordedExcluded).toBe(0);
    const withNone = buildAuthoritySummary(units, new Set(['2', NONE_KEY]), authority);
    expect(withNone.unrecordedExcluded).toBe(0);
    expect(withNone.all).toEqual({ available: 2, comingSoon: 2 });
  });
  it('an empty world yields a zero All row and no authority rows', () => {
    const summary = buildAuthoritySummary([], new Set<string>(), authorityOptions([]));
    expect(summary).toEqual({ all: { available: 0, comingSoon: 0 }, rows: [], unrecordedExcluded: 0 });
  });
});

describe('isDefaultSelection', () => {
  it('is true only for the bare view default', () => {
    expect(isDefaultSelection(sel(), 'active')).toBe(true);
    expect(isDefaultSelection(sel({ status: 'all' }), 'deleted')).toBe(true);
    expect(isDefaultSelection(sel({ q: '   ' }), 'active')).toBe(true);
  });
  it('is false once anything else constrains the list', () => {
    expect(isDefaultSelection(sel({ status: 'all' }), 'active')).toBe(false);
    expect(isDefaultSelection(sel({ status: 'available' }), 'deleted')).toBe(false);
    expect(isDefaultSelection(sel({ ha: new Set(['dca']) }), 'active')).toBe(false);
    expect(isDefaultSelection(sel({ voucher: new Set(['2']) }), 'active')).toBe(false);
    expect(isDefaultSelection(sel({ q: 'oak' }), 'active')).toBe(false);
  });
});

describe('countSelection', () => {
  const current = sel({ status: 'all', ha: new Set(['a', 'b']), voucher: new Set(['2']), q: 'oak' });
  it('sets the column status and that one authority, keeps voucher, clears the search', () => {
    const next = countSelection(current, 'comingSoon', 'dca');
    expect(next.status).toBe('setup');
    expect([...next.ha]).toEqual(['dca']);
    expect([...next.voucher]).toEqual(['2']);
    expect(next.q).toBe('');
  });
  it('the All row clears the authority filter; the no-authority row selects Not recorded', () => {
    expect([...countSelection(current, 'available', null).ha]).toEqual([]);
    expect(countSelection(current, 'available', null).status).toBe('available');
    expect([...countSelection(current, 'available', NONE_KEY).ha]).toEqual([NONE_KEY]);
  });
});
