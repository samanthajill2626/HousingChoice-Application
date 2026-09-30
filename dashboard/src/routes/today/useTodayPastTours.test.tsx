// useTodayPastTours - the Today page's past-tours section (Sam's item 18).
// The fetch and the selection are the Past tab's own (usePastTours), so these
// tests drive the api barrel's getTours and pin what Today adds: no-shows off,
// a cap of five with the full count, the Past order, point-read names, a
// soft-deleted tenant skipped (the walk continues past it), a failed lookup
// kept under its id, a first-load failure isolated to the section, and a
// tour.updated event reloading the rows.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, Tour, UnitItem } from '../../api/index.js';

const getTours = vi.fn();
const getContact = vi.fn();
const getUnit = vi.fn();
let lastHandlers: { onTourUpdated?: (e: { tourId: string; status: string }) => void } = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTours: (...a: unknown[]) => getTours(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useTodayPastTours } from './useTodayPastTours.js';

/** `daysAgo` days before today at 10:00 local. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

function tour(tourId: string, n: number, over: Partial<Tour> = {}): Tour {
  return {
    tourId,
    tenantId: `c-${tourId}`,
    unitId: `u-${tourId}`,
    scheduledAt: daysAgo(n),
    tourType: 'self_guided',
    status: 'toured',
    ...over,
  } as Tour;
}

/** The range read returns `range`; the status=toured read returns nothing. */
function serveTours(range: Tour[]): void {
  getTours.mockImplementation((params: { status?: string }) =>
    Promise.resolve(params.status === 'toured' ? [] : range),
  );
}

function contactFor(id: string, over: Partial<Contact> = {}): Contact {
  return { contactId: id, firstName: `Name ${id}`, lastName: 'Tenant', phone: '+15550100001', ...over } as Contact;
}

beforeEach(() => {
  getTours.mockReset();
  getContact.mockReset().mockImplementation((id: string) => Promise.resolve(contactFor(id)));
  getUnit
    .mockReset()
    .mockImplementation((id: string) => Promise.resolve({ unitId: id, address: `${id} Main St` } as UnitItem));
  lastHandlers = {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTodayPastTours', () => {
  it('lists the Past rows minus no-shows, most recent first, with names and addresses', async () => {
    serveTours([
      tour('old', 5),
      tour('ns', 2, { status: 'no_show' }),
      tour('new', 1, { status: 'scheduled' }),
    ]);
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows.map((r) => r.tour.tourId)).toEqual(['new', 'old']);
    // The "See all N" count is the Past tab's: it lists the no-show too.
    expect(result.current.total).toBe(3);
    expect(result.current.rows[0]).toMatchObject({ tenant: 'Name c-new Tenant', property: 'u-new Main St' });
    // Only the listed rows are looked up - never the no-show's tenant.
    expect(getContact).not.toHaveBeenCalledWith('c-ns', expect.anything());
  });

  it('shows at most five rows and reports the Past tab count for "See all N"', async () => {
    serveTours(Array.from({ length: 7 }, (_, i) => tour(`t${i}`, i + 1)));
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows.map((r) => r.tour.tourId)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(result.current.total).toBe(7);
    // Five tenants and five properties, not seven.
    expect(getContact).toHaveBeenCalledTimes(5);
    expect(getUnit).toHaveBeenCalledTimes(5);
  });

  it('skips a soft-deleted tenant and keeps walking to fill the section', async () => {
    serveTours(Array.from({ length: 7 }, (_, i) => tour(`t${i}`, i + 1)));
    getContact.mockImplementation((id: string) =>
      Promise.resolve(contactFor(id, id === 'c-t1' ? { deleted_at: '2026-09-01T00:00:00Z' } : {})),
    );
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows.map((r) => r.tour.tourId)).toEqual(['t0', 't2', 't3', 't4', 't5']);
    // The count is the Past tab's (it lists the deleted tenant's tour).
    expect(result.current.total).toBe(7);
  });

  it('keeps a row whose lookups fail, labeled by id (a failure is not a deletion)', async () => {
    serveTours([tour('a', 1)]);
    getContact.mockRejectedValue(new Error('boom'));
    getUnit.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]).toMatchObject({ tenant: 'c-a', property: 'u-a' });
  });

  it('reads the same two lists as the Past tab: the 90-day range and status=toured', async () => {
    serveTours([]);
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.rows).toEqual([]);
    expect(getTours).toHaveBeenCalledTimes(2);
    expect(getTours).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      expect.anything(),
    );
    expect(getTours).toHaveBeenCalledWith({ status: 'toured' }, expect.anything());
  });

  it('a failed first load is the section error, with no rows', async () => {
    getTours.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.rows).toEqual([]);
  });

  it('a tour.updated event reloads the rows', async () => {
    serveTours([tour('a', 1), tour('b', 2)]);
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(getTours).toHaveBeenCalledTimes(2);

    // Tour a gets its outcome: the next load no longer has it.
    serveTours([tour('b', 2)]);
    act(() => {
      lastHandlers.onTourUpdated?.({ tourId: 'a', status: 'closed' });
    });
    await waitFor(() => expect(result.current.rows.map((r) => r.tour.tourId)).toEqual(['b']));
    expect(getTours).toHaveBeenCalledTimes(4);
  });

  it('debounces: events 200ms apart reload once, 300ms after the LAST one', async () => {
    serveTours([tour('a', 1)]);
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getTours).toHaveBeenCalledTimes(2);

    vi.useRealTimers(); // release the global Date pin (test/setup.ts) first
    vi.useFakeTimers();
    act(() => {
      lastHandlers.onTourUpdated?.({ tourId: 'a', status: 'toured' });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => {
      lastHandlers.onTourUpdated?.({ tourId: 'a', status: 'toured' });
    });
    // 400ms after the first event, 200ms after the second: still inside the
    // window the second one restarted, so nothing has reloaded.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(getTours).toHaveBeenCalledTimes(2);
    // Past 300ms after the second event: exactly one reload (its two reads).
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(getTours).toHaveBeenCalledTimes(4);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getTours).toHaveBeenCalledTimes(4);
  });
});

describe('useTodayPastTours - round-2 review fixes', () => {
  it('a live reload reuses names it already looked up (N3)', async () => {
    serveTours([tour('a', 1), tour('b', 2)]);
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(getContact).toHaveBeenCalledTimes(2);
    expect(getUnit).toHaveBeenCalledTimes(2);

    act(() => {
      lastHandlers.onTourUpdated?.({ tourId: 'a', status: 'toured' });
    });
    await waitFor(() => expect(getTours).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(getContact).toHaveBeenCalledTimes(2);
    expect(getUnit).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup is not cached: the next reload asks again', async () => {
    serveTours([tour('a', 1)]);
    getContact.mockRejectedValueOnce(new Error('blip'));
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.rows[0]?.tenant).toBe('c-a'));

    act(() => {
      lastHandlers.onTourUpdated?.({ tourId: 'a', status: 'toured' });
    });
    await waitFor(() => expect(result.current.rows[0]?.tenant).toBe('Name c-a Tenant'));
    expect(getContact).toHaveBeenCalledTimes(2);
  });

  it('a failed live reload keeps the rows and sets reloadFailed (N6)', async () => {
    serveTours([tour('a', 1)]);
    const { result } = renderHook(() => useTodayPastTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.reloadFailed).toBe(false);

    getTours.mockRejectedValue(new Error('down'));
    act(() => {
      lastHandlers.onTourUpdated?.({ tourId: 'a', status: 'toured' });
    });
    await waitFor(() => expect(result.current.reloadFailed).toBe(true));
    expect(result.current.status).toBe('ready');
    expect(result.current.rows.map((r) => r.tour.tourId)).toEqual(['a']);
  });
});
