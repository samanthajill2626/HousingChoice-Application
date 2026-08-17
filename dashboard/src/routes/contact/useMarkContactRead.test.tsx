import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const markInboxRead = vi.fn(() => Promise.resolve());
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();
let capturedOnMessage: (() => void) | undefined;

// This auto-mark is DELIBERATELY unwired from the nav badge's optimistic layer:
// it fires BLIND on mount / tab-visibility / new message, with no unread
// knowledge at all, so an optimistic decrement here would subtract rows the badge
// may never have counted. It reconciles through the cheap count refetch instead.
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    markInboxRead: (...a: unknown[]) => markInboxRead(...(a as [])),
    useEventStream: (h: { onMessagePersisted?: () => void }) => {
      capturedOnMessage = h.onMessagePersisted;
    },
  };
});

import {
  AUTO_READ_DRAIN_TIMEOUT_MS,
  useMarkContactRead,
  type AutoReadHandle,
} from './useMarkContactRead.js';

function Probe({ id }: { id: string }): null {
  useMarkContactRead(id);
  return null;
}

// Same probe, but it keeps the returned handle reachable so the S6 suppression
// tests can drive suppressAndDrain the way the header action will.
let handle: AutoReadHandle | undefined;

function HandleProbe({ id }: { id: string }): null {
  handle = useMarkContactRead(id);
  return null;
}

function currentHandle(): AutoReadHandle {
  if (handle === undefined) throw new Error('the hook returned no handle');
  return handle;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  vi.clearAllMocks();
  capturedOnMessage = undefined;
  handle = undefined;
  setVisibility('visible');
});

describe('useMarkContactRead', () => {
  it('marks the contact read on open (while visible)', async () => {
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
  });

  it('marks read again when a new message lands while looking', async () => {
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    // Let the first call settle so the in-flight guard releases.
    await act(async () => {});
    act(() => capturedOnMessage?.());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
  });

  it('coalesces triggers that land while a mark-read is in flight into ONE trailing re-mark', async () => {
    // Hold the first request open so the trailing logic is observable.
    let release: (() => void) | undefined;
    markInboxRead.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));

    // Two events inside the same round trip (e.g. a call's ring then its miss).
    act(() => capturedOnMessage?.());
    act(() => capturedOnMessage?.());
    // Still exactly one request outstanding - nothing fired concurrently.
    expect(markInboxRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });
    // Exactly one trailing re-mark, not one per dropped event.
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(markInboxRead).toHaveBeenCalledTimes(2);
  });

  it('switching contacts while A\'s mark-read is in flight marks B on arrival and never re-marks A', async () => {
    let releaseA: (() => void) | undefined;
    markInboxRead.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
    );
    const view = render(<Probe id="A" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'A' }));

    // Same hook instance, new contact (unkeyed route + useParams).
    view.rerender(<Probe id="B" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'B' }));

    // A's request settles later: it must not spend a trailing re-mark on A.
    await act(async () => {
      releaseA?.();
    });
    await act(async () => {});
    const contacts = (markInboxRead.mock.calls as unknown as Array<[{ contactId: string }]>).map(
      (c) => c[0].contactId,
    );
    expect(contacts).toEqual(['A', 'B']);
  });

  it('a trailing re-mark never fires after unmount (an unread the operator never saw stays unread)', async () => {
    let release: (() => void) | undefined;
    markInboxRead.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const view = render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    act(() => capturedOnMessage?.()); // arms the trailing re-mark
    view.unmount();
    await act(async () => {
      release?.();
    });
    await act(async () => {});
    expect(markInboxRead).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark read when the tab is hidden (background tab)', () => {
    setVisibility('hidden');
    render(<Probe id="k1" />);
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('does nothing without a contactId', () => {
    render(<Probe id="" />);
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('marks read when the tab becomes visible again while on the page', async () => {
    setVisibility('hidden');
    render(<Probe id="k1" />);
    expect(markInboxRead).not.toHaveBeenCalled();
    setVisibility('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
  });

  it('does NOT touch the nav badge context (it fires blind, with no unread knowledge)', async () => {
    render(<Probe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'k1' }));
    act(() => capturedOnMessage?.());
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });
});

// S6. Marking a thread UNREAD races this page's own auto-read: the three
// triggers above fire uncancelled, so an operator's mark-unread could be
// silently re-read by a request that was already in flight (or by the trailing
// re-mark). suppressAndDrain latches the auto-read off for this contact and
// then waits out whatever is in flight, so the POST that follows it lands last.
describe('useMarkContactRead - suppressAndDrain (S6)', () => {
  it('suppresses the message.persisted trigger once suppressAndDrain has run', async () => {
    render(<HandleProbe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    await act(async () => {});

    await act(async () => {
      await currentHandle().suppressAndDrain();
    });

    act(() => capturedOnMessage?.());
    await act(async () => {});
    expect(markInboxRead).toHaveBeenCalledTimes(1);
  });

  it('suppresses the TRAILING re-mark once suppressAndDrain has run', async () => {
    let release: (() => void) | undefined;
    markInboxRead.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<HandleProbe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    // Arms the trailing re-mark inside the in-flight request's window.
    act(() => capturedOnMessage?.());

    const drain = currentHandle().suppressAndDrain();
    await act(async () => {
      release?.();
    });
    await act(async () => {
      await drain;
    });

    // The coalescing machinery must NOT re-mark read at the exact moment the
    // operator asked for unread.
    expect(markInboxRead).toHaveBeenCalledTimes(1);
  });

  it('does not resolve suppressAndDrain until the in-flight mark-read has settled', async () => {
    let release: (() => void) | undefined;
    markInboxRead.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<HandleProbe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));

    // ORDER is the whole point: a trigger-only test stays green while the
    // ordering bug ships (the mark-unread POST overtaken by the read it raced).
    const order: string[] = [];
    const drain = currentHandle()
      .suppressAndDrain()
      .then(() => {
        order.push('drained');
      });

    await act(async () => {});
    expect(order).toEqual([]);

    await act(async () => {
      order.push('auto-read settled');
      release?.();
    });
    await act(async () => {
      await drain;
    });
    expect(order).toEqual(['auto-read settled', 'drained']);
  });

  it('resolves suppressAndDrain after the drain timeout when the auto-read never settles', async () => {
    // src/test/setup.ts pins Date globally; release that pin before taking FULL
    // fake timers, per the convention documented there.
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      markInboxRead.mockImplementationOnce(() => new Promise<void>(() => {}));
      render(<HandleProbe id="k1" />);
      expect(markInboxRead).toHaveBeenCalledTimes(1);

      let resolved = false;
      const drain = currentHandle()
        .suppressAndDrain()
        .then(() => {
          resolved = true;
        });
      await act(async () => {});
      expect(resolved).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_READ_DRAIN_TIMEOUT_MS);
      });
      await drain;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never waits on a PREVIOUS contact request (the in-flight handle is keyed by contact)', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      // A's auto-read never settles; B's resolves normally.
      markInboxRead.mockImplementationOnce(() => new Promise<void>(() => {}));
      const view = render(<HandleProbe id="A" />);
      expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'A' });
      view.rerender(<HandleProbe id="B" />);
      expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'B' });
      await act(async () => {});

      let resolved = false;
      await act(async () => {
        await currentHandle().suppressAndDrain();
        resolved = true;
      });
      // No timer advanced: a drain that awaited A's request would still be
      // pending here rather than resolved.
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a contact switch clears the latch, so the new contact is still auto-read', async () => {
    const view = render(<HandleProbe id="A" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'A' }));
    await act(async () => {});
    await act(async () => {
      await currentHandle().suppressAndDrain();
    });

    view.rerender(<HandleProbe id="B" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'B' }));
  });

  it('returns a STABLE handle across re-renders (a churning identity POST-loops consumers)', async () => {
    const view = render(<HandleProbe id="k1" />);
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledTimes(1));
    const first = currentHandle();

    view.rerender(<HandleProbe id="k1" />);
    expect(currentHandle()).toBe(first);
  });
});
