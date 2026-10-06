// Unit tests for lib/tourListQuery.ts - the PURE half of the Tours page's All
// tab read, GET /api/tours/list (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md section 5): request
// parsing and normalization, and the phase plan. Pure - no I/O, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  isUnfilteredPhase,
  parseTourListQuery,
  planTourListPhases,
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
