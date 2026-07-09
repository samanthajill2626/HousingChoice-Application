// BroadcastResults tests (§8) — the live results view. Covers: StatChips from
// stats + per-recipient DeliveryBadge rows; a recipient row links to
// /contacts/:contactId; a phone-only row renders link-less; a failed row shows
// the error class + the "open conversation to retry" affordance; manual Refresh;
// a live broadcast.updated SSE overlays status/stats AND triggers a refetch that
// picks up updated recipients.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type {
  BroadcastResults as BroadcastResultsType,
  BroadcastUpdatedEvent,
  EventStreamHandlers,
} from '../../api/index.js';

const getBroadcastResults = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getBroadcastResults: (...a: unknown[]) => getBroadcastResults(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { BroadcastResults } from './BroadcastResults.js';

function results(over: Partial<BroadcastResultsType> = {}): BroadcastResultsType {
  return {
    broadcastId: 'bcast_1',
    status: 'sending',
    unitId: 'unit-0001',
    audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
    stats: { audience: 3, sent: 1, delivered: 1, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 1 },
    recipients: {
      c1: { status: 'delivered' },
      c2: { status: 'queued' },
    },
    created_at: '2026-06-30T14:00:00.000Z',
    ...over,
  };
}

function renderResults(id = 'bcast_1'): void {
  render(
    <MemoryRouter initialEntries={[`/broadcasts/${id}`]}>
      <Routes>
        <Route path="/broadcasts/:broadcastId" element={<BroadcastResults />} />
        <Route path="/contacts/:contactId" element={<div>Contact page</div>} />
        <Route path="*" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getBroadcastResults.mockReset();
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('BroadcastResults — render', () => {
  it('renders the StatChips + per-recipient rows with delivery badges', async () => {
    getBroadcastResults.mockResolvedValue(results());
    renderResults();
    // Stat chips.
    const chips = await screen.findByLabelText('Delivery stats');
    expect(within(within(chips).getByText('Recipients').closest('div') as HTMLElement).getByText('3')).toBeInTheDocument();
    // Recipient rows + a delivery badge each.
    const list = screen.getByRole('list', { name: 'Recipients' });
    expect(within(list).getByText('Delivered')).toBeInTheDocument();
    expect(within(list).getByText('Sending…')).toBeInTheDocument();
  });

  it('a recipient row links to /contacts/:contactId', async () => {
    getBroadcastResults.mockResolvedValue(results({ recipients: { c1: { status: 'delivered' } } }));
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    const link = within(list).getByRole('link');
    expect(link).toHaveAttribute('href', '/contacts/c1');
  });

  it('a phone-only recipient row renders WITHOUT a link', async () => {
    getBroadcastResults.mockResolvedValue(
      results({ recipients: { 'phone#+14040000007': { status: 'delivered' } } }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    expect(within(list).getByText('(404) 000-0007')).toBeInTheDocument();
  });

  it('a failed row shows the error class + the "open conversation to retry" affordance', async () => {
    getBroadcastResults.mockResolvedValue(
      results({ recipients: { c1: { status: 'failed', errorCode: '30003' } } }),
    );
    renderResults();
    const list = await screen.findByRole('list', { name: 'Recipients' });
    // Error class surfaced through the badge reason.
    expect(within(list).getByText(/Phone unreachable/i)).toBeInTheDocument();
    // The conversation-only disposition affordance is NAME-RESOLVABLE on the link:
    // its inner "↗ open conversation to retry" hint contributes to the accessible
    // name (not aria-hidden), so a role+name lookup resolves the failed-row link.
    const retryLink = within(list).getByRole('link', { name: /open conversation to retry/i });
    // The row links to the contact's comms (the in-thread Retry lives there).
    expect(retryLink).toHaveAttribute('href', '/contacts/c1');
  });
});

describe('BroadcastResults — not found', () => {
  it('shows the deleted/missing state on a 404', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
    getBroadcastResults.mockRejectedValue(new ApiError(404, 'broadcast_not_found', 'gone'));
    renderResults();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/doesn't exist/i);
    expect(within(alert).getByRole('link', { name: /Back to broadcasts/i })).toBeInTheDocument();
  });
});

describe('BroadcastResults — manual refresh', () => {
  it('refetches when Refresh is clicked', async () => {
    getBroadcastResults.mockResolvedValue(results());
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(getBroadcastResults).toHaveBeenCalledTimes(2));
  });
});

describe('BroadcastResults — live broadcast.updated SSE', () => {
  it('overlays status+stats instantly AND refetches for the updated recipients', async () => {
    // First load: sending, c2 queued.
    getBroadcastResults.mockResolvedValueOnce(results());
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    // The header pill starts at "Sending".
    expect(screen.getByText('Sending')).toBeInTheDocument();

    // The refetch the SSE triggers returns the SENT rollup with c2 now delivered.
    getBroadcastResults.mockResolvedValueOnce(
      results({
        status: 'sent',
        stats: { audience: 3, sent: 0, delivered: 3, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
        recipients: { c1: { status: 'delivered' }, c2: { status: 'delivered' } },
      }),
    );

    const event: BroadcastUpdatedEvent = {
      broadcastId: 'bcast_1',
      status: 'sent',
      stats: { audience: 3, sent: 0, delivered: 3, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
    };
    act(() => sse.onBroadcastUpdated?.(event));

    // Instant overlay: the Delivered chip flips to 3 (the live rollup) without a
    // refetch having resolved yet. (Scope to the chips dl — "Sent" appears both as
    // a chip label and, now, the status pill.)
    const chips = screen.getByLabelText('Delivery stats');
    await waitFor(() =>
      expect(
        within(within(chips).getByText('Delivered').closest('div') as HTMLElement).getByText('3'),
      ).toBeInTheDocument(),
    );
    // The status pill flips to "Sent" — it lives OUTSIDE the stats dl.
    const pillSent = screen.getAllByText('Sent').filter((el) => !chips.contains(el));
    expect(pillSent.length).toBeGreaterThan(0);

    // And the debounced refetch fires (per-recipient detail).
    await waitFor(() => expect(getBroadcastResults).toHaveBeenCalledTimes(2));
  });

  it('ignores a broadcast.updated for a DIFFERENT broadcast', async () => {
    getBroadcastResults.mockResolvedValue(results());
    renderResults();
    await screen.findByRole('list', { name: 'Recipients' });
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
    act(() =>
      sse.onBroadcastUpdated?.({
        broadcastId: 'someone_else',
        status: 'sent',
        stats: { audience: 1, sent: 0, delivered: 1, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      }),
    );
    // No overlay, no refetch.
    expect(screen.getByText('Sending')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(getBroadcastResults).toHaveBeenCalledTimes(1);
  });
});
