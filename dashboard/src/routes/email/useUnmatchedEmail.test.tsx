import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type {
  EventStreamHandlers,
  UnmatchedEmailItem,
  UnmatchedEmailPage,
  UnmatchedEmailRow,
} from '../../api/index.js';

const getUnmatchedEmail = vi.fn();
const markUnmatchedRead = vi.fn();
const linkUnmatched = vi.fn();
const createContactFromUnmatched = vi.fn();
const spamUnmatched = vi.fn();
const dismissUnmatched = vi.fn();
const releaseUnmatched = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnmatchedEmail: (...a: unknown[]) => getUnmatchedEmail(...a),
    markUnmatchedRead: (...a: unknown[]) => markUnmatchedRead(...a),
    linkUnmatched: (...a: unknown[]) => linkUnmatched(...a),
    createContactFromUnmatched: (...a: unknown[]) => createContactFromUnmatched(...a),
    spamUnmatched: (...a: unknown[]) => spamUnmatched(...a),
    dismissUnmatched: (...a: unknown[]) => dismissUnmatched(...a),
    releaseUnmatched: (...a: unknown[]) => releaseUnmatched(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { useUnmatchedEmail, type UnmatchedFilter } from './useUnmatchedEmail.js';

function mkRow(over: Partial<UnmatchedEmailRow> = {}): UnmatchedEmailRow {
  return {
    unmatchedId: 'a',
    status: 'unmatched',
    from: { address: 'stranger@example.com' },
    subject: 'Hello there',
    snippet: 'a short preview',
    attachments_meta: [],
    received_at: '2026-07-20T10:00:00.000Z',
    read: false,
    ...over,
  };
}
function mkDetail(over: Partial<UnmatchedEmailItem> = {}): UnmatchedEmailItem {
  return { ...mkRow(over), text: 'full body', ...over };
}
function pageOf(rows: UnmatchedEmailRow[], nextCursor: string | null = null): UnmatchedEmailPage {
  return { rows, nextCursor, unreadCount: rows.filter((r) => !r.read).length };
}

// Render the hook + expose its state and actions as clickable buttons.
function Probe({ filter }: { filter: UnmatchedFilter }): React.JSX.Element {
  const s = useUnmatchedEmail(filter);
  const [linked, setLinked] = useState('');
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="reads">{s.rows.map((r) => `${r.unmatchedId}:${String(r.read)}`).join(',')}</span>
      <span data-testid="hasMore">{String(s.hasMore)}</span>
      <span data-testid="linked">{linked}</span>
      <button onClick={() => s.loadMore()}>more</button>
      <button
        onClick={() => {
          void s.link('a', 'c9').then((r) => setLinked(r.conversationId));
        }}
      >
        link
      </button>
      {s.rows.map((r) => (
        <span key={r.unmatchedId}>
          <button onClick={() => s.markRead(r.unmatchedId)}>read:{r.unmatchedId}</button>
          <button onClick={() => void s.spam(r.unmatchedId).catch(() => {})}>spam:{r.unmatchedId}</button>
          <button onClick={() => void s.dismiss(r.unmatchedId).catch(() => {})}>
            dismiss:{r.unmatchedId}
          </button>
          <button onClick={() => void s.release(r.unmatchedId).catch(() => {})}>
            release:{r.unmatchedId}
          </button>
        </span>
      ))}
    </div>
  );
}

beforeEach(() => {
  getUnmatchedEmail.mockReset();
  markUnmatchedRead.mockReset().mockResolvedValue(mkDetail({ read: true }));
  linkUnmatched.mockReset().mockResolvedValue({ conversationId: 'conv7' });
  createContactFromUnmatched.mockReset().mockResolvedValue({ conversationId: 'conv7', contactId: 'c9' });
  spamUnmatched.mockReset().mockResolvedValue(mkDetail());
  dismissUnmatched.mockReset().mockResolvedValue(mkDetail());
  releaseUnmatched.mockReset().mockResolvedValue(mkDetail());
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('useUnmatchedEmail', () => {
  it('passes the active tab as the ?filter= arg and renders ready rows', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="quarantine" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getUnmatchedEmail.mock.calls[0]?.[0]).toBe('quarantine');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('refetches with the new filter when the tab switches', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow()]));
    const { rerender } = render(<Probe filter="unmatched" />);
    await waitFor(() => expect(getUnmatchedEmail).toHaveBeenCalledTimes(1));
    rerender(<Probe filter="quarantine" />);
    await waitFor(() => expect(getUnmatchedEmail).toHaveBeenCalledTimes(2));
    expect(getUnmatchedEmail.mock.calls[1]?.[0]).toBe('quarantine');
  });

  it('degrades to pending (not error) when the route 404s', async () => {
    getUnmatchedEmail.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('pending'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('goes to error on a non-404 failure', async () => {
    getUnmatchedEmail.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('appends a page on loadMore and clears hasMore at the end', async () => {
    getUnmatchedEmail
      .mockResolvedValueOnce(pageOf([mkRow({ unmatchedId: 'a' })], 'CUR'))
      .mockResolvedValueOnce(pageOf([mkRow({ unmatchedId: 'b' })], null));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
    expect(getUnmatchedEmail.mock.calls[1]?.[1]).toBe('CUR');
  });

  it('optimistically clears a row unread dot and POSTs read', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow({ unmatchedId: 'a', read: false })]));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('reads')).toHaveTextContent('a:false'));
    act(() => screen.getByRole('button', { name: 'read:a' }).click());
    await waitFor(() => expect(screen.getByTestId('reads')).toHaveTextContent('a:true'));
    expect(markUnmatchedRead).toHaveBeenCalledWith('a');
  });

  it('does not re-POST read for an already-read row', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow({ unmatchedId: 'a', read: true })]));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('reads')).toHaveTextContent('a:true'));
    act(() => screen.getByRole('button', { name: 'read:a' }).click());
    expect(markUnmatchedRead).not.toHaveBeenCalled();
  });

  it('optimistically removes a row on spam and calls the endpoint', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow({ unmatchedId: 'a' }), mkRow({ unmatchedId: 'b' })]));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'spam:a' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(spamUnmatched).toHaveBeenCalledWith('a');
  });

  it('removes a quarantined row on release', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow({ unmatchedId: 'a', status: 'quarantined' })]));
    render(<Probe filter="quarantine" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'release:a' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(releaseUnmatched).toHaveBeenCalledWith('a');
  });

  it('rolls the row back into the list when an action fails', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow({ unmatchedId: 'a' })]));
    let rejectDismiss: () => void = () => {};
    dismissUnmatched.mockImplementation(
      () => new Promise((_res, rej) => { rejectDismiss = () => rej(new ApiError(500, 'http_500', 'no')); }),
    );
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'dismiss:a' }).click());
    // Optimistic removal.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    // Failure -> rollback: the row reappears.
    act(() => rejectDismiss());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
  });

  it('links a row to a contact, removes it, and resolves the conversationId', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow({ unmatchedId: 'a' }), mkRow({ unmatchedId: 'x' })]));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    act(() => screen.getByRole('button', { name: 'link' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(linkUnmatched).toHaveBeenCalledWith('a', 'c9');
    await waitFor(() => expect(screen.getByTestId('linked')).toHaveTextContent('conv7'));
  });

  it('refetches (coalesced) the current tab on an SSE unmatched_email.updated', async () => {
    getUnmatchedEmail.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="unmatched" />);
    await waitFor(() => expect(getUnmatchedEmail).toHaveBeenCalledTimes(1));
    act(() => {
      sse.onUnmatchedEmailUpdated?.({ unmatchedId: 'a' });
      sse.onUnmatchedEmailUpdated?.({ unmatchedId: 'b' });
    });
    await waitFor(() => expect(getUnmatchedEmail).toHaveBeenCalledTimes(2));
  });
});
