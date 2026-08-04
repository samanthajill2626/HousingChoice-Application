// TourConversation tests - the three-channel switcher now that both 1:1 tabs are
// the SHARED person-centric comms pane (ContactCommsTab -> ContactCommsPane).
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
//
// TourConversation is rendered DIRECTLY with a hand-built `channels` stub (the
// real useTourChannels has its own suite + TourDetail.test). Unlike before the
// rewire the 1:1 panes DO fetch - they run useContactTimeline for their contact -
// so the api barrel is mocked here now.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactTimelinePage, Tour } from '../../api/index.js';

const getContactTimeline = vi.fn();
const getConversations = vi.fn();
const getConversationMessages = vi.fn();
const sendMessage = vi.fn();
const ensureContactConversation = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    // No SSE in unit tests (the timeline hook subscribes).
    useEventStream: () => {},
  };
});

import { TourConversation, type TourConversationProps } from './TourConversation.js';
import type { TourChannelsState } from './useTourChannels.js';

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

// Both 1:1 channels report unread only (they resolve a PERSON, not one
// conversation); the group is left unresolved so the initial Group pane is the
// empty state.
function makeChannels(over: Partial<TourChannelsState> = {}): TourChannelsState {
  return {
    status: 'ready',
    group: { conversationId: null, unread: 0 },
    tenant: { unread: 0 },
    landlord: { unread: 0 },
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
    landlordId: 'landlord-1',
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
  getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
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
    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute(
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

    // The Tenant tab becomes selected and its composer shows the seeded copy.
    expect(
      await screen.findByRole('tab', { name: /Tenant/, selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(SEED);
  });

  it('re-seeds a nonce bump fired while the Tenant tab is ALREADY active (spec M1)', async () => {
    const props = baseProps({ tour: makeTour({ groupThreadId: undefined }) });
    const { rerender } = renderConvo(props);

    // Self-guided tour -> the Tenant tab is the initial tab, its pane already
    // mounted and its composer empty.
    expect(screen.getByRole('tab', { name: /Tenant/ })).toHaveAttribute('aria-selected', 'true');
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

    // Invariant 1: switching to the Landlord pane shows an EMPTY composer - the
    // seed never reaches the landlord/PM 1:1.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');

    // Invariant 2: a later MANUAL return to the Tenant tab remounts a fresh pane
    // with no seed (the one-shot seed was consumed, not persisted). This is also
    // the wrong-party-send guard: a draft never survives a tab switch.
    await userEvent.click(screen.getByRole('tab', { name: /Tenant/ }));
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
        channels: makeChannels({ landlord: { unread: 4 } }),
      }),
    );

    expect(screen.getByRole('tab', { name: /Landlord - Lon.*unread/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Tenant - Ann/ })).not.toHaveAccessibleName(/unread/i);
  });

  it('an unresolved landlord shows the empty state, never a pane', async () => {
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        landlordId: undefined,
        landlord: null,
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: /Landlord/ }));
    expect(
      screen.getByText('The landlord for this property is not resolved yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
  });

  it('a contact whose record failed to load shows the empty state, never a pane', async () => {
    renderConvo(baseProps({ tour: makeTour({ groupThreadId: undefined }), tenant: null }));

    expect(
      await screen.findByText("We could not load the tenant's contact record."),
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

    // Switch to the Landlord pane: it REMOUNTS (fresh draft), but the filter is
    // held above the remount so it is still on.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord - Lon/ }));
    expect(screen.getByRole('button', { name: /Comms only/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(screen.queryByText('Tour scheduled')).not.toBeInTheDocument());
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

    await userEvent.click(screen.getByRole('tab', { name: /Tenant/ }));
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore contact' })).toBeNull();
  });

  it('the lock is per pane: a deleted landlord locks only the landlord 1:1', async () => {
    renderConvo(baseProps({ landlord: { ...landlordContact(), deleted_at: DELETED_AT } }));

    // The (live) tenant pane still composes normally...
    await userEvent.click(screen.getByRole('tab', { name: /Tenant/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeInTheDocument();

    // ...while the deleted landlord's pane is locked.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord/ }));
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
  });
});

// The 1:1 mark-read fan-out (markPersonRead -> POST /api/inbox/:id/read) clears
// unread on EVERY thread the person owns, and the product has no mark-unread
// anywhere - so it is one-way data loss and must only fire when the operator
// really could have read the tab. These pin the three gates plus the group tab's
// deliberate exemption. `commsVisible` is the page's answer to "is the comms
// column on screen?" (false = the <=860px shell is showing Details, with this
// component still MOUNTED behind display:none).
describe('TourConversation - 1:1 mark-read gates', () => {
  const unreadTenant = () => makeChannels({ tenant: { unread: 7 } });

  it('DESKTOP: the initial 1:1 tab with unread fans out on mount, no click', async () => {
    const channels = unreadTenant();
    renderConvo(
      baseProps({ tour: makeTour({ groupThreadId: undefined }), channels, commsVisible: true }),
    );

    await waitFor(() =>
      expect(channels.markPersonRead).toHaveBeenCalledWith('tenant', 'tenant-1', 7),
    );
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
    await waitFor(() =>
      expect(channels.markPersonRead).toHaveBeenCalledWith('tenant', 'tenant-1', 7),
    );
    expect(channels.markPersonRead).toHaveBeenCalledTimes(1);
  });

  it('a contact whose record FAILED to load never fans out (dead-end tab, unread kept)', async () => {
    // The adversarial probe, inverted: landlord id resolved, landlord record
    // null, landlord unread 4, one click on the Landlord tab.
    const channels = makeChannels({ landlord: { unread: 4 } });
    renderConvo(
      baseProps({
        tour: makeTour({ groupThreadId: undefined }),
        landlord: null,
        landlordId: 'landlord-1',
        channels,
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: /Landlord/ }));
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    // Scoped to the LANDLORD: the initial (loaded, unread-0) Tenant tab legitimately
    // calls through and the hook no-ops it, which is not what this pins.
    expect(channels.markPersonRead).not.toHaveBeenCalledWith('landlord', 'landlord-1', 4);
    expect(channels.markPersonRead).not.toHaveBeenCalledWith(
      'landlord',
      expect.anything(),
      expect.anything(),
    );
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
});
