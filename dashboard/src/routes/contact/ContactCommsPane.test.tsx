// ContactCommsPane - the comms-pane behaviours, tested on the SHARED component
// rather than on the contact page that used to own them. These cases are PORTED
// from ContactDetail.test.tsx (which still runs them end-to-end through the page)
// plus the coverage the extraction makes newly reachable: retry, the reply-target
// picker, a two-conversation contact, and the deleted-contact lock with and
// without a Restore handler (tour/placement tabs pass no onRestore).
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { Contact, ContactTimelinePage } from '../../api/index.js';

const getContactTimeline = vi.fn();
const getConversations = vi.fn();
const getConversationMessages = vi.fn();
const sendMessage = vi.fn();
const sendEmail = vi.fn();
const retryMessage = vi.fn();
const ensureContactConversation = vi.fn();
const ensureEmailConversation = vi.fn();
const updateContact = vi.fn();

// Same spread-actual pattern ContactDetail.test.tsx uses: every endpoint the pane
// touches becomes a spy, while ApiError stays REAL so `err instanceof ApiError`
// (the 409 consent gate, the contact_has_no_phone fallback) still narrows.
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    retryMessage: (...a: unknown[]) => retryMessage(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    ensureEmailConversation: (...a: unknown[]) => ensureEmailConversation(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
    // No SSE in unit tests (the timeline hook subscribes).
    useEventStream: () => {},
  };
});

import { ContactCommsPane, type ContactCommsPaneProps } from './ContactCommsPane.js';
import { useContactTimeline } from './useContactTimeline.js';

// The CALLER owns useContactTimeline (spec section 3) - the harness mirrors what
// ContactDetail / ContactCommsTab do, so these tests exercise the real optimistic
// merge, not a hand-rolled timeline stub.
type HarnessProps = Omit<ContactCommsPaneProps, 'timeline' | 'resetScrollKey'> & {
  resetScrollKey?: string;
};

function PaneHarness({ contact, resetScrollKey, ...rest }: HarnessProps): React.JSX.Element {
  const timeline = useContactTimeline(contact.contactId);
  return (
    <ContactCommsPane
      contact={contact}
      timeline={timeline}
      resetScrollKey={resetScrollKey ?? contact.contactId}
      {...rest}
    />
  );
}

function renderPane(props: HarnessProps) {
  // MemoryRouter: MilestonePin renders a <Link> for any milestone with a refId.
  return render(
    <MemoryRouter>
      <PaneHarness {...props} />
    </MemoryRouter>,
  );
}

const TENANT: Contact = {
  contactId: 'k1',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Williams',
  status: 'Active',
  phone: '+14040100007',
};

// Two numbers = two 1:1 threads (each phone is its own conversation by design).
const TWO_PHONE_TENANT: Contact = {
  contactId: 'k2',
  type: 'tenant',
  firstName: 'Dana',
  lastName: 'Reed',
  status: 'Active',
  phones: [
    { phone: '+14040100007', primary: true },
    { phone: '+14045550099', primary: false, label: 'work' },
  ],
};

const PHONELESS_PARTNER: Contact = {
  contactId: 'p1',
  type: 'partner',
  firstName: 'Ed',
  lastName: 'Only',
  status: 'Active',
  emails: [{ email: 'ed@partner.example', primary: true }],
};

// One prior outbound to the contact's number, so buildReplyTargets resolves a
// conversation (canSend === true) and a send actually fires.
const TIMELINE: ContactTimelinePage = {
  nextCursor: null,
  items: [
    {
      kind: 'message',
      id: 'm0',
      at: '2026-06-01T10:00:00.000Z',
      conversationId: 'conv-k1',
      tsMsgId: '2026-06-01T10:00:00.000Z#SM0',
      direction: 'outbound',
      author: 'teammate',
      type: 'sms',
      body: 'Hi',
      delivery_status: 'delivered',
      toPhone: '+14040100007',
    },
  ],
};

function timelinePage(items: ContactTimelinePage['items']): ContactTimelinePage {
  return { nextCursor: null, items };
}

async function typeAndSend(
  user: ReturnType<typeof import('@testing-library/user-event').default.setup>,
  text: string,
): Promise<void> {
  await user.type(screen.getByLabelText('Reply message'), text);
  await user.click(screen.getByRole('button', { name: /^Send$/i }));
}

beforeEach(() => {
  getContactTimeline.mockReset();
  getConversations.mockReset();
  getConversationMessages.mockReset();
  sendMessage.mockReset();
  sendEmail.mockReset();
  retryMessage.mockReset();
  ensureContactConversation.mockReset();
  ensureEmailConversation.mockReset();
  updateContact.mockReset();
  // RESOLVED (not 404-rejected): the pane's tests must never fall into the
  // fetch-the-whole-inbox fallback path.
  getContactTimeline.mockResolvedValue(timelinePage([]));
  getConversations.mockResolvedValue({ nextCursor: null, conversations: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('ContactCommsPane - texting', () => {
  it('sends into the resolved thread and shows the optimistic bubble immediately', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TIMELINE);
    sendMessage.mockResolvedValue({
      conversationId: 'conv-k1',
      providerSid: 'SM1',
      tsMsgId: '2026-06-02T10:00:00.000Z#SM1',
      status: 'sent',
    });

    renderPane({ contact: TENANT });
    await screen.findByText('Hi');
    await typeAndSend(user, 'Hello again');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]![0]).toBe('conv-k1');
    expect(sendMessage.mock.calls[0]![1]).toEqual({ body: 'Hello again' });
    // The optimistic bubble is in the stream (addOptimistic on the caller-owned
    // timeline state) and the composer cleared.
    expect(screen.getByText('Hello again')).toBeInTheDocument();
    expect(screen.getByLabelText('Reply message')).toHaveValue('');
    expect(ensureContactConversation).not.toHaveBeenCalled();
  });

  it('with NO thread yet: Send is enabled, the first send creates the conversation then POSTs into it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    // A brand-new contact: empty timeline, but they have a number to start with.
    ensureContactConversation.mockResolvedValue('conv-new');
    sendMessage.mockResolvedValue({
      conversationId: 'conv-new',
      providerSid: 'SM9',
      tsMsgId: '2026-07-02T10:00:00.000Z#SM9',
      status: 'sent',
    });

    renderPane({ contact: TENANT });
    const box = await screen.findByLabelText('Reply message');
    await user.type(box, 'Welcome aboard!');
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /^Send$/i }));

    await waitFor(() => expect(ensureContactConversation).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]![0]).toBe('conv-new');
    expect(sendMessage.mock.calls[0]![1]).toEqual({ body: 'Welcome aboard!' });
  });

  it('retries a failed outbound message by its provider SID', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(
      timelinePage([
        {
          kind: 'message',
          id: 'm-fail',
          at: '2026-06-01T10:00:00.000Z',
          conversationId: 'conv-k1',
          tsMsgId: '2026-06-01T10:00:00.000Z#SMfail',
          direction: 'outbound',
          author: 'teammate',
          type: 'sms',
          body: 'Did not go out',
          delivery_status: 'failed',
          toPhone: '+14040100007',
        },
      ]),
    );
    retryMessage.mockResolvedValue({
      conversationId: 'conv-k1',
      providerSid: 'SM2',
      tsMsgId: '2026-06-02T10:00:00.000Z#SM2',
      status: 'sent',
    });

    renderPane({ contact: TENANT });
    await user.click(await screen.findByRole('button', { name: 'Retry sending this message' }));

    await waitFor(() => expect(retryMessage).toHaveBeenCalledWith('conv-k1', 'SMfail'));
  });
});

describe('ContactCommsPane - a two-conversation contact', () => {
  const TWO_THREADS = timelinePage([
    {
      kind: 'message',
      id: 'm-a',
      at: '2026-06-01T10:00:00.000Z',
      conversationId: 'conv-a',
      tsMsgId: '2026-06-01T10:00:00.000Z#SMA',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      body: 'Texting from my cell',
      delivery_status: 'delivered',
      fromPhone: '+14040100007',
    },
    {
      kind: 'message',
      id: 'm-b',
      at: '2026-06-02T10:00:00.000Z',
      conversationId: 'conv-b',
      tsMsgId: '2026-06-02T10:00:00.000Z#SMB',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      body: 'And this one is my work line',
      delivery_status: 'delivered',
      fromPhone: '+14045550099',
    },
  ]);

  it('renders BOTH threads and offers both numbers as reply targets', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TWO_THREADS);

    renderPane({ contact: TWO_PHONE_TENANT });
    // The person feed carries every thread - not one arbitrary conversation.
    await screen.findByText('Texting from my cell');
    expect(screen.getByText('And this one is my work line')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /change/i }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: /010-0007/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /555-0099/ })).toBeInTheDocument();
  });

  it('sends into the PICKED number thread, not the default one', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TWO_THREADS);
    sendMessage.mockResolvedValue({
      conversationId: 'conv-b',
      providerSid: 'SM3',
      tsMsgId: '2026-06-03T10:00:00.000Z#SM3',
      status: 'sent',
    });

    renderPane({ contact: TWO_PHONE_TENANT });
    await screen.findByText('Texting from my cell');

    await user.click(screen.getByRole('button', { name: /change/i }));
    await user.click(screen.getByRole('menuitem', { name: /555-0099/ }));
    await typeAndSend(user, 'Reaching your work line');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    // The primary number's thread (conv-a) is the DEFAULT - the pick wins.
    expect(sendMessage.mock.calls[0]![0]).toBe('conv-b');
  });
});

describe('ContactCommsPane - email channel', () => {
  const WITH_EMAIL: Contact = { ...TENANT, emails: [{ email: 'tasha@example.com', primary: true }] };

  async function composeEmail(
    user: ReturnType<typeof import('@testing-library/user-event').default.setup>,
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.type(screen.getByLabelText('Subject'), 'Your documents');
    await user.type(screen.getByLabelText('Message'), 'Please see the info below.');
    await user.click(screen.getByRole('button', { name: 'Send email' }));
  }

  const SENT_EMAIL = {
    conversationId: 'conv-email',
    tsMsgId: '2026-07-20T10:00:00.000Z#hc-x@mail.test',
    providerSid: 'hc-x@mail.test',
    sesMessageId: 'ses-1',
    emailMessageId: '<hc-x@mail.test>',
    status: 'sent',
    redirected: false,
  };

  it('sends into the EXISTING email thread when the timeline has one', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(
      timelinePage([
        ...TIMELINE.items,
        {
          kind: 'message',
          id: 'm-email',
          at: '2026-06-05T10:00:00.000Z',
          conversationId: 'conv-email-1',
          tsMsgId: '2026-06-05T10:00:00.000Z#hc-in@mail.test',
          direction: 'inbound',
          author: 'tenant',
          type: 'email',
          subject: 'Question about the unit',
          body: 'Is it still available?',
          delivery_status: 'delivered',
        },
      ]),
    );
    sendEmail.mockResolvedValue(SENT_EMAIL);

    renderPane({ contact: WITH_EMAIL });
    await screen.findByText('Hi');
    await composeEmail(user);

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    // The email thread wins over the phone thread, and nothing is created.
    expect(sendEmail.mock.calls[0]![0]).toBe('conv-email-1');
    expect(ensureEmailConversation).not.toHaveBeenCalled();
    expect(ensureContactConversation).not.toHaveBeenCalled();
  });

  it('falls back to the phone thread when there is no email thread yet', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TIMELINE);
    sendEmail.mockResolvedValue(SENT_EMAIL);

    renderPane({ contact: WITH_EMAIL });
    await screen.findByText('Hi');
    await composeEmail(user);

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail.mock.calls[0]![0]).toBe('conv-k1');
    expect(ensureEmailConversation).not.toHaveBeenCalled();
    expect(ensureContactConversation).not.toHaveBeenCalled();
  });

  it('a phoneless contact emails via ensureEmailConversation, NOT the phone ensure route', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    ensureEmailConversation.mockResolvedValue('conv-email');
    sendEmail.mockResolvedValue(SENT_EMAIL);

    renderPane({ contact: PHONELESS_PARTNER });
    await composeEmail(user);

    await waitFor(() => expect(ensureEmailConversation).toHaveBeenCalledWith('p1'));
    expect(ensureContactConversation).not.toHaveBeenCalled();
    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail.mock.calls[0]![0]).toBe('conv-email');
    expect(sendEmail.mock.calls[0]![1]).toMatchObject({
      to: 'ed@partner.example',
      subject: 'Your documents',
    });
  });
});

describe('ContactCommsPane - just-in-time consent gate', () => {
  it('opens the consent modal on a 409, records consent, retries the send and clears the draft', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onContactUpdated = vi.fn();
    getContactTimeline.mockResolvedValue(TIMELINE);
    sendMessage
      .mockRejectedValueOnce(new ApiError(409, 'contact_no_consent', 'contact_no_consent'))
      .mockResolvedValueOnce({
        conversationId: 'conv-k1',
        providerSid: 'SM1',
        tsMsgId: '2026-06-02T10:00:00.000Z#SM1',
        status: 'sent',
      });
    updateContact.mockResolvedValue({ ...TENANT, consent_method: 'verbal_phone' });

    renderPane({ contact: TENANT, onContactUpdated });
    await screen.findByText('Hi');
    const fetchesBeforeConsent = getContactTimeline.mock.calls.length;
    await typeAndSend(user, 'Property that fits your voucher');

    const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
    const confirm = within(dialog).getByRole('button', { name: /Record consent & send/i });
    expect(confirm).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText(/How did they consent/i), 'verbal_phone');
    await user.click(confirm);

    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    const [id, patch] = updateContact.mock.calls[0]! as [string, Record<string, unknown>];
    expect(id).toBe('k1');
    expect(patch['consent_method']).toBe('verbal_phone');

    // The held send is retried and the modal closes.
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]![0]).toBe('conv-k1');
    expect(sendMessage.mock.calls[1]![1]).toEqual({ body: 'Property that fits your voucher' });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /Record consent before texting/i }),
      ).not.toBeInTheDocument(),
    );
    // The composer restored its draft on the 409 refusal - the out-of-band retry
    // must re-clear it (clearDraftSignal).
    await waitFor(() => expect(screen.getByLabelText('Reply message')).toHaveValue(''));
    // The updated contact is mirrored UP so a page that owns contact state stays
    // in sync (ContactDetail -> setContact); tour/placement pages pass no handler.
    expect(onContactUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ consent_method: 'verbal_phone' }),
    );
    // The consent PATCH wrote a milestone with no SSE - pull the timeline.
    await waitFor(() =>
      expect(getContactTimeline.mock.calls.length).toBeGreaterThan(fetchesBeforeConsent),
    );
  });

  it('Cancel aborts the send (no PATCH, no retry) and the message stays in the box', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TIMELINE);
    sendMessage.mockRejectedValueOnce(
      new ApiError(409, 'contact_no_consent', 'contact_no_consent'),
    );

    renderPane({ contact: TENANT });
    await screen.findByText('Hi');
    await typeAndSend(user, 'A first proactive text');

    const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));

    expect(updateContact).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Reply message')).toHaveValue('A first proactive text');
  });

  it('a normal successful send does NOT open the consent modal', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TIMELINE);
    sendMessage.mockResolvedValue({
      conversationId: 'conv-k1',
      providerSid: 'SM2',
      tsMsgId: '2026-06-03T10:00:00.000Z#SM2',
      status: 'sent',
    });

    renderPane({ contact: TENANT });
    await screen.findByText('Hi');
    await typeAndSend(user, 'A consented reply');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('dialog', { name: /Record consent before texting/i }),
    ).not.toBeInTheDocument();
    expect(updateContact).not.toHaveBeenCalled();
  });
});

describe('ContactCommsPane - deleted contact', () => {
  const DELETED: Contact = { ...TENANT, deleted_at: '2026-06-19T00:00:00.000Z' };

  it('locks the composer (no Send, no reply box) and renders the note WITHOUT a button when onRestore is absent', async () => {
    getContactTimeline.mockResolvedValue(TIMELINE);
    renderPane({ contact: DELETED });

    expect(await screen.findByText(/restore them to reply/i)).toBeInTheDocument();
    // canSend is false and the whole composer is replaced - the observable
    // consequence is that there is nothing to send with.
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull();
    // Tour/placement tabs pass no onRestore: no dead button.
    expect(screen.queryByRole('button', { name: 'Restore contact' })).toBeNull();
  });

  it('renders the note WITH a Restore button when onRestore is provided (the contact page)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onRestore = vi.fn();
    getContactTimeline.mockResolvedValue(TIMELINE);
    renderPane({ contact: DELETED, onRestore });

    await user.click(await screen.findByRole('button', { name: 'Restore contact' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});

describe('ContactCommsPane - local contact override', () => {
  it('drops its override when the caller hands it a NEW contact (send gates stay fresh)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getContactTimeline.mockResolvedValue(TIMELINE);
    sendMessage.mockRejectedValueOnce(
      new ApiError(409, 'contact_no_consent', 'contact_no_consent'),
    );
    updateContact.mockResolvedValue({ ...TENANT, consent_method: 'verbal_phone' });

    const { rerender } = renderPane({ contact: TENANT });
    await screen.findByText('Hi');
    await typeAndSend(user, 'Property that fits your voucher');
    const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
    await user.selectOptions(within(dialog).getByLabelText(/How did they consent/i), 'verbal_phone');
    await user.click(within(dialog).getByRole('button', { name: /Record consent & send/i }));
    // The pane now holds a LOCAL override (the consented contact).
    await waitFor(() => expect(updateContact).toHaveBeenCalled());

    // The page then applies an unrelated update - here an opt-out. If the pane
    // kept shadowing with its override, the send gate would go stale.
    rerender(
      <MemoryRouter>
        <PaneHarness contact={{ ...TENANT, sms_opt_out: true }} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Do-Not-Contact list/i)).toBeInTheDocument(),
    );
  });
});
