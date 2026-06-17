import { render, screen, waitFor } from '@testing-library/react';
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

import { involvesContact, useContactTimeline } from './useContactTimeline.js';

function Probe({ contactId, kinds }: { contactId: string; kinds?: string }): React.JSX.Element {
  const { status, items, source } = useContactTimeline(contactId, kinds);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="source">{source}</span>
      <span data-testid="count">{items.length}</span>
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
      assignment: null,
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
      assignment: null,
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
