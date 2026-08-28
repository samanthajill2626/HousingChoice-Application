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

import { toTimelineMessage, useRelayThread } from './useRelayThread.js';

// Instants are built from a base epoch + i minutes so no fixture can produce an
// impossible clock reading like 10:60.
const BASE_MS = Date.parse('2026-08-13T10:00:00.000Z');
const MINUTE = 60_000;

describe('toTimelineMessage - import provenance', () => {
  // A converted carrier group text carries pre-go-live history whose rows the
  // importer stamped `sent` with no receipt behind it. The multi-party mapper
  // has to carry the stamp through, or the group view keeps flagging every
  // historical bubble "Sent - not confirmed" after the 1:1 timeline stopped.
  const base = {
    conversationId: 'c1',
    tsMsgId: '2026-03-01T10:00:00.000Z#SM1',
    provider_ts: '2026-03-01T10:00:00.000Z',
    direction: 'outbound',
    author: 'teammate',
    type: 'sms',
    body: 'history',
    delivery_status: 'sent',
  };

  it('carries imported:true off the raw stored row', () => {
    const m = { ...base, imported_from: 'quo-airtable-import' } as unknown as Message;
    expect(toTimelineMessage(m)).toMatchObject({ kind: 'message', imported: true });
  });

  it('leaves imported ABSENT on a row we sent ourselves', () => {
    expect(toTimelineMessage(base as unknown as Message)).not.toHaveProperty('imported');
  });
});

describe('toTimelineMessage - masked relay calls', () => {
  it('maps safe call metadata instead of dropping the call or forwarding media', () => {
    const call = {
      conversationId: 'c1',
      tsMsgId: '2026-08-24T10:00:00.000Z#CA1',
      provider_sid: 'CA1',
      provider_ts: '2026-08-24T10:00:00.000Z',
      direction: 'inbound',
      author: 'tenant',
      type: 'call',
      delivery_status: 'delivered',
      masked: true,
      relay_sender_key: 'contact-alice',
      call_party_label: 'Bob',
      call_status: 'completed',
      call_outcome: 'answered',
      call_duration: 42,
      relay_refusal_reason: 'non_member',
      relay_external_caller_phone: '+16175550198',
      relay_external_caller_contact_id: 'contact-external',
      relay_external_caller_display_name: 'Morgan Lee',
      // Defense in depth: even a malformed masked row must not put media on the
      // relay TimelineCall wire shape.
      recording_s3_key: 'recordings/forbidden.wav',
      transcript: 'must not render',
      transcript_status: 'completed',
    } as unknown as Message;

    expect(toTimelineMessage(call)).toEqual({
      kind: 'call',
      id: '2026-08-24T10:00:00.000Z#CA1',
      at: '2026-08-24T10:00:00.000Z',
      conversationId: 'c1',
      direction: 'inbound',
      author: 'tenant',
      relay_sender_key: 'contact-alice',
      call_party_label: 'Bob',
      call_status: 'completed',
      call_outcome: 'answered',
      call_duration: 42,
      relay_refusal_reason: 'non_member',
      relay_external_caller_phone: '+16175550198',
      relay_external_caller_contact_id: 'contact-external',
      relay_external_caller_display_name: 'Morgan Lee',
    });
  });

  it('does not forward malformed external caller fields or an unrecognised refusal reason', () => {
    const call = {
      conversationId: 'c1',
      tsMsgId: '2026-08-24T10:00:00.000Z#CA2',
      provider_sid: 'CA2',
      provider_ts: '2026-08-24T10:00:00.000Z',
      direction: 'inbound',
      author: 'unknown',
      type: 'call',
      delivery_status: 'delivered',
      relay_refusal_reason: 'not_member',
      relay_external_caller_phone: 6175550198,
      relay_external_caller_contact_id: { id: 'contact-external' },
      relay_external_caller_display_name: ['Morgan Lee'],
    } as unknown as Message;

    expect(toTimelineMessage(call)).toEqual({
      kind: 'call',
      id: '2026-08-24T10:00:00.000Z#CA2',
      at: '2026-08-24T10:00:00.000Z',
      conversationId: 'c1',
      direction: 'inbound',
      author: 'unknown',
    });
  });
});

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

  // Spec 4.5: "empty older pages leave it untouched". Reachable BY DESIGN, not by
  // accident - spec 4.4's heuristic means every thread whose length is an exact
  // multiple of the page size ends on exactly this click. A bump here would fire
  // <Timeline>'s scroll anchor for a prepend that never happened, and the consume
  // branch returns before the pill logic, so an append coalesced into the same
  // commit is both scrolled past and has its "New messages" pill swallowed.
  it('leaves olderPagesLoaded untouched when the older page comes back EMPTY', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    getConversationMessages.mockResolvedValueOnce(page(2, 8)); // a real prepend
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('pages')).toHaveTextContent('1'));

    getConversationMessages.mockResolvedValueOnce([]); // nothing older after all
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
    expect(screen.getByTestId('pages')).toHaveTextContent('1');
    expect(screen.getByTestId('ids')).toHaveTextContent('m8,m9,m10');
  });

  // The guard is on the MAPPED page, not the raw one: buildRelayItems drops
  // email, so a page that came back FULL can still prepend nothing. The bound
  // and hasOlder still move, so the operator can page THROUGH such a run.
  it('leaves olderPagesLoaded untouched when a full older page maps to no rows', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    // 50 rows the relay mapper drops entirely.
    const emails = page(50, 60).map((m) => ({ ...m, tsMsgId: `email${m.tsMsgId}`, type: 'email' }));
    getConversationMessages.mockResolvedValueOnce(emails);
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
    expect(screen.getByTestId('pages')).toHaveTextContent('0');
    // ...but the operator can keep paging: the bound advanced to the raw page's
    // oldest row and the full page kept the control alive.
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('true');
    getConversationMessages.mockResolvedValueOnce([]);
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getConversationMessages).toHaveBeenLastCalledWith(
      'c1',
      { limit: 50, before: `emailm60` },
      expect.anything(),
    );
  });

  // The isFirstLoad baseline guard. Without it, ONE inbound message after the
  // operator has paged a thread back to its beginning resurrects the control
  // permanently: the refetched newest page is full, so hasOlder flips back to
  // true and the bound is re-baselined into history already held - every later
  // click then re-reads rows the merge already has and changes nothing on screen.
  it('does not resurrect a retired control when an SSE refetch reads a FULL page', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('hasOlder')).toHaveTextContent('true'));

    // Page back to the very beginning: a SHORT page retires the control.
    getConversationMessages.mockResolvedValueOnce(page(2, 8)); // m8, m9
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('hasOlder')).toHaveTextContent('false'));

    // One inbound message; the debounced refetch reads a FULL newest page.
    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
      await flushDebounce();
    });
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');

    // ...and the bound was not re-baselined either: the next read still starts
    // from the oldest row the operator actually walked back to, not from the
    // newest page's tail.
    getConversationMessages.mockResolvedValueOnce([]);
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getConversationMessages).toHaveBeenLastCalledWith(
      'c1',
      { limit: 50, before: 'm8' },
      expect.anything(),
    );
  });

  // A late-settling ABORTED older request must not clear the in-flight guard
  // belonging to a NEWER one. Unreachable through the button today (loadingOlder
  // disables it), which is why it is asserted here rather than through the UI:
  // the deferred scroll-triggered auto-loader calls loadOlder() programmatically.
  it('an aborted older request does not release the guard held by a newer one', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // c1 first page
    let releaseC1: (v: Message[]) => void = () => {};
    getConversationMessages.mockReturnValueOnce(
      new Promise<Message[]>((resolve) => {
        releaseC1 = resolve;
      }),
    );
    const { rerender } = render(<Probe conversationId="c1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click(); // c1 older, in flight
    });

    // Switch threads: the reset effect aborts c1's older request.
    getConversationMessages.mockResolvedValueOnce(page(50, 100)); // c2 first page
    let releaseC2: (v: Message[]) => void = () => {};
    getConversationMessages.mockReturnValueOnce(
      new Promise<Message[]>((resolve) => {
        releaseC2 = resolve;
      }),
    );
    rerender(<Probe conversationId="c2" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m100'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click(); // c2 older, in flight
    });
    expect(getConversationMessages).toHaveBeenCalledTimes(4);

    // c1's aborted request finally settles, AFTER c2's is already in flight.
    await act(async () => {
      releaseC1([]);
    });

    // c2's page is still in flight, so a further call must be a no-op.
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getConversationMessages).toHaveBeenCalledTimes(4);
    await act(async () => {
      releaseC2([]);
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
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

  // A debounced refetch armed for the PREVIOUS thread must not survive the
  // switch. The timer captured the old `fetchNow` (and with it the old
  // conversationId), so if it fires after the switch it reads thread A and
  // writes the result into the hook instance now showing thread B. Under the
  // pre-paging replace semantics that was transient - the next refetch for B
  // overwrote it. Under merge-by-id it is PERMANENT: A's rows are unioned in
  // and nothing ever removes them.
  it('does not let a refetch armed before a switch write the old thread into the new one', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 100)); // c1: m100..m102
    const { rerender } = render(<Probe conversationId="c1" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m100,m101,m102'));

    // An org-wide event arms the 300ms timer while c1 is still mounted. The relay
    // hook subscribes UNFILTERED, so any message in the org arms it.
    act(() => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
    });

    // The operator switches threads inside the debounce window.
    getConversationMessages.mockResolvedValueOnce(page(2, 200)); // c2: m200, m201
    rerender(<Probe conversationId="c2" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m200,m201'));

    // Let the armed timer's deadline pass. If it survived the switch it fetches
    // c1 again and merges m100..m102 into c2's transcript.
    await act(async () => {
      await flushDebounce();
    });

    expect(screen.getByTestId('ids')).toHaveTextContent('m200,m201');
    expect(screen.getByTestId('ids')).not.toHaveTextContent('m100');
    // Two reads total: c1's first load and c2's first load. A third means the
    // stale timer fired.
    expect(getConversationMessages).toHaveBeenCalledTimes(2);
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
