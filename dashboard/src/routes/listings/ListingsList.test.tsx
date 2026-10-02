import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
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

/** Someone ELSE replacing the URL with the bare list - what the router does
 *  for a nav link whose target equals the current URL. */
function ForeignReplaceButton(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate('/listings', { replace: true })}>
      Foreign replace
    </button>
  );
}

/** The two list routes exactly as App.tsx mounts them (siblings, same element
 *  position - so the list stays MOUNTED across a tab switch), plus a property
 *  page to navigate into and back out of. `from` puts an earlier history entry
 *  behind the list, so a test can prove Back LEAVES the page. */
function renderAt(entry = '/listings', from?: string): void {
  render(
    <MemoryRouter initialEntries={from === undefined ? [entry] : [from, entry]} initialIndex={from === undefined ? 0 : 1}>
      <Routes>
        <Route path="/listings" element={<ListingsList />} />
        <Route path="/listings/deleted" element={<ListingsList deleted />} />
        <Route path="/listings/:unitId" element={<p>Property page</p>} />
        <Route path="/elsewhere" element={<p>Somewhere else</p>} />
      </Routes>
      <LocationProbe />
      <BackButton />
      <ForeignReplaceButton />
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
    it('filters as you type and saves the text to the URL when the box loses focus', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings?status=all');
      expect(rows()).toHaveLength(2);

      const search = screen.getByRole('searchbox', { name: /search/i });
      await userEvent.type(search, 'decatur');
      expect(rowText()).toEqual([expect.stringContaining('88 Oak Ave')]);
      expect(search).toHaveValue('decatur');
      // No history write per keystroke (WebKit throttles replaceState)...
      expect(location()).toBe('/listings?status=all');
      // ...the text is saved when focus moves on.
      await userEvent.tab();
      expect(location()).toBe('/listings?status=all&q=decatur');
    });

    it('typing never adds history: Back after typing leaves the page', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings', '/elsewhere');
      await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Peach');
      await userEvent.tab();
      expect(location()).toBe('/listings?q=Peach');
      await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/elsewhere');
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

    it('never rewrites the URL on load; the next change drops a stale authority key', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?status=all&ha=stale&ha=dca');
      expect(location()).toBe('/listings?status=all&ha=stale&ha=dca');
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      expect(location()).toBe('/listings?status=all&voucher=2&ha=dca');
    });

    it('chip and dropdown changes replace history: Back leaves the page', async () => {
      activeState = { status: 'ready', units: UNITS };
      renderAt('/listings', '/elsewhere');
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      await userEvent.selectOptions(statusSelect(), 'all');
      expect(location()).toBe('/listings?status=all&voucher=2');
      await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/elsewhere');
    });
  });

  describe('labels, copy and layout', () => {
    it('the dropdown and the row badge still say Setup; only the summary says Coming soon', () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?status=setup');
      expect(statusSelect().selectedOptions[0]?.textContent).toBe('Setup');
      expect(within(statusSelect()).queryByRole('option', { name: /coming soon/i })).not.toBeInTheDocument();
      const firstRow = screen.getByRole('link', { name: /3 Soon Two Ct/ });
      expect(within(firstRow).getByText('Setup')).toBeInTheDocument();
      expect(within(summaryTable()).getByRole('columnheader', { name: 'Housing authority' })).toBeInTheDocument();
    });

    it('the summary ignores the search box', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt('/listings?q=zzz');
      expect(rows()).toHaveLength(0);
      expect(countsOf('All authorities')).toEqual(['2', '2']);
      expect(countsOf('DCA')).toEqual(['2', '1']);
    });

    it('with nothing to move: an All row of 0/0 without links, and an honest empty state', async () => {
      activeState = {
        status: 'ready',
        units: [{ unitId: 'o9', landlordId: 'l1', status: 'occupied', accepted_authorities: ['DCA'], address: { line1: '9 Taken Way' } }],
      };
      renderAt();
      expect(countsOf('All authorities')).toEqual(['0', '0']);
      expect(within(summaryTable()).queryAllByRole('link')).toHaveLength(0);
      expect(within(summaryTable()).getAllByRole('rowheader')).toHaveLength(1);
      // The user chose nothing: say what is true, not "the selected filters".
      expect(screen.getByText('No available properties right now.')).toBeInTheDocument();
      expect(screen.queryByText(/no properties match the selected filters/i)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Show all statuses' }));
      expect(statusSelect().value).toBe('all');
      expect(rowText()).toEqual([expect.stringContaining('9 Taken Way')]);
      expect(location()).toBe('/listings?status=all');
    });

    it('says how many properties a size filter leaves out for recording no size', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      expect(screen.queryByText(/no voucher size recorded/i)).not.toBeInTheDocument();
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      // s2 (coming soon, no size) is the one unrecorded property left out.
      expect(screen.getByText('1 property has no voucher size recorded and is not counted.')).toBeInTheDocument();
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: 'Not recorded' }));
      expect(screen.queryByText(/no voucher size recorded/i)).not.toBeInTheDocument();
    });

    it('puts the summary above the filter controls', () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      const order = summaryTable().compareDocumentPosition(statusSelect());
      expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the Deleted subtitle', () => {
      deletedState = { status: 'ready', units: [] };
      renderAt('/listings/deleted');
      expect(screen.getByText('Soft-deleted properties. Open one to restore it.')).toBeInTheDocument();
    });

    it('Clear hands keyboard focus to the first chip of its group', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: /clear voucher size filter/i }));
      expect(within(voucherGroup()).getByRole('button', { name: 'Studio' })).toHaveFocus();
    });

    it('Show all statuses keeps keyboard focus on the status filter', async () => {
      activeState = {
        status: 'ready',
        units: [{ unitId: 'o9', landlordId: 'l1', status: 'occupied', address: { line1: '9 Taken Way' } }],
      };
      renderAt();
      await userEvent.click(screen.getByRole('button', { name: 'Show all statuses' }));
      expect(statusSelect()).toHaveFocus();
    });
  });

  // Code review round 2: the page tells its OWN URL writes (stamped with history
  // state) from everyone else's navigations, and adopts all of the latter.
  describe('adopting the URL', () => {
    it('a late commit of the page own write never wipes a newer keystroke', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      const box = screen.getByRole('searchbox', { name: /search/i });
      // Both events land before the chip's URL write commits (it commits in a
      // transition, after the urgent keystroke).
      await act(async () => {
        fireEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
        fireEvent.change(box, { target: { value: 'T' } });
      });
      expect(location()).toBe('/listings?voucher=2');
      expect(box).toHaveValue('T');
    });

    it('a same-URL replace made by someone else IS adopted', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      const box = screen.getByRole('searchbox', { name: /search/i });
      fireEvent.change(box, { target: { value: 'Two' } });
      expect(rows()).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Foreign replace' }));
      expect(box).toHaveValue('');
      expect(rows()).toHaveLength(2);
    });

    it('a count whose target is the current URL (a router REPLACE) still clears the search', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      const box = screen.getByRole('searchbox', { name: /search/i });
      // No blur, so the URL stays bare and the All-row count targets it exactly.
      fireEvent.change(box, { target: { value: 'Two' } });
      fireEvent.click(screen.getByRole('link', { name: 'Show 2 available properties for all authorities' }));
      expect(location()).toBe('/listings');
      expect(box).toHaveValue('');
      expect(rows()).toHaveLength(2);
    });

    it('while the view loads, the current tab link keeps the authority filter', () => {
      activeState = { status: 'loading', units: [] };
      renderAt('/listings?ha=dca');
      const tabs = screen.getByRole('navigation', { name: 'Properties view' });
      expect(within(tabs).getByRole('link', { name: 'Active' })).toHaveAttribute('href', '/listings?ha=dca');
    });

    it('opening a row saves the search even when the box never blurred', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), { target: { value: 'Both' } });
      fireEvent.click(screen.getByRole('link', { name: /2 Avail Both Ave/ }));
      expect(screen.getByText('Property page')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/listings?q=Both');
      expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('Both');
    });

    it("Back onto an entry the page itself wrote is still adopted", async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      renderAt();
      // A chip writes a STAMPED entry; the count then pushes past it.
      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      await userEvent.click(screen.getByRole('link', { name: 'Show 1 coming soon property for DCA' }));
      expect(statusSelect().value).toBe('setup');
      // Back lands on the stamped entry: a POP is always adopted, stamp or not.
      await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/listings?voucher=2');
      expect(statusSelect().value).toBe('available');
      expect(within(haGroup()).queryAllByRole('button', { pressed: true })).toHaveLength(0);
    });

    it('a blur while the view loads keeps the authority filter in the URL', async () => {
      activeState = { status: 'loading', units: [] };
      deletedState = {
        status: 'ready',
        units: [{ unitId: 'd1', landlordId: 'l1', status: 'off_market', address: { line1: '1 Gone St' } }],
      };
      renderAt('/listings/deleted', '/listings?ha=dca');
      const box = screen.getByRole('searchbox', { name: /search/i });
      box.focus();
      // Back to the Active tab, which is still loading, then the box loses focus.
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      expect(location()).toBe('/listings?ha=dca');
      fireEvent.blur(box);
      // Nothing loaded means nothing to prune against: the filter must survive.
      expect(location()).toBe('/listings?ha=dca');
    });
  });

  // Under a REAL browser history (BrowserRouter), a write must never land on an
  // entry that a still-pending PUSH or Back/Forward has already moved to.
  describe('under a browser history', () => {
    afterEach(() => {
      window.history.replaceState(null, '', '/');
    });

    it('records the committed history index INSIDE the commit: a tap right after a navigation is written', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      window.history.replaceState(null, '', '/listings');
      render(
        <BrowserRouter>
          <Routes>
            <Route path="/listings" element={<ListingsList />} />
          </Routes>
        </BrowserRouter>,
      );
      // Tap 2-BR the moment the count's navigation COMMITS - from a mutation
      // observer, which runs right after the commit's DOM writes and before any
      // after-paint (passive) effect. Raw events outside act(), so React's own
      // scheduling decides the order, as in a browser.
      const observer = new MutationObserver(() => {
        if (!window.location.search.includes('ha=dca')) return;
        const chip = within(voucherGroup()).queryByRole('button', { name: '2-BR' });
        if (chip === null) return;
        observer.disconnect();
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      screen
        .getByRole('link', { name: 'Show 1 coming soon property for DCA' })
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await waitFor(() => expect(window.location.search).toContain('voucher=2'));
      observer.disconnect();
    });

    it('leaves the entry of a still-pending navigation untouched (the filter write is skipped)', async () => {
      activeState = { status: 'ready', units: SUMMARY_UNITS };
      window.history.replaceState(null, '', '/listings');
      render(
        <BrowserRouter>
          <Routes>
            <Route path="/listings" element={<ListingsList />} />
            <Route path="/listings/deleted" element={<ListingsList deleted />} />
          </Routes>
        </BrowserRouter>,
      );
      // A navigation the browser has started but the router has not committed:
      // the history entry (and its react-router index) has already moved.
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      window.history.pushState({ usr: null, key: 'pending', idx: idx + 1 }, '', '/listings/deleted');

      await userEvent.click(within(voucherGroup()).getByRole('button', { name: '2-BR' }));
      // The pending entry is untouched: no replace landed on it.
      expect(window.location.pathname + window.location.search).toBe('/listings/deleted');
    });
  });
});
