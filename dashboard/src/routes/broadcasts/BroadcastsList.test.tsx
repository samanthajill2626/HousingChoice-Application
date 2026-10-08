// BroadcastsList tests (§8) — the /broadcasts nav surface. Covers: rows render
// (status pill - audience - delivered/total - date); the ?status= filter tabs
// re-query; "New broadcast" → composer; a row → Results; a draft row → composer
// resume (?draftId=); cursor "Load more"; draft delete (confirm modal → row
// removed; Cancel keeps it; a raced 409 explains + refetches).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { BroadcastStatus, BroadcastSummary, BroadcastsPage, EventStreamHandlers } from '../../api/index.js';

const listBroadcasts = vi.fn();
const deleteBroadcast = vi.fn();
const getBroadcastStats = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listBroadcasts: (...a: unknown[]) => listBroadcasts(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
    getBroadcastStats: (...a: unknown[]) => getBroadcastStats(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { BroadcastsList } from './BroadcastsList.js';

function summary(over: Partial<BroadcastSummary> = {}): BroadcastSummary {
  return {
    broadcastId: 'bcast_1',
    status: 'sent',
    unitId: 'unit-0001',
    audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
    stats: { audience: 4, sent: 0, delivered: 3, failed: 1, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
    created_at: '2026-06-30T14:00:00.000Z',
    created_by: 'user-0002',
    ...over,
  };
}

function pageOf(rows: BroadcastSummary[], nextCursor: string | null = null): BroadcastsPage {
  return { broadcasts: rows, nextCursor };
}

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}

function renderList(): void {
  render(
    <MemoryRouter initialEntries={['/broadcasts']}>
      <Routes>
        <Route path="/broadcasts" element={<BroadcastsList />} />
        <Route path="*" element={<div />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listBroadcasts.mockReset();
  deleteBroadcast.mockReset().mockResolvedValue({ deleted: true });
  getBroadcastStats.mockReset();
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('BroadcastsList — rows', () => {
  it('renders a row with the status pill, audience summary, delivered/total, and date', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    expect(within(list).getByText('Sent')).toBeInTheDocument();
    expect(within(list).getByText('Tenants - 2-BR')).toBeInTheDocument();
    expect(within(list).getByText('3/4 delivered')).toBeInTheDocument();
  });

  it('caseworkers D22: the subtitle and the empty state use the neutral share wording', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList();
    expect(await screen.findByText('No sends yet')).toBeInTheDocument();
    expect(screen.getByText('Share a property with a curated set of recipients.')).toBeInTheDocument();
    // The curly quotes render from entities; `.` matches each one.
    expect(
      screen.getByText(
        /^Start one from a property's .Send this property., from a contact's .Properties sent., or with .Send a property.\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('shows the empty state when there are no broadcasts', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList();
    expect(await screen.findByText('No sends yet')).toBeInTheDocument();
  });
});

describe('BroadcastsList — status filter', () => {
  it('re-queries with the selected status when a filter tab is chosen', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    // First call: no status (All).
    expect((listBroadcasts.mock.calls[0]?.[0] as { status?: BroadcastStatus }).status).toBeUndefined();

    const u = userEvent.setup();
    await u.click(screen.getByRole('tab', { name: 'Drafts' }));
    await waitFor(() => {
      const last = listBroadcasts.mock.calls.at(-1)?.[0] as { status?: BroadcastStatus };
      expect(last.status).toBe('draft');
    });
  });
});

describe('BroadcastsList — navigation', () => {
  it('"Send a property" routes to the composer', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList();
    await screen.findByText('No sends yet');
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Send a property' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new');
  });

  it('a sent row links to its Results view', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_X', status: 'sent' })]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/broadcasts/bcast_X');
  });

  it('a draft row links to the composer resume (?draftId=)', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_D', status: 'draft' })]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/broadcasts/new?draftId=bcast_D');
  });
});

describe('BroadcastsList — delete draft', () => {
  it('shows a Delete action on draft rows only', async () => {
    listBroadcasts.mockResolvedValue(
      pageOf([
        summary({ broadcastId: 'bcast_D', status: 'draft' }),
        summary({ broadcastId: 'bcast_S', status: 'sent' }),
      ]),
    );
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    // One draft row → exactly one Delete button.
    expect(within(list).getAllByRole('button', { name: /^Delete draft:/ })).toHaveLength(1);
  });

  it('confirming the modal deletes the draft and removes its row', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_D', status: 'draft' })]));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /^Delete draft:/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete draft?' });
    await u.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(deleteBroadcast).toHaveBeenCalledWith('bcast_D'));
    // Row dropped locally (no refetch) → the only row is gone → empty state.
    expect(await screen.findByText('No sends yet')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(listBroadcasts).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the modal without deleting', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_D', status: 'draft' })]));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /^Delete draft:/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete draft?' });
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteBroadcast).not.toHaveBeenCalled();
    expect(screen.getByRole('list', { name: 'Property sends' })).toBeInTheDocument();
  });

  it('explains a 409 (raced to sending) and refetches the list', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_D', status: 'draft' })]));
    deleteBroadcast.mockRejectedValue(new ApiError(409, 'broadcast_not_draft', 'not a draft'));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /^Delete draft:/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete draft?' });
    await u.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    expect(
      await within(dialog).findByText(/already started, so it can no longer be deleted/),
    ).toBeInTheDocument();
    // The list refetched behind the modal so the row shows its real status.
    await waitFor(() => expect(listBroadcasts).toHaveBeenCalledTimes(2));
  });
});

describe('BroadcastsList — load more', () => {
  it('appends the next page on Load more and uses the cursor', async () => {
    listBroadcasts
      .mockResolvedValueOnce(pageOf([summary({ broadcastId: 'b1' })], 'CUR'))
      .mockResolvedValueOnce(pageOf([summary({ broadcastId: 'b2' })], null));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    const u = userEvent.setup();
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    await u.click(loadMore);
    await waitFor(() => {
      const list = screen.getByRole('list', { name: 'Property sends' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    });
    expect((listBroadcasts.mock.calls.at(-1)?.[0] as { cursor?: string }).cursor).toBe('CUR');
    // Cursor exhausted → Load more gone.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

// share-sent-outcome D4: a broadcast.updated patch MERGES an omitted
// retry_pending by keeping the row's last value (only the rollup that just
// scheduled a retry emits one); a FINISHED share whose kept count is positive
// refetches its stats once (GET results?view=stats, 400 ms debounced per row),
// so a chain that ends in a failure receipt turns Sending into Not sent.
describe('BroadcastsList - live broadcast.updated merge', () => {
  const none = { sent: 0, delivered: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 };
  /** Nothing reached, one failure holding a live promise: the pill reads Sending. */
  const PENDING = { ...none, audience: 1, failed: 1, retry_pending: 1 };
  /** The same buckets from an emit that leaves the count UNSET. */
  const UNSET = { ...none, audience: 1, failed: 1 };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  function statsView(status: BroadcastStatus, retryPending: number) {
    return {
      broadcastId: 'b1',
      status,
      unitId: 'unit-0001',
      stats: { ...none, audience: 1, failed: 1, retry_pending: retryPending },
      created_at: '2026-06-30T14:00:00.000Z',
    };
  }

  it('an event without retry_pending on a FINISHED row whose count is 1 keeps it (no flash), then refetches that share once and takes its status + stats', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: PENDING })]));
    getBroadcastStats.mockResolvedValue(statsView('sent', 0));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    expect(within(list).getByText('Sending')).toBeInTheDocument();

    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    // The kept count holds until the refetch lands.
    expect(within(list).getByText('Sending')).toBeInTheDocument();
    await waitFor(() => expect(getBroadcastStats).toHaveBeenCalledTimes(1));
    expect(getBroadcastStats.mock.calls[0]?.[0]).toBe('b1');
    expect(await within(list).findByText('Not sent')).toBeInTheDocument();
    await sleep(500);
    expect(getBroadcastStats).toHaveBeenCalledTimes(1);
  });

  it('the same event on a row stored SENDING never refetches (a Sending share needs no count) - the count is kept for when it finishes', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'b1', status: 'sending', stats: PENDING })]));
    getBroadcastStats.mockResolvedValue(statsView('sent', 0));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sending', stats: UNSET }));
    await sleep(600);
    expect(getBroadcastStats).not.toHaveBeenCalled();
    expect(within(list).getByText('Sending')).toBeInTheDocument();
    // Finalize's emit (count unset) finds the KEPT 1 on a now-finished share.
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    await waitFor(() => expect(getBroadcastStats).toHaveBeenCalledTimes(1));
    expect(await within(list).findByText('Not sent')).toBeInTheDocument();
  });

  it('an event CARRYING retry_pending replaces the count outright, with no fetch', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: PENDING })]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: { ...UNSET, retry_pending: 0 } }));
    expect(within(list).getByText('Not sent')).toBeInTheDocument();
    await sleep(600);
    expect(getBroadcastStats).not.toHaveBeenCalled();
  });

  it('two events inside 400 ms trigger ONE fetch', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: PENDING })]));
    getBroadcastStats.mockResolvedValue(statsView('sent', 0));
    renderList();
    await screen.findByRole('list', { name: 'Property sends' });
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    await waitFor(() => expect(getBroadcastStats).toHaveBeenCalledTimes(1));
    await sleep(600);
    expect(getBroadcastStats).toHaveBeenCalledTimes(1);
  });

  // code review ADV-7: the refetch decision reads the row AS PATCHED, so a
  // handler that runs before React renders (the rollup's emit, then the
  // withdrawal's re-emit, back to back) still sees the first event's count;
  // and a count-CARRYING event is newer than any pending or in-flight read.
  it('two back-to-back events with no render between - the rollup CARRYING retry_pending 1, then the re-emit with the count UNSET - schedule exactly ONE refetch', async () => {
    listBroadcasts.mockResolvedValue(
      pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: { ...none, audience: 1, failed: 1, retry_pending: 0 } })]),
    );
    getBroadcastStats.mockResolvedValue(statsView('sent', 0));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    expect(within(list).getByText('Not sent')).toBeInTheDocument();
    act(() => {
      sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: PENDING });
      sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET });
    });
    await waitFor(() => expect(getBroadcastStats).toHaveBeenCalledTimes(1));
    expect(await within(list).findByText('Not sent')).toBeInTheDocument();
    await sleep(500);
    expect(getBroadcastStats).toHaveBeenCalledTimes(1);
  });

  it('an event CARRYING the count while a stats refetch is in flight aborts it: the older response never replaces the newer count', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: PENDING })]));
    let resolveStale: (view: unknown) => void = () => {};
    let staleSignal: AbortSignal | undefined;
    getBroadcastStats.mockImplementation((_id: string, signal?: AbortSignal) => {
      staleSignal = signal;
      return new Promise((resolve) => {
        resolveStale = resolve;
      });
    });
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    await waitFor(() => expect(getBroadcastStats).toHaveBeenCalledTimes(1)); // the read is out
    // A NEW pending recipient: the rollup's own count lands while the older read is in flight.
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: PENDING }));
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => {
      resolveStale(statsView('sent', 0));
      await sleep(0);
    });
    expect(within(list).getByText('Sending')).toBeInTheDocument();
    expect(within(list).queryByText('Not sent')).toBeNull();
    expect(getBroadcastStats).toHaveBeenCalledTimes(1);
  });

  it('an event CARRYING the count inside the 400 ms debounce cancels the pending refetch - nothing is fetched', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: PENDING })]));
    getBroadcastStats.mockResolvedValue(statsView('sent', 0));
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: PENDING }));
    await sleep(600);
    expect(getBroadcastStats).not.toHaveBeenCalled();
    expect(within(list).getByText('Sending')).toBeInTheDocument();
  });

  it('a kept count of 0, and a share not on the page, never refetch', async () => {
    listBroadcasts.mockResolvedValue(
      pageOf([summary({ broadcastId: 'b1', status: 'sent', stats: { ...none, audience: 1, failed: 1, retry_pending: 0 } })]),
    );
    renderList();
    const list = await screen.findByRole('list', { name: 'Property sends' });
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b1', status: 'sent', stats: UNSET }));
    act(() => sse.onBroadcastUpdated?.({ broadcastId: 'b-elsewhere', status: 'sent', stats: PENDING }));
    await sleep(600);
    expect(getBroadcastStats).not.toHaveBeenCalled();
    expect(within(list).getByText('Not sent')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });
});
