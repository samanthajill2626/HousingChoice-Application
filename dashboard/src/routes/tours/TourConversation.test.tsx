// TourConversation tests - the channel switcher: the relay group plus ONE 1:1 tab
// per person the page resolves (keyed by contactId, labelled with that person's
// display name), each 1:1 being the SHARED person-centric comms pane
// (ContactCommsTab -> ContactCommsPane).
// Verifies the properties the rewire had to preserve or newly guarantee:
//   1) TENANT ONLY seed: a noShowDraft nonce bump selects the Tenant tab and
//      prefills the tenant composer (never the landlord/PM pane) - including a
//      bump fired while the Tenant tab is ALREADY active (spec M1: the pane keys
//      on `${tenantId}:${seedKey}`, so the nonce still remounts it).
//   2) ONE-SHOT: the seed is consumed on mount, so a later MANUAL return to the
//      Tenant tab starts with an EMPTY composer, and a draft never crosses tabs.
//   3) The deleted-contact composer lock survives the rewrite, per pane.
//   4) "Comms only" is page-level state ABOVE the remount, so it survives a tab
//      switch (Timeline's own copy is per-mount).
//   5) The 1:1 mark-read fan-out only fires from a pane the operator could
//      actually see: commsVisible + a LOADED contact + a foreground browser tab.
//      The group tab's single-conversation read is exempt.
//   6) The rail is driven by `channels.people`: one tab per person, no tab for a
//      person the page cannot resolve, selection falls back to Group when the
//      active person leaves the list, and an unread that scrolls off the right
//      edge is carried by a dot at that edge (spec 6.6).
//
// TourConversation is rendered DIRECTLY with a hand-built `channels` stub (the
// real useTourChannels has its own suite + TourDetail.test). Unlike before the
// rewire the 1:1 panes DO fetch - they run useContactTimeline for their contact -
// so the api barrel is mocked here now.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactTimelinePage, Tour } from '../../api/index.js';

const getContactTimeline = vi.fn();
const getAllConversations = vi.fn();
const getConversationMessages = vi.fn();
const sendMessage = vi.fn();
const ensureContactConversation = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getAllConversations: (...a: unknown[]) => getAllConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    // No SSE in unit tests (the timeline hook subscribes).
    useEventStream: () => {},
  };
});

import { TourConversation, type TourConversationProps } from './TourConversation.js';
import type { PersonChannel, TourChannelsState } from './useTourChannels.js';

const SEED = 'Hi! We noticed you may have missed your tour. Want to reschedule?';

function makeTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-abc',
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    scheduledAt: '2026-07-10T14:00:00Z',
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: '2026-07-01T10:00:00Z',
    groupThreadId: 'g1',
    ...over,
  };
}

function tenantContact(): Contact {
  return {
    contactId: 'tenant-1',
    type: 'tenant',
    status: 'searching',
    firstName: 'Ann',
    lastName: 'Tenant',
    voucherSize: 2,
    phone: '+14045550111',
  };
}

function landlordContact(): Contact {
  return {
    contactId: 'landlord-1',
    type: 'landlord',
    firstName: 'Lon',
    lastName: 'Landlord',
    phone: '+14045550222',
  };
}

/** A person feed carrying ONE lifecycle pin - the server-side write of this
 *  tour's events, which is what replaced the old client-side injection. */
function pinnedFeed(label: string): ContactTimelinePage {
  return {
    nextCursor: null,
    items: [
      {
        kind: 'milestone',
        id: '2026-07-01T00:00:00.000Z#a',
        at: '2026-07-01T00:00:00.000Z',
        type: 'tour_scheduled',
        label,
      },
    ],
  };
}

/** What TourDetail resolves today: the tenant + the property's landlord, keyed by
 *  contactId and labelled with the DISPLAY NAME (never a role word). */
function people(): PersonChannel[] {
  return [
    { contactId: 'tenant-1', label: 'Ann Tenant', unread: 0 },
    { contactId: 'landlord-1', label: 'Lon Landlord', unread: 0 },
  ];
}

/** The same two people with ONE person's unread raised. */
function peopleWith(contactId: string, unread: number): PersonChannel[] {
  return people().map((p) => (p.contactId === contactId ? { ...p, unread } : p));
}

// Person channels report unread only (they resolve a PERSON, not one
// conversation); the group is left unresolved so the initial Group pane is the
// empty state.
function makeChannels(over: Partial<TourChannelsState> = {}): TourChannelsState {
  return {
    status: 'ready',
    group: { conversationId: null, unread: 0 },
    people: people(),
    setGroupConversationId: vi.fn(),
    markGroupRead: vi.fn(),
    markPersonRead: vi.fn(),
    ...over,
  };
}

function baseProps(over: Partial<TourConversationProps> = {}): TourConversationProps {
  return {
    tour: makeTour(),
    tenant: tenantContact(),
    landlord: landlordContact(),
    channels: makeChannels(),
    onOpenGroup: vi.fn(),
    openGroupBusy: false,
    // Default = the DESKTOP two-pane reading (both panes on screen), which is
    // what TourDetail computes above 860px. The mobile cases pass false.
    commsVisible: true,
    ...over,
  };
}

function renderConvo(props: TourConversationProps, draft?: TourConversationProps['noShowDraft']) {
  return render(
    <MemoryRouter>
      <TourConversation {...props} {...(draft !== undefined && { noShowDraft: draft })} />
    </MemoryRouter>,
  );
}

/** jsdom's document is always 'visible'; the mark-read gate mirrors the contact
 *  page's document.visibilityState check, so one test drives it. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  setVisibility('visible');
  getContactTimeline.mockResolvedValue({ items: [], nextCursor: null });
  getAllConversations.mockResolvedValue([]);
  getConversationMessages.mockResolvedValue([]);
  sendMessage.mockResolvedValue({ tsMsgId: 'm1', status: 'queued' });
  ensureContactConversation.mockResolvedValue('c-new');
});

describe('TourConversation - no-show check-in seed', () => {
  it('switches to the tenant tab and seeds the composer when noShowDraft nonce bumps', async () => {
    const props = baseProps();
    const { rerender } = renderConvo(props);

    // Starts on the Group tab (the tour has a groupThreadId); no tenant composer
    // is mounted yet, so nothing is seeded.
    expect(screen.getByRole('tab', { name: 'Relay group' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).not.toBeInTheDocument();

    // A "Send no-show check-in" click bumps the nonce.
    rerender(
      <MemoryRouter>
        <TourConversation {...props} noShowDraft={{ body: SEED, nonce: 1 }} />
      </MemoryRouter>,
    );

    // The tenant's tab becomes selected and its composer shows the seeded copy.
    expect(
      await screen.findByRole('tab', { name: /Ann Tenant/, selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(SEED);
  });

  it('re-seeds a nonce bump fired while the Tenant tab is ALREADY active (spec M1)', async () => {
    const props = baseProps({ tour: makeTour({ groupThreadId: undefined }) });
    const { rerender } = renderConvo(props);

    // Self-guided tour -> the tenant's tab is the initial tab, its pane already
    // mounted and its composer empty.
    expect(screen.getByRole('tab', { name: /Ann Tenant/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('textbox', { name: 'Reply message' })).toHaveValue('');

    // "Send no-show check-in" with no tab change to ride: the seed key alone must
    // remount the pane (initialDraft is a MOUNT-ONLY initializer).
    rerender(
      <MemoryRouter>
        <TourConversation {...props} noShowDraft={{ body: SEED, nonce: 1 }} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(SEED),
    );
  });

  it('never seeds the landlord pane, and a later return to Tenant starts EMPTY', async () => {
    const props = baseProps();
    const { rerender } = renderConvo(props);
    rerender(
      <MemoryRouter>
        <TourConversation {...props} noShowDraft={{ body: SEED, nonce: 1 }} />
      </MemoryRouter>,
    );
    // Seeded once on the tenant pane.
    expect(await screen.findByRole('textbox', { name: 'Reply message' })).toHaveValue(SEED);

    // Invariant 1: switching to the landlord's pane shows an EMPTY composer - the
    // seed never reaches the landlord/PM 1:1.
    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');

    // Invariant 2: a later MANUAL return to the tenant's tab remounts a fresh
    // pane with no seed (the one-shot seed was consumed, not persisted). This is
    // also the wrong-party-send guard: a draft never survives a tab switch.
    await userEvent.click(screen.getByRole('tab', { name: /Ann Tenant/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');
  });
});

describe('TourConversation - 1:1 panes', () => {
  it('shows the emptyLabel with the contact FULL display name when the feed is empty', async () => {
    renderConvo(baseProps({ tour: makeTour({ groupThreadId: undefined }) }));

    expect(await screen.findByText('No messages with Ann Tenant yet')).toBeInTheDocument();
  });

  it('renders the person feed pins - no client-side milestone injection remains', async () => {
    getContactTimeline.mockResolvedValue(pinnedFeed('Tour scheduled'));
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        tourMilestones: [
          {
            kind: 'milestone',
            id: 'inj-1',
            at: '2026-07-01T00:00:00.000Z',
            type: 'tour_scheduled',
            label: 'INJECTED pin',
          },
        ],
      }),
    );

    // The pin comes from the PERSON feed...
    expect(await screen.findByText('Tour scheduled')).toBeInTheDocument();
    // ...and tourMilestones never reaches a 1:1 pane (the pane has no injection
    // prop at all - the group tab is its only consumer now).
    expect(screen.queryByText('INJECTED pin')).not.toBeInTheDocument();
  });

  it('shows the unread dot from the channel aggregate', () => {
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        channels: makeChannels({ people: peopleWith('landlord-1', 4) }),
      }),
    );

    expect(screen.getByRole('tab', { name: /Lon Landlord.*unread/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ann Tenant/ })).not.toHaveAccessibleName(/unread/i);
  });

  it('a landlord the page cannot resolve gets NO tab at all (people drives the rail)', () => {
    // The unit has no landlordId, so the page puts nobody but the tenant on the
    // channels - and a person with no id can no longer own an empty dead-end tab.
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        landlord: null,
        channels: makeChannels({ people: [{ contactId: 'tenant-1', label: 'Ann Tenant', unread: 0 }] }),
      }),
    );

    expect(screen.queryByRole('tab', { name: /Landlord/i })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('a contact whose record failed to load shows the empty state, never a pane', async () => {
    renderConvo(baseProps({ tour: makeTour({ groupThreadId: undefined }), tenant: null }));

    expect(
      await screen.findByText("We could not load Ann Tenant's contact record."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    // The pane is what fetches a timeline - it never mounted, so nothing did.
    expect(getContactTimeline).not.toHaveBeenCalled();
  });

  it('"Comms only" is page-level: the filter survives a tab switch (spec A-M2)', async () => {
    getContactTimeline.mockResolvedValue(pinnedFeed('Tour scheduled'));
    renderConvo(baseProps({ tour: makeTour({ groupThreadId: undefined }) }));

    expect(await screen.findByText('Tour scheduled')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Comms only/i }));
    await waitFor(() => expect(screen.queryByText('Tour scheduled')).not.toBeInTheDocument());

    // Switch to the landlord's pane: it REMOUNTS (fresh draft), but the filter is
    // held above the remount so it is still on.
    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    expect(screen.getByRole('button', { name: /Comms only/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(screen.queryByText('Tour scheduled')).not.toBeInTheDocument());
  });
});

// The rail is a pure projection of `channels.people` - no fixed tenant/landlord
// slots, no role words, no type-derived PM label. The page owns WHO is on the
// tour; this component only renders them.
describe('TourConversation - id-keyed person tabs', () => {
  it('renders one 1:1 tab per person input, keyed by contactId', async () => {
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        channels: makeChannels({
          people: [
            { contactId: 'tenant-1', label: 'Tasha Nguyen', unread: 0 },
            { contactId: 'landlord-1', label: 'Marcus Webb', unread: 0 },
          ],
        }),
      }),
    );

    expect(await screen.findByRole('tab', { name: /Tasha Nguyen/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Marcus Webb/ })).toBeInTheDocument();
    // The labels are DISPLAY NAMES: no role word survives on either tab.
    expect(screen.queryByRole('tab', { name: /Tenant|Landlord|PM/ })).toBeNull();
  });

  it('falls back to the Group tab when the active person leaves the people list', async () => {
    const props = baseProps();
    const { rerender } = renderConvo(props);

    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    expect(screen.getByRole('tab', { name: /Lon Landlord/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // The landlord is removed from the roster while their tab is selected.
    const trimmed = {
      ...props,
      channels: makeChannels({
        people: [{ contactId: 'tenant-1', label: 'Ann Tenant', unread: 0 }],
      }),
    };
    rerender(
      <MemoryRouter>
        <TourConversation {...trimmed} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('tab', { name: /Lon Landlord/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Relay group' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('No relay group yet')).toBeInTheDocument();
  });
});

// One row that SCROLLS (never wraps), with the overflow marked by an edge fade -
// and if a tab hidden past that edge has unread, the edge carries its dot so a
// reply can never hide off-screen (spec 6.6).
describe('TourConversation - scrolling tab rail', () => {
  // Five tabs 60px apart in a 200px rail whose content is 300px wide: tabs 0-2
  // are comfortably on screen, tabs 3-4 sit past the 24px fade at x=176.
  const RAIL_WIDTH = 200;
  const RAIL_CONTENT = 300;
  const TAB_PITCH = 60;
  const TAB_WIDTH = 50;
  const CARRIED = 'Unread messages past the edge of the channel list';

  function rectOf(left: number, right: number): DOMRect {
    return {
      x: left,
      y: 0,
      left,
      right,
      top: 0,
      bottom: 0,
      width: right - left,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** The rail's stubbed scrollWidth - mutable so a test can "resize" it. */
  let railContent = RAIL_WIDTH;

  /** jsdom does no layout, so drive the rail's overflow geometry ourselves: a
   *  RAIL_WIDTH-wide rail whose tabs sit TAB_PITCH apart, so the later tabs are
   *  off the right edge. `contentWidth` decides whether the rail overflows at
   *  all. Returns the undo. */
  function stubRailGeometry(contentWidth: number): () => void {
    railContent = contentWidth;
    const rects = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function boundingRect(this: HTMLElement): DOMRect {
        const role = this.getAttribute('role');
        if (role === 'tablist') return rectOf(0, RAIL_WIDTH);
        if (role === 'tab') {
          const i = Array.prototype.indexOf.call(this.parentElement?.children ?? [], this);
          return rectOf(i * TAB_PITCH, i * TAB_PITCH + TAB_WIDTH);
        }
        return rectOf(0, 0);
      });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'tablist' ? RAIL_WIDTH : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'tablist' ? railContent : 0;
      },
    });
    return () => {
      rects.mockRestore();
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    };
  }

  /** Five tabs (group + four people); `unreadFor` raises one person's unread. */
  function fiveTabs(unreadFor: string, unread: number): TourConversationProps {
    const roster: PersonChannel[] = [
      { contactId: 'tenant-1', label: 'Ann Tenant', unread: 0 },
      { contactId: 'landlord-1', label: 'Lon Landlord', unread: 0 },
      { contactId: 'pm-1', label: 'Pat Manager', unread: 0 },
      { contactId: 'sup-1', label: 'Sam Support', unread: 0 },
    ];
    return baseProps({
      channels: makeChannels({
        people: roster.map((p) => (p.contactId === unreadFor ? { ...p, unread } : p)),
      }),
    });
  }

  let undo: () => void = () => {};
  afterEach(() => undo());

  it('carries the unread dot of a tab hidden past the right edge', () => {
    // The 5th tab (Sam, at x=240) is past the 200px-wide rail entirely.
    undo = stubRailGeometry(RAIL_CONTENT);
    renderConvo(fiveTabs('sup-1', 3));

    expect(screen.getByText(CARRIED)).toBeInTheDocument();
  });

  it('carries nothing when every unread tab is on screen', () => {
    // The tenant's tab (x=60..110) is visible, so its own dot is enough.
    undo = stubRailGeometry(RAIL_CONTENT);
    renderConvo(fiveTabs('tenant-1', 3));

    expect(screen.queryByText(CARRIED)).toBeNull();
  });

  it('carries nothing when the rail does not overflow', () => {
    // Same tab offsets, but the content fits: there is no edge to hide behind.
    undo = stubRailGeometry(RAIL_WIDTH);
    renderConvo(fiveTabs('sup-1', 3));

    expect(screen.queryByText(CARRIED)).toBeNull();
  });

  it('re-measures on resize (the window narrows until the rail overflows)', async () => {
    undo = stubRailGeometry(RAIL_WIDTH);
    renderConvo(fiveTabs('sup-1', 3));
    expect(screen.queryByText(CARRIED)).toBeNull();

    // The pane narrows (an operator drags the window, or the shell flips to its
    // one-column layout) and the same tabs no longer fit.
    railContent = RAIL_CONTENT;
    window.dispatchEvent(new Event('resize'));

    expect(await screen.findByText(CARRIED)).toBeInTheDocument();
  });

  it('re-measures when the rail element itself changes box (pane switch reveals a hidden rail - no window event fires)', async () => {
    // At phone widths the hubs mount on the Details pane with the rail
    // display:none (0x0). Tapping [Conversation] only flips visibility: no
    // window resize, no scroll. The component must observe ITS OWN element
    // box (ResizeObserver) or the fade/carried dot are wrong on pane entry.
    // jsdom has no ResizeObserver - install a recording fake and drive it.
    const callbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        callbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      undo = stubRailGeometry(RAIL_WIDTH); // mounts "hidden": content fits, no fade
      renderConvo(fiveTabs('sup-1', 3));
      expect(screen.queryByText(CARRIED)).toBeNull();
      expect(callbacks.length).toBeGreaterThan(0); // the rail IS observed

      // The pane toggle reveals the rail at its real (overflowing) size.
      railContent = RAIL_CONTENT;
      act(() => {
        for (const cb of callbacks) cb([], {} as unknown as ResizeObserver);
      });

      expect(await screen.findByText(CARRIED)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The composer lock is UNIFORM across every 1:1 Timeline surface (2026-08-03
// deleted-contact resurfacing spec, human-approved scope amendment): a deleted
// contact's pane shows the standing restore note instead of the composer here
// exactly as on the contact page. Restoring itself stays on the contact page, so
// no onRestore is passed and no (dead) Restore button renders.
describe('TourConversation - deleted-contact composer lock', () => {
  const DELETED_AT = '2026-08-01T00:00:00.000Z';

  it('a soft-deleted tenant locks the tenant 1:1: note shown, no Reply textbox, no dead Restore', async () => {
    renderConvo(baseProps({ tenant: { ...tenantContact(), deleted_at: DELETED_AT } }));

    await userEvent.click(screen.getByRole('tab', { name: /Ann Tenant/ }));
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore contact' })).toBeNull();
  });

  it('the lock is per pane: a deleted landlord locks only the landlord 1:1', async () => {
    renderConvo(baseProps({ landlord: { ...landlordContact(), deleted_at: DELETED_AT } }));

    // The (live) tenant pane still composes normally...
    await userEvent.click(screen.getByRole('tab', { name: /Ann Tenant/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeInTheDocument();

    // ...while the deleted landlord's pane is locked.
    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
  });
});

// The 1:1 mark-read fan-out (markPersonRead -> POST /api/inbox/:id/read) clears
// unread on EVERY thread the person owns, and the product has no mark-unread
// anywhere - so it is one-way data loss and must only fire when the operator
// really could have read the tab. These pin the four gates plus the group tab's
// deliberate exemption. `commsVisible` is the page's answer to "is the comms
// column on screen?" (false = the <=860px shell is showing Details, with this
// component still MOUNTED behind display:none). The gate itself lives in
// ContactCommsTab (only IT can see the pane's timeline status); these drive it
// through the page, which is the surface the behavior is claimed on.
describe('TourConversation - 1:1 mark-read gates', () => {
  const unreadTenant = () => makeChannels({ people: peopleWith('tenant-1', 7) });

  it('DESKTOP: the initial 1:1 tab with unread fans out on mount, no click', async () => {
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );

    await waitFor(() => expect(channels.markPersonRead).toHaveBeenCalledWith('tenant-1', 7));
  });

  it('MOBILE: a details-first mount does NOT fan out; revealing the pane fires it once', async () => {
    const channels = unreadTenant();
    const props = baseProps({
      tour: makeTour({ groupThreadId: undefined }),
      channels,
      commsVisible: false,
    });
    const { rerender } = renderConvo(props);

    // The whole comms column is display:none behind the Details pane. Mounting it
    // is not reading it - the tenant's inbox row must be untouched.
    await screen.findByRole('textbox', { name: 'Reply message' });
    expect(channels.markPersonRead).not.toHaveBeenCalled();

    // The operator taps "Conversation": now the pane is genuinely on screen.
    rerender(
      <MemoryRouter>
        <TourConversation {...props} commsVisible={true} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(channels.markPersonRead).toHaveBeenCalledWith('tenant-1', 7));
    expect(channels.markPersonRead).toHaveBeenCalledTimes(1);
  });

  it('a contact whose record FAILED to load never fans out (dead-end tab, unread kept)', async () => {
    // The adversarial probe, inverted: the landlord is on the channels with
    // unread 4, their contact record is null, one click on their tab.
    const channels = makeChannels({ people: peopleWith('landlord-1', 4) });
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        landlord: null,
        channels,
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    // Scoped to the LANDLORD: the initial (loaded, unread-0) tenant tab legitimately
    // calls through and the hook no-ops it, which is not what this pins.
    expect(channels.markPersonRead).not.toHaveBeenCalledWith('landlord-1', 4);
    expect(channels.markPersonRead).not.toHaveBeenCalledWith('landlord-1', expect.anything());
  });

  it('the GROUP tab is unaffected by the visibility gate (single-conversation read)', async () => {
    const channels = makeChannels({ group: { conversationId: 'g1', unread: 5 } });
    renderConvo(baseProps({ channels, commsVisible: false }));

    // Group tab is initial (the tour has a groupThreadId). Its read is a
    // single-conversation markConversationRead that predates this pane, so the
    // 1:1 gates deliberately do not apply to it.
    await waitFor(() => expect(channels.markGroupRead).toHaveBeenCalledWith('g1', 5));
    expect(channels.markPersonRead).not.toHaveBeenCalled();
  });

  it('a BACKGROUND browser tab does not fan out (contact-page parity)', async () => {
    // Same idiom + same guard as useMarkContactRead.test's setVisibility.
    setVisibility('hidden');
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );
    await screen.findByRole('textbox', { name: 'Reply message' });
    expect(channels.markPersonRead).not.toHaveBeenCalled();
  });

  it('foregrounding the browser tab again DOES fan out (visibilitychange re-fire)', async () => {
    // The quiescent case: texts land while the operator is in another browser
    // tab, the gate withholds the mark, then the tenant stops texting. Nothing
    // re-renders a React tree because a browser tab was foregrounded, so without
    // a visibilitychange listener the operator could read the whole pane and the
    // dot would sit there until some unrelated render happened to occur.
    setVisibility('hidden');
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );
    await screen.findByRole('textbox', { name: 'Reply message' });
    expect(channels.markPersonRead).not.toHaveBeenCalled();

    // Same idiom as useMarkContactRead.test: flip the state, dispatch the event.
    setVisibility('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await waitFor(() =>
      expect(channels.markPersonRead).toHaveBeenCalledWith('tenant-1', 7),
    );
  });

  it('a PENDING timeline does not fan out - the tab dot outlives an unrendered pane', async () => {
    // The tab dot and the transcript are DIFFERENT requests: getConversations has
    // already said unread 7, but GET /api/contacts/:id/timeline is still open, so
    // there is nothing on screen for the operator to have read.
    getContactTimeline.mockReturnValue(new Promise(() => {}));
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );

    // Anchor on the pane's own loading state so this is not a race won by luck.
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(channels.markPersonRead).not.toHaveBeenCalled();
  });

  it('a FAILED timeline NEVER fans out (an error pane means nothing was read)', async () => {
    // The M1 repro: the cheap inbox count says 7 unread while the expensive
    // /timeline route 500s. The pane renders the error paragraph and NO
    // transcript - marking here would zero every thread this person owns, in one
    // direction, for messages nobody ever saw.
    getContactTimeline.mockRejectedValue(new Error('timeline 500'));
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );

    expect(await screen.findByText(/couldn't load this timeline/i)).toBeInTheDocument();
    expect(channels.markPersonRead).not.toHaveBeenCalled();
    // And it stays withheld - 'error' is terminal for this mount, not a delay.
    await act(async () => {});
    expect(channels.markPersonRead).not.toHaveBeenCalled();
  });

  it('the fan-out fires exactly ONCE, and only once the timeline resolves READY', async () => {
    // The success path, deferred: hold /timeline open (mark withheld), then let it
    // land and watch the SAME mount fan out - one call, on the ready commit.
    let land: (page: ContactTimelinePage) => void = () => {};
    getContactTimeline.mockReturnValue(
      new Promise<ContactTimelinePage>((res) => {
        land = res;
      }),
    );
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );

    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(channels.markPersonRead).not.toHaveBeenCalled();

    await act(async () => {
      land({ nextCursor: null, items: [] });
    });

    await waitFor(() =>
      expect(channels.markPersonRead).toHaveBeenCalledWith('tenant-1', 7),
    );
    expect(channels.markPersonRead).toHaveBeenCalledTimes(1);
  });
});
