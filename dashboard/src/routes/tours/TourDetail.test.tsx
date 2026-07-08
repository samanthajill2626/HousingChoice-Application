// TourDetail component tests - the rebuilt two-pane tour page. Verifies:
//   - the status-aware PRIMARY CTA ladder (Book / Mark toured / Record outcome /
//     Start placement / View placement / none) + the kebab guards
//   - the three-channel switcher: initial tab, never-auto-switch, unread dots,
//     SINGLE-conversation mark-read (never the inbox fan-out), composer targeting,
//     lazy-load, and the group + 1:1 empty states (open-group / create-on-demand)
//   - the right-column cards (routing chip + fallback warning, People, Guidance,
//     Outcome) + the mobile initial pane = Details
//   - not-found
//
// Pattern mirrors PlacementDetail.test / the old TourDetail.test: mock the api
// barrel, import after mocking, assert accessibility-first.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, Tour, UnitItem } from '../../api/index.js';

const getTour = vi.fn();
const getUnit = vi.fn();
const getContact = vi.fn();
const getConversations = vi.fn();
const getTourActivity = vi.fn();
const getTourReminders = vi.fn();
const getConversationMessages = vi.fn();
const getConversation = vi.fn();
const getConversationMembers = vi.fn();
const patchTour = vi.fn();
const createTourRelay = vi.fn();
const createPlacementFromTour = vi.fn();
const ensureContactConversation = vi.fn();
const sendMessage = vi.fn();
const markConversationRead = vi.fn();
const markInboxRead = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTour: (...a: unknown[]) => getTour(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getConversations: (...a: unknown[]) => getConversations(...a),
    getTourActivity: (...a: unknown[]) => getTourActivity(...a),
    getTourReminders: (...a: unknown[]) => getTourReminders(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversation: (...a: unknown[]) => getConversation(...a),
    getConversationMembers: (...a: unknown[]) => getConversationMembers(...a),
    patchTour: (...a: unknown[]) => patchTour(...a),
    createTourRelay: (...a: unknown[]) => createTourRelay(...a),
    createPlacementFromTour: (...a: unknown[]) => createPlacementFromTour(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
  };
});

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateSpy };
});

import { TourDetail } from './TourDetail.js';

function makeTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-abc',
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    scheduledAt: '2026-07-10T14:00:00Z',
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: '2026-07-01T10:00:00Z',
    ...over,
  };
}

function makeUnit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'unit-1',
    landlordId: 'landlord-1',
    status: 'available',
    address: { line1: '123 Main St', city: 'Atlanta', state: 'GA' },
    beds: 2,
    rent_min: 1400,
    rent_max: 1600,
    tour_process: 'Lockbox on the front door.',
    application_process: 'Apply online after the visit.',
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

/** A 1:1 conversation summary for a contact. */
function conv(conversationId: string, contactId: string, unread = 0, type = 'tenant_1to1') {
  return {
    conversationId,
    type,
    participant_phone: '+14045550111',
    participants: [{ contactId, phone: '+14045550111' }],
    preview: null,
    last_activity_at: '2026-07-05T00:00:00Z',
    unread_count: unread,
    assignment: null,
    sms_opt_out: false,
    participant_display_name: null,
  };
}

function renderDetail(tourId = 'tour-abc') {
  return render(
    <MemoryRouter initialEntries={[`/tours/${tourId}`]}>
      <Routes>
        <Route path="/tours/:tourId" element={<TourDetail />} />
        <Route path="/placements/:placementId" element={<div>Placement page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Wait for the loaded page (past the loading spinner). */
async function waitLoaded() {
  await screen.findByRole('link', { name: 'Back to tours' });
}

beforeEach(() => {
  vi.clearAllMocks();
  getTour.mockResolvedValue(makeTour());
  getUnit.mockResolvedValue(makeUnit());
  getContact.mockImplementation((id: string) =>
    Promise.resolve(id === 'landlord-1' ? landlordContact() : tenantContact()),
  );
  getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
  getTourActivity.mockResolvedValue([]);
  getTourReminders.mockResolvedValue({ reminders: [] });
  getConversationMessages.mockResolvedValue([]);
  getConversation.mockResolvedValue({
    conversationId: 'g1',
    type: 'relay_group',
    status: 'open',
    participants: [],
  });
  getConversationMembers.mockResolvedValue([]);
  markConversationRead.mockResolvedValue(undefined);
});

describe('TourDetail - load + header', () => {
  it('shows a loading spinner while the tour is fetching', () => {
    getTour.mockReturnValue(new Promise(() => {}));
    renderDetail();
    // The back crumb only appears once loaded.
    expect(screen.queryByRole('link', { name: 'Back to tours' })).not.toBeInTheDocument();
  });

  it('renders the identity, status badge, and facts once loaded', async () => {
    renderDetail();
    await waitLoaded();
    expect(screen.getByText('Tour - 123 Main St, Atlanta, GA')).toBeInTheDocument();
    // The tour StatusBadge (kind=tour) shows the status label.
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    // Facts line: when - type - tenant -> address.
    expect(screen.getByText(/Self-guided - Ann Tenant -> 123 Main St/)).toBeInTheDocument();
  });

  it('shows a not-found panel on a 404', async () => {
    getTour.mockRejectedValue(new ApiError(404, 'tour_not_found', 'tour_not_found'));
    renderDetail();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't find this tour/i);
  });
});

describe('TourDetail - primary CTA ladder', () => {
  it('requested -> Book tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('button', { name: 'Book tour' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark toured' })).not.toBeInTheDocument();
    // Not booked shows in the facts + Schedule card.
    expect(screen.getByText(/Not booked - Self-guided/)).toBeInTheDocument();
  });

  it('scheduled -> Mark toured', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('button', { name: 'Mark toured' })).toBeInTheDocument();
  });

  it('toured without an outcome -> Record outcome', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('button', { name: 'Record outcome' })).toBeInTheDocument();
  });

  it('convertible + not converted -> Start placement', async () => {
    getTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    renderDetail();
    await waitLoaded();
    // Header CTA + Outcome-card button both say "Start placement".
    expect(screen.getAllByRole('button', { name: 'Start placement' }).length).toBeGreaterThanOrEqual(1);
  });

  it('converted -> View placement link (header) + Outcome-card placement row', async () => {
    getTour.mockResolvedValue(
      makeTour({
        status: 'closed',
        outcome: 'move_forward',
        moveForward: true,
        convertible: true,
        convertedPlacementId: 'plc-77',
      }),
    );
    renderDetail();
    await waitLoaded();
    const link = screen.getByRole('link', { name: 'View placement' });
    expect(link).toHaveAttribute('href', '/placements/plc-77');
    expect(screen.getByRole('link', { name: 'View the placement' })).toHaveAttribute(
      'href',
      '/placements/plc-77',
    );
  });

  it('a canceled tour has no primary CTA', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'canceled' }));
    renderDetail();
    await waitLoaded();
    for (const name of ['Book tour', 'Mark toured', 'Record outcome', 'Start placement', 'View placement']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('Mark toured PATCHes { status: toured } and applies the returned tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Mark toured' }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'toured' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record outcome' })).toBeInTheDocument());
  });

  it('Start placement converts then navigates to the new placement', async () => {
    getTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockResolvedValue({
      placement: { placementId: 'plc-abc' },
      tour: makeTour({ status: 'closed', convertedPlacementId: 'plc-abc' }),
    });
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getAllByRole('button', { name: 'Start placement' })[0]!);
    expect(createPlacementFromTour).toHaveBeenCalledWith('tour-abc');
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/placements/plc-abc'));
  });

  it('a convert failure surfaces role=alert and does NOT navigate', async () => {
    getTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockRejectedValue(new ApiError(409, 'tour_already_converted', 'tour_already_converted'));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getAllByRole('button', { name: 'Start placement' })[0]!);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/tour_already_converted/i));
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe('TourDetail - kebab guards', () => {
  async function openKebab() {
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  }

  it('scheduled: Reschedule + Cancel + Mark no-show (no Open group when a group exists)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({ conversations: [conv('g1', 'tenant-1', 0, 'relay_group')], nextCursor: null });
    renderDetail();
    await waitLoaded();
    await openKebab();
    expect(screen.getByRole('menuitem', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cancel tour' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark no-show' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Open group text' })).not.toBeInTheDocument();
  });

  it('requested: Cancel + Open group text; NO Reschedule, NO Mark no-show', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    renderDetail();
    await waitLoaded();
    await openKebab();
    expect(screen.getByRole('menuitem', { name: 'Cancel tour' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open group text' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reschedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mark no-show' })).not.toBeInTheDocument();
  });

  it('a closed tour with a group has no kebab at all', async () => {
    getTour.mockResolvedValue(
      makeTour({ status: 'closed', groupThreadId: 'g1', outcome: 'not_a_fit', moveForward: false }),
    );
    getConversations.mockResolvedValue({ conversations: [conv('g1', 'tenant-1', 0, 'relay_group')], nextCursor: null });
    renderDetail();
    await waitLoaded();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('Cancel (kebab) opens the confirm modal and PATCHes { status: canceled }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'canceled' }));
    renderDetail();
    await waitLoaded();
    await openKebab();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel tour' }));
    // Confirm dialog.
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel tour' }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'canceled' });
  });

  it('Mark no-show (kebab) PATCHes { status: no_show }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'no_show' }));
    renderDetail();
    await waitLoaded();
    await openKebab();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark no-show' }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'no_show' });
  });
});

describe('TourDetail - Book / Reschedule / Record outcome modals', () => {
  it('Book opens a modal and PATCHes { scheduledAt, status: scheduled }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    patchTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Book tour' }));
    expect(screen.getByRole('form', { name: 'Book tour form' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Date and time'), '2026-07-20T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(patchTour).toHaveBeenCalledWith(
      'tour-abc',
      expect.objectContaining({ scheduledAt: expect.stringContaining('2026-07-20'), status: 'scheduled' }),
    );
  });

  it('Reschedule (Schedule-card action) PATCHes { scheduledAt, status: scheduled }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'scheduled', scheduledAt: '2026-07-20T10:00:00Z' }));
    renderDetail();
    await waitLoaded();
    // The Schedule card exposes a Reschedule action (aria-label "Reschedule tour").
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule tour' }));
    expect(screen.getByRole('form', { name: 'Reschedule tour form' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('New date and time'), '2026-07-20T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm reschedule' }));
    expect(patchTour).toHaveBeenCalledWith(
      'tour-abc',
      expect.objectContaining({ scheduledAt: expect.stringContaining('2026-07-20'), status: 'scheduled' }),
    );
  });

  it('Record outcome "Yes - move forward" PATCHes { outcome, moveForward }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    expect(screen.getByRole('group', { name: /Moving forward with this property/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Yes - move forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', { outcome: 'move_forward', moveForward: true });
  });

  it('Record outcome "No - not a fit" ALSO closes the tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    patchTour.mockResolvedValue(makeTour({ status: 'closed', outcome: 'not_a_fit', moveForward: false }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'No - not a fit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', {
      outcome: 'not_a_fit',
      moveForward: false,
      status: 'closed',
    });
  });
});

describe('TourDetail - right column cards', () => {
  it('self-guided shows the Guidance card with the ID-gate lead + reminders route to the tenant 1:1', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided' }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByText('Self-guided tour')).toBeInTheDocument();
    expect(screen.getByText('Photo ID before lockbox code - always.')).toBeInTheDocument();
    expect(screen.getByText('reminders -> tenant 1:1')).toBeInTheDocument();
  });

  it('landlord-led WITHOUT a group shows the fallback warning chip', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'landlord_led', groupThreadId: undefined }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByText('no group - reminders -> 1:1')).toBeInTheDocument();
    expect(screen.getByText('Landlord-led tour')).toBeInTheDocument();
  });

  it('landlord-led WITH a group routes reminders to the group', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'landlord_led', groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({ conversations: [conv('g1', 'tenant-1', 0, 'relay_group')], nextCursor: null });
    renderDetail();
    await waitLoaded();
    expect(screen.getByText('reminders -> group')).toBeInTheDocument();
  });

  it('People card links the tenant, landlord, and property', async () => {
    getTour.mockResolvedValue(makeTour());
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('link', { name: 'Ann Tenant' })).toHaveAttribute('href', '/contacts/tenant-1');
    expect(screen.getByRole('link', { name: 'Lon Landlord' })).toHaveAttribute('href', '/contacts/landlord-1');
    expect(screen.getByRole('link', { name: '123 Main St, Atlanta, GA' })).toHaveAttribute(
      'href',
      '/listings/unit-1',
    );
  });

  it('pm_team labels the landlord slot "Property manager"', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'pm_team' }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByText('Property manager')).toBeInTheDocument();
    expect(screen.getByText('PM-team tour')).toBeInTheDocument();
  });

  it('Outcome card shows the pending panel before the gate', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByText(/Records after the tour/i)).toBeInTheDocument();
  });

  it('Activity card renders the trail rows with a load-more when the page is full', async () => {
    getTour.mockResolvedValue(makeTour());
    getTourActivity.mockResolvedValue(
      Array.from({ length: 20 }, (_v, i) => ({
        id: `2026-07-0${(i % 9) + 1}T00:00:00Z#${i}`,
        at: `2026-07-0${(i % 9) + 1}T00:00:00Z`,
        type: 'tour_scheduled',
      })),
    );
    renderDetail();
    await waitLoaded();
    await waitFor(() => expect(screen.getByRole('list', { name: 'Tour activity' })).toBeInTheDocument());
    expect(screen.getAllByText('Tour scheduled').length).toBe(20);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});

describe('TourDetail - three-channel switcher', () => {
  it('a self-guided tour (no group) defaults to the Tenant tab and never auto-switches', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [conv('c-tenant', 'tenant-1'), conv('c-landlord', 'landlord-1', 0, 'landlord_1to1')],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('tab', { name: /Tenant - Ann/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute('aria-selected', 'false');
    // Let all the channel fetches settle; the active tab must NOT have moved.
    await waitFor(() => expect(getConversations).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: /Tenant - Ann/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('a tour WITH a group defaults to the Group tab', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({ conversations: [conv('g1', 'tenant-1', 0, 'relay_group')], nextCursor: null });
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows an unread dot on a non-active channel and lazy-loads ONLY the active transcript', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 0),
        conv('c-landlord', 'landlord-1', 2, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    // The Landlord tab (unread 2) exposes an accessible "unread" hint.
    await waitFor(() => expect(screen.getByRole('tab', { name: /Landlord - Lon.*unread/i })).toBeInTheDocument());
    // Lazy-load: only the ACTIVE (tenant) conversation was fetched.
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledWith('c-tenant', expect.anything()));
    expect(getConversationMessages).not.toHaveBeenCalledWith('c-landlord', expect.anything());
  });

  it('viewing an unread tab marks the SINGLE conversation read - never the inbox fan-out', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 0),
        conv('c-landlord', 'landlord-1', 2, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    await screen.findByRole('tab', { name: /Landlord - Lon.*unread/i });
    // The tenant tab (active, unread 0) triggered no mark-read.
    expect(markConversationRead).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: /Landlord - Lon/ }));
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c-landlord'));
    // The contact-wide fan-out read must NEVER be used (it would clear sibling tabs).
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('composer targets the ACTIVE tab, before and after switching', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 0),
        conv('c-landlord', 'landlord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    sendMessage.mockResolvedValue({ tsMsgId: 'm1', status: 'queued' });
    renderDetail();
    await waitLoaded();
    // Wait for the tenant channel to resolve + its real thread to mount (so the
    // composer sends into the existing conversation, not create-on-demand).
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledWith('c-tenant', expect.anything()));
    // Tenant tab active: send targets the tenant conversation.
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'hi tenant');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sendMessage).toHaveBeenLastCalledWith('c-tenant', { body: 'hi tenant' });
    // Switch to landlord: its thread mounts, then send targets the landlord conversation.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord - Lon/ }));
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledWith('c-landlord', expect.anything()));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'hi landlord');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sendMessage).toHaveBeenLastCalledWith('c-landlord', { body: 'hi landlord' });
  });

  it('a draft typed on Tenant does NOT carry to Landlord on a tab switch (no wrong-party send) (MAJOR 1)', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 0),
        conv('c-landlord', 'landlord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    sendMessage.mockResolvedValue({ tsMsgId: 'm1', status: 'queued' });
    renderDetail();
    await waitLoaded();
    // Tenant tab active + its real thread mounted.
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledWith('c-tenant', expect.anything()));
    // Type a tenant-intended draft but DO NOT send.
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply message' }),
      'PRIVATE note for the tenant',
    );
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('PRIVATE note for the tenant');
    // Switch to the Landlord tab WITHOUT sending.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord - Lon/ }));
    await waitFor(() => expect(getConversationMessages).toHaveBeenCalledWith('c-landlord', expect.anything()));
    // The remount gives a FRESH composer: the tenant draft is gone (not carried over).
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');
    // Compose + send on the Landlord tab.
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'note for the landlord');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The send targets the LANDLORD conversation with the AFTER-switch body...
    expect(sendMessage).toHaveBeenLastCalledWith('c-landlord', { body: 'note for the landlord' });
    // ...and the tenant-intended draft NEVER went anywhere (no wrong-party leak).
    expect(
      sendMessage.mock.calls.some(
        (c) => (c[1] as { body?: string } | undefined)?.body === 'PRIVATE note for the tenant',
      ),
    ).toBe(false);
  });

  it('the INITIAL active tab auto-marks-read when it loads with unread, no click (MAJOR 2)', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 3),
        conv('c-landlord', 'landlord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    // The reviewer's exact repro: initial Tenant tab, tenant 1:1 unread 3, NO
    // interaction. The ref-based markRead no-op'd on the loading->ready commit.
    await waitFor(() => expect(markConversationRead).toHaveBeenCalledWith('c-tenant'));
    expect(markConversationRead.mock.calls.filter((c) => c[0] === 'c-tenant')).toHaveLength(1);
    // The inactive landlord tab (unread 0) is never marked; never the inbox fan-out.
    expect(markConversationRead).not.toHaveBeenCalledWith('c-landlord');
    expect(markInboxRead).not.toHaveBeenCalled();
  });

  it('composer footer: 1:1 tabs show the reply number; the group tab keeps the shared relay copy', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('g1', 'tenant-1', 0, 'relay_group'),
        conv('c-tenant', 'tenant-1', 0),
      ],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    // Group tab (initial): the composer matches ConversationDetail's group view
    // (no reply-target props -> the shared "this contact" fallback).
    expect(await screen.findByText(/Reply sends to/)).toHaveTextContent(
      'Reply sends to this contact',
    );
    // Tenant 1:1 tab: the footer names the tenant's number (the contact-page pattern).
    await userEvent.click(screen.getByRole('tab', { name: /Tenant - Ann/ }));
    await waitFor(() =>
      expect(screen.getByText(/Reply sends to/)).toHaveTextContent(
        'Reply sends to (404) 555-0111',
      ),
    );
  });
});

describe('TourDetail - conversation empty states', () => {
  it('group with no thread shows "No group text yet" + Open group text (createTourRelay)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    createTourRelay.mockResolvedValue({ tour: makeTour({ groupThreadId: 'g-new' }), conversation: {} });
    renderDetail();
    await waitLoaded();
    // Switch to the Group tab (self-guided defaults to Tenant).
    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    expect(screen.getByText('No group text yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open group text' }));
    expect(createTourRelay).toHaveBeenCalledWith('tour-abc');
  });

  it('a 1:1 with no thread shows the "with <name>" empty state + creates on first send', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({ conversations: [], nextCursor: null });
    ensureContactConversation.mockResolvedValue('c-new');
    sendMessage.mockResolvedValue({ tsMsgId: 'm1', status: 'queued' });
    renderDetail();
    await waitLoaded();
    // Tenant tab active, no conversation yet.
    await waitFor(() => expect(screen.getByText('No messages with Ann Tenant yet')).toBeInTheDocument());
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'first message');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(ensureContactConversation).toHaveBeenCalledWith('tenant-1');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('c-new', { body: 'first message' }));
  });

  it('open-group is disabled on a canceled tour with a short note', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'canceled', groupThreadId: undefined }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    expect(screen.getByRole('button', { name: 'Open group text' })).toBeDisabled();
    expect(screen.getByText(/a group text cannot be opened/i)).toBeInTheDocument();
  });
});

describe('TourDetail - mobile', () => {
  it('exposes a Details | Conversation toggle with Details pressed initially', async () => {
    renderDetail();
    await waitLoaded();
    const details = screen.getByRole('button', { name: 'Details' });
    const conversation = screen.getByRole('button', { name: 'Conversation' });
    expect(details).toHaveAttribute('aria-pressed', 'true');
    expect(conversation).toHaveAttribute('aria-pressed', 'false');
  });
});
