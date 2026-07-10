import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type {
  ContactTimelinePage,
  ConversationsPage,
  Message,
} from '../../api/index.js';

const getContactTimeline = vi.fn();
const getConversations = vi.fn();
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
    getConversations: (...a: unknown[]) => getConversations(...a),
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

const CONVERSATIONS: ConversationsPage = {
  nextCursor: null,
  conversations: [
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
  ],
};

beforeEach(() => {
  getContactTimeline.mockReset();
  getConversations.mockReset();
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
    getConversations.mockResolvedValue(CONVERSATIONS);
    // Only c1 (the contact's conversation) should be fetched.
    getConversationMessages.mockImplementation((cid: string) =>
      cid === 'c1' ? Promise.resolve([msg({ tsMsgId: 'm1', body: 'real seeded' })]) : Promise.resolve([]),
    );

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('source').textContent).toBe('fallback');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
    expect(getConversationMessages).toHaveBeenCalledWith('c1', expect.anything());
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
    getConversations.mockResolvedValue(CONVERSATIONS);
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
      api!.addOptimistic('c1', 'on my way', '+14040100007');
    });

    // Appears immediately (no await), outbound, status queued → "Sending…".
    expect(bodies()).toContain('on my way|queued');
    expect(screen.getAllByTestId('item')).toHaveLength(2);
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
