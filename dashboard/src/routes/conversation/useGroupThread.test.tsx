import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../api/index.js';

const getConversationMessages = vi.fn();
// NOTE the NON-optional `event`: this hook wires onThreadEvent, which reads
// event.conversationId unconditionally, so a no-arg call throws a TypeError.
let lastHandlers: {
  onMessagePersisted?: (event: { conversationId?: string }) => void;
} = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useGroupThread } from './useGroupThread.js';

const BASE_MS = Date.parse('2026-08-13T10:00:00.000Z');
const MINUTE = 60_000;

function message(seq: number): Message {
  return {
    conversationId: 'g1',
    tsMsgId: `m${seq}`,
    provider_ts: new Date(BASE_MS + seq * MINUTE).toISOString(),
    direction: 'inbound',
    // 'tenant', not 'contact': MessageAuthor has no 'contact' member and the
    // `as Message` cast of one does not compile.
    author: 'tenant',
    type: 'sms',
    body: `m${seq}`,
    delivery_status: 'delivered',
  } as Message;
}

function page(count: number, startSeq: number): Message[] {
  return Array.from({ length: count }, (_, i) => message(startSeq + count - 1 - i));
}

async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function Probe({ conversationId = 'g1' }: { conversationId?: string }): React.JSX.Element {
  const { status, items, hasOlder, loadingOlder, loadOlder, olderPagesLoaded } =
    useGroupThread(conversationId);
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
  lastHandlers = {};
});

describe('useGroupThread paging', () => {
  it('reports hasOlder when the first page comes back full', async () => {
    getConversationMessages.mockResolvedValue(page(50, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the first page is short', async () => {
    getConversationMessages.mockResolvedValue(page(4, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  it('requests the older page with a before bound and prepends it', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    getConversationMessages.mockResolvedValueOnce(page(2, 8));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getConversationMessages).toHaveBeenLastCalledWith(
      'g1',
      { limit: 50, before: 'm10' },
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));
  });

  // NOTE the payload: this hook FILTERS by conversationId (onThreadEvent).
  it('keeps loaded older history when a live refetch shifts the newest window', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    getConversationMessages.mockResolvedValueOnce(page(2, 8));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));

    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'g1' });
      await flushDebounce();
    });

    await waitFor(() => {
      const ids = screen.getByTestId('ids').textContent ?? '';
      expect(ids).toContain('m8,m9,m10,m11,m12');
      expect(ids).toContain('m61');
    });
    // One merged older page, and the SSE refetch did not add a phantom one.
    expect(screen.getByTestId('pages')).toHaveTextContent('1');
  });

  it('ignores an SSE event for a DIFFERENT conversation', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'someone-else' });
      await flushDebounce();
    });
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
  });

  // [R4] Same ref guard as the relay hook - tested here too, because the guard
  // was copied and a copied guard is an untested guard.
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
    expect(getConversationMessages).toHaveBeenCalledTimes(2); // first page + ONE older

    await act(async () => {
      release([]);
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
  });

  it('replaces rather than merges when the conversation changes', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 100));
    const { rerender } = render(<Probe conversationId="g1" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m100,m101,m102'));

    getConversationMessages.mockResolvedValueOnce(page(2, 200));
    rerender(<Probe conversationId="g2" />);

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m200,m201'));
    expect(screen.getByTestId('ids')).not.toHaveTextContent('m100');
  });

  // Adjudication A4, as in the relay suite: the first load goes through
  // mergeTimelineItems([], fresh), so same-instant messages sort by ascending id
  // on the first paint instead of reshuffling on the first SSE refetch.
  it('orders same-instant messages by id on the FIRST load, before any merge', async () => {
    const at = new Date(BASE_MS).toISOString();
    const tied = (id: string): Message =>
      ({
        conversationId: 'g1',
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

    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'g1' });
      await flushDebounce();
    });
    expect(screen.getByTestId('ids')).toHaveTextContent('m1,m2');
  });
});
