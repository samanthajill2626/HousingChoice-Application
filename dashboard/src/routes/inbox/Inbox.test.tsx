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

// AuthContext: mutable status so we can assert the M2 SSE enabled gate.
const authState = vi.hoisted(() => ({ status: 'authenticated' as 'authenticated' | 'anonymous' }));
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({ status: authState.status, me: undefined, isAdmin: false, refresh: vi.fn() }),
}));

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
    participant_display_name: null,
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
  authState.status = 'authenticated';
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
      type: 'tenant_1to1',
      assignment: null,
      participant_display_name: null,
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

  it('re-evaluates the needs-review and Assigned chips live from a known-row update (C/D)', async () => {
    // Starts as an un-triaged, unassigned conversation → "Needs review", no
    // "Assigned" chip.
    listConversationsMock.mockResolvedValue(
      page([summary({ conversationId: 'c1', type: 'unknown_1to1', assignment: null })]),
    );

    renderInbox();

    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByText('Assigned')).not.toBeInTheDocument();

    // A live update resolves the type (→ tenant_1to1) and assigns the row. The
    // applyUpdate merge of type+assignment must flip both chips without a refetch.
    fireUpdate({
      conversationId: 'c1',
      last_activity_at: '2026-06-13T11:00:00.000Z',
      unread_count: 0,
      type: 'tenant_1to1',
      assignment: 'u_va1',
      participant_display_name: null,
    });

    await waitFor(() => expect(screen.queryByText('Needs review')).not.toBeInTheDocument());
    expect(screen.getByText('Assigned')).toBeInTheDocument();
    // Patched in place — no refetch.
    expect(listConversationsMock).toHaveBeenCalledTimes(1);
  });

  it('clears the needs-review chip live when a name is denormalized even though the thread stays unknown_1to1 (pm/team_member triage)', async () => {
    // Regression: an un-triaged conversation shows "Needs review". A live update
    // triages the participant to a pm/team_member (the thread type never leaves
    // unknown_1to1) but now carries a resolved participant_display_name — the
    // chip must clear and the name must surface, with no refetch.
    listConversationsMock.mockResolvedValue(
      page([
        summary({
          conversationId: 'c1',
          type: 'unknown_1to1',
          participant_phone: '+14155550101',
          participant_display_name: null,
        }),
      ]),
    );

    renderInbox();

    expect(await screen.findByText('Needs review')).toBeInTheDocument();

    fireUpdate({
      conversationId: 'c1',
      last_activity_at: '2026-06-13T11:00:00.000Z',
      unread_count: 0,
      // Thread type stays unknown_1to1 (no *_1to1 value for a team_member)…
      type: 'unknown_1to1',
      assignment: null,
      // …but the resolved name rides the event.
      participant_display_name: 'Jamie Rivera',
    });

    await waitFor(() => expect(screen.queryByText('Needs review')).not.toBeInTheDocument());
    expect(screen.getByText('Jamie Rivera')).toBeInTheDocument();
    // Patched in place — no refetch.
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
      type: 'unknown_1to1',
      assignment: null,
      participant_display_name: null,
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

  it('enables the SSE stream while authenticated (M2)', async () => {
    listConversationsMock.mockResolvedValue(page([]));
    renderInbox();
    await screen.findByText('No conversations yet');
    expect(capturedHandlers.current?.enabled).toBe(true);
  });

  it('disables the SSE stream when not authenticated (M2 — stops reconnect loop)', async () => {
    authState.status = 'anonymous';
    listConversationsMock.mockResolvedValue(page([]));
    renderInbox();
    await screen.findByText('No conversations yet');
    expect(capturedHandlers.current?.enabled).toBe(false);
  });
});
