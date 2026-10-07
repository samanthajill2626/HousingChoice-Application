// tourListSelection.test.ts - the All tab's pure filter model (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md sections 4.3, 4.7 and
// 4.9): URL parse/apply, the pruning invariant, local-day conversion, the API
// parameters and their key, and the restore record.
//
// Local-day expectations are computed with the same `new Date(y, m - 1, d)`
// constructor the module uses, so every case holds in any runner time zone
// (process.env.TZ is not reliable under vitest workers).
import { describe, expect, it } from 'vitest';
import type { TourStatus } from '../../api/index.js';
import {
  DEFAULT_TOUR_LIST_SELECTION,
  applyTourListSelection,
  effectiveTourListSort,
  isDefaultTourListSelection,
  localDayEndIso,
  localDayStartIso,
  parseTourListRestore,
  parseTourListSelection,
  pruneTourListSelection,
  tourListApiKey,
  tourListApiParams,
  tourListRangeError,
  type TourListSelection,
} from './tourListSelection.js';

/** A selection: the defaults with `overrides` on top (a fresh status set). */
function sel(overrides: Partial<TourListSelection> = {}): TourListSelection {
  return { ...DEFAULT_TOUR_LIST_SELECTION, statuses: new Set<TourStatus>(), ...overrides };
}

function statuses(...values: TourStatus[]): Set<TourStatus> {
  return new Set<TourStatus>(values);
}

function parse(query: string): TourListSelection {
  return parseTourListSelection(new URLSearchParams(query));
}

/** Start of a local calendar day, built the way the module builds it. */
function startOf(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d).toISOString();
}

/** End of a local calendar day: the next local midnight minus 1 ms. */
function endOf(y: number, m: number, d: number): string {
  return new Date(new Date(y, m - 1, d + 1).getTime() - 1).toISOString();
}

describe('parseTourListSelection', () => {
  it('an empty query is the default selection', () => {
    expect(parse('')).toEqual(DEFAULT_TOUR_LIST_SELECTION);
    expect(DEFAULT_TOUR_LIST_SELECTION).toEqual({
      when: 'any',
      from: '',
      to: '',
      statuses: new Set(),
      type: '',
      sort: '',
      q: '',
    });
  });

  it('keeps every valid value and drops each invalid one individually', () => {
    const parsed = parse('when=past&status=no_show,bogus,canceled&type=pm_team&sort=earliest&q=smith');
    expect(parsed).toEqual(
      sel({ when: 'past', statuses: statuses('no_show', 'canceled'), type: 'pm_team', sort: 'earliest', q: 'smith' }),
    );
    expect(parse('when=later').when).toBe('any');
    expect(parse('type=walk_in').type).toBe('');
    expect(parse('sort=newest').sort).toBe('');
    // A day that does not exist, and a non-ISO day, drop out.
    expect(parse('when=range&from=2026-02-30').from).toBe('');
    expect(parse('when=range&from=10/01/2026').from).toBe('');
    expect(parse('when=range&to=2026-1-5').to).toBe('');
    // Real days are kept.
    const range = parse('when=range&from=2026-10-01&to=2026-10-31');
    expect(range.from).toBe('2026-10-01');
    expect(range.to).toBe('2026-10-31');
  });

  it('a status list of only unknown values is every status (an empty set)', () => {
    expect(parse('status=bogus,,also_bogus').statuses).toEqual(new Set());
    expect(parse('status=requested').statuses).toEqual(statuses('requested'));
  });
});

describe('applyTourListSelection', () => {
  it('the default selection deletes every filter param and keeps unrelated ones', () => {
    const params = new URLSearchParams(
      'when=past&status=toured&type=pm_team&sort=earliest&from=2026-10-01&to=2026-10-02&q=x&keep=1',
    );
    applyTourListSelection(params, DEFAULT_TOUR_LIST_SELECTION);
    expect(params.toString()).toBe('keep=1');
  });

  it('writes only non-defaults, statuses in the fixed chip order whatever the insertion order', () => {
    const params = new URLSearchParams('keep=1');
    applyTourListSelection(params, sel({ statuses: statuses('closed', 'canceled', 'requested', 'no_show') }));
    expect(params.get('status')).toBe('requested,no_show,canceled,closed');
    expect(params.get('keep')).toBe('1');
    for (const name of ['when', 'type', 'sort', 'from', 'to', 'q']) expect(params.has(name)).toBe(false);

    const all = new URLSearchParams();
    applyTourListSelection(
      all,
      sel({
        statuses: statuses('toured', 'scheduled', 'closed', 'canceled', 'requested', 'no_show'),
      }),
    );
    expect(all.get('status')).toBe('requested,scheduled,toured,no_show,canceled,closed');
  });

  it('writes from / to ONLY under Date range', () => {
    const past = new URLSearchParams();
    applyTourListSelection(past, sel({ when: 'past', from: '2026-10-01', to: '2026-10-31' }));
    expect(past.get('when')).toBe('past');
    expect(past.has('from')).toBe(false);
    expect(past.has('to')).toBe(false);

    const range = new URLSearchParams();
    applyTourListSelection(range, sel({ when: 'range', from: '2026-10-01', to: '2026-10-31' }));
    expect(range.get('when')).toBe('range');
    expect(range.get('from')).toBe('2026-10-01');
    expect(range.get('to')).toBe('2026-10-31');
  });

  it('writes the pruned selection: a hidden Needs booking chip never reaches the URL', () => {
    const params = new URLSearchParams();
    applyTourListSelection(params, sel({ when: 'upcoming', statuses: statuses('requested', 'scheduled') }));
    expect(params.get('status')).toBe('scheduled');
  });

  it('writes type, sort and q when set', () => {
    const params = new URLSearchParams();
    applyTourListSelection(params, sel({ type: 'self_guided', sort: 'latest', q: 'Smith & Co' }));
    expect(params.get('type')).toBe('self_guided');
    expect(params.get('sort')).toBe('latest');
    expect(params.get('q')).toBe('Smith & Co');
  });
});

describe('round trip', () => {
  it('parse(apply(sel)) equals prune(sel)', () => {
    const cases: TourListSelection[] = [
      sel(),
      sel({ when: 'past', statuses: statuses('canceled', 'no_show'), sort: 'earliest' }),
      sel({ when: 'any', statuses: statuses('requested'), type: 'landlord_led', q: "O'Brien & Sons" }),
      sel({ when: 'upcoming', statuses: statuses('requested', 'scheduled'), from: '2026-10-01' }),
      sel({ when: 'range', from: '2026-10-01', to: '2026-10-31', statuses: statuses('closed', 'toured') }),
      sel({ when: 'range', from: '', to: '2026-12-31', sort: 'latest' }),
      sel({ when: 'past', from: '2026-01-01', to: '2026-01-02', q: '  spaced  ' }),
    ];
    for (const s of cases) {
      const params = new URLSearchParams();
      applyTourListSelection(params, s);
      expect(parseTourListSelection(new URLSearchParams(params.toString()))).toEqual(pruneTourListSelection(s));
    }
  });
});

describe('pruneTourListSelection', () => {
  it('drops the Needs booking status and the dates under a dated When, keeping the rest; never mutates', () => {
    const input = sel({
      when: 'past',
      from: '2026-10-01',
      to: '2026-10-31',
      statuses: statuses('requested', 'toured'),
      type: 'pm_team',
      sort: 'earliest',
      q: 'smith',
    });
    const out = pruneTourListSelection(input);
    expect(out).toEqual(
      sel({ when: 'past', statuses: statuses('toured'), type: 'pm_team', sort: 'earliest', q: 'smith' }),
    );
    // The input is untouched.
    expect(input.statuses).toEqual(statuses('requested', 'toured'));
    expect(input.from).toBe('2026-10-01');
    expect(input.to).toBe('2026-10-31');
    expect(out.statuses).not.toBe(input.statuses);
  });

  it('keeps Needs booking only under Any time, and the dates only under Date range', () => {
    const any = pruneTourListSelection(
      sel({ when: 'any', statuses: statuses('requested'), from: '2026-10-01', to: '2026-10-02' }),
    );
    expect(any.statuses).toEqual(statuses('requested'));
    expect(any.from).toBe('');
    expect(any.to).toBe('');

    const upcoming = pruneTourListSelection(sel({ when: 'upcoming', statuses: statuses('requested') }));
    expect(upcoming.statuses).toEqual(new Set());

    const range = pruneTourListSelection(
      sel({ when: 'range', statuses: statuses('requested', 'closed'), from: '2026-10-01', to: '2026-10-02' }),
    );
    expect(range.statuses).toEqual(statuses('closed'));
    expect(range.from).toBe('2026-10-01');
    expect(range.to).toBe('2026-10-02');
  });
});

describe('effectiveTourListSort', () => {
  it('a picked sort wins; otherwise Earliest for Upcoming and Latest for the rest', () => {
    expect(effectiveTourListSort(sel({ when: 'upcoming', sort: 'latest' }))).toBe('latest');
    expect(effectiveTourListSort(sel({ when: 'past', sort: 'earliest' }))).toBe('earliest');
    expect(effectiveTourListSort(sel({ when: 'upcoming' }))).toBe('earliest');
    expect(effectiveTourListSort(sel({ when: 'any' }))).toBe('latest');
    expect(effectiveTourListSort(sel({ when: 'past' }))).toBe('latest');
    expect(effectiveTourListSort(sel({ when: 'range' }))).toBe('latest');
  });
});

describe('local days', () => {
  it('a day starts at LOCAL midnight and ends at the next local midnight minus 1 ms', () => {
    expect(localDayStartIso('2026-10-06')).toBe(startOf(2026, 10, 6));
    expect(localDayEndIso('2026-10-06')).toBe(endOf(2026, 10, 6));
    // Month and year ends roll over by calendar arithmetic.
    expect(localDayEndIso('2026-10-31')).toBe(endOf(2026, 10, 31));
    expect(localDayEndIso('2026-12-31')).toBe(new Date(new Date(2027, 0, 1).getTime() - 1).toISOString());
    // US DST days (23 and 25 hours long in a US zone) still end at the next
    // local midnight.
    expect(localDayEndIso('2026-03-08')).toBe(endOf(2026, 3, 8));
    expect(localDayEndIso('2026-11-01')).toBe(endOf(2026, 11, 1));
  });

  it('reads the day in the LOCAL zone, never as UTC midnight', () => {
    const start = new Date(localDayStartIso('2026-10-06')!);
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 9, 6]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    const end = new Date(localDayEndIso('2026-10-06')!);
    expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2026, 9, 6]);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([23, 59, 59, 999]);
  });

  it('returns undefined for an empty, impossible or malformed day', () => {
    for (const bad of ['', '2026-02-30', '2026-1-5', '2026-13-01', '10/06/2026', '2026-10-06T00:00']) {
      expect(localDayStartIso(bad)).toBeUndefined();
      expect(localDayEndIso(bad)).toBeUndefined();
    }
  });

  it('the furthest pickable day never ends past year 9999 - the server refuses an extended year (R3-1)', () => {
    // At or west of UTC (Atlanta) the next local midnight after 9999-12-31 is
    // already year 10000 in UTC, so the day ends at the last instant of 9999;
    // east of UTC the day's own end stands.
    const atOrWestOfUtc = new Date(10000, 0, 1).getTimezoneOffset() >= 0;
    const end = localDayEndIso('9999-12-31');
    expect(end).toBe(atOrWestOfUtc ? '9999-12-31T23:59:59.999Z' : endOf(9999, 12, 31));
    // Never '+010000-...', whatever the runner's zone.
    expect(end).not.toMatch(/^\+/);
    // The start cannot overflow (local midnight of 9999-12-31 is in year 9999
    // in every zone): unchanged.
    expect(localDayStartIso('9999-12-31')).toBe(startOf(9999, 12, 31));
  });
});

describe('tourListRangeError', () => {
  it('From after To under Date range is an error; everything else is not', () => {
    expect(tourListRangeError(sel({ when: 'range', from: '2026-10-31', to: '2026-10-01' }))).toBe(
      'From must be on or before To.',
    );
    expect(tourListRangeError(sel({ when: 'range', from: '2026-10-01', to: '2026-10-01' }))).toBeNull();
    expect(tourListRangeError(sel({ when: 'range', from: '2026-10-01', to: '2026-10-31' }))).toBeNull();
    expect(tourListRangeError(sel({ when: 'range', from: '2026-10-31', to: '' }))).toBeNull();
    expect(tourListRangeError(sel({ when: 'range', from: '', to: '2026-10-01' }))).toBeNull();
    expect(tourListRangeError(sel({ when: 'past', from: '2026-10-31', to: '2026-10-01' }))).toBeNull();
    expect(tourListRangeError(sel())).toBeNull();
  });
});

describe('tourListApiParams', () => {
  it('the default selection sends when=any and sort=latest only', () => {
    expect(tourListApiParams(sel())).toStrictEqual({ when: 'any', sort: 'latest' });
  });

  it('a date range sends the start of From and the END of To as local-day instants', () => {
    expect(tourListApiParams(sel({ when: 'range', from: '2026-10-01', to: '2026-10-31' }))).toStrictEqual({
      when: 'range',
      from: startOf(2026, 10, 1),
      to: endOf(2026, 10, 31),
      sort: 'latest',
    });
    expect(tourListApiParams(sel({ when: 'range', to: '2026-10-31' }))).toStrictEqual({
      when: 'range',
      to: endOf(2026, 10, 31),
      sort: 'latest',
    });
  });

  it('Date range with both days empty sends no from / to', () => {
    expect(tourListApiParams(sel({ when: 'range' }))).toStrictEqual({ when: 'range', sort: 'latest' });
  });

  it('statuses go as a comma list in chip order; type as is; the When default sort applies', () => {
    expect(tourListApiParams(sel({ statuses: statuses('canceled', 'no_show') }))).toStrictEqual({
      when: 'any',
      status: 'no_show,canceled',
      sort: 'latest',
    });
    expect(tourListApiParams(sel({ when: 'upcoming', type: 'landlord_led' }))).toStrictEqual({
      when: 'upcoming',
      type: 'landlord_led',
      sort: 'earliest',
    });
  });

  it('sends the PRUNED selection: no hidden Needs booking chip, no dates outside Date range', () => {
    expect(
      tourListApiParams(
        sel({ when: 'past', statuses: statuses('requested', 'toured'), from: '2026-10-01', to: '2026-10-31' }),
      ),
    ).toStrictEqual({ when: 'past', status: 'toured', sort: 'latest' });
    expect(tourListApiParams(sel({ when: 'upcoming', statuses: statuses('requested') }))).toStrictEqual({
      when: 'upcoming',
      sort: 'earliest',
    });
  });

  it('never sends the search text', () => {
    const params = tourListApiParams(sel({ q: 'smith' }));
    expect(params).toStrictEqual({ when: 'any', sort: 'latest' });
    expect(params !== null && 'q' in params).toBe(false);
  });

  it('is null while the date range is invalid (the view sends nothing)', () => {
    expect(tourListApiParams(sel({ when: 'range', from: '2026-10-31', to: '2026-10-01' }))).toBeNull();
  });
});

describe('tourListApiKey', () => {
  it('is the JSON of the API params: stable across the search text and the chip insertion order', () => {
    const a = sel({ when: 'past', statuses: statuses('no_show', 'canceled'), q: 'smith' });
    const b = sel({ when: 'past', statuses: statuses('canceled', 'no_show'), q: 'jones' });
    expect(tourListApiKey(a)).toBe(tourListApiKey(b));
    expect(tourListApiKey(a)).toBe(JSON.stringify(tourListApiParams(a)));
    expect(tourListApiKey(sel())).toBe(JSON.stringify({ when: 'any', sort: 'latest' }));
  });

  it('changes when a server-visible filter changes', () => {
    const base = tourListApiKey(sel({ when: 'past' }));
    expect(tourListApiKey(sel({ when: 'past', sort: 'earliest' }))).not.toBe(base);
    expect(tourListApiKey(sel({ when: 'past', type: 'pm_team' }))).not.toBe(base);
    expect(tourListApiKey(sel({ when: 'past', statuses: statuses('toured') }))).not.toBe(base);
    expect(tourListApiKey(sel({ when: 'any' }))).not.toBe(base);
  });
});

describe('isDefaultTourListSelection', () => {
  it('true for the default; false when any one field differs, the search text included', () => {
    expect(isDefaultTourListSelection(DEFAULT_TOUR_LIST_SELECTION)).toBe(true);
    expect(isDefaultTourListSelection(sel())).toBe(true);
    const changed: Partial<TourListSelection>[] = [
      { when: 'past' },
      { from: '2026-10-01' },
      { to: '2026-10-01' },
      { statuses: statuses('toured') },
      { type: 'pm_team' },
      { sort: 'latest' },
      { q: 'smith' },
    ];
    for (const c of changed) expect(isDefaultTourListSelection(sel(c))).toBe(false);
  });
});

describe('parseTourListRestore', () => {
  const RECORD = { depth: 120, openedTourId: 't9', openedIndex: 7 };

  it('reads a valid record from history state, carrying only its three fields', () => {
    expect(parseTourListRestore({ restore: RECORD })).toStrictEqual(RECORD);
    expect(
      parseTourListRestore({ tourListFilterWrite: true, restore: { ...RECORD, extra: 'dropped' } }),
    ).toStrictEqual(RECORD);
    // Zero is a real depth and a real index.
    expect(parseTourListRestore({ restore: { depth: 0, openedTourId: 't1', openedIndex: 0 } })).toStrictEqual({
      depth: 0,
      openedTourId: 't1',
      openedIndex: 0,
    });
  });

  it('refuses a record with any one field wrong', () => {
    const wrong: Record<string, unknown>[] = [
      { ...RECORD, depth: -1 },
      { ...RECORD, depth: 1.5 },
      { ...RECORD, depth: '120' },
      { ...RECORD, depth: Number.NaN },
      { ...RECORD, depth: Number.POSITIVE_INFINITY },
      { openedTourId: 't9', openedIndex: 7 },
      { ...RECORD, openedIndex: -1 },
      { ...RECORD, openedIndex: 2.5 },
      { ...RECORD, openedIndex: '7' },
      { depth: 120, openedTourId: 't9' },
      { ...RECORD, openedTourId: '' },
      { ...RECORD, openedTourId: 9 },
      { depth: 120, openedIndex: 7 },
    ];
    for (const r of wrong) expect(parseTourListRestore({ restore: r })).toBeNull();
  });

  it('refuses a state or a record that is not an object', () => {
    for (const state of [null, undefined, 'restore', 42, true]) expect(parseTourListRestore(state)).toBeNull();
    for (const r of [null, undefined, 'x', 3, true]) expect(parseTourListRestore({ restore: r })).toBeNull();
  });

  it('is null when the state has no restore key', () => {
    expect(parseTourListRestore({})).toBeNull();
    expect(parseTourListRestore({ tourListFilterWrite: true })).toBeNull();
    expect(parseTourListRestore({ back: '/tours/all?when=past' })).toBeNull();
  });
});
