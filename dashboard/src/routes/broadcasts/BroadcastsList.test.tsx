// BroadcastsList tests (§8) — the /broadcasts nav surface. Covers: rows render
// (status pill - audience - delivered/total - date); the ?status= filter tabs
// re-query; "New broadcast" → composer; a row → Results; a draft row → composer
// resume (?draftId=); cursor "Load more"; draft delete (confirm modal → row
// removed; Cancel keeps it; a raced 409 explains + refetches).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { BroadcastStatus, BroadcastSummary, BroadcastsPage, EventStreamHandlers } from '../../api/index.js';

const listBroadcasts = vi.fn();
const deleteBroadcast = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listBroadcasts: (...a: unknown[]) => listBroadcasts(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
    useEventStream: (_h: EventStreamHandlers) => {},
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
