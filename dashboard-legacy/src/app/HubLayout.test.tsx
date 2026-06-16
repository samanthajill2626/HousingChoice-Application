// HubLayout tests — the responsive two-pane conversation hub routing:
//   - the conversation LIST is always rendered (shared across both routes);
//   - at '/', the right pane shows the "Select a conversation" empty state;
//   - at '/conversations/:id', the right pane shows that thread (the Outlet),
//     and the list is still present (not unmounted) — i.e. selecting a row
//     swaps the right pane without losing the list.
// We mock the api barrel (network functions + the SSE hook) and AuthContext so
// no EventSource / fetch is opened; Inbox + Thread render off the mocks.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Contact,
  Conversation,
  ConversationsPage,
  ConversationSummary,
} from '../api/index.js';

const api = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  getContact: vi.fn(),
  listMessages: vi.fn(),
  markRead: vi.fn(),
  setAssignment: vi.fn(),
  updateContact: vi.fn(),
  sendMessage: vi.fn(),
}));

// Inbox imports from '../api/index.js' and Thread from '../api' — both resolve
// to the SAME module (src/api/index.ts), so one mock intercepts both. The shared
// `api` spy object (vi.hoisted) is wired in so beforeEach can set return values.
// Stub every network function the hub touches + the SSE hook (no EventSource).
vi.mock('../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../api/index.js')>();
  return {
    ...actual,
    listConversations: api.listConversations,
    getConversation: api.getConversation,
    getContact: api.getContact,
    listMessages: api.listMessages,
    markRead: api.markRead,
    setAssignment: api.setAssignment,
    updateContact: api.updateContact,
    sendMessage: api.sendMessage,
    useEventStream: () => {},
  };
});

vi.mock('./AuthContext.js', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u-me', email: 'me@hc.test', role: 'admin' },
    isAdmin: true,
    refresh: vi.fn(),
  }),
}));

const { HubLayout } = await import('./HubLayout.js');
const { default: Thread } = await import('../routes/Thread.js');
const { ToastProvider } = await import('../ui/index.js');

const CONV_ID = 'c1';

function summary(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: CONV_ID,
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

function page(conversations: ConversationSummary[]): ConversationsPage {
  return { conversations, nextCursor: null };
}

function makeConversation(): Conversation {
  return {
    conversationId: CONV_ID,
    participant_phone: '+14155550100',
    status: 'open',
    last_activity_at: '2026-06-13T10:00:00.000Z',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00Z',
    participants: [{ contactId: 'k1', phone: '+14155550100' }],
  };
}

function makeContact(): Contact {
  return { contactId: 'k1', type: 'tenant', status: 'active', phone: '+14155550100', firstName: 'Ada' };
}

function renderHub(initialPath: string): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<HubLayout />}>
            <Route index element={null} />
            <Route path="conversations/:id" element={<Thread />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  api.listConversations.mockReset();
  api.listConversations.mockResolvedValue(page([summary()]));
  api.getConversation.mockResolvedValue(makeConversation());
  api.getContact.mockResolvedValue(makeContact());
  api.listMessages.mockResolvedValue([]);
  api.markRead.mockResolvedValue(makeConversation());
});

describe('<HubLayout>', () => {
  it('renders the conversation list and the empty thread pane at "/"', async () => {
    renderHub('/');

    // List is present (the inbox heading + a row link).
    expect(await screen.findByRole('list', { name: 'Conversations' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Conversation with/ })).toBeInTheDocument();

    // Right pane shows the friendly empty state.
    expect(screen.getByText('Select a conversation')).toBeInTheDocument();
  });

  it('renders the list AND the selected thread at "/conversations/:id"', async () => {
    renderHub(`/conversations/${CONV_ID}`);

    // The list is still present (shared, not unmounted)…
    expect(await screen.findByRole('list', { name: 'Conversations' })).toBeInTheDocument();

    // …and the thread's header assignment control renders (the thread loaded).
    await waitFor(() => expect(api.getConversation).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /assign to me/i })).toBeInTheDocument();

    // The empty-state prompt is NOT shown when a thread is selected.
    expect(screen.queryByText('Select a conversation')).not.toBeInTheDocument();
  });
});
