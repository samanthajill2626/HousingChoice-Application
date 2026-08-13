import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../api/index.js';

const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
let lastHandlers: {
  onMessagePersisted?: (event?: { conversationId?: string }) => void;
} = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversationScheduled: (...a: unknown[]) => getConversationScheduled(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useRelayThread } from './useRelayThread.js';

// Instants are built from a base epoch + i minutes so no fixture can produce an
// impossible clock reading like 10:60.
const BASE_MS = Date.parse('2026-08-13T10:00:00.000Z');
const MINUTE = 60_000;

function message(seq: number): Message {
  return {
    conversationId: 'c1',
    tsMsgId: `m${seq}`,
    provider_ts: new Date(BASE_MS + seq * MINUTE).toISOString(),
    direction: 'inbound',
    // 'tenant', not 'contact': MessageAuthor has no 'contact' member, and an
    // `as Message` cast of one does not compile (vitest strips types, tsc does
    // not - this is the typecheck gate's whole point).
    author: 'tenant',
    type: 'sms',
    body: `m${seq}`,
    delivery_status: 'delivered',
  } as Message;
}

/** `count` messages ending at sequence `startSeq + count - 1`, NEWEST FIRST. */
function page(count: number, startSeq: number): Message[] {
  return Array.from({ length: count }, (_, i) => message(startSeq + count - 1 - i));
}

/** Let the hook's 300ms SSE debounce fire. Real timers - this suite has no fake
 *  timers, and the global setup installs none (dashboard/src/test/setup.ts). */
async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function Probe({ conversationId = 'c1' }: { conversationId?: string }): React.JSX.Element {
  const { status, items, hasOlder, loadingOlder, loadOlder, olderPagesLoaded } =
    useRelayThread(conversationId);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="hasOlder">{String(hasOlder)}</span>
      <span data-testid="loadingOlder">{String(loadingOlder)}</span>
      <span data-testid="pages">{String(olderPagesLoaded)}</span>
      <button type="button" onClick={() => void loadOlder()}>
        load older
      </button>
    </div>
  );
}

beforeEach(() => {
  getConversationMessages.mockReset();
  getConversationScheduled.mockReset().mockResolvedValue({ scheduled: [] });
  lastHandlers = {};
});

describe('useRelayThread paging', () => {
  it('reports hasOlder when the first page comes back full', async () => {
    getConversationMessages.mockResolvedValue(page(50, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the first page is short', async () => {
    getConversationMessages.mockResolvedValue(page(3, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  it('requests the older page with a before bound and prepends it', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    getConversationMessages.mockResolvedValueOnce(page(2, 8)); // m8, m9
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getConversationMessages).toHaveBeenLastCalledWith(
      'c1',
      { limit: 50, before: 'm10' },
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  // The gap bug (spec 4.1) at the hook level.
  it('keeps loaded older history when a live refetch shifts the newest window', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    getConversationMessages.mockResolvedValueOnce(page(2, 8)); // older: m8, m9
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));

    // A new message arrives: the newest-50 window slides forward to m12..m61,
    // so m10 and m11 are no longer in it.
    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
      await flushDebounce();
    });

    await waitFor(() => {
      const ids = screen.getByTestId('ids').textContent ?? '';
      expect(ids).toContain('m8,m9,m10,m11,m12'); // no hole
      expect(ids).toContain('m61'); // the new tail landed
    });
  });

  // [R4] The guard is a REF, so it holds within a single render - two clicks in
  // one tick must produce ONE older request, not two.
  it('fires one older request for a double click', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    let release: (v: Message[]) => void = () => {};
    getConversationMessages.mockReturnValueOnce(
      new Promise<Message[]>((resolve) => {
        release = resolve;
      }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(screen.getByTestId('loadingOlder')).toHaveTextContent('true');
    expect(getConversationMessages).toHaveBeenCalledTimes(2); // first page + ONE older

    await act(async () => {
      release([]);
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
  });

  // The counter is <Timeline>'s prepend signal, so a bump WITHOUT a merge (or a
  // merge without a bump) silently breaks scroll anchoring on every surface.
  it('bumps olderPagesLoaded only when an older page actually merges', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('pages')).toHaveTextContent('0'); // first load is not a prepend

    // An SSE refetch is not a prepend.
    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
      await flushDebounce();
    });
    expect(screen.getByTestId('pages')).toHaveTextContent('0');

    // A merged older page IS.
    getConversationMessages.mockResolvedValueOnce(page(2, 8));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('pages')).toHaveTextContent('1'));

    // A FAILED older page is not - nothing merged, so nothing may signal one.
    getConversationMessages.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
    expect(screen.getByTestId('pages')).toHaveTextContent('1');
  });

  // The ONLY thing standing between two threads' transcripts fusing.
  it('replaces rather than merges when the conversation changes', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 100)); // m100..m102
    const { rerender } = render(<Probe conversationId="c1" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m100,m101,m102'));

    getConversationMessages.mockResolvedValueOnce(page(2, 200)); // m200, m201
    rerender(<Probe conversationId="c2" />);

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m200,m201'));
    expect(screen.getByTestId('ids')).not.toHaveTextContent('m100');
  });

  // Adjudication A4. buildRelayItems returns 0 for equal `at` and JS sort is
  // stable, so a raw page keeps NEWEST-FIRST order within a tie, while
  // mergeTimelineItems breaks the tie by ASCENDING id. Routing the first load
  // through mergeTimelineItems([], fresh) - still a replace - is what stops
  // same-instant messages from reshuffling on the first SSE refetch.
  it('orders same-instant messages by id on the FIRST load, before any merge', async () => {
    const at = new Date(BASE_MS).toISOString();
    const tied = (id: string): Message =>
      ({
        conversationId: 'c1',
        tsMsgId: id,
        provider_ts: at,
        direction: 'inbound',
        author: 'tenant',
        type: 'sms',
        body: id,
        delivery_status: 'delivered',
      }) as Message;
    // Newest-first raw order is the REVERSE of the id order.
    getConversationMessages.mockResolvedValue([tied('m2'), tied('m1')]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('ids')).toHaveTextContent('m1,m2');

    // ...and the order is unchanged after an SSE refetch of the same page.
    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
      await flushDebounce();
    });
    expect(screen.getByTestId('ids')).toHaveTextContent('m1,m2');
  });
});
