// tenantFacets - the pure facet engine behind the Tenants list controls (spec
// sections 5/6/10). Written test-first: these assertions ARE the module's
// specification, and slices 5/7 consume the exported names verbatim.
import { describe, expect, it } from 'vitest';
import { TENANT_STATUSES, TENANT_STATUS_LABELS, type Contact, type TenantStatus } from '../../api/index.js';
import { voucherSizeLabel } from '../broadcasts/broadcastFormat.js';
import {
  ALL_STATUS_SET,
  applySelection,
  applySortToParams,
  applyToParams,
  buildFacets,
  DEFAULT_STATUS_SET,
  factsLine,
  hiddenByStatusOnly,
  NONE_KEY,
  normalizeAuthorityKey,
  parseSelection,
  parseSort,
  STATUS_EMPTY_KEY,
  voucherBucketOf,
  voucherBucketOfSize,
  VOUCHER_BUCKETS,
  type TenantSelection,
} from './tenantFacets.js';

// The row separator is U+00B7. ONE construction form, in the module AND here:
// String.fromCharCode(0xB7) - never a literal middot character, never an HTML
// entity (an entity inside a JS string renders literally as text). Keeps every
// line ASCII, the same convention e2e/support/selectors.md records for the
// em dash.
const SEP = ' ' + String.fromCharCode(0xB7) + ' ';

let seq = 0;
/** A tenant fixture with a stable id (identity comparisons stay readable). */
const t = (over: Partial<Contact>): Contact =>
  ({ contactId: `c${++seq}`, type: 'tenant', ...over }) as Contact;
const all = (): boolean => true;
const ALL_SEVEN = (): Set<TenantStatus> => new Set<TenantStatus>(TENANT_STATUSES);
const emptySel = (): TenantSelection => ({
  voucher: new Set<string>(),
  ha: new Set<string>(),
  porting: false,
  status: ALL_SEVEN(),
});

describe('VOUCHER_BUCKETS', () => {
  it('is the FIXED five, labelled by voucherSizeLabel (the strings are never restated)', () => {
    expect(VOUCHER_BUCKETS.map((b) => b.key)).toEqual(['0', '1', '2', '3', '4plus']);
    expect(VOUCHER_BUCKETS.map((b) => b.label)).toEqual([0, 1, 2, 3, 4].map(voucherSizeLabel));
  });
});

describe('voucherBucketOf', () => {
  it('pins Studio=0 via typeof, never truthiness', () => {
    expect(voucherBucketOf(t({ voucherSize: 0 }))).toBe('0');
  });
  it('maps 1..3 to their own bucket', () => {
    expect(voucherBucketOf(t({ voucherSize: 1 }))).toBe('1');
    expect(voucherBucketOf(t({ voucherSize: 2 }))).toBe('2');
    expect(voucherBucketOf(t({ voucherSize: 3 }))).toBe('3');
  });
  it('caps 4 and above at 4plus via the explicit table', () => {
    expect(voucherBucketOf(t({ voucherSize: 4 }))).toBe('4plus');
    expect(voucherBucketOf(t({ voucherSize: 6 }))).toBe('4plus');
  });
  it('null when absent', () => {
    expect(voucherBucketOf(t({}))).toBeNull();
  });
});

describe('voucherBucketOfSize', () => {
  // The ONE size-to-bucket rule. The Tenants facet (voucherBucketOf) and the
  // Properties list's voucher filter both read through it, so a 4+ BR tenant and
  // a 4+ BR property can never land in different buckets.
  it('buckets whole sizes, truncating fractions', () => {
    expect(voucherBucketOfSize(0)).toBe('0');
    expect(voucherBucketOfSize(2)).toBe('2');
    expect(voucherBucketOfSize(2.7)).toBe('2');
    expect(voucherBucketOfSize(3)).toBe('3');
  });
  it('caps 4 and above (and Infinity) at 4plus; a negative reads as Studio', () => {
    expect(voucherBucketOfSize(4)).toBe('4plus');
    expect(voucherBucketOfSize(9)).toBe('4plus');
    expect(voucherBucketOfSize(Number.POSITIVE_INFINITY)).toBe('4plus');
    expect(voucherBucketOfSize(-1)).toBe('0');
  });
  it('null for anything that is not a number, and for NaN', () => {
    expect(voucherBucketOfSize(Number.NaN)).toBeNull();
    expect(voucherBucketOfSize('2')).toBeNull();
    expect(voucherBucketOfSize(undefined)).toBeNull();
    expect(voucherBucketOfSize(null)).toBeNull();
  });
});

describe('normalizeAuthorityKey', () => {
  // The pure function's contract. It earns its keep on INTERIOR whitespace,
  // case, and underscore/slug folding, plus legacy stored rows (adjudication
  // A5); the trailing-space case pins the function, not a reachable state.
  it('folds case, whitespace, underscores', () => {
    for (const raw of ['atlanta_housing', 'Atlanta_Housing', 'Atlanta  Housing', ' Atlanta Housing ']) {
      expect(normalizeAuthorityKey(raw)).toBe('atlanta housing');
    }
  });
});

describe('buildFacets', () => {
  it('merges spelling variants into one option, displays most frequent, sums counts', () => {
    const m = buildFacets(
      [
        t({ housingAuthority: 'Atlanta (AHA)' }),
        t({ housingAuthority: 'Atlanta (AHA)' }),
        t({ housingAuthority: 'atlanta (aha) ' }),
      ],
      emptySel(),
      all,
    );
    const opt = m.authority.find((o) => o.key === 'atlanta (aha)')!;
    expect(opt.label).toBe('Atlanta (AHA)');
    expect(opt.count).toBe(3);
  });
  it('displays the MAJORITY spelling even when it does NOT sort first', () => {
    // The fixture above cannot tell "most frequent" from "sorted-first": its
    // majority spelling is ALSO the ASCII-first one. This one can. Sort order is
    // ['DEKALB  County Housing', 'DeKalb County Housing', 'dekalb_county_housing']
    // ('E'=69 < 'e'=101, then 'D'=68 < 'd'=100), so the count-2 spelling sits in
    // the MIDDLE and each degradation of displaySpelling yields a DIFFERENT
    // string: sorted-first gives the shouted variant, sorted-last the slug, and
    // folding to the key gives 'dekalb county housing'. Doubles as the
    // slug-plus-prose option-merge pin, and mirrors the fixture family the
    // properties list uses for this same exported helper
    // (routes/listings/ListingsList.test.tsx).
    const m = buildFacets(
      [
        t({ housingAuthority: 'DeKalb County Housing' }),
        t({ housingAuthority: 'DeKalb County Housing' }),
        t({ housingAuthority: 'DEKALB  County Housing' }),
        t({ housingAuthority: 'dekalb_county_housing' }),
      ],
      emptySel(),
      all,
    );
    expect(m.authority.map((o) => o.key)).toEqual(['dekalb county housing', NONE_KEY]);
    const opt = m.authority.find((o) => o.key === 'dekalb county housing')!;
    expect(opt.label).toBe('DeKalb County Housing');
    expect(opt.count).toBe(4);
  });
  it('breaks a display-spelling tie deterministically by sort order', () => {
    const m = buildFacets(
      [t({ housingAuthority: 'DCA' }), t({ housingAuthority: 'dca' })],
      emptySel(),
      all,
    );
    expect(m.authority.find((o) => o.key === 'dca')!.label).toBe('DCA');
  });
  it('counts reflect the OTHER facet but not their own', () => {
    const tenants = [
      t({ voucherSize: 2, housingAuthority: 'DCA' }),
      t({ voucherSize: 3, housingAuthority: 'DCA' }),
      t({ voucherSize: 2, housingAuthority: 'Fulton County' }),
    ];
    const sel = { voucher: new Set(['2']), ha: new Set<string>(), porting: false, status: ALL_SEVEN() };
    const m = buildFacets(tenants, sel, all);
    expect(m.authority.find((o) => o.key === 'dca')!.count).toBe(1); // narrowed by voucher
    expect(m.voucher.find((o) => o.key === '2')!.count).toBe(2); // NOT narrowed by itself
    // The UNSELECTED bucket is the assertion that actually catches an own-facet
    // leak: a chip's number must state what clicking it does, so 3-BR still
    // reads 1 while 2-BR is the active selection.
    expect(m.voucher.find((o) => o.key === '3')!.count).toBe(1);
  });
  it('counts reflect the search query', () => {
    const keep = t({ firstName: 'Tasha', voucherSize: 2, housingAuthority: 'DCA' });
    const drop = t({ firstName: 'Other', voucherSize: 2, housingAuthority: 'DCA' });
    const m = buildFacets([keep, drop], emptySel(), (c) => c.firstName === 'Tasha');
    expect(m.voucher.find((o) => o.key === '2')!.count).toBe(1);
    expect(m.authority.find((o) => o.key === 'dca')!.count).toBe(1);
  });
  it('counts reflect porting; portingCount reflects the value facets but not itself', () => {
    const a = t({ porting: true, voucherSize: 2, housingAuthority: 'DCA' });
    const b = t({ porting: false, voucherSize: 2, housingAuthority: 'DCA' });
    const c = t({ porting: true, voucherSize: 3, housingAuthority: 'DCA' });
    const m = buildFacets([a, b, c], { voucher: new Set(['2']), ha: new Set<string>(), porting: true, status: ALL_SEVEN() }, all);
    expect(m.voucher.find((o) => o.key === '2')!.count).toBe(1); // porting narrows, its own selection does not
    expect(m.voucher.find((o) => o.key === '3')!.count).toBe(1);
    expect(m.authority.find((o) => o.key === 'dca')!.count).toBe(1); // voucher + porting
    expect(m.portingCount).toBe(1); // voucher only - never its own toggle
  });
  it('Not recorded buckets count the absent', () => {
    const m = buildFacets([t({}), t({ voucherSize: 1, housingAuthority: 'DCA' })], emptySel(), all);
    expect(m.voucher.find((o) => o.key === NONE_KEY)!.count).toBe(1);
    expect(m.authority.find((o) => o.key === NONE_KEY)!.count).toBe(1);
  });
  it('Not recorded is ALWAYS present and last in both value facets, even at zero count', () => {
    const m = buildFacets([t({ voucherSize: 2, housingAuthority: 'DCA' })], emptySel(), all);
    expect(m.voucher.at(-1)!.key).toBe(NONE_KEY);
    expect(m.authority.at(-1)!.key).toBe(NONE_KEY);
    expect(m.voucher.at(-1)!.label).toBe('Not recorded');
    expect(m.authority.at(-1)!.label).toBe('Not recorded');
    expect(m.voucher.find((o) => o.key === NONE_KEY)!.count).toBe(0);
    expect(m.authority.find((o) => o.key === NONE_KEY)!.count).toBe(0);
  });
  it('a Studio tenant counts under Studio, never Not recorded (the falsy-zero trap)', () => {
    const m = buildFacets([t({ voucherSize: 0 })], emptySel(), all);
    expect(m.voucher.find((o) => o.key === '0')!.count).toBe(1);
    expect(m.voucher.find((o) => o.key === NONE_KEY)!.count).toBe(0);
    expect(m.voucherEmpty).toBe(false);
  });
  it('porting shows only when some tenant is === true', () => {
    expect(buildFacets([t({ porting: false })], emptySel(), all).showPorting).toBe(false);
    expect(buildFacets([t({ porting: true })], emptySel(), all).showPorting).toBe(true);
  });
  it('authorityEmpty when zero recorded', () => {
    expect(buildFacets([t({})], emptySel(), all).authorityEmpty).toBe(true);
  });
  it('an empty or whitespace-only authority is NOT recorded', () => {
    const m = buildFacets(
      [t({ housingAuthority: '' }), t({ housingAuthority: '   ' })],
      emptySel(),
      all,
    );
    expect(m.authorityEmpty).toBe(true);
    expect(m.authority.map((o) => o.key)).toEqual([NONE_KEY]);
    expect(m.authority.find((o) => o.key === NONE_KEY)!.count).toBe(2);
  });
  it('keeps the fixed five voucher chips when nothing is recorded, and flags both facets empty', () => {
    const m = buildFacets([t({}), t({ porting: true })], emptySel(), all);
    expect(m.voucher.map((o) => o.key)).toEqual(['0', '1', '2', '3', '4plus', NONE_KEY]);
    expect(m.voucherEmpty).toBe(true);
    expect(m.authorityEmpty).toBe(true);
    expect(m.voucher.find((o) => o.key === NONE_KEY)!.count).toBe(2);
  });
});

describe('applySelection', () => {
  it('OR within a facet, AND across, none-key matches the unrecorded', () => {
    const a = t({ voucherSize: 2, housingAuthority: 'DCA' });
    const b = t({ voucherSize: 3, housingAuthority: 'DCA' });
    const c = t({ voucherSize: 2 });
    expect(
      applySelection([a, b, c], { voucher: new Set(['2', '3']), ha: new Set(['dca']), porting: false, status: ALL_SEVEN() }),
    ).toEqual([a, b]);
    expect(
      applySelection([a, c], { voucher: new Set<string>(), ha: new Set([NONE_KEY]), porting: false, status: ALL_SEVEN() }),
    ).toEqual([c]);
  });
  it('an empty selection is unconstrained', () => {
    const rows = [t({}), t({ voucherSize: 2, housingAuthority: 'DCA' })];
    expect(applySelection(rows, emptySel())).toEqual(rows);
  });
  it('ORs a value bucket together with Not recorded', () => {
    const a = t({ voucherSize: 2 });
    const b = t({});
    expect(
      applySelection([a, b], { voucher: new Set(['2', NONE_KEY]), ha: new Set<string>(), porting: false, status: ALL_SEVEN() }),
    ).toEqual([a, b]);
  });
  it('matches an authority by NORMALIZED key across spelling variants', () => {
    const a = t({ housingAuthority: 'atlanta_housing' });
    const b = t({ housingAuthority: 'Atlanta Housing ' });
    const c = t({ housingAuthority: 'DCA' });
    expect(
      applySelection([a, b, c], { voucher: new Set<string>(), ha: new Set(['atlanta housing']), porting: false, status: ALL_SEVEN() }),
    ).toEqual([a, b]);
  });
  it('an unknown ha key matches nothing (a stale link never silently widens the list)', () => {
    const a = t({ housingAuthority: 'DCA' });
    expect(
      applySelection([a], { voucher: new Set<string>(), ha: new Set(['ghost authority']), porting: false, status: ALL_SEVEN() }),
    ).toEqual([]);
  });
});

describe('URL round-trip', () => {
  it('parses repeated params, drops unknown voucher keys, string-matches 0 and 4plus, porting presence-only', () => {
    const p = new URLSearchParams('voucher=0&voucher=4plus&voucher=9&ha=dca&porting=false&phone=%2B14045550100');
    const sel = parseSelection(p);
    expect([...sel.voucher].sort()).toEqual(['0', '4plus']);
    expect(sel.porting).toBe(false);
    applyToParams(p, sel);
    expect(p.has('phone')).toBe(true); // unrelated keys NEVER touched
    expect(p.getAll('voucher').sort()).toEqual(['0', '4plus']);
    expect(p.get('porting')).toBeNull(); // false -> absent
  });
  it('never accepts a String(min(size, 4)) writer output: "4" is not a bucket key', () => {
    // Widened to `string` on purpose: tsc rejects `b.key === '4'` outright
    // (TS2367 - no overlap with VoucherBucketKey), which is the type-level half
    // of this pin. The runtime half survives someone widening the union later.
    expect(VOUCHER_BUCKETS.map((b): string => b.key)).not.toContain('4');
    expect([...parseSelection(new URLSearchParams('voucher=4')).voucher]).toEqual([]);
    // The real writer emits '4plus', which survives the round trip - the reason
    // the bucket table is explicit in BOTH directions (spec section 10).
    const p = new URLSearchParams();
    applyToParams(p, {
      voucher: new Set([voucherBucketOf(t({ voucherSize: 4 }))!]),
      ha: new Set<string>(),
      porting: false,
      status: ALL_SEVEN(),
    });
    expect(p.getAll('voucher')).toEqual(['4plus']);
    expect([...parseSelection(p).voucher]).toEqual(['4plus']);
  });
  it('accepts the Not-recorded sentinel in both value facets', () => {
    const sel = parseSelection(new URLSearchParams(`voucher=${NONE_KEY}&ha=${NONE_KEY}`));
    expect([...sel.voucher]).toEqual([NONE_KEY]);
    expect([...sel.ha]).toEqual([NONE_KEY]);
  });
  it('reads porting by presence: 1 is on, false is absent, missing is off', () => {
    expect(parseSelection(new URLSearchParams('porting=1')).porting).toBe(true);
    expect(parseSelection(new URLSearchParams('porting=false')).porting).toBe(false);
    expect(parseSelection(new URLSearchParams()).porting).toBe(false);
  });
  it('writes repeated ha values verbatim - never comma-joined (a raw value can contain a comma)', () => {
    const p = new URLSearchParams();
    applyToParams(p, {
      voucher: new Set<string>(),
      ha: new Set(['dca, department of community affairs', 'fulton county']),
      porting: false,
      status: ALL_SEVEN(),
    });
    expect(p.getAll('ha')).toEqual(['dca, department of community affairs', 'fulton county']);
    expect([...parseSelection(p).ha]).toEqual(['dca, department of community affairs', 'fulton county']);
  });
  it('clears stale facet params when the selection empties, leaving unrelated keys alone', () => {
    const p = new URLSearchParams('voucher=2&ha=dca&porting=1&phone=%2B14045550100');
    applyToParams(p, emptySel());
    expect(p.getAll('voucher')).toEqual([]);
    expect(p.getAll('ha')).toEqual([]);
    expect(p.get('porting')).toBeNull();
    expect(p.get('phone')).toBe('+14045550100');
  });
});

describe('factsLine', () => {
  it('exact facts, middot join, collapses missing values', () => {
    expect(factsLine(t({ voucherSize: 6, housingAuthority: 'Dekalb County Housing' }))).toBe(
      '6 BR' + SEP + 'Dekalb County Housing',
    );
    expect(factsLine(t({ voucherSize: 0 }))).toBe('Studio');
    expect(factsLine(t({ housingAuthority: 'DCA' }))).toBe('DCA');
    expect(factsLine(t({}))).toBeNull();
  });
  it('renders the EXACT size, never the 4+ bucket label', () => {
    expect(factsLine(t({ voucherSize: 4 }))).toBe('4 BR');
  });
  it('renders the stored authority AS-IS, with no transformation', () => {
    expect(factsLine(t({ voucherSize: 2, housingAuthority: 'atlanta_housing' }))).toBe(
      '2 BR' + SEP + 'atlanta_housing',
    );
  });
});

describe('option-list stability (spec section 5: pinned by test)', () => {
  it('applying a selection never changes which authority options exist', () => {
    const tenants = [t({ housingAuthority: 'DCA' }), t({ housingAuthority: 'Fulton County', voucherSize: 2 })];
    const before = buildFacets(tenants, emptySel(), all).authority.map((o) => o.key);
    const after = buildFacets(tenants, { voucher: new Set(['2']), ha: new Set<string>(), porting: false, status: ALL_SEVEN() }, all)
      .authority.map((o) => o.key);
    expect(after).toEqual(before); // counts change; the option LIST does not
  });
  it('a search query narrows counts without removing options, and sorts by folded label', () => {
    const tenants = [
      t({ housingAuthority: 'Fulton County', firstName: 'Tasha' }),
      t({ housingAuthority: 'atlanta (aha)', firstName: 'Other' }),
      t({ housingAuthority: 'DCA', firstName: 'Other' }),
    ];
    const m = buildFacets(tenants, emptySel(), (c) => c.firstName === 'Tasha');
    expect(m.authority.map((o) => o.key)).toEqual(['atlanta (aha)', 'dca', 'fulton county', NONE_KEY]);
    expect(m.authority.find((o) => o.key === 'dca')!.count).toBe(0);
    expect(m.authority.find((o) => o.key === 'fulton county')!.count).toBe(1);
  });
});

describe('porting filter', () => {
  it('porting: true keeps only tenants with porting === true', () => {
    const on = t({ porting: true });
    const off = t({ porting: false });
    const absent = t({});
    expect(
      applySelection([on, off, absent], { voucher: new Set<string>(), ha: new Set<string>(), porting: true, status: ALL_SEVEN() }),
    ).toEqual([on]);
  });
});

describe('status facet (spec 2026-10-12 5.7, 14.5 F1/F9)', () => {
  const st = (status: string | undefined, over: Partial<Contact> = {}): Contact => t({ ...over, ...(status !== undefined && { status }) });
  const sel = (status: Iterable<TenantStatus>): TenantSelection => ({ ...emptySel(), status: new Set(status) });

  it('DEFAULT is every status except inactive and placed; ALL is the seven', () => {
    expect([...DEFAULT_STATUS_SET]).toEqual(['needs_review', 'onboarding', 'searching', 'placing', 'on_hold']);
    expect([...ALL_STATUS_SET]).toEqual([...TENANT_STATUSES]);
  });

  it('parses: absent and invalid-only -> default; _empty -> empty; values beat the sentinel', () => {
    expect([...parseSelection(new URLSearchParams()).status]).toEqual([...DEFAULT_STATUS_SET]);
    expect([...parseSelection(new URLSearchParams('status=bogus')).status]).toEqual([...DEFAULT_STATUS_SET]);
    expect([...parseSelection(new URLSearchParams(`status=${STATUS_EMPTY_KEY}`)).status]).toEqual([]);
    expect([...parseSelection(new URLSearchParams(`status=${STATUS_EMPTY_KEY}&status=inactive`)).status]).toEqual(['inactive']);
    expect([...parseSelection(new URLSearchParams('status=searching&status=bogus')).status]).toEqual(['searching']);
    expect([...parseSelection(new URLSearchParams('status=inactive&status=placed')).status].sort()).toEqual(['inactive', 'placed']);
  });

  it('writes only a NON-default selection: default -> no param, empty -> _empty, values in TENANT_STATUSES order', () => {
    const p = new URLSearchParams('phone=%2B14045550100&status=inactive');
    applyToParams(p, sel(DEFAULT_STATUS_SET));
    expect(p.getAll('status')).toEqual([]);
    expect(p.get('phone')).toBe('+14045550100');
    applyToParams(p, sel([]));
    expect(p.getAll('status')).toEqual([STATUS_EMPTY_KEY]);
    applyToParams(p, sel(['inactive', 'searching']));
    expect(p.getAll('status')).toEqual(['searching', 'inactive']);
  });

  it('round-trips default, empty, all and a custom selection', () => {
    for (const s of [[...DEFAULT_STATUS_SET], [], [...TENANT_STATUSES], ['on_hold', 'placed']] as TenantStatus[][]) {
      const p = new URLSearchParams();
      applyToParams(p, sel(s));
      expect([...parseSelection(p).status].sort()).toEqual([...s].sort());
    }
  });

  it('hides inactive and placed by default; NO status and an off-list status are never hidden (F1)', () => {
    const searching = st('searching');
    const inactive = st('inactive');
    const placed = st('placed');
    const none = st(undefined);
    const offList = st('active');
    expect(applySelection([searching, inactive, placed, none, offList], sel(DEFAULT_STATUS_SET))).toEqual([searching, none, offList]);
    // Even the EMPTY selection keeps them: the facet only ever hides a recorded tenant status.
    expect(applySelection([searching, none, offList], sel([]))).toEqual([none, offList]);
  });

  it('status chips: seven, TENANT_STATUSES order, StatusBadge labels, counts under the OTHER facets only', () => {
    const tenants = [
      st('searching', { voucherSize: 2 }),
      st('searching', { voucherSize: 3 }),
      st('inactive', { voucherSize: 2 }),
      st(undefined, { voucherSize: 2 }), // counts under no chip
      st('active', { voucherSize: 2 }), // off-list: counts under no chip
    ];
    const m = buildFacets(tenants, { ...sel(DEFAULT_STATUS_SET), voucher: new Set(['2']) }, all);
    expect(m.status.map((o) => o.key)).toEqual([...TENANT_STATUSES]);
    expect(m.status.map((o) => o.label)).toEqual(TENANT_STATUSES.map((s) => TENANT_STATUS_LABELS[s]));
    // Narrowed by voucher (one 2-BR searching), NOT by its own selection (inactive still 1).
    expect(m.status.find((o) => o.key === 'searching')!.count).toBe(1);
    expect(m.status.find((o) => o.key === 'inactive')!.count).toBe(1);
    expect(m.status.reduce((sum, o) => sum + o.count, 0)).toBe(2);
  });

  it('the value facets count under the status selection', () => {
    const tenants = [st('searching', { voucherSize: 2 }), st('inactive', { voucherSize: 2 }), st(undefined, { voucherSize: 2 })];
    expect(buildFacets(tenants, sel(DEFAULT_STATUS_SET), all).voucher.find((o) => o.key === '2')!.count).toBe(2);
    expect(buildFacets(tenants, sel(TENANT_STATUSES), all).voucher.find((o) => o.key === '2')!.count).toBe(3);
  });

  it('hiddenByStatusOnly: true only when the other three facets pass and the status does not', () => {
    const inactive2 = st('inactive', { voucherSize: 2 });
    expect(hiddenByStatusOnly(inactive2, sel(DEFAULT_STATUS_SET))).toBe(true);
    expect(hiddenByStatusOnly(inactive2, { ...sel(DEFAULT_STATUS_SET), voucher: new Set(['3']) })).toBe(false);
    expect(hiddenByStatusOnly(st('searching'), sel(DEFAULT_STATUS_SET))).toBe(false);
    expect(hiddenByStatusOnly(st(undefined), sel([]))).toBe(false);
  });

  it('sort: ?sort=name reads name, anything else heard; the writer touches only sort', () => {
    expect(parseSort(new URLSearchParams('sort=name'))).toBe('name');
    expect(parseSort(new URLSearchParams())).toBe('heard');
    expect(parseSort(new URLSearchParams('sort=bogus'))).toBe('heard');
    const p = new URLSearchParams('voucher=2&sort=bogus');
    applySortToParams(p, 'name');
    expect(p.toString()).toBe('voucher=2&sort=name');
    applySortToParams(p, 'heard');
    expect(p.toString()).toBe('voucher=2');
  });
});
