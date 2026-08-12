// GroupTextView - the NATIVE group-text thread view, exercised THROUGH
// ConversationDetail so the type dispatch is covered by the same tests (the
// dangerous failure this replaces was a silent redirect, not a crash).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const sendMessageMock = vi.fn();
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
    sendMessage: (...a: unknown[]) => sendMessageMock(...a),
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
  sendMessageMock.mockReset().mockResolvedValue({
    conversationId: 'gt-1',
    providerSid: 'IMsent1',
    tsMsgId: '2026-06-17T11:00:00.000Z#IMsent1',
    status: 'queued',
  });
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

  it('ships a working composer (S5) - and no leftover "coming next" note', async () => {
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('Group text')).toBeInTheDocument());
    expect(await screen.findByLabelText('Reply message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Replying to a group text is coming next/)).toBeNull();
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

  // LIVE QA ROUND 2, L6. Every member a carrier group detects is a bare stub
  // with no name, so this - not the named case above - is what a real group
  // thread renders. It used to attribute NOTHING, for every member, always.
  it('attributes a NAMELESS member by their formatted number, not by nothing', async () => {
    const nameless: GroupMemberRow = {
      contactId: 'c-stub',
      phone: '+16174707727',
      suppressed: false,
      suppressionScope: 'no_contact',
    };
    getGroupMembers.mockResolvedValue([ANN, nameless]);
    getConversation.mockResolvedValue(
      groupHeader({
        participants: [
          { contactId: ANN.contactId, phone: ANN.phone, name: ANN.name },
          { contactId: nameless.contactId, phone: nameless.phone },
        ],
      }),
    );
    getConversationMessages.mockResolvedValue([msg({ relay_sender_key: 'phone#+16174707727' })]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('On my way')).toBeInTheDocument());
    // Twice, for the same reason the named case is twice: the bubble's sender
    // chip and the member panel's row, both spelling the number identically.
    await waitFor(() => expect(screen.getAllByText('(617) 470-7727')).toHaveLength(2));
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

// ---------------------------------------------------------------------------
// S5 - the composer
// ---------------------------------------------------------------------------

describe('GroupTextView - the composer (S5)', () => {
  async function typeAndSend(text: string): Promise<void> {
    const box = await screen.findByLabelText('Reply message');
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
  }

  it('POSTs the reply to the thread and shows the bubble optimistically', async () => {
    renderAt('gt-1');
    await typeAndSend('on my way');

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledWith('gt-1', { body: 'on my way' }));
    // The optimistic bubble is on screen before any refetch resolves.
    await waitFor(() => expect(screen.getByText('on my way')).toBeInTheDocument());
  });

  it('names the GROUP TEXT in the reply note, never "relay group"', async () => {
    renderAt('gt-1');
    await screen.findByLabelText('Reply message');
    expect(screen.getByText(/everyone in this group text/)).toBeInTheDocument();
    expect(screen.queryByText(/everyone in this relay group/)).toBeNull();
  });

  it('offers NO attach control - outbound group media is not supported in v1', async () => {
    renderAt('gt-1');
    await screen.findByLabelText('Reply message');
    expect(screen.queryByRole('button', { name: /Attach a file/i })).toBeNull();
  });

  it('surfaces a refused send and restores the draft rather than losing it', async () => {
    sendMessageMock.mockRejectedValue(
      new ApiError(409, 'group_member_deleted', 'Marcus is a deleted contact'),
    );
    renderAt('gt-1');
    await typeAndSend('on my way');

    await waitFor(() =>
      expect(screen.getByText(/Someone in this group text is a deleted contact/)).toBeInTheDocument(),
    );
    // The words are not lost to a 409.
    expect(await screen.findByLabelText('Reply message')).toHaveValue('on my way');
    // ...and the optimistic bubble is gone, so nothing implies it was sent: the
    // only place that text survives is the restored draft itself.
    const occurrences = screen.getAllByText('on my way');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.tagName).toBe('TEXTAREA');
  });

  it('explains a no-consent refusal specifically', async () => {
    sendMessageMock.mockRejectedValue(new ApiError(409, 'group_member_no_consent', 'no basis'));
    renderAt('gt-1');
    await typeAndSend('hello');
    await waitFor(() =>
      expect(screen.getByText(/has no recorded consent basis/)).toBeInTheDocument(),
    );
  });

  it('explains a rail-not-ready refusal specifically', async () => {
    sendMessageMock.mockRejectedValue(new ApiError(409, 'group_rail_unavailable', 'no rail'));
    renderAt('gt-1');
    await typeAndSend('hello');
    await waitFor(() =>
      expect(screen.getByText(/not connected for sending yet/)).toBeInTheDocument(),
    );
  });

  it('REPLACES the composer on an over-cap thread rather than offering a dead one', async () => {
    getGroupMembers.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        contactId: `c-${i}`,
        phone: `+140455501${String(20 + i)}`,
        name: `Member${i}`,
        suppressed: false,
        suppressionScope: 'primary' as const,
      })),
    );
    renderAt('gt-1');
    await waitFor(() =>
      expect(screen.getByRole('note')).toHaveTextContent(/Too many members to send as a group/),
    );
    expect(screen.queryByLabelText('Reply message')).toBeNull();
  });

  it('KEEPS the composer live when a member is deleted, and says why sending will be refused', async () => {
    // A deleted member is a SERVER refusal, not a structural impossibility: the
    // contact can be restored while the operator is looking at the thread.
    getGroupMembers.mockResolvedValue([{ ...ANN, deleted: true }, MARCUS]);
    renderAt('gt-1');
    expect(await screen.findByLabelText('Reply message')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .some((el) => /Sending is refused while a member is a deleted contact/.test(el.textContent ?? '')),
      ).toBe(true),
    );
  });

  it('says a suppressed member will not receive the send, without blocking it', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, suppressed: true, suppressionScope: 'primary' }, MARCUS]);
    renderAt('gt-1');
    expect(await screen.findByLabelText('Reply message')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((el) => /One member has opted out/.test(el.textContent ?? '')),
      ).toBe(true),
    );
  });

  // LIVE QA ROUND 2, L5. The notice blamed the CARRIER for dropping the message.
  // The live evidence says otherwise: Twilio skips the participant, so no leg is
  // ever created and no carrier ever sees it. An operator told "their carrier
  // drops it" would go hunting a carrier failure that does not exist.
  it('does NOT blame the carrier for an opt-out - Twilio never sends the leg', async () => {
    getGroupMembers.mockResolvedValue([{ ...ANN, suppressed: true, suppressionScope: 'primary' }, MARCUS]);
    renderAt('gt-1');
    const notice = await waitFor(() => {
      const el = screen
        .getAllByRole('status')
        .find((n) => /opted out/.test(n.textContent ?? ''));
      if (!el) throw new Error('the opt-out notice never rendered');
      return el;
    });
    expect(notice.textContent).not.toMatch(/carrier drops it/i);
    expect(notice.textContent).toMatch(/Twilio skips them/i);
  });

  // LIVE QA ROUND 2, L5 (layout). `twoPaneShell .left` is `display: flex` with
  // the default ROW direction, so a notice rendered as a SIBLING of the timeline
  // became its own column beside the conversation and squeezed the messages into
  // a narrow slice. The pane must therefore hold exactly ONE flex child - the
  // stack - with every notice inside it, above the timeline.
  it('stacks the notices ABOVE the conversation instead of beside it', async () => {
    getGroupMembers.mockResolvedValue([
      { ...ANN, suppressed: true, suppressionScope: 'primary' },
      { ...MARCUS, deleted: true },
    ]);
    renderAt('gt-1');
    const composer = await screen.findByLabelText('Reply message');
    const notice = await waitFor(() => {
      const el = screen.getAllByRole('status').find((n) => /opted out/.test(n.textContent ?? ''));
      if (!el) throw new Error('the opt-out notice never rendered');
      return el;
    });
    const stack = notice.parentElement;
    expect(stack).not.toBeNull();
    // Every notice AND the conversation live in the one stack...
    expect(stack!.contains(composer)).toBe(true);
    expect(
      screen.getAllByRole('status').filter((n) => n.parentElement === stack).length,
    ).toBeGreaterThan(1);
    // ...and the flex-ROW pane above it has exactly that one child, so nothing
    // can ever sit BESIDE the conversation again.
    expect(stack!.parentElement!.children).toHaveLength(1);
  });

  it('renders the per-member delivery rollup on an outbound group message', async () => {
    getConversationMessages.mockResolvedValue([
      {
        conversationId: 'gt-1',
        tsMsgId: '2026-06-17T10:00:00.000Z#IM1',
        direction: 'outbound',
        author: 'teammate',
        type: 'sms',
        body: 'heading over',
        delivery_status: 'queued',
        provider_ts: '2026-06-17T10:00:00.000Z',
        delivery_recipients: {
          'phone#+14045550111': { status: 'delivered' },
          'phone#+14045550112': { status: 'sent' },
        },
      } as unknown as Message,
    ]);
    renderAt('gt-1');
    await waitFor(() => expect(screen.getByText('heading over')).toBeInTheDocument());
    expect(screen.getByText(/delivered 1\/2/)).toBeInTheDocument();
  });
});
