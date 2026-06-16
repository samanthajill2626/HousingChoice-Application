// BroadcastResults tests — render stats + per-recipient delivery, a live
// broadcast.updated SSE patch, and the manual Refresh. Mock getBroadcastResults
// + useEventStream (capture handlers); keep useApi + ApiError real. No network.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BroadcastResults as BroadcastResultsData, EventStreamHandlers } from '../../api';

const api = vi.hoisted(() => ({
  getBroadcastResults: vi.fn(),
  eventHandlers: { current: undefined as EventStreamHandlers | undefined },
}));

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return {
    ...actual,
    getBroadcastResults: api.getBroadcastResults,
    useEventStream: (handlers: EventStreamHandlers) => {
      api.eventHandlers.current = handlers;
    },
  };
});

const { default: BroadcastResults } = await import('./BroadcastResults');

function results(over: Partial<BroadcastResultsData> = {}): BroadcastResultsData {
  return {
    broadcastId: 'b1',
    status: 'sending',
    unitId: 'u1',
    audience_filter: {
      contact_type: 'tenant',
      excludeOptedOut: true,
      excludeUnreachable: true,
    },
    stats: { audience: 3, sent: 1, delivered: 0, failed: 0, skipped_opted_out: 0, queued: 2 },
    recipients: {
      c1: { status: 'sent' },
      'phone#+13135550002': { status: 'queued' },
      c3: { status: 'skipped' },
    },
    created_at: '2026-06-14T00:00:00Z',
    ...over,
  };
}

function renderScreen(): void {
  render(
    <MemoryRouter initialEntries={['/broadcasts/b1']}>
      <Routes>
        <Route path="/broadcasts/:id" element={<BroadcastResults />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.getBroadcastResults.mockReset();
  api.eventHandlers.current = undefined;
});

describe('<BroadcastResults>', () => {
  it('renders the stat chips and per-recipient delivery', async () => {
    api.getBroadcastResults.mockResolvedValue(results());
    renderScreen();

    expect(await screen.findByText('Broadcast results')).toBeInTheDocument();
    const stats = screen.getByLabelText('Broadcast statistics');
    // Audience chip value.
    expect(within(stats).getByText('Audience').closest('div')).toHaveTextContent('3');

    const recipients = screen.getByLabelText('Per-recipient delivery');
    // phone# key resolves to a formatted phone (honest identity).
    expect(within(recipients).getByText('(313) 555-0002')).toBeInTheDocument();
    // The skipped recipient renders a Skipped badge (no delivery peer).
    expect(within(recipients).getByText('Skipped')).toBeInTheDocument();
    // The sent recipient renders the shared DeliveryBadge.
    expect(within(recipients).getByText('Sent')).toBeInTheDocument();
  });

  it('patches stats + status live on a broadcast.updated SSE event', async () => {
    api.getBroadcastResults.mockResolvedValue(results());
    renderScreen();
    const heading = await screen.findByText('Broadcast results');
    const header = heading.closest('header') as HTMLElement;

    expect(within(header).getByText('Sending')).toBeInTheDocument();

    act(() => {
      api.eventHandlers.current?.onBroadcastUpdated?.({
        broadcastId: 'b1',
        status: 'sent',
        stats: { audience: 3, sent: 3, delivered: 2, failed: 0, skipped_opted_out: 0, queued: 0 },
      });
    });

    // The header status badge flips to Sent (scoped — "Sent" also appears as a
    // recipient delivery badge).
    expect(within(header).getByText('Sent')).toBeInTheDocument();
    const stats = screen.getByLabelText('Broadcast statistics');
    expect(within(stats).getByText('Delivered').closest('div')).toHaveTextContent('2');
  });

  it('ignores SSE events for a different broadcast', async () => {
    api.getBroadcastResults.mockResolvedValue(results());
    renderScreen();
    const heading = await screen.findByText('Broadcast results');
    const header = heading.closest('header') as HTMLElement;

    act(() => {
      api.eventHandlers.current?.onBroadcastUpdated?.({
        broadcastId: 'other',
        status: 'failed',
        stats: { audience: 9, sent: 9, delivered: 9, failed: 9, skipped_opted_out: 9, queued: 9 },
      });
    });

    // Still the original sending status.
    expect(within(header).getByText('Sending')).toBeInTheDocument();
  });

  it('refetches results on Refresh', async () => {
    api.getBroadcastResults.mockResolvedValue(results());
    renderScreen();
    await screen.findByText('Broadcast results');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.getBroadcastResults).toHaveBeenCalledTimes(2));
  });

  it('shows a not-found state for a missing broadcast', async () => {
    const { ApiError } = await import('../../api');
    api.getBroadcastResults.mockRejectedValueOnce(
      new ApiError(404, 'broadcast_not_found', 'broadcast_not_found'),
    );
    renderScreen();
    expect(await screen.findByText('Broadcast not found')).toBeInTheDocument();
  });
});
