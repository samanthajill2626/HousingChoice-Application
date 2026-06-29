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
    jurisdiction: 'atlanta_housing',
    address: { line1: '123 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
    beds: 2,
    baths: 1,
    rent_min: 1400,
    rent_max: 1600,
  },
  {
    unitId: 'u2',
    landlordId: 'l2',
    status: 'occupied',
    jurisdiction: 'ga_dca',
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
  it('shows a Properties heading and a spinner while loading', () => {
    state = { status: 'loading', units: [] };
    renderList();
    expect(screen.getByRole('heading', { level: 1, name: 'Properties' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an inline error on failure', () => {
    state = { status: 'error', units: [] };
    renderList();
    expect(screen.getByText(/couldn.t load|try again/i)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no properties', () => {
    state = { status: 'ready', units: [] };
    renderList();
    expect(screen.getByText(/no properties yet/i)).toBeInTheDocument();
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

  it('filters by status via the dropdown', async () => {
    state = { status: 'ready', units: UNITS };
    renderList();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'occupied');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText(/88 Oak Ave/)).toBeInTheDocument();
  });

  it('multi-selects housing authorities and clears back to all properties', async () => {
    state = { status: 'ready', units: UNITS };
    renderList();
    const haGroup = screen.getByRole('group', { name: /housing authority/i });

    // Pick one authority → only its listing shows.
    await userEvent.click(within(haGroup).getByRole('button', { name: 'Atlanta Housing' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /123 Peachtree St/ })).toBeInTheDocument();

    // Add a second (multi-select) → both show.
    await userEvent.click(within(haGroup).getByRole('button', { name: 'GA DCA' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    // Clear → back to all, and the Clear control disappears.
    await userEvent.click(within(haGroup).getByRole('button', { name: /clear/i }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(within(haGroup).queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });

  it('combines the status + housing-authority filters (AND)', async () => {
    state = { status: 'ready', units: UNITS };
    renderList();
    // Status=available (u1) AND authority=GA DCA (u2) → no overlap → no matches.
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'available');
    const haGroup = screen.getByRole('group', { name: /housing authority/i });
    await userEvent.click(within(haGroup).getByRole('button', { name: 'GA DCA' }));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText(/no properties match the selected filters/i)).toBeInTheDocument();
  });
});
