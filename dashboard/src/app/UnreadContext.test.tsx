import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationUpdatedEvent, EventStreamHandlers, InboxUnreadCount } from '../api/index.js';
import { ApiError } from '../api/index.js';

const getInbox = vi.fn();
const getUnreadCount = vi.fn();
const getUnmatchedEmail = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    getInbox: (...a: unknown[]) => getInbox(...a),
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
    getUnmatchedEmail: (...a: unknown[]) => getUnmatchedEmail(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { UnreadProvider, useUnread } from './UnreadContext.js';
import { contactClearKey } from './unreadKeys.js';

/** The badge wire shape. `capped`/`truncated` default false - the tests that care
 *  about them say so explicitly. */
function countOf(unreadCount: number, over: Partial<InboxUnreadCount> = {}): InboxUnreadCount {
  return { unreadCount, capped: false, truncated: false, ...over };
}
function convEvent(): ConversationUpdatedEvent {
  return {
    conversationId: 'x',
    last_activity_at: '2026-06-17T11:00:00.000Z',
    unread_count: 1,
    type: 'tenant_1to1',
    participant_display_name: 'A',
  };
}
/** Flush the awaited fetch microtasks + advance timers by `ms` inside act. Only
 *  for the fake-timer suites below. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function click(name: string): void {
  act(() => {
    screen.getByRole('button', { name }).click();
  });
}

function Probe(): React.JSX.Element {
  const { unread, unmatchedUnread, noteRowsCleared, rollbackRowsCleared } = useUnread();
  return (
    <>
      <span data-testid="unread">{unread === null ? 'null' : String(unread)}</span>
      <span data-testid="unmatched">
        {unmatchedUnread === null ? 'null' : String(unmatchedUnread)}
      </span>
      <button type="button" onClick={() => noteRowsCleared([contactClearKey('c1')])}>
        clear-c1
      </button>
      <button type="button" onClick={() => noteRowsCleared([contactClearKey('c2')])}>
        clear-c2
      </button>
      <button type="button" onClick={() => noteRowsCleared([contactClearKey('c3')])}>
        clear-c3
      </button>
      <button type="button" onClick={() => rollbackRowsCleared([contactClearKey('c1')])}>
        rollback-c1
      </button>
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
  getUnreadCount.mockReset();
  // Benign default so the provider's SECOND (unmatched) fetch never rejects in the
  // inbox-focused tests; the unmatched tests below override it.
  getUnmatchedEmail.mockReset().mockResolvedValue({ rows: [], nextCursor: null, unreadCount: 0 });
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('UnreadProvider', () => {
  it('fetches the cheap count endpoint, never a page of inbox rows', async () => {
    getUnreadCount.mockResolvedValue(countOf(3));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    expect(getUnreadCount).toHaveBeenCalled();
    expect(getInbox).not.toHaveBeenCalled();
  });

  it('exposes null (no badge) when the backend 404s', async () => {
    getUnreadCount.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('null'));
  });

  it('refetches on an SSE conversation.updated', async () => {
    getUnreadCount.mockResolvedValueOnce(countOf(1)).mockResolvedValueOnce(countOf(5));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));
    act(() => {
      sse.onConversationUpdated?.(convEvent());
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('5'));
  });

  it('reconciles when the SSE stream (re)opens', async () => {
    getUnreadCount.mockResolvedValueOnce(countOf(1)).mockResolvedValueOnce(countOf(6));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));
    act(() => {
      sse.onOpen?.();
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('6'));
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
    getUnreadCount.mockResolvedValue(countOf(2));
    getUnmatchedEmail.mockResolvedValue({ rows: [], nextCursor: null, unreadCount: 7 });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    expect(screen.getByTestId('unmatched')).toHaveTextContent('7');
  });
});

describe('UnreadProvider - the optimistic pending-clears layer', () => {
  it('decrements the badge SYNCHRONOUSLY when a row is cleared', async () => {
    getUnreadCount.mockResolvedValue(countOf(3));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    click('clear-c1');
    // No await: the whole point of this layer is that the badge moves with the
    // click rather than ~2s later, when the reconcile fetch lands.
    expect(screen.getByTestId('unread')).toHaveTextContent('2');
  });

  it('is idempotent per key, so one logical row decrements the badge once', async () => {
    getUnreadCount.mockResolvedValue(countOf(3));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    click('clear-c1');
    click('clear-c1');
    click('clear-c1');
    expect(screen.getByTestId('unread')).toHaveTextContent('2');
  });

  it('restores the count when a clear is rolled back', async () => {
    getUnreadCount.mockResolvedValue(countOf(3));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    click('clear-c1');
    expect(screen.getByTestId('unread')).toHaveTextContent('2');
    click('rollback-c1');
    expect(screen.getByTestId('unread')).toHaveTextContent('3');
  });

  it('clamps the displayed count at 0', async () => {
    getUnreadCount.mockResolvedValue(countOf(1));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));
    click('clear-c1');
    click('clear-c2');
    click('clear-c3');
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
  });

  it('SUPPRESSES the decrement while the count is CAPPED', async () => {
    // The number is a floor at BADGE_COUNT_CAP; decrementing would flick the
    // rendered badge 99+ -> 99 -> 99+ for no information.
    getUnreadCount.mockResolvedValue(countOf(100, { capped: true }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('100'));
    click('clear-c1');
    expect(screen.getByTestId('unread')).toHaveTextContent('100');
  });

  it('still decrements when the count is TRUNCATED but not capped', async () => {
    // A truncated count is small and real-so-far, so instant feedback stays on.
    // This is the whole reason capped and truncated are separate wire fields.
    getUnreadCount.mockResolvedValue(countOf(4, { truncated: true }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('4'));
    click('clear-c1');
    expect(screen.getByTestId('unread')).toHaveTextContent('3');
  });

  it('expires a clear only on a fetch that STARTED after it, never by comparing values', async () => {
    let releaseFirst: () => void = () => {};
    getUnreadCount.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseFirst = () => res(countOf(3));
        }),
    );
    renderProvider();
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(1));

    // Recorded while fetch A is on the wire: A read the server BEFORE this clear
    // existed, so resolving it must NOT expire the clear.
    click('clear-c1');
    act(() => releaseFirst());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));

    // Fetch B starts AFTER the clear and reports the SAME number. A value
    // predicate ("only expire if the count dropped") would strand the clear
    // forever; the generation rule expires it and hands authority back.
    getUnreadCount.mockResolvedValueOnce(countOf(3));
    act(() => {
      sse.onConversationUpdated?.(convEvent());
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
  });

  it('discards a fetch that resolves after a newer fetch started', async () => {
    // Defense in depth: the newer fetch also aborts this one, but the abort can
    // land too late to reject, and only the generation guard covers that.
    let releaseStale: () => void = () => {};
    getUnreadCount.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseStale = () => res(countOf(9));
        }),
    );
    renderProvider();
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(1));
    getUnreadCount.mockResolvedValueOnce(countOf(5));
    act(() => {
      sse.onConversationUpdated?.(convEvent());
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('5'));
    act(() => releaseStale());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('unread')).toHaveTextContent('5');
  });

  it('is safe to consume with NO provider (the no-op defaults)', () => {
    render(<Probe />);
    expect(screen.getByTestId('unread')).toHaveTextContent('null');
    expect(() => click('clear-c1')).not.toThrow();
    expect(() => click('rollback-c1')).not.toThrow();
    expect(screen.getByTestId('unread')).toHaveTextContent('null');
  });

  it('hands down IDENTITY-STABLE clear functions across every re-render', async () => {
    // A11: markRead's dep array (useInbox) and the channel hooks' returned object
    // flow into consumer effect deps. A churning identity POST-loops there.
    const seen = new Set<unknown>();
    function IdentityProbe(): React.JSX.Element {
      const { unread, noteRowsCleared, rollbackRowsCleared } = useUnread();
      seen.add(noteRowsCleared);
      seen.add(rollbackRowsCleared);
      return (
        <>
          <span data-testid="unread">{unread === null ? 'null' : String(unread)}</span>
          <button type="button" onClick={() => noteRowsCleared([contactClearKey('c1')])}>
            clear-c1
          </button>
          <button type="button" onClick={() => rollbackRowsCleared([contactClearKey('c1')])}>
            rollback-c1
          </button>
        </>
      );
    }
    getUnreadCount.mockResolvedValueOnce(countOf(3)).mockResolvedValueOnce(countOf(2));
    render(
      <UnreadProvider>
        <IdentityProbe />
      </UnreadProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    click('clear-c1');
    click('rollback-c1');
    act(() => {
      sse.onConversationUpdated?.(convEvent());
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('2'));
    expect(seen.size).toBe(2);
  });
});

describe('UnreadProvider - follow-up reconcile and TTL (fake timers)', () => {
  beforeEach(() => {
    vi.useRealTimers(); // release the global Date pin (test/setup.ts) first
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules AT MOST ONE follow-up reconcile under a burst of clears', async () => {
    getUnreadCount.mockResolvedValue(countOf(5));
    renderProvider();
    await tick(0);
    expect(getUnreadCount).toHaveBeenCalledTimes(1);

    // Three clear-then-reconcile rounds. Each resolve expires that round's clear
    // and tries to schedule a follow-up; only the first one gets to.
    for (const name of ['clear-c1', 'clear-c2', 'clear-c3']) {
      click(name);
      act(() => {
        sse.onConversationUpdated?.(convEvent());
      });
      await tick(300);
    }
    expect(getUnreadCount).toHaveBeenCalledTimes(4); // mount + 3 debounced refetches
    expect(vi.getTimerCount()).toBe(1); // ONE pending follow-up, not three

    await tick(2000);
    expect(getUnreadCount).toHaveBeenCalledTimes(5);
    // The chain terminates: that follow-up expired nothing, so it scheduled
    // nothing. (The bound is one SCHEDULED follow-up at a time, not no-cascade -
    // a clear recorded between scheduling and firing would legitimately arm
    // another.)
    await tick(4000);
    expect(getUnreadCount).toHaveBeenCalledTimes(5);
  });

  it('skips the follow-up when a refetch is already pending', async () => {
    getUnreadCount.mockResolvedValueOnce(countOf(5));
    renderProvider();
    await tick(0);
    click('clear-c1');

    let releaseSecond: () => void = () => {};
    getUnreadCount.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseSecond = () => res(countOf(5));
        }),
    );
    act(() => {
      sse.onConversationUpdated?.(convEvent());
    });
    await tick(300);
    expect(getUnreadCount).toHaveBeenCalledTimes(2); // on the wire, hanging

    // A second event arms the debounce WHILE that fetch is still out.
    act(() => {
      sse.onConversationUpdated?.(convEvent());
    });
    getUnreadCount.mockResolvedValue(countOf(5));
    await act(async () => {
      releaseSecond();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getUnreadCount).toHaveBeenCalledTimes(2);

    // The already-pending debounce provides the convergence instead...
    await tick(300);
    expect(getUnreadCount).toHaveBeenCalledTimes(3);
    // ...and no follow-up was ever scheduled on top of it.
    await tick(2000);
    expect(getUnreadCount).toHaveBeenCalledTimes(3);
  });

  it('expires a clear on the TTL backstop when no reconcile ever happens', async () => {
    getUnreadCount.mockResolvedValue(countOf(3));
    renderProvider();
    await tick(0);
    click('clear-c1');
    expect(screen.getByTestId('unread')).toHaveTextContent('2');

    await tick(10_000);
    expect(screen.getByTestId('unread')).toHaveTextContent('3');
    expect(getUnreadCount).toHaveBeenCalledTimes(1); // no fetch was involved
  });
});
