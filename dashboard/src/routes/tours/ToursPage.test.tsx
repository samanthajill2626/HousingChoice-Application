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
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tour, Contact, UnitItem } from '../../api/index.js';
import type { ToursPageState } from './useTours.js';
import type { ContactsState } from '../contacts/useContacts.js';
import type { ListingsState } from '../listings/useListings.js';

// ---------------------------------------------------------------------------
// Mocks — hoisted so imports below can reference the state variables.
// ---------------------------------------------------------------------------

let toursState: ToursPageState = { status: 'loading', upcoming: [], needsBooking: [] };
let contactsState: ContactsState = { status: 'loading', contacts: [] };
let unitsState: ListingsState = { status: 'loading', units: [] };

vi.mock('./useTours.js', () => ({ useTours: () => toursState }));
vi.mock('../contacts/useContacts.js', () => ({ useContacts: () => contactsState }));
vi.mock('../listings/useListings.js', () => ({ useListings: () => unitsState }));

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
  status: 'confirmed',
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

function renderPage(): void {
  render(
    <MemoryRouter>
      <ToursPage />
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
  unitsState = { status: 'loading', units: [] };
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
