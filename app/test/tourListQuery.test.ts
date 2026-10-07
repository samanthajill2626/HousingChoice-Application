// Unit tests for lib/tourListQuery.ts - the PURE half of the Tours page's All
// tab read, GET /api/tours/list (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md section 5): request
// parsing and normalization, the phase plan, the filter fingerprint and the
// opaque cursor. Pure - no I/O, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  decodeTourListCursor,
  encodeTourListCursor,
  isUnfilteredPhase,
  locateTourListCursor,
  parseTourListQuery,
  planTourListPhases,
  tourListFingerprint,
  tourListKeyOf,
  type TourListCursor,
  type TourListFilters,
  type TourListPhase,
  type TourListRequest,
} from '../src/lib/tourListQuery.js';

/** Parse and unwrap a request that must be valid. */
function parsed(query: Record<string, unknown>): TourListRequest {
  const r = parseTourListQuery(query);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}

const WHEN_ERROR = 'when must be one of: any, upcoming, past, range';
const SORT_ERROR = 'sort must be one of: latest, earliest';
const STATUS_ERROR = 'status must be a comma list of: requested, scheduled, toured, no_show, canceled, closed';
const TYPE_ERROR = 'type must be one of: self_guided, landlord_led, pm_team';
const ONLY_RANGE_ERROR = 'from and to are accepted only with when=range';
const ISO_ERROR = 'from and to must be valid ISO 8601 datetimes';
const ORDER_ERROR = 'from must be on or before to';
const LIMIT_ERROR = 'limit must be an integer 1..100';

describe('parseTourListQuery', () => {
  it('1: an empty query is every tour, latest first, 50 rows, no cursor - and no from/to/type keys at all', () => {
    expect(parsed({})).toStrictEqual({
      filters: { when: 'any', statuses: [], sort: 'latest' },
      limit: 50,
    });
  });

  it('2: when picks the default sort; empty is absent; anything else is a 400 message', () => {
    expect(parsed({ when: 'upcoming' }).filters).toStrictEqual({ when: 'upcoming', statuses: [], sort: 'earliest' });
    expect(parsed({ when: 'past' }).filters.sort).toBe('latest');
    expect(parsed({ when: 'range' }).filters.sort).toBe('latest');
    expect(parsed({ when: 'any' }).filters.sort).toBe('latest');
    expect(parsed({ when: '' }).filters).toStrictEqual({ when: 'any', statuses: [], sort: 'latest' });
    expect(parseTourListQuery({ when: 'later' })).toEqual({ ok: false, error: WHEN_ERROR });
    expect(parseTourListQuery({ when: ['any', 'past'] })).toEqual({ ok: false, error: WHEN_ERROR });
  });

  it('3: an explicit sort wins over the When default; an unknown sort is a 400 message', () => {
    expect(parsed({ when: 'past', sort: 'earliest' }).filters.sort).toBe('earliest');
    expect(parsed({ when: 'upcoming', sort: 'latest' }).filters.sort).toBe('latest');
    expect(parseTourListQuery({ sort: 'newest' })).toEqual({ ok: false, error: SORT_ERROR });
  });

  it('4: status is a comma list - deduped, trimmed, in TOUR_STATUSES order; all six is the empty set', () => {
    expect(parsed({ status: 'no_show,canceled' }).filters.statuses).toEqual(['no_show', 'canceled']);
    expect(parsed({ status: 'canceled,no_show,canceled' }).filters.statuses).toEqual(['no_show', 'canceled']);
    expect(parsed({ status: ' toured , ' }).filters.statuses).toEqual(['toured']);
    expect(parsed({ status: '' }).filters.statuses).toEqual([]);
    expect(parsed({ status: 'closed,canceled,no_show,toured,scheduled,requested' }).filters.statuses).toEqual([]);
    expect(parsed({ status: 'requested,scheduled,toured,no_show,canceled,closed' }).filters.statuses).toEqual([]);
    expect(parseTourListQuery({ status: 'toured,bogus' })).toEqual({ ok: false, error: STATUS_ERROR });
  });

  it('5: type is one tour type; empty is absent; an unknown type is a 400 message', () => {
    expect(parsed({ type: 'pm_team' }).filters).toStrictEqual({
      when: 'any',
      statuses: [],
      type: 'pm_team',
      sort: 'latest',
    });
    expect(parsed({ type: '' }).filters).toStrictEqual({ when: 'any', statuses: [], sort: 'latest' });
    expect(parseTourListQuery({ type: 'walk_in' })).toEqual({ ok: false, error: TYPE_ERROR });
  });

  it('6: from / to only with when=range, canonicalized, valid, and in order', () => {
    expect(parseTourListQuery({ from: '2026-10-01T04:00:00.000Z' })).toEqual({ ok: false, error: ONLY_RANGE_ERROR });
    expect(parseTourListQuery({ when: 'past', to: '2026-10-01T04:00:00.000Z' })).toEqual({
      ok: false,
      error: ONLY_RANGE_ERROR,
    });
    expect(parseTourListQuery({ when: 'upcoming', from: '2026-10-01T04:00:00.000Z' })).toEqual({
      ok: false,
      error: ONLY_RANGE_ERROR,
    });

    expect(parsed({ when: 'range', from: '2026-10-01T04:00:00Z' }).filters).toStrictEqual({
      when: 'range',
      from: '2026-10-01T04:00:00.000Z',
      statuses: [],
      sort: 'latest',
    });
    expect(parsed({ when: 'range', from: '2026-10-01T00:00:00-04:00' }).filters.from).toBe('2026-10-01T04:00:00.000Z');
    expect(parsed({ when: 'range', to: '2026-10-31T03:59:59.999Z' }).filters).toStrictEqual({
      when: 'range',
      to: '2026-10-31T03:59:59.999Z',
      statuses: [],
      sort: 'latest',
    });

    expect(parseTourListQuery({ when: 'range', from: 'yesterday' })).toEqual({ ok: false, error: ISO_ERROR });
    expect(parseTourListQuery({ when: 'range', to: 'yesterday' })).toEqual({ ok: false, error: ISO_ERROR });
    expect(
      parseTourListQuery({ when: 'range', from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
    ).toEqual({ ok: false, error: ORDER_ERROR });
    expect(
      parsed({ when: 'range', from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }).filters,
    ).toMatchObject({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });

    expect(parsed({ when: 'range' }).filters).toStrictEqual({ when: 'range', statuses: [], sort: 'latest' });
  });

  it('7: limit is an integer 1..100, default 50', () => {
    expect(parsed({ limit: '1' }).limit).toBe(1);
    expect(parsed({ limit: '100' }).limit).toBe(100);
    expect(parsed({}).limit).toBe(50);
    for (const bad of ['0', '101', '2.5', 'abc', '']) {
      expect(parseTourListQuery({ limit: bad }), `limit ${JSON.stringify(bad)}`).toEqual({
        ok: false,
        error: LIMIT_ERROR,
      });
    }
  });

  it('8: a cursor string passes through untouched; an empty or repeated cursor is invalid', () => {
    expect(parsed({ cursor: 'eyJ2IjoxfQ' }).cursor).toBe('eyJ2IjoxfQ');
    expect(parseTourListQuery({ cursor: '' })).toEqual({ ok: false, error: 'invalid cursor' });
    expect(parseTourListQuery({ cursor: ['a', 'b'] })).toEqual({ ok: false, error: 'invalid cursor' });
  });

  it('9: from / to are ISO 8601 date-times WITH a zone - a zone-less or date-only form would mean a different instant per host (SC-2)', () => {
    for (const bad of ['10/06/2026', 'Oct 6 2026', '2026', '2026-10-06', '2026-10-06T00:00:00', '2026-10-06T00:00:00.000']) {
      expect(parseTourListQuery({ when: 'range', from: bad }), `from ${bad}`).toEqual({ ok: false, error: ISO_ERROR });
      expect(parseTourListQuery({ when: 'range', to: bad }), `to ${bad}`).toEqual({ ok: false, error: ISO_ERROR });
    }
    expect(parsed({ when: 'range', from: '2026-10-06T00:00:00-04:00' }).filters.from).toBe('2026-10-06T04:00:00.000Z');
    expect(parsed({ when: 'range', from: '2026-10-06T00:00:00Z' }).filters.from).toBe('2026-10-06T00:00:00.000Z');
    expect(parsed({ when: 'range', to: '2026-10-06T23:59:59.999-04:00' }).filters.to).toBe('2026-10-07T03:59:59.999Z');
    expect(parsed({ when: 'range', to: '2026-10-06T12:30Z' }).filters.to).toBe('2026-10-06T12:30:00.000Z');

    // Any fraction length, truncated to milliseconds; and an impossible
    // calendar time is a 400, never rolled into the next day or month (R2-1).
    expect(parsed({ when: 'range', from: '2026-10-06T00:00:00.123456Z' }).filters.from).toBe('2026-10-06T00:00:00.123Z');
    expect(parsed({ when: 'range', from: '2026-10-06T00:00:00.123456+00:00' }).filters.from).toBe('2026-10-06T00:00:00.123Z');
    for (const bad of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00-04:00', '2026-10-06T24:00:00Z']) {
      expect(parseTourListQuery({ when: 'range', from: bad }), `from ${bad}`).toEqual({ ok: false, error: ISO_ERROR });
      expect(parseTourListQuery({ when: 'range', to: bad }), `to ${bad}`).toEqual({ ok: false, error: ISO_ERROR });
    }
    // The day check is the year's own (a leap day), and a year below 100 is
    // that year, never 1900 + it.
    expect(parsed({ when: 'range', from: '2028-02-29T00:00:00Z' }).filters.from).toBe('2028-02-29T00:00:00.000Z');
    expect(parsed({ when: 'range', from: '0050-06-15T00:00:00Z' }).filters.from).toBe('0050-06-15T00:00:00.000Z');
  });
});

describe('planTourListPhases', () => {
  const N = '2026-10-06T16:00:00.000Z';
  const filters = (over: Partial<TourListFilters>): TourListFilters => ({
    when: 'any',
    statuses: [],
    sort: 'latest',
    ...over,
  });
  const EVERY_ANY: TourListPhase[] = [
    { kind: 'd', range: { op: 'all' } },
    { kind: 'u', index: 0, status: 'requested', notExists: false },
    { kind: 'u', index: 1, status: 'toured', notExists: true },
    { kind: 'u', index: 2, status: 'no_show', notExists: true },
    { kind: 'u', index: 3, status: 'canceled', notExists: true },
    { kind: 'u', index: 4, status: 'closed', notExists: true },
  ];

  it('1: when=any, every status -> D over the whole partition (no filters), then one U phase per U_ORDER status', () => {
    expect(planTourListPhases(filters({}), N)).toStrictEqual(EVERY_ANY);
  });

  it('2: only requested -> exactly the requested U phase (D skipped - requested is never dated)', () => {
    expect(planTourListPhases(filters({ statuses: ['requested'] }), N)).toStrictEqual([
      { kind: 'u', index: 0, status: 'requested', notExists: false },
    ]);
  });

  it('3: only scheduled -> exactly D with a scheduled status filter (U skipped)', () => {
    expect(planTourListPhases(filters({ statuses: ['scheduled'] }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'all' }, statusFilter: ['scheduled'] },
    ]);
  });

  it('4: a partial dated set -> D filtered to the dated picks, then U for the picked U_ORDER statuses', () => {
    expect(
      planTourListPhases(filters({ statuses: ['requested', 'scheduled', 'toured', 'no_show', 'canceled'] }), N),
    ).toStrictEqual([
      { kind: 'd', range: { op: 'all' }, statusFilter: ['scheduled', 'toured', 'no_show', 'canceled'] },
      { kind: 'u', index: 0, status: 'requested', notExists: false },
      { kind: 'u', index: 1, status: 'toured', notExists: true },
      { kind: 'u', index: 2, status: 'no_show', notExists: true },
      { kind: 'u', index: 3, status: 'canceled', notExists: true },
    ]);
  });

  it('5: every dated status without requested -> D carries NO status filter; U has no requested phase', () => {
    expect(
      planTourListPhases(filters({ statuses: ['scheduled', 'toured', 'no_show', 'canceled', 'closed'] }), N),
    ).toStrictEqual([
      { kind: 'd', range: { op: 'all' } },
      { kind: 'u', index: 1, status: 'toured', notExists: true },
      { kind: 'u', index: 2, status: 'no_show', notExists: true },
      { kind: 'u', index: 3, status: 'canceled', notExists: true },
      { kind: 'u', index: 4, status: 'closed', notExists: true },
    ]);
  });

  it('6: upcoming / past split at the pinned instant and never read phase U, whatever the statuses', () => {
    expect(planTourListPhases(filters({ when: 'upcoming', sort: 'earliest' }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'gte', value: N } },
    ]);
    expect(planTourListPhases(filters({ when: 'past' }), N)).toStrictEqual([{ kind: 'd', range: { op: 'lt', value: N } }]);
    expect(planTourListPhases(filters({ when: 'past', statuses: ['requested', 'toured', 'closed'] }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'lt', value: N }, statusFilter: ['toured', 'closed'] },
    ]);
    expect(planTourListPhases(filters({ when: 'upcoming', statuses: ['scheduled', 'requested'] }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'gte', value: N }, statusFilter: ['scheduled'] },
    ]);
  });

  it('7: range -> between / gte from / lte to / all, and never phase U', () => {
    const from = '2026-10-01T04:00:00.000Z';
    const to = '2026-11-01T03:59:59.999Z';
    expect(planTourListPhases(filters({ when: 'range', from, to }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'between', from, to } },
    ]);
    expect(planTourListPhases(filters({ when: 'range', from }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'gte', value: from } },
    ]);
    expect(planTourListPhases(filters({ when: 'range', to }), N)).toStrictEqual([
      { kind: 'd', range: { op: 'lte', value: to } },
    ]);
    expect(planTourListPhases(filters({ when: 'range' }), N)).toStrictEqual([{ kind: 'd', range: { op: 'all' } }]);
  });

  it('8: upcoming with only requested -> no phase at all (nothing can match)', () => {
    expect(planTourListPhases(filters({ when: 'upcoming', sort: 'earliest', statuses: ['requested'] }), N)).toStrictEqual(
      [],
    );
  });

  it('9: a type rides on every phase', () => {
    expect(planTourListPhases(filters({ type: 'self_guided' }), N)).toStrictEqual(
      EVERY_ANY.map((p) => ({ ...p, type: 'self_guided' })),
    );
  });

  it('10: isUnfilteredPhase - only a filter-free D and the type-free requested U phase', () => {
    const [d, requested, ...notExists] = planTourListPhases(filters({}), N);
    expect(d && isUnfilteredPhase(d)).toBe(true);
    expect(requested && isUnfilteredPhase(requested)).toBe(true);
    expect(notExists).toHaveLength(4);
    for (const p of notExists) expect(isUnfilteredPhase(p), `${p.kind} ${JSON.stringify(p)}`).toBe(false);
    for (const p of planTourListPhases(filters({ type: 'pm_team' }), N)) {
      expect(isUnfilteredPhase(p), `typed ${JSON.stringify(p)}`).toBe(false);
    }
    expect(isUnfilteredPhase({ kind: 'd', range: { op: 'all' }, statusFilter: ['toured'] })).toBe(false);
    expect(isUnfilteredPhase({ kind: 'd', range: { op: 'lt', value: N } })).toBe(true);
  });
});

describe('tourListFingerprint', () => {
  const base: TourListFilters = {
    when: 'range',
    from: '2026-10-01T04:00:00.000Z',
    to: '2026-11-01T03:59:59.999Z',
    statuses: ['toured', 'closed'],
    type: 'pm_team',
    sort: 'latest',
  };

  it('1: 16 lowercase hex chars, equal for equal filters, different when any one filter changes', () => {
    const fp = tourListFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(tourListFingerprint({ ...base, statuses: ['toured', 'closed'] })).toBe(fp);

    const { from: _from, ...noFrom } = base;
    const { to: _to, ...noTo } = base;
    const { type: _type, ...noType } = base;
    const variants: TourListFilters[] = [
      { ...base, when: 'past' },
      { ...base, from: '2026-10-02T04:00:00.000Z' },
      noFrom,
      { ...base, to: '2026-11-02T03:59:59.999Z' },
      noTo,
      { ...base, statuses: ['toured'] },
      { ...base, statuses: [] },
      { ...base, type: 'self_guided' },
      noType,
      { ...base, sort: 'earliest' },
    ];
    const prints = variants.map((v) => tourListFingerprint(v));
    for (const p of prints) expect(p).not.toBe(fp);
    expect(new Set([fp, ...prints]).size).toBe(variants.length + 1);
  });

  it('1: status absent and all six statuses fingerprint the same (both normalize to every status)', () => {
    const absent = parseTourListQuery({});
    const allSix = parseTourListQuery({ status: 'closed,requested,toured,scheduled,canceled,no_show' });
    if (!absent.ok || !allSix.ok) throw new Error('expected both to parse');
    expect(tourListFingerprint(allSix.value.filters)).toBe(tourListFingerprint(absent.value.filters));
  });
});

describe('tour list cursor', () => {
  const N = '2026-10-06T16:00:00.000Z';
  const F = '0123456789abcdef';
  const D_KEY = { tourId: 'tour-d1', _schedPartition: 'tours', scheduledAt: '2028-01-01T10:00:00.000Z' };
  const U_KEY = { tourId: 'tour-u1', status: 'no_show', createdAt: '2027-12-01T10:00:00.000Z' };
  /** base64url(JSON) of ANY value - for the shapes encodeTourListCursor refuses to type. */
  const raw = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const every = planTourListPhases({ when: 'any', statuses: [], sort: 'latest' }, N);

  it('2: encode / decode round-trips a d cursor and a u cursor with and without k', () => {
    const cursors: TourListCursor[] = [
      { v: 1, f: F, n: N, ph: 'd', k: D_KEY },
      { v: 1, f: F, n: N, ph: 'u', i: 3, k: { ...U_KEY, status: 'canceled' } },
      { v: 1, f: F, n: N, ph: 'u', i: 3 },
    ];
    for (const c of cursors) {
      const encoded = encodeTourListCursor(c);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeTourListCursor(encoded)).toStrictEqual(c);
    }
  });

  it('3: decode refuses every malformed shape', () => {
    const d = { v: 1, f: F, n: N, ph: 'd', k: D_KEY };
    const u = { v: 1, f: F, n: N, ph: 'u', i: 2, k: U_KEY };
    const bad: Array<[string, string]> = [
      ['not base64url JSON', '%%%not-a-cursor%%%'],
      ['base64url of plain text', Buffer.from('not json', 'utf8').toString('base64url')],
      ['a JSON string', raw('cursor')],
      ['a JSON array', raw([d])],
      ['v: 2', raw({ ...d, v: 2 })],
      ['f not 16 hex (short)', raw({ ...d, f: '0123abcd' })],
      ['f not 16 hex (uppercase)', raw({ ...d, f: '0123456789ABCDEF' })],
      ['n a date, not a canonical instant', raw({ ...d, n: '2026-10-06' })],
      ['n a non-canonical instant', raw({ ...d, n: '2026-10-06T16:00:00Z' })],
      ['ph: r', raw({ ...d, ph: 'r' })],
      ['ph: d with an i', raw({ ...d, i: 0 })],
      ['ph: d without k', raw({ v: 1, f: F, n: N, ph: 'd' })],
      ['ph: u without i', raw({ v: 1, f: F, n: N, ph: 'u', k: U_KEY })],
      ['i negative', raw({ ...u, i: -1 })],
      ['i fractional', raw({ ...u, i: 1.5 })],
      ['i > 4', raw({ ...u, i: 5 })],
      ['i a string', raw({ ...u, i: '2' })],
      ['k with an extra key', raw({ ...d, k: { ...D_KEY, unitId: 'unit-1' } })],
      ['k with a missing key', raw({ ...d, k: { tourId: 'tour-d1', _schedPartition: 'tours' } })],
      ['k with an empty string', raw({ ...d, k: { ...D_KEY, scheduledAt: '' } })],
      ['k with a non-string value', raw({ ...d, k: { ...D_KEY, scheduledAt: 20280101 } })],
      ['k an array', raw({ ...d, k: ['tour-d1', 'tours', '2028-01-01T10:00:00.000Z'] })],
      ['a d key on a u cursor', raw({ ...u, k: D_KEY })],
      ['a u key on a d cursor', raw({ ...d, k: U_KEY })],
      ['an unknown top-level key', raw({ ...d, extra: true })],
    ];
    for (const [why, cursor] of bad) expect(decodeTourListCursor(cursor), why).toBeUndefined();
  });

  it('3b: decode refuses a key value over 1,024 UTF-8 bytes or not well-formed - AWS may answer such a key with a 500 (AD-4)', () => {
    const d = { v: 1, f: F, n: N, ph: 'd', k: D_KEY };
    const u = { v: 1, f: F, n: N, ph: 'u', i: 2, k: U_KEY };
    // Built in code: a lone high surrogate survives the JSON / base64url wire
    // form, and a two-byte character makes UTF-8 bytes outnumber UTF-16 units.
    const lone = `a${String.fromCharCode(0xd800)}b`;
    const twoByte = String.fromCharCode(0xe9);
    const bad: Array<[string, string]> = [
      ['a 1,100-byte d tourId', raw({ ...d, k: { ...D_KEY, tourId: 'x'.repeat(1100) } })],
      ['a 1,100-byte u createdAt', raw({ ...u, k: { ...U_KEY, createdAt: 'x'.repeat(1100) } })],
      ['600 two-byte characters (1,200 bytes)', raw({ ...d, k: { ...D_KEY, tourId: twoByte.repeat(600) } })],
      ['a lone surrogate in a d tourId', raw({ ...d, k: { ...D_KEY, tourId: lone } })],
      ['a lone surrogate in a u createdAt', raw({ ...u, k: { ...U_KEY, createdAt: lone } })],
    ];
    for (const [why, cursor] of bad) expect(decodeTourListCursor(cursor), why).toBeUndefined();

    // The cap is inclusive: exactly 1,024 bytes still decodes.
    const atCap: TourListCursor = { v: 1, f: F, n: N, ph: 'd', k: { ...D_KEY, tourId: 'x'.repeat(1024) } };
    expect(decodeTourListCursor(encodeTourListCursor(atCap))).toStrictEqual(atCap);
    // A surrogate PAIR is one astral character - well-formed, so it decodes.
    const astral = String.fromCharCode(0xd83d, 0xde00);
    const paired: TourListCursor = { v: 1, f: F, n: N, ph: 'd', k: { ...D_KEY, tourId: `tour-${astral}` } };
    expect(decodeTourListCursor(encodeTourListCursor(paired))).toStrictEqual(paired);
  });

  it('4: locate - a d cursor resumes phase D only with a tours-partition key', () => {
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'd', k: D_KEY }, every)).toStrictEqual({
      phaseIndex: 0,
      startKey: D_KEY,
    });
    expect(
      locateTourListCursor({ v: 1, f: F, n: N, ph: 'd', k: { ...D_KEY, _schedPartition: 'other' } }, every),
    ).toBeUndefined();
    const requestedOnly = planTourListPhases({ when: 'any', statuses: ['requested'], sort: 'latest' }, N);
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'd', k: D_KEY }, requestedOnly)).toBeUndefined();
  });

  it('4: locate - a u cursor resumes its status phase only when that status is in the plan', () => {
    // every: [D, requested, toured, no_show, canceled, closed] - no_show (i 2) is phase 3.
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 2, k: U_KEY }, every)).toStrictEqual({
      phaseIndex: 3,
      startKey: U_KEY,
    });
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 2 }, every)).toStrictEqual({ phaseIndex: 3 });
    expect(
      locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 2, k: { ...U_KEY, status: 'toured' } }, every),
    ).toBeUndefined();

    // [D(toured, no_show), toured, no_show] - requested is not in the plan.
    const reduced = planTourListPhases({ when: 'any', statuses: ['toured', 'no_show'], sort: 'latest' }, N);
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 0 }, reduced)).toBeUndefined();
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 2 }, reduced)).toStrictEqual({ phaseIndex: 2 });

    const past = planTourListPhases({ when: 'past', statuses: [], sort: 'latest' }, N);
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 1 }, past)).toBeUndefined();
    expect(locateTourListCursor({ v: 1, f: F, n: N, ph: 'u', i: 2, k: U_KEY }, past)).toBeUndefined();
  });

  it("5: tourListKeyOf returns exactly the phase index's three key attributes", () => {
    const item = {
      tourId: 'tour-9',
      tenantId: 'contact-1',
      unitId: 'unit-1',
      tourType: 'self_guided',
      status: 'no_show',
      scheduledAt: '2028-01-03T10:00:00.000Z',
      _schedPartition: 'tours',
      createdAt: '2027-12-03T10:00:00.000Z',
      updatedAt: '2028-01-03T11:00:00.000Z',
      outcome: 'not_a_fit',
    };
    const [d, , , noShow] = every;
    if (d === undefined || noShow === undefined) throw new Error('expected the every-status plan');
    expect(tourListKeyOf(item, d)).toStrictEqual({
      tourId: 'tour-9',
      _schedPartition: 'tours',
      scheduledAt: '2028-01-03T10:00:00.000Z',
    });
    expect(tourListKeyOf(item, noShow)).toStrictEqual({
      tourId: 'tour-9',
      status: 'no_show',
      createdAt: '2027-12-03T10:00:00.000Z',
    });
  });
});
