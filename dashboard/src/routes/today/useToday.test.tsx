import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { PlacementsPage, ConversationsPage, TodayResponse } from '../../api/index.js';

// Mock the api barrel: stub the three fetchers + capture the SSE handlers so the
// test can drive a live event. ApiError is re-exported real.
const getToday = vi.fn();
const getPlacements = vi.fn();
const getConversations = vi.fn();
const getTours = vi.fn();
let lastHandlers: { onPlacementUpdated?: () => void; onConversationUpdated?: () => void } = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getToday: (...a: unknown[]) => getToday(...a),
    getPlacements: (...a: unknown[]) => getPlacements(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getTours: (...a: unknown[]) => getTours(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useToday } from './useToday.js';

function Probe(): React.JSX.Element {
  const { status, items, source } = useToday();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="source">{source}</span>
      <span data-testid="count">{items.length}</span>
      <span data-testid="first">{items[0]?.who ?? ''}</span>
    </div>
  );
}

const TODAY: TodayResponse = {
  generatedAt: '2026-06-16T12:00:00Z',
  items: [
    { group: 'needs_you_now', refType: 'placement', refId: 'k1', who: 'Server Tasha', why: 'RTA' },
  ],
};

const CASES: PlacementsPage = {
  nextCursor: null,
  placements: [
    {
      placementId: 'k9',
      tenantId: 'Fallback Tenant',
      unitId: 'u9',
      stage: 'schedule_inspection',
      next_deadline_type: 'rta_window',
      next_deadline_at: '2999-01-01T00:00:00Z',
    },
  ],
};
const CONVERSATIONS: ConversationsPage = { nextCursor: null, conversations: [] };

beforeEach(() => {
  getToday.mockReset();
  getPlacements.mockReset();
  getConversations.mockReset();
  getTours.mockReset();
  getTours.mockResolvedValue([]); // fallback default: no tours today
  lastHandlers = {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useToday', () => {
  it('uses the server endpoint when /api/today succeeds', async () => {
    getToday.mockResolvedValue(TODAY);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('source')).toHaveTextContent('server');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('first')).toHaveTextContent('Server Tasha');
    expect(getPlacements).not.toHaveBeenCalled();
    // The browser owns "today": the server call carries the operator's LOCAL
    // calendar day (YYYY-MM-DD) AND its local-day boundary instants (the
    // toursFrom/toursTo window for the Tour-entity tours_today group).
    expect(getToday).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.anything(),
      expect.objectContaining({
        from: expect.stringMatching(/T.*Z$/),
        to: expect.stringMatching(/T.*Z$/),
      }),
    );
  });

  it('falls back to placements+conversations+tours on a 404', async () => {
    getToday.mockRejectedValue(new ApiError(404, 'not_found', 'no'));
    getPlacements.mockResolvedValue(CASES);
    getConversations.mockResolvedValue(CONVERSATIONS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('source')).toHaveTextContent('fallback');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('first')).toHaveTextContent('Fallback Tenant');
    // The fallback fetches today's tours with the local-day window.
    expect(getTours).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      expect.anything(),
    );
  });

  it('fallback folds a Tour entity scheduled today into tours_today', async () => {
    getToday.mockRejectedValue(new ApiError(404, 'not_found', 'no'));
    getPlacements.mockResolvedValue({ nextCursor: null, placements: [] });
    getConversations.mockResolvedValue(CONVERSATIONS);
    const now = new Date();
    const twoPmLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0, 0);
    getTours.mockResolvedValue([
      {
        tourId: 'tour-x',
        tenantId: 'Tour Tenant',
        unitId: 'u-x',
        tourType: 'self_guided',
        status: 'scheduled',
        scheduledAt: twoPmLocal.toISOString(),
      },
    ]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('source')).toHaveTextContent('fallback');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('first')).toHaveTextContent('Tour Tenant');
  });

  it('surfaces error status when the fallback itself fails', async () => {
    getToday.mockRejectedValue(new ApiError(404, 'not_found', 'no'));
    getPlacements.mockRejectedValue(new ApiError(500, 'boom', 'server error'));
    getConversations.mockResolvedValue(CONVERSATIONS);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('surfaces error status when /api/today fails with a non-404', async () => {
    getToday.mockRejectedValue(new ApiError(500, 'boom', 'server error'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(getPlacements).not.toHaveBeenCalled();
  });

  it('refetches when a placement.updated event arrives', async () => {
    getToday.mockResolvedValue(TODAY);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getToday).toHaveBeenCalledTimes(1);

    getToday.mockResolvedValue({
      ...TODAY,
      items: [{ group: 'needs_you_now', refType: 'placement', refId: 'k2', who: 'Updated', why: 'x' }],
    });
    lastHandlers.onPlacementUpdated?.();
    await waitFor(() => expect(screen.getByTestId('first')).toHaveTextContent('Updated'));
    expect(getToday).toHaveBeenCalledTimes(2);
  });
});
