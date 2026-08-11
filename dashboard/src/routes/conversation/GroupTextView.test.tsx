// GroupTextView - the NATIVE group-text thread view, exercised THROUGH
// ConversationDetail so the type dispatch is covered by the same tests (the
// dangerous failure this replaces was a silent redirect, not a crash).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type {
  ConversationHeader,
  EventStreamHandlers,
  GroupMemberRow,
  Message,
} from '../../api/index.js';

const getConversation = vi.fn();
const getConversationMembers = vi.fn();
const getGroupMembers = vi.fn();
const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
const markConversationRead = vi.fn();
const getContacts = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversation: (...a: unknown[]) => getConversation(...a),
    getConversationMembers: (...a: unknown[]) => getConversationMembers(...a),
    getGroupMembers: (...a: unknown[]) => getGroupMembers(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversationScheduled: (...a: unknown[]) => getConversationScheduled(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { ConversationDetail } from './ConversationDetail.js';

const ANN: GroupMemberRow = {
  contactId: 'c-ann',
  phone: '+14045550111',
  name: 'Ann Tenant',
  suppressed: false,
  suppressionScope: 'primary',
};
const MARCUS: GroupMemberRow = {
  contactId: 'c-marcus',
  phone: '+14045550112',
  name: 'Marcus Landlord',
  suppressed: false,
  suppressionScope: 'primary',
};

function groupHeader(over: Partial<ConversationHeader> = {}): ConversationHeader {
  return {
    conversationId: 'gt-1',
    type: 'group_text',
    status: 'group_open',
    participants: [
      { contactId: ANN.contactId, phone: ANN.phone, name: ANN.name },
      { contactId: MARCUS.contactId, phone: MARCUS.phone, name: MARCUS.name },
    ],
    ...over,
  };
}

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
  getGroupMembers.mockReset();
  getConversationMessages.mockReset().mockResolvedValue([]);
  getConversationScheduled.mockReset().mockResolvedValue({ scheduled: [] });
  markConversationRead.mockReset().mockResolvedValue(undefined);
  getContacts.mockReset().mockResolvedValue({ nextCursor: null, contacts: [] });
  getGroupMembers.mockResolvedValue([ANN, MARCUS]);
  getConversation.mockResolvedValue(groupHeader());
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('ConversationDetail dispatch - group_text', () => {
  it('renders the group text view and NEVER redirects to a roster member', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    // The pre-S4 `!== 'relay_group'` redirect would have landed here instead.
    expect(screen.queryByText('CONTACT PAGE')).toBeNull();
    expect(screen.getByText('With Ann & Marcus')).toBeInTheDocument();
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('gt-1'));
  });

  it('reads the roster from the GROUP members route, never the relay members route', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getGroupMembers).toHaveBeenCalled());
    // /conversations/:id/members is relay-only by a positive type guard: calling
    // it here would 404 and blank the panel.
    expect(getConversationMembers).not.toHaveBeenCalled();
  });

  it('states in the header that the group is unmasked', async () => {
    renderAt('gt-1');
    await waitFor(() =>
      expect(
        screen.getByText(/Everyone in this group text sees everyone's real number/),
      ).toBeInTheDocument(),
    );
  });

  it('ships NO composer in this slice (the group send lands with its typed refusal)', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    // Not a disabled composer either: a text box you can type into and never
    // send from loses the operator's draft.
    expect(screen.queryByLabelText('Reply message')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Send$/ })).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(/Replying to a group text is coming next/);
  });

  it('offers no roster editing, close, or reopen (a different roster is a different thread)', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Add member/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Close/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/i })).toBeNull();
  });
});

describe('GroupTextView - member panel', () => {
  it('links each known member to their contact page', async () => {
    renderAt('gt-1');
    const roster = await screen.findByRole('list', { name: 'Group members' });
    expect(within(roster).getByRole('link', { name: 'Ann Tenant' })).toHaveAttribute(
      'href',
      '/contacts/c-ann',
    );
    expect(within(roster).getByText('(404) 555-0111')).toBeInTheDocument();
  });

  it('renders an unknown-number member as plain text', async () => {
    getGroupMembers.mockResolvedValue([
      ANN,
      { contactId: '', phone: '+14045550113', suppressed: false, suppressionScope: 'no_contact' },
    ]);
    renderAt('gt-1');
    const roster = await screen.findByRole('list', { name: 'Group members' });
    await waitFor(() => expect(within(roster).getByText('(404) 555-0113')).toBeInTheDocument());
    expect(within(roster).queryByRole('link', { name: '(404) 555-0113' })).toBeNull();
  });

  it('chips a PRIMARY-number opt-out as the member opting out', async () => {
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' },
      MARCUS,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());
  });

  it('chips a SECONDARY-number opt-out as THIS NUMBER only', async () => {
    // The number-scoped seam's whole point: the contact may be perfectly
    // reachable on their primary number. Saying "opted out" flatly would be a
    // lie staff would act on.
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'secondary' },
      MARCUS,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('This number opted out')).toBeInTheDocument());
    expect(screen.queryByText('Opted out')).toBeNull();
  });

  it('shows no suppression chip for a reachable member', async () => {
    renderAt('gt-1');
    await screen.findByRole('list', { name: 'Group members' });
    expect(screen.queryByText(/Opted out/i)).toBeNull();
  });

  it('surfaces a DELETED member and what it means for sending', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, deleted: true }, MARCUS]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Deleted')).toBeInTheDocument());
    expect(screen.getByText(/Sending is refused while they are deleted/)).toBeInTheDocument();
  });

  it('keeps the membership visible when the member-state read fails, and says state is missing', async () => {
    getGroupMembers.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // Membership comes from the header, which is immutable - it must not blank.
    const roster = screen.getByRole('list', { name: 'Group members' });
    expect(within(roster).getByRole('link', { name: 'Ann Tenant' })).toBeInTheDocument();
    expect(screen.getByText(/Opt-out state may be missing/)).toBeInTheDocument();
  });
});

describe('GroupTextView - the send cap', () => {
  const bigRoster: GroupMemberRow[] = Array.from({ length: 10 }, (_, i) => ({
    contactId: `c-${i}`,
    phone: `+140455501${String(20 + i)}`,
    name: `Member${i}`,
    suppressed: false,
    suppressionScope: 'primary' as const,
  }));

  it('marks a >9-member thread read-only and names the 1:1 links as the fallback', async () => {
    getGroupMembers.mockResolvedValue(bigRoster);
    renderAt('gt-1');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /10 members, more than the 9 a group send can reach/,
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/one at a time from their contact pages/);
  });

  it('renders no read-only banner at or under the cap', async () => {
    renderAt('gt-1');
    await screen.findByRole('list', { name: 'Group members' });
    expect(screen.queryByText(/group send can reach/)).toBeNull();
  });
});

describe('GroupTextView - the transcript', () => {
  function msg(over: Partial<Message> = {}): Message {
    return {
      conversationId: 'gt-1',
      tsMsgId: '2026-06-17T10:00:00.000Z#SM1',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      body: 'On my way',
      delivery_status: 'delivered',
      provider_ts: '2026-06-17T10:00:00.000Z',
      ...over,
    } as Message;
  }

  it('attributes a member message by its PHONE-SCOPED sender key', async () => {
    getConversationMessages.mockResolvedValue([msg({ relay_sender_key: 'phone#+14045550112' })]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('On my way')).toBeInTheDocument());
    // Resolved through the shared attribution renderer, against the group roster:
    // the name appears TWICE - once as the bubble's sender chip, once in the
    // member panel (which renders it as a link).
    await waitFor(() => expect(screen.getAllByText('Marcus Landlord')).toHaveLength(2));
    expect(
      screen.getAllByText('Marcus Landlord').some((el) => el.tagName !== 'A'),
    ).toBe(true);
  });

  it('refetches the transcript on a live message event', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledTimes(1));
    getConversationMessages.mockResolvedValue([msg({ body: 'Just landed' })]);
    act(() => {
      sse.onMessagePersisted?.({
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:05:00.000Z#SM2',
        direction: 'inbound',
      } as never);
    });
    await waitFor(() => expect(screen.getByText('Just landed')).toBeInTheDocument());
  });

  it('never asks for a scheduled bucket (group threads have no automated sends)', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalled());
    expect(getConversationScheduled).not.toHaveBeenCalled();
  });
});
