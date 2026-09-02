// The staleness TICKER (slice S4) - the one thing that makes an escalation
// appear on a bubble ALREADY on screen when the 15-minute boundary passes.
//
// WHY THIS IS ITS OWN FILE. Fake timers escaping a describe block wedge every
// `waitFor` in Timeline.test.tsx, which is 1700+ lines and mostly async. Keeping
// the timers here makes the blast radius of a timer mistake one small file - the
// same split the repo already uses for Timeline.mms / Timeline.email /
// Timeline.delivery.
//
// THE HAZARD THIS FILE EXISTS TO PIN DOWN. The run condition has failed to
// terminate four distinct ways across four review rounds (any non-terminal leg;
// any not-yet-stale leg; a WITHHELD clock; a clock that parses to NaN), so this
// file proves TERMINATION for every row of the spec's S3 eligibility table plus
// an imported bubble and a NaN-clock bubble - not just the happy escalation.
//
// OBSERVABLE. `vi.getTimerCount()` is deliberately NOT used: it is polluted by
// CallCard's own setTimeout and by RTL internals. Each absence proof spies on
// `window.setInterval` and asserts it was never called, and backs that with the
// behavioural half (advance a long way, nothing escalates). Each test title says
// which observable it used.
//
// TIMER DISCIPLINE. Every test opens with `startFakeClock()`, which releases the
// shared Date pin (src/test/setup.ts) BEFORE installing fake timers - vitest
// throws otherwise - and the afterEach restores real timers so setup.ts's
// beforeEach can re-pin. No hardcoded clock literal anywhere: every fixture
// instant is derived from the fake clock's own `Date.now()`.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import type { RelayRecipientDelivery, TimelineItem, TimelineMessage } from '../../api/index.js';

const BODY = 'Team reply to the group';
const LIST_NAME = 'Delivery by recipient';

/** Comfortably past STALE_SENT_AFTER_MS (15 minutes) - derived from the boundary
 *  it crosses, not from the ticker's own period. */
const PAST_THE_BOUNDARY_MS = 16 * 60 * 1000;
/** A long idle stretch, used by the absence proofs' behavioural half. */
const A_LONG_WHILE_MS = 24 * 60 * 60 * 1000;
/** Further ahead of the browser clock than any ordinary skew - the shape a
 *  machine with no NTP or a dead CMOS battery puts EVERY freshly-sent leg in. */
const A_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const ROSTER = [
  { contactId: 'c1', phone: '+14045550111', name: 'Keisha Kane' },
  { contactId: 'c2', phone: '+14045550112', name: 'Lars Landlord' },
];

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
        relayRoster={ROSTER}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** An outbound relay bubble whose `at` is derived from the fixture's own clock.
 *  `recipients` is the WHOLE map, so each case states exactly the S3-table row
 *  it exercises. */
function outboundAt(
  atMs: number,
  recipients: Record<string, RelayRecipientDelivery>,
  extra: Partial<TimelineMessage> = {},
): TimelineMessage {
  return {
    kind: 'message',
    id: 'r1',
    at: new Date(atMs).toISOString(),
    conversationId: 'g1',
    tsMsgId: 'r1',
    direction: 'outbound',
    author: 'teammate',
    type: 'sms',
    delivery_status: 'sent',
    body: BODY,
    relay_sender_key: 'team',
    delivery_recipients: recipients,
    ...extra,
  };
}

/** Release the shared Date pin, install fake timers, and hand back the instant
 *  every fixture in the test derives from. */
function startFakeClock(): number {
  vi.useRealTimers();
  vi.useFakeTimers();
  return Date.now();
}

/** Spy on the two window methods the ticker uses. Installed AFTER the fake
 *  timers, so the spy wraps the FAKE setInterval and advanceTimersByTime still
 *  drives it. The afterEach restores in the mirror order. */
function spyOnIntervals() {
  return {
    set: vi.spyOn(window, 'setInterval'),
    clear: vi.spyOn(window, 'clearInterval'),
  };
}

/** Click the bubble's body text; it bubbles to the bubble div's toggleMeta. */
function reveal(): void {
  fireEvent.click(screen.getByText(BODY));
}

describe('Timeline staleness ticker', () => {
  afterEach(() => {
    // Order matters: restoreAllMocks FIRST (it puts the FAKE setInterval back
    // under the spy), then useRealTimers (which replaces it with the real one).
    // Inverted, the fake timer functions would leak into the next file.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('escalates a not-yet-stale leg once the boundary passes - observable: the rendered chip text, with the preserved reveal proving no re-mount and a paging spy proving no refetch', () => {
    const t0 = startFakeClock();
    const onLoadOlder = vi.fn();
    const msg = outboundAt(t0, {
      c1: { status: 'delivered', deliveredAt: new Date(t0).toISOString() },
      c2: { status: 'sent', sentAt: new Date(t0).toISOString() },
    });
    renderTimeline({
      items: [msg],
      paging: { hasOlder: true, loadingOlder: false, olderPagesLoaded: 0, onLoadOlder },
    });

    // Fresh: the neutral in-flight rollup, no escalation anywhere.
    expect(screen.getByText('delivered 1/2')).toBeInTheDocument();
    reveal();
    expect(screen.getByRole('list', { name: LIST_NAME })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
    });

    // No reload, no navigation, no inbound message - only time passing.
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: LIST_NAME });
    expect(within(list).getByText('Sent - not confirmed')).toBeInTheDocument();
    // The reveal is MessageBubble-local state: still open means the bubble was
    // re-rendered, not re-mounted.
    expect(list).toBeInTheDocument();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('STOPS once every eligible leg is stale - observable: window.clearInterval was called with the ticker id and window.setInterval never ran a second time', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    renderTimeline({
      items: [
        outboundAt(t0, {
          c1: { status: 'delivered' },
          c2: { status: 'sent', sentAt: new Date(t0).toISOString() },
        }),
      ],
    });

    // Nothing else in a Timeline render schedules an interval - the absence
    // proofs below establish that baseline is exactly zero - so this call is the
    // ticker's.
    expect(spies.set).toHaveBeenCalledTimes(1);
    const tickerId: unknown = spies.set.mock.results[0]?.value;

    act(() => {
      vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
    });
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();
    expect(spies.clear).toHaveBeenCalledWith(tickerId);

    // And it does NOT re-arm: a stale leg stays non-terminal for ever, which is
    // non-termination #1.
    act(() => {
      vi.advanceTimersByTime(A_LONG_WHILE_MS);
    });
    expect(spies.set).toHaveBeenCalledTimes(1);
  });

  it('cleans up on unmount - observable: window.clearInterval was called with the ticker id', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    const { unmount } = renderTimeline({
      items: [
        outboundAt(t0, {
          c1: { status: 'sent', sentAt: new Date(t0).toISOString() },
        }),
      ],
    });
    expect(spies.set).toHaveBeenCalledTimes(1);
    const tickerId: unknown = spies.set.mock.results[0]?.value;

    unmount();
    expect(spies.clear).toHaveBeenCalledWith(tickerId);
  });

  it('does not tick a HIDDEN tab - observable: the rendered chip text is unchanged while document.visibilityState is hidden, and escalates on the focus that follows', () => {
    const t0 = startFakeClock();
    let visibility: DocumentVisibilityState = 'hidden';
    // jsdom defines visibilityState on Document.prototype, so shadow it with an
    // own configurable getter rather than vi.spyOn (which needs an own
    // descriptor). Deleted again below so the override cannot leak.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    renderTimeline({
      items: [
        outboundAt(t0, {
          c1: { status: 'delivered' },
          c2: { status: 'sent', sentAt: new Date(t0).toISOString() },
        }),
      ],
    });
    expect(screen.getByText('delivered 1/2')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
    });
    expect(screen.getByText('delivered 1/2')).toBeInTheDocument();

    // Coming back to the tab is immediate - that is what lets the interval only
    // have to cover the tab already in front of the operator.
    visibility = 'visible';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();

    delete (document as unknown as Record<string, unknown>).visibilityState;
  });
});

// --- The termination table -------------------------------------------------
// One case per row of the spec's S3 eligibility table, plus an imported bubble
// and a NaN-clock bubble. Every case says whether the interval runs and why.

interface TickerCase {
  title: string;
  build: (t0: number) => TimelineMessage;
}

const ARMING_CASES: TickerCase[] = [
  {
    title: 'S3 row 1 - a `sent` leg WITH a parseable sentAt ages from sentAt',
    build: (t0) =>
      outboundAt(t0, {
        c1: { status: 'delivered' },
        c2: { status: 'sent', sentAt: new Date(t0).toISOString() },
      }),
  },
  {
    title: 'S3 row 2 - a `sent` leg with NO sentAt ages from the message instant',
    build: (t0) =>
      outboundAt(t0, {
        c1: { status: 'delivered' },
        c2: { status: 'sent' },
      }),
  },
  {
    title: 'S3 row 3 - a `queued` leg WITH a parseable sentAt ages from sentAt',
    build: (t0) =>
      outboundAt(
        t0,
        {
          c1: { status: 'delivered' },
          c2: { status: 'queued', sentAt: new Date(t0).toISOString() },
        },
        { delivery_status: 'queued' },
      ),
  },
];

const SILENT_CASES: TickerCase[] = [
  {
    title:
      'S3 row 4 - a `queued` leg with NO sentAt never ages (the released hold and the receipts outage), so nothing is scheduled',
    build: (t0) =>
      outboundAt(
        t0,
        {
          c1: { status: 'queued' },
          c2: { status: 'queued' },
        },
        { delivery_status: 'queued' },
      ),
  },
  {
    title: 'S3 row 5 - a `queued_pending` SLOT has not been dispatched, so nothing is scheduled',
    build: (t0) =>
      outboundAt(t0, {
        c1: { status: 'queued_pending' },
        c2: { status: 'queued_pending', sentAt: new Date(t0).toISOString() },
      }),
  },
  {
    title:
      'S3 row 5b - a `queued_pending` PARENT renders no rollup and no rows, so even an otherwise-eligible leg schedules nothing',
    build: (t0) =>
      outboundAt(
        t0,
        {
          c1: { status: 'sent', sentAt: new Date(t0).toISOString() },
        },
        { delivery_status: 'queued_pending' },
      ),
  },
  {
    title: 'S3 row 6 - terminal legs (delivered / failed / undelivered) have settled',
    build: (t0) =>
      outboundAt(
        t0,
        {
          c1: { status: 'delivered', deliveredAt: new Date(t0).toISOString() },
          c2: { status: 'failed', errorCode: '30005' },
          'phone#+14045550999': { status: 'undelivered', errorCode: 'contact_opted_out' },
        },
        { delivery_status: 'delivered' },
      ),
  },
  {
    title:
      'an IMPORTED bubble withholds its clock (D-c2), so its legs contribute nothing however quiet they are',
    build: (t0) =>
      outboundAt(
        t0 - PAST_THE_BOUNDARY_MS,
        {
          c1: { status: 'sent', sentAt: new Date(t0 - PAST_THE_BOUNDARY_MS).toISOString() },
          c2: { status: 'sent' },
        },
        { imported: true },
      ),
  },
  {
    title:
      'a NaN clock - a `sent` leg with no sentAt on a message whose instant does not parse (messageInstant returns an empty string for a non-ISO tsMsgId) - is not eligible, so nothing spins for ever',
    build: () => ({
      ...outboundAt(0, { c1: { status: 'sent' }, c2: { status: 'sent' } }, { tsMsgId: 'nosid' }),
      at: '',
    }),
  },
  {
    title:
      'a leg whose sentAt is more than one budget in the FUTURE (the operator browser clock is slow) ages from NOTHING, so the interval is never armed',
    build: (t0) =>
      outboundAt(t0, {
        c1: { status: 'delivered' },
        c2: { status: 'sent', sentAt: new Date(t0 + A_YEAR_MS).toISOString() },
      }),
  },
  {
    title:
      'the same skew reached through the MESSAGE clock - a clock-less `sent` leg (S3 row 2) on a message instant far in the future - also ages from NOTHING',
    build: (t0) =>
      outboundAt(t0 + A_YEAR_MS, {
        c1: { status: 'delivered' },
        c2: { status: 'sent' },
      }),
  },
  {
    title:
      'an EMAIL row renders an EmailCard - no rollup, no rows, no legs - so even an otherwise-eligible leg presents nothing that could change',
    build: (t0) =>
      outboundAt(
        t0,
        { c1: { status: 'sent', sentAt: new Date(t0).toISOString() } },
        { type: 'email', subject: 'Property options for you' },
      ),
  },
  {
    title:
      'an OPTED-OUT leg is excluded from the rollup and short-circuited by the row presenter, so no pixel can ever change for it',
    build: (t0) =>
      outboundAt(t0, {
        c1: {
          status: 'sent',
          sentAt: new Date(t0).toISOString(),
          errorCode: 'contact_opted_out',
        },
      }),
  },
  {
    title: 'a generic INBOUND bubble without a Relay sender key has no rendered recipient state to age',
    build: (t0) =>
      outboundAt(
        t0,
        {
          c1: { status: 'sent', sentAt: new Date(t0).toISOString() },
        },
        { direction: 'inbound', relay_sender_key: undefined },
      ),
  },
  {
    title: 'a bubble with NO delivery_recipients map at all has no legs to age',
    build: (t0) => {
      const msg = outboundAt(t0, {});
      delete msg.delivery_recipients;
      return msg;
    },
  },
];

describe('Timeline staleness ticker - termination table', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('ARMS and TERMINATES for an INBOUND Relay source: its collapsed recipient summary and revealed row both update when the live outbound leg becomes stale', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    renderTimeline({
      items: [
        outboundAt(
          t0,
          {
            c1: { status: 'sent', sentAt: new Date(t0).toISOString() },
          },
          { direction: 'inbound' },
        ),
      ],
    });
    expect(
      screen.getByRole('group', { name: /Delivery by recipient\. Keisha Kane: Sent,/ }),
    ).toBeInTheDocument();
    expect(spies.set).toHaveBeenCalledTimes(1);
    const tickerId: unknown = spies.set.mock.results[0]?.value;

    act(() => {
      vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
    });

    expect(
      screen.getByRole('group', { name: /Delivery by recipient\. Keisha Kane: Sent, not confirmed,/ }),
    ).toBeInTheDocument();
    expect(spies.clear).toHaveBeenCalledWith(tickerId);
    reveal();
    expect(within(screen.getByRole('list', { name: LIST_NAME })).getByText('Sent - not confirmed')).toBeInTheDocument();
  });

  it.each(ARMING_CASES)(
    'ARMS then terminates: $title - observable: window.setInterval called exactly once, then window.clearInterval once the leg is stale',
    ({ build }) => {
      const t0 = startFakeClock();
      const spies = spyOnIntervals();
      renderTimeline({ items: [build(t0)] });
      expect(spies.set).toHaveBeenCalledTimes(1);
      const tickerId: unknown = spies.set.mock.results[0]?.value;

      act(() => {
        vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
      });
      expect(screen.getByText(/not confirmed/)).toBeInTheDocument();
      expect(spies.clear).toHaveBeenCalledWith(tickerId);

      act(() => {
        vi.advanceTimersByTime(A_LONG_WHILE_MS);
      });
      expect(spies.set).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SILENT_CASES)(
    'schedules NOTHING: $title - observable: window.setInterval was never called, plus a day of advancing that changes nothing',
    ({ build }) => {
      const t0 = startFakeClock();
      const spies = spyOnIntervals();
      renderTimeline({ items: [build(t0)] });

      expect(spies.set).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(A_LONG_WHILE_MS);
      });
      expect(spies.set).not.toHaveBeenCalled();
      expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
    },
  );

  it('schedules NOTHING for an ALREADY-stale eligible leg - observable: window.setInterval was never called, and the escalation is on the FIRST render with no tick at all', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    const quietSince = t0 - PAST_THE_BOUNDARY_MS;
    renderTimeline({
      items: [
        outboundAt(quietSince, {
          c1: { status: 'delivered' },
          c2: { status: 'sent', sentAt: new Date(quietSince).toISOString() },
        }),
      ],
    });

    // A stale leg stays non-terminal for ever - non-termination #1. There is
    // nothing left to carry across the boundary, so there is nothing to schedule.
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();
    expect(spies.set).not.toHaveBeenCalled();
  });

  it('ARMS and TERMINATES for a clock WITHIN one budget in the future - ordinary browser skew escalates LATE, never not at all - observable: window.setInterval once, then window.clearInterval with the ticker id', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    // The operator's browser clock is five minutes slow, so a freshly-sent leg
    // carries a provider clock five minutes AHEAD of ours. This is the case a
    // `clock <= nowMs` bound would have made INELIGIBLE - arming nothing, so
    // nothing re-renders when the browser clock catches up and the escalation is
    // missed entirely.
    const skewMs = 5 * 60 * 1000;
    renderTimeline({
      items: [
        outboundAt(t0, {
          c1: { status: 'delivered' },
          c2: { status: 'sent', sentAt: new Date(t0 + skewMs).toISOString() },
        }),
      ],
    });
    expect(spies.set).toHaveBeenCalledTimes(1);
    const tickerId: unknown = spies.set.mock.results[0]?.value;

    // BOUNDED: at most two budgets of real time, not for ever.
    act(() => {
      vi.advanceTimersByTime(2 * PAST_THE_BOUNDARY_MS);
    });
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();
    expect(spies.clear).toHaveBeenCalledWith(tickerId);
  });

  // REGRESSION (planner review, 2026-08-24). The ticker's `tickNow` is not only
  // the re-render trigger - it is ALSO the clock every staleness decision is
  // measured against, and its only writer lives INSIDE the interval. So the
  // moment the ticker disarms, the clock FREEZES for the lifetime of the mounted
  // Timeline, and `canEverGoStale`'s futurity bound then refuses to re-arm for
  // any leg whose clock is more than one budget newer than that freeze. The two
  // reinforce each other: frozen clock -> nothing eligible -> no interval ->
  // clock stays frozen.
  //
  // The reachable case is the ordinary one, and it is the incident's own shape
  // with a longer gap: staff open a thread where everything has already
  // delivered (so the ticker NEVER arms and the clock is pinned at mount), leave
  // it open, and send later. Every test in this file before this one mounted
  // fresh, where `tickNow === Date.now()` by construction - which is exactly why
  // the suite was structurally blind to it.
  it('re-arms for a leg that arrives long after the ticker disarmed - observable: the chip escalates for the NEW leg, proving the arming clock is not frozen at mount', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    const settled = outboundAt(t0, {
      c1: { status: 'delivered', deliveredAt: new Date(t0).toISOString() },
      c2: { status: 'delivered', deliveredAt: new Date(t0).toISOString() },
    });
    const view = renderTimeline({ items: [settled] });

    // Nothing can escalate, so nothing is armed - and therefore nothing will
    // ever bump the clock again on its own.
    expect(screen.getByText('Delivered 2/2')).toBeInTheDocument();
    expect(spies.set).not.toHaveBeenCalled();

    // Staff leave the thread open for longer than one budget.
    const IDLE_MS = 20 * 60 * 1000;
    act(() => {
      vi.advanceTimersByTime(IDLE_MS);
    });

    // A new team message lands by SSE refetch. Its leg is FRESH - `sentAt` is
    // now - which under a frozen clock reads as a full budget INTO THE FUTURE.
    const tNew = Date.now();
    const arrived = outboundAt(
      tNew,
      {
        c1: { status: 'delivered', deliveredAt: new Date(tNew).toISOString() },
        c2: { status: 'sent', sentAt: new Date(tNew).toISOString() },
      },
      { id: 'r2', tsMsgId: 'r2', body: 'here is the flyer' },
    );
    view.rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[settled, arrived]}
          source="server"
          replyToPhone="+14705550148"
          replyToLabel="most recent"
          canSend={false}
          onSend={vi.fn()}
          relayRoster={ROSTER}
        />
      </MemoryRouter>,
    );

    // The new leg is live and not yet stale, so the ticker MUST arm for it.
    expect(spies.set).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
    });
    expect(screen.getByText('delivered 1/2 - 1 not confirmed')).toBeInTheDocument();
  });

  // The refresh trigger is "the RENDERED set changed", which is deliberately
  // broader than "an item arrived" - `visible` also changes identity when a
  // display filter is toggled. Pinned because it is the one shape the rerender
  // test above does not reach, and because the breadth is load-bearing: the
  // trigger has to cover a paged prepend and a thread switch, both of which are
  // also just a `visible` identity change. A staff toggle therefore re-evaluates
  // arming, which can only make a chip MORE current, never less.
  it('re-evaluates arming when a display filter changes the rendered set, not only when an item arrives - observable: window.setInterval is called after the toggle', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    const settled = outboundAt(t0, {
      c1: { status: 'delivered', deliveredAt: new Date(t0).toISOString() },
      c2: { status: 'delivered', deliveredAt: new Date(t0).toISOString() },
    });
    const view = renderTimeline({ items: [settled], commsOnly: false });
    expect(spies.set).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(20 * 60 * 1000);
    });

    // Same items, different FILTER - and a leg that is now live on screen.
    const tNew = Date.now();
    const arrived = outboundAt(
      tNew,
      {
        c1: { status: 'delivered', deliveredAt: new Date(tNew).toISOString() },
        c2: { status: 'sent', sentAt: new Date(tNew).toISOString() },
      },
      { id: 'r2', tsMsgId: 'r2', body: 'here is the flyer' },
    );
    view.rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[settled, arrived]}
          source="server"
          replyToPhone="+14705550148"
          replyToLabel="most recent"
          canSend={false}
          onSend={vi.fn()}
          relayRoster={ROSTER}
          commsOnly
        />
      </MemoryRouter>,
    );
    expect(spies.set).toHaveBeenCalledTimes(1);
  });

  it('ARMS on a MIXED map - one leg opted out, one live and eligible - observable: window.setInterval once, then the chip escalates for the live leg alone', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    // The counterpart to the all-opted-out SILENT case above, and the assertion
    // that pins WHERE the opted-out filter sits. It lives INSIDE the `.some()`
    // predicate, per slot, so an opted-out leg removes ITSELF and nothing else.
    // Hoisted to a whole-map filter - or inverted - this bubble would go silent,
    // and this is exactly the shape the feature targets: a group where one
    // member has STOPped and the rest are live.
    renderTimeline({
      items: [
        outboundAt(t0, {
          c1: { status: 'failed', errorCode: 'contact_opted_out' },
          c2: { status: 'sent', sentAt: new Date(t0).toISOString() },
        }),
      ],
    });
    expect(spies.set).toHaveBeenCalledTimes(1);
    const tickerId: unknown = spies.set.mock.results[0]?.value;

    act(() => {
      vi.advanceTimersByTime(PAST_THE_BOUNDARY_MS);
    });
    // The opted-out leg is out of the denominator (both presenters key on the
    // code alone), so the live leg IS the whole count - and it escalated.
    expect(screen.getByText('delivered 0/1 - 1 not confirmed')).toBeInTheDocument();
    expect(spies.clear).toHaveBeenCalledWith(tickerId);
  });

  it('a thread of only CALL cards schedules nothing - observable: window.setInterval was never called (a local mirror of the four getTimerCount tripwires in Timeline.test.tsx)', () => {
    const t0 = startFakeClock();
    const spies = spyOnIntervals();
    renderTimeline({
      items: [
        {
          kind: 'call',
          id: 'c-ring',
          at: new Date(t0).toISOString(),
          direction: 'outbound',
          call_status: 'ringing',
        },
      ],
      relayRoster: undefined,
    });
    expect(spies.set).not.toHaveBeenCalled();
  });
});
