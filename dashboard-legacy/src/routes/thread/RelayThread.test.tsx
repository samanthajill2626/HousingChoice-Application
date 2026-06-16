// Relay-group Thread tests (M1.7). Mock the network-bound api functions and
// useEventStream; keep ApiError + useApi real. Covers: relay header + member
// roster render, per-recipient delivery chips, inbound attribution from
// relay_sender_key (roster-resolved, NOT body), the closed banner + late-reply
// badge, add/remove member, close/reopen, and a LIVE roster update from a
// conversation.updated SSE event (no /members refetch).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ConversationParticipant,
  ConversationUpdatedEvent,
  EventStreamHandlers,
  Message,
} from '../../api';

const api = vi.hoisted(() => ({
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  getContact: vi.fn(),
  markRead: vi.fn(),
  setAssignment: vi.fn(),
  getRelayMembers: vi.fn(),
  addRelayMember: vi.fn(),
  removeRelayMember: vi.fn(),
  setRelayClosed: vi.fn(),
  eventHandlers: { current: undefined as EventStreamHandlers | undefined },
}));

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return {
    ...actual,
    listMessages: api.listMessages,
    sendMessage: api.sendMessage,
    getConversation: api.getConversation,
    getContact: api.getContact,
    markRead: api.markRead,
    setAssignment: api.setAssignment,
    getRelayMembers: api.getRelayMembers,
    addRelayMember: api.addRelayMember,
    removeRelayMember: api.removeRelayMember,
    setRelayClosed: api.setRelayClosed,
    useEventStream: (handlers: EventStreamHandlers) => {
      api.eventHandlers.current = handlers;
    },
  };
});

vi.mock('../../app/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u-me', email: 'me@hc.test', role: 'admin' },
    isAdmin: true,
    refresh: vi.fn(),
  }),
}));

const Thread = (await import('../Thread')).default;
const { ToastProvider } = await import('../../ui');

const CONV_ID = 'conv-relay-1';
const POOL = '+13135559000';

const ALICE: ConversationParticipant = { contactId: 'c-alice', phone: '+13135550001', name: 'Alice' };
const BOB: ConversationParticipant = { contactId: '', phone: '+14155550100' }; // no name → phone

function makeRelay(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: CONV_ID,
    participant_phone: POOL,
    status: 'open',
    last_activity_at: '2026-06-12T10:00:00Z',
    type: 'relay_group',
    ai_mode: 'manual',
    pool_number: POOL,
    participants: [ALICE, BOB],
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    conversationId: CONV_ID,
    tsMsgId: '2026-06-12T10:00:00Z#SM1',
    type: 'sms',
    direction: 'inbound',
    author: 'unknown',
    body: 'hello group',
    provider_sid: 'SM1',
    provider_ts: '2026-06-12T10:00:00Z',
    delivery_status: 'delivered',
    created_at: '2026-06-12T10:00:00Z',
    ...overrides,
  };
}

function renderThread(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/conversations/${CONV_ID}`]}>
        <Routes>
          <Route path="/conversations/:id" element={<Thread />} />
          <Route path="/" element={<div>Inbox</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  api.eventHandlers.current = undefined;
  api.getConversation.mockResolvedValue(makeRelay());
  api.getRelayMembers.mockResolvedValue([ALICE, BOB]);
  api.markRead.mockResolvedValue(makeRelay());
  api.listMessages.mockResolvedValue([]);
  api.addRelayMember.mockResolvedValue([ALICE, BOB]);
  api.removeRelayMember.mockResolvedValue([ALICE]);
  api.setRelayClosed.mockResolvedValue(makeRelay({ status: 'closed', pool_number: undefined }));
  api.sendMessage.mockResolvedValue({
    conversationId: CONV_ID,
    providerSid: 'team-x',
    tsMsgId: '2026-06-12T11:00:00Z#team-x',
    status: 'queued',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<Thread> relay group — header + members', () => {
  it('renders the relay header (group label + member count + pool number) and the roster', async () => {
    renderThread();

    expect(await screen.findByText('Relay group')).toBeInTheDocument();
    // Member-count badge in the header (populates once the roster GET resolves).
    expect(await screen.findByText('2 members')).toBeInTheDocument();
    // Masked pool number subtitle.
    expect(screen.getByText(/Pool \(313\) 555-9000/)).toBeInTheDocument();

    // Roster: Alice by name; Bob by his formatted phone (honest identity).
    const memberList = await screen.findByRole('list', { name: 'Relay members' });
    expect(within(memberList).getByText('Alice')).toBeInTheDocument();
    expect(within(memberList).getByText('(415) 555-0100')).toBeInTheDocument();

    // No 1:1 affordances on a relay thread.
    expect(screen.queryByRole('button', { name: /assign to me/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /call instead/i })).not.toBeInTheDocument();
  });

  it('attributes an inbound relayed message to the sender resolved from relay_sender_key (not the body)', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({
        tsMsgId: 't1#SM1',
        direction: 'inbound',
        author: 'unknown',
        body: 'raw text with no prefix',
        relay_sender_key: 'c-alice',
      }),
    ]);
    renderThread();

    // The bubble's author label is Alice (from the roster), not "Unknown sender".
    expect(await screen.findByLabelText('Alice message')).toBeInTheDocument();
    expect(screen.getByText('raw text with no prefix')).toBeInTheDocument();
  });

  it('renders per-recipient delivery chips resolved against the roster', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({
        tsMsgId: 't1#team1',
        direction: 'outbound',
        author: 'teammate',
        body: 'team broadcast',
        relay_sender_key: 'team',
        delivery_recipients: {
          'c-alice': { status: 'delivered' },
          'phone#+14155550100': { status: 'failed', errorCode: '30005' },
        },
      }),
    ]);
    renderThread();

    const perRecipient = await screen.findByRole('list', { name: 'Per-recipient delivery' });
    // Alice → Delivered; Bob (phone) → Failed with the reason. The member labels
    // resolve once the roster GET settles, so await Alice's label.
    expect(await within(perRecipient).findByText('Alice')).toBeInTheDocument();
    expect(within(perRecipient).getByText('(415) 555-0100')).toBeInTheDocument();
    expect(within(perRecipient).getByText('Delivered')).toBeInTheDocument();
    expect(within(perRecipient).getByText(/Failed/)).toBeInTheDocument();
  });
});

describe('<Thread> relay group — closed state', () => {
  it('shows the closed banner, disables the composer, and marks late replies', async () => {
    api.getConversation.mockResolvedValue(makeRelay({ status: 'closed', pool_number: undefined }));
    api.listMessages.mockResolvedValue([
      makeMessage({
        tsMsgId: 't1#SM9',
        direction: 'inbound',
        relay_sender_key: 'c-alice',
        body: 'late reply',
        received_on_closed_thread: true,
      }),
    ]);
    renderThread();

    // Banner (its text is split by a <strong>, so match a contiguous chunk) +
    // the inline late-reply badge.
    expect(await screen.findByText(/the pool number is released/i)).toBeInTheDocument();
    expect(screen.getByText(/late reply \(thread closed\)/i)).toBeInTheDocument();
    // Composer is disabled with the closed note (no textarea).
    expect(screen.getByText(/closed — reopen it to send/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    // The header offers Reopen.
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('closes the group via setRelayClosed', async () => {
    renderThread();
    const close = await screen.findByRole('button', { name: 'Close group' });
    fireEvent.click(close);
    await waitFor(() => expect(api.setRelayClosed).toHaveBeenCalledWith(CONV_ID, true));
  });
});

describe('<Thread> relay group — roster mutations', () => {
  it('adds a member via the add form', async () => {
    api.getRelayMembers.mockResolvedValue([ALICE]);
    api.addRelayMember.mockResolvedValue([ALICE, BOB]);
    renderThread();

    // Wait for the panel to load (Alice present).
    await screen.findByText('Alice');

    const phoneInput = screen.getByLabelText('Phone');
    fireEvent.change(phoneInput, { target: { value: '+14155550100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() =>
      expect(api.addRelayMember).toHaveBeenCalledWith(CONV_ID, { phone: '+14155550100' }),
    );
    // The returned roster surfaces Bob.
    expect(await screen.findByText('(415) 555-0100')).toBeInTheDocument();
  });

  it('removes a member via the per-member Remove button', async () => {
    renderThread();
    const memberList = await screen.findByRole('list', { name: 'Relay members' });
    const removeBob = within(memberList).getByRole('button', { name: /remove \(415\) 555-0100/i });
    fireEvent.click(removeBob);

    await waitFor(() => expect(api.removeRelayMember).toHaveBeenCalledWith(CONV_ID, '+14155550100'));
  });

  it('updates the roster live from a conversation.updated SSE event (no /members refetch)', async () => {
    api.getRelayMembers.mockResolvedValue([ALICE]);
    renderThread();
    await screen.findByText('Alice');
    // Only the initial members GET so far.
    expect(api.getRelayMembers).toHaveBeenCalledTimes(1);

    const event: ConversationUpdatedEvent = {
      conversationId: CONV_ID,
      last_activity_at: '2026-06-12T12:00:00Z',
      unread_count: 0,
      type: 'relay_group',
      assignment: null,
      participant_display_name: null,
      status: 'open',
      pool_number: POOL,
      members: [ALICE, BOB],
    };
    act(() => {
      api.eventHandlers.current?.onConversationUpdated?.(event);
    });

    // Bob now appears, sourced from the event roster — NOT a second GET.
    expect(await screen.findByText('(415) 555-0100')).toBeInTheDocument();
    expect(api.getRelayMembers).toHaveBeenCalledTimes(1);
  });
});
