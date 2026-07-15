// usePlacementNudges hook tests - the ONE shared nudge-ladder fetch lifted out of
// DeadlinesNudgesCard (Task 9) so the Now card + Deadlines card share it. Covers
// the behavior that MOVED here from the card's own test: fetch on mount, the
// scheduled.updated live refetch, and the busyId single-flight cancel/restore
// (PATCH {canceled} then refetch the honest ladder). vitest footgun: mockReset
// (not just clearAllMocks) when reusing a mockResolvedValueOnce queue.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { EventStreamHandlers, PlacementNudgeView } from '../../api/index.js';

const getPlacementNudges = vi.fn();
const patchPlacementNudge = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacementNudges: (...a: unknown[]) => getPlacementNudges(...a),
    patchPlacementNudge: (...a: unknown[]) => patchPlacementNudge(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { usePlacementNudges } from './usePlacementNudges.js';

function nudge(over: Partial<PlacementNudgeView> = {}): PlacementNudgeView {
  return {
    nudgeId: 'n-1',
    placementId: 'p1',
    kind: 'receipt_check',
    recipient: 'tenant',
    dueAt: '2999-01-01T12:00:00Z',
    state: 'upcoming',
    ...over,
  };
}

beforeEach(() => {
  getPlacementNudges.mockReset().mockResolvedValue([]);
  patchPlacementNudge.mockReset().mockResolvedValue(nudge());
  streamHandlers = null;
});

it('fetches the ladder on mount and exposes it (loading clears)', async () => {
  getPlacementNudges.mockResolvedValue([nudge({ nudgeId: 'n-1', kind: 'receipt_check' })]);
  const { result } = renderHook(() => usePlacementNudges('p1'));
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(getPlacementNudges).toHaveBeenCalledWith('p1', expect.anything());
  expect(result.current.nudges).toHaveLength(1);
});

it('refetches on a scheduled.updated event', async () => {
  getPlacementNudges.mockResolvedValueOnce([]);
  const { result } = renderHook(() => usePlacementNudges('p1'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(getPlacementNudges).toHaveBeenCalledTimes(1);

  getPlacementNudges.mockResolvedValueOnce([nudge({ nudgeId: 'n-9' })]);
  act(() => streamHandlers?.onScheduledUpdated?.({}));
  await waitFor(() => expect(getPlacementNudges).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.nudges).toHaveLength(1));
});

it('toggleCanceled PATCHes {canceled:true} for an upcoming rung, then refetches', async () => {
  getPlacementNudges
    .mockResolvedValueOnce([nudge({ nudgeId: 'n-c', state: 'upcoming' })])
    .mockResolvedValue([nudge({ nudgeId: 'n-c', state: 'canceled', canceledAt: '2026-07-14T10:00:00Z' })]);
  const { result } = renderHook(() => usePlacementNudges('p1'));
  await waitFor(() => expect(result.current.nudges).toHaveLength(1));

  act(() => result.current.toggleCanceled(nudge({ nudgeId: 'n-c', state: 'upcoming' })));
  await waitFor(() => expect(patchPlacementNudge).toHaveBeenCalledWith('p1', 'n-c', true));
  await waitFor(() => expect(result.current.nudges[0]?.state).toBe('canceled'));
});

it('toggleCanceled PATCHes {canceled:false} for a canceled rung (restore)', async () => {
  getPlacementNudges.mockResolvedValue([nudge({ nudgeId: 'n-c', state: 'canceled' })]);
  const { result } = renderHook(() => usePlacementNudges('p1'));
  await waitFor(() => expect(result.current.nudges).toHaveLength(1));

  act(() => result.current.toggleCanceled(nudge({ nudgeId: 'n-c', state: 'canceled' })));
  await waitFor(() => expect(patchPlacementNudge).toHaveBeenCalledWith('p1', 'n-c', false));
});

it('single-flights: a second toggle while busy is ignored', async () => {
  getPlacementNudges.mockResolvedValue([nudge({ nudgeId: 'n-c', state: 'upcoming' })]);
  let release: () => void = () => {};
  patchPlacementNudge.mockReturnValue(
    new Promise<PlacementNudgeView>((resolve) => {
      release = () => resolve(nudge({ nudgeId: 'n-c', state: 'canceled' }));
    }),
  );
  const { result } = renderHook(() => usePlacementNudges('p1'));
  await waitFor(() => expect(result.current.nudges).toHaveLength(1));

  act(() => result.current.toggleCanceled(nudge({ nudgeId: 'n-c', state: 'upcoming' })));
  await waitFor(() => expect(result.current.busyId).toBe('n-c'));
  // A second click while the first PATCH is in flight is a no-op.
  act(() => result.current.toggleCanceled(nudge({ nudgeId: 'n-c', state: 'upcoming' })));
  expect(patchPlacementNudge).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() => expect(result.current.busyId).toBeNull());
});

it('surfaces a fetch error', async () => {
  getPlacementNudges.mockReset();
  getPlacementNudges.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
  const { result } = renderHook(() => usePlacementNudges('p1'));
  await waitFor(() => expect(result.current.error).not.toBeNull());
});
