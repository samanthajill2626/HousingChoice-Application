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

/** The separator inside the SHIPPED 1:1 / group-text 30003 reason: one U+2014 EM
 *  DASH with an ASCII space each side. Built from a codepoint so every line this
 *  slice added stays ASCII (AGENTS.md), and so the character is never copied into
 *  new copy - the relay override uses a plain hyphen like every newer string in
 *  the presenter module. */
const EM_DASH = String.fromCharCode(0x2014);

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

  it("shows a NON-delivered leg's sentAt even when the slot also carries a deliveredAt", () => {
    // Pins the `status === 'delivered' &&` clause in `recipientRowTime`, which
    // decides WHICH of the two clocks a row dates itself by. Nothing else pins
    // it: every other fixture carrying `deliveredAt` also carries
    // `status: 'delivered'`, so dropping the clause (`slot.deliveredAt ??
    // slot.sentAt`) turns no other test red. A row must never date a leg by a
    // delivery its own status says has not happened.
    const sentAt = '2026-06-08T09:25:00.000Z';
    const deliveredAt = '2026-06-08T14:47:00.000Z';
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'sent', sentAt, deliveredAt },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    const row = rows()[1] as HTMLElement;
    // Both expectations are derived with formatTime from the fixture's OWN
    // instants, never a clock literal. The guard here is that the two render
    // DIFFERENTLY - without it the positive and negative below could both hold
    // vacuously.
    expect(formatTime(sentAt)).not.toBe(formatTime(deliveredAt));
    expect(within(row).getByText(formatTime(sentAt))).toBeInTheDocument();
    expect(within(row).queryByText(formatTime(deliveredAt))).not.toBeInTheDocument();
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
    // EXACT, beside the substring assertion above and deliberately not instead
    // of it: `contact_opted_out` maps in `deliveryReason` to the MESSAGE-LEVEL
    // aggregate ("Everyone here has opted out - nothing was sent"), which beside
    // ONE member's name is the precise misread this feature exists to kill. The
    // row-level gate is what keeps it out, and only an exact assertion notices
    // when that gate is inverted - a substring match survives the appended copy.
    expect(within(list[0] as HTMLElement).getByText('Not sent - opted out')).toBeInTheDocument();
    expect(screen.queryByText(/Everyone here has opted out/)).not.toBeInTheDocument();
    expect(list[1]).toHaveTextContent('Lars Landlord');
  });

  // THE ROW-LEVEL REASON GATE (spec S4). A row shows a reason only when THAT
  // ROW's own presentation isFailure. Both directions are load-bearing and both
  // are asserted with EXACT text, never a substring: a build with the gate
  // inverted renders the row with the reason appended (or stripped), and a
  // substring assertion would stay green through exactly the misread this
  // feature exists to stop.
  it('shows the failure reason on a HARD-FAILED row, with the raw carrier code', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'failed', errorCode: '30034' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    const failedRow = rows()[1] as HTMLElement;
    expect(failedRow).toHaveTextContent('Lars Landlord');
    expect(
      within(failedRow).getByText('Failed - Number not registered for A2P 10DLC (error 30034)'),
    ).toBeInTheDocument();
  });

  // THE MEDIA CONVERGENCE (main's MMS fix, carried onto this NEW surface).
  // Prod 2026-08-24: a Verizon mobile delivered 10/10 texts the same week 6/6 of
  // its MMS died 30005, so "Number is invalid" on an attachment leg sends staff
  // chasing a number that works. main hedged that copy on the MESSAGE-LEVEL chip
  // and the rollup. The per-recipient rows are a surface main never saw, and an
  // un-hedged reason HERE - beside a named member, directly under a hedged chip -
  // would contradict the fix at the exact place it matters most.
  //
  // This pins the CALL SITE, not the pure function: deleting `{ media: isMms }`
  // from the row's `deliveryReason` call leaves every other test in the repo
  // green. Proved non-vacuous by removing it - this test then rendered
  // "Failed - Number is invalid (error 30005)" on Lars Landlord's row, which the
  // negative below catches.
  it('hedges a 30005 on an ATTACHMENT row instead of blaming the number', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-mms-fail',
      tsMsgId: 'r-mms-fail',
      type: 'mms',
      body: 'photos of the unit',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'failed', errorCode: '30005' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('photos of the unit');
    const failedRow = rows()[1] as HTMLElement;
    expect(failedRow).toHaveTextContent('Lars Landlord');
    // EXACT text, never a substring: the whole point is WHICH sentence renders.
    expect(
      within(failedRow).getByText(
        "Failed - Attachment didn't get through, texts may still work (error 30005)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Number is invalid/)).not.toBeInTheDocument();
    // The accessible name is the THIRD consumer of the same `isMms`, and a
    // screen-reader user reading "Number is invalid" is the same wrong fact.
    expect(screen.getByRole('img')).toHaveAccessibleName(
      "delivered 1 of 2, 1 failed, Attachment didn't get through, texts may still work (error 30005). " +
        "Keisha Kane: Delivered. Lars Landlord: Failed, Attachment didn't get through, texts may still work (error 30005).",
    );
  });

  it('keeps the invalid-number reading on a 30005 row of a TEXT message', () => {
    // The other half of main's rule, and the reason the flag is per-message
    // rather than global: 30005 on a plain SMS really does mean the number is
    // bad, and that is how every dead number in prod was caught.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-sms-fail',
      tsMsgId: 'r-sms-fail',
      body: 'plain text to the group',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'failed', errorCode: '30005' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('plain text to the group');
    const failedRow = rows()[1] as HTMLElement;
    expect(within(failedRow).getByText('Failed - Number is invalid (error 30005)')).toBeInTheDocument();
    expect(screen.queryByText(/Attachment didn't get through/)).not.toBeInTheDocument();
  });

  // POSITIONS 2 and 3 of the four surfaces the fan-out close codes reach: the
  // accessible-name recital (Timeline.tsx:582) and the per-recipient row
  // (Timeline.tsx:1045). The ladders write these codes onto the SLOT, so they
  // land beside a named member; unregistered the row read
  // "Failed - Delivery failed (error transient_cap)", which prints an
  // app-invented token as though it were a carrier number the operator could look
  // up. EXACT text, never a substring - same reason as the 30034 row above.
  it('reads a CAPPED fan-out row as operator prose, with no carrier-code tail', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-capped',
      tsMsgId: 'r-capped',
      body: 'group note that ran out of retries',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'failed', errorCode: 'transient_cap' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('group note that ran out of retries');
    const failedRow = rows()[1] as HTMLElement;
    expect(failedRow).toHaveTextContent('Lars Landlord');
    expect(
      within(failedRow).getByText('Failed - Sending gave up after repeated carrier deferrals'),
    ).toBeInTheDocument();
    expect(failedRow.textContent ?? '').not.toContain('(error ');
    expect(failedRow.textContent ?? '').not.toContain('transient_cap');
    // The recital is the SECOND reader of the same slot code and is computed
    // whether or not the list is revealed, so a screen-reader user gets the same
    // sentence a sighted one does.
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'delivered 1 of 2, 1 failed, Sending gave up after repeated carrier deferrals. ' +
        'Keisha Kane: Delivered. Lars Landlord: Failed, Sending gave up after repeated carrier deferrals.',
    );
  });

  // The other close: the continuation was never scheduled, so no retry ran at
  // all. D10 - the row must not tell staff the ladder was exhausted.
  it('reads a NEVER-SCHEDULED fan-out row distinctly, also without a tail', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-unscheduled',
      tsMsgId: 'r-unscheduled',
      body: 'group note that never got queued',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'failed', errorCode: 'enqueue_failed' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('group note that never got queued');
    const failedRow = rows()[1] as HTMLElement;
    expect(failedRow).toHaveTextContent('Lars Landlord');
    expect(
      within(failedRow).getByText('Failed - Sending could not be scheduled'),
    ).toBeInTheDocument();
    expect(failedRow.textContent ?? '').not.toContain('(error ');
    expect(failedRow.textContent ?? '').not.toContain('enqueue_failed');
    expect(screen.queryByText(/gave up after repeated carrier deferrals/)).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'delivered 1 of 2, 1 failed, Sending could not be scheduled. ' +
        'Keisha Kane: Delivered. Lars Landlord: Failed, Sending could not be scheduled.',
    );
  });

  it('shows NO reason on a STILL-RETRYING row that carries a transient carrier code', () => {
    // The fan-out writes a transient code onto a leg it is still retrying.
    // `queued` is not a failure, so 30003's "will retry" copy must not appear
    // beside this person's name as though the send were over.
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'queued', errorCode: '30003' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    reveal('Team reply to the group');
    const retryingRow = rows()[1] as HTMLElement;
    expect(retryingRow).toHaveTextContent('Lars Landlord');
    // EXACT: the state chip is the label alone, with nothing appended. The
    // shipped label carries a U+2026 ellipsis; written as an escape so this
    // source line stays ASCII (AGENTS.md).
    expect(within(retryingRow).getByText('Sending\u2026')).toBeInTheDocument();
    expect(within(retryingRow).queryByText(/30003/)).not.toBeInTheDocument();
    expect(within(retryingRow).queryByText(/will retry/)).not.toBeInTheDocument();
  });

  // ---- Slice 5a: the relay 30003 override (D19-D21) --------------------------
  //
  // D19: no relay retry is scheduled. The status webhook returns on the
  // relay-pointer branch BEFORE the 1:1 retry enqueue, and this branch adds no
  // relay retry - so "will retry" beside a relay member's name is a promise the
  // product cannot keep, in both worlds.
  //
  // D21: one flag feeds the rollup, the recital and the row, so the three cannot
  // disagree; a partial fix that left a row contradicting the chip above it would
  // be worse than none. Each test below therefore asserts ALL THREE positions,
  // and the PROVING assertion at each is the NEGATIVE.
  it('drops the retry promise on a RELAY 30003 leg at all three positions, code intact', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-30003',
      tsMsgId: 'r-30003',
      body: 'relay note to the group',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'undelivered', errorCode: '30003' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    // POSITION 1 - the rollup chip (deliveryStatus.ts:416), visible with no
    // reveal. EXACT text: the whole question is WHICH sentence renders.
    const rollup = screen.getByRole('img');
    expect(rollup).toHaveTextContent('delivered 1/2 - 1 failed - Phone unreachable (error 30003)');
    // POSITION 2 - the accessible-name recital (Timeline.tsx:582), computed
    // whether or not the list is revealed, so a screen-reader user gets the same
    // sentence a sighted one does.
    expect(rollup).toHaveAccessibleName(
      'delivered 1 of 2, 1 failed, Phone unreachable (error 30003). ' +
        'Keisha Kane: Delivered. Lars Landlord: Undelivered, Phone unreachable (error 30003).',
    );
    // POSITION 3 - the per-recipient row (Timeline.tsx:1045), REVEALED.
    reveal('relay note to the group');
    const failedRow = rows()[1] as HTMLElement;
    expect(failedRow).toHaveTextContent('Lars Landlord');
    expect(
      within(failedRow).getByText('Undelivered - Phone unreachable (error 30003)'),
    ).toBeInTheDocument();
    // THE PROVING ASSERTION, and it is PAGE-WIDE on purpose. Besides the three
    // positions it also covers the message-level chip (Timeline.tsx:849), which
    // must never pick a code off a SLOT - research F4: that site's safety rests
    // on group-delivery behavior in files this branch does not edit, so it is
    // pinned here rather than asserted in a table.
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
  });

  // D20, pinned EXPLICITLY rather than by relying on a default. `rosterKind`
  // defaults to 'relay' (Timeline.tsx:1519, the operative one - MessageBubble's
  // own :796 default is dead in production because :2083 always supplies a
  // value), so exactly ONE production caller opts out: GroupTextView. A
  // group-text 30003 really does reach the retry enqueue - the 30005/30006 and
  // 21610 arms each carry a group_text guard and the 30003 arm carries none - so
  // the promise is TRUE there and must survive byte for byte.
  it('keeps the retry promise on the SAME leg in a native GROUP TEXT', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'g-30003',
      tsMsgId: 'g-30003',
      body: 'group text to the pair',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'undelivered', errorCode: '30003' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: GROUP_ROSTER, rosterKind: 'group_text' });
    const base = `Phone unreachable ${EM_DASH} will retry (error 30003)`;
    const rollup = screen.getByRole('img');
    expect(rollup).toHaveTextContent(`delivered 1/2 - 1 failed - ${base}`);
    expect(rollup).toHaveAccessibleName(
      `delivered 1 of 2, 1 failed, ${base}. Ann Tenant: Delivered. Bo Tenant: Undelivered, ${base}.`,
    );
    reveal('group text to the pair');
    const failedRow = rows()[1] as HTMLElement;
    expect(within(failedRow).getByText(`Undelivered - ${base}`)).toBeInTheDocument();
  });

  // THE PRECEDENCE, at the CALL SITES rather than in the pure function: both
  // flags are handed to deliveryReason from the same three places, and adding
  // `relay` must not displace `media`. A relay MMS leg that fails 30003 misses
  // the media map (which holds 30005/30006 only) and lands on the relay copy; a
  // relay MMS leg that fails 30005 keeps the MMS hedge.
  it('keeps the MMS hedge on a relay ATTACHMENT leg, and still overrides its 30003', () => {
    const mms: TimelineItem = {
      ...RELAY_OUT,
      id: 'r-mms-30003',
      tsMsgId: 'r-mms-30003',
      type: 'mms',
      body: 'photos and a dead line',
      delivery_recipients: {
        c1: { status: 'failed', errorCode: '30005' },
        c2: { status: 'undelivered', errorCode: '30003' },
      },
    };
    renderTimeline({ items: [mms], relayRoster: RELAY_ROSTER });
    reveal('photos and a dead line');
    const list = rows();
    expect(
      within(list[0] as HTMLElement).getByText(
        "Failed - Attachment didn't get through, texts may still work (error 30005)",
      ),
    ).toBeInTheDocument();
    expect(
      within(list[1] as HTMLElement).getByText('Undelivered - Phone unreachable (error 30003)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
  });

  // Timeline.tsx:849 - the MESSAGE-LEVEL chip - is NOT overridden. It reads
  // `msg.error_code`, gets no product flag, and is reached by 1:1 bubbles and by
  // the native-group-text aggregate (services/groupDelivery.ts copies the worst
  // leg's code onto the message row for group texts ONLY). Both keep a real
  // retry, so the base copy has to survive here even though this timeline's
  // rosterKind is 'relay' by default - which is exactly what would break if the
  // override were applied to the message level instead of to relay LEGS.
  it('leaves the MESSAGE-LEVEL chip on the base copy, relay default notwithstanding', () => {
    const oneToOne: TimelineItem = {
      kind: 'message',
      id: 'm-30003',
      at: RELAY_AT,
      conversationId: 'c1',
      tsMsgId: 'm-30003',
      direction: 'outbound',
      author: 'teammate',
      type: 'sms',
      delivery_status: 'undelivered',
      error_code: '30003',
      body: 'one to one, no roster',
    };
    renderTimeline({ items: [oneToOne] });
    expect(
      screen.getByText(`Undelivered - Phone unreachable ${EM_DASH} will retry (error 30003)`),
    ).toBeInTheDocument();
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

  it('revealed, an INBOUND relay source bubble discloses its available outbound leg', () => {
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
    expect(
      within(screen.getByRole('list', { name: LIST_NAME })).getByRole('listitem', {
        name: 'Lars Landlord - Delivered',
      }),
    ).toBeInTheDocument();
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
  it('escalates on the FIRST render, with no tick and no interaction, and names both legs with their own times', () => {
    // The 2026-08-23 headline case: a founder opens a thread whose leg went
    // quiet hours ago. If the clock initialised lazily this would render
    // exactly as it did before the feature.
    const deliveredAt = '2026-06-08T14:47:00.000Z';
    const sentAt = '2026-06-08T15:03:00.000Z';
    const msg: TimelineItem = {
      ...RELAY_OUT,
      delivery_recipients: {
        c1: { status: 'delivered', deliveredAt },
        c2: { status: 'sent', sentAt },
      },
    };
    expect(formatTime(deliveredAt)).not.toBe(formatTime(sentAt));
    renderTimeline({ items: [msg], relayRoster: RELAY_ROSTER });
    const chip = screen.getByText('delivered 1/2 - 1 not confirmed');
    expect(chip.className).toMatch(/toneDanger/);
    expect(chip).toHaveAttribute('role', 'img');
    expect(chip).toHaveAccessibleName(
      `delivered 1 of 2, 1 not confirmed. Keisha Kane: Delivered, ${formatTime(deliveredAt)}. ` +
        `Lars Landlord: Sent, not confirmed, ${formatTime(sentAt)}.`,
    );
  });

  it('puts the summary on the MESSAGE-LEVEL chip when the rollup is null (all opted out)', () => {
    // Branch 0: no rollup chip exists, so without this clause a screen-reader
    // user would get the aggregate sentence and no names at all.
    const annSentAt = '2026-06-08T14:47:00.000Z';
    const boSentAt = '2026-06-08T15:03:00.000Z';
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'g-optout',
      tsMsgId: 'g-optout',
      body: 'nobody can hear this',
      delivery_status: 'undelivered',
      error_code: 'contact_opted_out',
      delivery_recipients: {
        'phone#+14045550111': {
          status: 'undelivered',
          errorCode: 'contact_opted_out',
          sentAt: annSentAt,
        },
        'phone#+14045550112': {
          status: 'undelivered',
          errorCode: 'contact_opted_out',
          sentAt: boSentAt,
        },
      },
    };
    expect(formatTime(annSentAt)).not.toBe(formatTime(boSentAt));
    renderTimeline({ items: [msg], relayRoster: GROUP_ROSTER, rosterKind: 'group_text' });
    const chip = screen.getByText('Undelivered - Everyone here has opted out - nothing was sent');
    expect(chip).toHaveAttribute('role', 'img');
    expect(chip).toHaveAccessibleName(
      'Undelivered, Everyone here has opted out, nothing was sent. ' +
        `Ann Tenant: Not sent, opted out (Twilio skips them), ${formatTime(annSentAt)}. ` +
        `Bo Tenant: Not sent, opted out (Twilio skips them), ${formatTime(boSentAt)}.`,
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
