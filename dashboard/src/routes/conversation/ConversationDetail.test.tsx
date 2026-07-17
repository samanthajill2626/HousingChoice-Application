import { render, screen, waitFor, within } from '@testing-library/react';
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
const getContacts = vi.fn();

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
    getContacts: (...a: unknown[]) => getContacts(...a),
    useEventStream: () => {},
  };
});

import { ConversationDetail } from './ConversationDetail.js';

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

beforeEach(() => {
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
  getConversationScheduled.mockResolvedValue([]);
  getConversationMembers.mockResolvedValue([KEISHA, LARS]);
  markConversationRead.mockResolvedValue(undefined);
  // useContacts('all') fans out per type; return the candidate for tenants only
  // (so the search field yields exactly one option).
  getContacts.mockImplementation((params: { type?: string } = {}) =>
    Promise.resolve({ nextCursor: null, contacts: params.type === 'tenant' ? [CANDIDATE] : [] }),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('ConversationDetail dispatch', () => {
  it('renders the group view for a relay_group conversation', async () => {
    getConversation.mockResolvedValue(relayHeader());
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
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
    // Marked read on view.
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('conv-g1'));
  });

  it('shows the pinned Upcoming section for group-routed scheduled reminders', async () => {
    getConversation.mockResolvedValue(relayHeader());
    getConversationScheduled.mockResolvedValue([
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
    ]);
    renderAt('conv-g1');
    const region = await screen.findByRole('region', { name: 'Upcoming scheduled messages' });
    expect(within(region).getByText('Reminder: your property tour is tomorrow.')).toBeInTheDocument();
    expect(getConversationScheduled).toHaveBeenCalledWith('conv-g1', expect.anything());
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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Reply message'), 'On my way');
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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    // getConversationMembers ran once on mount.
    await waitFor(() => expect(getConversationMembers).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Remove Keisha Kane' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove member\?/i });
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/ }));

    // The 409 triggers a roster REFETCH (not swallowed).
    await waitFor(() => expect(getConversationMembers).toHaveBeenCalledTimes(2));
  });
});

describe('ConversationDetail close / reopen', () => {
  it('closes with a confirm that notes the pool number is released', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getConversation.mockResolvedValue(relayHeader());
    closeConversation.mockResolvedValue(relayHeader({ status: 'closed' }));
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());

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
      'This group text cannot be reopened: its number was retired after long inactivity. Start a new group text instead.';
    closeConversation.mockRejectedValue(
      new ApiError(409, 'pool_number_released', 'pool_number_released', {
        error: 'pool_number_released',
        message: serverMessage,
      }),
    );
    renderAt('conv-g1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Reopen group' }));
    const dialog = await screen.findByRole('dialog', { name: /Reopen group\?/i });
    await user.click(within(dialog).getByRole('button', { name: 'Reopen group' }));

    // The actionable server copy renders (not the generic "Couldn't reopen the group.").
    await waitFor(() => expect(screen.getByText(serverMessage)).toBeInTheDocument());
  });
});
