import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStreamHandlers } from '../../api/index.js';
import { ApiError } from '../../api/index.js';
import type { InboxFilter, InboxPage, InboxRow } from '../../api/index.js';

const getInbox = vi.fn();
const markInboxRead = vi.fn();
const markInboxUnread = vi.fn();
const markConversationRead = vi.fn();
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getInbox: (...a: unknown[]) => getInbox(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    markInboxUnread: (...a: unknown[]) => markInboxUnread(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

// Stub the badge context rather than mounting a real UnreadProvider: a real one
// would fire its own count + unmatched-email fetches through this file's api mock
// and would fight for the shared `sse` capture above.
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

import { useInbox, rowKey } from './useInbox.js';
// The REAL component, for the composed cases at the bottom of this file: the
// truncation flag only misfires where the hook's server statement meets the
// component's render of the client-filtered list.
import { Inbox } from './Inbox.js';
import { StrictMode } from 'react';
import { clearInboxLists, inboxListKey, loadInboxList, saveInboxList } from './inboxListStore.js';

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
function Probe({
  filter,
  limit,
  operatorId,
  restoreScroll,
}: {
  filter: InboxFilter;
  limit?: number;
  operatorId?: string;
  restoreScroll?: boolean;
}): React.JSX.Element {
  const s = useInbox(filter, limit, operatorId, restoreScroll);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="ids">{s.rows.map((r) => rowKey(r)).join(',')}</span>
      <span data-testid="unread">{s.rows.map((r) => r.unreadCount).join(',')}</span>
      <span data-testid="hasMore">{String(s.hasMore)}</span>
      <span data-testid="groupsTruncated">{String(s.groupsTruncated)}</span>
      <span data-testid="truncated">{String(s.truncated)}</span>
      <span data-testid="serverRowCount">{String(s.serverRowCount)}</span>
      <span data-testid="groupRowsShown">{String(s.groupRowsShown)}</span>
      <span data-testid="loadingMore">{String(s.loadingMore)}</span>
      <span data-testid="refreshFailed">{String(s.refreshFailed)}</span>
      <span data-testid="armed">{String(s.autoLoadArmed)}</span>
      <span data-testid="epoch">{String(s.pageEpoch)}</span>
      <span data-testid="restoredScrollTop">{String(s.restoredScrollTop)}</span>
      <button onClick={() => s.loadMore()}>more</button>
      <button onClick={() => s.retry()}>retry</button>
      <button onClick={() => s.noteScrollTop(321)}>scroll</button>
      {s.rows.map((r) => (
        <span key={rowKey(r)}>
          <button onClick={() => s.markRead(r)}>read:{rowKey(r)}</button>
          <button onClick={() => s.markUnread(r)}>unread:{rowKey(r)}</button>
        </span>
      ))}
    </div>
  );
}

beforeEach(() => {
  clearInboxLists();
  getInbox.mockReset();
  markInboxRead.mockReset().mockResolvedValue(undefined);
  markInboxUnread.mockReset().mockResolvedValue(undefined);
  markConversationRead.mockReset().mockResolvedValue(undefined);
  noteRowsCleared.mockReset();
  rollbackRowsCleared.mockReset();
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
    // SC-8: the key effect cleared loadingMore for the new tab. The stale
    // page's `finally` skips the clear, so without it Load more (and
    // auto-load, which needs !loadingMore) would be dead here for good.
    expect(screen.getByTestId('loadingMore')).toHaveTextContent('false');

    act(() => releaseMore());
    await new Promise((r) => setTimeout(r, 20));
    // No contamination, and no cursor from a partition this filter cannot read.
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
    expect(screen.getByTestId('loadingMore')).toHaveTextContent('false');
  });

  // Adversarial 29. `loadMore`'s `stale()` guard consulted the FILTER axis only,
  // so an SSE reconcile racing an in-flight page still appended it - on top of a
  // first page the reconcile had just replaced - and overwrote the fresh cursor
  // with one addressing a position the list no longer holds. `rows` is not
  // deduped, so that is duplicate rowKeys and silently skipped rows, and the
  // dead cursor is the same class of failure the filter axis already guards.
  it('drops an in-flight loadMore when an SSE reconcile lands under it', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR-PAGE-1'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));

    let releaseMore: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseMore = () =>
            res(
              pageOf(
                [mkRow({ contactId: 'c-page-2', lastActivityAt: '2026-06-17T08:00:00.000Z' })],
                'CUR-STALE-POSITION',
              ),
            );
        }),
    );
    act(() => screen.getByRole('button', { name: 'more' }).click());
    expect(screen.getByTestId('loadingMore')).toHaveTextContent('true');

    // A message lands anywhere in the org: the debounced reconcile refetches the
    // FIRST page and commits a brand-new list, with its own (here: exhausted)
    // cursor.
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c-fresh' })], null));
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        participant_display_name: 'T',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('false'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');

    // The page that was in flight the whole time finally lands.
    act(() => releaseMore());
    await new Promise((r) => setTimeout(r, 20));
    // It neither appends to a list it was never a continuation of...
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    // ...nor reinstalls a cursor addressing a position that list no longer holds.
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
    // ...and Load more is not left permanently spinning.
    expect(screen.getByTestId('loadingMore')).toHaveTextContent('false');
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
    // The stale refetch now resolves - the generation guard must discard it.
    // SC-10: released inside an async act that outlasts its continuation, then
    // asserted once. A waitFor here would check once synchronously and pass
    // BEFORE the stale page could commit, so deleting the guard went unseen.
    await act(async () => {
      releaseStale();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
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

  // A26, CORRECTED by adversarial 30. A26 pinned this count to the PAGE THE
  // SERVER RETURNED, which fixed the wrong half of the drift: on the Unread tab
  // `rows` drops every row the operator marks read while the server page does
  // not, so the notice could read "Showing the latest 2 unread group texts" with
  // ZERO group rows on screen - a claim about the list that the list contradicts.
  // The notice is a statement about what is RENDERED, so it counts what is
  // rendered. A26's own case is still covered by the sibling test below: on All
  // and Groups a marked-read row stays in the list, so nothing ticks there.
  it('counts the group rows actually RENDERED, so the notice cannot outlive them', async () => {
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
    // The row leaves the Unread list immediately, and the count leaves with it.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    await waitFor(() => expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('1'));

    act(() => screen.getByRole('button', { name: 'read:gt:gt-2' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    // The notice can no longer claim group texts that are not on screen.
    await waitFor(() => expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('0'));
  });

  // A26's actual protection, kept: on every filter that does NOT narrow by
  // unread, marking a row read leaves it in the list, so the count is stable and
  // the operator never watches it tick down under a standing truncation claim.
  it('does NOT tick down when a marked-read group row stays in the list', async () => {
    getInbox.mockResolvedValueOnce({
      rows: [
        groupRow({ conversationId: 'gt-1', unreadCount: 1 }),
        groupRow({ conversationId: 'gt-2', unreadCount: 1 }),
      ],
      nextCursor: null,
      groupsTruncated: true,
    });
    render(<Probe filter="groups" />);
    await waitFor(() => expect(screen.getByTestId('groupRowsShown')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'read:gt:gt-1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0,1'));
    expect(screen.getByTestId('count')).toHaveTextContent('2');
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

  it('mints the KIND-FREE cv: badge key for a group_text row, not its gt: row key', async () => {
    getInbox.mockResolvedValueOnce(pageOf([groupRow()]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'read:gt:gt-1' }).click());
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('gt-1'));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['cv:gt-1']);
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

// The nav badge's optimistic layer. The key is minted INSIDE the branch that
// resolved the read action, so it always describes how the row was ACTUALLY
// addressed - and it is a different vocabulary from `rowKey` (both group kinds
// share `cv:` so the badge dedupes with the tour/placement tabs).
describe('useInbox - badge clear keys', () => {
  it('mints c:<contactId> for a contact row', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 3 })]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'c1' }));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['c:c1']);
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('mints u:<phone> for an unknown row', async () => {
    getInbox.mockResolvedValue(
      pageOf([
        mkRow({
          kind: 'unknown',
          contactId: undefined,
          phone: '+15555550123',
          unreadCount: 1,
          needsTriage: true,
        }),
      ]),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:u:+15555550123' }).click());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ phone: '+15555550123' }));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['u:+15555550123']);
  });

  it('mints cv:<conversationId> for a relay_group row', async () => {
    getInbox.mockResolvedValue(
      pageOf([
        mkRow({ kind: 'relay_group', contactId: undefined, conversationId: 'g-1', unreadCount: 2 }),
      ]),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'read:g:g-1' }).click());
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('g-1'));
    expect(noteRowsCleared).toHaveBeenCalledTimes(1);
    expect(noteRowsCleared).toHaveBeenCalledWith(['cv:g-1']);
  });

  // THE TRAP the per-branch minting exists for: the third branch catches rows by
  // PHONE across kinds, so a `contact` row with no contactId is marked read BY
  // PHONE. A key derived from `row.kind` would mint `c:undefined` here.
  it('mints u:<phone> for a CONTACT row that had to be addressed by phone', async () => {
    getInbox.mockResolvedValue(
      pageOf([
        mkRow({ kind: 'contact', contactId: undefined, phone: '+15555550999', unreadCount: 1 }),
      ]),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:c:' }).click());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ phone: '+15555550999' }));
    expect(noteRowsCleared).toHaveBeenCalledWith(['u:+15555550999']);
  });

  it('never touches the badge for an UNADDRESSABLE row', async () => {
    getInbox.mockResolvedValue(
      pageOf([mkRow({ kind: 'contact', contactId: undefined, phone: undefined, unreadCount: 1 })]),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:c:' }).click());
    await new Promise((r) => setTimeout(r, 20));
    expect(markInboxRead).not.toHaveBeenCalled();
    expect(noteRowsCleared).not.toHaveBeenCalled();
  });

  it('rolls the badge clear back when the mark-read request fails', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 3 })]));
    markInboxRead.mockRejectedValue(new ApiError(500, 'http_500', 'no'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(rollbackRowsCleared).toHaveBeenCalledWith(['c:c1']));
    expect(noteRowsCleared).toHaveBeenCalledWith(['c:c1']);
  });
});

describe('useInbox - the unread feed truncation flag', () => {
  it('surfaces truncated from the first page', async () => {
    getInbox.mockResolvedValue({ rows: [], nextCursor: null, truncated: true });
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('truncated')).toHaveTextContent('true'));
  });

  it('surfaces truncated from a LOAD MORE page too', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR'))
      .mockResolvedValueOnce({
        rows: [mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })],
        nextCursor: null,
        truncated: true,
      });
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('truncated')).toHaveTextContent('false'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('truncated')).toHaveTextContent('true');
  });

  // A10. Without the reset the flag SURVIVES the tab switch while the new
  // filter's first page is on the wire, and the moment that page lands empty the
  // All tab renders the inbox ERROR state instead of "all caught up" (Inbox.tsx
  // gates the failure block on rows.length === 0 && truncated). The mid-flight
  // assertion is the one that discriminates: the success branch overwrites the
  // flag, so only the reset can clear it BEFORE the page lands.
  it('RESETS truncated on a filter change, so an empty All page is not an error', async () => {
    getInbox.mockResolvedValueOnce({ rows: [], nextCursor: null, truncated: true });
    const { rerender } = render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('truncated')).toHaveTextContent('true'));

    let releaseAll: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseAll = () => res(pageOf([]));
        }),
    );
    rerender(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('loading'));
    expect(screen.getByTestId('truncated')).toHaveTextContent('false');

    act(() => releaseAll());
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('truncated')).toHaveTextContent('false');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  // THE STALE-FILTER RECONCILE. Diagnosed 2026-08-24 from a reproduced e2e
  // failure with server-side read accounting: the app served a FULL page on
  // every filter=all request while the browser rendered "No conversations yet",
  // and the request that emptied the list was a `filter=unread` fetch the
  // BROWSER issued 158ms after the All tab's own fetch had already landed.
  //
  // The debounce timer is scheduled inside `scheduleRefetch`, which closes over
  // the `fetchFirstPage` of the filter that was active when the SSE event
  // arrived. Nothing cancels it on a filter change - the clearing effect has
  // EMPTY deps, so it only runs on unmount - and `fetchFirstPage` commits
  // whatever it fetched with no filter-identity guard. `loadMore` was hardened
  // against precisely this class ("a page fetched for the previous filter must
  // never append to the new filter's list"); the first-page path never was.
  //
  // Operator-visible, and not only in tests: mark a row read on Unread and
  // switch to All inside 300ms and the All tab goes blank until the next event
  // happens to arrive. Closes call-inbox-unread-detached-node-flake and
  // inbox-row-appearance-e2e-flake, which are the same defect seen from the
  // click side and the row-appearance side.
  it('DROPS a debounced reconcile scheduled under the previous filter', async () => {
    const allRows = [
      mkRow({ contactId: 'c1' }),
      mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' }),
      mkRow({ contactId: 'c3', lastActivityAt: '2026-06-17T08:00:00.000Z' }),
    ];
    // The unread feed still holds the row when the Unread tab loads, and is
    // EMPTY by the time the stale refetch lands - which is exactly what
    // marking that row read does, and why this only bites right after one.
    let unreadRows: InboxRow[] = [mkRow({ contactId: 'c1' })];
    getInbox.mockImplementation((opts: { filter: InboxFilter }) =>
      Promise.resolve(pageOf(opts.filter === 'unread' ? unreadRows : allRows)),
    );

    const { rerender } = render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));

    unreadRows = [];
    // The mark-read's conversation.updated: schedules a reconcile bound to the
    // UNREAD closure...
    act(() => {
      sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never);
    });
    // ...and the operator switches tabs inside the 300ms debounce window.
    rerender(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'));

    // Outlast the debounce. The stale timer either never fires or its page is
    // refused; either way the All tab keeps the page it actually asked for.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('3');
    // And no request was spent on a filter the operator has left. Asserted off
    // the LAST call rather than a positional slice: a positional assertion
    // silently depends on exactly one request having been made before the
    // switch, which StrictMode's double-invoke would break for reasons that
    // have nothing to do with this behaviour.
    expect(getInbox).toHaveBeenCalledTimes(2);
    const lastFilter = (getInbox.mock.calls.at(-1)?.[0] as { filter: InboxFilter }).filter;
    expect(lastFilter).toBe('all');
  });

  // ADVERSARIAL REVIEW FINDING 3. The SUCCESS path refuses a page on two axes -
  // the optimistic-mutation generation and the filter - while the FAILURE path
  // checked only the filter, under a comment claiming both branches refused
  // alike. They did not, and the asymmetry is reachable without any filter
  // change at all: a background reconcile that FAILS discards a healthy list
  // the operator is looking at, including a mark-read they just committed.
  //
  // `loadMore`'s .catch is deliberately non-destructive for this exact reason.
  // A reconcile nobody asked for has even less licence to destroy good state.
  it('a FAILED background reconcile does not discard a committed mark-read', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    // A background reconcile starts FIRST and is still on the wire - that
    // ordering is the whole point, because it is what captures the pre-commit
    // generation.
    let failReconcile: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          failReconcile = () => rej(new ApiError(500, 'http_500', 'boom'));
        }),
    );
    act(() => {
      sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(getInbox).toHaveBeenCalledTimes(2);

    // NOW the operator marks the row read; the POST resolves and commits.
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));

    // ...and only then does the in-flight reconcile fail.
    await act(async () => {
      failReconcile();
      await new Promise((r) => setTimeout(r, 50));
    });

    // The list the operator is looking at survives, and so does their action.
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
  });

  // CONFORMANCE REVIEW FINDING 1. `genRef` is not filter-scoped, so an
  // optimistic commit for a row on the filter the operator LEFT invalidates the
  // page the filter they arrived at is currently fetching. The effect already
  // set status 'loading' and nothing else re-fetches, so the new tab strands on
  // a spinner until an unrelated SSE event happens along.
  //
  // Pre-existing, but the stale-reconcile fix made it REACHABLE: the stale
  // timer used to fire at +300ms and drag the tab to 'ready' (with the wrong
  // filter's rows - the defect that fix closed). Cancelling that timer removed
  // the accident that was covering this.
  it('an optimistic commit on the PREVIOUS filter does not strand the new one', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })]));
    let releaseRead: () => void = () => {};
    markInboxRead.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          releaseRead = () => res();
        }),
    );
    const { rerender } = render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    // Mark read on Unread - the POST is still in flight...
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    // ...the operator switches to All, and then BACK to Unread. The round trip
    // is the point: a guard that compares filter IDENTITY sees 'unread' again
    // and concludes nothing changed, so it bumps the generation and invalidates
    // the page this tab is currently fetching. Identities recur; epochs do not.
    // "Mark read, peek at All, come back" is an ordinary triage gesture, and
    // browser back/forward steps through filters by design.
    getInbox.mockImplementationOnce(() => new Promise(() => {})); // All, never settles
    rerender(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('loading'));

    let releaseArrived: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((res) => {
          // unreadCount > 0: we land back on the Unread tab, which narrows the
          // list client-side, so a read row would be filtered out and the
          // assertion below would fail for a reason unrelated to the defect.
          releaseArrived = () => res(pageOf([mkRow({ contactId: 'c2', unreadCount: 3 })]));
        }),
    );
    rerender(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('loading'));

    // ...and the mark-read commits FIRST, bumping the generation.
    await act(async () => {
      releaseRead();
      await Promise.resolve();
    });
    await act(async () => {
      releaseArrived();
      await new Promise((r) => setTimeout(r, 50));
    });

    // The page for the tab the operator is ACTUALLY on must install. Stranding
    // on 'loading' - a spinner with no Retry, since Retry lives under the error
    // state - with no request in flight is the defect.
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  // THE GENERATION GUARD PROTECTS A LIST, NOT A SPINNER (see fetchHead). A
  // mutation committing under a head read that set `loading` must not strand
  // the tab: nothing re-issues a discarded page there. Same filter throughout.
  it('a mark-read committing under RETRY (no rows rendered) does not strand the tab on a spinner', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })]));
    let releaseRead: () => void = () => {};
    markInboxRead.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          releaseRead = () => res();
        }),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    // Mark read; the POST hangs.
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());

    // A complete head read returns ZERO rows: the list empties (still ready).
    getInbox.mockResolvedValueOnce(pageOf([], null));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(screen.getByTestId('serverRowCount')).toHaveTextContent('0'), { timeout: 2000 });

    // Now a head read FAILS with no rows rendered: today's error arm.
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-2' } as never));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'), { timeout: 2000 });

    // Retry with no rows sets loading; its page is on the wire...
    let releaseRetry: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseRetry = () => res(pageOf([mkRow({ contactId: 'c1', unreadCount: 0 })]));
        }),
    );
    act(() => screen.getByRole('button', { name: 'retry' }).click());
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('loading'));

    // ...and the mark-read commits first, bumping the generation for THIS
    // filter. Retry's page must still land: discarding it leaves nothing on
    // screen and nothing in flight.
    await act(async () => {
      releaseRead();
      await Promise.resolve();
    });
    await act(async () => {
      releaseRetry();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  // The OTHER reset A10 names. Kept on the SAME filter (a reconcile refetch that
  // 404s), because a filter change would reset the flag through the filter effect
  // and this branch would go untested.
  it('RESETS truncated on the 404 (backend not live) branch', async () => {
    getInbox.mockResolvedValueOnce({ rows: [], nextCursor: null, truncated: true });
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('truncated')).toHaveTextContent('true'));

    getInbox.mockRejectedValueOnce(new ApiError(404, 'http_404', 'nope'));
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        participant_display_name: 'T',
      });
    });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('pending'));
    expect(screen.getByTestId('truncated')).toHaveTextContent('false');
  });

  // ADVERSARIAL 4, and the test the two shipped halves never composed: one proved
  // the hook surfaces `truncated`, the other proved Inbox renders the failure
  // state on an empty truncated page, and nothing exercised the sequence that
  // actually bites - a truncated page WITH rows that the operator clears. `rows`
  // is the client-filtered list; `truncated` is the server's statement about its
  // page. Pairing them made a successful triage session end in "We couldn't load
  // your inbox." So this drives the REAL Inbox through the REAL hook.
  it('COMPOSED: marking every row of a TRUNCATED page read leaves no failure banner', async () => {
    getInbox.mockResolvedValue({
      rows: [
        mkRow({ contactId: 'c1', name: 'Tasha Williams' }),
        mkRow({ contactId: 'c2', name: 'Rene Okafor', lastActivityAt: '2026-06-17T09:00:00.000Z' }),
      ],
      nextCursor: null,
      truncated: true,
    });
    render(
      <MemoryRouter initialEntries={['/inbox?filter=unread']}>
        <Inbox />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark Tasha Williams read' })).toBeInTheDocument(),
    );
    // The server DID say truncated on a page it filled - the banner must not be
    // showing even now, which is the shipped behavior this test must not weaken.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => screen.getByRole('button', { name: 'Mark Tasha Williams read' }).click());
    act(() => screen.getByRole('button', { name: 'Mark Rene Okafor read' }).click());

    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your inbox/i)).not.toBeInTheDocument();
    expect(markInboxRead).toHaveBeenCalledTimes(2);
  });

  // The other half stays green: an EMPTY server page that says truncated is a
  // real early end and still renders the failure state through the same wiring.
  it('COMPOSED: an EMPTY truncated page still renders the failure state', async () => {
    getInbox.mockResolvedValue({ rows: [], nextCursor: null, truncated: true });
    render(
      <MemoryRouter initialEntries={['/inbox?filter=unread']}>
        <Inbox />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/couldn.t load your inbox/i)).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });
});

describe('useInbox - page one persists (spec 5.5-5.8)', () => {
  const KEY = inboxListKey('anon', 'all', 2);
  function snapshot(rows: InboxRow[], cursor: string | null, scrollTop = 0) {
    return { head: rows, tail: [], cursor, groupsTruncated: false, truncated: false, scrollTop };
  }

  it('every head read and every page requests the hook limit', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR'));
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2' })], null));
    render(<Probe filter="all" limit={7} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect((getInbox.mock.calls[0]?.[0] as { limit: number }).limit).toBe(7);
    expect((getInbox.mock.calls[1]?.[0] as { limit: number }).limit).toBe(7);
  });

  it('a store hit renders ready on the first paint, unarmed, and issues exactly one live head read under StrictMode', async () => {
    saveInboxList(KEY, snapshot([mkRow({ contactId: 'r1' }), mkRow({ contactId: 'r2' })], 'OLD', 55));
    let release: (v: InboxPage) => void = () => {};
    getInbox.mockImplementation(() => new Promise<InboxPage>((res) => { release = res; }));
    render(
      <StrictMode>
        <Probe filter="all" limit={2} />
      </StrictMode>,
    );
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('ids')).toHaveTextContent('c:r1,c:r2');
    expect(screen.getByTestId('armed')).toHaveTextContent('false');
    expect(screen.getByTestId('restoredScrollTop')).toHaveTextContent('55');
    // StrictMode issued two calls; the first was aborted by the simulated
    // cleanup. Exactly one is live: resolving it commits.
    const live = getInbox.mock.calls.filter((c) => !(c[1] as AbortSignal | undefined)?.aborted);
    expect(live).toHaveLength(1);
    act(() => release(pageOf([mkRow({ contactId: 'n1' }), mkRow({ contactId: 'n2' })], 'NEW')));
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:n1,c:n2'));
    expect(screen.getByTestId('armed')).toHaveTextContent('true');
  });

  it("the restore's complete head read replaces the whole restored list and issues no cursor request", async () => {
    const restoredRows = [mkRow({ contactId: 'r1' }), mkRow({ contactId: 'r2' }), mkRow({ contactId: 'r3' }), mkRow({ contactId: 'r4' })];
    saveInboxList(KEY, snapshot(restoredRows, 'TAIL'));
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'n1' }), mkRow({ contactId: 'r1' })], 'NEW'));
    render(<Probe filter="all" limit={2} />);
    expect(screen.getByTestId('count')).toHaveTextContent('4');
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:n1,c:r1'));
    expect(getInbox).toHaveBeenCalledTimes(1);
    expect((getInbox.mock.calls[0]?.[0] as { cursor?: string }).cursor).toBeUndefined();
  });

  it('a commit saves the committed value: a loaded page saves its rows AND its cursor together', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], 'C2'));
    render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    expect(loadInboxList('anon:all:1')?.cursor).toBe('C1');
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    const saved = loadInboxList('anon:all:1');
    expect(saved?.tail.map((r) => r.contactId)).toEqual(['c2']);
    expect(saved?.cursor).toBe('C2');
  });

  it('a reset writes no snapshot: switching filters leaves the new key empty until its page commits', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    let release: (v: InboxPage) => void = () => {};
    const { rerender } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockImplementation(() => new Promise<InboxPage>((res) => { release = res; }));
    rerender(<Probe filter="unread" limit={2} />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(loadInboxList('anon:unread:2')).toBeUndefined();
    expect(loadInboxList(KEY)?.head.map((r) => r.contactId)).toEqual(['c1']);
    act(() => release(pageOf([mkRow({ contactId: 'u1' })], null)));
    await waitFor(() => expect(loadInboxList('anon:unread:2')).toBeDefined());
  });

  it('a loadMore that settles after unmount neither commits nor saves', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'));
    let release: (v: InboxPage) => void = () => {};
    const { unmount } = render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    getInbox.mockImplementation(() => new Promise<InboxPage>((res) => { release = res; }));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    unmount();
    const before = loadInboxList('anon:all:1');
    await act(async () => {
      release(pageOf([mkRow({ contactId: 'c2' })], 'C2'));
      await Promise.resolve();
    });
    expect(loadInboxList('anon:all:1')).toEqual(before);
    expect(before?.cursor).toBe('C1');
  });

  it('is alive again after a StrictMode replay: a later page commit saves', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], null));
    render(
      <StrictMode>
        <Probe filter="all" limit={1} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(loadInboxList('anon:all:1')?.cursor).toBeNull();
  });

  it('the unmount save folds in a pending patch made in the same act and the reported scrollTop', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })], null));
    let settle: () => void = () => {};
    markInboxRead.mockImplementation(() => new Promise<void>((res) => { settle = res; }));
    const { unmount } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    act(() => {
      screen.getByRole('button', { name: 'scroll' }).click();
      screen.getByRole('button', { name: 'read:c:c1' }).click();
      unmount();
    });
    const saved = loadInboxList(KEY);
    expect(saved?.head[0]?.unreadCount).toBe(0);
    expect(saved?.scrollTop).toBe(321);
    settle();
  });

  it('loadMore dedupes against the list by rowKey and by conversationId across kinds, and arms only on new rows', async () => {
    const relay = mkRow({ kind: 'relay_group', contactId: undefined, conversationId: 'x', name: 'With x', status: 'open' });
    const group = { ...relay, kind: 'group_text' as const, status: undefined };
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' }), relay], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' }), group], 'C2'))
      .mockResolvedValueOnce(pageOf([], 'C3'));
    render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('2'));
    expect(screen.getByTestId('ids')).toHaveTextContent('c:c1,gt:x');
    expect(screen.getByTestId('armed')).toHaveTextContent('true');
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('3'));
    expect(screen.getByTestId('armed')).toHaveTextContent('false');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('true');
  });

  it('pageEpoch bumps on head and page commits, not on a mark-read commit, a reset or a failure', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 1 })], 'C1'));
    const { rerender } = render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('loadingMore')).toHaveTextContent('false'));
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
    // A reset carries the epoch (never back to 0); the new filter's first
    // page then bumps it.
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'u1' })], null));
    rerender(<Probe filter="unread" limit={1} />);
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('2'));
  });

  it('a failed background head read with rows rendered keeps the rows and raises refreshFailed; a 404 does the same', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true'), { timeout: 2000 });
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    getInbox.mockRejectedValueOnce(new ApiError(404, 'http_404', 'gone'));
    act(() => screen.getByRole('button', { name: 'retry' }).click());
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  // Worklist S5 item 1 (spec decision 7, 5.7, invariant 4). The failure path
  // refuses on the FILTER axis only. A mark-read that commits while a
  // background head read is on the wire bumps the generation; if that read
  // then FAILS, the rows stay AND the banner shows. A generation check on the
  // failure path returns before the rows-rendered check and leaves a silently
  // stale list: no banner, so no Retry refresh either.
  it('a head read that fails after a mark-read committed under it keeps the rows and still raises refreshFailed', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })], null));
    let releaseRead: () => void = () => {};
    markInboxRead.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          releaseRead = () => res();
        }),
    );
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    // Mark read; the POST hangs.
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());

    // A background head read starts and hangs: it captured the PRE-commit
    // generation.
    let failHead: () => void = () => {};
    getInbox.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          failHead = () => rej(new ApiError(500, 'http_500', 'boom'));
        }),
    );
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2), { timeout: 2000 });

    // The POST commits first and bumps the generation. The store holds the
    // committed list, so the commit is visible there (the patch alone is not
    // saved until a commit).
    await act(async () => {
      releaseRead();
      await Promise.resolve();
    });
    await waitFor(() => expect(loadInboxList(KEY)?.head[0]?.unreadCount).toBe(0));

    // ...and only then does the head read fail.
    await act(async () => {
      failHead();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true');
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
  });

  it('Retry with rows rendered never shows the spinner and clears the banner when the read commits', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true'), { timeout: 2000 });
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c9' })], null));
    act(() => screen.getByRole('button', { name: 'retry' }).click());
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false'));
    expect(screen.getByTestId('ids')).toHaveTextContent('c:c9');
  });

  // Review Focus 3: a zero-row budget exit with rows rendered is not a failure.
  it('an incomplete head read (zero rows with a cursor) changes nothing and raises no banner', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'));
    render(<Probe filter="unknown" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockResolvedValueOnce(pageOf([], 'BUDGET'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('2'));
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false');
    expect(screen.getByTestId('ids')).toHaveTextContent('c:c1');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('true');
  });

  it('a failed initial load with no rows still yields error', async () => {
    getInbox.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false');
  });

  it('keys the store by operator: another operator never sees the saved list', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    const { unmount } = render(<Probe filter="all" limit={2} operatorId="u1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    unmount();
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2' })], null));
    render(<Probe filter="all" limit={2} operatorId="u2" />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:c2'));
  });

  it('seeds the scroll ref from the snapshot only when restoreScroll is set, so an immediate unmount saves the shown position', async () => {
    saveInboxList(KEY, snapshot([mkRow({ contactId: 'r1' })], null, 77));
    getInbox.mockImplementation(() => new Promise<InboxPage>(() => {}));
    const first = render(<Probe filter="all" limit={2} restoreScroll />);
    first.unmount();
    expect(loadInboxList(KEY)?.scrollTop).toBe(77);
    saveInboxList(KEY, snapshot([mkRow({ contactId: 'r1' })], null, 77));
    const second = render(<Probe filter="all" limit={2} restoreScroll={false} />);
    second.unmount();
    expect(loadInboxList(KEY)?.scrollTop).toBe(0);
  });

  // SC-3 (invariant 7): the unmount save is gated on `ready`, so a mount that
  // missed the store and never saw its first page commit saves nothing - not
  // on the StrictMode simulated unmount, not on the real one. An empty
  // snapshot here would restore as a 'ready' empty list on the next visit.
  it('the unmount save writes nothing before the first page commits (StrictMode store miss, hanging read)', () => {
    getInbox.mockImplementation(() => new Promise<InboxPage>(() => {}));
    const { unmount } = render(
      <StrictMode>
        <Probe filter="all" limit={2} />
      </StrictMode>,
    );
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    unmount();
    expect(loadInboxList(KEY)).toBeUndefined();
  });

  // SC-6 (spec 5.8, the filter-effect rule): the effect records the key it
  // just handled in BOTH branches, so a restored mount that leaves its tab and
  // comes back resets instead of skipping the reset with the other tab's rows.
  it('a restored mount that switches tab and back resets to the spinner, never showing the other tab rows', async () => {
    saveInboxList(KEY, snapshot([mkRow({ contactId: 'r1' })], null));
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'r1' })], null));
    const { rerender } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('1'));
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'u1', unreadCount: 1 })], null));
    rerender(<Probe filter="unread" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:u1'));
    getInbox.mockImplementation(() => new Promise<InboxPage>(() => {}));
    rerender(<Probe filter="all" limit={2} />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('ids').textContent).toBe('');
  });

  // SC-7 (spec 5.7): a filter change clears the banner with the rest of the
  // reset, before the new tab's first page lands.
  it('the reset clears refreshFailed: a banner raised on one tab is gone while the next tab loads', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    const { rerender } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true'), { timeout: 2000 });
    getInbox.mockImplementation(() => new Promise<InboxPage>(() => {}));
    rerender(<Probe filter="unread" limit={2} />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false');
  });

  // SC-7 (slice C gaps): the reset also drops the old tab's pending patches
  // and zeroes the scroll seed. Neither is rendered, so the new tab's first
  // SAVE is where a leftover would show: a patch folded into a row it never
  // touched, and the old tab's scroll position.
  it('the reset clears the pending patches and the scroll seed: the next tab saves neither', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })], null));
    markInboxRead.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { rerender } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    act(() => {
      screen.getByRole('button', { name: 'scroll' }).click();
      screen.getByRole('button', { name: 'read:c:c1' }).click();
    });
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })], null));
    rerender(<Probe filter="unread" limit={2} />);
    const unreadKey = inboxListKey('anon', 'unread', 2);
    await waitFor(() => expect(loadInboxList(unreadKey)).toBeDefined());
    expect(loadInboxList(unreadKey)?.head[0]?.unreadCount).toBe(2);
    expect(loadInboxList(unreadKey)?.scrollTop).toBe(0);
  });

  // SC-9 (section 6: markUnread's commit is a commitList writer). The row
  // flips at once, the settled POST commits it to the render AND the store,
  // and a patch commit is not a page commit, so the epoch stays put.
  it('markUnread flips the row at once, then commits it to the render and the store without moving the epoch', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 0 })], null));
    let settle: () => void = () => {};
    markInboxUnread.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          settle = () => res();
        }),
    );
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'unread:c:c1' }).click());
    expect(screen.getByTestId('unread')).toHaveTextContent('1');
    expect(markInboxUnread).toHaveBeenCalledWith({ contactId: 'c1' });
    await act(async () => {
      settle();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('unread')).toHaveTextContent('1');
    expect(loadInboxList(KEY)?.head[0]?.unreadCount).toBe(1);
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
  });

  it('markUnread rolls the row back to read when the request fails', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 0 })], null));
    markInboxUnread.mockRejectedValueOnce(new ApiError(500, 'http_500', 'no'));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'unread:c:c1' }).click());
    expect(screen.getByTestId('unread')).toHaveTextContent('1');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
    expect(loadInboxList(KEY)?.head[0]?.unreadCount).toBe(0);
  });

  // The sign-out ordering case: the unmount save ran, AuthGate cleared the
  // store, and only THEN does the POST settle. Nothing may write the store
  // again. (The commit's own alive gate and commitList's back each other up.)
  it('a markUnread that settles after unmount and the sign-out clear saves nothing', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 0 })], null));
    let settle: () => void = () => {};
    markInboxUnread.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          settle = () => res();
        }),
    );
    const { unmount } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    act(() => screen.getByRole('button', { name: 'unread:c:c1' }).click());
    unmount();
    clearInboxLists();
    await act(async () => {
      settle();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(loadInboxList(KEY)).toBeUndefined();
  });
});
