import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStreamHandlers, InboxPage, InboxRow } from '../api/index.js';
import { ApiError } from '../api/index.js';

const getInbox = vi.fn();
const getUnmatchedEmail = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    getInbox: (...a: unknown[]) => getInbox(...a),
    getUnmatchedEmail: (...a: unknown[]) => getUnmatchedEmail(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { UnreadProvider, useUnread } from './UnreadContext.js';

function row(): InboxRow {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'A',
    unreadCount: 1,
    preview: 'x',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
  };
}
function pageOf(n: number): InboxPage {
  return { rows: Array.from({ length: n }, row), nextCursor: null };
}
function Probe(): React.JSX.Element {
  const { unread, unmatchedUnread } = useUnread();
  return (
    <>
      <span data-testid="unread">{unread === null ? 'null' : String(unread)}</span>
      <span data-testid="unmatched">
        {unmatchedUnread === null ? 'null' : String(unmatchedUnread)}
      </span>
    </>
  );
}
function renderProvider(): void {
  render(
    <UnreadProvider>
      <Probe />
    </UnreadProvider>,
  );
}

beforeEach(() => {
  getInbox.mockReset();
  // Benign default so the provider's SECOND (unmatched) fetch never rejects in the
  // inbox-focused tests; the unmatched tests below override it.
  getUnmatchedEmail.mockReset().mockResolvedValue({ rows: [], nextCursor: null, unreadCount: 0 });
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('UnreadProvider', () => {
  it('fetches the unread feed and exposes the row count', async () => {
    getInbox.mockResolvedValue(pageOf(3));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    expect((getInbox.mock.calls[0]?.[0] as { filter: string }).filter).toBe('unread');
  });

  it('exposes null (no badge) when the backend 404s', async () => {
    getInbox.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('null'));
  });

  it('refetches on an SSE conversation.updated', async () => {
    getInbox.mockResolvedValueOnce(pageOf(1)).mockResolvedValueOnce(pageOf(5));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        participant_display_name: 'A',
      });
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('5'));
  });

  it('fetches the unmatched-email feed and exposes the server unreadCount', async () => {
    getUnmatchedEmail.mockResolvedValue({ rows: [], nextCursor: null, unreadCount: 4 });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unmatched')).toHaveTextContent('4'));
    // First positional arg is the 'unmatched' filter (never 'quarantine').
    expect(getUnmatchedEmail.mock.calls[0]?.[0]).toBe('unmatched');
  });

  it('exposes null (no unmatched badge) when the unmatched feed 404s', async () => {
    getUnmatchedEmail.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unmatched')).toHaveTextContent('null'));
  });

  it('refetches the unmatched count on an SSE unmatched_email.updated', async () => {
    getUnmatchedEmail
      .mockResolvedValueOnce({ rows: [], nextCursor: null, unreadCount: 1 })
      .mockResolvedValueOnce({ rows: [], nextCursor: null, unreadCount: 6 });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unmatched')).toHaveTextContent('1'));
    act(() => {
      sse.onUnmatchedEmailUpdated?.({ unmatchedId: 'um-1' });
    });
    await waitFor(() => expect(screen.getByTestId('unmatched')).toHaveTextContent('6'));
  });

  it('keeps the inbox and unmatched counts independent', async () => {
    getInbox.mockResolvedValue(pageOf(2));
    getUnmatchedEmail.mockResolvedValue({ rows: [], nextCursor: null, unreadCount: 7 });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    expect(screen.getByTestId('unmatched')).toHaveTextContent('7');
  });
});
