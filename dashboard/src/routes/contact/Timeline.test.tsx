import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import { ApiError } from '../../api/index.js';
import type { TimelineItem, TimelineScheduled } from '../../api/index.js';

function renderTimeline(props: Partial<React.ComponentProps<typeof Timeline>> = {}) {
  const items: TimelineItem[] = props.items ?? [];
  return render(
    <MemoryRouter>
      <Timeline
        status="ready"
        items={items}
        source="server"
        replyToPhone="+14705550148"
        replyToLabel="most recent"
        canSend={false}
        onSend={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

const MESSAGE_IN: TimelineItem = {
  kind: 'message',
  id: 'm1',
  at: '2026-06-08T09:14:00',
  conversationId: 'c1',
  tsMsgId: 'm1',
  direction: 'inbound',
  author: 'tenant',
  type: 'sms',
  delivery_status: 'delivered',
  body: 'Hi, looking for a 2 bedroom.',
  fromPhone: '+14040100007',
};

const MESSAGE_OUT: TimelineItem = {
  kind: 'message',
  id: 'm2',
  at: '2026-06-08T09:20:00',
  conversationId: 'c1',
  tsMsgId: 'm2',
  direction: 'outbound',
  author: 'teammate',
  type: 'sms',
  delivery_status: 'sent',
  body: 'Welcome! I will send options.',
  toPhone: '+14040100007',
};

const CALL: TimelineItem = {
  kind: 'call',
  id: 'call1',
  at: '2026-06-08T11:00:00',
  call_outcome: 'answered',
  call_duration: 252,
  transcript: 'Operator: hello. Tenant: hi there.',
};

const MILESTONE: TimelineItem = {
  kind: 'milestone',
  id: 'ms1',
  at: '2026-06-08T08:00:00',
  type: 'placement_opened',
  label: 'Placement opened - 1450 Joseph Blvd',
  refType: 'placement',
  refId: 'k1',
};

const NUMBER_ADDED: TimelineItem = {
  kind: 'milestone',
  id: 'ms2',
  at: '2026-06-10T13:00:00',
  type: 'number_added',
  label: 'Now also texting from (470) 555-0148',
};

describe('Timeline', () => {
  it('renders message bubbles with full body + SMS meta line', () => {
    renderTimeline({ items: [MESSAGE_IN, MESSAGE_OUT] });
    expect(screen.getByText('Hi, looking for a 2 bedroom.')).toBeInTheDocument();
    expect(screen.getByText('Welcome! I will send options.')).toBeInTheDocument();
    // The meta line carries transport - number - time.
    expect(screen.getByText(/SMS - \(404\) 010-0007 - 9:14a/)).toBeInTheDocument();
  });

  it('renders a cluster label (day - time) for the first message', () => {
    renderTimeline({ items: [MESSAGE_IN] });
    expect(screen.getByText(/Mon Jun 8 - 9:14a/)).toBeInTheDocument();
  });

  it('starts a new cluster with a time-only label after a >1h same-day gap', () => {
    const later: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-late',
      tsMsgId: 'm-late',
      at: '2026-06-08T13:30:00', // same day as MESSAGE_IN (9:14a), >1h later
      body: 'later message',
    };
    renderTimeline({ items: [MESSAGE_IN, later] });
    expect(screen.getByText(/Mon Jun 8 - 9:14a/)).toBeInTheDocument(); // first cluster: day - time
    expect(screen.getByText('1:30p')).toBeInTheDocument(); // second cluster: time only
  });

  it('renders a collapsed call card whose transcript expands on click', () => {
    renderTimeline({ items: [CALL] });
    expect(screen.getByText(/Answered/)).toBeInTheDocument();
    expect(screen.getByText(/4m 12s/)).toBeInTheDocument();
    // Transcript is hidden until the disclosure is opened.
    const disclosure = screen.getByText(/Transcript/);
    expect(screen.queryByText(/Operator: hello/)).not.toBeVisible();
    fireEvent.click(disclosure);
    expect(screen.getByText(/Operator: hello/)).toBeVisible();
  });

  it('renders a milestone pin that links out via refType/refId', () => {
    renderTimeline({ items: [MILESTONE] });
    const link = screen.getByRole('link', { name: /Placement opened/ });
    expect(link).toHaveAttribute('href', '/placements/k1');
  });

  it("deep-links a 'tour' refType milestone to the tour detail page", () => {
    const tourMilestone: TimelineItem = {
      kind: 'milestone',
      id: 'ms-tour',
      at: '2026-06-08T08:00:00',
      type: 'tour_took_place',
      label: 'Tour took place - Toured',
      refType: 'tour',
      refId: 'tour-55',
    };
    renderTimeline({ items: [tourMilestone] });
    const link = screen.getByRole('link', { name: /Tour took place/ });
    expect(link).toHaveAttribute('href', '/tours/tour-55');
  });

  it('hides milestones when "Comms only" is toggled', () => {
    renderTimeline({ items: [MESSAGE_IN, MILESTONE, NUMBER_ADDED] });
    expect(screen.getByText(/Placement opened/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Comms only/i }));
    expect(screen.queryByText(/Placement opened/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Now also texting/)).not.toBeInTheDocument();
    // Messages survive the toggle.
    expect(screen.getByText('Hi, looking for a 2 bedroom.')).toBeInTheDocument();
  });

  it('disables Send (with a tooltip) when no conversation is resolvable', () => {
    renderTimeline({ items: [MESSAGE_IN], canSend: false });
    const send = screen.getByRole('button', { name: /Send/i });
    expect(send).toBeDisabled();
  });

  it('sends the typed reply and clears the draft on success', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(onSend).toHaveBeenCalledWith('On my way');
    // Draft is cleared ONLY after the send resolves.
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('sends on Enter (desktop) and clears the draft', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'On my way' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('On my way');
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('does NOT send on Shift+Enter (newline) — draft is preserved', () => {
    const onSend = vi.fn();
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('line one');
  });

  it('does NOT send on Enter mid-IME-composition (isComposing)', () => {
    const onSend = vi.fn();
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'こんにち' } });
    // A composing Enter (the keyCode-229 / soft-keyboard path) must not send.
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does NOT send on Enter on a touch device (coarse pointer) — newline + UI Send instead', () => {
    const onSend = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true })); // coarse pointer
    try {
      renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
      const box = screen.getByRole('textbox', { name: /reply/i });
      fireEvent.change(box, { target: { value: 'On my way' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
      expect(box).toHaveValue('On my way');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the draft and surfaces an error when the send fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network'));
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'Important reply' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    // Failure is surfaced (role=alert) and the draft is NOT lost.
    await screen.findByRole('alert');
    expect(box).toHaveValue('Important reply');
  });

  it('surfaces a clear Do-Not-Contact reason when the send is refused (opt-out)', async () => {
    const onSend = vi.fn().mockRejectedValue(new ApiError(409, 'contact_opted_out', 'contact_opted_out'));
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'Hello?' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    const alert = await screen.findByRole('alert');
    // The specific reason, NOT the generic "please try again".
    expect(alert).toHaveTextContent(/Do-Not-Contact/i);
    expect(alert).not.toHaveTextContent(/please try again/i);
    expect(box).toHaveValue('Hello?'); // draft preserved
  });

  it('surfaces the rate-limited reason when the send 429s (rate_limited)', async () => {
    const onSend = vi.fn().mockRejectedValue(new ApiError(429, 'rate_limited', 'rate_limited'));
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'Rapid fire' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sending too fast — wait a moment and try again.');
    expect(box).toHaveValue('Rapid fire'); // draft preserved
    // The busy flag reset — Send is back (not stuck on "Sending…") and enabled.
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('shows a standing Do-Not-Contact note at the composer when the contact is opted out', () => {
    renderTimeline({ items: [MESSAGE_IN], optedOut: true });
    expect(screen.getByRole('note')).toHaveTextContent(/Do-Not-Contact/i);
  });

  it('shows the reply target number + label', () => {
    renderTimeline({ items: [] });
    expect(screen.getByText(/Reply sends to/)).toBeInTheDocument();
    expect(screen.getByText(/\(470\) 555-0148/)).toBeInTheDocument();
    expect(screen.getByText(/most recent/)).toBeInTheDocument();
  });

  it('shows a loading state and an empty state', () => {
    const { rerender } = renderTimeline({ status: 'loading' });
    expect(screen.getByRole('status')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[]}
          source="fallback"
          replyToPhone="+14705550148"
          replyToLabel="most recent"
          canSend={false}
          onSend={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No messages yet/i)).toBeInTheDocument();
  });

  it('renders an MMS image inline and a PDF as a viewer link via the authed endpoint', () => {
    const mms: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'mms1',
      tsMsgId: '2026-06-08T09:20:00#SM123', // <provider_ts>#<sid>
      type: 'mms',
      body: 'see attached',
      media_attachments: [
        { s3Key: 'k0', contentType: 'image/jpeg' },
        { s3Key: 'k1', contentType: 'application/pdf' },
      ],
    };
    renderTimeline({ items: [mms] });
    // Image → inline <img> pointing at the authed same-origin endpoint.
    const img = screen.getByRole('img', { name: /Attachment 1/i });
    expect(img).toHaveAttribute('src', '/api/messages/SM123/media/0');
    // PDF → a viewer link (new tab), not an <img>.
    const pdf = screen.getByRole('link', { name: /PDF attachment 2/i });
    expect(pdf).toHaveAttribute('href', '/api/messages/SM123/media/1');
    expect(pdf).toHaveAttribute('target', '_blank');
  });

  it('falls back to a count chip when no provider sid can be derived', () => {
    const mms: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'mms2',
      tsMsgId: 'nosid', // no "#" → no derivable sid
      type: 'mms',
      media_attachments: [{ s3Key: 'k', contentType: 'image/png' }],
    };
    renderTimeline({ items: [mms] });
    expect(screen.getByText(/1 attachment/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the delivery status on an OUTBOUND bubble', () => {
    renderTimeline({ items: [MESSAGE_OUT] }); // delivery_status: 'sent'
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  it('shows NO delivery status on an inbound bubble (delivery state is outbound-only)', () => {
    renderTimeline({ items: [MESSAGE_IN] }); // inbound, even though it carries a status
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('shows Failed + reason + Retry on a failed outbound message, and retries on click', () => {
    const failed: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail',
      tsMsgId: 'm-fail',
      delivery_status: 'failed',
      error_code: '30007',
      body: 'This one failed',
    };
    const onRetry = vi.fn();
    renderTimeline({ items: [failed], onRetry });
    expect(screen.getByText(/Failed - Carrier filtered the message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry sending/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rate-limited RETRY in the composer error slot (retry shares the manual-send budget)', async () => {
    const failed: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail',
      tsMsgId: 'm-fail',
      delivery_status: 'failed',
      error_code: '30007',
      body: 'This one failed',
    };
    const onRetry = vi.fn().mockRejectedValue(new ApiError(429, 'rate_limited', 'rate_limited'));
    renderTimeline({ items: [failed], onRetry });
    fireEvent.click(screen.getByRole('button', { name: /Retry sending/i }));
    // The rejection is NOT swallowed — it lands in the same error slot as a send.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sending too fast — wait a moment and try again.');
  });

  it('hides a failed message that a delivered retry superseded (retry_of), keeping only the retry', () => {
    const failed: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail',
      tsMsgId: 'm-fail',
      at: '2026-06-08T09:20:00',
      delivery_status: 'failed',
      error_code: '30007',
      body: 'Retry me',
    };
    const retry: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-retry',
      tsMsgId: 'm-retry',
      at: '2026-06-08T09:25:00',
      delivery_status: 'delivered',
      retry_of: 'm-fail',
      body: 'Retry me',
    };
    const onRetry = vi.fn();
    renderTimeline({ items: [failed, retry], onRetry });

    // The stale failed bubble + its Retry are gone; the delivered retry remains.
    expect(screen.queryByText('Failed - Carrier filtered the message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry sending/i })).not.toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    // The body text appears exactly once (one surviving bubble, not two).
    expect(screen.getAllByText('Retry me')).toHaveLength(1);
  });

  it('keeps a retry that ALSO failed clickable (the tail of the chain still shows Retry)', () => {
    const first: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail-1',
      tsMsgId: 'm-fail-1',
      at: '2026-06-08T09:20:00',
      delivery_status: 'failed',
      error_code: '30007',
      body: 'Still failing',
    };
    const secondFail: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail-2',
      tsMsgId: 'm-fail-2',
      at: '2026-06-08T09:25:00',
      delivery_status: 'failed',
      error_code: '30007',
      retry_of: 'm-fail-1',
      body: 'Still failing',
    };
    renderTimeline({ items: [first, secondFail], onRetry: vi.fn() });

    // Only the LATEST attempt is shown, and it's still retryable.
    expect(screen.getAllByText('Still failing')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Retry sending/i })).toBeInTheDocument();
  });

  it('renders the relay opted-out note when a message has a contact_opted_out recipient', () => {
    const relaySource: TimelineItem = {
      ...MESSAGE_IN,
      id: 'm-relay',
      tsMsgId: 'm-relay',
      body: 'is the unit available?',
      // Two OTHER members: one opted out (skipped), one delivered.
      delivery_recipients: {
        'c-bob': { status: 'failed', errorCode: 'contact_opted_out' },
        'c-carol': { status: 'delivered' },
      },
    };
    renderTimeline({ items: [relaySource] });
    // Real text (not color-only), singular phrasing for one member.
    expect(screen.getByText(/1 member opted out — not relayed to them\./)).toBeInTheDocument();
  });

  it('pluralizes the relay opted-out note for multiple opted-out members', () => {
    const relaySource: TimelineItem = {
      ...MESSAGE_IN,
      id: 'm-relay2',
      tsMsgId: 'm-relay2',
      body: 'open house Saturday',
      delivery_recipients: {
        'c-bob': { status: 'failed', errorCode: 'contact_opted_out' },
        'c-dave': { status: 'failed', errorCode: 'contact_opted_out' },
        'c-carol': { status: 'sent' },
      },
    };
    renderTimeline({ items: [relaySource] });
    expect(screen.getByText(/2 members opted out — not relayed to them\./)).toBeInTheDocument();
  });

  it('renders NO opted-out note when a relay message has no contact_opted_out recipient', () => {
    const relaySource: TimelineItem = {
      ...MESSAGE_IN,
      id: 'm-relay3',
      tsMsgId: 'm-relay3',
      body: 'all good',
      // A non-opt-out failure (carrier) must NOT trigger the opted-out note.
      delivery_recipients: {
        'c-bob': { status: 'failed', errorCode: '30007' },
        'c-carol': { status: 'delivered' },
      },
    };
    renderTimeline({ items: [relaySource] });
    expect(screen.queryByText(/opted out — not relayed/)).not.toBeInTheDocument();
  });

  it('shows no status chip (and no Retry) when delivery_status is absent — seed/legacy rows', () => {
    const noStatus = {
      ...MESSAGE_OUT,
      id: 'm-nostatus',
      tsMsgId: 'm-nostatus',
      body: 'legacy row',
      delivery_status: undefined,
    } as unknown as TimelineItem;
    renderTimeline({ items: [noStatus] });
    expect(screen.getByText('legacy row')).toBeInTheDocument();
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('renders a contact_status_changed milestone pin with its label', () => {
    renderTimeline({ items: [
      { kind: 'milestone', id: 'evt-1', at: '2026-07-03T10:00:00.000Z',
        type: 'contact_status_changed', label: 'Status → Active' },
    ] });
    expect(screen.getByText('Status → Active')).toBeInTheDocument();
  });

  it('renders a tour_canceled milestone pin as a tour deep-link', () => {
    renderTimeline({ items: [
      { kind: 'milestone', id: 'evt-2', at: '2026-07-03T10:00:00.000Z',
        type: 'tour_canceled', label: 'Tour canceled', refType: 'tour', refId: 't-9' },
    ] });
    const link = screen.getByRole('link', { name: /Tour canceled/ });
    expect(link).toHaveAttribute('href', '/tours/t-9');
  });

  // --- Pinned "Upcoming" scheduled-messages section ------------------------
  const SCHEDULED: TimelineScheduled = {
    kind: 'scheduled',
    id: 'sched-1',
    at: '2999-01-01T10:00:00Z', // always future so it never reads "sending shortly"
    conversationId: 'c1',
    source: 'tour_reminder',
    reminderKind: 'day_before',
    body: 'Reminder: your tour is tomorrow.',
    refType: 'tour',
    refId: 'tour-9',
  };

  it('renders the pinned "Upcoming (N)" section when upcoming is non-empty', () => {
    renderTimeline({ items: [MESSAGE_IN], upcoming: [SCHEDULED] });
    const section = screen.getByRole('region', { name: 'Upcoming scheduled messages' });
    expect(section).toBeInTheDocument();
    expect(screen.getByText('Upcoming (1)')).toBeInTheDocument();
    // The scheduled item's body renders inside the section.
    expect(screen.getByText('Reminder: your tour is tomorrow.')).toBeInTheDocument();
  });

  it('does NOT render the Upcoming section when upcoming is empty or absent', () => {
    const { rerender } = renderTimeline({ items: [MESSAGE_IN], upcoming: [] });
    expect(
      screen.queryByRole('region', { name: 'Upcoming scheduled messages' }),
    ).not.toBeInTheDocument();
    // Absent (undefined) prop path — same result.
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[MESSAGE_IN]}
          source="server"
          canSend={false}
          onSend={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole('region', { name: 'Upcoming scheduled messages' }),
    ).not.toBeInTheDocument();
  });
});

describe('Timeline relay-group annotations', () => {
  const ROSTER = [
    { contactId: 'c1', phone: '+14045550111', name: 'Keisha Kane' },
    { contactId: 'c2', phone: '+14045550112', name: 'Lars Landlord' },
  ];

  const RELAY_OUT: TimelineItem = {
    kind: 'message',
    id: 'r1',
    at: '2026-06-08T09:20:00',
    conversationId: 'g1',
    tsMsgId: 'r1',
    direction: 'outbound',
    author: 'teammate',
    type: 'sms',
    delivery_status: 'sent',
    body: 'Team reply to the group',
    relay_sender_key: 'team',
    delivery_recipients: {
      c1: { status: 'delivered' },
      c2: { status: 'sent' },
    },
  };

  it('shows a "delivered N/M" summary on an outbound relay bubble', () => {
    renderTimeline({ items: [RELAY_OUT], relayRoster: ROSTER });
    expect(screen.getByText('delivered 1/2')).toBeInTheDocument();
    // Team attribution.
    expect(screen.getByText('Team')).toBeInTheDocument();
  });

  it('attributes an inbound relay bubble to the sending member', () => {
    const inbound: TimelineItem = {
      kind: 'message',
      id: 'r2',
      at: '2026-06-08T09:25:00',
      conversationId: 'g1',
      tsMsgId: 'r2',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      delivery_status: 'delivered',
      body: 'Thanks!',
      relay_sender_key: 'c1',
    };
    renderTimeline({ items: [inbound], relayRoster: ROSTER });
    expect(screen.getByText('Keisha Kane')).toBeInTheDocument();
  });

  it('leaves a 1:1 bubble unchanged (no delivered summary, no attribution)', () => {
    renderTimeline({ items: [MESSAGE_OUT] });
    expect(screen.queryByText(/^delivered \d+\/\d+$/)).not.toBeInTheDocument();
  });
});

describe('Timeline stick-to-bottom', () => {
  // jsdom does no layout, so drive the scroll geometry ourselves: mock
  // scrollHeight/clientHeight and back scrollTop with a real read/write value.
  function setProp(el: HTMLElement, name: string, value: number): void {
    Object.defineProperty(el, name, { configurable: true, value });
  }
  function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight = 100): void {
    setProp(el, 'clientHeight', clientHeight);
    setProp(el, 'scrollHeight', scrollHeight);
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }
  const wrap = (items: TimelineItem[], key = 'c1'): React.JSX.Element => (
    <MemoryRouter>
      <Timeline
        status="ready"
        items={items}
        source="server"
        replyToPhone="+14040100007"
        canSend={false}
        onSend={vi.fn()}
        resetScrollKey={key}
      />
    </MemoryRouter>
  );
  // The scroll container is `.stream`; exclude the `.streamWrap` positioning parent.
  const stream = (): HTMLElement =>
    document.querySelector('[class*="stream"]:not([class*="Wrap"])') as HTMLElement;

  it('pins to the bottom when a new item arrives while the operator is at the bottom', () => {
    const { rerender } = render(wrap([MESSAGE_IN, MESSAGE_OUT]));
    const el = stream();
    makeScrollable(el, 500);
    el.scrollTop = 400; // 500 - 400 - 100 = 0 → at bottom
    fireEvent.scroll(el);

    setProp(el, 'scrollHeight', 700); // a new item grew the content
    rerender(wrap([MESSAGE_IN, MESSAGE_OUT, CALL]));

    expect(el.scrollTop).toBe(700); // re-pinned to the new bottom
  });

  it('does NOT yank to the bottom when the operator has scrolled up to read history', () => {
    const { rerender } = render(wrap([MESSAGE_IN, MESSAGE_OUT]));
    const el = stream();
    makeScrollable(el, 500);
    el.scrollTop = 40; // 500 - 40 - 100 = 360 → NOT at bottom
    fireEvent.scroll(el);

    setProp(el, 'scrollHeight', 700);
    rerender(wrap([MESSAGE_IN, MESSAGE_OUT, CALL]));

    expect(el.scrollTop).toBe(40); // left exactly where they were reading
  });

  it('shows a "New messages" pill when an item arrives while scrolled up; clicking it jumps down', () => {
    const { rerender } = render(wrap([MESSAGE_IN, MESSAGE_OUT]));
    const el = stream();
    makeScrollable(el, 500);
    el.scrollTop = 40; // scrolled up reading history
    fireEvent.scroll(el);
    expect(screen.queryByRole('button', { name: /jump to the newest/i })).not.toBeInTheDocument();

    setProp(el, 'scrollHeight', 700); // a new item lands below
    rerender(wrap([MESSAGE_IN, MESSAGE_OUT, CALL]));

    const pill = screen.getByRole('button', { name: /jump to the newest/i });
    expect(pill).toBeInTheDocument();

    fireEvent.click(pill);
    expect(el.scrollTop).toBe(700); // jumped to the newest
    expect(screen.queryByRole('button', { name: /jump to the newest/i })).not.toBeInTheDocument();
  });

  it('does NOT show the pill when the new item arrives while already at the bottom', () => {
    const { rerender } = render(wrap([MESSAGE_IN, MESSAGE_OUT]));
    const el = stream();
    makeScrollable(el, 500);
    el.scrollTop = 400; // at bottom
    fireEvent.scroll(el);

    setProp(el, 'scrollHeight', 700);
    rerender(wrap([MESSAGE_IN, MESSAGE_OUT, CALL]));

    expect(screen.queryByRole('button', { name: /jump to the newest/i })).not.toBeInTheDocument();
  });

  it('switching conversations jumps to the bottom with no carried-over pill', () => {
    const { rerender } = render(wrap([MESSAGE_IN, MESSAGE_OUT], 'c1'));
    const el = stream();
    makeScrollable(el, 500);
    el.scrollTop = 40; // scrolled up in conversation c1
    fireEvent.scroll(el);

    setProp(el, 'scrollHeight', 900);
    rerender(wrap([MESSAGE_IN, MESSAGE_OUT, CALL], 'c2')); // a DIFFERENT conversation

    expect(el.scrollTop).toBe(900); // opened on the newest item
    expect(screen.queryByRole('button', { name: /jump to the newest/i })).not.toBeInTheDocument();
  });
});
