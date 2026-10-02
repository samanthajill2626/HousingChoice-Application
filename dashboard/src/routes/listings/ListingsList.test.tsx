import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import type { ListingsState } from './useListings.js';

// Drive the view through a mocked useListings so these tests are independent of
// fetching (covered separately) and assert the rendered rows/links, the filters,
// the summary, and the loading/error/empty states. The mock answers per VIEW, so
// a test can walk from the Active tab to the Deleted tab on one mounted list.
let activeState: ListingsState = { status: 'loading', units: [] };
let deletedState: ListingsState = { status: 'ready', units: [] };
vi.mock('./useListings.js', () => ({
  useListings: (deleted: boolean) => (deleted ? deletedState : activeState),
}));

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

/** The summary world: two authorities, a multi-authority property, a property
 *  with no authority, and one whose only authority has nothing to move. */
const SUMMARY_UNITS: UnitItem[] = [
  {
    unitId: 'a1',
    landlordId: 'l1',
    status: 'available',
    accepted_authorities: ['DCA'],
    voucher_size_accepted: 2,
    address: { line1: '1 Avail Two St' },
  },
  {
    unitId: 'a2',
    landlordId: 'l1',
    status: 'available',
    accepted_authorities: ['DCA', 'Atlanta (AHA)'],
    voucher_size_accepted: [2, 3] as unknown as number,
    address: { line1: '2 Avail Both Ave' },
  },
  {
    unitId: 's1',
    landlordId: 'l1',
    status: 'setup',
    accepted_authorities: ['dca'],
    voucher_size_accepted: 2,
    address: { line1: '3 Soon Two Ct' },
  },
  {
    unitId: 's2',
    landlordId: 'l1',
    status: 'setup',
    accepted_authorities: [],
    address: { line1: '4 Soon Nobody Rd' },
  },
  {
    unitId: 'o1',
    landlordId: 'l1',
    status: 'occupied',
    accepted_authorities: ['Fulton County'],
    voucher_size_accepted: 3,
    address: { line1: '5 Occupied Ln' },
  },
];

/** Renders the current path + query so a test can assert the URL contract. A
 *  plain span: an <output> carries the implicit `status` role, which would
 *  collide with the loading spinner's. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

/** A stand-in for the browser's Back button. */
function BackButton(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Browser back
    </button>
  );
}

/** The two list routes exactly as App.tsx mounts them (siblings, same element
 *  position - so the list stays MOUNTED across a tab switch), plus a property
 *  page to navigate into and back out of. */
function renderAt(entry = '/listings'): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/listings" element={<ListingsList />} />
        <Route path="/listings/deleted" element={<ListingsList deleted />} />
        <Route path="/listings/:unitId" element={<p>Property page</p>} />
      </Routes>
      <LocationProbe />
      <BackButton />
    </MemoryRouter>,
  );
}

const location = (): string => screen.getByTestId('location').textContent ?? '';
const rows = (): HTMLElement[] => screen.queryAllByRole('listitem');
const rowText = (): string[] => rows().map((r) => r.textContent ?? '');
const statusSelect = (): HTMLSelectElement => screen.getByLabelText('Status') as HTMLSelectElement;
const haGroup = (): HTMLElement => screen.getByRole('group', { name: /housing authority/i });
const voucherGroup = (): HTMLElement => screen.getByRole('group', { name: /voucher size/i });
const summaryTable = (): HTMLElement => screen.getByRole('table', { name: /by housing authority/i });
/** The summary row whose header cell reads exactly `label`. */
function summaryRow(label: string): HTMLElement {
  const header = within(summaryTable()).getByRole('rowheader', { name: label });
  return header.closest('tr') as HTMLElement;
}
/** The two count cells of one summary row, as text. */
const countsOf = (label: string): string[] =>
  within(summaryRow(label))
    .getAllByRole('cell')
    .map((c) => c.textContent ?? '');

beforeEach(() => {
  activeState = { status: 'loading', units: [] };
  deletedState = { status: 'ready', units: [] };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ListingsList', () => {
  it('shows a Properties heading and a spinner while loading', () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: 'Properties' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an inline error on failure', () => {
    activeState = { status: 'error', units: [] };
    renderAt();
    expect(screen.getByText(/couldn.t load|try again/i)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no properties', () => {
    activeState = { status: 'ready', units: [] };
    renderAt();
    expect(screen.getByText(/no properties yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a row per unit with address, status, beds/baths, rent, and a detail link', () => {
    activeState = { status: 'ready', units: UNITS };
    renderAt();
    const row = screen.getByRole('link', { name: /123 Peachtree St/ });
    expect(row).toHaveAttribute('href', '/listings/u1');
    expect(within(row).getByText(/available/i)).toBeInTheDocument();
    expect(within(row).getByText(/2 \/ 1/)).toBeInTheDocument();
    expect(within(row).getByText(/\$1,400/)).toBeInTheDocument();
  });

  describe('the status default', () => {
    it('opens the Active tab on Available, with a bare URL', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt();
      expect(statusSelect().value).toBe('available');
      expect(rowText()).toEqual([expect.stringContaining('123 Peachtree St')]);
      expect(location()).toBe('/listings');

      await userEvent.selectOptions(statusSelect(), 'all');
      expect(rows()).toHaveLength(2);
      expect(location()).toBe('/listings?status=all');
    });

    it('says Available is the default in the subtitle', () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt();
      expect(screen.getByText(/available properties by default/i)).toBeInTheDocument();
    });

    it('opens the Deleted tab on every status, without a summary', () => {
      deletedState = { status: 'ready', units: [{ ...UNITS[1]!, deleted_at: '2026-09-01T00:00:00Z' }] };
      renderAt('/listings/deleted');
      expect(statusSelect().value).toBe('all');
      expect(rowText()).toEqual([expect.stringContaining('88 Oak Ave')]);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('filters by any one status via the dropdown', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt();
      await userEvent.selectOptions(statusSelect(), 'occupied');
      expect(rowText()).toEqual([expect.stringContaining('88 Oak Ave')]);
      expect(location()).toBe('/listings?status=occupied');
    });
  });

  describe('search', () => {
    it('filters the rows by address and keeps the text in the URL', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings?status=all');
      expect(rows()).toHaveLength(2);

      const search = screen.getByRole('searchbox', { name: /search/i });
      await userEvent.type(search, 'decatur');
      expect(rowText()).toEqual([expect.stringContaining('88 Oak Ave')]);
      expect(search).toHaveValue('decatur');
      expect(location()).toBe('/listings?status=all&q=decatur');
    });

    it('shows a no-matches state when the search excludes every row', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt();
      await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzzzz');
      expect(screen.getByText(/no matches/i)).toBeInTheDocument();
    });
  });

  describe('the by-housing-authority summary', () => {
    it('shows All, then each authority (stored spelling), then no-authority; hides zero rows', () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      const table = summaryTable();
      expect(within(table).getByRole('columnheader', { name: 'Available' })).toBeInTheDocument();
      expect(within(table).getByRole('columnheader', { name: 'Coming soon (Setup)' })).toBeInTheDocument();
      const headers = within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent);
      // Fulton County has only an occupied property: nothing to move, no row.
      expect(headers).toEqual(['All authorities', 'Atlanta (AHA)', 'DCA', 'No authority recorded']);
      expect(screen.getByText(/counts under each/i)).toBeInTheDocument();
    });

    it('counts each property once in All and under every authority it accepts', () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      expect(countsOf('All authorities')).toEqual(['2', '2']);
      expect(countsOf('DCA')).toEqual(['2', '1']);
      expect(countsOf('Atlanta (AHA)')).toEqual(['1', '0']);
      expect(countsOf('No authority recorded')).toEqual(['0', '1']);
    });

    it('links every non-zero count and leaves a zero as plain text', () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      const atlanta = summaryRow('Atlanta (AHA)');
      expect(within(atlanta).getAllByRole('link')).toHaveLength(1);
      expect(
        within(atlanta).getByRole('link', { name: 'Show 1 available property for Atlanta (AHA)' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Show 2 coming soon properties for all authorities' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Show 1 coming soon property with no housing authority recorded' }),
      ).toBeInTheDocument();
    });

    it('a count sets its status and authority, keeps the voucher filter, and clears the search', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?voucher=2');
      await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz');
      expect(rows()).toHaveLength(0);

      await userEvent.click(screen.getByRole('link', { name: 'Show 1 coming soon property for DCA' }));
      expect(statusSelect().value).toBe('setup');
      expect(within(haGroup()).getByRole('button', { name: 'DCA' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(voucherGroup()).getByRole('button', { name: '2-BR' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('');
      expect(rowText()).toEqual([expect.stringContaining('3 Soon Two Ct')]);
      expect(location()).toBe('/listings?status=setup&voucher=2&ha=dca');
    });

    it('a count is a navigation: Back returns to the view it was clicked from', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?q=Avail');
      await userEvent.click(screen.getByRole('link', { name: 'Show 1 coming soon property for DCA' }));
      expect(location()).toBe('/listings?status=setup&ha=dca');

      await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/listings?q=Avail');
      expect(statusSelect().value).toBe('available');
      expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('Avail');
      expect(rows()).toHaveLength(2);
    });

    it('the All row clears the authority filter', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?ha=atlanta+%28aha%29');
      expect(rows()).toHaveLength(1);
      await userEvent.click(screen.getByRole('link', { name: 'Show 2 available properties for all authorities' }));
      expect(within(haGroup()).queryAllByRole('button', { pressed: true })).toHaveLength(0);
      expect(rows()).toHaveLength(2);
    });

    it('the no-authority row selects the Not recorded authority chip', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      await userEvent.click(
        screen.getByRole('link', { name: 'Show 1 coming soon property with no housing authority recorded' }),
      );
      expect(within(haGroup()).getByRole('button', { name: 'Not recorded' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(rowText()).toEqual([expect.stringContaining('4 Soon Nobody Rd')]);
    });

    it('follows the voucher filter, and only the voucher filter', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '3-BR' }));
      const headers = within(summaryTable())
        .getAllByRole('rowheader')
        .map((h) => h.textContent);
      // 3-BR: a2 (available; DCA + Atlanta) - o1 is occupied, so Fulton stays out.
      expect(headers).toEqual(['All authorities', 'Atlanta (AHA)', 'DCA']);
      expect(countsOf('DCA')).toEqual(['1', '0']);

      // The status and authority filters never move the counts.
      await userEvent.selectOptions(statusSelect(), 'occupied');
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'Fulton County' }));
      expect(countsOf('DCA')).toEqual(['1', '0']);
    });
  });

  describe('voucher size', () => {
    it('filters on one number or a list, OR within the facet, with a Clear', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?status=all');
      expect(
        within(voucherGroup())
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Studio', '1-BR', '2-BR', '3-BR', '4+ BR', 'Not recorded']);

      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '3-BR' }));
      // a2 accepts [2, 3]; o1 accepts 3.
      expect(rowText()).toEqual([
        expect.stringContaining('2 Avail Both Ave'),
        expect.stringContaining('5 Occupied Ln'),
      ]);
      expect(location()).toBe('/listings?status=all&voucher=3');

      await userEvent.click(within(voucherGroup()).getByRole('button', { name: 'Not recorded' }));
      expect(rows()).toHaveLength(3); // + s2, which records no size

      await userEvent.click(within(voucherGroup()).getByRole('button', { name: /clear voucher size filter/i }));
      expect(rows()).toHaveLength(5);
      expect(location()).toBe('/listings?status=all');
    });

    it('never treats bedrooms as a voucher size', async () => {
      activeState = {
        status: 'ready',
        units: [{ unitId: 'b1', landlordId: 'l1', status: 'available', beds: 2, address: { line1: '9 Beds Only St' } }],
      };
      renderAt();
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      expect(rows()).toHaveLength(0);
      expect(screen.getByText(/no properties match the selected filters/i)).toBeInTheDocument();
    });
  });

  describe('housing authority chips', () => {
    it('multi-selects housing authorities and clears back to all properties', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings?status=all');

      // Pick one authority -> only its listing shows.
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'atlanta_housing' }));
      expect(rowText()).toEqual([expect.stringContaining('123 Peachtree St')]);

      // Add a second (multi-select) -> both show.
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'ga_dca' }));
      expect(rows()).toHaveLength(2);

      // Clear -> back to all, and the Clear control disappears.
      await userEvent.click(within(haGroup()).getByRole('button', { name: /clear/i }));
      expect(rows()).toHaveLength(2);
      expect(within(haGroup()).queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    });

    it('lists a unit under EVERY authority it accepts', async () => {
      activeState = {
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
      renderAt();

      // The two-authority unit shows under the first authority...
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'atlanta_housing' }));
      expect(rowText()).toEqual([expect.stringContaining('9 Both Ways Ct')]);

      // ...and under the second one too, alongside the single-authority unit.
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'atlanta_housing' }));
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'ga_dca' }));
      expect(rows()).toHaveLength(2);
    });

    it('groups spelling variants of one authority under a single chip', async () => {
      // Same authority, three stored spellings: a legacy slug, a SHOUTED value with
      // an interior double-space, and the prose spelling twice. The normalized key
      // folds underscores, whitespace and case, so ONE chip covers all four units -
      // and it DISPLAYS the most frequent raw spelling, never the key.
      activeState = {
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
      renderAt();
      expect(within(haGroup()).getAllByRole('button')).toHaveLength(1);

      await userEvent.click(within(haGroup()).getByRole('button', { name: 'DeKalb County Housing' }));
      expect(rows()).toHaveLength(4);
    });

    it('shows every stored spelling exactly as stored - no prettifier', () => {
      activeState = {
        status: 'ready',
        units: [
          {
            unitId: 'u8',
            landlordId: 'l8',
            status: 'available',
            accepted_authorities: ['Atlanta (AHA)'],
            address: { line1: '8 Canonical Cir' },
          },
          {
            unitId: 'u9',
            landlordId: 'l9',
            status: 'available',
            accepted_authorities: ['Department of Community Affairs'],
            address: { line1: '9 State St' },
          },
          {
            unitId: 'u10',
            landlordId: 'l10',
            status: 'available',
            jurisdiction: 'atlanta_housing',
            address: { line1: '10 Legacy Ln' },
          },
        ],
      };
      renderAt();
      // The retired prettifier upper-cased short words ("Department OF
      // Community Affairs") and re-cased slugs ("Atlanta Housing"). Order is by
      // normalized key: 'atlanta (aha)' < 'atlanta housing' < 'department ...'.
      expect(
        within(haGroup())
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Atlanta (AHA)', 'atlanta_housing', 'Department of Community Affairs']);
      expect(
        within(summaryTable()).getByRole('rowheader', { name: 'Department of Community Affairs' }),
      ).toBeInTheDocument();
    });

    it('offers Not recorded only when some property lists no authority', () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings?status=all');
      expect(within(haGroup()).queryByRole('button', { name: 'Not recorded' })).not.toBeInTheDocument();
    });

    it('combines the status + housing-authority filters (AND)', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt();
      // Status=available (u1) AND authority=ga_dca (u2) -> no overlap -> no matches.
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'ga_dca' }));
      expect(rows()).toHaveLength(0);
      expect(screen.getByText(/no properties match the selected filters/i)).toBeInTheDocument();
    });
  });

  describe('filters in the URL', () => {
    it('restores every control from the URL', () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?status=setup&voucher=2&ha=dca&q=Soon');
      expect(statusSelect().value).toBe('setup');
      expect(within(voucherGroup()).getByRole('button', { name: '2-BR' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(within(haGroup()).getByRole('button', { name: 'DCA' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('Soon');
      expect(rowText()).toEqual([expect.stringContaining('3 Soon Two Ct')]);
    });

    it('Back from a property page returns to the same filtered view', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '3-BR' }));
      await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Both');
      await userEvent.click(screen.getByRole('link', { name: /2 Avail Both Ave/ }));
      expect(screen.getByText('Property page')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/listings?voucher=3&q=Both');
      expect(within(voucherGroup()).getByRole('button', { name: '3-BR' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('Both');
      expect(rowText()).toEqual([expect.stringContaining('2 Avail Both Ave')]);
    });

    it('re-clicking the current tab keeps the filters; the other tab starts clean', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings?status=all&q=Oak');
      const tabs = screen.getByRole('navigation', { name: 'Properties view' });
      await userEvent.click(within(tabs).getByRole('link', { name: 'Active' }));
      expect(location()).toBe('/listings?status=all&q=Oak');

      await userEvent.click(within(tabs).getByRole('link', { name: 'Deleted' }));
      expect(location()).toBe('/listings/deleted');
      expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('');
    });

    // docs/issues/properties-authority-filter-invisible-lock.md: an authority
    // picked on Active used to stay applied on Deleted, where no chip or Clear
    // could show it, and the Deleted list sat at zero rows with no way out.
    it('an authority picked on Active never filters the Deleted tab', async () => {
      activeState = { status: 'ready', units: UNITS };
      deletedState = {
        status: 'ready',
        units: [{ unitId: 'd1', landlordId: 'l1', status: 'off_market', address: { line1: '1 Gone St' } }],
      };
      renderAt();
      await userEvent.click(within(haGroup()).getByRole('button', { name: 'atlanta_housing' }));
      await userEvent.click(
        within(screen.getByRole('navigation', { name: 'Properties view' })).getByRole('link', {
          name: 'Deleted',
        }),
      );
      expect(rowText()).toEqual([expect.stringContaining('1 Gone St')]);
    });

    it('a stale authority key in a link does not empty the list', () => {
      deletedState = {
        status: 'ready',
        units: [
          {
            unitId: 'd1',
            landlordId: 'l1',
            status: 'off_market',
            accepted_authorities: ['DCA'],
            address: { line1: '1 Gone St' },
          },
        ],
      };
      renderAt('/listings/deleted?ha=atlanta+housing&ha=__none__');
      expect(rowText()).toEqual([expect.stringContaining('1 Gone St')]);
      expect(within(haGroup()).queryAllByRole('button', { pressed: true })).toHaveLength(0);
    });
  });
});
