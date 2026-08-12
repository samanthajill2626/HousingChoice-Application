import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStreamHandlers } from '../../api/index.js';
import { ApiError } from '../../api/index.js';
import type { InboxFilter, InboxPage, InboxRow } from '../../api/index.js';

const getInbox = vi.fn();
const markInboxRead = vi.fn();
const markConversationRead = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getInbox: (...a: unknown[]) => getInbox(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { useInbox, rowKey } from './useInbox.js';

function mkRow(over: Partial<InboxRow> = {}): InboxRow {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'Tasha Williams',
    unreadCount: 2,
    preview: 'Hi there',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
    ...over,
  };
}
function pageOf(rows: InboxRow[], nextCursor: string | null = null): InboxPage {
  return { rows, nextCursor };
}

// Minimal probe: render hook state + expose its actions as buttons we can click.
function Probe({ filter }: { filter: InboxFilter }): React.JSX.Element {
  const s = useInbox(filter);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="unread">{s.rows.map((r) => r.unreadCount).join(',')}</span>
      <span data-testid="hasMore">{String(s.hasMore)}</span>
      <span data-testid="groupsTruncated">{String(s.groupsTruncated)}</span>
      <span data-testid="groupRowsShown">{String(s.groupRowsShown)}</span>
      <button onClick={() => s.loadMore()}>more</button>
      {s.rows.map((r) => (
        <span key={rowKey(r)}>
          <button onClick={() => s.markRead(r)}>read:{rowKey(r)}</button>
        </span>
      ))}
    </div>
  );
}

beforeEach(() => {
  getInbox.mockReset();
  markInboxRead.mockReset().mockResolvedValue(undefined);
  markConversationRead.mockReset().mockResolvedValue(undefined);
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('useInbox', () => {
  it('passes the active filter as the ?filter= query and renders ready rows', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect((getInbox.mock.calls[0]?.[0] as { filter: InboxFilter }).filter).toBe('unread');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('degrades to pending (not error) when GET /api/inbox 404s', async () => {
    getInbox.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('pending'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('goes to error on a non-404 failure', async () => {
    getInbox.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('appends a page on loadMore and clears hasMore at the end', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], null));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
    expect((getInbox.mock.calls[1]?.[0] as { cursor?: string }).cursor).toBe('CUR');
  });

  // C2 / conformance F10. Spec 11 names a DEFENSE-IN-DEPTH pair: the server
  // 400s a cursor whose tag mismatches the filter, AND the client drops the
  // cursor on a filter switch. `fetchFirstPage` had both an AbortController and
  // a generation ref; `loadMore` had neither, so a "Load more" in flight across
  // a tab switch appended the OLD filter's rows to the NEW filter's list and
  // installed the OLD partition's cursor - which the server then 400s into
  // loadMore's empty .catch, leaving contaminated rows and a dead Load more.
  it('drops an in-flight loadMore when the filter changes under it', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR-ALL'));
    const { rerender } = render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));

    let releaseMore: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseMore = () =>
            res(
              pageOf(
                [mkRow({ contactId: 'c-old-filter', lastActivityAt: '2026-06-17T08:00:00.000Z' })],
                'CUR-OLD-PARTITION',
              ),
            );
        }),
    );
    act(() => screen.getByRole('button', { name: 'more' }).click());

    // The operator switches tabs while it is still in flight, and the new
    // filter's first page lands first.
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c-new' })], null));
    rerender(<Probe filter="groups" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');

    act(() => releaseMore());
    await new Promise((r) => setTimeout(r, 20));
    // No contamination, and no cursor from a partition this filter cannot read.
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
  });

  it('optimistically marks a row read and posts to the contact read endpoint', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 3 })]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    // Optimistic: unread drops to 0 immediately.
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'c1' });
  });

  it('rolls back the optimistic mark-read when the request fails', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 3 })]));
    markInboxRead.mockRejectedValue(new ApiError(500, 'http_500', 'no'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    // Drops to 0 optimistically, then restores to 3 on failure.
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
  });

  it('drops a row out of the Unread filter the instant it is marked read', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 1 })]));
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  });

  it('marks an unknown row read by phone', async () => {
    getInbox.mockResolvedValue(
      pageOf([mkRow({ kind: 'unknown', contactId: undefined, phone: '+15555550123', unreadCount: 1, needsTriage: true })]),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:u:+15555550123' }).click());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ phone: '+15555550123' }));
  });

  it('refetches (coalesced) the current page on an SSE conversation.updated', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(1));
    // Fire a burst — they coalesce into ONE debounced refetch.
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        participant_display_name: 'Tasha',
      });
      sse.onConversationUpdated?.({
        conversationId: 'y',
        last_activity_at: '2026-06-17T11:00:01.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        participant_display_name: 'Bo',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
  });

  it('keeps an optimistic mark-read visible across an interleaved refetch that still shows it unread', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })]));
    let releaseRead: () => void = () => {};
    markInboxRead.mockImplementation(() => new Promise<void>((res) => { releaseRead = () => res(); }));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    // An SSE refetch lands returning the row STILL unread (server not caught up yet).
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })]));
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x', last_activity_at: '2026-06-17T11:00:00.000Z', unread_count: 2,
        type: 'tenant_1to1', participant_display_name: 'T',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
    // The in-flight overlay protects it — still 0.
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
    act(() => releaseRead());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
  });

  it('does not let a stale in-flight refetch overwrite a committed mark-read', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    // An SSE refetch starts and HANGS (in flight, reading pre-read state).
    let releaseStale: () => void = () => {};
    getInbox.mockImplementationOnce(
      () => new Promise((res) => { releaseStale = () => res(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })])); }),
    );
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x', last_activity_at: '2026-06-17T11:00:00.000Z', unread_count: 2,
        type: 'tenant_1to1', participant_display_name: 'T',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
    // Mark read resolves and commits (generation bump).
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    // The stale refetch now resolves — the generation guard must discard it.
    act(() => releaseStale());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
  });
});

describe('useInbox - native group text rows', () => {
  const groupRow = (over: Partial<InboxRow> = {}): InboxRow =>
    mkRow({
      kind: 'group_text',
      contactId: undefined,
      channel: undefined,
      direction: undefined,
      name: 'With Ann & Marcus',
      conversationId: 'gt-1',
      unreadCount: 2,
      ...over,
    });

  it('keys a group_text row with its OWN prefix (g: already belongs to relay)', () => {
    expect(rowKey(groupRow())).toBe('gt:gt-1');
    expect(rowKey(mkRow({ kind: 'relay_group', contactId: undefined, conversationId: 'gt-1' }))).toBe(
      'g:gt-1',
    );
  });

  it('marks a group row read through its OWN conversation, not the contact fan-out', async () => {
    getInbox.mockResolvedValueOnce(pageOf([groupRow()]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'read:gt:gt-1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    expect(markConversationRead).toHaveBeenCalledWith('gt-1');
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  // A26 / adversarial 21. The truncation notice used to count `inbox.rows`,
  // which the Unread filter has already narrowed AND the optimistic mark-read
  // has already patched - so the operator watched "Showing the latest 4 group
  // texts" tick down to 3, then 2, while the truncation claim stood. The count
  // belongs to the PAGE THE SERVER RETURNED, which is what was actually
  // withheld against.
  it('counts group rows from the server page, not the filtered/patched list', async () => {
    getInbox.mockResolvedValueOnce({
      rows: [
        groupRow({ conversationId: 'gt-1', unreadCount: 1 }),
        groupRow({ conversationId: 'gt-2', unreadCount: 1 }),
      ],
      nextCursor: null,
      groupsTruncated: true,
    });
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('2'));

    act(() => screen.getByRole('button', { name: 'read:gt:gt-1' }).click());
    // The row leaves the Unread list immediately...
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    // ...and the truncation claim's count does NOT move.
    expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('2');
  });

  it('grows the group count as further pages land', async () => {
    getInbox
      .mockResolvedValueOnce({
        rows: [groupRow({ conversationId: 'gt-1' })],
        nextCursor: 'CUR',
        groupsTruncated: true,
      })
      .mockResolvedValueOnce(
        pageOf([groupRow({ conversationId: 'gt-2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], null),
      );
    render(<Probe filter="groups" />);
    await waitFor(() => expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('2'));
  });

  it('surfaces the server truncation flag and clears it on a filter change', async () => {
    getInbox.mockResolvedValueOnce({ rows: [groupRow()], nextCursor: null, groupsTruncated: true });
    const { rerender } = render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('groupsTruncated')).toHaveTextContent('true'));

    getInbox.mockResolvedValueOnce(pageOf([groupRow()]));
    rerender(<Probe filter="groups" />);
    await waitFor(() => expect(screen.getByTestId('groupsTruncated')).toHaveTextContent('false'));
    expect(getInbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: 'groups' }),
      expect.anything(),
    );
  });
});
