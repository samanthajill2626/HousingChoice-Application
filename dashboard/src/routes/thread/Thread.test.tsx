// Thread view integration tests. We mock the network-bound api functions
// (listMessages/sendMessage/getConversation/getContact/updateContact/markRead/
// setAssignment) and useEventStream, but keep the REAL ApiError + useApi hook so
// instanceof checks and the GET lifecycle behave like production. No network.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Contact,
  Conversation,
  Message,
  MessagePersistedEvent,
  SendMessageResult,
} from '../../api';
import type { EventStreamHandlers } from '../../api';

// --- Mock the api barrel: keep ApiError + useApi real, stub the rest. --------
const api = vi.hoisted(() => ({
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  getContact: vi.fn(),
  updateContact: vi.fn(),
  markRead: vi.fn(),
  setAssignment: vi.fn(),
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
    updateContact: api.updateContact,
    markRead: api.markRead,
    setAssignment: api.setAssignment,
    // Capture the handlers so tests can fire SSE events synchronously.
    useEventStream: (handlers: EventStreamHandlers) => {
      api.eventHandlers.current = handlers;
    },
  };
});

// AuthContext: a fixed authenticated principal.
vi.mock('../../app/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u-me', email: 'me@hc.test', role: 'admin' },
    isAdmin: true,
    refresh: vi.fn(),
  }),
}));

import Thread from '../Thread';
import { ToastProvider } from '../../ui';

const CONV_ID = 'conv-1';

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: CONV_ID,
    participant_phone: '+13135551234',
    status: 'open',
    last_activity_at: '2026-06-12T10:00:00Z',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00Z',
    participants: [{ contactId: 'contact-1', phone: '+13135551234' }],
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
    body: 'hello',
    provider_sid: 'SM1',
    provider_ts: '2026-06-12T10:00:00Z',
    delivery_status: 'delivered',
    created_at: '2026-06-12T10:00:00Z',
    ...overrides,
  };
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    contactId: 'contact-1',
    type: 'unknown',
    status: 'needs_review',
    phone: '+13135551234',
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
  api.getConversation.mockResolvedValue(makeConversation());
  api.getContact.mockResolvedValue(makeContact());
  api.markRead.mockResolvedValue(makeConversation());
  api.setAssignment.mockResolvedValue(makeConversation({ assignment: 'u-me' }));
  api.updateContact.mockResolvedValue(makeContact({ type: 'tenant', status: 'active', firstName: 'Keisha' }));
  api.listMessages.mockResolvedValue([]);
  api.sendMessage.mockResolvedValue({
    conversationId: CONV_ID,
    providerSid: 'SM-new',
    tsMsgId: '2026-06-12T11:00:00Z#SM-new',
    status: 'queued',
  } satisfies SendMessageResult);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<Thread> timeline + bubbles', () => {
  it('renders inbound (left) and outbound (right) bubbles with author + body', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({ tsMsgId: 't2#SM2', direction: 'outbound', author: 'teammate', body: 'replying', delivery_status: 'delivered' }),
      makeMessage({ tsMsgId: 't1#SM1', direction: 'inbound', author: 'tenant', body: 'incoming question' }),
    ]);
    renderThread();

    expect(await screen.findByText('incoming question')).toBeInTheDocument();
    expect(screen.getByText('replying')).toBeInTheDocument();
    // Scope the author labels to the message bubbles — "Tenant"/"Landlord" also
    // appear as <option> labels in the triage <select>, so a bare getByText is
    // ambiguous. The bubble exposes an aria-label "<Author> message".
    expect(screen.getByLabelText('Tenant message')).toBeInTheDocument();
    expect(screen.getByLabelText('Teammate message')).toBeInTheDocument();
  });

  it('shows a DeliveryBadge on outbound and a failure reason + Retry that re-sends the body', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({
        tsMsgId: 't1#SM1',
        direction: 'outbound',
        author: 'teammate',
        body: 'undeliverable text',
        delivery_status: 'failed',
        error_code: '30005',
      }),
    ]);
    renderThread();

    expect(await screen.findByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByText(/invalid/i)).toBeInTheDocument();

    const retry = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(CONV_ID, { body: 'undeliverable text' }));

    // H2/L5: the retry reconciles the SAME bubble in place — no second bubble,
    // and the failure reason clears on success (reconciled to "Queued").
    await waitFor(() => expect(screen.getByText('Queued')).toBeInTheDocument());
    expect(screen.getAllByText('undeliverable text')).toHaveLength(1);
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
  });

  it('renders a media-attachment placeholder chip for an MMS (no broken img)', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({ tsMsgId: 't1#SM1', type: 'mms', body: '', media_s3_keys: ['k1', 'k2'] }),
    ]);
    renderThread();

    expect(await screen.findByText(/media attachment/i)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('does NOT treat "sent" as a failure (no Retry button)', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({ tsMsgId: 't1#SM1', direction: 'outbound', author: 'teammate', body: 'on its way', delivery_status: 'sent' }),
    ]);
    renderThread();

    expect(await screen.findByText('Sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe('<Thread> composer', () => {
  it('appends an optimistic bubble on send and reconciles on the response', async () => {
    renderThread();
    await screen.findByText(/no messages yet/i);

    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Optimistic body shows immediately.
    expect(await screen.findByText('hello there')).toBeInTheDocument();
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(CONV_ID, { body: 'hello there' }));
    // After reconcile the bubble carries a real delivery badge (Queued).
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('disables the composer with the STOP note when the contact has opted out', async () => {
    api.getConversation.mockResolvedValue(makeConversation({ sms_opt_out: true }));
    renderThread();

    expect(await screen.findByText(/opted out \(STOP\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });
});

describe('<Thread> identity + triage', () => {
  it('shows the needs-review badge for an unknown_1to1 thread', async () => {
    renderThread();
    const reviewMarks = await screen.findAllByText(/needs review/i);
    expect(reviewMarks.length).toBeGreaterThan(0);
    // The header label is the formatted phone, never a fabricated name.
    expect(screen.getAllByText('(313) 555-1234').length).toBeGreaterThan(0);
  });

  it('header shows the phone + needs-review cue when the contact is unknown (H1)', async () => {
    // Default makeContact is type 'unknown' / needs_review → no fabricated name.
    renderThread();
    // The header (and panel) carry the needs-review badge.
    expect((await screen.findAllByText(/needs review/i)).length).toBeGreaterThan(0);
    // The header label is the formatted phone — never a fabricated name.
    expect(screen.getAllByText('(313) 555-1234').length).toBeGreaterThan(0);
    // No name fabricated anywhere.
    expect(screen.queryByText('Keisha Jones')).not.toBeInTheDocument();
  });

  it('header shows the real name once the contact is named + triaged (H1)', async () => {
    // A resolved tenant_1to1 conversation whose linked contact carries a name.
    api.getConversation.mockResolvedValue(makeConversation({ type: 'tenant_1to1' }));
    api.getContact.mockResolvedValue(
      makeContact({ type: 'tenant', status: 'active', firstName: 'Keisha', lastName: 'Jones' }),
    );
    renderThread();

    // The lifted contact feeds the header identity → the real name shows (in
    // BOTH the header and the side panel summary, hence findAllByText).
    expect((await screen.findAllByText('Keisha Jones')).length).toBeGreaterThan(0);
    // The needs-review cue is cleared for a resolved identity: no review Badge
    // (scoped via its title so the triage <option> labels don't false-match).
    expect(
      document.querySelector('[title="Identity not yet confirmed"]'),
    ).toBeNull();
  });

  it('a TYPE-ONLY triage clears the needs-review badge and the header shows the resolved type (no fabricated name)', async () => {
    renderThread();
    await screen.findByText(/no messages yet/i);

    // The needs-review Badge is visible up front (unknown_1to1 + unknown contact).
    expect(
      document.querySelector('[title="Identity not yet confirmed"]'),
    ).not.toBeNull();

    // The desktop side panel renders the triage form. Set type → Tenant, save.
    const typeSelect = await screen.findByLabelText('Type');
    fireEvent.change(typeSelect, { target: { value: 'tenant' } });

    // REAL backend behavior on a type-only triage: it auto-advances the contact
    // status to 'active' BECAUSE the type resolved to tenant, and flips the
    // conversation to tenant_1to1 — but NO name was entered, so the refetched
    // contact carries no name (the UI must not fabricate one). The post-save
    // refetch reflects exactly that: status:'active', type:'tenant', NO name.
    api.getConversation.mockResolvedValue(makeConversation({ type: 'tenant_1to1' }));
    api.getContact.mockResolvedValue(makeContact({ type: 'tenant', status: 'active' }));

    const saveButtons = screen.getAllByRole('button', { name: /save contact/i });
    fireEvent.click(saveButtons[0]!);

    // Dirty-tracking: only the changed type is sent (no stale status/name/notes).
    await waitFor(() => expect(api.updateContact).toHaveBeenCalledTimes(1));
    expect(api.updateContact).toHaveBeenCalledWith('contact-1', { type: 'tenant' });
    // Conversation refetched after the type flip.
    await waitFor(() => expect(api.getConversation.mock.calls.length).toBeGreaterThan(1));
    // Regression: the header needs-review Badge clears once the identity resolves
    // (the backend auto-advanced status → 'active', so needs_review is gone).
    await waitFor(() =>
      expect(document.querySelector('[title="Identity not yet confirmed"]')).toBeNull(),
    );
    // …and the header now shows the RESOLVED TYPE ("Tenant"), not a fabricated
    // name: with no contact name, the label stays the formatted phone.
    expect(screen.getAllByText('Tenant').length).toBeGreaterThan(0);
    expect(screen.getAllByText('(313) 555-1234').length).toBeGreaterThan(0);
  });

  it('a team_member triage clears the needs-review cue and shows the name even though the thread stays unknown_1to1 (regression)', async () => {
    // The bug the operator hit: triaging a contact to a NON-tenant/landlord type
    // (team_member) leaves the conversation type at unknown_1to1 (there is no
    // *_1to1 value for a team_member). Identity must follow the CONTACT, so the
    // header should resolve — real name, no "?"/review badge — once the contact
    // is active + named.
    api.getConversation.mockResolvedValue(makeConversation({ type: 'unknown_1to1' }));
    api.getContact.mockResolvedValue(
      makeContact({ type: 'team_member', status: 'active', firstName: 'Jamie', lastName: 'Rivera' }),
    );

    renderThread();

    // The resolved name surfaces (header + side panel summary).
    expect((await screen.findAllByText('Jamie Rivera')).length).toBeGreaterThan(0);
    // The needs-review cue is cleared even though the thread is still unknown_1to1
    // (scoped via its title so the triage <option> labels don't false-match).
    expect(document.querySelector('[title="Identity not yet confirmed"]')).toBeNull();
    // The phone remains as the honest subtitle (it is NOT used as the header
    // label here — the resolved name is), so we don't assert its absence.
  });
});

describe('<Thread> mark read (M3)', () => {
  it('marks read once on open, and does NOT refire on focus when already read', async () => {
    // unread_count 0 → after the on-open mark-read, a window focus must not POST again.
    api.getConversation.mockResolvedValue(makeConversation({ unread_count: 0 }));
    renderThread();
    await screen.findByText(/no messages yet/i);

    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(1));

    fireEvent(window, new Event('focus'));
    // Still exactly one — no redundant /read for an already-read thread.
    await Promise.resolve();
    expect(api.markRead).toHaveBeenCalledTimes(1);
  });

  it('re-marks read on focus when there is unread', async () => {
    api.getConversation.mockResolvedValue(makeConversation({ unread_count: 3 }));
    renderThread();
    await screen.findByText(/no messages yet/i);

    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(1));

    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(2));
  });
});

describe('<Thread> live updates', () => {
  it('appends an incoming message.persisted event (deduped by tsMsgId)', async () => {
    api.listMessages.mockResolvedValue([]);
    renderThread();
    await screen.findByText(/no messages yet/i);

    // The next listMessages (triggered by the event for an unseen tsMsgId)
    // returns the new inbound message.
    api.listMessages.mockResolvedValue([
      makeMessage({ tsMsgId: 'tNEW#SMx', direction: 'inbound', author: 'tenant', body: 'live message' }),
    ]);

    const event: MessagePersistedEvent = {
      conversationId: CONV_ID,
      tsMsgId: 'tNEW#SMx',
      direction: 'inbound',
      deliveryStatus: 'delivered',
    };
    api.eventHandlers.current?.onMessagePersisted?.(event);

    expect(await screen.findByText('live message')).toBeInTheDocument();
  });

  it('ignores message.persisted events for OTHER conversations', async () => {
    api.listMessages.mockResolvedValue([]);
    renderThread();
    await screen.findByText(/no messages yet/i);

    api.listMessages.mockClear();
    api.eventHandlers.current?.onMessagePersisted?.({
      conversationId: 'some-other-conv',
      tsMsgId: 'x#y',
      direction: 'inbound',
      deliveryStatus: 'delivered',
    });

    expect(api.listMessages).not.toHaveBeenCalled();
  });
});

describe('<Thread> error states', () => {
  it('renders "conversation not found" on a 404', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../api')>('../../api');
    api.getConversation.mockRejectedValue(new ApiError(404, 'not_found', 'not found'));
    renderThread();

    expect(await screen.findByText(/conversation not found/i)).toBeInTheDocument();
  });
});

describe('<Thread> assignment', () => {
  it('assigns to self via setAssignment', async () => {
    renderThread();
    const assign = await screen.findByRole('button', { name: /assign to me/i });
    fireEvent.click(assign);
    await waitFor(() => expect(api.setAssignment).toHaveBeenCalledWith(CONV_ID, 'u-me'));
  });

  it('renders the Call instead affordance DISABLED (M1.9)', async () => {
    renderThread();
    const call = await screen.findByRole('button', { name: /call instead/i });
    expect(call).toBeDisabled();
    expect(call).toHaveAttribute('title', 'Calling arrives in M1.9');
  });
});

describe('<Thread> XSS regression — hostile content renders as inert text', () => {
  const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
  const JS_PAYLOAD = 'javascript:alert(document.cookie)';

  it('renders a hostile MESSAGE BODY as text — no <img> / element injected', async () => {
    api.listMessages.mockResolvedValue([
      makeMessage({ tsMsgId: 't1#SM1', direction: 'inbound', author: 'tenant', body: IMG_PAYLOAD }),
    ]);
    renderThread();

    // The payload appears verbatim as TEXT (React escaped it on render)…
    expect(await screen.findByText(IMG_PAYLOAD)).toBeInTheDocument();
    // …and crucially NO live <img> element was injected from the body.
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders a hostile CONTACT NAME as text — no script/anchor injected', async () => {
    // A triaged contact whose name carries hostile markup + a javascript: URL.
    api.getConversation.mockResolvedValue(makeConversation({ type: 'tenant_1to1' }));
    api.getContact.mockResolvedValue(
      makeContact({
        type: 'tenant',
        status: 'active',
        firstName: IMG_PAYLOAD,
        lastName: JS_PAYLOAD,
      }),
    );
    renderThread();

    // The hostile name shows as escaped text (header + side panel) …
    expect((await screen.findAllByText(`${IMG_PAYLOAD} ${JS_PAYLOAD}`)).length).toBeGreaterThan(0);
    // … with no injected <img> and no <a href="javascript:..."> anchor.
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
