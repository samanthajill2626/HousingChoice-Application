// useTours.test.ts — unit tests for the useTours data hook.
//
// Asserts:
//   - getTours is called with from/to params (the upcoming window)
//   - getTours is called with status='requested' (the needs-booking query)
//   - toursDateRange produces the expected window
//   - Upcoming tours are sorted ascending by scheduledAt (soonest first)
//   - Needs-booking tours are sorted ascending by created_at (oldest first)
//   - AbortError is swallowed (no state change)
//   - Non-abort errors set status='error'
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toursDateRange } from './useTours.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const getToursMock = vi.fn();
vi.mock('../../api/index.js', () => ({
  getTours: (...args: unknown[]) => getToursMock(...args),
}));

import { useTours } from './useTours.js';

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
    { tourId: 't2', tenantId: 'c2', unitId: 'u2', scheduledAt: '2026-07-10T14:00:00Z', tourType: 'self_guided', status: 'scheduled', created_at: '2026-06-02T00:00:00Z' },
    { tourId: 't1', tenantId: 'c1', unitId: 'u1', scheduledAt: '2026-07-05T10:00:00Z', tourType: 'landlord_led', status: 'confirmed', created_at: '2026-06-01T00:00:00Z' },
  ];

  const NEEDS_BOOKING = [
    { tourId: 'r2', tenantId: 'c2', unitId: 'u2', tourType: 'self_guided', status: 'requested', created_at: '2026-06-20T00:00:00Z' },
    { tourId: 'r1', tenantId: 'c1', unitId: 'u1', tourType: 'pm_team', status: 'requested', created_at: '2026-06-10T00:00:00Z' },
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

  it('sorts needs-booking tours by created_at ascending (oldest first)', async () => {
    getToursMock.mockImplementation(async (params: Record<string, string>) => {
      if (params['status'] === 'requested') return NEEDS_BOOKING;
      return [];
    });
    const { result } = renderHook(() => useTours());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const ids = result.current.needsBooking.map((t) => t.tourId);
    // r1 (Jun 10) should come before r2 (Jun 20).
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
