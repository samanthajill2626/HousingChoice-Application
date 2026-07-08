// useTourActivity tests - the Activity trail hook: initial page, load-more via the
// `before` cursor, and a tour.updated refetch. Mirrors usePlacementHistory's tests.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStreamHandlers, TourActivityEvent } from '../../api/index.js';

const getTourActivity = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTourActivity: (...a: unknown[]) => getTourActivity(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { useTourActivity } from './useTourActivity.js';

function row(i: number): TourActivityEvent {
  return { id: `2026-07-01T00:00:0${i}Z#${i}`, at: `2026-07-01T00:00:0${i}Z`, type: 'tour_scheduled' };
}
const page20 = (): TourActivityEvent[] => Array.from({ length: 20 }, (_v, i) => row(i));

function Probe({ tourId }: { tourId: string }): React.JSX.Element {
  const s = useTourActivity(tourId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="more">{String(s.hasMore)}</span>
      <button type="button" onClick={s.loadMore}>
        more
      </button>
    </div>
  );
}

beforeEach(() => {
  getTourActivity.mockReset();
  streamHandlers = null;
});
afterEach(() => vi.restoreAllMocks());

describe('useTourActivity', () => {
  it('loads the initial page; hasMore when it is full (=20)', async () => {
    getTourActivity.mockResolvedValue(page20());
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('20');
    expect(screen.getByTestId('more')).toHaveTextContent('true');
  });

  it('a short first page -> no load-more', async () => {
    getTourActivity.mockResolvedValue([row(0)]);
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(screen.getByTestId('more')).toHaveTextContent('false');
  });

  it('loadMore pages older via the `before` cursor (the last row id)', async () => {
    getTourActivity.mockResolvedValueOnce(page20());
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('20'));

    getTourActivity.mockResolvedValueOnce([row(0), row(1)]);
    await userEvent.click(screen.getByRole('button', { name: 'more' }));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('22'));
    // The second call carries before = the 20th row's id (row(19)).
    expect(getTourActivity).toHaveBeenLastCalledWith(
      't1',
      { limit: 20, before: row(19).id },
      expect.anything(),
    );
    expect(screen.getByTestId('more')).toHaveTextContent('false');
  });

  it('refetches on a tour.updated for THIS tour, ignores others', async () => {
    getTourActivity.mockResolvedValue([row(0)]);
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getTourActivity).toHaveBeenCalledTimes(1);

    act(() => streamHandlers?.onTourUpdated?.({ tourId: 'other', status: 'toured' }));
    expect(getTourActivity).toHaveBeenCalledTimes(1);

    act(() => streamHandlers?.onTourUpdated?.({ tourId: 't1', status: 'toured' }));
    await waitFor(() => expect(getTourActivity).toHaveBeenCalledTimes(2));
  });
});
