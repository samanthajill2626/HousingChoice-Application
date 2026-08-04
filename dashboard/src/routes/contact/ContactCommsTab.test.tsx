// ContactCommsTab - the thin wrapper the tour/placement 1:1 tabs mount. It owns
// exactly one decision: run useContactTimeline for THIS contact and hand the
// state to the shared ContactCommsPane. The HARD RULE it exists to enforce (spec
// section 3 / review B2) is pinned first: the hook is never called with an empty
// or unresolved contactId, because the component takes a LOADED Contact and the
// callers gate on it.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactTimelinePage } from '../../api/index.js';

const getContactTimeline = vi.fn();
const getConversations = vi.fn();
const getConversationMessages = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    // No SSE in unit tests (the timeline hook subscribes).
    useEventStream: () => {},
  };
});

import { ContactCommsTab, type ContactCommsTabProps } from './ContactCommsTab.js';

const TENANT: Contact = {
  contactId: 'tenant-1',
  type: 'tenant',
  status: 'searching',
  firstName: 'Ann',
  lastName: 'Tenant',
  phone: '+14045550111',
};

function page(items: ContactTimelinePage['items']): ContactTimelinePage {
  return { nextCursor: null, items };
}

const MESSAGE: ContactTimelinePage['items'][number] = {
  kind: 'message',
  id: 'm0',
  at: '2026-07-01T10:00:00.000Z',
  conversationId: 'c-tenant',
  tsMsgId: '2026-07-01T10:00:00.000Z#SM0',
  direction: 'inbound',
  author: 'tenant',
  type: 'sms',
  body: 'Is the place still open?',
  delivery_status: 'delivered',
};

const PIN: ContactTimelinePage['items'][number] = {
  kind: 'milestone',
  id: '2026-07-02T00:00:00.000Z#a',
  at: '2026-07-02T00:00:00.000Z',
  type: 'tour_scheduled',
  label: 'Tour scheduled',
};

function baseProps(over: Partial<ContactCommsTabProps> = {}): ContactCommsTabProps {
  return {
    contact: TENANT,
    emptyLabel: 'No messages with Ann Tenant yet',
    commsOnly: false,
    onCommsOnlyChange: vi.fn(),
    // The mark-read fan-out this component gates. Defaults are the DESKTOP,
    // already-read reading (visible column, nothing unread) so the cases above
    // are unaffected by it; the gate itself is driven end-to-end through the
    // pages, in TourConversation.test / PlacementConversation.test.
    commsVisible: true,
    unread: 0,
    onMarkRead: vi.fn(),
    ...over,
  };
}

function renderTab(props: ContactCommsTabProps) {
  // MemoryRouter: a milestone pin with a refId renders a <Link>.
  return render(
    <MemoryRouter>
      <ContactCommsTab {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getContactTimeline.mockResolvedValue(page([]));
  getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
  getConversationMessages.mockResolvedValue([]);
  sendMessage.mockResolvedValue({ tsMsgId: 'm1', status: 'queued' });
});

describe('ContactCommsTab', () => {
  it('fetches the PERSON timeline for the loaded contact - never with an empty id', async () => {
    renderTab(baseProps());

    await waitFor(() =>
      expect(getContactTimeline).toHaveBeenCalledWith('tenant-1', {}, expect.any(AbortSignal)),
    );
    // The hard rule (spec section 3): every call carries a real contactId. A ''
    // would fall into useContactTimeline's fetch-the-whole-inbox fallback.
    for (const call of getContactTimeline.mock.calls) {
      expect(call[0]).toBe('tenant-1');
    }
    expect(getConversations).not.toHaveBeenCalled();
  });

  it('renders the person feed - messages AND the lifecycle pins the server carries', async () => {
    getContactTimeline.mockResolvedValue(page([MESSAGE, PIN]));
    renderTab(baseProps());

    expect(await screen.findByText('Is the place still open?')).toBeInTheDocument();
    expect(screen.getByText('Tour scheduled')).toBeInTheDocument();
  });

  it('shows the caller-supplied emptyLabel when the feed is ready and empty', async () => {
    renderTab(baseProps());

    expect(await screen.findByText('No messages with Ann Tenant yet')).toBeInTheDocument();
  });

  it('seeds the composer from initialDraft and reports the seed once', async () => {
    const onDraftSeeded = vi.fn();
    renderTab(baseProps({ initialDraft: 'Sorry we missed you!', onDraftSeeded }));

    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(
      'Sorry we missed you!',
    );
    expect(onDraftSeeded).toHaveBeenCalledTimes(1);
    // Let the timeline fetch settle so its commit lands inside act().
    await screen.findByText('No messages with Ann Tenant yet');
  });

  it('"Comms only" is CONTROLLED by the caller: the click reports up, the filter does not self-apply', async () => {
    getContactTimeline.mockResolvedValue(page([MESSAGE, PIN]));
    const onCommsOnlyChange = vi.fn();
    renderTab(baseProps({ onCommsOnlyChange }));

    expect(await screen.findByText('Tour scheduled')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Comms only/i }));

    expect(onCommsOnlyChange).toHaveBeenCalledWith(true);
    // The caller owns the value (it lives above this component's remount), so
    // until IT flips, the pin stays. This is what keeps the filter from resetting
    // on every tab switch.
    expect(screen.getByText('Tour scheduled')).toBeInTheDocument();
  });

  it('applies the filter when the caller passes commsOnly=true', async () => {
    getContactTimeline.mockResolvedValue(page([MESSAGE, PIN]));
    renderTab(baseProps({ commsOnly: true }));

    expect(await screen.findByText('Is the place still open?')).toBeInTheDocument();
    expect(screen.queryByText('Tour scheduled')).not.toBeInTheDocument();
  });
});
