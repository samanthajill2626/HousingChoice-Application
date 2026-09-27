// ToursPage.test.tsx — unit tests for the /tours list page.
//
// Strategy: mock the three data hooks (useTours, useContacts, useListings) so
// these tests are independent of fetching. Assert:
//   - Loading and error states
//   - Upcoming section: date grouping (two groups for two dates, soonest first;
//     "Today" label for the current date); rows with tenant/property/time/status/type;
//     row links to /tours/:tourId; empty state
//   - Needs-booking section: renders requested tours oldest first; no time column;
//     row links to detail; empty state
//   - getTours is called with the right params (asserted via useTours mock below)
//   - Past view (/tours/past, spec 4.1, 4.3-4.5): rows with date-time labels,
//     the row actions, and the sequential re-read-then-PATCH bulk runner
//     (usePastTours is mocked; pastState stays real via importActual)
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tour, Contact, UnitItem } from '../../api/index.js';
import type { ClosedToursState, PastToursState, ToursPageState } from './useTours.js';
import type { ContactsState } from '../contacts/useContacts.js';
import type { ListingsState } from '../listings/useListings.js';

// ---------------------------------------------------------------------------
// Mocks — hoisted so imports below can reference the state variables.
// ---------------------------------------------------------------------------

let toursState: ToursPageState = { status: 'loading', upcoming: [], needsBooking: [] };
let contactsState: ContactsState = { status: 'loading', contacts: [] };
let deletedContactsState: ContactsState = { status: 'ready', contacts: [] };
let unitsState: ListingsState = { status: 'loading', units: [] };
let deletedUnitsState: ListingsState = { status: 'ready', units: [] };
let closedState: ClosedToursState = { status: 'ready', closed: [] };
// Spy on the enabled flag so tests can assert the fetch stays OFF by default.
const useClosedToursSpy = vi.fn(
  (enabled: boolean): ClosedToursState =>
    enabled ? closedState : { status: 'idle', closed: [] },
);
// The Past hook: the rows a test sets, plus a reload spy. The spy records the
// enabled flag so a test can prove the hook is never even called off Past.
let pastRows: Omit<PastToursState, 'reload'> = { status: 'ready', past: [], reloadFailed: false };
const reloadPast = vi.fn();
/** The Past hook's default answer. Re-installed before every test, so a test
 *  that swaps it for one visit cannot leak into the next. */
function pastHookAnswer(enabled: boolean): PastToursState {
  return enabled
    ? { ...pastRows, reload: reloadPast }
    : { status: 'idle', past: [], reload: reloadPast, reloadFailed: false };
}
const usePastToursSpy = vi.fn(pastHookAnswer);

// Spread form: the page also imports PURE helpers from this module (pastState
// renders the Past chip), which must stay real.
vi.mock('./useTours.js', async () => {
  const actual = await vi.importActual<typeof import('./useTours.js')>('./useTours.js');
  return {
    ...actual,
    useTours: () => toursState,
    useClosedTours: (enabled: boolean) => useClosedToursSpy(enabled),
    usePastTours: (enabled: boolean) => usePastToursSpy(enabled),
  };
});
// The page cross-references BOTH live and soft-deleted entities (a closed tour
// often outlives its contact/unit) — the mocks answer per filter arg.
vi.mock('../contacts/useContacts.js', () => ({
  useContacts: (filter: string) => (filter === 'deleted' ? deletedContactsState : contactsState),
}));
vi.mock('../listings/useListings.js', () => ({
  useListings: (deleted?: boolean) => (deleted === true ? deletedUnitsState : unitsState),
}));

// The "+ New tour" dialog (ScheduleTourForm) fetches its own typeahead
// candidates from the api barrel - stub those so opening it stays offline.
const getAllContacts = vi.fn(() => Promise.resolve([]));
const getAllUnits = vi.fn(() => Promise.resolve([]));
const createTour = vi.fn();
// The Past view's bulk runner re-reads each tour, then PATCHes it.
const getTour = vi.fn();
const patchTour = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllContacts: (...a: unknown[]) => getAllContacts(...(a as [])),
    getAllUnits: (...a: unknown[]) => getAllUnits(...(a as [])),
    createTour: (...a: unknown[]) => createTour(...(a as [])),
    getTour: (...a: unknown[]) => getTour(...(a as [])),
    patchTour: (...a: unknown[]) => patchTour(...(a as [])),
  };
});

import { ApiError } from '../../api/index.js';
import { ToursPage } from './ToursPage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Today's date at noon (deterministic scheduled time for "Today" group). */
function todayAt(hours: number, minutes = 0): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

/** A date 7 days from now at noon. */
function sevenDaysFrom(hours = 12): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
}

/** A date 14 days from now at noon. */
function fourteenDaysFrom(hours = 12): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
}

const CONTACTS: Contact[] = [
  {
    contactId: 'c1',
    type: 'tenant',
    firstName: 'Alice',
    lastName: 'Smith',
    phone: '+14040000001',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    contactId: 'c2',
    type: 'tenant',
    firstName: 'Bob',
    lastName: 'Jones',
    phone: '+14040000002',
    status: 'active',
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
];

const UNITS: UnitItem[] = [
  {
    unitId: 'u1',
    landlordId: 'l1',
    status: 'available',
    jurisdiction: 'atlanta_housing',
    address: { line1: '123 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
  },
  {
    unitId: 'u2',
    landlordId: 'l2',
    status: 'available',
    jurisdiction: 'atlanta_housing',
    address: { line1: '456 Oak Ave', city: 'Decatur', state: 'GA', zip: '30030' },
  },
];

/** A scheduled upcoming tour for tenant c1 / unit u1 on TODAY. */
const TOUR_TODAY: Tour = {
  tourId: 't1',
  tenantId: 'c1',
  unitId: 'u1',
  scheduledAt: todayAt(14, 0), // 2:00 PM today
  tourType: 'self_guided',
  status: 'scheduled',
  createdAt: '2026-06-01T10:00:00Z',
};

/** A scheduled upcoming tour for tenant c2 / unit u2 in 7 days. */
const TOUR_NEXT_WEEK: Tour = {
  tourId: 't2',
  tenantId: 'c2',
  unitId: 'u2',
  scheduledAt: sevenDaysFrom(10),
  tourType: 'landlord_led',
  status: 'scheduled',
  createdAt: '2026-06-02T10:00:00Z',
};

/** A second upcoming tour also in 7 days (same date group as TOUR_NEXT_WEEK). */
const TOUR_NEXT_WEEK_2: Tour = {
  tourId: 't3',
  tenantId: 'c1',
  unitId: 'u2',
  scheduledAt: sevenDaysFrom(14), // same date, later time
  tourType: 'pm_team',
  status: 'scheduled',
  createdAt: '2026-06-03T10:00:00Z',
};

/** A third upcoming tour in 14 days (a different date group). */
const TOUR_TWO_WEEKS: Tour = {
  tourId: 't4',
  tenantId: 'c1',
  unitId: 'u1',
  scheduledAt: fourteenDaysFrom(11),
  tourType: 'self_guided',
  status: 'scheduled',
  createdAt: '2026-06-04T10:00:00Z',
};

/** A requested (time-less) tour — older. */
const TOUR_REQUESTED_OLD: Tour = {
  tourId: 'r1',
  tenantId: 'c1',
  unitId: 'u1',
  tourType: 'self_guided',
  status: 'requested',
  createdAt: '2026-05-01T08:00:00Z',
};

/** A requested (time-less) tour — newer. */
const TOUR_REQUESTED_NEW: Tour = {
  tourId: 'r2',
  tenantId: 'c2',
  unitId: 'u2',
  tourType: 'landlord_led',
  status: 'requested',
  createdAt: '2026-05-15T08:00:00Z',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shows where a row link landed and what state it carried (unit-test only). */
function LocationProbe(): React.JSX.Element {
  const l = useLocation();
  return (
    <output data-testid="loc">
      {l.pathname}
      {l.search}|{JSON.stringify(l.state ?? null)}
    </output>
  );
}

/** Render with ALL THREE view routes wired (the Active/Past/Closed tabs are
 *  real links, so navigation between the views works in-test), plus a probe on
 *  the tour route that shows where a row link landed and its router state. */
function renderPage(initialPath = '/tours'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/tours" element={<ToursPage />} />
        <Route path="/tours/past" element={<ToursPage view="past" />} />
        <Route path="/tours/closed" element={<ToursPage view="closed" />} />
        <Route path="/tours/:tourId" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function readyAll(
  upcoming: Tour[] = [],
  needsBooking: Tour[] = [],
  contacts: Contact[] = CONTACTS,
  units: UnitItem[] = UNITS,
): void {
  toursState = { status: 'ready', upcoming, needsBooking };
  contactsState = { status: 'ready', contacts };
  unitsState = { status: 'ready', units };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  toursState = { status: 'loading', upcoming: [], needsBooking: [] };
  contactsState = { status: 'loading', contacts: [] };
  deletedContactsState = { status: 'ready', contacts: [] };
  unitsState = { status: 'loading', units: [] };
  deletedUnitsState = { status: 'ready', units: [] };
  closedState = { status: 'ready', closed: [] };
  useClosedToursSpy.mockClear();
  pastRows = { status: 'ready', past: [], reloadFailed: false };
  // mockReset, not mockClear: a test installs a reloadPast implementation,
  // which must never leak into the next test.
  reloadPast.mockReset();
  usePastToursSpy.mockClear();
  usePastToursSpy.mockImplementation(pastHookAnswer);
  getTour.mockReset();
  patchTour.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToursPage', () => {
  // --- Loading / error states ---

  it('shows a spinner and the Tours heading while loading', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Tours' })).toBeInTheDocument();
    // The Spinner uses role="status"
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error alert when any fetch fails', () => {
    toursState = { status: 'error', upcoming: [], needsBooking: [] };
    contactsState = { status: 'ready', contacts: CONTACTS };
    unitsState = { status: 'ready', units: UNITS };
    renderPage();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t load|try again/i);
  });

  // --- Empty states ---

  it('shows empty states for both sections when there are no tours', () => {
    readyAll([], []);
    renderPage();
    const upcoming = screen.getByRole('region', { name: 'Upcoming tours' });
    expect(within(upcoming).getByText(/no tours scheduled/i)).toBeInTheDocument();
    const needs = screen.getByRole('region', { name: 'Needs booking' });
    expect(within(needs).getByText(/no unbooked/i)).toBeInTheDocument();
  });

  // --- Upcoming section ---

  it('renders a row with tenant name, property, time, status, and type', () => {
    readyAll([TOUR_TODAY]);
    renderPage();
    const upcoming = screen.getByRole('region', { name: 'Upcoming tours' });
    const row = within(upcoming).getByRole('link', { name: /Alice Smith.*123 Peachtree/i });
    expect(row).toHaveAttribute('href', '/tours/t1');
    // Status badge
    expect(within(row).getByText('Scheduled')).toBeInTheDocument();
    // Type badge
    expect(within(row).getByText('Self-guided')).toBeInTheDocument();
    // Time present
    const timeEl = within(row).getByText(/\d+:\d+/);
    expect(timeEl).toBeInTheDocument();
  });

  it('groups upcoming tours by local date, soonest first, with "Today" for today\'s date', () => {
    // Three tours: one today, two next week (same day), one two weeks out → 3 groups.
    readyAll([TOUR_TODAY, TOUR_NEXT_WEEK, TOUR_NEXT_WEEK_2, TOUR_TWO_WEEKS]);
    renderPage();
    const upcoming = screen.getByRole('region', { name: 'Upcoming tours' });
    // "Today" group appears first.
    const todayGroup = within(upcoming).getByRole('list', { name: /tours on today/i });
    expect(todayGroup).toBeInTheDocument();
    expect(within(todayGroup).getAllByRole('listitem')).toHaveLength(1);

    // The next-week date group has two tours (t2 + t3).
    const allLists = within(upcoming).getAllByRole('list');
    // First list = Today group, second = next-week group, third = two-weeks group.
    expect(allLists).toHaveLength(3);
    expect(within(allLists[1]!).getAllByRole('listitem')).toHaveLength(2);
    expect(within(allLists[2]!).getAllByRole('listitem')).toHaveLength(1);
  });

  it('resolves a PARTNER contact to a display name - the widened fan-out reaches this list', () => {
    // This page reads useContacts('all') as an id->name map. TYPES_FOR.all
    // gained 'partner' on 2026-08-18; without a partner in the resolution set,
    // a tour whose tenantId points at a partner-typed contact renders the raw
    // id. See docs/issues/partner-widening-consumer-test-gap.md.
    readyAll(
      [{ ...TOUR_TODAY, tourId: 't-partner', tenantId: 'c-partner' }],
      [],
      [
        ...CONTACTS,
        { contactId: 'c-partner', type: 'partner', firstName: 'Renata', lastName: 'Cole', phone: '+14040000009' },
      ],
    );
    renderPage();
    const upcoming = screen.getByRole('region', { name: 'Upcoming tours' });
    expect(within(upcoming).getByRole('link', { name: /Renata Cole/ })).toBeInTheDocument();
    expect(within(upcoming).queryByText(/c-partner/)).not.toBeInTheDocument();
  });

  it('each upcoming row links to /tours/:tourId', () => {
    readyAll([TOUR_TODAY, TOUR_NEXT_WEEK]);
    renderPage();
    const upcoming = screen.getByRole('region', { name: 'Upcoming tours' });
    expect(within(upcoming).getByRole('link', { name: /Alice Smith/ })).toHaveAttribute(
      'href',
      '/tours/t1',
    );
    expect(within(upcoming).getByRole('link', { name: /Bob Jones/ })).toHaveAttribute(
      'href',
      '/tours/t2',
    );
  });

  // --- Needs-booking section ---

  it('renders requested tours in the needs-booking section without a time column', () => {
    readyAll([], [TOUR_REQUESTED_OLD, TOUR_REQUESTED_NEW]);
    renderPage();
    const needs = screen.getByRole('region', { name: 'Needs booking' });
    const rows = within(needs).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Status badge: 'Requested'
    expect(within(needs).getAllByText('Requested')).toHaveLength(2);
  });

  it('lists needs-booking tours in the order provided by useTours (oldest first)', () => {
    // useTours sorts by createdAt ascending before returning. The component renders
    // whatever the hook provides. Here we supply already-sorted data (oldest first)
    // and assert the component renders them in that order.
    readyAll([], [TOUR_REQUESTED_OLD, TOUR_REQUESTED_NEW]);
    renderPage();
    const needs = screen.getByRole('region', { name: 'Needs booking' });
    const items = within(needs).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // First item is the older tour (Alice / Peachtree).
    expect(within(items[0]!).getByText('Alice Smith')).toBeInTheDocument();
    // Second is the newer (Bob / Oak).
    expect(within(items[1]!).getByText('Bob Jones')).toBeInTheDocument();
  });

  it('each needs-booking row links to /tours/:tourId', () => {
    readyAll([], [TOUR_REQUESTED_OLD]);
    renderPage();
    const needs = screen.getByRole('region', { name: 'Needs booking' });
    expect(within(needs).getByRole('link', { name: /Alice Smith/ })).toHaveAttribute(
      'href',
      '/tours/r1',
    );
  });

  // --- Closed section (opt-in via the "Show closed" toggle) ---

  /** A closed tour (converted) — newest. */
  const TOUR_CLOSED_NEW: Tour = {
    tourId: 'x1',
    tenantId: 'c1',
    unitId: 'u1',
    scheduledAt: '2026-07-14T18:00:00Z',
    tourType: 'landlord_led',
    status: 'closed',
    outcome: 'move_forward',
    moveForward: true,
    convertedPlacementId: 'plc-1',
    createdAt: '2026-07-01T10:00:00Z',
    updatedAt: '2026-07-14T20:00:00Z',
  };

  /** A closed tour (not a fit) — older. */
  const TOUR_CLOSED_OLD: Tour = {
    tourId: 'x2',
    tenantId: 'c2',
    unitId: 'u2',
    scheduledAt: '2026-06-02T18:00:00Z',
    tourType: 'self_guided',
    status: 'closed',
    outcome: 'not_a_fit',
    moveForward: false,
    createdAt: '2026-06-01T10:00:00Z',
    updatedAt: '2026-06-02T19:00:00Z',
  };

  /** A CANCELED tour — the Closed view lists these too (revivable, but not
   *  live; the badge tells it apart from a terminal closed tour). */
  const TOUR_CANCELED: Tour = {
    tourId: 'k1',
    tenantId: 'c1',
    unitId: 'u2',
    scheduledAt: '2026-06-20T18:00:00Z',
    tourType: 'self_guided',
    status: 'canceled',
    createdAt: '2026-06-15T10:00:00Z',
    updatedAt: '2026-06-20T10:00:00Z',
  };

  it('Active view: renders the view tabs with Active current, no Closed section, closed fetch OFF', () => {
    readyAll([TOUR_TODAY], []);
    renderPage();
    const tabs = screen.getByRole('navigation', { name: 'Tours view' });
    const active = within(tabs).getByRole('link', { name: 'Active' });
    const closedTab = within(tabs).getByRole('link', { name: 'Closed' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('href', '/tours');
    expect(closedTab).not.toHaveAttribute('aria-current');
    expect(closedTab).toHaveAttribute('href', '/tours/closed');
    const pastTab = within(tabs).getByRole('link', { name: 'Past' });
    expect(pastTab).not.toHaveAttribute('aria-current');
    expect(pastTab).toHaveAttribute('href', '/tours/past');
    // The Past data hook lives in a Past-only child, so it is never even
    // called on the Active view.
    expect(usePastToursSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Closed tours' })).not.toBeInTheDocument();
    // The lazy hook was only ever asked with enabled=false on the Active view.
    expect(useClosedToursSpy).toHaveBeenCalled();
    expect(useClosedToursSpy.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
  });

  it('clicking the Closed tab switches views: title, rows with tenant, property, DATE, and badges', async () => {
    const user = userEvent.setup();
    readyAll([], []);
    // Hook order (newest first): closed x1 > canceled k1 > closed x2.
    closedState = { status: 'ready', closed: [TOUR_CLOSED_NEW, TOUR_CANCELED, TOUR_CLOSED_OLD] };
    renderPage();

    await user.click(screen.getByRole('link', { name: 'Closed' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Closed tours' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Closed' })).toHaveAttribute('aria-current', 'page');
    expect(useClosedToursSpy).toHaveBeenCalledWith(true);
    // The Active sections are gone on this view.
    expect(screen.queryByRole('region', { name: 'Upcoming tours' })).not.toBeInTheDocument();

    const region = screen.getByRole('region', { name: 'Closed tours' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Newest first (the hook's order is respected).
    const first = within(items[0]!).getByRole('link');
    expect(first).toHaveAttribute('href', '/tours/x1');
    expect(within(items[0]!).getByText('Alice Smith')).toBeInTheDocument();
    // The lead meta column shows the tour DATE, not a bare time-of-day.
    expect(within(items[0]!).getByText(/Jul 14, 2026/)).toBeInTheDocument();
    expect(within(items[0]!).getByText('Closed')).toBeInTheDocument();
    // A canceled tour lists here too, its badge telling it apart.
    expect(within(items[1]!).getByRole('link')).toHaveAttribute('href', '/tours/k1');
    expect(within(items[1]!).getByText('Canceled')).toBeInTheDocument();
    expect(within(items[2]!).getByRole('link')).toHaveAttribute('href', '/tours/x2');
  });

  it('clicking Active from the Closed view returns to the two main sections', async () => {
    const user = userEvent.setup();
    readyAll([TOUR_TODAY], []);
    closedState = { status: 'ready', closed: [TOUR_CLOSED_NEW] };
    renderPage('/tours/closed');

    expect(screen.getByRole('region', { name: 'Closed tours' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Active' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Tours' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Closed tours' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Upcoming tours' })).toBeInTheDocument();
  });

  it('Closed view: resolves names for SOFT-DELETED contacts and units (never raw ids)', () => {
    // A closed tour outlives its entities: the tenant and the property were both
    // soft-deleted after the tour ended. They exist ONLY in the deleted lists —
    // the row must still show their real name/address, not the raw uuids.
    const deletedContact: Contact = {
      contactId: 'c-del',
      type: 'tenant',
      firstName: 'Dora',
      lastName: 'Departed',
      phone: '+14040000009',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      deleted_at: '2026-07-20T00:00:00Z',
    };
    const deletedUnit: UnitItem = {
      unitId: 'u-del',
      landlordId: 'l1',
      status: 'occupied',
      jurisdiction: 'atlanta_housing',
      address: { line1: '789 Gone St', city: 'Atlanta', state: 'GA', zip: '30303' },
      deleted_at: '2026-07-21T00:00:00Z',
    };
    const closedTourDeletedRefs: Tour = {
      tourId: 'x9',
      tenantId: 'c-del',
      unitId: 'u-del',
      scheduledAt: '2026-07-10T18:00:00Z',
      tourType: 'self_guided',
      status: 'closed',
      outcome: 'not_a_fit',
      moveForward: false,
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-10T19:00:00Z',
    };
    readyAll([], []);
    deletedContactsState = { status: 'ready', contacts: [deletedContact] };
    deletedUnitsState = { status: 'ready', units: [deletedUnit] };
    closedState = { status: 'ready', closed: [closedTourDeletedRefs] };
    renderPage('/tours/closed');

    const region = screen.getByRole('region', { name: 'Closed tours' });
    expect(within(region).getByText('Dora Departed')).toBeInTheDocument();
    expect(within(region).getByText(/789 Gone St/)).toBeInTheDocument();
    expect(within(region).queryByText('c-del')).not.toBeInTheDocument();
    expect(within(region).queryByText('u-del')).not.toBeInTheDocument();
  });

  it('shows the Closed empty state when there are no closed tours', () => {
    readyAll([], []);
    closedState = { status: 'ready', closed: [] };
    renderPage('/tours/closed');
    const region = screen.getByRole('region', { name: 'Closed tours' });
    expect(within(region).getByText(/no closed or canceled tours/i)).toBeInTheDocument();
  });

  it('shows the page alert when the closed fetch fails on the Closed view', () => {
    readyAll([], []);
    closedState = { status: 'error', closed: [] };
    renderPage('/tours/closed');
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t load|try again/i);
    expect(screen.queryByRole('region', { name: 'Closed tours' })).not.toBeInTheDocument();
  });

  // --- "+ New tour" (Active-view header action) ---

  it('"+ New tour" opens the Schedule-a-tour dialog with BOTH sides as free typeaheads', async () => {
    const user = userEvent.setup();
    readyAll([], []);
    renderPage();

    await user.click(screen.getByRole('button', { name: '+ New tour' }));
    expect(await screen.findByRole('dialog', { name: 'Schedule a tour' })).toBeInTheDocument();
    // No locked tenant here (unlike the tenant file's entry): both typeaheads.
    expect(screen.getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Unit' })).toBeInTheDocument();
    // Cancel closes it without creating anything.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createTour).not.toHaveBeenCalled();
  });

  it('the Closed view has NO "+ New tour" action', () => {
    readyAll([], []);
    closedState = { status: 'ready', closed: [] };
    renderPage('/tours/closed');
    expect(screen.queryByRole('button', { name: '+ New tour' })).not.toBeInTheDocument();
  });

  // --- Rendering order (component respects hook-provided order) ---
  // useTours sorts ascending by scheduledAt before returning; the component renders
  // whatever order the hook supplies. Here we supply already-sorted data and assert
  // the component renders the "Today" group first.
  it('renders upcoming groups in the order provided (soonest date first)', () => {
    // TOUR_TODAY comes before TOUR_NEXT_WEEK in scheduledAt — provide soonest first.
    readyAll([TOUR_TODAY, TOUR_NEXT_WEEK]);
    renderPage();
    const upcoming = screen.getByRole('region', { name: 'Upcoming tours' });
    // Today group is first.
    const allLists = within(upcoming).getAllByRole('list');
    expect(allLists).toHaveLength(2);
    // First group = Today; its only item is Alice Smith (t1).
    const firstGroupItems = within(allLists[0]!).getAllByRole('listitem');
    expect(firstGroupItems).toHaveLength(1);
    // The item links to today's tour.
    expect(within(firstGroupItems[0]!).getByRole('link')).toHaveAttribute('href', '/tours/t1');
  });
});

// ---------------------------------------------------------------------------
// Past view (/tours/past) - spec 4.1, 4.3, 4.4, 4.5
// ---------------------------------------------------------------------------

describe('ToursPage - Past view', () => {
  /** `days` days ago at `hours`:00 local, as the wire ISO string. */
  function daysAgoAt(days: number, hours: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hours, 0, 0, 0);
    return d.toISOString();
  }
  /** U+202F / U+00A0 -> a plain space, as the page's whenLabel does (repo
   *  convention, inbox/inboxTime.ts): an ICU 72+ host emits U+202F before
   *  AM/PM, and these tests compare exact strings. */
  const NBSP_LIKE = /[\u202f\u00a0]/g;
  /** The row's own "Sep 24, 2026, 2:30 PM" string for an ISO instant. */
  function whenLabel(iso: string): string {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${date}, ${time}`.replace(NBSP_LIKE, ' ');
  }
  const NOT_MARKED: Tour = { tourId: 'p1', tenantId: 'c1', unitId: 'u1', scheduledAt: daysAgoAt(1, 14), tourType: 'self_guided', status: 'scheduled' };
  const NEEDS_OUTCOME: Tour = { tourId: 'p2', tenantId: 'c2', unitId: 'u2', scheduledAt: daysAgoAt(2, 10), tourType: 'landlord_led', status: 'toured' };
  const NO_SHOW: Tour = { tourId: 'p3', tenantId: 'c1', unitId: 'u2', scheduledAt: daysAgoAt(3, 9), tourType: 'pm_team', status: 'no_show' };
  const NOT_MARKED_2: Tour = { tourId: 'p4', tenantId: 'c2', unitId: 'u1', scheduledAt: daysAgoAt(4, 11), tourType: 'self_guided', status: 'scheduled' };
  const NEEDS_PLACEMENT: Tour = { tourId: 'p5', tenantId: 'c2', unitId: 'u2', scheduledAt: daysAgoAt(5, 12), tourType: 'self_guided', status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true };
  // Labels use the file's real fixtures: c1 = Alice Smith, c2 = Bob Jones,
  // u1 = "123 Peachtree St, Atlanta, GA, 30303", u2 = "456 Oak Ave, Decatur,
  // GA, 30030" (formatAddress joins line1, city, state, zip with ", ").
  const U1 = '123 Peachtree St, Atlanta, GA, 30303';
  const P1_LABEL = `Alice Smith at ${U1} on ${whenLabel(NOT_MARKED.scheduledAt!)}`;
  const P4_LABEL = `Bob Jones at ${U1} on ${whenLabel(NOT_MARKED_2.scheduledAt!)}`;

  function readyPast(rows: Tour[], reloadFailed = false): void {
    readyAll([], []);
    pastRows = { status: 'ready', past: rows, reloadFailed };
  }

  it('renders the heading, the 90-day intro, the Past tab current, and the empty state', () => {
    readyPast([]);
    renderPage('/tours/past');
    expect(screen.getByRole('heading', { level: 1, name: 'Past tours' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Last 90 days: tours that were never marked toured, toured tours still waiting on an outcome or a placement, and no-shows.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Past' })).toHaveAttribute('aria-current', 'page');
    expect(usePastToursSpy).toHaveBeenCalledWith(true);
    expect(screen.getByText('No past tours need attention in the last 90 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Upcoming tours' })).not.toBeInTheDocument();
  });

  it('rows: date + time, tenant, property, plain-words state, date-time in the label, and the row link carrying state.back', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NEEDS_OUTCOME, NO_SHOW]);
    renderPage('/tours/past');
    const region = screen.getByRole('region', { name: 'Past tours' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Order is the hook's order (most recent first).
    const rowLink = within(items[0]!).getByRole('link', { name: `Tour for ${P1_LABEL}` });
    expect(rowLink).toHaveAttribute('href', '/tours/p1');
    expect(within(items[0]!).getByText('Not marked')).toBeInTheDocument();
    expect(within(items[0]!).getByText(whenLabel(NOT_MARKED.scheduledAt!))).toBeInTheDocument();
    expect(within(items[1]!).getByText('Needs outcome')).toBeInTheDocument();
    expect(within(items[2]!).getByText('No show')).toBeInTheDocument();
    // No tour-type badge on Past rows.
    expect(within(region).queryByText('Self-guided')).not.toBeInTheDocument();
    // The row link carries the back pointer.
    await user.click(rowLink);
    expect(screen.getByTestId('loc')).toHaveTextContent('/tours/p1|{"back":"/tours/past"}');
  });

  it('the date-time reads with plain spaces in the row and every label even where the host ICU puts U+202F before AM/PM', () => {
    // Force the ICU 72+ output on this host: a narrow no-break space before AM/PM.
    const toTime = Date.prototype.toLocaleTimeString;
    const narrowNbsp = String.fromCharCode(0x202f);
    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): string {
      return toTime.call(this, locales, options).replace(' ', narrowNbsp);
    });
    readyPast([NOT_MARKED]);
    renderPage('/tours/past');
    const item = within(screen.getByRole('region', { name: 'Past tours' })).getAllByRole('listitem')[0]!;
    // Exact compares (no whitespace normalization on either side).
    expect(within(item).getByRole('link', { name: `Tour for ${P1_LABEL}` })).toHaveAttribute(
      'aria-label',
      `Tour for ${P1_LABEL}`,
    );
    expect(within(item).getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toHaveAttribute(
      'aria-label',
      `Mark toured: ${P1_LABEL}`,
    );
    const when = whenLabel(NOT_MARKED.scheduledAt!);
    expect(within(item).getByText(when).textContent).toBe(when);
  });

  it('row actions: Mark toured + checkbox on Not marked; Record outcome deep link (with state.back) on Needs outcome; none on No show or Needs placement', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NEEDS_OUTCOME, NO_SHOW, NEEDS_PLACEMENT]);
    renderPage('/tours/past');
    const items = within(screen.getByRole('region', { name: 'Past tours' })).getAllByRole('listitem');
    expect(within(items[3]!).getByText('Needs placement')).toBeInTheDocument();
    expect(within(items[3]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(items[3]!).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(items[3]!).queryByRole('link', { name: /Record outcome/ })).not.toBeInTheDocument();
    expect(within(items[0]!).getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toBeInTheDocument();
    expect(within(items[0]!).getByRole('checkbox', { name: `Select tour for ${P1_LABEL}` })).toBeInTheDocument();
    const record = within(items[1]!).getByRole('link', { name: /^Record outcome: .* on / });
    expect(record).toHaveAttribute('href', '/tours/p2?outcome=1');
    expect(within(items[1]!).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('link', { name: /Record outcome/ })).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(record);
    expect(screen.getByTestId('loc')).toHaveTextContent('/tours/p2?outcome=1|{"back":"/tours/past"}');
  });

  it('bulk: select all -> Mark toured (N) re-reads then PATCHes each id sequentially, disables every control meanwhile, reports per row, reloads', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NEEDS_OUTCOME, NOT_MARKED_2]);
    // The re-read agrees with the list for p1 and reports p4 as canceled since.
    getTour.mockImplementation((id: string) =>
      Promise.resolve(id === 'p4' ? { ...NOT_MARKED_2, status: 'canceled' } : NOT_MARKED),
    );
    const order: string[] = [];
    // No initializer: an initializer of null would narrow the type to null,
    // and the release!() below would not typecheck.
    let release: (() => void) | undefined;
    patchTour.mockImplementation((id: string) => {
      order.push(id);
      // Hold the FIRST call so we can prove nothing else has started.
      return new Promise((resolve) => {
        release = () => resolve({ ...NOT_MARKED, tourId: id, status: 'toured' });
      });
    });
    renderPage('/tours/past');

    expect(screen.getByRole('button', { name: 'Mark toured (0)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select all not marked' }));
    expect(screen.getByRole('button', { name: 'Mark toured (2)' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Mark toured (2)' }));
    // p1 was re-read and PATCHed; p4 has not been touched yet (sequential).
    await waitFor(() => expect(order).toEqual(['p1']));
    expect(getTour).toHaveBeenCalledTimes(1);
    // Every mark control is disabled while the batch runs.
    expect(screen.getByRole('button', { name: 'Mark toured (2)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select all not marked' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    release!();

    // p4's re-read says canceled -> skipped, never PATCHed.
    await waitFor(() => expect(getTour).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['p1']);
    expect(patchTour).toHaveBeenCalledWith('p1', { status: 'toured' });

    const items = within(screen.getByRole('region', { name: 'Past tours' })).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('status')).toHaveTextContent('Marked toured');
    expect(within(items[2]!).getByRole('alert')).toHaveTextContent('Could not mark toured: Changed since the list loaded');
    // The failed row stays selected; the succeeded one left the selection.
    expect(screen.getByRole('button', { name: 'Mark toured (1)' })).toBeEnabled();
    expect(within(items[2]!).getByRole('checkbox')).toBeChecked();
    expect(within(items[0]!).getByRole('checkbox')).not.toBeChecked();
  });

  it('results whose rows the reload dropped are reported above the toolbar (a failure as alert, a success as status), from the snapshot', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockImplementation((id: string) =>
      Promise.resolve(id === 'p4' ? { ...NOT_MARKED_2, status: 'canceled' } : NOT_MARKED),
    );
    patchTour.mockResolvedValue({ ...NOT_MARKED, status: 'toured' });
    // The mocked hook is not reactive, so the "reload" swaps its rows
    // SYNCHRONOUSLY inside reloadPast(): the runner refreshes (reloadPast,
    // through the page's pointer) and then clears the page's busy flag in the
    // same async continuation, and React batches both into ONE render that
    // reads the new rows. Here the reload drops BOTH ids: p4 is canceled now,
    // and p1 (marked toured) is gone because its "toured" row was, say, given
    // an outcome meanwhile.
    reloadPast.mockImplementation(() => {
      pastRows = { status: 'ready', past: [], reloadFailed: false };
    });
    renderPage('/tours/past');
    await user.click(screen.getByRole('checkbox', { name: 'Select all not marked' }));
    await user.click(screen.getByRole('button', { name: 'Mark toured (2)' }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));

    // The list is empty now; both results survive above it, named from the
    // snapshot. findBy* waits for the batched render to commit.
    const region = await screen.findByRole('region', { name: 'Past tours' });
    expect(await within(region).findByText('No past tours need attention in the last 90 days.')).toBeInTheDocument();
    expect(await within(region).findByRole('alert')).toHaveTextContent(`${P4_LABEL}: Changed since the list loaded`);
    expect(await within(region).findByRole('status')).toHaveTextContent(`${P1_LABEL}: Marked toured`);
    // No per-row line is left dangling.
    expect(screen.queryByText('Could not mark toured: Changed since the list loaded')).not.toBeInTheDocument();
    expect(screen.queryByText('Marked toured', { exact: true })).not.toBeInTheDocument();
  });

  it('switching tabs unmounts the Past view: selection and results are gone when Past shows again', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockResolvedValue({ ...NOT_MARKED_2, status: 'canceled' });
    renderPage('/tours/past');
    await user.click(screen.getByRole('checkbox', { name: 'Select all not marked' }));
    await user.click(screen.getByRole('button', { name: 'Mark toured (2)' }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('link', { name: 'Active' }));
    expect(screen.queryByRole('region', { name: 'Past tours' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Past' }));
    const region = await screen.findByRole('region', { name: 'Past tours' });
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark toured (0)' })).toBeDisabled();
    for (const box of within(region).getAllByRole('checkbox')) {
      expect(box).not.toBeChecked();
    }
  });

  it('a tab round trip MID-BATCH remounts Past with every mark control still disabled, and the batch refreshes the remounted view', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockResolvedValue(NOT_MARKED);
    let release: (() => void) | undefined;
    patchTour.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...NOT_MARKED, status: 'toured' });
        }),
    );
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(patchTour).toHaveBeenCalledTimes(1));

    // Past -> Active -> Past while that PATCH is held. The second Past visit
    // is a NEW mount of the view, with its own reload function.
    await user.click(screen.getByRole('link', { name: 'Active' }));
    expect(screen.queryByRole('region', { name: 'Past tours' })).not.toBeInTheDocument();
    const reloadSecondVisit = vi.fn();
    usePastToursSpy.mockImplementation((enabled: boolean) => ({ ...pastHookAnswer(enabled), reload: reloadSecondVisit }));
    await user.click(screen.getByRole('link', { name: 'Past' }));
    const region = await screen.findByRole('region', { name: 'Past tours' });

    // Fresh view state (nothing selected, no result lines), but the batch is
    // still running: the busy flag is the page's, so no control is enabled
    // and silently inert.
    expect(screen.getByRole('button', { name: 'Mark toured (0)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Mark toured: ${P4_LABEL}` })).toBeDisabled();
    for (const box of within(region).getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(within(region).queryByRole('status')).not.toBeInTheDocument();

    release!();
    // The batch's refresh reaches the view mounted NOW (through the page-owned
    // pointer), never the unmounted first one, and the controls come back.
    await waitFor(() => expect(reloadSecondVisit).toHaveBeenCalledTimes(1));
    expect(reloadPast).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Select all not marked' })).toBeEnabled(),
    );
    expect(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` })).toBeEnabled();
    expect(patchTour).toHaveBeenCalledTimes(1);
  });

  it('the row button marks that one tour (one re-read, one PATCH), and the batch never sends an outcome or closed', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED, NOT_MARKED_2]);
    getTour.mockResolvedValue(NOT_MARKED);
    patchTour.mockResolvedValue({ ...NOT_MARKED, status: 'toured' });
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(patchTour).toHaveBeenCalledTimes(1));
    expect(getTour).toHaveBeenCalledTimes(1);
    expect(patchTour).toHaveBeenCalledWith('p1', { status: 'toured' });
    for (const [, body] of patchTour.mock.calls as [string, Record<string, unknown>][]) {
      expect(Object.keys(body)).toEqual(['status']);
    }
    expect(reloadPast).toHaveBeenCalledTimes(1);
  });

  it('a tour RESCHEDULED since the list loaded (still scheduled, different time) is skipped as Changed since the list loaded', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED]);
    getTour.mockResolvedValue({ ...NOT_MARKED, scheduledAt: '2030-01-10T15:00:00.000Z' });
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect(patchTour).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not mark toured: Changed since the list loaded');
  });

  it('a PATCH failure reads The update failed', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED]);
    getTour.mockResolvedValue(NOT_MARKED);
    patchTour.mockRejectedValue(new ApiError(409, 'illegal_status_transition', 'illegal_status_transition'));
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not mark toured: The update failed');
    expect(alert).not.toHaveTextContent('illegal_status_transition');
  });

  it('a failed re-read is reported as Could not check the tour and the tour is not PATCHed', async () => {
    const user = userEvent.setup();
    readyPast([NOT_MARKED]);
    getTour.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    renderPage('/tours/past');
    await user.click(screen.getByRole('button', { name: `Mark toured: ${P1_LABEL}` }));
    await waitFor(() => expect(reloadPast).toHaveBeenCalledTimes(1));
    expect(patchTour).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not mark toured: Could not check the tour');
  });

  it('shows the page error when the FIRST Past fetch fails', () => {
    readyAll([], []);
    pastRows = { status: 'error', past: [], reloadFailed: false };
    renderPage('/tours/past');
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load/i);
    expect(screen.queryByRole('region', { name: 'Past tours' })).not.toBeInTheDocument();
  });

  it('a failed RELOAD keeps the rows and adds one refresh alert above the toolbar', () => {
    readyPast([NOT_MARKED], true);
    renderPage('/tours/past');
    const region = screen.getByRole('region', { name: 'Past tours' });
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
    expect(within(region).getByRole('alert')).toHaveTextContent(
      'Could not refresh the list. Reload the page to see the latest.',
    );
  });
});
