import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationsPage,
  ConversationSummary,
  ConversationUpdatedEvent,
  EventStreamHandlers,
} from '../../api/index.js';

// --- Mock the api barrel --------------------------------------------------
// Keep the real useApi/ApiError/types; stub the network function and the SSE
// hook (which we drive manually via a captured handler — no EventSource).
const { listConversationsMock, capturedHandlers } = vi.hoisted(() => ({
  listConversationsMock: vi.fn(),
  capturedHandlers: { current: undefined as EventStreamHandlers | undefined },
}));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return {
    ...actual,
    listConversations: listConversationsMock,
    useEventStream: (handlers: EventStreamHandlers) => {
      capturedHandlers.current = handlers;
    },
  };
});

// Import AFTER the mock is registered.
const { default: Inbox } = await import('../Inbox.js');

function summary(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: 'c1',
    type: 'tenant_1to1',
    participant_phone: '+14155550100',
    participants: [{ contactId: 'k1', phone: '+14155550100' }],
    preview: 'Hello there',
    last_activity_at: '2026-06-13T10:00:00.000Z',
    unread_count: 0,
    assignment: null,
    sms_opt_out: false,
    ...over,
  };
}

function page(
  conversations: ConversationSummary[],
  nextCursor: string | null = null,
): ConversationsPage {
  return { conversations, nextCursor };
}

function renderInbox(): void {
  render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
}

function fireUpdate(event: ConversationUpdatedEvent): void {
  // The SSE handler runs outside React's event system → wrap in act.
  act(() => {
    capturedHandlers.current?.onConversationUpdated?.(event);
  });
}

beforeEach(() => {
  listConversationsMock.mockReset();
  capturedHandlers.current = undefined;
});

describe('<Inbox>', () => {
  it('renders rows with name, preview, and an unread badge', async () => {
    listConversationsMock.mockResolvedValue(
      page([
        summary({
          conversationId: 'c1',
          participant_phone: '+14155550100',
          preview: 'Hello there',
          unread_count: 3,
        }),
      ]),
    );

    renderInbox();

    // Name = formatted phone (no contact name in the wire shape).
    expect(await screen.findByText('(415) 555-0100')).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    // Unread count surfaced via an accessible label on the badge.
    expect(screen.getByLabelText('3 unread')).toBeInTheDocument();

    // The row links to the thread.
    const link = screen.getByRole('link', { name: /Conversation with/ });
    expect(link).toHaveAttribute('href', '/conversations/c1');
  });

  it('shows the "needs review" chip for an unknown_1to1 conversation', async () => {
    listConversationsMock.mockResolvedValue(
      page([summary({ conversationId: 'cu', type: 'unknown_1to1', preview: null })]),
    );

    renderInbox();

    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    // Honest identity: no fabricated preview either.
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('surfaces assignment and opt-out indicators', async () => {
    listConversationsMock.mockResolvedValue(
      page([summary({ conversationId: 'c2', assignment: 'u_va1', sms_opt_out: true })]),
    );

    renderInbox();

    expect(await screen.findByText('Assigned')).toBeInTheDocument();
    expect(screen.getByText('Opted out')).toBeInTheDocument();
  });

  it('renders the empty state when there are no conversations', async () => {
    listConversationsMock.mockResolvedValue(page([]));

    renderInbox();

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders an error state with a working retry', async () => {
    const { ApiError } = await import('../../api/index.js');
    listConversationsMock.mockRejectedValueOnce(new ApiError(500, 'boom', 'boom'));

    renderInbox();

    expect(await screen.findByText("Couldn't load conversations")).toBeInTheDocument();

    // Retry succeeds the second time → list renders.
    listConversationsMock.mockResolvedValueOnce(
      page([summary({ conversationId: 'c1', preview: 'Recovered' })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Recovered')).toBeInTheDocument();
  });

  it('bumps a known row in place on a conversation.updated event', async () => {
    listConversationsMock.mockResolvedValue(
      page([
        summary({
          conversationId: 'c1',
          participant_phone: '+14155550101',
          preview: 'old preview',
          unread_count: 0,
          last_activity_at: '2026-06-13T09:00:00.000Z',
        }),
        summary({
          conversationId: 'c2',
          participant_phone: '+14155550102',
          preview: 'second',
          last_activity_at: '2026-06-13T10:00:00.000Z',
        }),
      ]),
    );

    renderInbox();

    // c2 starts on top (more recent activity).
    const listBefore = await screen.findByRole('list', { name: 'Conversations' });
    const names = within(listBefore)
      .getAllByRole('link')
      .map((el) => el.getAttribute('href'));
    expect(names).toEqual(['/conversations/c2', '/conversations/c1']);

    // Live update to c1: newer activity + a fresh preview + unread.
    fireUpdate({
      conversationId: 'c1',
      last_activity_at: '2026-06-13T11:00:00.000Z',
      unread_count: 2,
      preview: 'fresh preview',
    });

    // Row patched in place and re-sorted to the top; no refetch.
    await waitFor(() => {
      const links = within(screen.getByRole('list', { name: 'Conversations' }))
        .getAllByRole('link')
        .map((el) => el.getAttribute('href'));
      expect(links).toEqual(['/conversations/c1', '/conversations/c2']);
    });
    expect(screen.getByText('fresh preview')).toBeInTheDocument();
    expect(screen.getByLabelText('2 unread')).toBeInTheDocument();
    // listConversations called once (initial) — no refetch for a known row.
    expect(listConversationsMock).toHaveBeenCalledTimes(1);
  });

  it('refetches the first page on an update for a not-yet-listed conversation', async () => {
    listConversationsMock.mockResolvedValueOnce(
      page([summary({ conversationId: 'c1', preview: 'first' })]),
    );

    renderInbox();

    // Let the initial load settle.
    expect(await screen.findByText('first')).toBeInTheDocument();

    // A brand-new conversation not in the list → debounced first-page refetch.
    listConversationsMock.mockResolvedValueOnce(
      page([
        summary({
          conversationId: 'cN',
          participant_phone: '+14155550199',
          preview: 'brand new',
          last_activity_at: '2026-06-13T12:00:00.000Z',
        }),
        summary({ conversationId: 'c1', preview: 'first' }),
      ]),
    );
    fireUpdate({
      conversationId: 'cN',
      last_activity_at: '2026-06-13T12:00:00.000Z',
      unread_count: 1,
    });

    // The debounced refetch (real timers) surfaces the new row at the top.
    expect(await screen.findByText('brand new')).toBeInTheDocument();
    expect(listConversationsMock).toHaveBeenCalledTimes(2);
  });

  it('paginates via Load more using nextCursor', async () => {
    listConversationsMock.mockResolvedValueOnce(
      page([summary({ conversationId: 'c1', preview: 'page one' })], 'cursor-2'),
    );

    renderInbox();

    expect(await screen.findByText('page one')).toBeInTheDocument();
    const loadMore = await screen.findByRole('button', { name: 'Load more' });

    listConversationsMock.mockResolvedValueOnce(
      page([
        summary({
          conversationId: 'c9',
          participant_phone: '+14155550109',
          preview: 'page two',
          last_activity_at: '2026-06-13T08:00:00.000Z',
        }),
      ]),
    );
    fireEvent.click(loadMore);

    expect(await screen.findByText('page two')).toBeInTheDocument();
    // Second call carried the cursor.
    expect(listConversationsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-2' }),
    );
  });
});
