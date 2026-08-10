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

// LEGACY units: both carry only the retired `jurisdiction` string, so the
// authority chips they produce come from read-time synthesis (spec section 8).
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

  it('lists a unit under EVERY authority it accepts', async () => {
    state = {
      status: 'ready',
      units: [
        {
          unitId: 'u3',
          landlordId: 'l3',
          status: 'available',
          accepted_authorities: ['atlanta_housing', 'ga_dca'],
          address: { line1: '9 Both Ways Ct' },
        },
        {
          unitId: 'u4',
          landlordId: 'l4',
          status: 'available',
          accepted_authorities: ['ga_dca'],
          address: { line1: '10 Solo Rd' },
        },
      ],
    };
    renderList();
    const haGroup = screen.getByRole('group', { name: /housing authority/i });

    // The two-authority unit shows under the first authority...
    await userEvent.click(within(haGroup).getByRole('button', { name: 'Atlanta Housing' }));
    let rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText(/9 Both Ways Ct/)).toBeInTheDocument();

    // ...and under the second one too, alongside the single-authority unit.
    await userEvent.click(within(haGroup).getByRole('button', { name: 'Atlanta Housing' }));
    await userEvent.click(within(haGroup).getByRole('button', { name: 'GA DCA' }));
    rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
  });

  it('groups spelling variants of one authority under a single chip', async () => {
    // Same authority, three stored spellings: a legacy slug, a SHOUTED value with
    // an interior double-space, and the prose spelling twice. The normalized key
    // folds underscores, whitespace and case, so ONE chip must cover all four
    // units - and it DISPLAYS the most frequent raw spelling, not the key.
    //
    // The spellings are chosen so that claim is FALSIFIABLE. `Atlanta Housing`
    // (the obvious fixture) cannot do it: the slug, both prose variants AND the
    // case-folded key all humanize to the identical "Atlanta Housing", so the
    // assertion would pass even if displaySpelling returned the key. Here the key
    // and the slug humanize to "Dekalb County Housing" (lowercase k - humanizing
    // only title-cases the first letter) and the shouted variant to "DEKALB
    // County Housing", so only the most frequent RAW spelling renders "DeKalb".
    state = {
      status: 'ready',
      units: [
        {
          unitId: 'u5',
          landlordId: 'l5',
          status: 'available',
          jurisdiction: 'dekalb_county_housing',
          address: { line1: '5 Slug Ln' },
        },
        {
          unitId: 'u6',
          landlordId: 'l6',
          status: 'available',
          accepted_authorities: ['DEKALB  County Housing'],
          address: { line1: '6 Shouted Way' },
        },
        {
          unitId: 'u7',
          landlordId: 'l7',
          status: 'available',
          accepted_authorities: ['DeKalb County Housing'],
          address: { line1: '7 Prose St' },
        },
        {
          unitId: 'u7b',
          landlordId: 'l7b',
          status: 'available',
          accepted_authorities: ['DeKalb County Housing'],
          address: { line1: '7 Prose Twin St' },
        },
      ],
    };
    renderList();
    const haGroup = screen.getByRole('group', { name: /housing authority/i });
    expect(within(haGroup).getAllByRole('button')).toHaveLength(1);

    // Exact name match: "Dekalb County Housing" would NOT satisfy it.
    await userEvent.click(within(haGroup).getByRole('button', { name: 'DeKalb County Housing' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('humanizes the raw display spelling, not the case-folded grouping key', async () => {
    state = {
      status: 'ready',
      units: [
        {
          unitId: 'u8',
          landlordId: 'l8',
          status: 'available',
          accepted_authorities: ['Atlanta (AHA)'],
          address: { line1: '8 Canonical Cir' },
        },
      ],
    };
    renderList();
    const haGroup = screen.getByRole('group', { name: /housing authority/i });
    // The grouping key is 'atlanta (aha)'; humanizing THAT would render
    // "Atlanta (aha)". The chip must carry the stored spelling's case.
    expect(within(haGroup).getByRole('button', { name: 'Atlanta (AHA)' })).toBeInTheDocument();
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
