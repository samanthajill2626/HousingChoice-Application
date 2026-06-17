import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import type { ListingsState } from './useListings.js';

// Drive the view through a mocked useListings so these tests are independent of
// fetching (covered separately) and assert the rendered rows/links, the search
// box, and the loading/error/empty states.
let state: ListingsState = { status: 'loading', units: [] };
vi.mock('./useListings.js', () => ({ useListings: () => state }));

import { ListingsList } from './ListingsList.js';

const UNITS: UnitItem[] = [
  {
    unitId: 'u1',
    landlordId: 'l1',
    status: 'available',
    address: { line1: '123 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
    beds: 2,
    baths: 1,
    rent_min: 1400,
    rent_max: 1600,
  },
  {
    unitId: 'u2',
    landlordId: 'l2',
    status: 'placed',
    address: { line1: '88 Oak Ave', city: 'Decatur', state: 'GA' },
    beds: 3,
    baths: 2,
    rent_min: 1800,
  },
];

function renderList(): void {
  render(
    <MemoryRouter>
      <ListingsList />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state = { status: 'loading', units: [] };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ListingsList', () => {
  it('shows a Listings heading and a spinner while loading', () => {
    state = { status: 'loading', units: [] };
    renderList();
    expect(screen.getByRole('heading', { level: 1, name: 'Listings' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an inline error on failure', () => {
    state = { status: 'error', units: [] };
    renderList();
    expect(screen.getByText(/couldn.t load|try again/i)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no listings', () => {
    state = { status: 'ready', units: [] };
    renderList();
    expect(screen.getByText(/no listings yet/i)).toBeInTheDocument();
  });

  it('renders a row per unit with address, status, beds/baths, rent, and a detail link', () => {
    state = { status: 'ready', units: UNITS };
    renderList();
    const row = screen.getByRole('link', { name: /123 Peachtree St/ });
    expect(row).toHaveAttribute('href', '/listings/u1');
    expect(within(row).getByText(/available/i)).toBeInTheDocument();
    expect(within(row).getByText(/2 \/ 1/)).toBeInTheDocument();
    expect(within(row).getByText(/\$1,400/)).toBeInTheDocument();
  });

  it('filters the rows client-side via the search box (by address)', async () => {
    state = { status: 'ready', units: UNITS };
    renderList();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    const search = screen.getByRole('searchbox', { name: /search/i });
    await userEvent.type(search, 'decatur');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText(/88 Oak Ave/)).toBeInTheDocument();
  });

  it('shows a no-matches state when the search excludes every row', async () => {
    state = { status: 'ready', units: UNITS };
    renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzzzz');
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });
});
