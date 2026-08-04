// PlacementConversation tests - the placement page's three-channel switcher now
// that both 1:1 tabs are the SHARED person-centric comms pane (ContactCommsTab ->
// ContactCommsPane). This suite is NEW: before the rewire the placement hub had
// no component-level coverage at all (PlacementDetail.test mocks the comms deps
// to keep the pane quiet), so the tour side's guarantees were untested here.
// It mirrors TourConversation.test.tsx: render the component DIRECTLY with a
// hand-built `channels` stub (the real usePlacementChannels has its own suite).
//
// Covered: tab switching + draft isolation (no wrong-party send), the
// deleted-contact composer lock per pane, both "no contact" empty states, the
// emptyLabel copy, the GROUP tab rendering its relay thread RAW (the placement
// page injects no milestones on any tab, before or after the rewire), and the
// 1:1 mark-read gates (a fan-out only from a pane the operator could see).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, PlacementItem, UnitItem } from '../../api/index.js';

const getContactTimeline = vi.fn();
const getConversations = vi.fn();
const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
const getConversation = vi.fn();
const getConversationMembers = vi.fn();
const sendMessage = vi.fn();
const ensureContactConversation = vi.fn();
const provisionPlacementRelay = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversationScheduled: (...a: unknown[]) => getConversationScheduled(...a),
    getConversation: (...a: unknown[]) => getConversation(...a),
    getConversationMembers: (...a: unknown[]) => getConversationMembers(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    provisionPlacementRelay: (...a: unknown[]) => provisionPlacementRelay(...a),
    // No SSE in unit tests (both the timeline hook and the relay thread subscribe).
    useEventStream: () => {},
  };
});

import { PlacementConversation, type PlacementConversationProps } from './PlacementConversation.js';
import type { PlacementChannelsState } from './usePlacementChannels.js';

function makePlacement(over: Partial<PlacementItem> = {}): PlacementItem {
  return {
    placementId: 'p1',
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    stage: 'awaiting_inspection',
    ...over,
  };
}

function makeUnit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'unit-1',
    landlordId: 'landlord-1',
    status: 'under_application',
    address: { line1: '12 Oak St' },
    ...over,
  } as UnitItem;
}

function tenantContact(): Contact {
  return {
    contactId: 'tenant-1',
    type: 'tenant',
    status: 'searching',
    firstName: 'Ann',
    lastName: 'Tenant',
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

// The 1:1 channels report unread only (they resolve a PERSON, not one
// conversation); the group is left unresolved so the initial Group pane is the
// empty state unless a test resolves it.
function makeChannels(over: Partial<PlacementChannelsState> = {}): PlacementChannelsState {
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

function baseProps(over: Partial<PlacementConversationProps> = {}): PlacementConversationProps {
  return {
    placement: makePlacement(),
    unit: makeUnit(),
    tenant: tenantContact(),
    landlord: landlordContact(),
    channels: makeChannels(),
    // Default = the DESKTOP two-pane reading (both panes on screen), which is
    // what PlacementDetail computes above 860px. The mobile cases pass false.
    commsVisible: true,
    ...over,
  };
}

function renderConvo(props: PlacementConversationProps) {
  // MemoryRouter: a milestone pin with a refId renders a <Link>.
  return render(
    <MemoryRouter>
      <PlacementConversation {...props} />
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
  getConversationScheduled.mockResolvedValue([]);
  getConversation.mockResolvedValue({
    conversationId: 'g1',
    type: 'relay_group',
    status: 'open',
    participants: [],
  });
  getConversationMembers.mockResolvedValue([]);
  sendMessage.mockResolvedValue({ tsMsgId: 'm1', status: 'queued' });
  ensureContactConversation.mockImplementation((id: string) =>
    Promise.resolve(id === 'landlord-1' ? 'c-landlord' : 'c-tenant'),
  );
  provisionPlacementRelay.mockResolvedValue({ conversationId: 'g-new' });
});

describe('PlacementConversation - tabs and 1:1 panes', () => {
  it('defaults to Tenant with no group thread and lazily loads ONLY that feed', async () => {
    renderConvo(baseProps());

    expect(screen.getByRole('tab', { name: /Tenant - Ann/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() =>
      expect(getContactTimeline).toHaveBeenCalledWith('tenant-1', {}, expect.any(AbortSignal)),
    );
    expect(getContactTimeline).not.toHaveBeenCalledWith(
      'landlord-1',
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows the emptyLabel with the contact FULL display name when the feed is empty', async () => {
    renderConvo(baseProps());

    expect(await screen.findByText('No messages with Ann Tenant yet')).toBeInTheDocument();
  });

  it('a draft typed on Tenant does NOT carry to Landlord (no wrong-party send)', async () => {
    renderConvo(baseProps());

    await screen.findByRole('textbox', { name: 'Reply message' });
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply message' }),
      'PRIVATE note for the tenant',
    );

    // Switch WITHOUT sending: the pane remounts, so the composer is fresh.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord - Lon/ }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Landlord - Lon/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');

    // Compose + send here: it targets the LANDLORD, and the tenant draft never
    // went anywhere.
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply message' }),
      'note for the landlord',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith('c-landlord', { body: 'note for the landlord' }),
    );
    expect(
      sendMessage.mock.calls.some(
        (c) => (c[1] as { body?: string } | undefined)?.body === 'PRIVATE note for the tenant',
      ),
    ).toBe(false);
  });

  it('an unresolved landlord (no unit) shows the empty state, never a pane', async () => {
    renderConvo(baseProps({ unit: null, landlord: null }));

    await userEvent.click(screen.getByRole('tab', { name: /Landlord/ }));
    expect(
      screen.getByText('The landlord for this property is not resolved yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
  });

  it('a contact whose record failed to load shows the empty state, never a pane', async () => {
    renderConvo(baseProps({ tenant: null }));

    expect(
      await screen.findByText("We could not load the tenant's contact record."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    // The pane is what fetches a timeline - it never mounted, so nothing did.
    expect(getContactTimeline).not.toHaveBeenCalled();
  });

  it('"Comms only" is page-level: the filter survives a tab switch (spec A-M2)', async () => {
    getContactTimeline.mockResolvedValue({
      nextCursor: null,
      items: [
        {
          kind: 'milestone',
          id: '2026-07-01T00:00:00.000Z#0',
          at: '2026-07-01T00:00:00.000Z',
          type: 'stage_changed',
          label: 'Moved to Awaiting inspection',
        },
      ],
    });
    renderConvo(baseProps());

    expect(await screen.findByText('Moved to Awaiting inspection')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Comms only/i }));
    await waitFor(() =>
      expect(screen.queryByText('Moved to Awaiting inspection')).not.toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('tab', { name: /Landlord - Lon/ }));
    expect(screen.getByRole('button', { name: /Comms only/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(screen.queryByText('Moved to Awaiting inspection')).not.toBeInTheDocument(),
    );
  });
});

// The composer lock is UNIFORM across every 1:1 Timeline surface (2026-08-03
// deleted-contact resurfacing spec): a deleted contact's pane shows the standing
// restore note instead of the composer. Restoring stays on the contact page, so
// no onRestore is passed and no (dead) Restore button renders. These are the
// parity cases the tour side has had since the lock merged.
describe('PlacementConversation - deleted-contact composer lock', () => {
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

describe('PlacementConversation - group tab', () => {
  it('renders the relay thread items RAW (this page injects no milestones anywhere)', async () => {
    getConversationMessages.mockResolvedValue([
      {
        conversationId: 'g1',
        tsMsgId: '2026-07-01T10:00:00.000Z#SM1',
        provider_ts: '2026-07-01T10:00:00.000Z',
        direction: 'inbound',
        author: 'tenant',
        type: 'sms',
        body: 'Group message here',
        delivery_status: 'delivered',
      },
    ]);
    renderConvo(
      baseProps({
        placement: makePlacement({ group_thread: 'g1' }),
        channels: makeChannels({ group: { conversationId: 'g1', unread: 0 } }),
      }),
    );

    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Group message here')).toBeInTheDocument();
    // The relay transcript comes from the conversation, not the person feed.
    expect(getConversationMessages).toHaveBeenCalledWith('g1', expect.any(AbortSignal));
    expect(getContactTimeline).not.toHaveBeenCalled();
  });

  it('with no thread yet, [Open group text] provisions the relay and injects its id', async () => {
    // Group provisioning stays PAGE-LOCAL on the placement side (the tour page
    // delegates to a parent onOpenGroup): provisionPlacementRelay, then inject
    // the fresh id on the GROUP key so the relay thread mounts at once.
    const channels = makeChannels();
    renderConvo(baseProps({ channels }));

    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    expect(screen.getByText('No group text yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open group text' }));
    await waitFor(() => expect(provisionPlacementRelay).toHaveBeenCalledWith('p1'));
    await waitFor(() =>
      expect(channels.setGroupConversationId).toHaveBeenCalledWith('g-new'),
    );
  });
});

// The 1:1 mark-read fan-out (markPersonRead -> POST /api/inbox/:id/read) clears
// unread on EVERY thread the person owns, and the product has no mark-unread
// anywhere - so it is one-way data loss and must only fire when the operator
// really could have read the tab. Mirrors TourConversation.test's gate suite.
// `commsVisible` is the page's answer to "is the comms column on screen?"
// (false = the <=860px shell is showing Details, with this component still
// MOUNTED behind display:none).
describe('PlacementConversation - 1:1 mark-read gates', () => {
  const unreadTenant = () => makeChannels({ tenant: { unread: 7 } });

  it('DESKTOP: the initial 1:1 tab with unread fans out on mount, no click', async () => {
    const channels = unreadTenant();
    renderConvo(baseProps({ channels, commsVisible: true }));

    await waitFor(() =>
      expect(channels.markPersonRead).toHaveBeenCalledWith('tenant', 'tenant-1', 7),
    );
  });

  it('MOBILE: a details-first mount does NOT fan out; revealing the pane fires it once', async () => {
    const channels = unreadTenant();
    const props = baseProps({ channels, commsVisible: false });
    const { rerender } = renderConvo(props);

    await screen.findByRole('textbox', { name: 'Reply message' });
    expect(channels.markPersonRead).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <PlacementConversation {...props} commsVisible={true} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(channels.markPersonRead).toHaveBeenCalledWith('tenant', 'tenant-1', 7),
    );
    expect(channels.markPersonRead).toHaveBeenCalledTimes(1);
  });

  it('a contact whose record FAILED to load never fans out (dead-end tab, unread kept)', async () => {
    const channels = makeChannels({ landlord: { unread: 4 } });
    renderConvo(baseProps({ landlord: null, channels }));

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
    renderConvo(
      baseProps({
        placement: makePlacement({ group_thread: 'g1' }),
        channels,
        commsVisible: false,
      }),
    );

    await waitFor(() => expect(channels.markGroupRead).toHaveBeenCalledWith('g1', 5));
    expect(channels.markPersonRead).not.toHaveBeenCalled();
  });

  it('a BACKGROUND browser tab does not fan out (contact-page parity)', async () => {
    setVisibility('hidden');
    const channels = unreadTenant();
    renderConvo(baseProps({ channels, commsVisible: true }));

    await screen.findByRole('textbox', { name: 'Reply message' });
    expect(channels.markPersonRead).not.toHaveBeenCalled();
  });
});
