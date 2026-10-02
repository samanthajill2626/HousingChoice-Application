// useTours.test.ts — unit tests for the useTours data hook.
//
// Asserts:
//   - getTours is called with from/to params (the upcoming window)
//   - getTours is called with status='requested' (the needs-booking query)
//   - toursDateRange produces the expected window
//   - Upcoming tours are sorted ascending by scheduledAt (soonest first)
//   - Needs-booking tours are sorted ascending by createdAt (oldest first, camelCase = real wire)
//   - AbortError is swallowed (no state change)
//   - Non-abort errors set status='error'
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tour } from '../../api/index.js';
import { toursDateRange } from './useTours.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const getToursMock = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, getTours: (...args: unknown[]) => getToursMock(...args) };
});

import {
  pastState,
  pastToursDateRange,
  selectPastTours,
  selectOffRangeTours,
  TODAY_PAST_TOURS_CAP,
  useClosedTours,
  usePastTours,
  useTours,
} from './useTours.js';

// ---------------------------------------------------------------------------
// toursDateRange
// ---------------------------------------------------------------------------

describe('toursDateRange', () => {
  it('from = start of today local (midnight UTC-offset)', () => {
    const now = new Date('2026-07-02T15:30:00'); // mid-afternoon local
    const { from } = toursDateRange(now);
    const d = new Date(from);
    // Local midnight → getHours() = 0
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('to = exactly 30 days after start-of-today', () => {
    const now = new Date('2026-07-02T15:30:00');
    const { from, to } = toursDateRange(now);
    const diff = new Date(to).getTime() - new Date(from).getTime();
    expect(diff).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// useTours hook
// ---------------------------------------------------------------------------

describe('useTours', () => {
  beforeEach(() => {
    getToursMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const UPCOMING = [
    { tourId: 't2', tenantId: 'c2', unitId: 'u2', scheduledAt: '2026-07-10T14:00:00Z', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-02T00:00:00Z' },
    { tourId: 't1', tenantId: 'c1', unitId: 'u1', scheduledAt: '2026-07-05T10:00:00Z', tourType: 'landlord_led', status: 'scheduled', createdAt: '2026-06-01T00:00:00Z' },
  ];

  // Fixtures use camelCase createdAt — the REAL wire field (toursRepo.ts stores createdAt;
  // the route returns raw TourItem; no snake_case transform anywhere in app/src).
  // r2 is newer (Jun 20) and r1 is older (Jun 10): placed in newest-first order so the
  // sort assertion below proves the comparator actually reorders them.
  const NEEDS_BOOKING = [
    { tourId: 'r2', tenantId: 'c2', unitId: 'u2', tourType: 'self_guided', status: 'requested', createdAt: '2026-06-20T00:00:00Z' },
    { tourId: 'r1', tenantId: 'c1', unitId: 'u1', tourType: 'pm_team', status: 'requested', createdAt: '2026-06-10T00:00:00Z' },
  ];

  it('calls getTours with from+to for upcoming and with status=requested for needs-booking', async () => {
    getToursMock.mockImplementation(async (params: Record<string, string>) => {
      if (params['status'] === 'requested') return [];
      if (params['from']) return [];
      return [];
    });
    const { result } = renderHook(() => useTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(getToursMock).toHaveBeenCalledTimes(2);
    const calls = getToursMock.mock.calls as [Record<string, string>, AbortSignal | undefined][];
    const upcomingCall = calls.find(([p]) => p['from'] !== undefined);
    const requestedCall = calls.find(([p]) => p['status'] === 'requested');
    expect(upcomingCall).toBeDefined();
    expect(upcomingCall![0]).toHaveProperty('from');
    expect(upcomingCall![0]).toHaveProperty('to');
    expect(requestedCall).toBeDefined();
    expect(requestedCall![0]).toEqual({ status: 'requested' });
  });

  it('sorts upcoming tours by scheduledAt ascending (soonest first)', async () => {
    getToursMock.mockImplementation(async (params: Record<string, string>) => {
      if (params['status'] === 'requested') return [];
      // Return in reverse order (latest first) to prove sorting happens.
      return UPCOMING;
    });
    const { result } = renderHook(() => useTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const ids = result.current.upcoming.map((t) => t.tourId);
    // t1 (Jul 5) should come before t2 (Jul 10).
    expect(ids).toEqual(['t1', 't2']);
  });

  it("upcoming keeps ONLY status='scheduled' - canceled/closed tours keep their scheduledAt and must not leak", async () => {
    // The window query matches on scheduledAt alone; these all fall in range.
    const windowRows = [
      { tourId: 'ok', tenantId: 'c1', unitId: 'u1', scheduledAt: '2026-07-20T14:00:00Z', tourType: 'self_guided', status: 'scheduled' },
      { tourId: 'cx', tenantId: 'c1', unitId: 'u1', scheduledAt: '2026-07-21T14:00:00Z', tourType: 'self_guided', status: 'canceled' },
      { tourId: 'cl', tenantId: 'c2', unitId: 'u2', scheduledAt: '2026-07-22T14:00:00Z', tourType: 'self_guided', status: 'closed' },
      { tourId: 'ns', tenantId: 'c2', unitId: 'u2', scheduledAt: '2026-07-23T14:00:00Z', tourType: 'self_guided', status: 'no_show' },
    ];
    getToursMock.mockImplementation(async (params: Record<string, string>) => {
      if (params['status'] === 'requested') return [];
      return windowRows;
    });
    const { result } = renderHook(() => useTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.upcoming.map((t) => t.tourId)).toEqual(['ok']);
  });

  it('sorts needs-booking tours by createdAt ascending (oldest first) — real camelCase wire field', async () => {
    // NEEDS_BOOKING arrives newest-first (r2 Jun 20, r1 Jun 10).
    // The sort must reorder to oldest-first (r1 Jun 10, r2 Jun 20).
    // Using the real camelCase field `createdAt` — a snake_case field would be undefined
    // for every item and the sort would be a no-op (vacuous pass).
    getToursMock.mockImplementation(async (params: Record<string, string>) => {
      if (params['status'] === 'requested') return NEEDS_BOOKING;
      return [];
    });
    const { result } = renderHook(() => useTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const ids = result.current.needsBooking.map((t) => t.tourId);
    // r1 (Jun 10 = older) must appear BEFORE r2 (Jun 20 = newer).
    expect(ids).toEqual(['r1', 'r2']);
  });

  it('sets status=error when a fetch fails', async () => {
    getToursMock.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useTours());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.upcoming).toHaveLength(0);
    expect(result.current.needsBooking).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// useClosedTours hook (the opt-in Closed section's lazy fetch)
// ---------------------------------------------------------------------------

describe('useClosedTours', () => {
  beforeEach(() => {
    getToursMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The closed fixtures arrive OLDEST-first so the newest-first sort assertion
  // below proves the comparator reorders; the canceled row's cancel (updatedAt)
  // falls BETWEEN them, proving the two status lists interleave by recency.
  const CLOSED = [
    { tourId: 'x1', tenantId: 'c1', unitId: 'u1', scheduledAt: '2026-06-02T18:00:00Z', tourType: 'self_guided', status: 'closed', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-02T19:00:00Z' },
    { tourId: 'x2', tenantId: 'c2', unitId: 'u2', scheduledAt: '2026-07-14T18:00:00Z', tourType: 'landlord_led', status: 'closed', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-14T20:00:00Z' },
  ];
  const CANCELED = [
    { tourId: 'k1', tenantId: 'c1', unitId: 'u2', scheduledAt: '2026-06-20T18:00:00Z', tourType: 'self_guided', status: 'canceled', createdAt: '2026-06-15T00:00:00Z', updatedAt: '2026-06-20T10:00:00Z' },
  ];

  it('stays idle and fetches NOTHING while disabled (the default page load)', () => {
    const { result } = renderHook(() => useClosedTours(false));
    expect(result.current.status).toBe('idle');
    expect(getToursMock).not.toHaveBeenCalled();
  });

  it('fetches closed AND canceled once enabled, interleaved newest first (updatedAt desc)', async () => {
    getToursMock.mockImplementation(async (params: Record<string, string>) =>
      params['status'] === 'closed' ? CLOSED : params['status'] === 'canceled' ? CANCELED : [],
    );
    const { result, rerender } = renderHook(({ enabled }) => useClosedTours(enabled), {
      initialProps: { enabled: false },
    });
    expect(getToursMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getToursMock).toHaveBeenCalledWith({ status: 'closed' }, expect.anything());
    expect(getToursMock).toHaveBeenCalledWith({ status: 'canceled' }, expect.anything());
    // x2 (Jul 14) > k1 (canceled Jun 20) > x1 (Jun 2) - one recency order.
    expect(result.current.closed.map((t) => t.tourId)).toEqual(['x2', 'k1', 'x1']);
  });

  it('sets status=error when the closed fetch fails', async () => {
    getToursMock.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useClosedTours(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.closed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Past tab (spec 4.2 / 4.3): window, selection, state chip, lazy hook
// ---------------------------------------------------------------------------

describe('pastToursDateRange', () => {
  it('from = start of the local day 90 calendar days ago; to = end of today local (DST-safe)', () => {
    const now = new Date('2026-09-26T15:30:00'); // local
    const { from, to } = pastToursDateRange(now);
    // Same calendar construction the implementation uses - not a millisecond
    // subtraction, which drifts by an hour across a DST change.
    const expectedFrom = new Date(2026, 8, 26 - 90, 0, 0, 0, 0);
    const expectedTo = new Date(2026, 8, 27, 0, 0, 0, 0).getTime() - 1;
    expect(new Date(from).getTime()).toBe(expectedFrom.getTime());
    expect(new Date(to).getTime()).toBe(expectedTo);
  });

  it('the Past window ends 1 ms before tomorrow starts, so the Active window (from = start of today) overlaps only today', () => {
    const now = new Date('2026-09-26T15:30:00');
    const activeFrom = new Date(toursDateRange(now).from).getTime();
    expect(new Date(pastToursDateRange(now).to).getTime()).toBeGreaterThan(activeFrom);
    expect(new Date(pastToursDateRange(now).to).getTime()).toBe(new Date(2026, 8, 27).getTime() - 1);
  });

  it('spans a DST change without an hour of drift (November)', () => {
    const now = new Date('2026-11-15T12:00:00'); // local; 90 days back crosses the fall change in US zones
    const { from } = pastToursDateRange(now);
    const d = new Date(from);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(new Date(2026, 10, 15 - 90).getDate());
  });
});

describe('selectPastTours', () => {
  /** A fixed "now": 2026-09-26 15:30 local. */
  const NOW = new Date(2026, 8, 26, 15, 30, 0, 0);
  const at = (y: number, m: number, d: number, h: number): string =>
    new Date(y, m - 1, d, h, 0, 0, 0).toISOString();
  const ROWS = [
    { tourId: 'ns', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 23, 14), tourType: 'self_guided', status: 'no_show' },
    { tourId: 'cx', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 24, 14), tourType: 'self_guided', status: 'canceled' },
    { tourId: 'sc', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 25, 14), tourType: 'self_guided', status: 'scheduled' },
    { tourId: 'cl', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 25, 15), tourType: 'self_guided', status: 'closed' },
    { tourId: 'tb', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 24, 16), tourType: 'self_guided', status: 'toured' },
    { tourId: 'ta', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 24, 16), tourType: 'self_guided', status: 'toured' },
    // A recorded not_a_fit left un-closed: decided, excluded.
    { tourId: 'to', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 22, 16), tourType: 'self_guided', status: 'toured', outcome: 'not_a_fit', moveForward: false },
    // A move_forward whose conversion never happened: Needs placement, kept.
    { tourId: 'np', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 21, 16), tourType: 'self_guided', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true },
    // A converted tour is closed by the conversion, but pin the rule anyway.
    { tourId: 'cv', tenantId: 'c2', unitId: 'u2', scheduledAt: at(2026, 9, 20, 16), tourType: 'self_guided', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true, convertedPlacementId: 'pl-1' },
    // Today: a still-scheduled 9:00 tour stays on Active; a toured 10:00, a
    // no-show 11:00 and a tour marked toured EARLY for 17:00 belong here.
    { tourId: 'sc-today', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 9), tourType: 'self_guided', status: 'scheduled' },
    { tourId: 't-today', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 10), tourType: 'self_guided', status: 'toured' },
    { tourId: 'ns-today', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 11), tourType: 'self_guided', status: 'no_show' },
    { tourId: 't-later', tenantId: 'c1', unitId: 'u1', scheduledAt: at(2026, 9, 26, 17), tourType: 'self_guided', status: 'toured' },
  ] as Tour[];

  it('keeps scheduled / toured / no_show only, drops a scheduled row dated today and a decided toured row, keeps a Needs-placement row, most recent first, ties by tourId', () => {
    expect(selectPastTours(ROWS, NOW).map((t) => t.tourId)).toEqual([
      't-later',
      'ns-today',
      't-today',
      'sc',
      'ta',
      'tb',
      'ns',
      'np',
    ]);
  });

  it('returns a new array and never mutates its input', () => {
    const input = [...ROWS];
    selectPastTours(input, NOW);
    expect(input.map((t) => t.tourId)).toEqual(ROWS.map((t) => t.tourId));
  });
});

// Today lists the Past tab's rows as they are, no-shows included (spec 9.4) -
// useTodayPastTours.test.tsx pins that end to end. What is left here is the cap.
describe('TODAY_PAST_TOURS_CAP (the Today page, Sam item 18)', () => {
  it('caps Today at five rows', () => {
    expect(TODAY_PAST_TOURS_CAP).toBe(5);
  });
});

describe('pastState', () => {
  const base = { tourId: 't', tenantId: 'c', unitId: 'u', tourType: 'self_guided' } as const;
  it('scheduled -> Not marked', () => {
    expect(pastState({ ...base, status: 'scheduled' } as Tour)).toBe('Not marked');
  });
  it('toured without an outcome -> Needs outcome', () => {
    expect(pastState({ ...base, status: 'toured' } as Tour)).toBe('Needs outcome');
  });
  it('toured, convertible, no placement -> Needs placement', () => {
    expect(pastState({ ...base, status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true } as Tour)).toBe('Needs placement');
  });
  it('no_show -> No show', () => {
    expect(pastState({ ...base, status: 'no_show' } as Tour)).toBe('No show');
  });
  it('anything else -> the status label (never blank)', () => {
    expect(pastState({ ...base, status: 'canceled' } as Tour)).toBe('Canceled');
  });
  it('precedence: a toured row with NO outcome reads Needs outcome even if it is convertible (an API-only shape)', () => {
    expect(pastState({ ...base, status: 'toured', convertible: true } as Tour)).toBe('Needs outcome');
  });
});

describe('selectOffRangeTours (spec 4.2a)', () => {
  /** A fixed "now": 2026-09-26 15:30 local. */
  const NOW = new Date(2026, 8, 26, 15, 30, 0, 0);
  const at = (y: number, m: number, d: number, h: number): string =>
    new Date(y, m - 1, d, h, 0, 0, 0).toISOString();
  const base = { tenantId: 'c1', unitId: 'u1', tourType: 'self_guided' } as const;
  const ROWS = [
    { ...base, tourId: 'u-old', status: 'toured', createdAt: at(2026, 9, 1, 9), updatedAt: at(2026, 9, 20, 9) },
    { ...base, tourId: 'u-new', status: 'toured', createdAt: at(2026, 9, 1, 9), updatedAt: at(2026, 9, 25, 9) },
    // Older than the 90-day window by its last touch: dropped.
    { ...base, tourId: 'u-expired', status: 'toured', createdAt: at(2026, 5, 1, 9), updatedAt: at(2026, 5, 2, 9) },
    // No updatedAt: its createdAt places it.
    { ...base, tourId: 'u-created-only', status: 'toured', createdAt: at(2026, 9, 10, 9) },
    // Decided: dropped.
    { ...base, tourId: 'u-outcome', status: 'toured', outcome: 'not_a_fit', moveForward: false, updatedAt: at(2026, 9, 24, 9) },
    // Move-forward never converted: kept (Needs placement).
    { ...base, tourId: 'u-np', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true, updatedAt: at(2026, 9, 22, 9) },
    // Dated inside the window: the range read owns it, so this read must not add it twice.
    { ...base, tourId: 'dated', status: 'toured', scheduledAt: at(2026, 9, 24, 10), updatedAt: at(2026, 9, 24, 12) },
    // Dated TODAY, later than now: still inside the window (it runs through
    // the end of today), so still the range read's.
    { ...base, tourId: 'dated-today', status: 'toured', scheduledAt: at(2026, 9, 26, 18), updatedAt: at(2026, 9, 26, 9) },
    // Not toured.
    { ...base, tourId: 'closed', status: 'closed', updatedAt: at(2026, 9, 25, 9) },
  ] as Tour[];

  it('keeps undated toured tours still needing a decision, inside the 90 days, most recently touched first', () => {
    expect(selectOffRangeTours(ROWS, NOW).map((t) => t.tourId)).toEqual(['u-new', 'u-np', 'u-old', 'u-created-only']);
  });

  it('also keeps a toured tour dated AFTER today (marked toured early) that still needs a decision, ordered by its last touch', () => {
    const input = [
      ...ROWS,
      // Tomorrow, marked toured today with no outcome: the range read cannot see it until tomorrow.
      { ...base, tourId: 'f-early', status: 'toured', scheduledAt: at(2026, 9, 27, 10), updatedAt: at(2026, 9, 26, 11) },
      // A mistyped year: far future, touched last week.
      { ...base, tourId: 'f-year', status: 'toured', scheduledAt: at(2027, 9, 21, 10), updatedAt: at(2026, 9, 21, 9) },
      // Future-dated but decided: dropped.
      { ...base, tourId: 'f-decided', status: 'toured', outcome: 'not_a_fit', moveForward: false, scheduledAt: at(2026, 9, 28, 10), updatedAt: at(2026, 9, 26, 12) },
      // Future-dated and still scheduled: Active's Upcoming shows it, never Past.
      { ...base, tourId: 'f-scheduled', status: 'scheduled', scheduledAt: at(2026, 9, 28, 10), updatedAt: at(2026, 9, 26, 12) },
    ] as Tour[];
    expect(selectOffRangeTours(input, NOW).map((t) => t.tourId)).toEqual([
      'f-early', 'u-new', 'u-np', 'f-year', 'u-old', 'u-created-only',
    ]);
  });

  it('breaks a tie by tourId and never mutates its input', () => {
    const same = at(2026, 9, 25, 9);
    const input = [
      { ...base, tourId: 'b', status: 'toured', updatedAt: same },
      { ...base, tourId: 'a', status: 'toured', updatedAt: same },
    ] as Tour[];
    expect(selectOffRangeTours(input, NOW).map((t) => t.tourId)).toEqual(['a', 'b']);
    expect(input.map((t) => t.tourId)).toEqual(['b', 'a']);
  });
});

describe('usePastTours', () => {
  beforeEach(() => {
    getToursMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const yesterdayAt = (h: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const WINDOW_ROWS = [
    { tourId: 'sc', tenantId: 'c1', unitId: 'u1', scheduledAt: yesterdayAt(14), tourType: 'self_guided', status: 'scheduled' },
    { tourId: 'cx', tenantId: 'c1', unitId: 'u1', scheduledAt: yesterdayAt(10), tourType: 'self_guided', status: 'canceled' },
  ];
  // The toured-status read: one undated row (listed LAST) and one dated row
  // the range read already owns (must not be duplicated).
  const TOURED_ROWS = [
    { tourId: 'und', tenantId: 'c1', unitId: 'u1', tourType: 'self_guided', status: 'toured', updatedAt: yesterdayAt(9) },
    { tourId: 'sc-t', tenantId: 'c1', unitId: 'u1', scheduledAt: yesterdayAt(8), tourType: 'self_guided', status: 'toured', updatedAt: yesterdayAt(9) },
  ];
  /** Answers each of the hook's two reads with its own rows. */
  function answer(range: unknown[], toured: unknown[]): void {
    getToursMock.mockImplementation(async (params: Record<string, string>) =>
      params['status'] === 'toured' ? toured : range,
    );
  }

  it('stays idle and fetches NOTHING while disabled', () => {
    const { result } = renderHook(() => usePastTours(false));
    expect(result.current.status).toBe('idle');
    expect(getToursMock).not.toHaveBeenCalled();
  });

  it('once enabled, makes the range read (through end of today) AND the toured-status read; dated rows first, undated last', async () => {
    answer(WINDOW_ROWS, TOURED_ROWS);
    const { result } = renderHook(() => usePastTours(true));
    // No synchronous 'loading' write (the lint preset forbids setState in an
    // effect body): the hook reads 'idle' until the first result lands.
    expect(result.current.status).toBe('idle');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getToursMock).toHaveBeenCalledTimes(2);
    const calls = getToursMock.mock.calls.map(([p]) => p as Record<string, string>);
    const range = calls.find((p) => p['from'] !== undefined)!;
    expect(Object.keys(range).sort()).toEqual(['from', 'to']);
    const n = new Date();
    const endOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 0).getTime() - 1;
    expect(new Date(range['to']!).getTime()).toBe(endOfToday);
    expect(new Date(range['from']!).getTime()).toBe(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 90, 0, 0, 0, 0).getTime());
    expect(calls.find((p) => p['status'] !== undefined)).toEqual({ status: 'toured' });
    // sc-t is dated, so only the range read could list it; this fixture's range
    // read does not, so it must not appear from the status read either.
    expect(result.current.past.map((t) => t.tourId)).toEqual(['sc', 'und']);
  });

  it('reload() refetches BOTH reads and keeps the current rows on screen until the new page lands', async () => {
    answer(WINDOW_ROWS, TOURED_ROWS);
    const { result } = renderHook(() => usePastTours(true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    answer([], []);
    act(() => result.current.reload());
    // Still ready with the old rows while the refetch is in flight.
    expect(result.current.status).toBe('ready');
    expect(result.current.past.map((t) => t.tourId)).toEqual(['sc', 'und']);
    await waitFor(() => expect(getToursMock).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(result.current.past).toEqual([]));
  });

  it('sets status=error when the FIRST load fails (either read)', async () => {
    getToursMock.mockImplementation(async (params: Record<string, string>) => {
      if (params['status'] === 'toured') throw new Error('network error');
      return WINDOW_ROWS;
    });
    const { result } = renderHook(() => usePastTours(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.past).toEqual([]);
    expect(result.current.reloadFailed).toBe(false);
  });

  it('a failed RELOAD keeps the rows, stays ready and sets reloadFailed; the next success clears it', async () => {
    answer(WINDOW_ROWS, TOURED_ROWS);
    const { result } = renderHook(() => usePastTours(true));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getToursMock.mockRejectedValueOnce(new Error('network error'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.reloadFailed).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(result.current.past.map((t) => t.tourId)).toEqual(['sc', 'und']);
    answer([], []);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.reloadFailed).toBe(false));
    expect(result.current.past).toEqual([]);
  });
});
