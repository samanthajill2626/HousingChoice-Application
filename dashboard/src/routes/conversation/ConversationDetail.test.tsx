import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type {
  Contact,
  ConversationHeader,
  ConversationParticipant,
} from '../../api/index.js';

const getConversation = vi.fn();
const getConversationMembers = vi.fn();
const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
const sendMessage = vi.fn();
const addConversationMember = vi.fn();
const removeConversationMember = vi.fn();
const closeConversation = vi.fn();
const markConversationRead = vi.fn();
const markConversationUnread = vi.fn();
const getContacts = vi.fn();
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();

// EVERY useEventStream caller in this subtree, fanned out per event name rather
// than captured last-writer-wins. Production registers each caller separately
// with the provider, so both useRelayThread's thread filter AND the header's
// live unread count really do receive conversation.updated. A single-slot
// capture would hand the event to whichever registered last and quietly turn
// the other one's assertions vacuous. Handlers are useCallback-stable, so the
// Set holds one entry per caller.
const conversationUpdatedHandlers = new Set<(e: unknown) => void>();

// The nav badge's optimistic layer, spied so the mount-mark below can assert it
// stays UNWIRED (adversarial A10). If a future edit wires noteRowsCleared into
// that effect, this spy is what catches it.
vi.mock('../../app/UnreadContext.js', () => ({
  useUnread: () => ({ unread: null, unmatchedUnread: null, noteRowsCleared, rollbackRowsCleared }),
}));

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversation: (...a: unknown[]) => getConversation(...a),
    getConversationMembers: (...a: unknown[]) => getConversationMembers(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversationScheduled: (...a: unknown[]) => getConversationScheduled(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    addConversationMember: (...a: unknown[]) => addConversationMember(...a),
    removeConversationMember: (...a: unknown[]) => removeConversationMember(...a),
    closeConversation: (...a: unknown[]) => closeConversation(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    markConversationUnread: (...a: unknown[]) => markConversationUnread(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    useEventStream: (h: { onConversationUpdated?: (e: unknown) => void }) => {
      if (h.onConversationUpdated !== undefined) conversationUpdatedHandlers.add(h.onConversationUpdated);
    },
  };
});

import { ConversationDetail } from './ConversationDetail.js';
import { seedUnreadCount, ThreadUnreadToggle } from './ThreadUnreadToggle.js';

const KEISHA: ConversationParticipant = {
  contactId: 'c1',
  phone: '+14045550111',
  name: 'Keisha Kane',
};
const LARS: ConversationParticipant = {
  contactId: 'c2',
  phone: '+14045550112',
  name: 'Lars Landlord',
};

function relayHeader(over: Partial<ConversationHeader> = {}): ConversationHeader {
  return {
    conversationId: 'conv-g1',
    type: 'relay_group',
    status: 'open',
    participant_phone: '+15550190001',
    pool_number: '+15550190001',
    participants: [KEISHA, LARS],
    owner: { type: 'tour', id: 'tour-1' },
    placement_tag: 'Maple St tour',
    ...over,
  };
}

const CANDIDATE: Contact = {
  contactId: 'c-new',
  type: 'tenant',
  firstName: 'Nadia',
  lastName: 'Newman',
  phones: [{ phone: '+14045550199', primary: true }],
};

function renderAt(conversationId: string) {
  return render(
    <MemoryRouter initialEntries={[`/conversations/${conversationId}`]}>
      <Routes>
        <Route path="/conversations/:conversationId" element={<ConversationDetail />} />
        <Route path="/contacts/:contactId" element={<div>CONTACT PAGE</div>} />
        <Route path="/inbox" element={<div>INBOX</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Deliver one conversation.updated to EVERY registered listener. The dispatch
 *  originates outside React's event system, so it is act-wrapped here. */
function emitConversationUpdated(event: Record<string, unknown>): void {
  act(() => {
    for (const handler of [...conversationUpdatedHandlers]) handler(event);
  });
}

beforeEach(() => {
  conversationUpdatedHandlers.clear();
  markConversationUnread.mockReset().mockResolvedValue(undefined);
  getConversation.mockReset();
  getConversationMembers.mockReset();
  getConversationMessages.mockReset();
  sendMessage.mockReset();
  addConversationMember.mockReset();
  removeConversationMember.mockReset();
  closeConversation.mockReset();
  markConversationRead.mockReset();
  getContacts.mockReset();
  getConversationScheduled.mockReset();
  getConversationMessages.mockResolvedValue([]);
  // The endpoint returns the whole ENVELOPE now (rows + the composing zone).
  getConversationScheduled.mockResolvedValue({ scheduled: [] });
  getConversationMembers.mockResolvedValue([KEISHA, LARS]);
  markConversationRead.mockResolvedValue(undefined);
  // useContacts('all') fans out per type; return the candidate for tenants only
  // (so the search field yields exactly one option).
  getContacts.mockImplementation((params: { type?: string } = {}) =>
    Promise.resolve({ nextCursor: null, contacts: params.type === 'tenant' ? [CANDIDATE] : [] }),
  );
});
afterEach(() => {
  // UNMOUNT BEFORE RESTORING (fix wave 2). The group view's member effect re-runs
  // on a debounced live signal, so a timer scheduled by one test can fire while a
  // component is still mounted at teardown - and once the api mocks are restored
  // the call returns undefined and the effect crashes on `.then`, failing whatever
  // test happens to be running. Explicit cleanup makes the ordering deterministic.
  cleanup();
  vi.restoreAllMocks();
});

describe('ConversationDetail dispatch', () => {
  it('renders the group view for a relay_group conversation', async () => {
    getConversation.mockResolvedValue(relayHeader());
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());
    // The segmented toggle leads with Conversation (aria-pressed).
    expect(screen.getByRole('button', { name: 'Conversation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'false');
    // The roster list is labelled + carries the members, each name linking to its
    // contact page.
    const roster = screen.getByRole('list', { name: 'Group members' });
    expect(within(roster).getByRole('link', { name: 'Keisha Kane' })).toHaveAttribute(
      'href',
      '/contacts/c1',
    );
    expect(within(roster).getByRole('link', { name: 'Lars Landlord' })).toHaveAttribute(
      'href',
      '/contacts/c2',
    );
    // Marked read on view...
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));
    // ...and DELIBERATELY not through the nav badge's optimistic layer
    // (adversarial A10). This mount-mark fires BLIND, with no unread knowledge,
    // exactly like useMarkContactRead - so an optimistic decrement here could
    // subtract a row the badge never counted. It reconciles through the cheap
    // count refetch the mark-read's own SSE event triggers. The asymmetry is
    // real and intended: opening this thread from an Inbox ROW decrements
    // instantly (useInbox knows that row's unread), opening it from Today or a
    // deep link does not.
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });

  it('shows the pinned Upcoming section for group-routed scheduled reminders', async () => {
    getConversation.mockResolvedValue(relayHeader());
    getConversationScheduled.mockResolvedValue({
      scheduled: [
        {
          kind: 'scheduled',
          id: 'sched#tour_reminder#rem-1',
          at: '2026-08-03T18:00:00.000Z',
          conversationId: 'conv-g1',
          source: 'tour_reminder',
          reminderKind: 'day_before',
          body: 'Reminder: your property tour is tomorrow.',
          refType: 'tour',
          refId: 'tour-1',
        },
      ],
    });
    renderAt('conv-g1');
    const region = await screen.findByRole('region', { name: 'Upcoming scheduled messages' });
    expect(within(region).getByText('Reminder: your property tour is tomorrow.')).toBeInTheDocument();
    expect(getConversationScheduled).toHaveBeenCalledWith('conv-g1', expect.anything());
  });

  it('labels a group-thread fire time in the zone the body was composed in', async () => {
    // ADJ-2 / spec D8: the GROUP thread renders the SAME ScheduledCard as the
    // contact timeline, so the envelope's zone has to survive the whole path
    // (endpoint -> useRelayThread -> Timeline -> card) or a navigator outside
    // the org's zone reads a fire time that contradicts the body beside it.
    // Asia/Tokyo is deliberately nobody's plausible browser zone, so the
    // assertion cannot pass by accident on a machine that happens to sit in the
    // org's zone. 2099-01-10T10:00Z is 19:00 the same day in Tokyo.
    getConversation.mockResolvedValue(relayHeader());
    getConversationScheduled.mockResolvedValue({
      scheduled: [
        {
          kind: 'scheduled',
          id: 'sched#tour_reminder#rem-tz',
          at: '2099-01-10T10:00:00.000Z',
          conversationId: 'conv-g1',
          source: 'tour_reminder',
          reminderKind: 'day_before',
          body: 'Reminder: tour at 412 Sender Way NW is tomorrow, Sat, Jan 10 at 7:00 PM.',
          refType: 'tour',
          refId: 'tour-1',
        },
      ],
      timezone: 'Asia/Tokyo',
    });
    renderAt('conv-g1');
    const region = await screen.findByRole('region', { name: 'Upcoming scheduled messages' });
    expect(within(region).getByText(/Jan 10, 7:00 PM/)).toBeInTheDocument();
  });

  it('redirects a 1:1 conversation to its contact page', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1to1',
      type: 'tenant_1to1',
      status: 'open',
      participant_phone: '+14040100007',
      participants: [{ contactId: 'k1', phone: '+14040100007' }],
    });
    renderAt('conv-1to1');
    await waitFor(() => expect(screen.getByText('CONTACT PAGE')).toBeInTheDocument());
  });

  it('degrades a 1:1 with an unresolvable contact to a fallback link (no crash)', async () => {
    getConversation.mockResolvedValue({
      conversationId: 'conv-1to1',
      type: 'unknown_1to1',
      status: 'open',
      participant_phone: '+15551230000',
      participants: [],
    });
    renderAt('conv-1to1');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /open the contact/i })).toHaveAttribute(
        'href',
        '/contacts/unknown?phone=%2B15551230000',
      ),
    );
  });

  it('shows a not-found treatment when the conversation is missing', async () => {
    getConversation.mockRejectedValue(new ApiError(404, 'conversation_not_found', 'x'));
    renderAt('nope');
    await waitFor(() => expect(screen.getByText(/couldn.t find this conversation/i)).toBeInTheDocument());
  });
});

describe('ConversationDetail group view', () => {
  it('renders the transcript reply box and the three Details cards', async () => {
    getConversation.mockResolvedValue(relayHeader());
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());
    expect(screen.getByLabelText('Reply message')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Group/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Members/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Actions/ })).toBeInTheDocument();
    // The Group card surfaces the formatted pool number + the tag.
    expect(screen.getByText('(555) 019-0001')).toBeInTheDocument();
    expect(screen.getByText('Maple St tour')).toBeInTheDocument();
  });

  it('HARD-disables the composer when the group is closed', async () => {
    // Relay number lifecycle: a closed group KEEPS its pool_number (it still
    // intercepts late texts); the composer hard-disable keys on status, not the
    // number.
    getConversation.mockResolvedValue(relayHeader({ status: 'closed' }));
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeDisabled();
    expect(screen.getByText(/this group is closed/i)).toBeInTheDocument();
  });

  it('posts a team reply optimistically via sendMessage', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    sendMessage.mockResolvedValue({
      conversationId: 'conv-g1',
      providerSid: 'team-1',
      tsMsgId: '2026-07-04T10:00:00.000Z#team-1',
      status: 'queued',
    });
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Reply message'), 'On my way');
    await user.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('conv-g1', { body: 'On my way' }));
  });
});

describe('ConversationDetail connecting state', () => {
  it('renders a Connecting pill (not Open/Closed) and keeps the composer usable', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    // A connect-when-ready group (D9): status 'connecting', no pool_number yet.
    getConversation.mockResolvedValue(relayHeader({ status: 'connecting', pool_number: undefined }));
    sendMessage.mockResolvedValue({
      conversationId: 'conv-g1',
      providerSid: 'team-q1',
      tsMsgId: '2026-07-04T10:00:00.000Z#team-q1',
      status: 'queued_pending',
    });
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    // A distinct Connecting state - never Open, never Closed.
    expect(screen.getAllByText('Connecting').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    // A standing note explains the composer queues instead of sending.
    expect(screen.getByText(/messages will send when the group connects/i)).toBeInTheDocument();

    // The composer is NOT hard-disabled (unlike closed): typing enables Send, and a
    // send is accepted (the server persists it queued_pending and returns success).
    await user.type(screen.getByLabelText('Reply message'), 'On my way');
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('conv-g1', { body: 'On my way' }));
  });
});

describe('ConversationDetail roster management', () => {
  it('adds a member picked from contact search (resolves the contact primary phone)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    addConversationMember.mockResolvedValue([KEISHA, LARS, { contactId: 'c-new', phone: '+14045550199', name: 'Nadia Newman' }]);
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add a member' }));
    const search = screen.getByRole('combobox', { name: 'Add member' });
    await user.type(search, 'Nadia');
    await user.click(await screen.findByRole('option', { name: /Nadia Newman/ }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(addConversationMember).toHaveBeenCalledWith('conv-g1', {
        phone: '+14045550199',
        contactId: 'c-new',
        name: 'Nadia Newman',
      }),
    );
  });

  it('adds a member by raw phone (normalized to E.164) when no contact is picked', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    addConversationMember.mockResolvedValue([KEISHA, LARS, { contactId: '', phone: '+14045550123' }]);
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add a member' }));
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), '(404) 555-0123');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(addConversationMember).toHaveBeenCalledWith('conv-g1', { phone: '+14045550123' }),
    );
  });

  it('removes a member after a confirm', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    removeConversationMember.mockResolvedValue([LARS]);
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Remove Keisha Kane' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove member\?/i });
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/ }));

    await waitFor(() => expect(removeConversationMember).toHaveBeenCalledWith('conv-g1', '+14045550111'));
  });

  it('refetches the roster on a 409 roster_conflict during remove', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    removeConversationMember.mockRejectedValue(new ApiError(409, 'roster_conflict', 'roster_conflict'));
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());
    // getConversationMembers ran once on mount.
    await waitFor(() => expect(getConversationMembers).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Remove Keisha Kane' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove member\?/i });
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/ }));

    // The 409 triggers a roster REFETCH (not swallowed).
    await waitFor(() => expect(getConversationMembers).toHaveBeenCalledTimes(2));
  });

  it('add refused (409 phone_conflict_on_number): surfaces the actionable server message (W1)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    const serverMessage =
      'This person already has a relay group history on this number. Start a new relay group with them instead.';
    addConversationMember.mockRejectedValue(
      new ApiError(409, 'phone_conflict_on_number', 'phone_conflict_on_number', {
        error: 'phone_conflict_on_number',
        message: serverMessage,
      }),
    );
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Add a member' }));
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), '(404) 555-0177');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // The actionable server copy renders (not the generic "Couldn't add that member.").
    await waitFor(() => expect(screen.getByText(serverMessage)).toBeInTheDocument());
  });
});

describe('ConversationDetail close / reopen', () => {
  it('closes with a confirm that notes the pool number is released', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    closeConversation.mockResolvedValue(relayHeader({ status: 'closed' }));
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Close group' }));
    const dialog = await screen.findByRole('dialog', { name: /Close group\?/i });
    expect(within(dialog).getByText(/sends members a final automated message/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close group' }));

    await waitFor(() => expect(closeConversation).toHaveBeenCalledWith('conv-g1', true));
  });

  it('reopens with a confirm that notes the number is kept (no re-provisioning)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader({ status: 'closed' }));
    closeConversation.mockResolvedValue(relayHeader());
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Reopen group' }));
    const dialog = await screen.findByRole('dialog', { name: /Reopen group\?/i });
    expect(within(dialog).getByText(/keeps the same number/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reopen group' }));

    await waitFor(() => expect(closeConversation).toHaveBeenCalledWith('conv-g1', false));
  });

  it('reopen refused (409 pool_number_released): surfaces the actionable server message (AF-3)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader({ status: 'closed' }));
    const serverMessage =
      'This relay group cannot be reopened: its number was retired after long inactivity. Start a new relay group instead.';
    closeConversation.mockRejectedValue(
      new ApiError(409, 'pool_number_released', 'pool_number_released', {
        error: 'pool_number_released',
        message: serverMessage,
      }),
    );
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Reopen group' }));
    const dialog = await screen.findByRole('dialog', { name: /Reopen group\?/i });
    await user.click(within(dialog).getByRole('button', { name: 'Reopen group' }));

    // The actionable server copy renders (not the generic "Couldn't reopen the group.").
    await waitFor(() => expect(screen.getByText(serverMessage)).toBeInTheDocument());
  });
});

// --- S7: the header mark-read / mark-unread toggle (D6) ---------------------
//
// ONE affordance, never both halves at once, chosen by a LIVE count. The count
// is seeded from the mount header and thereafter owned by conversation.updated:
// the header is fetched once per conversationId and NOTHING re-reads it, so a
// seed-only toggle would be frozen on a pre-auto-read number forever.
describe('ConversationDetail - the relay header unread toggle (S7)', () => {
  const MARK_UNREAD = 'Mark Relay group as unread';
  const MARK_READ = 'Mark Relay group read';

  async function openRelay(over: Partial<ConversationHeader> = {}): Promise<void> {
    getConversation.mockResolvedValue(relayHeader(over));
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Relay group')).toBeInTheDocument());
  }

  it('offers Mark unread - and NEVER Mark read - while the live count is 0', async () => {
    await openRelay({ unread_count: 0 });
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_READ })).toBeNull();
  });

  it('offers Mark read - and NEVER Mark unread - while the live count is above 0', async () => {
    await openRelay({ unread_count: 3 });
    expect(await screen.findByRole('button', { name: MARK_READ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_UNREAD })).toBeNull();
  });

  it('takes the count LIVE from conversation.updated, with no re-fetch of the header', async () => {
    await openRelay({ unread_count: 0 });
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();

    emitConversationUpdated({
      conversationId: 'conv-g1',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 3,
    });

    // The seed said 0 and nothing re-read the header - only the event can have
    // flipped this.
    expect(await screen.findByRole('button', { name: MARK_READ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_UNREAD })).toBeNull();
    expect(getConversation).toHaveBeenCalledTimes(1);
  });

  it('ignores a conversation.updated for a DIFFERENT thread', async () => {
    await openRelay({ unread_count: 0 });
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    emitConversationUpdated({
      conversationId: 'some-other-thread',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 9,
    });
    expect(screen.getByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_READ })).toBeNull();
  });

  it('survives a mount header with NO unread_count at all (0, never NaN)', async () => {
    // relayHeader() carries no unread_count - the attribute is genuinely sparse
    // server-side, so this is the common case, not an edge one.
    await openRelay();
    expect(await screen.findByRole('button', { name: MARK_UNREAD })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MARK_READ })).toBeNull();
  });

  it('seeds an absent or non-numeric unread_count as 0, never NaN', () => {
    // Asserted on the seed DIRECTLY, because the rendered toggle cannot tell the
    // two apart: `NaN > 0` and `0 > 0` are both false, so a NaN seed renders the
    // exact same label a real 0 does and the bug ships invisibly.
    const base = relayHeader();
    expect(seedUnreadCount(base)).toBe(0);
    expect(Number.isNaN(seedUnreadCount(base))).toBe(false);
    expect(seedUnreadCount(relayHeader({ unread_count: '3' }))).toBe(0);
    expect(seedUnreadCount(relayHeader({ unread_count: Number.NaN }))).toBe(0);
    expect(seedUnreadCount(relayHeader({ unread_count: 4 }))).toBe(4);
  });

  it('awaits the auto-read drain BEFORE issuing the mark-unread POST', async () => {
    // THE ordering test. The mount auto-read is held open, so a toggle that
    // POSTs without awaiting suppressAndDrain() is caught here and nowhere
    // else: S6 can be perfect and S7 can still fail to call it.
    let releaseAutoRead: (() => void) | undefined;
    markConversationRead.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAutoRead = resolve;
        }),
    );
    await openRelay({ unread_count: 0 });
    const button = await screen.findByRole('button', { name: MARK_UNREAD });
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    // The drain is still waiting on the in-flight auto-read.
    expect(markConversationUnread).not.toHaveBeenCalled();

    await act(async () => {
      releaseAutoRead?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(markConversationUnread).toHaveBeenCalledWith('conv-g1'));
  });

  it('navigates to /inbox once the mark-unread POST succeeds', async () => {
    await openRelay({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() => expect(screen.getByText('INBOX')).toBeInTheDocument());
  });

  it('does NOT navigate on Mark read - reading a thread is not a departure', async () => {
    await openRelay({ unread_count: 3 });
    markConversationRead.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: MARK_READ }));
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));
    expect(screen.queryByText('INBOX')).toBeNull();
  });

  it('stays put when the mark-unread POST rejects', async () => {
    markConversationUnread.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    await openRelay({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() => expect(markConversationUnread).toHaveBeenCalled());
    expect(screen.queryByText('INBOX')).toBeNull();
    expect(screen.getByText('Relay group')).toBeInTheDocument();
  });

  it('stays put when Mark read rejects', async () => {
    await openRelay({ unread_count: 3 });
    markConversationRead.mockClear().mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
    fireEvent.click(await screen.findByRole('button', { name: MARK_READ }));
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));
    expect(screen.queryByText('INBOX')).toBeNull();
  });

  it('renders a pending state while the mark-unread request is outstanding', async () => {
    let releasePost: (() => void) | undefined;
    markConversationUnread.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePost = resolve;
        }),
    );
    await openRelay({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() => expect(screen.getByRole('button', { name: MARK_UNREAD })).toBeDisabled());
    expect(screen.getByText('Marking unread...')).toBeInTheDocument();
    await act(async () => {
      releasePost?.();
      await Promise.resolve();
    });
  });

  it('renders the RETRYABLE copy on a 409 and leaves the action available', async () => {
    // The participant-GSI-lag path is expected and retryable, not an error the
    // operator has to reason about - so the button stays live.
    markConversationUnread.mockRejectedValue(
      new ApiError(409, 'thread_closed', 'thread_closed', { error: 'thread_closed' }),
    );
    await openRelay({ unread_count: 0 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not mark unread - try again'),
    );
    const button = screen.getByRole('button', { name: MARK_UNREAD });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('hides the toggle ENTIRELY on a closed relay group', async () => {
    await openRelay({ status: 'closed', unread_count: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: MARK_UNREAD })).toBeNull();
    expect(screen.queryByRole('button', { name: MARK_READ })).toBeNull();
  });

  // Fix wave 1. The toggle STAYS on the page when the mark-unread POST fails, so
  // it must hand the auto-read back or the latch outlives the attempt. Driven
  // against the component directly with a stub handle: the real auto-read hook
  // is MOUNT-ONLY, so a stuck latch has no later trigger to silence here and no
  // integration assertion could see it - but the two hooks share one contract
  // and this is the half that has a live trigger on the contact page.
  describe('the auto-read handle on the failure path', () => {
    const stubHandle = (): { suppressAndDrain: () => Promise<void>; release: () => void } => ({
      suppressAndDrain: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    });

    /** `mounted: false` is what ConversationDetail really renders the instant the
     *  operator switches threads: its header effect sets status 'loading' on
     *  every conversationId change and the spinner branch replaces the group
     *  view, so this toggle leaves the tree (useMarkThreadRead.ts:27-35 records
     *  that property and relies on it). The router keeps running around it. */
    const toggleTree = (autoRead: ReturnType<typeof stubHandle>, mounted = true) => (
      <MemoryRouter initialEntries={['/conversations/conv-g1']}>
        <Routes>
          <Route
            path="/conversations/:conversationId"
            element={
              mounted ? (
                <ThreadUnreadToggle
                  conversationId="conv-g1"
                  header={relayHeader({ unread_count: 0 })}
                  name="Relay group"
                  autoRead={autoRead}
                />
              ) : (
                <div>THREAD LOADING</div>
              )
            }
          />
          <Route path="/inbox" element={<div>INBOX</div>} />
        </Routes>
      </MemoryRouter>
    );

    const renderToggle = (autoRead: ReturnType<typeof stubHandle>) =>
      render(toggleTree(autoRead));

    it('RELEASES the auto-read when the mark-unread POST rejects', async () => {
      markConversationUnread.mockRejectedValue(new ApiError(500, 'server_error', 'boom'));
      const autoRead = stubHandle();
      renderToggle(autoRead);
      fireEvent.click(screen.getByRole('button', { name: MARK_UNREAD }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(autoRead.release).toHaveBeenCalledTimes(1);
    });

    it('does NOT release on the success path - navigating away unmounts the hook', async () => {
      const autoRead = stubHandle();
      renderToggle(autoRead);
      fireEvent.click(screen.getByRole('button', { name: MARK_UNREAD }));
      await waitFor(() => expect(screen.getByText('INBOX')).toBeInTheDocument());
      expect(autoRead.release).not.toHaveBeenCalled();
    });

    // Fix wave 2 (FIX 14), the same class as the contact page's FIX 8, one
    // surface over. The unmount silences this component's setStates but NOT its
    // navigate: react-router's useNavigate sets `activeRef` in a layout effect
    // and never clears it on unmount, so an unguarded resolution still moves a
    // page the operator has already left.
    it('does NOT navigate when the mark-unread resolves after the thread view unmounted', async () => {
      let releasePost: (() => void) | undefined;
      markConversationUnread.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releasePost = resolve;
          }),
      );
      const autoRead = stubHandle();
      const view = renderToggle(autoRead);
      fireEvent.click(screen.getByRole('button', { name: MARK_UNREAD }));
      await waitFor(() => expect(markConversationUnread).toHaveBeenCalledWith('conv-g1'));

      view.rerender(toggleTree(autoRead, false));
      expect(screen.getByText('THREAD LOADING')).toBeInTheDocument();

      await act(async () => {
        releasePost?.();
        await Promise.resolve();
      });
      expect(screen.queryByText('INBOX')).toBeNull();
      expect(screen.getByText('THREAD LOADING')).toBeInTheDocument();
    });

    it('does NOT hand back the auto-read when the rejection lands after the unmount', async () => {
      let rejectPost: (() => void) | undefined;
      markConversationUnread.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectPost = () => reject(new ApiError(500, 'server_error', 'boom'));
          }),
      );
      const autoRead = stubHandle();
      const view = renderToggle(autoRead);
      fireEvent.click(screen.getByRole('button', { name: MARK_UNREAD }));
      await waitFor(() => expect(markConversationUnread).toHaveBeenCalledWith('conv-g1'));

      view.rerender(toggleTree(autoRead, false));
      await act(async () => {
        rejectPost?.();
        await Promise.resolve();
      });
      // The handle belongs to a hook that unmounted with the view; there is no
      // latch left to release, and no banner to raise on a thread nobody is on.
      expect(autoRead.release).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('never touches the nav badge optimistic layer, in either direction', async () => {
    await openRelay({ unread_count: 3 });
    fireEvent.click(await screen.findByRole('button', { name: MARK_READ }));
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(2));
    emitConversationUpdated({
      conversationId: 'conv-g1',
      last_activity_at: '2026-08-17T11:00:00.000Z',
      unread_count: 0,
    });
    fireEvent.click(await screen.findByRole('button', { name: MARK_UNREAD }));
    await waitFor(() => expect(markConversationUnread).toHaveBeenCalled());
    expect(noteRowsCleared).not.toHaveBeenCalled();
    expect(rollbackRowsCleared).not.toHaveBeenCalled();
  });
});
