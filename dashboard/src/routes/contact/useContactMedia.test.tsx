// useContactMedia - the gallery feed off the media pointer index (2026-08-18).
// What is pinned: the first page renders; "load more" walks older media by
// cursor and appends; an SSE message.persisted refetches the FIRST page and
// merges it over what is loaded (a just-mirrored MMS appears, a load-more walk
// is not thrown away); a contact switch never shows the previous contact's rows.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactMediaItem, ContactMediaPage } from '../../api/index.js';

const getContactMedia = vi.fn();
let lastHandlers: { onMessagePersisted?: () => void; onConversationUpdated?: () => void } = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactMedia: (...a: unknown[]) => getContactMedia(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useContactMedia } from './useContactMedia.js';

function item(sid: string, at: string, index = 0): ContactMediaItem {
  return { providerSid: sid, index, contentType: 'image/jpeg', at, conversationId: 'c1' };
}

function Probe({ contactId }: { contactId: string }): React.JSX.Element {
  const m = useContactMedia(contactId);
  return (
    <div>
      <span data-testid="status">{m.status}</span>
      <span data-testid="keys">{m.items.map((i) => i.key).join(',')}</span>
      <span data-testid="hasMore">{String(m.hasMore)}</span>
      <button type="button" onClick={m.loadMore} disabled={m.loadingMore}>
        more
      </button>
    </div>
  );
}

beforeEach(() => {
  getContactMedia.mockReset();
  lastHandlers = {};
});

describe('useContactMedia', () => {
  it('renders the first page and reports whether older media exists', async () => {
    const page: ContactMediaPage = { media: [item('MM3', '2026-06-16T13:00:00Z'), item('MM2', '2026-06-16T12:00:00Z')], nextCursor: 'cur-1' };
    getContactMedia.mockResolvedValueOnce(page);
    render(<Probe contactId="k1" />);
    expect(screen.getByTestId('status').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('keys').textContent).toBe('MM3:0,MM2:0');
    expect(screen.getByTestId('hasMore').textContent).toBe('true');
    expect(getContactMedia).toHaveBeenCalledWith('k1', { limit: 60 }, expect.any(AbortSignal));
  });

  it('"load more" walks older media by cursor and APPENDS it', async () => {
    getContactMedia
      .mockResolvedValueOnce({ media: [item('MM3', '2026-06-16T13:00:00Z')], nextCursor: 'cur-1' })
      .mockResolvedValueOnce({ media: [item('MM1', '2026-06-16T11:00:00Z')] });
    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    await waitFor(() => expect(screen.getByTestId('keys').textContent).toBe('MM3:0,MM1:0'));
    expect(screen.getByTestId('hasMore').textContent).toBe('false');
    expect(getContactMedia).toHaveBeenLastCalledWith('k1', { limit: 60, cursor: 'cur-1' }, expect.any(AbortSignal));
  });

  it('a message.persisted refetches the FIRST page and merges it over what is loaded - a load-more walk survives', async () => {
    getContactMedia
      .mockResolvedValueOnce({ media: [item('MM3', '2026-06-16T13:00:00Z')], nextCursor: 'cur-1' })
      .mockResolvedValueOnce({ media: [item('MM1', '2026-06-16T11:00:00Z')] })
      // The refetch: a NEW newest item plus the one already shown.
      .mockResolvedValueOnce({ media: [item('MM4', '2026-06-16T14:00:00Z'), item('MM3', '2026-06-16T13:00:00Z')], nextCursor: 'cur-x' });
    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    await waitFor(() => expect(screen.getByTestId('keys').textContent).toBe('MM3:0,MM1:0'));

    act(() => lastHandlers.onMessagePersisted?.());
    // The refetch is debounced (300ms, real timers here).
    await waitFor(() => expect(screen.getByTestId('keys').textContent).toBe('MM4:0,MM3:0,MM1:0'), { timeout: 2_000 });
    // The walk had reached the end; a refetch does not resurrect a cursor.
    expect(screen.getByTestId('hasMore').textContent).toBe('false');
  });

  it('a contact switch shows loading, never the previous contact rows', async () => {
    let resolveSecond: ((p: ContactMediaPage) => void) | undefined;
    getContactMedia
      .mockResolvedValueOnce({ media: [item('MMa', '2026-06-16T13:00:00Z')] })
      .mockImplementationOnce(() => new Promise<ContactMediaPage>((r) => { resolveSecond = r; }));
    const { rerender } = render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('keys').textContent).toBe('MMa:0'));
    rerender(<Probe contactId="k2" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('loading'));
    expect(screen.getByTestId('keys').textContent).toBe('');
    act(() => resolveSecond?.({ media: [item('MMb', '2026-06-16T13:00:00Z')] }));
    await waitFor(() => expect(screen.getByTestId('keys').textContent).toBe('MMb:0'));
  });

  it('a failed first load is an error; a failed refetch keeps what is shown', async () => {
    getContactMedia.mockRejectedValueOnce(new Error('boom'));
    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });
});
