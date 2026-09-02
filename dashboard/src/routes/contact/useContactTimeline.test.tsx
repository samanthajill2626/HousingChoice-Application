import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { ContactTimelinePage, ConversationSummary, ConversationsPage, Message } from '../../api/index.js';

const getContactTimeline = vi.fn();
const getAllConversations = vi.fn();
const getConversationMessages = vi.fn();
let lastHandlers: {
  onMessagePersisted?: () => void;
  onConversationUpdated?: () => void;
} = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getAllConversations: (...a: unknown[]) => getAllConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import type { TimelineItem } from '../../api/index.js';
import {
  involvesContact,
  normalizeServerItems,
  useContactTimeline,
} from './useContactTimeline.js';

function Probe({ contactId, kinds }: { contactId: string; kinds?: string }): React.JSX.Element {
  const { status, items, upcoming, source } = useContactTimeline(contactId, kinds);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="source">{source}</span>
      <span data-testid="count">{items.length}</span>
      <span data-testid="upcoming">{upcoming.length}</span>
    </div>
  );
}

const SERVER_PAGE: ContactTimelinePage = {
  nextCursor: null,
  items: [
    {
      kind: 'message',
      id: 's1',
      at: '2026-06-08T09:00:00Z',
      conversationId: 'c1',
      tsMsgId: 's1',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      delivery_status: 'delivered',
      body: 'from server',
    },
  ],
};

function msg(partial: Partial<Message> & Pick<Message, 'tsMsgId'>): Message {
  return {
    conversationId: 'c1',
    type: 'sms',
    direction: 'inbound',
    author: 'tenant',
    provider_sid: `SM-${partial.tsMsgId}`,
    provider_ts: '2026-06-08T09:00:00Z',
    delivery_status: 'delivered',
    created_at: '2026-06-08T09:00:00Z',
    ...partial,
  };
}

const CONVERSATIONS: ConversationSummary[] = [
    {
      conversationId: 'c1',
      type: 'tenant_1to1',
      participant_phone: '+14040100007',
      participants: [{ contactId: 'k1', phone: '+14040100007' }],
      preview: null,
      last_activity_at: '2026-06-08T09:00:00Z',
      unread_count: 0,
      sms_opt_out: false,
      participant_display_name: null,
    },
    {
      conversationId: 'c2',
      type: 'tenant_1to1',
      participant_phone: '+19990000000',
      participants: [{ contactId: 'OTHER', phone: '+19990000000' }],
      preview: null,
      last_activity_at: '2026-06-08T09:00:00Z',
      unread_count: 0,
      sms_opt_out: false,
      participant_display_name: null,
    },
  ];

beforeEach(() => {
  getContactTimeline.mockReset();
  getAllConversations.mockReset();
  getConversationMessages.mockReset();
  lastHandlers = {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useContactTimeline', () => {
  it('uses the server timeline when GET /timeline succeeds', async () => {
    getContactTimeline.mockResolvedValue(SERVER_PAGE);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('source').textContent).toBe('server');
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('falls back to conversations (filtered to the contact) on a 404', async () => {
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    getAllConversations.mockResolvedValue(CONVERSATIONS);
    // Only c1 (the contact's conversation) should be fetched.
    getConversationMessages.mockImplementation((cid: string) =>
      cid === 'c1' ? Promise.resolve([msg({ tsMsgId: 'm1', body: 'real seeded' })]) : Promise.resolve([]),
    );

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('source').textContent).toBe('fallback');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
    expect(getConversationMessages).toHaveBeenCalledWith('c1', {}, expect.anything());
  });

  it('never pulls a MULTI-PARTY thread into the 1:1 fallback timeline', async () => {
    // The roster match alone would accept it (the contact IS on the roster), and
    // the whole group transcript would land in this member's 1:1 timeline.
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    getAllConversations.mockResolvedValue([
        ...CONVERSATIONS,
        {
          conversationId: 'gt-1',
          type: 'group_text',
          participants: [
            { contactId: 'k1', phone: '+14040100007' },
            { contactId: 'OTHER', phone: '+19990000000' },
          ],
          preview: null,
          last_activity_at: '2026-06-09T09:00:00Z',
          unread_count: 0,
          sms_opt_out: false,
          participant_display_name: null,
        },
        {
          conversationId: 'relay-1',
          type: 'relay_group',
          participant_phone: '+15550190001',
          participants: [{ contactId: 'k1', phone: '+14040100007' }],
          preview: null,
          last_activity_at: '2026-06-09T10:00:00Z',
          unread_count: 0,
          sms_opt_out: false,
          participant_display_name: null,
        },
      ] as ConversationSummary[]);
    getConversationMessages.mockResolvedValue([]);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
    expect(getConversationMessages).toHaveBeenCalledWith('c1', {}, expect.anything());
  });

  it('threads the server upcoming[] bucket through to state', async () => {
    getContactTimeline.mockResolvedValue({
      ...SERVER_PAGE,
      upcoming: [
        {
          kind: 'scheduled',
          id: 'sched-1',
          at: '2026-06-18T15:00:00Z',
          conversationId: 'c1',
          source: 'tour_reminder',
          body: 'reminder',
          refType: 'tour',
          refId: 'tour-9',
        },
      ],
    } satisfies ContactTimelinePage);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('upcoming').textContent).toBe('1');
  });

  it('defaults upcoming to [] on the 404 fallback path', async () => {
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    getAllConversations.mockResolvedValue(CONVERSATIONS);
    getConversationMessages.mockResolvedValue([]);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('source').textContent).toBe('fallback'));
    expect(screen.getByTestId('upcoming').textContent).toBe('0');
  });

  it('surfaces an error state on a non-404 failure', async () => {
    getContactTimeline.mockRejectedValue(new ApiError(500, 'boom', 'server error'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });

  it('refetches when a message.persisted event arrives', async () => {
    getContactTimeline.mockResolvedValue(SERVER_PAGE);

    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(getContactTimeline).toHaveBeenCalledTimes(1);

    lastHandlers.onMessagePersisted?.();

    await waitFor(() => expect(getContactTimeline).toHaveBeenCalledTimes(2));
  });

  it('passes the kinds filter through to the server timeline', async () => {
    getContactTimeline.mockResolvedValue(SERVER_PAGE);

    render(<Probe contactId="k1" kinds="message,call" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(getContactTimeline).toHaveBeenCalledWith(
      'k1',
      { kinds: 'message,call' },
      expect.anything(),
    );
  });
});

describe('useContactTimeline — optimistic send', () => {
  let api: ReturnType<typeof useContactTimeline> | null = null;

  function OptProbe(): React.JSX.Element {
    const t = useContactTimeline('k1');
    api = t;
    return (
      <ul>
        {t.items.map((i) => (
          <li key={i.id} data-testid="item">
            {i.kind === 'message' ? `${i.body ?? ''}|${i.delivery_status}` : i.kind}
          </li>
        ))}
      </ul>
    );
  }

  const bodies = (): string[] =>
    screen.getAllByTestId('item').map((el) => el.textContent ?? '');

  afterEach(() => {
    api = null;
  });

  it('shows an outbound bubble as "queued" (Sending…) the instant a send starts', async () => {
    getContactTimeline.mockResolvedValue(SERVER_PAGE);
    render(<OptProbe />);
    await waitFor(() => expect(screen.getAllByTestId('item')).toHaveLength(1));

    act(() => {
      api!.addOptimistic('c1', 'on my way', { toPhone: '+14040100007' });
    });

    // Appears immediately (no await), outbound, status queued → "Sending…".
    expect(bodies()).toContain('on my way|queued');
    expect(screen.getAllByTestId('item')).toHaveLength(2);
    const optimistic = api!.items.find(
      (item) => item.kind === 'message' && item.body === 'on my way',
    );
    expect(optimistic).toMatchObject({ optimistic: true });
    expect(optimistic).not.toHaveProperty('transport_schema_version');
    expect(optimistic).not.toHaveProperty('requested_transport');
    expect(optimistic).not.toHaveProperty('actual_transport');
  });

  it('stamps the real status on resolve, then de-dupes once the server refetch carries it', async () => {
    getContactTimeline.mockResolvedValueOnce(SERVER_PAGE);
    render(<OptProbe />);
    await waitFor(() => expect(screen.getAllByTestId('item')).toHaveLength(1));

    let tempId = '';
    act(() => {
      tempId = api!.addOptimistic('c1', 'hi there');
    });
    act(() => {
      api!.resolveOptimistic(tempId, {
        conversationId: 'c1',
        providerSid: 'SM9',
        tsMsgId: 'srv-9',
        status: 'sent',
      });
    });
    // Reconciled bubble now reads "sent" — still the optimistic row (one copy).
    expect(bodies().filter((b) => b.startsWith('hi there'))).toEqual(['hi there|sent']);
    expect(api!.items.find((item) => item.kind === 'message' && item.body === 'hi there')).toMatchObject({
      optimistic: true,
      id: 'srv-9',
      delivery_status: 'sent',
    });

    // The SSE refetch brings the SERVER row (same tsMsgId, now delivered) → the
    // optimistic copy drops out, leaving exactly one "hi there" at the real status.
    getContactTimeline.mockResolvedValueOnce({
      nextCursor: null,
      items: [
        SERVER_PAGE.items[0]!,
        {
          kind: 'message',
          id: 'srv-9',
          at: '2026-06-08T09:05:00Z',
          conversationId: 'c1',
          tsMsgId: 'srv-9',
          direction: 'outbound',
          author: 'teammate',
          type: 'sms',
          delivery_status: 'delivered',
          body: 'hi there',
          transport_schema_version: 1,
          requested_transport: 'rcs',
          actual_transport: 'sms',
        },
      ],
    } satisfies ContactTimelinePage);
    act(() => {
      lastHandlers.onMessagePersisted?.();
    });

    await waitFor(() =>
      expect(bodies().filter((b) => b.startsWith('hi there'))).toEqual(['hi there|delivered']),
    );
    expect(screen.getAllByTestId('item')).toHaveLength(2); // s1 + the one reconciled row
    expect(api!.items.find((item) => item.kind === 'message' && item.body === 'hi there')).toMatchObject({
      transport_schema_version: 1,
      requested_transport: 'rcs',
      actual_transport: 'sms',
    });
    expect(api!.items.find((item) => item.kind === 'message' && item.body === 'hi there'))
      .not.toHaveProperty('optimistic');
  });

  it('removes the optimistic bubble when the send fails', async () => {
    getContactTimeline.mockResolvedValue(SERVER_PAGE);
    render(<OptProbe />);
    await waitFor(() => expect(screen.getAllByTestId('item')).toHaveLength(1));

    let tempId = '';
    act(() => {
      tempId = api!.addOptimistic('c1', 'nope');
    });
    expect(screen.getAllByTestId('item')).toHaveLength(2);

    act(() => {
      api!.failOptimistic(tempId);
    });
    expect(screen.getAllByTestId('item')).toHaveLength(1);
    expect(bodies().some((b) => b.startsWith('nope'))).toBe(false);
  });
});

describe('involvesContact', () => {
  it('matches a roster of {contactId} objects', () => {
    expect(involvesContact([{ contactId: 'c1' }, { contactId: 'c2' }], 'c2')).toBe(true);
    expect(involvesContact([{ contactId: 'c1' }], 'cX')).toBe(false);
  });

  it('matches a roster of bare contactId strings (seeded / 1:1 shape)', () => {
    expect(involvesContact(['c1', 'contact-tenant-0001'], 'contact-tenant-0001')).toBe(true);
    expect(involvesContact(['c1'], 'contact-tenant-0001')).toBe(false);
  });

  it('handles an empty / undefined roster', () => {
    expect(involvesContact([], 'c1')).toBe(false);
    expect(involvesContact(undefined, 'c1')).toBe(false);
  });
});

describe('normalizeServerItems', () => {
  const msg = (id: string, at?: string): TimelineItem =>
    ({ kind: 'message', id, type: 'sms', direction: 'inbound', author: 'tenant', delivery_status: 'delivered', ...(at !== undefined && { at }) }) as TimelineItem;

  it('derives at from the id prefix when the server omits it, ordered oldest→newest', () => {
    // Server shape observed in integration: id is "<ISO ts>#<msgid>", no `at`,
    // newest-first. Normalize → chronological with `at` populated.
    const out = normalizeServerItems([
      msg('2026-06-01T14:05:45.000Z#msg-0003'),
      msg('2026-06-01T14:02:10.000Z#msg-0002'),
      msg('2026-06-01T14:00:00.000Z#msg-0001'),
    ]);
    expect(out.map((i) => i.id)).toEqual([
      '2026-06-01T14:00:00.000Z#msg-0001',
      '2026-06-01T14:02:10.000Z#msg-0002',
      '2026-06-01T14:05:45.000Z#msg-0003',
    ]);
    expect(out[0]?.at).toBe('2026-06-01T14:00:00.000Z');
  });

  it('keeps a proper server-provided at + order untouched (no-op)', () => {
    const a = msg('x#1', '2026-06-01T09:00:00.000Z');
    const b = msg('y#2', '2026-06-01T10:00:00.000Z');
    const out = normalizeServerItems([a, b]);
    expect(out).toEqual([a, b]);
  });

  it('sorts items with no derivable instant last, without crashing', () => {
    const out = normalizeServerItems([
      msg('not-an-iso-id'),
      msg('2026-06-01T08:00:00.000Z#m'),
    ]);
    expect(out[0]?.id).toBe('2026-06-01T08:00:00.000Z#m');
    expect(out[1]?.id).toBe('not-an-iso-id');
  });
});

// A SECOND probe, alongside Probe: the existing one is depended on by every case
// above through its test ids, so paging gets its own p-prefixed surface.
function PagingProbe({
  contactId,
  kinds,
}: {
  contactId: string;
  kinds?: string;
}): React.JSX.Element {
  const {
    status,
    items,
    upcoming,
    upcomingTimezone,
    source,
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
  } = useContactTimeline(contactId, kinds);
  return (
    <div>
      <span data-testid="p-status">{status}</span>
      <span data-testid="p-source">{source}</span>
      <span data-testid="p-ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="p-upcoming">{upcoming.length}</span>
      <span data-testid="p-tz">{upcomingTimezone ?? 'none'}</span>
      <span data-testid="p-hasOlder">{String(hasOlder)}</span>
      <span data-testid="p-loadingOlder">{String(loadingOlder)}</span>
      <span data-testid="p-pages">{String(olderPagesLoaded)}</span>
      <button type="button" onClick={() => void loadOlder()}>
        load older
      </button>
    </div>
  );
}

// author is 'tenant', NOT 'contact': MessageAuthor has no 'contact' member, so an
// `as TimelineItem` cast of a 'contact' literal is a TS2352. Vitest strips types
// and would never notice; npm run typecheck would.
function timelineItem(id: string, at: string): TimelineItem {
  return {
    kind: 'message',
    id,
    at,
    conversationId: 'c1',
    tsMsgId: id,
    direction: 'inbound',
    author: 'tenant',
    type: 'sms',
    body: id,
    delivery_status: 'delivered',
  } as TimelineItem;
}

describe('useContactTimeline paging', () => {
  it('reports hasOlder from the server cursor', async () => {
    getContactTimeline.mockResolvedValue({
      items: [timelineItem('a', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the cursor is null', async () => {
    getContactTimeline.mockResolvedValue({
      items: [timelineItem('a', '2026-08-13T10:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
  });

  it('sends the cursor AND the kinds filter on the older page', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" kinds="message,call" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getContactTimeline).toHaveBeenLastCalledWith(
      'p1',
      { kinds: 'message,call', cursor: 'CURSOR1' },
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
  });

  it('keeps the first-page upcoming bucket AND its timezone when an older page arrives', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [{ id: 's1' }, { id: 's2' }],
      timezone: 'America/Chicago',
    });
    // The server gathers `upcoming` only when `cursor` is absent, so an older
    // page legitimately carries none. It must not blank the pinned section.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-upcoming')).toHaveTextContent('2'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('p-upcoming')).toHaveTextContent('2');
    expect(screen.getByTestId('p-tz')).toHaveTextContent('America/Chicago');
    // The merged older page is <Timeline>'s prepend signal.
    expect(screen.getByTestId('p-pages')).toHaveTextContent('1');
  });

  it('reports no older history on the assembled fallback path', async () => {
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    getAllConversations.mockResolvedValue([]);
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
  });

  // A5: the fallback check runs on EVERY load, not only the first. A first page
  // that succeeded with a cursor followed by a refetch that 404s would otherwise
  // leave a live control on a fallback timeline whose every click 404s.
  it('retires the control when a LATER refetch falls back to the assembled path', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('true'));

    // The endpoint is rolled back (or the contact is soft-deleted and the route
    // answers 404 contact_not_found), so the SSE refetch assembles the fallback.
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    getAllConversations.mockResolvedValue([]);
    act(() => {
      lastHandlers.onMessagePersisted?.();
    });

    await waitFor(() => expect(screen.getByTestId('p-source')).toHaveTextContent('fallback'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
  });

  // [R4] The ref guard, tested here too rather than assumed from the copy.
  it('fires one older request for a double click', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    let release: (v: unknown) => void = () => {};
    getContactTimeline.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getContactTimeline).toHaveBeenCalledTimes(2); // first page + ONE older

    await act(async () => {
      release({ items: [], nextCursor: null });
    });
    await waitFor(() => expect(screen.getByTestId('p-loadingOlder')).toHaveTextContent('false'));
  });

  // Spec 5.1 asks for this in ALL THREE hooks, and only the relay suite had it.
  // The counter is <Timeline>'s prepend signal, so a bump without a merge fires a
  // scroll restore for a prepend that never happened.
  it('bumps olderPagesLoaded only when an older page actually merges', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-pages')).toHaveTextContent('0'); // first load is not a prepend

    // An SSE refetch is not a prepend.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('c', '2026-08-13T11:00:00.000Z')],
      nextCursor: 'CURSOR9',
      upcoming: [],
    });
    act(() => {
      lastHandlers.onMessagePersisted?.();
    });
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('b,c'));
    expect(screen.getByTestId('p-pages')).toHaveTextContent('0');

    // A merged older page IS.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: 'CURSOR2',
    });
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('p-pages')).toHaveTextContent('1'));

    // A FAILED older page is not - nothing merged, so nothing may signal one.
    getContactTimeline.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('p-loadingOlder')).toHaveTextContent('false'));
    expect(screen.getByTestId('p-pages')).toHaveTextContent('1');
    expect(screen.getByTestId('p-status')).toHaveTextContent('ready'); // never errors the feed
  });

  // Spec 4.5: "empty older pages leave it untouched". Rarer here than on the
  // conversation hooks (the cursor is authoritative) but not impossible - the
  // server can hand back a cursor whose page filters down to nothing.
  it('leaves olderPagesLoaded untouched when the older page comes back EMPTY', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));

    getContactTimeline.mockResolvedValueOnce({ items: [], nextCursor: 'CURSOR2' });
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('p-loadingOlder')).toHaveTextContent('false'));
    expect(screen.getByTestId('p-pages')).toHaveTextContent('0');
    // The cursor still advanced, so the operator can page THROUGH the empty page.
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('true');
    getContactTimeline.mockResolvedValueOnce({ items: [], nextCursor: null });
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getContactTimeline).toHaveBeenLastCalledWith(
      'p1',
      { cursor: 'CURSOR2' },
      expect.anything(),
    );
  });

  // The isFirstLoad baseline guard, which here protects the CURSOR as well as
  // hasOlder. Without it, one inbound message after the operator has paged the
  // feed back to its beginning both resurrects the control and rewinds the cursor
  // to the newest page's boundary - so every later click re-reads pages already
  // merged and nothing on screen changes.
  it('does not resurrect a retired control (or rewind the cursor) on an SSE refetch', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('true'));

    // Page back to the beginning: a null cursor retires the control.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
    });
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false'));

    // One inbound message; the debounced refetch reads a newest page that still
    // has history behind IT, so it carries a cursor.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('c', '2026-08-13T11:00:00.000Z')],
      nextCursor: 'CURSOR9',
      upcoming: [],
    });
    act(() => {
      lastHandlers.onMessagePersisted?.();
    });
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a,b,c'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');

    // ...and the cursor stayed null, so a further load is a no-op rather than a
    // re-read of pages already merged.
    const calls = getContactTimeline.mock.calls.length;
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getContactTimeline).toHaveBeenCalledTimes(calls);
  });

  // A late-settling ABORTED older request must not clear the in-flight guard
  // belonging to a NEWER one. Unreachable through the button today, which is why
  // it is asserted here: the deferred scroll-triggered auto-loader calls
  // loadOlder() programmatically.
  it('an aborted older request does not release the guard held by a newer one', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    let releaseFirst: (v: unknown) => void = () => {};
    getContactTimeline.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const { rerender } = render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    // A kinds change is a NEW feed: the reset effect aborts the older request.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('z', '2026-08-13T12:00:00.000Z')],
      nextCursor: 'CURSOR7',
      upcoming: [],
    });
    let releaseSecond: (v: unknown) => void = () => {};
    getContactTimeline.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSecond = resolve;
      }),
    );
    rerender(<PagingProbe contactId="p1" kinds="message" />);
    await waitFor(() => expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('true'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getContactTimeline).toHaveBeenCalledTimes(4);

    await act(async () => {
      releaseFirst({ items: [], nextCursor: null }); // the ABORTED one settles late
    });
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getContactTimeline).toHaveBeenCalledTimes(4);
    await act(async () => {
      releaseSecond({ items: [], nextCursor: null });
    });
    await waitFor(() => expect(screen.getByTestId('p-loadingOlder')).toHaveTextContent('false'));
  });

  it('replaces rather than merges when the kinds filter changes', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    const { rerender } = render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a'));

    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('z', '2026-08-13T11:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    rerender(<PagingProbe contactId="p1" kinds="message" />);

    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('z'));
    expect(screen.getByTestId('p-ids')).not.toHaveTextContent('a');
  });

  // The armed-timer-survives-a-switch case. This hook is the one that does NOT
  // remount across a contactId change - ContactDetail re-renders the same
  // instance - so a timer armed for contact A is still live for contact B, and
  // merge-by-id would make the resulting contamination permanent.
  it('does not let a refetch armed before a switch write the old contact into the new one', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    const { rerender } = render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a'));

    act(() => {
      lastHandlers.onMessagePersisted?.();
    });

    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('z', '2026-08-13T11:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    rerender(<PagingProbe contactId="p2" />);
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('z'));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.getByTestId('p-ids')).toHaveTextContent('z');
    expect(screen.getByTestId('p-ids')).not.toHaveTextContent('a');
    expect(getContactTimeline).toHaveBeenCalledTimes(2);
  });

  // A4: the first load REPLACES, but it must still route through
  // mergeTimelineItems so the ordering contract is identical before and after any
  // merge. normalizeServerItems returns 0 on an `at` tie and JS sort is stable, so
  // a raw page keeps its own order within a tie while the merge breaks the tie by
  // ascending id - assigning the page directly would reshuffle same-instant items
  // on the first SSE refetch, with no user action.
  it('orders same-instant items by id on the FIRST load, before any merge', async () => {
    const SAME = '2026-08-13T10:00:00.000Z';
    getContactTimeline.mockResolvedValue({
      // Raw order is the REVERSE of id order.
      items: [timelineItem('m2', SAME), timelineItem('m1', SAME)],
      nextCursor: null,
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);

    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('m1,m2'));

    act(() => {
      lastHandlers.onMessagePersisted?.();
    });
    await waitFor(() => expect(getContactTimeline).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('p-ids')).toHaveTextContent('m1,m2');
  });
});
