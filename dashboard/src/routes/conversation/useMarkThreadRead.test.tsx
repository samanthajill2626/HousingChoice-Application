import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const markConversationRead = vi.fn(() => Promise.resolve());
// Spied so the "mount effect ONLY" ruling is pinned: this hook must NOT grow
// the contact page's visibilitychange / message.persisted triggers. Adding them
// here would change shipped behavior on the two group views.
const useEventStream = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    markConversationRead: (...a: unknown[]) => markConversationRead(...(a as [])),
    useEventStream: (...a: unknown[]) => {
      useEventStream(...(a as []));
    },
  };
});

// AUTO_READ_DRAIN_TIMEOUT_MS and AutoReadHandle live with the contact auto-read,
// which is the home of the shared contract both hooks implement.
import { AUTO_READ_DRAIN_TIMEOUT_MS, type AutoReadHandle } from '../contact/useMarkContactRead.js';
import { useMarkThreadRead } from './useMarkThreadRead.js';

let handle: AutoReadHandle | undefined;

function Probe({ id }: { id: string }): null {
  handle = useMarkThreadRead(id);
  return null;
}

function currentHandle(): AutoReadHandle {
  if (handle === undefined) throw new Error('the hook returned no handle');
  return handle;
}

afterEach(() => {
  vi.clearAllMocks();
  handle = undefined;
});

describe('useMarkThreadRead', () => {
  it('marks the thread read on mount', async () => {
    render(<Probe id="conv-g1" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));
    expect(markConversationRead).toHaveBeenCalledTimes(1);
  });

  it('fires on MOUNT ONLY - no visibilitychange trigger and no SSE subscription', async () => {
    render(<Probe id="conv-g1" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(1));

    expect(useEventStream).not.toHaveBeenCalled();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {});
    expect(markConversationRead).toHaveBeenCalledTimes(1);
  });

  it('does not resolve suppressAndDrain until the in-flight mount read has settled', async () => {
    let release: (() => void) | undefined;
    markConversationRead.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<Probe id="conv-g1" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(1));

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

  it('resolves suppressAndDrain after the drain timeout when the mount read never settles', async () => {
    // src/test/setup.ts pins Date globally; release that pin before taking FULL
    // fake timers, per the convention documented there.
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      markConversationRead.mockImplementationOnce(() => new Promise<void>(() => {}));
      render(<Probe id="conv-g1" />);
      expect(markConversationRead).toHaveBeenCalledTimes(1);

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

  it('a conversationId change is still auto-read after a suppression (the latch is keyed, never sticky)', async () => {
    // Belt and braces for the comment in the hook: a conversationId change
    // normally arrives as a FRESH MOUNT (ConversationDetail's loading branch
    // unmounts the child), so this path should be unreachable - but a latch that
    // could stick forever under a live mount is the failure worth ruling out.
    const view = render(<Probe id="conv-g1" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));
    await act(async () => {});
    await act(async () => {
      await currentHandle().suppressAndDrain();
    });

    view.rerender(<Probe id="conv-g2" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g2'));
  });

  it('returns a STABLE handle across re-renders (a churning identity POST-loops consumers)', async () => {
    const view = render(<Probe id="conv-g1" />);
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(1));
    const first = currentHandle();

    view.rerender(<Probe id="conv-g1" />);
    expect(currentHandle()).toBe(first);
  });
});
