// useRoster tests - the ONE roster fetch both hubs share (plan Task 8,
// adjudication A14). Neither hub page subscribes to conversation.updated at page
// level, so this hook subscribes for itself: tours listen on tour.updated,
// placements on placement.updated, and BOTH listen on conversation.updated for
// their own group thread (a member added to the live group changes the roster).
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationUpdatedEvent,
  EventStreamHandlers,
  PlacementUpdatedEvent,
  RosterView,
  TourUpdatedEvent,
} from '../../api/index.js';

const getTourRoster = vi.fn();
const getPlacementRoster = vi.fn();
let streamHandlers: EventStreamHandlers[] = [];

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTourRoster: (...a: unknown[]) => getTourRoster(...a),
    getPlacementRoster: (...a: unknown[]) => getPlacementRoster(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers.push(h);
    },
  };
});

import { useRoster } from './useRoster.js';

const ROSTER: RosterView = {
  source: 'default',
  members: [{ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha', role: 'tenant', reachability: 'reachable' }],
  customized: false,
  tenantOnRoster: true,
  canOpenGroup: false,
  threadExists: false,
};

/** Fire an event at every registered subscriber (the provider's job). */
function emitTour(ev: TourUpdatedEvent): void {
  act(() => {
    for (const h of streamHandlers) h.onTourUpdated?.(ev);
  });
}
function emitPlacement(ev: PlacementUpdatedEvent): void {
  act(() => {
    for (const h of streamHandlers) h.onPlacementUpdated?.(ev);
  });
}
function emitConversation(conversationId: string): void {
  act(() => {
    for (const h of streamHandlers)
      h.onConversationUpdated?.({ conversationId } as ConversationUpdatedEvent);
  });
}

beforeEach(() => {
  getTourRoster.mockReset().mockResolvedValue(ROSTER);
  getPlacementRoster.mockReset().mockResolvedValue(ROSTER);
  streamHandlers = [];
});

describe('useRoster', () => {
  it('loads the tour roster: loading -> ready', async () => {
    const { result } = renderHook(() => useRoster({ type: 'tour', id: 'tour-1' }));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.roster).toEqual(ROSTER);
    expect(getTourRoster).toHaveBeenCalledWith('tour-1', expect.anything());
  });

  it('reports error on a failed fetch, and refetch() retries', async () => {
    getTourRoster.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useRoster({ type: 'tour', id: 'tour-1' }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.roster).toBeNull();
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('refetches on tour.updated for THIS tour only', async () => {
    const { result } = renderHook(() => useRoster({ type: 'tour', id: 'tour-1' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getTourRoster.mockClear();

    emitTour({ tourId: 'tour-other', status: 'scheduled' });
    emitTour({ tourId: 'tour-1', status: 'scheduled' });
    await waitFor(() => expect(getTourRoster).toHaveBeenCalledTimes(1));
  });

  it('refetches on conversation.updated for its OWN group thread only', async () => {
    const { result } = renderHook(() =>
      useRoster({ type: 'tour', id: 'tour-1', threadId: 'conv-group' }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getTourRoster.mockClear();

    emitConversation('conv-elsewhere');
    emitConversation('conv-group');
    await waitFor(() => expect(getTourRoster).toHaveBeenCalledTimes(1));
  });

  it('placements read the placement endpoint and follow placement.updated', async () => {
    const { result } = renderHook(() => useRoster({ type: 'placement', id: 'pl-1' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getPlacementRoster).toHaveBeenCalledWith('pl-1', expect.anything());
    expect(getTourRoster).not.toHaveBeenCalled();
    getPlacementRoster.mockClear();

    emitPlacement({ placementId: 'pl-1' } as PlacementUpdatedEvent);
    await waitFor(() => expect(getPlacementRoster).toHaveBeenCalledTimes(1));
  });

  it('refetches when the group-thread pointer appears (the source flips to participants)', async () => {
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId?: string }) =>
        useRoster({ type: 'tour', id: 'tour-1', ...(threadId !== undefined && { threadId }) }),
      { initialProps: {} as { threadId?: string } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getTourRoster.mockClear();

    rerender({ threadId: 'conv-group' });
    await waitFor(() => expect(getTourRoster).toHaveBeenCalledTimes(1));
  });
});
