import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementUpdatedEvent, EventStreamHandlers, HistoryRow } from '../../api/index.js';

const getPlacementHistory = vi.fn();
// Capture the handlers usePlacementHistory registers so a test can fire placement.updated.
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacementHistory: (...a: unknown[]) => getPlacementHistory(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { usePlacementHistory } from './usePlacementHistory.js';

function row(over: Partial<HistoryRow>): HistoryRow {
  return { entityKey: 'placement#c1', event_type: 'stage_changed', ts: '2026-06-18T13:00:00Z', ...over };
}

function Probe({ placementId }: { placementId: string }): React.JSX.Element {
  const s = usePlacementHistory(placementId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="types">{s.rows.map((r) => r.event_type).join(',')}</span>
    </div>
  );
}

const evt = (placementId: string): PlacementUpdatedEvent => ({
  placementId,
  tenantId: 't1',
  unitId: 'u1',
  stage: 'schedule_inspection',
  tour_date: null,
  next_deadline_type: null,
  next_deadline_at: null,
  group_thread: null,
  attention: false,
  lost_reason: null,
  updated_at: null,
});

beforeEach(() => {
  getPlacementHistory.mockReset();
  streamHandlers = null;
});
afterEach(() => vi.restoreAllMocks());

describe('usePlacementHistory', () => {
  it('loads the initial newest page', async () => {
    getPlacementHistory.mockResolvedValue([row({ event_type: 'created' })]);
    render(<Probe placementId="c1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(getPlacementHistory).toHaveBeenCalledTimes(1);
  });

  it('refetches the newest page when a placement.updated event for this placement arrives', async () => {
    getPlacementHistory.mockResolvedValueOnce([row({ event_type: 'created' })]);
    render(<Probe placementId="c1" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    // A transition lands → the SSE event fires → the panel refetches, now showing
    // the new audit row WITHOUT a manual reload.
    getPlacementHistory.mockResolvedValueOnce([
      row({ event_type: 'stage_changed' }),
      row({ event_type: 'created' }),
    ]);
    act(() => streamHandlers?.onPlacementUpdated?.(evt('c1')));

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('types')).toHaveTextContent('stage_changed,created');
    expect(getPlacementHistory).toHaveBeenCalledTimes(2);
  });

  it('ignores a placement.updated event for a different placement', async () => {
    getPlacementHistory.mockResolvedValue([row({ event_type: 'created' })]);
    render(<Probe placementId="c1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    act(() => streamHandlers?.onPlacementUpdated?.(evt('other-placement')));
    // No refetch for an unrelated placement.
    expect(getPlacementHistory).toHaveBeenCalledTimes(1);
  });
});
