// useThreadMessages unit tests — the timeline state machine in isolation:
// ascending sort, optimistic send + reconcile, dedupe-by-tsMsgId on SSE, and
// the patch-only path for an event whose tsMsgId we already hold.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SendMessageResult } from '../../api';

const api = vi.hoisted(() => ({
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return { ...actual, listMessages: api.listMessages, sendMessage: api.sendMessage };
});

import { isPending, useThreadMessages } from './useThreadMessages';

const CONV = 'c1';

function msg(over: Partial<Message> = {}): Message {
  return {
    conversationId: CONV,
    tsMsgId: 't1#SM1',
    type: 'sms',
    direction: 'inbound',
    author: 'tenant',
    body: 'hi',
    provider_sid: 'SM1',
    provider_ts: 't1',
    delivery_status: 'delivered',
    created_at: '2026-06-12T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  api.listMessages.mockResolvedValue([]);
  api.sendMessage.mockResolvedValue({
    conversationId: CONV,
    providerSid: 'SM-real',
    tsMsgId: 't9#SM-real',
    status: 'queued',
  } satisfies SendMessageResult);
});

afterEach(() => vi.clearAllMocks());

describe('useThreadMessages', () => {
  it('loads newest-first and exposes them ascending by tsMsgId', async () => {
    api.listMessages.mockResolvedValue([
      msg({ tsMsgId: 't3#c', body: 'third' }),
      msg({ tsMsgId: 't1#a', body: 'first' }),
      msg({ tsMsgId: 't2#b', body: 'second' }),
    ]);
    const { result } = renderHook(() => useThreadMessages(CONV));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.body)).toEqual(['first', 'second', 'third']);
  });

  it('optimistically appends a pending bubble then reconciles to the server tsMsgId', async () => {
    const { result } = renderHook(() => useThreadMessages(CONV));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let sendPromise: Promise<void>;
    act(() => {
      sendPromise = result.current.send('outgoing');
    });
    // Pending bubble present immediately.
    expect(result.current.messages.some((m) => isPending(m) && m.body === 'outgoing')).toBe(true);

    await act(async () => {
      await sendPromise;
    });
    // Reconciled: no pending bubble, and the real tsMsgId is present once.
    const matches = result.current.messages.filter((m) => m.body === 'outgoing');
    expect(matches).toHaveLength(1);
    expect(isPending(matches[0]!)).toBe(false);
    expect(matches[0]!.tsMsgId).toBe('t9#SM-real');
  });

  it('dedupes an SSE event whose tsMsgId is already held (patches status, no refetch)', async () => {
    api.listMessages.mockResolvedValue([msg({ tsMsgId: 't1#a', direction: 'outbound', delivery_status: 'sent' })]);
    const { result } = renderHook(() => useThreadMessages(CONV));
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.listMessages.mockClear();

    act(() => {
      result.current.ingestEvent({
        conversationId: CONV,
        tsMsgId: 't1#a',
        direction: 'outbound',
        deliveryStatus: 'delivered',
      });
    });

    // No refetch for a known id; status patched in place.
    expect(api.listMessages).not.toHaveBeenCalled();
    const m = result.current.messages.find((x) => x.tsMsgId === 't1#a');
    expect(m?.delivery_status).toBe('delivered');
  });

  it('fetches + merges (deduped) for an SSE event with an unseen tsMsgId', async () => {
    const { result } = renderHook(() => useThreadMessages(CONV));
    await waitFor(() => expect(result.current.loading).toBe(false));

    api.listMessages.mockResolvedValue([
      msg({ tsMsgId: 'tNEW#x', body: 'fresh' }),
      msg({ tsMsgId: 'tNEW#x', body: 'fresh' }), // duplicate in the page
    ]);

    await act(async () => {
      result.current.ingestEvent({
        conversationId: CONV,
        tsMsgId: 'tNEW#x',
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.messages.filter((m) => m.tsMsgId === 'tNEW#x')).toHaveLength(1);
    });
  });

  it('ignores events for other conversations', async () => {
    const { result } = renderHook(() => useThreadMessages(CONV));
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.listMessages.mockClear();
    act(() => {
      result.current.ingestEvent({
        conversationId: 'other',
        tsMsgId: 'z#z',
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
    });
    expect(api.listMessages).not.toHaveBeenCalled();
  });

  it('retry re-sends the failed message body via sendMessage', async () => {
    const { result } = renderHook(() => useThreadMessages(CONV));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.retry(msg({ tsMsgId: 'tf#f', direction: 'outbound', body: 'retry me', delivery_status: 'failed' }));
    });
    expect(api.sendMessage).toHaveBeenCalledWith(CONV, { body: 'retry me' });
  });
});
