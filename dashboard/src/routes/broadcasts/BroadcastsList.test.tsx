// BroadcastsList tests (§8) — the /broadcasts nav surface. Covers: rows render
// (status pill - audience - delivered/total - date); the ?status= filter tabs
// re-query; "New broadcast" → composer; a row → Results; a draft row → composer
// resume (?draftId=); cursor "Load more".
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { BroadcastStatus, BroadcastSummary, BroadcastsPage, EventStreamHandlers } from '../../api/index.js';

const listBroadcasts = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    listBroadcasts: (...a: unknown[]) => listBroadcasts(...a),
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
    stats: { audience: 4, sent: 0, delivered: 3, failed: 1, skipped_opted_out: 0, queued: 0 },
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
});
afterEach(() => vi.restoreAllMocks());

describe('BroadcastsList — rows', () => {
  it('renders a row with the status pill, audience summary, delivered/total, and date', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Broadcasts' });
    expect(within(list).getByText('Sent')).toBeInTheDocument();
    expect(within(list).getByText('Tenants - 2-BR')).toBeInTheDocument();
    expect(within(list).getByText('3/4 delivered')).toBeInTheDocument();
  });

  it('shows the empty state when there are no broadcasts', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList();
    expect(await screen.findByText('No broadcasts yet')).toBeInTheDocument();
  });
});

describe('BroadcastsList — status filter', () => {
  it('re-queries with the selected status when a filter tab is chosen', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary()]));
    renderList();
    await screen.findByRole('list', { name: 'Broadcasts' });
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
  it('"New broadcast" routes to the composer', async () => {
    listBroadcasts.mockResolvedValue(pageOf([]));
    renderList();
    await screen.findByText('No broadcasts yet');
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'New broadcast' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new');
  });

  it('a sent row links to its Results view', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_X', status: 'sent' })]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Broadcasts' });
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/broadcasts/bcast_X');
  });

  it('a draft row links to the composer resume (?draftId=)', async () => {
    listBroadcasts.mockResolvedValue(pageOf([summary({ broadcastId: 'bcast_D', status: 'draft' })]));
    renderList();
    const list = await screen.findByRole('list', { name: 'Broadcasts' });
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/broadcasts/new?draftId=bcast_D');
  });
});

describe('BroadcastsList — load more', () => {
  it('appends the next page on Load more and uses the cursor', async () => {
    listBroadcasts
      .mockResolvedValueOnce(pageOf([summary({ broadcastId: 'b1' })], 'CUR'))
      .mockResolvedValueOnce(pageOf([summary({ broadcastId: 'b2' })], null));
    renderList();
    await screen.findByRole('list', { name: 'Broadcasts' });
    const u = userEvent.setup();
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    await u.click(loadMore);
    await waitFor(() => {
      const list = screen.getByRole('list', { name: 'Broadcasts' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    });
    expect((listBroadcasts.mock.calls.at(-1)?.[0] as { cursor?: string }).cursor).toBe('CUR');
    // Cursor exhausted → Load more gone.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
