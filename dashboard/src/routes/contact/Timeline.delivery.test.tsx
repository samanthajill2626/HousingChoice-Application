// Per-recipient delivery rows on a multi-party bubble (slice S3).
//
// Split out of Timeline.test.tsx the way Timeline.mms/.email already are: this
// file owns the row list, the row timestamps, the three naming cases end to end
// and the two accessible-name variants. Timeline.test.tsx keeps the rollup-chip
// coverage it already had.
//
// THE RULE FOR EVERY LIST ASSERTION, POSITIVE AND NEGATIVE: drive the reveal
// first. The list is CONDITIONALLY RENDERED, so a queryBy-is-absent assertion
// written without a click would pass on a completely broken build. The negatives
// below are phrased "revealed, and still no list".
//
// No fake timers here (that is slice S4) and no hardcoded clock strings: every
// time expectation is derived with formatTime(<the fixture's own instant>), so
// it computes exactly the way the component does and cannot shift with the
// developer's UTC offset.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import { formatTime } from './format.js';
import type { TimelineItem } from '../../api/index.js';

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

const LIST_NAME = 'Delivery by recipient';

/** Click the bubble's body text; it bubbles to the bubble div's toggleMeta. */
function reveal(bodyText: string): void {
  fireEvent.click(screen.getByText(bodyText));
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: LIST_NAME })).getAllByRole('listitem');
}

const RELAY_ROSTER = [
  { contactId: 'c1', phone: '+14045550111', name: 'Keisha Kane' },
  { contactId: 'c2', phone: '+14045550112', name: 'Lars Landlord' },
];

const GROUP_ROSTER = [
  { contactId: 'c1', phone: '+14045550111', name: 'Ann Tenant' },
  { contactId: 'c2', phone: '+14045550112', name: 'Bo Tenant' },
];

/** Naive-local `at`, three weeks before the pinned clock (setup.ts pins
 *  2026-07-01T12:00:00Z), so a clock-less `sent` leg ages from it and is stale.
 *  formatTime(RELAY_AT) is '9:20a'. */
const RELAY_AT = '2026-06-08T09:20:00';

const RELAY_OUT: TimelineItem = {
  kind: 'message',
  id: 'r1',
  at: RELAY_AT,
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

describe('Timeline per-recipient delivery rows - who the send actually reached', () => {
  it('names every recipient in ROSTER order, contactId-keyed (relay)', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      // MAP order is deliberately the REVERSE of roster order.
      delivery_recipients: {
        c2: { status: 'sent' },
        c1: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    expect(screen.queryByRole('list', { name: LIST_NAME })).not.toBeInTheDocument();
    reveal('Team reply to the group');
    const list = rows();
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveTextContent('Keisha Kane');
    expect(list[1]).toHaveTextContent('Lars Landlord');
  });

  it('names phone-keyed recipients on a native group text', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'g-1',
      tsMsgId: 'g-1',
      body: 'heading over now',
      delivery_recipients: {
        'phone#+14045550111': { status: 'delivered' },
        'phone#+14045550112': { status: 'queued' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: GROUP_ROSTER, rosterKind: 'group_text' });
    reveal('heading over now');
    const list = rows();
    expect(list[0]).toHaveTextContent('Ann Tenant');
    expect(list[1]).toHaveTextContent('Bo Tenant');
  });

  it('puts a slot matching no roster member LAST, in map-key order, marked a former member', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        'c-gone': { status: 'delivered' },
        c1: { status: 'delivered' },
        'phone#+14045550999': { status: 'delivered' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    const list = rows();
    expect(list).toHaveLength(3);
    // The roster match comes first however late it sits in the map.
    expect(list[0]).toHaveTextContent('Keisha Kane');
    // Then the unmatched keys, in MAP order: 'c-gone' before 'phone#...999'.
    expect(list[1]).toHaveTextContent('Unnamed recipient - former member');
    expect(list[2]).toHaveTextContent('(404) 555-0999 - former member');
  });

  it('makes NO membership claim when the roster is EMPTY - case 3 never says "former member"', () => {
    // Placement/Tour semantics: both surfaces initialise members to [] and
    // swallow a roster fetch failure, so this is a real steady state. Saying
    // "former member" here would tell a founder every recipient had left.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        'phone#+14045550111': { status: 'delivered' },
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: [] });
    reveal('Team reply to the group');
    const list = rows();
    expect(list[0]).toHaveTextContent('(404) 555-0111');
    expect(list[1]).toHaveTextContent('Unnamed recipient');
    expect(screen.queryByText(/former member/)).not.toBeInTheDocument();
  });

  it("shows the LEG's own deliveredAt on a delivered row, never the message's time", () => {
    const deliveredAt = '2026-06-08T14:47:00.000Z';
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered', deliveredAt },
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    const list = rows();
    expect(within(list[0] as HTMLElement).getByText(formatTime(deliveredAt))).toBeInTheDocument();
    // The leg WITHOUT a clock is not back-filled from the message instant.
    expect(within(list[1] as HTMLElement).queryByText(formatTime(RELAY_AT))).not.toBeInTheDocument();
  });

  it('shows a stale QUEUED leg as "Queued - not confirmed" AND still shows its sentAt', () => {
    // The row is the answer to "why is the chip red"; withholding the very
    // clock that justifies the red would be its own misread.
    const sentAt = '2026-07-01T11:30:00.000Z';
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'queued', sentAt },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    const stalled = rows()[1] as HTMLElement;
    expect(within(stalled).getByText('Queued - not confirmed')).toBeInTheDocument();
    expect(within(stalled).getByText(formatTime(sentAt))).toBeInTheDocument();
  });

  it('shows NO time on a leg carrying neither clock, and never back-fills the message time', () => {
    // Native group-text legs never get a sentAt (S5), so a state with no time
    // is the correct rendering for most of that product.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'g-2',
      tsMsgId: 'g-2',
      body: 'open house Saturday',
      delivery_recipients: {
        'phone#+14045550111': { status: 'queued' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: GROUP_ROSTER, rosterKind: 'group_text' });
    reveal('open house Saturday');
    const only = rows()[0] as HTMLElement;
    // The shipped `queued` label carries a U+2026 ellipsis; written as an escape
    // so this source line stays ASCII (AGENTS.md). Deliberately NOT compared
    // against presentDeliveryStatus('queued') - that would be self-referential.
    expect(within(only).getByText('Sending\u2026')).toBeInTheDocument();
    expect(within(only).queryByText(formatTime(RELAY_AT))).not.toBeInTheDocument();
  });

  it('renders the rows for an ALL-OPTED-OUT send alongside the message-level chip', () => {
    // Locked decision 2: the opted-out members are the ONLY information this
    // bubble has, so the list must not be gated on the rollup being non-null.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_status: 'queued',
      delivery_recipients: {
        c1: { status: 'failed', errorCode: 'contact_opted_out' },
        c2: { status: 'failed', errorCode: 'contact_opted_out' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    // The message-level chip still renders - the rollup is null here.
    expect(screen.getByText('Sending\u2026')).toBeInTheDocument();
    reveal('Team reply to the group');
    const list = rows();
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveTextContent('Keisha Kane');
    expect(list[0]).toHaveTextContent('Not sent - opted out');
    expect(list[1]).toHaveTextContent('Lars Landlord');
  });

  it('revealed, a queued_pending HOLD still renders no list', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'rq',
      tsMsgId: 'rq',
      body: 'Held until the group connects',
      delivery_status: 'queued_pending',
      delivery_recipients: {
        c1: { status: 'queued' },
        c2: { status: 'queued' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Held until the group connects');
    expect(screen.queryByRole('list', { name: LIST_NAME })).not.toBeInTheDocument();
  });

  it('revealed, an EMPTY delivery_recipients map still renders no list', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-empty',
      tsMsgId: 'r-empty',
      body: 'seeded with no legs',
      delivery_recipients: {},
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('seeded with no legs');
    expect(screen.queryByRole('list', { name: LIST_NAME })).not.toBeInTheDocument();
  });

  it('revealed, an INBOUND relay source bubble still renders no list', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-in',
      tsMsgId: 'r-in',
      direction: 'inbound',
      author: 'tenant',
      body: 'is the unit available?',
      relay_sender_key: 'c1',
      fromPhone: '+14045550111',
      delivery_recipients: {
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('is the unit available?');
    expect(screen.queryByRole('list', { name: LIST_NAME })).not.toBeInTheDocument();
  });

  it('collapses the list again when a ROW is clicked - the rows do not stopPropagation', () => {
    renderTimeline({ items: [RELAY_OUT], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    expect(screen.getByRole('list', { name: LIST_NAME })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Keisha Kane'));
    expect(screen.queryByRole('list', { name: LIST_NAME })).not.toBeInTheDocument();
  });

  it('shows no stale state anywhere on an IMPORTED row carrying a synthetic map', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-imported',
      tsMsgId: 'r-imported',
      body: 'imported history',
      imported: true,
      delivery_recipients: {
        c1: { status: 'sent' },
        c2: { status: 'sent' },
      },
    } as TimelineItem;
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    expect(screen.getByText('delivered 0/2')).toBeInTheDocument();
    reveal('imported history');
    const list = rows();
    expect(within(list[0] as HTMLElement).getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
  });
});

describe('Timeline per-recipient delivery - the chip that carries the accessible summary', () => {
  it('escalates on the FIRST render, with no tick and no interaction, and names both legs', () => {
    // The 2026-08-23 headline case: a founder opens a thread whose leg went
    // quiet hours ago. If the clock initialised lazily this would render
    // exactly as it did before the feature.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'sent' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    const chip = screen.getByText('delivered 1/2 - 1 not confirmed');
    expect(chip.className).toMatch(/toneDanger/);
    expect(chip).toHaveAttribute('role', 'img');
    expect(chip).toHaveAccessibleName(
      'delivered 1 of 2, 1 not confirmed. Keisha Kane: Delivered. Lars Landlord: Sent, not confirmed.',
    );
  });

  it('puts the summary on the MESSAGE-LEVEL chip when the rollup is null (all opted out)', () => {
    // Branch 0: no rollup chip exists, so without this clause a screen-reader
    // user would get the aggregate sentence and no names at all.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'g-optout',
      tsMsgId: 'g-optout',
      body: 'nobody can hear this',
      delivery_status: 'undelivered',
      error_code: 'contact_opted_out',
      delivery_recipients: {
        'phone#+14045550111': { status: 'undelivered', errorCode: 'contact_opted_out' },
        'phone#+14045550112': { status: 'undelivered', errorCode: 'contact_opted_out' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: GROUP_ROSTER, rosterKind: 'group_text' });
    const chip = screen.getByText('Undelivered - Everyone here has opted out - nothing was sent');
    expect(chip).toHaveAttribute('role', 'img');
    expect(chip).toHaveAccessibleName(
      'Undelivered, Everyone here has opted out, nothing was sent. ' +
        'Ann Tenant: Not sent, opted out (Twilio skips them). ' +
        'Bo Tenant: Not sent, opted out (Twilio skips them).',
    );
    // The title stays for mouse users; the aria-label supersedes it.
    expect(chip).toHaveAttribute('title', 'Everyone here has opted out - nothing was sent');
  });

  it('omits the per-recipient recital when the roster is absent AND every key is a contactId', () => {
    // Spec S6 case-3 clause: reciting "Unnamed recipient" N times is worse than
    // the count alone.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'delivered' },
      },
    };
    renderTimeline({ items: [msg] });
    const chip = screen.getByText('Delivered 2/2');
    expect(chip).toHaveAccessibleName('Delivered 2 of 2');
  });

  it('gives NEITHER chip a role on a bubble with no delivery_recipients map at all', () => {
    // Mirrors Timeline.test.tsx's MMS guard: role="img" is applied only to the
    // rollup chip, or to the message-level chip on a branch-0 bubble.
    const oneToOne: TimelineItem = {
      kind: 'message',
      id: 'm2',
      at: RELAY_AT,
      conversationId: 'c1',
      tsMsgId: 'm2',
      direction: 'outbound',
      author: 'teammate',
      type: 'sms',
      delivery_status: 'delivered',
      body: 'Welcome! I will send options.',
      toPhone: '+14040100007',
    };
    renderTimeline({ items: [oneToOne] });
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
