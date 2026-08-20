import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline, type TimelinePaging } from './Timeline.js';
import { ApiError } from '../../api/index.js';
import { buildTimelineFallback } from './buildTimelineFallback.js';
import type {
  ConversationSummary,
  Message,
  TimelineCall,
  TimelineItem,
  TimelineScheduled,
} from '../../api/index.js';

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
  direction: 'inbound',
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

  it('renders "Transcribing..." while a transcript is pending (no collapsible)', () => {
    renderTimeline({
      items: [
        {
          kind: 'call',
          id: 'call1',
          at: '2026-06-08T11:00:00',
          direction: 'inbound',
          call_outcome: 'missed',
          transcript_status: 'pending',
        },
      ],
    });
    expect(screen.getByText('Transcribing...')).toBeInTheDocument();
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument(); // no collapsible yet
  });

  it('renders "Transcript unavailable" when the transcript failed', () => {
    renderTimeline({
      items: [
        {
          kind: 'call',
          id: 'call1',
          at: '2026-06-08T11:00:00',
          direction: 'inbound',
          call_outcome: 'answered',
          transcript_status: 'failed',
        },
      ],
    });
    expect(screen.getByText('Transcript unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
  });

  it('renders a Voicemail call card with an audio player pointed at the recording endpoint (bare CallSid)', () => {
    renderTimeline({
      items: [
        {
          kind: 'call',
          id: 'ts#CA1', // the composite tsMsgId - NOT what the player should use
          at: '2026-06-08T11:00:00',
          direction: 'inbound',
          call_outcome: 'voicemail',
          recording_s3_key: 'recordings/CA1/RE1',
          call_sid: 'CA1',
          transcript_status: 'completed',
          transcript: 'Please call me back.',
        },
      ],
    });
    expect(screen.getByText(/Voicemail/)).toBeInTheDocument();
    const player = screen.getByLabelText('Call recording');
    // The player targets the BARE CallSid (call_sid), NOT the composite id.
    expect(player).toHaveAttribute('src', '/api/calls/CA1/recording');
  });

  it('renders NO audio player when call_sid is absent (the recording endpoint would 404)', () => {
    renderTimeline({
      items: [
        {
          kind: 'call',
          id: 'ts#CA1',
          at: '2026-06-08T11:00:00',
          direction: 'inbound',
          call_outcome: 'voicemail',
          recording_s3_key: 'recordings/CA1/RE1',
        },
      ],
    });
    expect(screen.queryByLabelText('Call recording')).not.toBeInTheDocument();
  });

  it('downmixes recording playback to MONO on first play (dual-channel earbud fix)', () => {
    // Bridge recordings are dual-channel (caller L, staff R) for transcript
    // attribution; playback must fold both into every output so a one-earbud
    // listener still hears BOTH parties.
    const gain = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
      connect: vi.fn(),
    };
    const source = { connect: vi.fn() };
    const ctx = {
      destination: { kind: 'destination' },
      createMediaElementSource: vi.fn(() => source),
      createGain: vi.fn(() => gain),
      resume: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    vi.stubGlobal('AudioContext', vi.fn(() => ctx));
    try {
      renderTimeline({
        items: [
          {
            kind: 'call',
            id: 'ts#CA1',
            at: '2026-06-08T11:00:00',
            direction: 'inbound',
            call_outcome: 'answered',
            recording_s3_key: 'recordings/CA1/RE1',
            call_sid: 'CA1',
          },
        ],
      });
      const player = screen.getByLabelText('Call recording');
      fireEvent.play(player);
      // The graph: element source -> mono gain -> destination.
      expect(ctx.createMediaElementSource).toHaveBeenCalledWith(player);
      expect(gain.channelCount).toBe(1);
      expect(gain.channelCountMode).toBe('explicit');
      expect(source.connect).toHaveBeenCalledWith(gain);
      expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
      // Wired exactly once - a second play must not rebuild the graph.
      fireEvent.play(player);
      expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('plays normally when Web Audio is unavailable (no crash, element untouched)', () => {
    // jsdom has no AudioContext - firing play must not throw; the element just
    // plays directly (stereo) as the degraded path.
    renderTimeline({
      items: [
        {
          kind: 'call',
          id: 'ts#CA2',
          at: '2026-06-08T11:00:00',
          direction: 'inbound',
          call_outcome: 'answered',
          recording_s3_key: 'recordings/CA2/RE2',
          call_sid: 'CA2',
        },
      ],
    });
    const player = screen.getByLabelText('Call recording');
    expect(() => fireEvent.play(player)).not.toThrow();
    expect(player).toHaveAttribute('src', '/api/calls/CA2/recording');
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

  it("renders a tour_group_opened milestone as a purple pin linking to the tour", () => {
    const groupOpened: TimelineItem = {
      kind: 'milestone',
      id: 'ms-group-open',
      at: '2026-06-08T08:00:00',
      type: 'tour_group_opened',
      label: 'Relay group opened',
      refType: 'tour',
      refId: 't1',
    };
    renderTimeline({ items: [groupOpened] });
    const link = screen.getByRole('link', { name: 'Relay group opened' });
    expect(link).toHaveAttribute('href', '/tours/t1');
    // Same purple family as added_to_group_text - a relay-group membership cue.
    expect(link.parentElement?.className).toContain('purple');
  });

  // PIN (not a failing-first lever): tour_converted's variant is deliberately the
  // neutral default and its label is SERVER-owned, so the only compile-time proof
  // is the type union (npm run typecheck). This render pin guards the generic
  // refType 'tour' deep-link and the verbatim label passthrough.
  it("renders a tour_converted milestone as a neutral pin linking to the tour", () => {
    const converted: TimelineItem = {
      kind: 'milestone',
      id: 'ms-converted',
      at: '2026-06-08T09:00:00',
      type: 'tour_converted',
      label: 'Converted to placement',
      refType: 'tour',
      refId: 't1',
    };
    renderTimeline({ items: [converted] });
    const link = screen.getByRole('link', { name: 'Converted to placement' });
    expect(link).toHaveAttribute('href', '/tours/t1');
    expect(link.parentElement?.className).toContain('neutral');
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

  // CONTROLLED "Comms only" (spec A-M2): the tour/placement pages hold ONE toggle
  // state per page visit ABOVE the pane's remount boundary, so the filter has to
  // survive a tab switch. Passing BOTH props hands the value to the caller; the
  // buttons then only REPORT (no internal flip), so what renders is whatever the
  // caller last said.
  it('CONTROLLED "Comms only": renders the caller\'s value and reports clicks without self-flipping', () => {
    const onCommsOnlyChange = vi.fn();
    renderTimeline({
      items: [MESSAGE_IN, MILESTONE, NUMBER_ADDED],
      commsOnly: true,
      onCommsOnlyChange,
    });
    // Filtered on the FIRST render - no click needed. This is the state a remount
    // must be able to restore.
    expect(screen.queryByText(/Placement opened/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Now also texting/)).not.toBeInTheDocument();
    expect(screen.getByText('Hi, looking for a 2 bedroom.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comms only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onCommsOnlyChange).toHaveBeenCalledWith(false);
    // Nothing came back: the caller owns the value, so the pins stay hidden until
    // it re-renders us with commsOnly={false}.
    expect(screen.queryByText(/Placement opened/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comms only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('CONTROLLED "Comms only": clicking the filter reports true and hides nothing itself', () => {
    const onCommsOnlyChange = vi.fn();
    renderTimeline({ items: [MESSAGE_IN, MILESTONE], commsOnly: false, onCommsOnlyChange });
    expect(screen.getByText(/Placement opened/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Comms only' }));
    expect(onCommsOnlyChange).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Placement opened/)).toBeInTheDocument();
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

  it('a relay GROUP names the whole roster in the composer footer (never a single target)', () => {
    // A reply relays to EVERY member — the footer must say who it reaches. A
    // member without a resolved name falls back to their formatted number.
    renderTimeline({
      items: [],
      relayRoster: [
        { contactId: 't1', phone: '+14045550111', name: 'Ann' },
        { contactId: 'l1', phone: '+14045550122' },
      ],
    });
    const foot = screen.getByText(/Reply sends to/);
    expect(foot).toHaveTextContent(
      'Reply sends to everyone in this relay group (Ann, (404) 555-0122)',
    );
    // The single-target copy (incl. the replyToPhone prop the helper passes) is gone.
    expect(foot).not.toHaveTextContent(/\(470\) 555-0148/);
    expect(foot).not.toHaveTextContent('this contact');
  });

  it('a relay GROUP with an unloaded roster keeps the honest "everyone" line, no list', () => {
    renderTimeline({ items: [], relayRoster: [] });
    expect(screen.getByText(/Reply sends to/)).toHaveTextContent(
      'Reply sends to everyone in this relay group',
    );
    expect(screen.getByText(/Reply sends to/)).not.toHaveTextContent('(');
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
    // A JUST-sent message still reads "Sent" - it may yet be confirmed.
    renderTimeline({ items: [{ ...MESSAGE_OUT, at: new Date().toISOString() }] });
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  it('a `sent` bubble that has gone quiet stops implying it was delivered', () => {
    // MESSAGE_OUT is dated 2026-06-08 and still sits at `sent`. A carrier that
    // discards a message returns no receipt and no error code, so the age of the
    // row is the only signal there is - "Sent" would read as "it arrived".
    renderTimeline({ items: [MESSAGE_OUT] });
    expect(screen.getByText(/Sent - not confirmed/)).toBeInTheDocument();
  });

  it('an IMPORTED message reads a plain "Sent" no matter how old it is', () => {
    // Pre-go-live history carried in from the Quo/Airtable export. The importer
    // writes `sent` because the export has no per-message receipts - there was
    // never a receipt to miss, so the unconfirmed cue would flag every historical
    // message in the thread as a possible drop.
    renderTimeline({ items: [{ ...MESSAGE_OUT, imported: true }] });
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
  });

  it('still flags an imported row that genuinely failed', () => {
    // `imported` suppresses only the age-derived cue. A stored terminal status is
    // the source's own fact and keeps rendering.
    renderTimeline({
      items: [{ ...MESSAGE_OUT, imported: true, delivery_status: 'failed', error_code: '30007' }],
    });
    expect(screen.getByText(/Failed - Carrier filtered the message/)).toBeInTheDocument();
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

  // A27(a) / adversarial 22. On a NATIVE group text nothing is relayed - the
  // thread already exists on everyone's handset and we post into it. Twilio
  // SKIPS a suppressed participant outright (app/src/services/groupDelivery.ts),
  // so "not relayed to them" both invents a mechanism and contradicts the
  // suppression banner rendered directly above the same conversation
  // (GroupTextView.tsx). Relay bubbles keep their copy: relay really does relay.
  it('frames the opted-out note for a GROUP TEXT as a skipped participant, never as a relay', () => {
    const groupSource: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-group-optout',
      tsMsgId: 'm-group-optout',
      body: 'heading over now',
      delivery_recipients: {
        'phone#+14045550111': { status: 'undelivered', errorCode: 'contact_opted_out' },
        'phone#+14045550112': { status: 'delivered' },
      },
    };
    renderTimeline({ items: [groupSource], rosterKind: 'group_text' });
    expect(screen.queryByText(/not relayed to them/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 member opted out/)).toHaveTextContent(/Twilio skips them/);
  });

  it('pluralizes the group-text opted-out note', () => {
    const groupSource: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-group-optout2',
      tsMsgId: 'm-group-optout2',
      body: 'open house Saturday',
      delivery_recipients: {
        'phone#+14045550111': { status: 'undelivered', errorCode: 'contact_opted_out' },
        'phone#+14045550113': { status: 'undelivered', errorCode: 'contact_opted_out' },
        'phone#+14045550112': { status: 'delivered' },
      },
    };
    renderTimeline({ items: [groupSource], rosterKind: 'group_text' });
    expect(screen.getByText(/2 members opted out/)).toHaveTextContent(/Twilio skips them/);
    expect(screen.queryByText(/not relayed to them/)).not.toBeInTheDocument();
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

describe('Timeline initialDraft seed (manual no-show check-in prefill)', () => {
  const SEED = 'Hi! We noticed you may have missed your tour. Want to reschedule?';

  it('seeds the composer from initialDraft and fires onDraftSeeded exactly once', () => {
    const onDraftSeeded = vi.fn();
    renderTimeline({ initialDraft: SEED, onDraftSeeded });
    const box = screen.getByRole('textbox', { name: 'Reply message' });
    expect(box).toHaveValue(SEED);
    expect(onDraftSeeded).toHaveBeenCalledTimes(1);
  });

  it('does not seed the composer or fire onDraftSeeded when initialDraft is absent', () => {
    const onDraftSeeded = vi.fn();
    renderTimeline({ onDraftSeeded });
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');
    expect(onDraftSeeded).not.toHaveBeenCalled();
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

  it('labels a system announcement (group intro / tour reminder rung) "Automated" with its rollup', () => {
    const SYSTEM_OUT: TimelineItem = {
      ...RELAY_OUT,
      id: 'r2',
      tsMsgId: 'r2',
      author: 'system',
      body: 'Reminder: your property tour is tomorrow.',
      relay_sender_key: 'system',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [SYSTEM_OUT], relayRoster: ROSTER });
    expect(screen.getByText('Automated')).toBeInTheDocument();
    expect(screen.getByText('Reminder: your property tour is tomorrow.')).toBeInTheDocument();
    // The per-member rollup works for announcements exactly like team sends.
    expect(screen.getByText('Delivered 2/2')).toBeInTheDocument();
  });

  it('suppresses the per-message status chip on a relay source bubble (the rollup is the truth)', () => {
    // A relay SOURCE message's own delivery_status stays at its initial
    // 'queued' forever — DLRs land in delivery_recipients slots, never on the
    // parent (relay-source-message-sending-chip). Rendering it would show a
    // permanent "Sending…" contradicting a fully delivered rollup.
    const fullyDelivered: TimelineItem = {
      ...RELAY_OUT,
      delivery_status: 'queued',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [fullyDelivered], relayRoster: ROSTER });
    expect(screen.getByText('Delivered 2/2')).toBeInTheDocument();
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
  });

  it('finalizes the rollup GREEN ("Delivered N/N") when every leg delivered — same cue as 1:1', () => {
    const fullyDelivered: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [fullyDelivered], relayRoster: ROSTER });
    const chip = screen.getByText('Delivered 2/2');
    expect(chip.className).toMatch(/toneSuccess/);
  });

  it('turns the rollup red and counts failures when a leg hard-fails', () => {
    const oneFailed: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'failed', errorCode: '30005' },
      },
    };
    renderTimeline({ items: [oneFailed], relayRoster: ROSTER });
    // The chip now surfaces the failing code inline so it's debuggable (30005).
    const chip = screen.getByText(/delivered 1\/2 - 1 failed - Number is invalid \(error 30005\)/);
    expect(chip.className).toMatch(/toneDanger/);
    expect(chip).toHaveAttribute('title', expect.stringContaining('error 30005'));
  });

  it('surfaces the A2P-unregistered code (30034) on the rollup - the relay-group bug now shows WHY', () => {
    const bothFailed: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'undelivered', errorCode: '30034' },
        c2: { status: 'undelivered', errorCode: '30034' },
      },
    };
    renderTimeline({ items: [bothFailed], relayRoster: ROSTER });
    const chip = screen.getByText(
      /delivered 0\/2 - 2 failed - Number not registered for A2P 10DLC \(error 30034\)/,
    );
    expect(chip.className).toMatch(/toneDanger/);
  });

  it('keeps the in-flight rollup neutral while legs are still sending', () => {
    // RELAY_OUT: c1 delivered, c2 only sent — not final, not failed.
    renderTimeline({ items: [RELAY_OUT], relayRoster: ROSTER });
    const chip = screen.getByText('delivered 1/2');
    expect(chip.className).toMatch(/toneNeutral/);
  });

  it('renders a "Queued - will send when connected" chip for a queued_pending message', () => {
    // Connect-when-ready (T7): a team compose on a CONNECTING group is held as
    // delivery_status 'queued_pending' with pre-seeded 'queued' member slots. The
    // held state must show its own "Queued" chip - NOT a "delivered 0/2" rollup off
    // those placeholder slots (which would read like a stalled/failed send).
    const queued: TimelineItem = {
      ...RELAY_OUT,
      id: 'rq',
      tsMsgId: 'rq',
      delivery_status: 'queued_pending',
      body: 'Held until the group connects',
      delivery_recipients: {
        c1: { status: 'queued' },
        c2: { status: 'queued' },
      },
    };
    renderTimeline({ items: [queued], relayRoster: ROSTER });
    expect(screen.getByText('Queued - will send when connected')).toBeInTheDocument();
    expect(screen.queryByText('delivered 0/2')).not.toBeInTheDocument();
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

  it('attributes a PHONE-SCOPED sender key to the same member (native group_text convention)', () => {
    // Native group threads key members by phone (spec 15.6) while relay keys
    // them by contactId. ONE shared resolver serves both - this bubble proves
    // the phone-scoped form resolves through the very same Timeline path.
    const inbound: TimelineItem = {
      kind: 'message',
      id: 'gt1',
      at: '2026-06-08T09:26:00',
      conversationId: 'gt-1',
      tsMsgId: 'gt1',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      delivery_status: 'delivered',
      body: 'On my way',
      relay_sender_key: 'phone#+14045550112',
    };
    renderTimeline({ items: [inbound], relayRoster: ROSTER });
    expect(screen.getByText('Lars Landlord')).toBeInTheDocument();
  });

  it('leaves a 1:1 bubble unchanged (no delivered summary, no attribution)', () => {
    renderTimeline({ items: [MESSAGE_OUT] });
    expect(screen.queryByText(/^delivered \d+\/\d+$/)).not.toBeInTheDocument();
  });

  // INVARIANT 6, pinned. The group_text fix (L6) gives a NAMELESS member a
  // formatted-number sender chip. Relay must keep rendering exactly what it
  // rendered before: nothing. `rosterKind` defaults to 'relay', and this is the
  // test that fails if that default is ever widened.
  const NAMELESS_INBOUND: TimelineItem = {
    kind: 'message',
    id: 'r-nameless',
    at: '2026-06-08T09:27:00',
    conversationId: 'g1',
    tsMsgId: 'r-nameless',
    direction: 'inbound',
    author: 'tenant',
    type: 'sms',
    delivery_status: 'delivered',
    body: 'no name on this roster entry',
    relay_sender_key: 'phone#+14045550999',
  };
  const NAMELESS_ROSTER = [{ contactId: 'c9', phone: '+14045550999' }];

  it('RELAY: a nameless member still gets NO attribution line (rendering frozen)', () => {
    renderTimeline({ items: [NAMELESS_INBOUND], relayRoster: NAMELESS_ROSTER });
    expect(screen.getByText('no name on this roster entry')).toBeInTheDocument();
    expect(screen.queryByText('(404) 555-0999')).not.toBeInTheDocument();
  });

  it('GROUP_TEXT: the same bubble and roster DO get the formatted-number chip', () => {
    renderTimeline({
      items: [NAMELESS_INBOUND],
      relayRoster: NAMELESS_ROSTER,
      rosterKind: 'group_text',
    });
    expect(screen.getByText('(404) 555-0999')).toBeInTheDocument();
  });
});

describe('Timeline - closed-group provenance badge (relay number lifecycle)', () => {
  it('renders a "Sent to the closed group chat" link to the closed group', () => {
    const late: TimelineItem = {
      kind: 'message',
      id: 'late1',
      at: '2026-07-10T09:00:00',
      conversationId: 'c-tenant-1to1',
      tsMsgId: 'late1',
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      delivery_status: 'delivered',
      body: 'Are we still on?',
      via_closed_group: 'g-closed-1',
    };
    renderTimeline({ items: [late] });
    const badge = screen.getByRole('link', { name: 'Sent to the closed group chat' });
    expect(badge).toHaveAttribute('href', '/conversations/g-closed-1');
  });

  it('renders no badge on an ordinary 1:1 message (no via_closed_group)', () => {
    renderTimeline({ items: [MESSAGE_IN] });
    expect(screen.queryByRole('link', { name: /closed group chat/i })).not.toBeInTheDocument();
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

describe('Timeline load-older control', () => {
  // Named apart from the module-scope `renderTimeline` / the stick-to-bottom
  // block's `setProp` / `makeScrollable` / `wrap` / `stream` so nothing is
  // shadowed: those helpers live inside a sibling describe and carry different
  // defaults.
  function setNum(el: HTMLElement, name: string, value: number): void {
    Object.defineProperty(el, name, { configurable: true, value });
  }

  /** Back scrollHeight/clientHeight with fixed values and scrollTop with a real
   *  read/write slot, so the layout effect's arithmetic is observable. */
  function stubScroll(el: HTMLElement, scrollHeight: number, clientHeight = 100): void {
    setNum(el, 'scrollHeight', scrollHeight);
    setNum(el, 'clientHeight', clientHeight);
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  /** The SCROLL CONTAINER, excluding the .streamWrap positioning parent. */
  function streamEl(): HTMLElement {
    return document.querySelector('[class*="stream"]:not([class*="Wrap"])') as HTMLElement;
  }

  // Typed as TimelineItem rather than cast through `as`: the plan's fixture used
  // `author: 'contact'`, which is NOT a MessageAuthor, and a cast would hide
  // that from tsc while vitest strips types and runs it green.
  function item(id: string, at: string): TimelineItem {
    return {
      kind: 'message',
      id,
      at,
      conversationId: 'c1',
      tsMsgId: id,
      direction: 'inbound',
      author: 'tenant',
      type: 'sms',
      body: id,
      delivery_status: 'delivered',
    };
  }

  const OLD = item('a', '2026-08-13T09:00:00.000Z');
  const MID = item('b', '2026-08-13T10:00:00.000Z');
  const NEW = item('z', '2026-08-13T11:00:00.000Z');

  /** The paging object, defaulted to "older history exists, nothing in flight".
   *  All four members always travel together - that is the whole point of the
   *  object, so no test may hand-build a partial one. */
  function pagingProps(over: Partial<TimelinePaging> = {}): TimelinePaging {
    return {
      hasOlder: true,
      loadingOlder: false,
      olderPagesLoaded: 0,
      onLoadOlder: vi.fn(),
      ...over,
    };
  }

  function renderPagingTimeline(props: Partial<React.ComponentProps<typeof Timeline>>) {
    return render(
      <MemoryRouter>
        <Timeline status="ready" items={[MID]} source="server" canSend={false} {...props} />
      </MemoryRouter>,
    );
  }

  it('does not render the control when the caller passes no paging object', () => {
    renderPagingTimeline({});
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('does not render the control when there is no older history', () => {
    renderPagingTimeline({ paging: pagingProps({ hasOlder: false }) });
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  // The status gate is a plan decision the spec does not mention, and it was
  // untested in BOTH directions. It is deliberate: a hook that has not loaded
  // reports hasOlder: false anyway, and a loading/error stream has no rendered
  // history to anchor against. The spec's "stays visible when the stream renders
  // empty" case is status === 'ready' with visible.length === 0, which the gate
  // permits.
  it('does not render the control while the timeline is still loading', () => {
    renderPagingTimeline({ status: 'loading', paging: pagingProps() });
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  // Spec 4.5, by name: "It stays visible when the stream renders empty." If
  // "Comms only" hides every entry on the current page, the control is the ONLY
  // way to reach the pages behind it without abandoning the filter. Easy to
  // regress with a visible.length guard on the render gate, which is exactly what
  // this asserts against.
  it('stays visible when the stream renders empty', () => {
    const milestone: TimelineItem = {
      kind: 'milestone',
      id: 'ms1',
      at: '2026-08-13T08:00:00.000Z',
      type: 'placement_opened',
      label: 'Placement opened',
    };
    renderPagingTimeline({ items: [milestone], paging: pagingProps() });
    fireEvent.click(screen.getByRole('button', { name: 'Comms only' }));

    expect(screen.getByText('No messages yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeVisible();
  });

  it('calls onLoadOlder when clicked', () => {
    const onLoadOlder = vi.fn();
    renderPagingTimeline({ paging: pagingProps({ onLoadOlder }) });
    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('disables the control while a page is in flight', () => {
    renderPagingTimeline({ paging: pagingProps({ loadingOlder: true }) });
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  });

  it('holds the scroll anchor when older items prepend', () => {
    const { rerender } = renderPagingTimeline({ paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    // A real scroll event is required: assigning .scrollTop fires none in jsdom,
    // and atBottomRef defaults to TRUE, so without this the unfixed code takes
    // the pin-to-bottom branch and the test cannot go red.
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    setNum(el, 'scrollHeight', 700); // the prepend grew content ABOVE by 200px
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[OLD, MID]}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(el.scrollTop).toBe(200); // the bubble they were reading stayed put
  });

  it('raises no "new messages" pill for a prepend', () => {
    const { rerender } = renderPagingTimeline({ paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[OLD, MID]}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Jump to the newest messages' })).toBeNull();
  });

  it('still raises the pill for an APPEND while scrolled up', () => {
    const { rerender } = renderPagingTimeline({});
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 40;
    fireEvent.scroll(el);

    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline status="ready" items={[MID, NEW]} source="server" canSend={false} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Jump to the newest messages' })).toBeVisible();
  });

  // [R1] The anchor is consumed only when the HOOK reports a merged older page.
  // An SSE append landing while the older page is in flight must not steal it.
  //
  // NOTE the initial render passes loadingOlder={false}: the control is only
  // named "Load older messages" while it is NOT loading, so a test that renders
  // with loadingOlder={true} cannot find or click it.
  it('does not consume the anchor when an append lands mid-flight', () => {
    const { rerender } = renderPagingTimeline({ paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));

    // An inbound message appends BELOW while the older page is still in flight.
    // The counter has NOT moved, so the anchor must survive.
    setNum(el, 'scrollHeight', 600);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[MID, NEW]}
          source="server"
          canSend={false}
          paging={pagingProps({ loadingOlder: true })}
        />
      </MemoryRouter>,
    );
    // The reader must NOT have been scrolled by content that landed below them,
    // and the pill for it must be raised.
    expect(el.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: 'Jump to the newest messages' })).toBeVisible();

    // NOW the older page lands: the counter moves. The anchor was re-baselined to
    // the post-append height, so only the prepended 200px moves the reader.
    setNum(el, 'scrollHeight', 800);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[OLD, MID, NEW]}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );
    expect(el.scrollTop).toBe(200);
  });

  // DEP-ARRAY GUARD. `paging?.olderPagesLoaded` must be in the layout effect's
  // deps: a render where ONLY the counter changed must still consume the anchor.
  // Every other case here also changes `items`, so `clusters` gets a new identity
  // and the effect would re-run from that dep alone - dropping the counter dep
  // leaves all of them green. This one holds the SAME items array reference
  // across both renders, so `visible` and `clusters` keep their identity and the
  // counter is the only thing that can schedule the effect.
  it('consumes the anchor on a render where only the counter changed', () => {
    const held: TimelineItem[] = [MID];
    const { rerender } = renderPagingTimeline({ items: held, paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(el.scrollTop).toBe(200);
  });

  // THE SETTLE EFFECT. It is the ONLY thing that disarms the anchor when a load
  // ends without changing anything - and after the empty-page fix it is the only
  // thing at all on that path, because such a page no longer bumps the counter.
  // A surviving anchor is consumed by a LATER, unrelated render and jumps the
  // reader by content they never asked for.
  //
  // The items array identity is held across every render so `clusters` keeps its
  // identity: the point is a load that changes NOTHING.
  it('disarms the anchor when the older page returns nothing', () => {
    const held: TimelineItem[] = [MID];
    const { rerender } = renderPagingTimeline({ items: held, paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' })); // arms at 500

    // The page is in flight...
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ loadingOlder: true })}
        />
      </MemoryRouter>,
    );
    // ...and comes back EMPTY: no items, no counter bump, the load just settles.
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ loadingOlder: false })}
        />
      </MemoryRouter>,
    );

    // A later render moves the counter with no arming click before it - the
    // stale-anchor case. With the anchor disarmed the reader stays put.
    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(el.scrollTop).toBe(0);
  });

  // The same settle path with the filter engaged, which is the other case the
  // effect's comment names. The toggle re-renders while the page is still in
  // flight, so the anchor is RE-BASELINED to the shrunk height first - and that
  // re-baselined anchor is what has to be disarmed when the load settles with
  // nothing to show for it.
  it('disarms a re-baselined anchor when a filtered load settles with nothing', () => {
    const milestone: TimelineItem = {
      kind: 'milestone',
      id: 'ms1',
      at: '2026-08-13T08:00:00.000Z',
      type: 'placement_opened',
      label: 'Placement opened',
    };
    const held: TimelineItem[] = [milestone, MID];
    const { rerender } = renderPagingTimeline({ items: held, paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' })); // arms at 500

    // "Comms only" hides the milestone while the page is in flight: the anchor is
    // re-baselined to 400 so the eventual delta counts only prepended content.
    setNum(el, 'scrollHeight', 400);
    fireEvent.click(screen.getByRole('button', { name: 'Comms only' }));

    // The page settles having contributed nothing visible.
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ loadingOlder: true })}
        />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ loadingOlder: false })}
        />
      </MemoryRouter>,
    );

    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={held}
          source="server"
          canSend={false}
          paging={pagingProps({ olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(el.scrollTop).toBe(0);
  });

  // The "Comms only" toggle changes the FIRST rendered item with no prepend at
  // all, because Timeline renders the filtered `visible`, not `items`. It must
  // not be mistaken for one.
  it('does not consume the anchor when a filter change alters the first item', () => {
    const milestone: TimelineItem = {
      kind: 'milestone',
      id: 'ms1',
      at: '2026-08-13T08:00:00.000Z',
      type: 'placement_opened',
      label: 'Placement opened',
    };
    renderPagingTimeline({ items: [milestone, MID], paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));

    // ORDER MATTERS. Clicking "Comms only" re-renders from Timeline's own state,
    // so THAT is the layout pass a first-item-keyed rule would consume on. The
    // shrunk height must be in place BEFORE the click, or the delta is 0 and the
    // test passes under a broken rule as happily as a correct one.
    setNum(el, 'scrollHeight', 400);
    fireEvent.click(screen.getByRole('button', { name: 'Comms only' }));

    // Hiding the milestone dropped the first RENDERED item with no page merged.
    // Counter-keyed: untouched. First-item-keyed: 500 -> 400 would have moved it.
    expect(el.scrollTop).toBe(0);
  });
});

// --- Call cards as first-class DIRECTIONAL items ----------------------------
// The card takes a side, says which way the call went, and states only what the
// data supports. The label itself is unit-tested in presentCallState.test.ts;
// what is proved here is the WIRING - direction -> side/arrow/word/tint, the
// snake_case -> camelCase mapping at the call site, the accessible name, the
// click-to-reveal detail line, and the staleness timer.

// The arrows are written as code points, not literal characters, for the same
// reason the component does: every source line in this repo stays ASCII.
const GLYPH_IN = String.fromCodePoint(0x2199);
const GLYPH_OUT = String.fromCodePoint(0x2197);

function callItem(
  partial: Partial<TimelineCall> & Pick<TimelineCall, 'id' | 'direction'>,
): TimelineItem {
  return { kind: 'call', at: '2026-06-08T11:00:00', ...partial };
}

describe('Timeline call cards - direction', () => {
  it('aligns by direction: inbound left, outbound right + the outbound tint', () => {
    renderTimeline({
      items: [
        callItem({ id: 'c-in', direction: 'inbound', call_outcome: 'answered' }),
        callItem({ id: 'c-out', direction: 'outbound', call_outcome: 'answered', at: '2026-06-08T11:05:00' }),
      ],
    });
    const inbound = screen.getByRole('group', { name: /Incoming call/ });
    const outbound = screen.getByRole('group', { name: /Outgoing call/ });

    // Alignment-ONLY classes - never .in/.out, which would repaint the card as a
    // chat bubble. CSS-module class names are hashed under vitest, so match on
    // the readable stem rather than the emitted name.
    expect(inbound.className).toContain('itemIn');
    expect(outbound.className).toContain('itemOut');
    // The outbound tint, the same signal the outbound email card carries.
    expect(outbound.className).toContain('callOut');
    expect(inbound.className).not.toContain('callOut');
  });

  it('renders the direction word and an aria-hidden arrow glyph', () => {
    renderTimeline({
      items: [
        callItem({ id: 'c-in', direction: 'inbound', call_outcome: 'answered' }),
        callItem({ id: 'c-out', direction: 'outbound', call_outcome: 'answered', at: '2026-06-08T11:05:00' }),
      ],
    });
    expect(screen.getByText('Incoming call')).toBeInTheDocument();
    expect(screen.getByText('Outgoing call')).toBeInTheDocument();

    // Decorative only: an unhidden arrow is announced as "north east arrow".
    expect(screen.getByText(GLYPH_IN)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(GLYPH_OUT)).toHaveAttribute('aria-hidden', 'true');
  });

  it('names the card by direction and time ONLY - the outcome stays out of it', () => {
    renderTimeline({
      items: [callItem({ id: 'c-out', direction: 'outbound', call_outcome: 'answered' })],
    });
    const card = screen.getByRole('group', { name: /Outgoing call/ });
    const name = card.getAttribute('aria-label') ?? '';

    expect(name).toContain('Outgoing call');
    // SECONDS, not minutes: minute precision is not unique (see the redial case
    // below), and the VISIBLE clock stays at minutes regardless.
    expect(name).toContain('11:00:00a');
    // The outcome flips with the ringing/in-progress clauses, so an accessible
    // name carrying it would make any handle built on it race the staleness
    // timer. It stays assertable as the chip's own text instead.
    expect(name).not.toContain('Connected');
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('maps the wire fields to the presenter: outbound answered is "Connected", inbound "Answered"', () => {
    renderTimeline({
      items: [
        callItem({ id: 'c-in', direction: 'inbound', call_outcome: 'answered' }),
        callItem({ id: 'c-out', direction: 'outbound', call_outcome: 'answered', at: '2026-06-08T11:05:00' }),
      ],
    });
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders NO chip when nothing is known - the direction and time still render', () => {
    renderTimeline({ items: [callItem({ id: 'c-bare', direction: 'inbound' })] });
    const card = screen.getByRole('group', { name: /Incoming call/ });
    expect(card.querySelector('[class*="outcome"]')).toBeNull();
    expect(screen.getByText('Incoming call')).toBeInTheDocument();
  });

  it('keeps the duration on the card face', () => {
    renderTimeline({
      items: [callItem({ id: 'c-out', direction: 'outbound', call_outcome: 'answered', call_duration: 252 })],
    });
    const card = screen.getByRole('group', { name: /Outgoing call/ });
    expect(card.querySelector('[class*="callDuration"]')?.textContent).toBe('4m 12s');
  });

  it('hides the party number behind a Details BUTTON and reveals it on click', () => {
    renderTimeline({
      items: [
        callItem({
          id: 'c-out',
          direction: 'outbound',
          call_outcome: 'answered',
          party_phone: '+14040100007',
        }),
      ],
    });
    const card = screen.getByRole('group', { name: /Outgoing call/ });
    // A real control, not a click handler on the card surface - and not the card
    // itself as a button, which holds an audio player and a <details>. Its
    // VISIBLE text is "Details"; its accessible name identifies its own card.
    const button = screen.getByRole('button', { name: /^Details for Outgoing call/ });
    expect(button.textContent).toBe('Details');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // jsdom loads no stylesheet here (vitest css:false), so the `display:none`
    // half is not observable - the reveal STATE class on the CARD is what
    // discriminates a working reveal from a dead one, and it is exactly what the
    // card-scoped CSS selector roots on.
    expect(card.className).not.toContain('cardRevealed');

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(card.className).toContain('cardRevealed');
    expect(screen.getByText('to (404) 010-0007 - 11:00a')).toBeVisible();
  });

  it('reveals "from <number>" on an inbound call', () => {
    renderTimeline({
      items: [
        callItem({
          id: 'c-in',
          direction: 'inbound',
          call_outcome: 'answered',
          party_phone: '+14040100007',
        }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /^Details for Incoming call/ }));
    expect(screen.getByText('from (404) 010-0007 - 11:00a')).toBeVisible();
  });

  // A MASKED row carries no counterpart identity at all, and the time is ALREADY
  // on the card face - so a reveal there would disclose a duplicate of what the
  // reader can already see. No control, and no line for it to open.
  it('renders NO reveal control and NO detail line on a MASKED call (no party_phone on the wire)', () => {
    renderTimeline({ items: [callItem({ id: 'c-masked', direction: 'inbound', call_outcome: 'missed' })] });
    const card = screen.getByRole('group', { name: /Incoming call/ });
    expect(screen.queryByRole('button', { name: /^Details for Incoming call/ })).toBeNull();
    expect(card.querySelector('[class*="cardMeta"]')).toBeNull();
    // The time is still on the face, which is the whole reason the reveal is gone.
    expect(card.querySelector('[class*="callAt"]')?.textContent).toBe('11:00a');
  });

  it('still renders the reveal control when there IS a party phone to disclose', () => {
    renderTimeline({
      items: [
        callItem({
          id: 'c-party',
          direction: 'inbound',
          call_outcome: 'missed',
          party_phone: '+14040100007',
        }),
      ],
    });
    const card = screen.getByRole('group', { name: /Incoming call/ });
    expect(screen.getByRole('button', { name: /^Details for Incoming call/ })).toBeInTheDocument();
    expect(card.querySelector('[class*="cardMeta"]')?.textContent).toBe(
      'from (404) 010-0007 - 11:00a',
    );
  });

  // A REDIAL after a miss: two inbound calls inside one minute. At minute
  // precision both cards, and both reveal buttons, carried the same accessible
  // name - ambiguous to a screen-reader user and a Playwright strict-mode
  // violation on the very locator the selectors doc blesses.
  // Both rows carry a party_phone: the reveal control exists ONLY when there is
  // something to disclose, and this case is about the NAMES of those controls.
  it('gives two calls in the SAME minute distinct accessible names (card and reveal button)', () => {
    renderTimeline({
      items: [
        callItem({
          id: 'c-a',
          direction: 'inbound',
          at: '2026-06-08T11:00:07',
          call_outcome: 'missed',
          party_phone: '+14040100007',
        }),
        callItem({
          id: 'c-b',
          direction: 'inbound',
          at: '2026-06-08T11:00:41',
          call_outcome: 'answered',
          party_phone: '+14040100007',
        }),
      ],
    });
    const names = screen
      .getAllByRole('group', { name: /^Incoming call/ })
      .map((el) => el.getAttribute('aria-label'));
    expect(new Set(names)).toEqual(new Set(['Incoming call - 11:00:07a', 'Incoming call - 11:00:41a']));

    const buttonNames = screen
      .getAllByRole('button', { name: /^Details for Incoming call/ })
      .map((el) => el.getAttribute('aria-label'));
    expect(new Set(buttonNames).size).toBe(2);
  });

  // An UNPARSEABLE timestamp is a real handled case on this surface (the
  // presenter has matrix coverage for it). formatTimeWithSeconds answers '' for
  // it, so a bare concatenation produced "Incoming call - " - a dangling
  // separator and, on two such rows, the exact collision the seconds removed.
  // The row id is the fallback.
  it('keeps two UNPARSEABLE-timestamp cards distinctly named, with no dangling separator', () => {
    renderTimeline({
      items: [
        callItem({
          id: 'c-bad-a',
          direction: 'inbound',
          at: 'not-a-date',
          call_outcome: 'missed',
          party_phone: '+14040100007',
        }),
        callItem({
          id: 'c-bad-b',
          direction: 'inbound',
          at: 'also-not-a-date',
          call_outcome: 'answered',
          party_phone: '+14040100007',
        }),
      ],
    });
    const names = screen
      .getAllByRole('group', { name: /^Incoming call/ })
      .map((el) => el.getAttribute('aria-label') ?? '');
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.endsWith('- ')).toBe(false);
      expect(name).not.toBe('Incoming call - ');
    }
    expect(new Set(names)).toEqual(
      new Set(['Incoming call - c-bad-a', 'Incoming call - c-bad-b']),
    );

    // The reveal buttons inherit the same name, so they stay distinct too.
    const buttonNames = screen
      .getAllByRole('button', { name: /^Details for Incoming call/ })
      .map((el) => el.getAttribute('aria-label'));
    expect(new Set(buttonNames).size).toBe(2);
  });
});

describe('Timeline call card - staleness timer', () => {
  const ui = (items: TimelineItem[]) => (
    <MemoryRouter>
      <Timeline status="ready" items={items} source="server" canSend={false} onSend={vi.fn()} />
    </MemoryRouter>
  );
  const ringingAt = (ms: number): TimelineItem => ({
    kind: 'call',
    id: 'c-ring',
    at: new Date(ms).toISOString(),
    direction: 'outbound',
    call_status: 'ringing',
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes the delay from a FRESH clock read at schedule time, not the card clock', () => {
    // Release the global Date pin (src/test/setup.ts) BEFORE enabling fake
    // timers - vitest throws otherwise.
    vi.useRealTimers();
    vi.useFakeTimers();
    const t0 = Date.now();
    const { rerender } = render(ui([ringingAt(t0)]));
    expect(screen.getByText('Ringing...')).toBeInTheDocument();

    // 60s pass with no re-render, so the card's own `now` is still t0. Then a
    // props change moves the call's instant 1s forward, so the expiry becomes
    // t0 + 91s and the effect reschedules.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    rerender(ui([ringingAt(t0 + 1_000)]));

    // A delay taken from the card's stale `now` would be 91s and nothing would
    // fire here; taken from a fresh read it is 31s and the label flips.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByText('No team answer')).toBeInTheDocument();
  });

  it('schedules NOTHING when the expiry is beyond the 32-bit setTimeout ceiling', () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    // An instant 30 days in the FUTURE: still "fresh" by age, but its expiry is
    // ~30 days out. Above the ceiling setTimeout fires IMMEDIATELY rather than
    // late, which is the spin this guard exists to make unrepresentable.
    render(ui([ringingAt(Date.now() + 30 * 24 * 60 * 60 * 1_000)]));
    expect(screen.getByText('Ringing...')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles on the stale label immediately when the expiry has already passed', () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const t0 = Date.now();
    const { rerender } = render(ui([ringingAt(t0)]));
    expect(screen.getByText('Ringing...')).toBeInTheDocument();

    // Move the wall clock two minutes WITHOUT running the pending timer, then
    // nudge the props so the effect re-runs against an expiry already in the past.
    vi.setSystemTime(t0 + 120_000);
    rerender(ui([ringingAt(t0 + 1_000)]));

    // The effect advanced the card's clock itself rather than merely skipping the
    // schedule - skipping would have stranded it on "Ringing..." with no
    // correction path, since `now` only ever advances there.
    expect(screen.getByText('No team answer')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still settles when its timer fires MARGINALLY EARLY (a backwards clock step)', () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const t0 = Date.now();
    render(ui([ringingAt(t0)]));
    expect(screen.getByText('Ringing...')).toBeInTheDocument();

    // The wall clock steps BACK 10 seconds. Fake timers keep a pending timeout
    // relative to the new system time, so it now comes due at t0 + 80s - ten
    // seconds BEFORE the label's own expiry at t0 + 90s. An early-firing timeout
    // produces the same shape.
    vi.setSystemTime(t0 - 10_000);
    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    // A bare Date.now() in the callback would write t0 + 80s; the presenter would
    // return the SAME staleAt, the [staleAt] dependency would not change, the
    // effect would not re-run, and no replacement timer would ever be scheduled -
    // the card would sit on "Ringing..." forever. The callback advances to at
    // least the boundary instead, so the next render takes the stale branch.
    expect(screen.getByText('No team answer')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a settled call card schedules no timer at all', () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    render(
      ui([
        {
          kind: 'call',
          id: 'c-done',
          at: new Date(Date.now()).toISOString(),
          direction: 'outbound',
          call_status: 'completed',
          call_outcome: 'answered',
        },
      ]),
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Timeline email cards - alignment', () => {
  const emailItem = (direction: 'inbound' | 'outbound', id: string): TimelineItem => ({
    kind: 'message',
    id,
    at: direction === 'inbound' ? '2026-06-08T09:14:00' : '2026-06-08T09:20:00',
    conversationId: 'c1',
    tsMsgId: id,
    direction,
    author: direction === 'inbound' ? 'tenant' : 'teammate',
    type: 'email',
    delivery_status: 'delivered',
    subject: 'Re: 1450 Joseph Blvd',
    body: 'Tuesday at 3pm works.',
  });

  it('aligns email cards by direction on the SERVER timeline path', () => {
    renderTimeline({ items: [emailItem('inbound', 'e-in'), emailItem('outbound', 'e-out')] });
    const cards = document.querySelectorAll('[class*="emailCard"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.className).toContain('itemIn');
    expect(cards[1]?.className).toContain('itemOut');
  });

  it('aligns email cards by direction on the buildTimelineFallback path too', () => {
    const conv: ConversationSummary = {
      conversationId: 'c1',
      type: 'tenant_1to1',
      participant_phone: '+14040100007',
      participants: [],
      preview: null,
      last_activity_at: '2026-06-08T13:14:00Z',
      unread_count: 0,
      sms_opt_out: false,
      participant_display_name: null,
    };
    const mail = (direction: 'inbound' | 'outbound', tsMsgId: string): Message => ({
      conversationId: 'c1',
      tsMsgId,
      type: 'email',
      direction,
      author: direction === 'inbound' ? 'tenant' : 'teammate',
      provider_sid: `EM-${tsMsgId}`,
      provider_ts: direction === 'inbound' ? '2026-06-08T09:14:00Z' : '2026-06-08T09:20:00Z',
      delivery_status: 'delivered',
      created_at: '2026-06-08T09:14:00Z',
      subject: 'Re: 1450 Joseph Blvd',
      body: 'Tuesday at 3pm works.',
    });
    const items = buildTimelineFallback(
      [conv],
      new Map([['c1', [mail('inbound', 'e-in'), mail('outbound', 'e-out')]]]),
    );

    renderTimeline({ items, source: 'fallback' });
    const cards = document.querySelectorAll('[class*="emailCard"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.className).toContain('itemIn');
    expect(cards[1]?.className).toContain('itemOut');
  });
});
