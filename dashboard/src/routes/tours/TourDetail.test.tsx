// TourDetail component tests - the rebuilt two-pane tour page. Verifies:
//   - the status-aware PRIMARY CTA ladder (Book / Mark toured / Record outcome /
//     Start placement / View placement / none) + the kebab guards
//   - the channel switcher: initial tab, never-auto-switch, unread dots,
//     SINGLE-conversation mark-read (never the inbox fan-out), composer targeting,
//     lazy-load, and the group + 1:1 empty states (open-group / create-on-demand)
//   - the right-column cards (routing chip + fallback warning, People, Guidance,
//     Outcome) + the mobile initial pane = Details
//   - not-found
//
// Pattern mirrors PlacementDetail.test / the old TourDetail.test: mock the api
// barrel, import after mocking, assert accessibility-first.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, RosterView, Tour, UnitItem } from '../../api/index.js';

const getTour = vi.fn();
const getUnit = vi.fn();
const getContact = vi.fn();
const getConversations = vi.fn();
const getTourActivity = vi.fn();
const getTourReminders = vi.fn();
const getNoShowCheckinDraft = vi.fn();
const getConversationMessages = vi.fn();
const getConversation = vi.fn();
const getConversationMembers = vi.fn();
// The 1:1 tabs are contact-keyed panes now, so every render of this page mounts
// useContactTimeline for the active party. Mocked in EVERY test (not just the
// conversation ones) - left unmocked it would reject and the pane would render
// its error state into unrelated assertions.
const getContactTimeline = vi.fn();
// The People card AND the 1:1 tab set both read the resolved roster now
// (contact-rosters Task 8) - one payload, one source.
const getTourRoster = vi.fn();
// [Open group text] is a REAL send now: it previews the server-composed intro
// first and provisions only after the confirm (contact-rosters spec 6.3).
const previewTourRosterOpen = vi.fn();
const patchTour = vi.fn();
const createTourRelay = vi.fn();
const createPlacementFromTour = vi.fn();
const ensureContactConversation = vi.fn();
const sendMessage = vi.fn();
const updateContact = vi.fn();
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
    getNoShowCheckinDraft: (...a: unknown[]) => getNoShowCheckinDraft(...a),
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversation: (...a: unknown[]) => getConversation(...a),
    getConversationMembers: (...a: unknown[]) => getConversationMembers(...a),
    getContactTimeline: (...a: unknown[]) => getContactTimeline(...a),
    getTourRoster: (...a: unknown[]) => getTourRoster(...a),
    previewTourRosterOpen: (...a: unknown[]) => previewTourRosterOpen(...a),
    patchTour: (...a: unknown[]) => patchTour(...a),
    createTourRelay: (...a: unknown[]) => createTourRelay(...a),
    createPlacementFromTour: (...a: unknown[]) => createPlacementFromTour(...a),
    ensureContactConversation: (...a: unknown[]) => ensureContactConversation(...a),
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
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

/** The default resolved roster: the same two people the page used to hard-code
 *  (tenant + the unit's landlord), now served by GET /api/tours/:id/roster. */
function makeRoster(over: Partial<RosterView> = {}): RosterView {
  return {
    source: 'default',
    members: [
      {
        memberKey: 'tenant-1',
        contactId: 'tenant-1',
        name: 'Ann Tenant',
        role: 'tenant',
        reachability: 'reachable',
      },
      {
        memberKey: 'landlord-1',
        contactId: 'landlord-1',
        name: 'Lon Landlord',
        role: 'landlord',
        reachability: 'reachable',
      },
    ],
    customized: false,
    tenantOnRoster: true,
    canOpenGroup: true,
    threadExists: false,
    pending: [],
    skipped: [],
    ...over,
  };
}

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
  getContactTimeline.mockResolvedValue({ items: [], nextCursor: null });
  getTourRoster.mockResolvedValue(makeRoster());
  previewTourRosterOpen.mockResolvedValue({
    body: 'Hi Ann and Lon - this is Housing Choice connecting you about 123 Main St.',
    recipients: [
      { name: 'Ann Tenant', reachability: 'reachable' },
      { name: 'Lon Landlord', reachability: 'reachable' },
    ],
    recipientCount: 2,
    deferred: false,
  });
  markConversationRead.mockResolvedValue(undefined);
  markInboxRead.mockResolvedValue(undefined);
  // The 1:1 panes create their thread on first send (ensureContactConversation);
  // resolve a DISTINCT id per contact so a send's target still proves which party
  // it went to.
  ensureContactConversation.mockImplementation((id: string) =>
    Promise.resolve(id === 'landlord-1' ? 'c-landlord' : 'c-tenant'),
  );
  getNoShowCheckinDraft.mockResolvedValue({
    body: 'Hi! We noticed you may have missed your tour. Want to reschedule?',
  });
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
  it('requested -> Schedule tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('button', { name: 'Schedule tour' })).toBeInTheDocument();
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
    for (const name of ['Schedule tour', 'Mark toured', 'Record outcome', 'Start placement', 'View placement']) {
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

describe('TourDetail - Send no-show check-in (manual)', () => {
  const CHECKIN = 'Hi! We noticed you may have missed your tour. Want to reschedule?';

  async function openKebab() {
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  }

  // makeTour's default scheduledAt (2026-07-10) is in the FUTURE under the pinned
  // test clock (2026-07-01, see test/setup.ts), which correctly hides the item -
  // so these tests pass an explicitly PAST start.
  const PAST_START = '2026-06-30T14:00:00Z'; // a day before the pinned now

  it('the kebab shows the item once the tour start has passed (scheduled)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', scheduledAt: PAST_START }));
    renderDetail();
    await waitLoaded();
    await openKebab();
    expect(screen.getByRole('menuitem', { name: 'Send no-show check-in' })).toBeInTheDocument();
  });

  it('is hidden while the tour start is still in the future', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', scheduledAt: '2999-01-01T00:00:00Z' }));
    renderDetail();
    await waitLoaded();
    await openKebab();
    // The other scheduled actions remain; only the no-show check-in is gated out.
    expect(screen.getByRole('menuitem', { name: 'Mark no-show' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Send no-show check-in' }),
    ).not.toBeInTheDocument();
  });

  it('is available for a no_show tour (send again after marking no-show)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'no_show', scheduledAt: PAST_START }));
    renderDetail();
    await waitLoaded();
    await openKebab();
    expect(screen.getByRole('menuitem', { name: 'Send no-show check-in' })).toBeInTheDocument();
  });

  it('clicking it fetches the copy and prefills the tenant composer with the template', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', scheduledAt: PAST_START }));
    getNoShowCheckinDraft.mockResolvedValue({ body: CHECKIN });
    renderDetail();
    await waitLoaded();
    await openKebab();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Send no-show check-in' }));
    // TourConversation selects the Tenant tab and seeds its composer via the nonce.
    expect(await screen.findByRole('tab', { name: /Tenant/, selected: true })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(CHECKIN),
    );
    // Called with the tourId + an AbortSignal (the fetch is aborted on unmount).
    expect(getNoShowCheckinDraft).toHaveBeenCalledWith('tour-abc', expect.any(AbortSignal));
  });
});

/** A datetime-local value `msFromNow` from the real clock — RELATIVE times so
 *  the Book/Reschedule tests stay inside the ordinary window (future, under the
 *  14-day odd-time warning) as the calendar advances. */
function localDatetime(msFromNow: number): string {
  const d = new Date(Date.now() + msFromNow);
  d.setSeconds(0, 0);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const DAY = 24 * 3_600_000;

describe('TourDetail - Book / Reschedule / Record outcome modals', () => {
  it('Book opens a modal and PATCHes { scheduledAt, status: scheduled }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    patchTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitLoaded();
    const at = localDatetime(2 * DAY);
    await userEvent.click(screen.getByRole('button', { name: 'Schedule tour' }));
    expect(screen.getByRole('form', { name: 'Schedule tour form' })).toBeInTheDocument();
    // REPLACE the value (the input is pre-seeded with the current hour now —
    // typing would merge into the prefill).
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: at } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm schedule' }));
    expect(patchTour).toHaveBeenCalledWith(
      'tour-abc',
      expect.objectContaining({ scheduledAt: new Date(at).toISOString(), status: 'scheduled' }),
    );
  });

  it('Schedule with a PAST time warns first; "Schedule anyway" confirms the PATCH', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    patchTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitLoaded();
    const past = localDatetime(-1 * DAY);
    await userEvent.click(screen.getByRole('button', { name: 'Schedule tour' }));
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: past } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm schedule' }));
    // First submit: the odd-time warning, NO patch, button re-labeled.
    expect(screen.getByRole('alert')).toHaveTextContent(/in the past/i);
    expect(patchTour).not.toHaveBeenCalled();
    // Second submit is the confirmation.
    await userEvent.click(screen.getByRole('button', { name: 'Schedule anyway' }));
    expect(patchTour).toHaveBeenCalledWith(
      'tour-abc',
      expect.objectContaining({ scheduledAt: new Date(past).toISOString(), status: 'scheduled' }),
    );
  });

  it('Reschedule (Schedule-card action) PATCHes { scheduledAt, status: scheduled }', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'scheduled', scheduledAt: '2026-07-20T10:00:00Z' }));
    renderDetail();
    await waitLoaded();
    const at = localDatetime(2 * DAY);
    // The Schedule card exposes a Reschedule action (aria-label "Reschedule tour").
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule tour' }));
    expect(screen.getByRole('form', { name: 'Reschedule tour form' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New date and time'), { target: { value: at } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm reschedule' }));
    expect(patchTour).toHaveBeenCalledWith(
      'tour-abc',
      expect.objectContaining({ scheduledAt: new Date(at).toISOString(), status: 'scheduled' }),
    );
  });

  it('Record outcome "Yes - move forward" PATCHes the decision then flows STRAIGHT into the placement', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockResolvedValue({
      placement: { placementId: 'plc-auto' },
      tour: makeTour({ status: 'closed', convertedPlacementId: 'plc-auto' }),
    });
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    expect(screen.getByRole('group', { name: /Moving forward with this property/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Yes - move forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', { outcome: 'move_forward', moveForward: true });
    // Recording move-forward IS the start-placement step - no second click.
    await waitFor(() => expect(createPlacementFromTour).toHaveBeenCalledWith('tour-abc'));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/placements/plc-auto'));
  });

  it('move-forward with a failing conversion: outcome saved, modal closes, alert shows, no navigation', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockRejectedValue(new ApiError(500, 'convert_failed', 'convert_failed'));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Yes - move forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    // The outcome PATCH landed and the modal closed (the decision IS saved) -
    // a conversion failure must not re-open it.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The failure surfaces in the header alert; no navigation. The tour is
    // convertible, so "Start placement" remains as the retry path.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/convert_failed/i));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Start placement' }).length).toBeGreaterThan(0);
  });

  it('Record outcome "No - not a fit" ALSO closes the tour and never converts', async () => {
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
    expect(createPlacementFromTour).not.toHaveBeenCalled();
  });
});

describe('TourDetail - close the group text after a terminal outcome (relay number lifecycle)', () => {
  const OPEN_GROUP = {
    conversationId: 'g1',
    type: 'relay_group',
    status: 'open',
    participants: [
      { contactId: 'tenant-1', phone: '+14045550111', name: 'Ann' },
      { contactId: 'landlord-1', phone: '+14045550222', name: 'Lon' },
    ],
  };

  it('recording "not a fit" on a tour WITH an open group offers to close the group text', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured', groupThreadId: 'g1' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'closed', groupThreadId: 'g1', outcome: 'not_a_fit', moveForward: false }),
    );
    getConversation.mockResolvedValue(OPEN_GROUP);
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'No - not a fit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    // The ask dialog appears once the outcome saved + the group is confirmed open,
    // named for the members.
    const dialog = await screen.findByRole('dialog', {
      name: /Also close the group text with Ann & Lon\?/i,
    });
    expect(within(dialog).getByRole('button', { name: 'Close group text' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep it open' })).toBeInTheDocument();
  });

  it('move-forward NEVER offers to close the group (conversion continues it silently)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured', groupThreadId: 'g1' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'toured', groupThreadId: 'g1', outcome: 'move_forward', moveForward: true, convertible: true }),
    );
    createPlacementFromTour.mockResolvedValue({
      placement: { placementId: 'plc-1' },
      tour: makeTour({ status: 'closed', convertedPlacementId: 'plc-1' }),
    });
    getConversation.mockResolvedValue(OPEN_GROUP);
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Yes - move forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/placements/plc-1'));
    expect(
      screen.queryByRole('dialog', { name: /Also close the group text/i }),
    ).not.toBeInTheDocument();
  });

  it('recording "not a fit" with NO group shows no close-group dialog', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured', groupThreadId: undefined }));
    patchTour.mockResolvedValue(makeTour({ status: 'closed', outcome: 'not_a_fit', moveForward: false }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'No - not a fit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    // The outcome modal closes; no ask dialog appears (no linked group).
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Record outcome/i })).not.toBeInTheDocument(),
    );
    expect(getConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Also close the group text/i })).not.toBeInTheDocument();
  });

  it('canceling a tour WITH an open group offers to close the group text', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: 'g1' }));
    patchTour.mockResolvedValue(makeTour({ status: 'canceled', groupThreadId: 'g1' }));
    getConversation.mockResolvedValue(OPEN_GROUP);
    getConversations.mockResolvedValue({
      conversations: [conv('g1', 'tenant-1', 0, 'relay_group')],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel tour' }));
    const cancelDialog = screen.getByRole('dialog', { name: /Cancel tour\?/i });
    await userEvent.click(within(cancelDialog).getByRole('button', { name: 'Cancel tour' }));
    // The cancel saved; because the group is still open the ask dialog appears.
    await screen.findByRole('dialog', { name: /Also close the group text/i });
  });

  it('skips the ask when the linked group is already closed', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured', groupThreadId: 'g1' }));
    patchTour.mockResolvedValue(
      makeTour({ status: 'closed', groupThreadId: 'g1', outcome: 'not_a_fit', moveForward: false }),
    );
    getConversation.mockResolvedValue({ ...OPEN_GROUP, status: 'closed' });
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await userEvent.click(screen.getByRole('radio', { name: 'No - not a fit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(getConversation).toHaveBeenCalledWith('g1'));
    expect(screen.queryByRole('dialog', { name: /Also close the group text/i })).not.toBeInTheDocument();
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

  it('People card lists the ROSTER members and keeps the property row', async () => {
    getTour.mockResolvedValue(makeTour());
    renderDetail();
    await waitLoaded();
    const roster = await screen.findByRole('list', { name: 'Roster' });
    expect(within(roster).getByRole('link', { name: 'Ann Tenant' })).toHaveAttribute(
      'href',
      '/contacts/tenant-1',
    );
    expect(within(roster).getByRole('link', { name: 'Lon Landlord' })).toHaveAttribute(
      'href',
      '/contacts/landlord-1',
    );
    // The Property row is the PAGE's, below the divider (spec 6.2).
    expect(screen.getByRole('link', { name: '123 Main St, Atlanta, GA' })).toHaveAttribute(
      'href',
      '/listings/unit-1',
    );
  });

  it('NEVER derives a "Property manager" / "Landlord" key from the tour type', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'pm_team' }));
    getTourRoster.mockResolvedValue(
      makeRoster({
        members: [
          {
            memberKey: 'tenant-1',
            contactId: 'tenant-1',
            name: 'Ann Tenant',
            role: 'tenant',
            reachability: 'reachable',
          },
          {
            memberKey: 'landlord-1',
            contactId: 'landlord-1',
            name: 'Lon Landlord',
            // The ROSTER says owner; the tour type says pm_team. The card must
            // follow the roster - the old key claimed a PM and rendered an owner.
            role: 'owner',
            reachability: 'reachable',
          },
        ],
      }),
    );
    renderDetail();
    await waitLoaded();
    const roster = await screen.findByRole('list', { name: 'Roster' });
    expect(within(roster).getByText('owner')).toBeInTheDocument();
    expect(screen.queryByText('Property manager')).not.toBeInTheDocument();
    expect(screen.getByText('PM-team tour')).toBeInTheDocument();
  });

  it('the People card surfaces the roster notes (tenant off the roster)', async () => {
    getTourRoster.mockResolvedValue(makeRoster({ tenantOnRoster: false }));
    renderDetail();
    await waitLoaded();
    expect(
      await screen.findByText('Tenant is not on this roster - tour reminders are paused'),
    ).toBeInTheDocument();
  });

  it('an unavailable roster offers a retry and shows NO people', async () => {
    getTourRoster.mockResolvedValue(makeRoster({ source: 'unavailable', members: [], threadExists: true }));
    renderDetail();
    await waitLoaded();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Roster' })).not.toBeInTheDocument();
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
    // Scope to the card's list: the same rows ALSO render as transcript pins in
    // the conversation pane (the milestones-interleave feature), so a page-wide
    // count would double.
    const list = screen.getByRole('list', { name: 'Tour activity' });
    expect(within(list).getAllByText('Tour scheduled').length).toBe(20);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    // The heading is the bare title — count asides were removed 2026-08-03.
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
  });
});

describe('TourDetail - the 1:1 tabs FOLLOW the roster payload', () => {
  it('a member added to the roster grows a tab', async () => {
    getTourRoster.mockResolvedValue(
      makeRoster({
        members: [
          ...makeRoster().members,
          {
            memberKey: 'pm-9',
            contactId: 'pm-9',
            name: 'Alicia Grant',
            role: 'pm',
            reachability: 'reachable',
          },
        ],
      }),
    );
    renderDetail();
    await waitLoaded();
    expect(await screen.findByRole('tab', { name: /Alicia Grant/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4));
  });

  it('a PM-MANAGED roster: the PM tab opens a real pane, not the failed-load note', async () => {
    // The motivating case (spec D6 / 6.6): the roster is [tenant, PM] while the
    // unit's landlordId is the OWNER, so the PM is NEITHER of the two records
    // this page fetches for itself. Their tab must still resolve a Contact.
    getTourRoster.mockResolvedValue(
      makeRoster({
        members: [
          {
            memberKey: 'tenant-1',
            contactId: 'tenant-1',
            name: 'Ann Tenant',
            role: 'tenant',
            reachability: 'reachable',
          },
          {
            memberKey: 'pm-9',
            contactId: 'pm-9',
            name: 'Alicia Grant',
            role: 'pm',
            reachability: 'reachable',
          },
        ],
      }),
    );
    getContact.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'landlord-1'
          ? landlordContact()
          : id === 'pm-9'
            ? {
                contactId: 'pm-9',
                type: 'landlord',
                firstName: 'Alicia',
                lastName: 'Grant',
                phone: '+14045550333',
              }
            : tenantContact(),
      ),
    );
    renderDetail();
    await waitLoaded();
    await userEvent.click(await screen.findByRole('tab', { name: /Alicia Grant/ }));
    expect(await screen.findByText('No messages with Alicia Grant yet')).toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeInTheDocument();
  });

  it('a BARE-PHONE roster member gets no tab (spec 6.6)', async () => {
    getTourRoster.mockResolvedValue(
      makeRoster({
        source: 'participants',
        threadExists: true,
        members: [
          ...makeRoster().members,
          { memberKey: 'phone:+14045550199', phoneLast4: '0199', role: 'added', reachability: 'reachable' },
        ],
      }),
    );
    renderDetail();
    await waitLoaded();
    await screen.findByRole('list', { name: 'Roster' });
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('tab', { name: /0199/ })).not.toBeInTheDocument();
  });

  it('a REMOVED-CONTACT roster member gets no tab either', async () => {
    getTourRoster.mockResolvedValue(
      makeRoster({
        source: 'participants',
        threadExists: true,
        members: [
          ...makeRoster().members,
          {
            memberKey: 'c-gone',
            contactId: 'c-gone',
            name: 'Del Ted',
            role: 'removed_contact',
            reachability: 'no_phone',
          },
        ],
      }),
    );
    renderDetail();
    await waitLoaded();
    await screen.findByRole('list', { name: 'Roster' });
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('tab', { name: /Del Ted/ })).not.toBeInTheDocument();
  });

  it('while the roster payload is still in flight the tabs keep the page inputs (no blink)', async () => {
    getTourRoster.mockReturnValue(new Promise(() => {}));
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('tab', { name: /Ann Tenant/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Lon Landlord/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('an UNAVAILABLE roster also keeps the page inputs rather than dropping the tabs', async () => {
    getTourRoster.mockResolvedValue(makeRoster({ source: 'unavailable', members: [], threadExists: true }));
    renderDetail();
    await waitLoaded();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ann Tenant/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Lon Landlord/ })).toBeInTheDocument();
  });
});

describe('TourDetail - channel switcher', () => {
  it('a self-guided tour (no group) defaults to the Tenant tab and never auto-switches', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [conv('c-tenant', 'tenant-1'), conv('c-landlord', 'landlord-1', 0, 'landlord_1to1')],
      nextCursor: null,
    });
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('tab', { name: /Ann Tenant/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute('aria-selected', 'false');
    // Let all the channel fetches settle; the active tab must NOT have moved.
    await waitFor(() => expect(getConversations).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: /Ann Tenant/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('a tour WITH a group defaults to the Group tab', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({ conversations: [conv('g1', 'tenant-1', 0, 'relay_group')], nextCursor: null });
    renderDetail();
    await waitLoaded();
    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows an unread dot on a non-active channel and loads ONLY the active tab feed', async () => {
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
    await waitFor(() => expect(screen.getByRole('tab', { name: /Lon Landlord.*unread/i })).toBeInTheDocument());
    // Lazy-load, now measured on the PERSON feed (a 1:1 tab is a contact-keyed
    // pane, so its stream comes from getContactTimeline): the ACTIVE tab's
    // contact IS fetched, the inactive tab's contact is NOT.
    await screen.findByRole('textbox', { name: 'Reply message' });
    await waitFor(() =>
      expect(getContactTimeline).toHaveBeenCalledWith('tenant-1', {}, expect.any(AbortSignal)),
    );
    expect(getContactTimeline).not.toHaveBeenCalledWith(
      'landlord-1',
      expect.anything(),
      expect.anything(),
    );
    // ...and no single-conversation transcript is fetched for a 1:1 tab at all.
    expect(getConversationMessages).not.toHaveBeenCalledWith('c-landlord', expect.anything());
  });

  it('viewing an unread 1:1 tab marks the CONTACT read (inbox fan-out) - never one conversation', async () => {
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
    await screen.findByRole('tab', { name: /Lon Landlord.*unread/i });
    // The tenant tab (active, unread 0) triggered no mark-read.
    expect(markInboxRead).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    // Contact-page parity: the 1:1 tab reads the PERSON, clearing every thread
    // they own (which is exactly what the tab's summed dot counted).
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'landlord-1' }));
    // The single-conversation read belongs to the GROUP tab alone now.
    expect(markConversationRead).not.toHaveBeenCalled();
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
    // Wait for the tenant pane's composer to mount.
    await screen.findByRole('textbox', { name: 'Reply message' });
    // Tenant tab active: send targets the tenant conversation.
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'hi tenant');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendMessage).toHaveBeenLastCalledWith('c-tenant', { body: 'hi tenant' }));
    // Switch to landlord: its pane mounts, then send targets the landlord conversation.
    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Lon Landlord/ })).toHaveAttribute('aria-selected', 'true'),
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'hi landlord');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith('c-landlord', { body: 'hi landlord' }),
    );
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
    // Tenant tab active + its pane mounted.
    await screen.findByRole('textbox', { name: 'Reply message' });
    // Type a tenant-intended draft but DO NOT send.
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply message' }),
      'PRIVATE note for the tenant',
    );
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('PRIVATE note for the tenant');
    // Switch to the Landlord tab WITHOUT sending.
    await userEvent.click(screen.getByRole('tab', { name: /Lon Landlord/ }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Lon Landlord/ })).toHaveAttribute('aria-selected', 'true'),
    );
    // The remount gives a FRESH composer: the tenant draft is gone (not carried over).
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');
    // Compose + send on the Landlord tab.
    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'note for the landlord');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The send targets the LANDLORD conversation with the AFTER-switch body...
    await waitFor(() =>
      expect(sendMessage).toHaveBeenLastCalledWith('c-landlord', { body: 'note for the landlord' }),
    );
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
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'tenant-1' }));
    expect(markInboxRead.mock.calls.filter((c) => (c[0] as { contactId: string }).contactId === 'tenant-1')).toHaveLength(1);
    // The inactive landlord tab (unread 0) is never marked; the 1:1 tabs never
    // take the single-conversation read.
    expect(markInboxRead).not.toHaveBeenCalledWith({ contactId: 'landlord-1' });
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('composer footer: the group tab names the WHOLE roster; 1:1 tabs show the reply number', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('g1', 'tenant-1', 0, 'relay_group'),
        conv('c-tenant', 'tenant-1', 0),
      ],
      nextCursor: null,
    });
    getConversationMembers.mockResolvedValue([
      { contactId: 'tenant-1', phone: '+14045550111', name: 'Ann' },
      { contactId: 'landlord-1', phone: '+14045550122', name: 'Marcus' },
    ]);
    renderDetail();
    await waitLoaded();
    // Group tab (initial): a reply relays to EVERY member — the footer says so
    // and lists the roster (never the old "this contact" single-target copy).
    expect(await screen.findByText(/Reply sends to/)).toHaveTextContent(
      'Reply sends to everyone in this group text (Ann, Marcus)',
    );
    // Tenant 1:1 tab: the footer names the tenant's number (the contact-page
    // pattern). Byte-for-byte the contact page's own copy now that the shared
    // pane renders it - including the "(primary)" qualifier the pane passes as
    // replyToLabel=defaultPhoneLabel(phones), which the old bespoke 1:1
    // transcript did not have.
    await userEvent.click(screen.getByRole('tab', { name: /Ann Tenant/ }));
    await waitFor(() =>
      expect(screen.getByText(/Reply sends to/)).toHaveTextContent(
        'Reply sends to (404) 555-0111 (primary)',
      ),
    );
  });
});

describe('TourDetail - tour milestones interleave into the conversation panes', () => {
  it('the 1:1 transcript shows the lifecycle pins from the PERSON feed; "Comms only" hides them', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [conv('c-tenant', 'tenant-1', 0)],
      nextCursor: null,
    });
    // A 1:1 tab is the contact-keyed pane now, so its pins arrive on the PERSON
    // timeline (the server writes a dual-party event per tour milestone) - there
    // is no client-side injection left on this surface.
    getContactTimeline.mockResolvedValue({
      nextCursor: null,
      items: [
        {
          kind: 'milestone',
          id: '2026-07-01T00:00:00.000Z#0',
          at: '2026-07-01T00:00:00.000Z',
          type: 'tour_scheduled',
          label: 'Tour scheduled',
        },
        {
          kind: 'milestone',
          id: '2026-07-03T00:00:00.000Z#1',
          at: '2026-07-03T00:00:00.000Z',
          type: 'tour_scheduled',
          label: 'Tour rescheduled',
        },
      ],
    });
    // The tour ACTIVITY rows (the old injection source) stay empty, so a pin in
    // this transcript can only have come from the person feed.
    getTourActivity.mockResolvedValue([]);
    renderDetail();
    await waitLoaded();

    // Scope to the TRANSCRIPT region - the right-column Activity card shows the
    // same labels, and it must not satisfy these assertions.
    const transcript = screen.getByRole('region', { name: /Communications/i });
    await waitFor(() => expect(within(transcript).getByText('Tour scheduled')).toBeInTheDocument());
    expect(within(transcript).getByText('Tour rescheduled')).toBeInTheDocument();

    // The "Comms only" toggle hides the pins (they are milestones, not comms).
    await userEvent.click(within(transcript).getByRole('button', { name: /Comms only/i }));
    await waitFor(() =>
      expect(within(transcript).queryByText('Tour scheduled')).not.toBeInTheDocument(),
    );
    expect(within(transcript).queryByText('Tour rescheduled')).not.toBeInTheDocument();
  });

  it('the GROUP transcript shows the pins too (with deep links kept)', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'g1' }));
    getConversations.mockResolvedValue({
      conversations: [conv('g1', 'tenant-1', 0, 'relay_group')],
      nextCursor: null,
    });
    getTourActivity.mockResolvedValue([
      { id: '2026-07-02T00:00:00Z#1', at: '2026-07-02T00:00:00Z', type: 'tour_group_opened', conversationId: 'g1' },
    ]);
    renderDetail();
    await waitLoaded();
    const transcript = screen.getByRole('region', { name: /Communications/i });
    const pin = await within(transcript).findByRole('link', { name: 'Group text opened' });
    expect(pin).toHaveAttribute('href', '/conversations/g1');
  });
});

describe('TourDetail - just-in-time consent gate (1:1 tabs)', () => {
  // A proactive 1:1 send to a no-consent contact is refused server-side (409
  // contact_no_consent). Before 2026-07-09 the tour page swallowed it SILENTLY:
  // optimistic bubble gone, draft restored, no error, no modal. It now opens the
  // same hard-block ConsentCaptureModal as the contact page and retries.
  it('a refused 1:1 send opens the consent modal; recording consent retries and clears the draft', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 0),
        conv('c-landlord', 'landlord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    sendMessage
      .mockRejectedValueOnce(new ApiError(409, 'contact_no_consent', 'contact_no_consent'))
      .mockResolvedValueOnce({ tsMsgId: 'm1', status: 'queued' });
    updateContact.mockResolvedValue({ ...tenantContact(), consent_method: 'verbal_phone' });
    renderDetail();
    await waitLoaded();
    await screen.findByRole('textbox', { name: 'Reply message' });

    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'hi tenant');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The hard-block modal appears — and the draft was restored (nothing lost).
    const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('hi tenant');

    await userEvent.selectOptions(within(dialog).getByLabelText(/How did they consent/i), 'verbal_phone');
    await userEvent.click(within(dialog).getByRole('button', { name: /Record consent & send/i }));

    // Consent PATCHed for the TENANT (the active 1:1), then the exact send retried.
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ consent_method: 'verbal_phone' }),
      ),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]).toEqual(['c-tenant', { body: 'hi tenant' }]);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Record consent/i })).not.toBeInTheDocument(),
    );
    // The restored draft clears once the retry lands (ContactDetail parity).
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(''));
  });

  it('Cancel aborts: no consent PATCH, no retry, the draft stays in the box', async () => {
    getTour.mockResolvedValue(makeTour({ tourType: 'self_guided', groupThreadId: undefined }));
    getConversations.mockResolvedValue({
      conversations: [
        conv('c-tenant', 'tenant-1', 0),
        conv('c-landlord', 'landlord-1', 0, 'landlord_1to1'),
      ],
      nextCursor: null,
    });
    sendMessage.mockRejectedValue(new ApiError(409, 'contact_no_consent', 'contact_no_consent'));
    renderDetail();
    await waitLoaded();
    await screen.findByRole('textbox', { name: 'Reply message' });

    await userEvent.type(screen.getByRole('textbox', { name: 'Reply message' }), 'hi tenant');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const dialog = await screen.findByRole('dialog', { name: /Record consent before texting/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }));

    expect(screen.queryByRole('dialog', { name: /Record consent/i })).not.toBeInTheDocument();
    expect(updateContact).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('hi tenant');
  });
});

describe('TourDetail - conversation empty states', () => {
  it('group with no thread shows "No group text yet" + Open group text (confirm, then createTourRelay)', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    createTourRelay.mockResolvedValue({ deferred: false, tour: makeTour({ groupThreadId: 'g-new' }) });
    renderDetail();
    await waitLoaded();
    // Switch to the Group tab (self-guided defaults to Tenant).
    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    expect(screen.getByText('No group text yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open group text' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open the group text?' });
    expect(createTourRelay).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open group text' }));
    await waitFor(() =>
      expect(createTourRelay).toHaveBeenCalledWith('tour-abc', { force: false }),
    );
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
  // jsdom has no matchMedia, so useTwoPaneNarrow reads WIDE by default and every
  // other test in this file exercises the desktop two-pane path (both panes on
  // screen). These stub it narrow.
  function stubNarrow(matches: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 860px') ? matches : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes a Details | Conversation toggle with Details pressed initially', async () => {
    renderDetail();
    await waitLoaded();
    const details = screen.getByRole('button', { name: 'Details' });
    const conversation = screen.getByRole('button', { name: 'Conversation' });
    expect(details).toHaveAttribute('aria-pressed', 'true');
    expect(conversation).toHaveAttribute('aria-pressed', 'false');
  });

  it('landing on the page does NOT clear the tenant inbox row until the pane is revealed', async () => {
    // The MF1 repro: at <=860px the comms column is display:none behind the
    // Details pane, but it still MOUNTS - so merely opening /tours/:id from a
    // phone used to fire the contact-wide fan-out and consume unread the
    // operator never saw (there is no mark-unread anywhere in the product).
    stubNarrow(true);
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

    // The Tenant tab is active and its dot is showing - and NOTHING was marked
    // read. Wait for the pane itself to mount so this is not a race won by luck.
    await screen.findByRole('tab', { name: /Ann Tenant.*unread/i });
    await screen.findByRole('textbox', { name: 'Reply message' });
    expect(markInboxRead).not.toHaveBeenCalled();

    // The operator taps "Conversation": now they are genuinely looking at it.
    await userEvent.click(
      within(screen.getByRole('group', { name: 'View' })).getByRole('button', {
        name: 'Conversation',
      }),
    );
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'tenant-1' }));
    expect(markInboxRead).toHaveBeenCalledTimes(1);
  });

  it('the WIDE two-pane page still auto-marks on load (both panes are on screen)', async () => {
    // The same stub, resolving WIDE - the desktop contract MF1 had to keep.
    stubNarrow(false);
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

    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'tenant-1' }));
  });
});

// --- contact-rosters Task 11: the pre-open confirm + the card as editor ------
describe('TourDetail - pre-open confirm + roster editing', () => {
  it('previews the SERVER-composed intro before provisioning, and provisions only on confirm', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', groupThreadId: undefined }));
    createTourRelay.mockResolvedValue({
      deferred: false,
      tour: makeTour({ groupThreadId: 'g-new' }),
    });
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open group text' }));

    const dialog = await screen.findByRole('dialog', { name: 'Open the group text?' });
    expect(previewTourRosterOpen).toHaveBeenCalledWith('tour-abc');
    expect(
      within(dialog).getByText(
        'Hi Ann and Lon - this is Housing Choice connecting you about 123 Main St.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('2 recipients will receive this.')).toBeInTheDocument();
    // NOTHING is provisioned until the operator confirms.
    expect(createTourRelay).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open group text' }));
    await waitFor(() =>
      expect(createTourRelay).toHaveBeenCalledWith('tour-abc', { force: false }),
    );
  });

  // --- Task 14: the 202-DEFERRED arm ---------------------------------------
  // Confirming inside quiet hours creates a PENDING action and opens NOTHING.
  // The response is a RosterView, not { tour, conversation } - reading
  // `res.tour` / `res.conversation.conversationId` there is the undefined deref
  // the s6b contract flagged, and mounting a thread id that does not exist is
  // the failure it would cause.
  it('a confirm DURING QUIET HOURS defers: no thread is mounted and the card says when it opens', async () => {
    const quietEndsAt = '2026-08-05T12:00:00.000Z';
    const clock = new Date(quietEndsAt).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    getTour.mockResolvedValue(makeTour({ status: 'requested', groupThreadId: undefined }));
    previewTourRosterOpen.mockResolvedValue({
      body: 'Hi Ann and Lon - this is Housing Choice connecting you about 123 Main St.',
      recipients: [
        { name: 'Ann Tenant', reachability: 'reachable' },
        { name: 'Lon Landlord', reachability: 'reachable' },
      ],
      recipientCount: 2,
      deferred: true,
      quietEndsAt,
    });
    createTourRelay.mockResolvedValue({
      deferred: true,
      roster: makeRoster({
        pending: [{ actionId: 'tour#tour-abc#open', kind: 'open_group', dueAt: quietEndsAt }],
      }),
    });
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open group text' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open the group text?' });
    await userEvent.click(within(dialog).getByRole('button', { name: `Open at ${clock}` }));

    await waitFor(() =>
      expect(createTourRelay).toHaveBeenCalledWith('tour-abc', { force: false }),
    );
    // The pending state is on the card, straight from the 202 payload...
    expect(await screen.findByText(`Opens at ${clock} - quiet hours`)).toBeInTheDocument();
    // ...and NOTHING was opened: the group pane still has no thread.
    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    expect(screen.getByText('No group text yet')).toBeInTheDocument();
    expect(getConversationMessages).not.toHaveBeenCalledWith('g-new', expect.anything());
  });

  it('"Send the group text now" on a pending open FORCES the provision through', async () => {
    const quietEndsAt = '2026-08-05T12:00:00.000Z';
    getTour.mockResolvedValue(makeTour({ status: 'requested', groupThreadId: undefined }));
    getTourRoster.mockResolvedValue(
      makeRoster({
        pending: [{ actionId: 'tour#tour-abc#open', kind: 'open_group', dueAt: quietEndsAt }],
      }),
    );
    createTourRelay.mockResolvedValue({
      deferred: false,
      tour: makeTour({ groupThreadId: 'g-new' }),
    });
    renderDetail();
    await waitLoaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Send the group text now' }));
    await waitFor(() => expect(createTourRelay).toHaveBeenCalledWith('tour-abc', { force: true }));
    // No preview, no dialog - the operator already confirmed this send once.
    expect(previewTourRosterOpen).not.toHaveBeenCalled();
  });

  it('DISABLES [Open group text] with the pending reason while an open is deferred', async () => {
    const quietEndsAt = '2026-08-05T12:00:00.000Z';
    const clock = new Date(quietEndsAt).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    getTourRoster.mockResolvedValue(
      makeRoster({
        pending: [{ actionId: 'tour#tour-abc#open', kind: 'open_group', dueAt: quietEndsAt }],
      }),
    );
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open group text' })).toBeDisabled(),
    );
    // The control carries the SAME sentence the card does - one fact, one phrasing.
    expect(screen.getAllByText(`Opens at ${clock} - quiet hours`).length).toBeGreaterThan(1);
  });

  it('a 409 relay_already_provisioned REFETCHES the roster instead of opening a dialog', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', groupThreadId: undefined }));
    previewTourRosterOpen.mockRejectedValue(
      new ApiError(409, 'relay_already_provisioned', 'relay_already_provisioned', {
        error: 'relay_already_provisioned',
      }),
    );
    renderDetail();
    await waitLoaded();
    await waitFor(() => expect(getTourRoster).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open group text' }));

    await waitFor(() => expect(getTourRoster).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createTourRelay).not.toHaveBeenCalled();
  });

  it("disables [Open group text] with the roster's reason when too few members are reachable", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    getTourRoster.mockResolvedValue(makeRoster({ canOpenGroup: false }));
    renderDetail();
    await waitLoaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Group text' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open group text' })).toBeDisabled(),
    );
    expect(
      screen.getAllByText(
        'Not enough people to open a group text - two reachable members are needed',
      ).length,
    ).toBeGreaterThan(0);
    expect(previewTourRosterOpen).not.toHaveBeenCalled();
  });

  it("the KEBAB's [Open group text] is disabled by the same too-thin roster", async () => {
    // Spec 6.2 asks for the reason on a DISABLED control instead of a click-time
    // 400 relay_member_unresolvable - the kebab is a third way to that click, so
    // it obeys the same gate as the pane button and the card note.
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    getTourRoster.mockResolvedValue(makeRoster({ canOpenGroup: false }));
    renderDetail();
    await waitLoaded();
    await waitFor(() => expect(getTourRoster).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: 'Open group text' });
    // Still VISIBLE (an absent control teaches nothing), disabled, with the why.
    await waitFor(() => expect(item).toBeDisabled());
    expect(item).toHaveAttribute(
      'title',
      'Not enough people to open a group text - two reachable members are needed',
    );
    await userEvent.click(item);
    expect(previewTourRosterOpen).not.toHaveBeenCalled();
  });

  it('the KEBAB stays LIVE while an open is merely deferred (Send now anyway)', async () => {
    // The pending-open case is deliberately NOT blocked: re-confirming and
    // choosing "Send now anyway" is the second way to force a deferred open.
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    getTourRoster.mockResolvedValue(
      makeRoster({
        pending: [
          { actionId: 'tour#tour-abc#open', kind: 'open_group', dueAt: '2026-08-05T12:00:00.000Z' },
        ],
      }),
    );
    renderDetail();
    await waitLoaded();
    await waitFor(() => expect(getTourRoster).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Open group text' })).toBeEnabled();
  });

  it("the People card edits the roster and suggests the property's other contacts", async () => {
    getUnit.mockResolvedValue(
      makeUnit({
        contacts: [
          { contactId: 'c-pm', role: 'pm', primaryContact: true, name: 'Alicia Grant' },
          { contactId: 'landlord-1', role: 'landlord', primaryContact: false, name: 'Lon Landlord' },
        ],
      }),
    );
    renderDetail();
    await waitLoaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit people' }));
    // The PM is on the PROPERTY but not on this tour - one click puts them here.
    expect(
      screen.getByText('Also on this property: Alicia Grant - PM - primary contact'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add Alicia Grant to this tour' }),
    ).toBeInTheDocument();
    // The landlord IS on the roster already, so they are never suggested.
    expect(screen.queryByText(/Also on this property: Lon Landlord/)).not.toBeInTheDocument();
  });
});
