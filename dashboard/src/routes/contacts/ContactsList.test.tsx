import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import { NONE_KEY } from './tenantFacets.js';
import type { ContactsFilter, ContactsState } from './useContacts.js';
import { formatInboxTimeFull } from '../inbox/inboxTime.js';

// Drive the view through a mocked useContacts so these tests are independent of
// fetching (covered separately) and assert the route → filter behavior, the
// rendered rows/links, the search box, and the loading/error/empty states.
let state: ContactsState = { status: 'loading', contacts: [] };
// Some cases need the mock to be VIEW-AWARE: the hook is mocked, so ContactsList
// does no type filtering of its own and a filter-blind mock would render every
// fixture on the Landlords view, voiding an exact row count. A per-filter entry
// wins; every other view falls back to `state`.
let stateByFilter: Partial<Record<ContactsFilter, ContactsState>> = {};
vi.mock('./useContacts.js', () => ({
  useContacts: (filter: ContactsFilter) => stateByFilter[filter] ?? state,
}));

// ContactCreateForm uses useContactVocabulary (makes a network call on mount).
// Mock it to keep these tests hermetic.
vi.mock('../contact/useContactVocabulary.js', () => ({
  useContactVocabulary: () => ({ roles: [], relationshipRoles: [], fieldLabels: [] }),
}));

import { ContactsList } from './ContactsList.js';

const CONTACTS: Contact[] = [
  { contactId: 'c1', type: 'tenant', firstName: 'Tasha', lastName: 'Williams', phone: '+14040100007', status: 'active' },
  { contactId: 'c2', type: 'landlord', firstName: 'James', lastName: 'Porter', phone: '+14040100008' },
  { contactId: 'c3', type: 'unknown', phone: '+14040100009' },
];

function renderList(filter: 'all' | 'tenant' | 'landlord' | 'unknown' = 'all'): void {
  render(
    <MemoryRouter>
      <ContactsList filter={filter} />
    </MemoryRouter>,
  );
}

// --- Tenant facet fixtures + helpers (spec sections 5/6/10) -----------------

/** A Studio tenant on DCA. */
const T_STUDIO: Contact = {
  contactId: 't0',
  type: 'tenant',
  firstName: 'Tina',
  lastName: 'Zero',
  phone: '+14040100001',
  voucherSize: 0,
  housingAuthority: 'DCA',
};
/** A 6-BR porting tenant on a second authority (facts are EXACT, not bucketed). */
const T_SIX: Contact = {
  contactId: 't6',
  type: 'tenant',
  firstName: 'Tessa',
  lastName: 'Six',
  phone: '+14040100002',
  status: 'searching',
  voucherSize: 6,
  housingAuthority: 'Fulton County',
  porting: true,
};
/** Neither fact recorded (the Not-recorded population). */
const T_NONE: Contact = {
  contactId: 'tn',
  type: 'tenant',
  firstName: 'Nora',
  lastName: 'None',
  phone: '+14040100003',
};
/** An authority but NO voucher size - the `voucherEmpty` population. */
const T_HA_ONLY: Contact = {
  contactId: 'th',
  type: 'tenant',
  firstName: 'Hana',
  lastName: 'Authorityonly',
  phone: '+14040100005',
  housingAuthority: 'DCA',
};
/** NAMED on purpose: a nameless contact falls back to the formatted phone, and
 *  the /Lana Landlord/ query would then throw. */
const LANDLORD: Contact = {
  contactId: 'l1',
  type: 'landlord',
  firstName: 'Lana',
  lastName: 'Landlord',
  phone: '+14040100004',
};
const TENANTS: Contact[] = [T_STUDIO, T_SIX, T_NONE];
/** Nobody is porting, so the Porting GROUP does not render (T_SIX is the only
 *  porting fixture). Voucher sizes are still recorded, isolating the toggle. */
const TENANTS_NO_PORTING: Contact[] = [T_STUDIO, T_NONE];
/** Nobody has a recorded voucher size, so that facet renders its muted line
 *  INSTEAD of all five chips plus Not recorded - and its Clear with them. */
const TENANTS_NO_VOUCHER: Contact[] = [T_HA_ONLY, T_NONE];

/** Status-facet fixtures (spec 2026-10-12 5.7). Sam/Rae are default-visible,
 *  Ida/Pat are hidden by default, Nell has NO status (never hidden, F1). */
const S_SAM: Contact = { contactId: 's1', type: 'tenant', firstName: 'Sam', lastName: 'Searching', phone: '+14040100011', status: 'searching', voucherSize: 2, last_heard_from_at: '2024-03-05T12:00:00.000Z' };
const S_IDA: Contact = { contactId: 's2', type: 'tenant', firstName: 'Ida', lastName: 'Inactive', phone: '+14040100012', status: 'inactive', last_heard_from_at: '2024-04-01T12:00:00.000Z' };
const S_PAT: Contact = { contactId: 's3', type: 'tenant', firstName: 'Pat', lastName: 'Placed', phone: '+14040100013', status: 'placed' };
const S_NELL: Contact = { contactId: 's4', type: 'tenant', firstName: 'Nell', lastName: 'Nostatus', phone: '+14040100014' };
const S_RAE: Contact = { contactId: 's5', type: 'tenant', firstName: 'Rae', lastName: 'Recent', phone: '+14040100015', status: 'onboarding', last_heard_from_at: '2024-06-01T12:00:00.000Z' };
const STATUS_TENANTS: Contact[] = [S_SAM, S_IDA, S_PAT, S_NELL, S_RAE];

/** The rows' display names in render order (the name span is the link's first child). */
function tenantRowNames(): string[] {
  return rowsOf('Tenants')
    .getAllByRole('listitem')
    .map((li: HTMLElement) => li.querySelector('a > span')?.textContent ?? '');
}

// The row separator is U+00B7 with spaces, built ONE way in source AND tests.
const SEP = ' ' + String.fromCharCode(0xB7) + ' ';

/** Reports the live location so a facet WRITE can be asserted. */
function Probe(): React.JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

/** Render at a URL (facet params live there) with the route's `filter` prop. */
function renderAt(url: string, filter: ContactsFilter = 'tenant'): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <ContactsList filter={filter} />
      <Probe />
    </MemoryRouter>,
  );
}

/** The rows list (scoped so the controls can never be counted as rows). */
function rowsOf(heading: string): ReturnType<typeof within> {
  return within(screen.getByRole('list', { name: heading }));
}

beforeEach(() => {
  state = { status: 'loading', contacts: [] };
  stateByFilter = {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContactsList', () => {
  it('shows a spinner while loading', () => {
    state = { status: 'loading', contacts: [] };
    renderList();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an inline error on failure', () => {
    state = { status: 'error', contacts: [] };
    renderList();
    expect(screen.getByText(/couldn.t load|try again/i)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no contacts', () => {
    state = { status: 'ready', contacts: [] };
    renderList('tenant');
    expect(screen.getByText(/no tenants yet/i)).toBeInTheDocument();
  });

  it('uses a heading that reflects the active filter', () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('tenant');
    expect(screen.getByRole('heading', { level: 1, name: 'Tenants' })).toBeInTheDocument();
  });

  it('renders on-page filter tabs linking to each filtered route, marking the active one', () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('tenant');
    const bar = screen.getByRole('navigation', { name: /filter contacts/i });
    expect(within(bar).getByRole('link', { name: 'All' })).toHaveAttribute('href', '/contacts');
    expect(within(bar).getByRole('link', { name: 'Tenants' })).toHaveAttribute('href', '/contacts/tenants');
    expect(within(bar).getByRole('link', { name: 'Landlords' })).toHaveAttribute('href', '/contacts/landlords');
    expect(within(bar).getByRole('link', { name: 'Unknown' })).toHaveAttribute('href', '/contacts/unknown');
    // The active tab reflects the current filter (and only it).
    expect(within(bar).getByRole('link', { name: 'Tenants' })).toHaveAttribute('aria-current', 'page');
    expect(within(bar).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
    // Caseworkers (spec 2026-10-06 D18): its own page, in the nav's order.
    expect(within(bar).getByRole('link', { name: 'Caseworkers' })).toHaveAttribute('href', '/contacts/caseworkers');
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'All',
      'Tenants',
      'Landlords',
      'Caseworkers',
      'Unknown',
      'Deleted',
    ]);
  });

  it('renders a row per contact with name, phone, type, and a detail link', () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    const tasha = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(tasha).toHaveAttribute('href', '/contacts/c1');
    expect(within(tasha).getByText(/\(404\) 010-0007/)).toBeInTheDocument();
    expect(within(tasha).getByText(/tenant/i)).toBeInTheDocument();
  });

  it('renders a PARTNER row on the All tab with its kind label, surviving the search filter', async () => {
    // The widened fan-out (TYPES_FOR.all += partner, 2026-08-18) is only worth
    // anything if the All tab actually SHOWS the row - this is the surface a
    // human reads. See docs/issues/partner-widening-consumer-test-gap.md.
    state = {
      status: 'ready',
      contacts: [
        ...CONTACTS,
        { contactId: 'c-partner', type: 'partner', firstName: 'Renata', lastName: 'Cole', phone: '+14040100010' },
      ],
    };
    renderList('all');
    const partner = screen.getByRole('link', { name: /Renata Cole/ });
    expect(partner).toHaveAttribute('href', '/contacts/c-partner');
    expect(within(partner).getByText(/partner/i)).toBeInTheDocument();

    // And the client-side search does not drop the type.
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'renata');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText(/Renata Cole/)).toBeInTheDocument();
  });

  it('falls back to the formatted phone when a contact has no name', () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    const unknown = screen.getByRole('link', { name: /\(404\) 010-0009/ });
    expect(unknown).toHaveAttribute('href', '/contacts/c3');
  });

  it('filters the rows client-side via the search box (by name or phone)', async () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    const search = screen.getByRole('searchbox', { name: /search/i });
    await userEvent.type(search, 'porter');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText(/James Porter/)).toBeInTheDocument();
  });

  it('shows a no-matches state when the search excludes every row', async () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzzzz');
    expect(screen.getByText(/no matches|nothing/i)).toBeInTheDocument();
  });

  it('seeds the search box from a ?phone= deep-link and filters to that row (Inbox/Today unknown links)', () => {
    state = { status: 'ready', contacts: CONTACTS };
    render(
      <MemoryRouter initialEntries={['/contacts/unknown?phone=%2B14040100009']}>
        <ContactsList filter="unknown" />
      </MemoryRouter>,
    );
    // The deep-linked phone prefills the search box...
    expect(screen.getByRole('searchbox', { name: /search/i })).toHaveValue('+14040100009');
    // ...and the list is filtered to the matching contact (a nameless unknown
    // renders the phone as BOTH the name fallback and the phone chip).
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getAllByText(/\(404\) 010-0009/).length).toBeGreaterThan(0);
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', '/contacts/c3');
  });

  it('renders a "New contact" button in the list header', () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    expect(screen.getByRole('button', { name: 'New contact' })).toBeInTheDocument();
  });

  it('clicking "New contact" opens the create dialog', async () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    await userEvent.click(screen.getByRole('button', { name: 'New contact' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The dialog title heading should read "New contact"
    expect(screen.getByRole('heading', { name: 'New contact' })).toBeInTheDocument();
  });
});

describe('ContactsList - tenant facets, row facts, and URL state', () => {
  it('renders the three facet groups on the Tenants view', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants');
    expect(screen.getByRole('group', { name: 'Voucher size' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Housing authority' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Porting' })).toBeInTheDocument();
  });

  it('renders the value facets even with zero tenants loaded (ready is the ONLY gate)', () => {
    state = { status: 'ready', contacts: [] };
    renderAt('/contacts/tenants');
    // A promised control must not silently vanish - it explains itself instead.
    expect(screen.getByText('No voucher sizes recorded yet')).toBeInTheDocument();
    expect(screen.getByText('No housing authorities recorded yet')).toBeInTheDocument();
  });

  it('hides the controls until the fetch is ready', () => {
    state = { status: 'loading', contacts: [] };
    renderAt('/contacts/tenants');
    expect(screen.queryByRole('group', { name: 'Voucher size' })).toBeNull();
  });

  it('a voucher chip narrows the list and the URL carries the bucket key', async () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants');
    await userEvent.click(screen.getByRole('button', { name: /Studio \(1\)/ }));
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(1);
    expect(rowsOf('Tenants').getByRole('link', { name: /Tina Zero/ })).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toContain('voucher=0');
  });

  it('the Porting toggle writes porting=1 and keeps only porting tenants', async () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants');
    await userEvent.click(screen.getByRole('button', { name: /^Porting/ }));
    expect(screen.getByTestId('loc').textContent).toContain('porting=1');
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(1);
    expect(rowsOf('Tenants').getByRole('link', { name: /Tessa Six/ })).toBeInTheDocument();
  });

  it('a facet write MERGES the query string (?phone= survives)', async () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?phone=%2B14040100001');
    await userEvent.click(screen.getByRole('button', { name: /Studio \(1\)/ }));
    const search = screen.getByTestId('loc').textContent ?? '';
    expect(search).toContain('phone=');
    expect(search).toContain('voucher=0');
  });

  it('round-trips ?voucher=0 and ?voucher=4plus into pressed chips', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?voucher=0&voucher=4plus');
    expect(screen.getByRole('button', { name: /Studio/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /4\+ BR/ })).toHaveAttribute('aria-pressed', 'true');
    // OR within a facet: the Studio tenant AND the 6-BR one.
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(2);
  });

  it('a non-normalized ?ha= value drops individually while the rest still filter', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?ha=DCA&ha=dca');
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(1);
    expect(rowsOf('Tenants').getByRole('link', { name: /Tina Zero/ })).toBeInTheDocument();
  });

  it('a stale ?ha= link never empties the list, and does not rewrite the URL', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?ha=ghost');
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(3);
    // The ghost is pruned from the SELECTION, so the OTHER facet's counts stay
    // truthful (a ghost left in place would zero every one of them).
    expect(screen.getByRole('button', { name: 'Studio (1)' })).toBeInTheDocument();
    expect(screen.getByTestId('loc').textContent).toBe('?ha=ghost');
  });

  it('a ?porting=1 selection nobody can SEE or CLEAR does not filter the list', () => {
    // Reachable in one session: filter by Porting while one tenant is porting,
    // resolve that port, come Back. The group now hides (a toggle with nothing
    // to match is dead UI), so the selection is invisible, no Clear exists, and
    // every other chip click re-serializes porting=1. It must not filter.
    state = { status: 'ready', contacts: TENANTS_NO_PORTING };
    renderAt('/contacts/tenants?porting=1');
    expect(screen.queryByRole('group', { name: 'Porting' })).toBeNull();
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(2);
    // Pruned from the SELECTION only - the URL is never rewritten on mount.
    expect(screen.getByTestId('loc').textContent).toBe('?porting=1');
  });

  it('a ?voucher= selection nobody can SEE or CLEAR does not filter the list', () => {
    // Same lock on the value facet: the muted line REPLACES the chips and the
    // Clear button, so a selected bucket is unreachable.
    state = { status: 'ready', contacts: TENANTS_NO_VOUCHER };
    renderAt('/contacts/tenants?voucher=2');
    expect(screen.getByText('No voucher sizes recorded yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Clear voucher size/i })).toBeNull();
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('loc').textContent).toBe('?voucher=2');
  });

  it('keeps the Not-recorded authority sentinel through pruning', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?ha=' + NONE_KEY);
    expect(rowsOf('Tenants').getAllByRole('listitem')).toHaveLength(1);
    expect(rowsOf('Tenants').getByRole('link', { name: /Nora None/ })).toBeInTheDocument();
  });

  it('all and landlord views render no controls, and facet params are inert', () => {
    stateByFilter = { landlord: { status: 'ready', contacts: [LANDLORD] } };
    renderAt('/contacts/landlords?voucher=0', 'landlord');
    expect(screen.queryByRole('group', { name: 'Voucher size' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Studio/ })).toBeNull();
    // EXACT: the one landlord fixture. A >0 assertion would pass even if the
    // param wrongly filtered - which is the failure case itself.
    expect(rowsOf('Landlords').getAllByRole('listitem')).toHaveLength(1);
  });

  it('tenant rows carry the facts line + Porting chip after the existing chips', () => {
    state = { status: 'ready', contacts: [...TENANTS, LANDLORD] };
    renderAt('/contacts', 'all');
    const rows = rowsOf('Contacts');
    const row6 = rows.getByRole('link', { name: /6 BR/ });
    // EXACT facts, never the bucket label: `6 BR`, not `4+ BR`.
    expect(row6.textContent).toContain('6 BR' + SEP + 'Fulton County');
    expect(row6.textContent).not.toContain('4+ BR');
    // Kind, phone and status are untouched, and the facts follow them.
    expect(within(row6).getByText(/tenant/i)).toBeInTheDocument();
    expect(within(row6).getByText(/\(404\) 010-0002/)).toBeInTheDocument();
    expect(within(row6).getByText('Searching')).toBeInTheDocument();
    const text = row6.textContent ?? '';
    expect(text.indexOf('(404) 010-0002')).toBeLessThan(text.indexOf('6 BR'));
    expect(within(row6).getByTitle('Tenant is porting')).toBeInTheDocument();
    // Only-size collapses to the size alone; a landlord row gets no facts.
    expect(rows.getByRole('link', { name: /Nora None/ }).textContent).not.toContain('BR');
    expect(rows.getByRole('link', { name: /Lana Landlord/ }).textContent).not.toContain('BR');
  });

  it('renders NO facts on the Deleted view, tenant rows included', () => {
    stateByFilter = { deleted: { status: 'ready', contacts: TENANTS } };
    renderAt('/contacts/deleted', 'deleted');
    const rows = rowsOf('Deleted');
    expect(rows.getAllByRole('listitem')).toHaveLength(3);
    expect(rows.getByRole('link', { name: /Tessa Six/ }).textContent).not.toContain('BR');
    expect(rows.queryByTitle('Tenant is porting')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Voucher size' })).toBeNull();
  });

  it('the active Tenants tab preserves the facet params; other tabs stay bare', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?voucher=0');
    const bar = within(screen.getByRole('navigation', { name: 'Filter contacts' }));
    // Exact string equality via getAttribute - a substring match would pass on a
    // wrong pathname.
    expect(bar.getByRole('link', { name: 'Tenants' }).getAttribute('href')).toBe(
      '/contacts/tenants?voucher=0',
    );
    expect(bar.getByRole('link', { name: 'Landlords' }).getAttribute('href')).toBe(
      '/contacts/landlords',
    );
    expect(bar.getByRole('link', { name: 'All' }).getAttribute('href')).toBe('/contacts');
  });

  it('leaves the Tenants tab bare from another view (leaving Tenants drops facets)', () => {
    stateByFilter = { landlord: { status: 'ready', contacts: [LANDLORD] } };
    renderAt('/contacts/landlords?voucher=0', 'landlord');
    const bar = within(screen.getByRole('navigation', { name: 'Filter contacts' }));
    expect(bar.getByRole('link', { name: 'Tenants' }).getAttribute('href')).toBe(
      '/contacts/tenants',
    );
  });

  it('shows the filter-miss message when facets exclude every row', () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?voucher=3'); // no tenant is a 3-BR
    expect(screen.getByText('No tenants match the selected filters.')).toBeInTheDocument();
    expect(screen.queryByText(/No matches for/)).toBeNull();
  });

  it('lets the query message win the noMatches precedence when both are active', async () => {
    state = { status: 'ready', contacts: TENANTS };
    renderAt('/contacts/tenants?voucher=0');
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzzzz');
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
    expect(screen.queryByText('No tenants match the selected filters.')).toBeNull();
  });
});

describe('ContactsList - status facet (spec 2026-10-12 5.7)', () => {
  it('the default hides inactive and placed tenants; a tenant with no status stays', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    expect(tenantRowNames().sort()).toEqual(['Nell Nostatus', 'Rae Recent', 'Sam Searching']);
    const group = screen.getByRole('group', { name: 'Status' });
    expect(within(group).getByRole('button', { name: 'Inactive (1)' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: 'Placed (1)' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Clear status filter' })).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('');
  });

  it('a chip brings a hidden status back and writes the non-default set; Clear returns to the default', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    await userEvent.click(screen.getByRole('button', { name: 'Inactive (1)' }));
    expect(tenantRowNames()).toContain('Ida Inactive');
    expect(tenantRowNames()).not.toContain('Pat Placed');
    const search = screen.getByTestId('loc').textContent ?? '';
    expect(search).toContain('status=inactive');
    expect(search).toContain('status=needs_review');
    expect(search).not.toContain('status=placed');
    await userEvent.click(screen.getByRole('button', { name: 'Clear status filter' }));
    expect(tenantRowNames()).not.toContain('Ida Inactive');
    expect(screen.getByTestId('loc').textContent).not.toContain('status=');
  });

  it('?status=_empty lights no chip, keeps only the status-less tenant, and offers Clear', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?status=_empty');
    expect(tenantRowNames()).toEqual(['Nell Nostatus']);
    const group = screen.getByRole('group', { name: 'Status' });
    for (const b of within(group).getAllByRole('button', { name: /\(\d+\)$/ })) {
      expect(b).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getByRole('button', { name: 'Clear status filter' })).toBeInTheDocument();
  });

  it('status values beat the _empty sentinel', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?status=_empty&status=inactive');
    expect(tenantRowNames().sort()).toEqual(['Ida Inactive', 'Nell Nostatus']);
  });

  it('an invalid-only ?status= reads as the default and the URL is not rewritten on mount', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?status=bogus');
    expect(tenantRowNames().sort()).toEqual(['Nell Nostatus', 'Rae Recent', 'Sam Searching']);
    expect(screen.getByTestId('loc').textContent).toBe('?status=bogus');
  });

  it('a query that matches only a status-hidden tenant offers "Show all statuses", which lights all seven', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'ida');
    expect(screen.getByText(/No matches for .ida. among the statuses shown/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all statuses' }));
    expect(tenantRowNames()).toEqual(['Ida Inactive']);
    for (const b of within(screen.getByRole('group', { name: 'Status' })).getAllByRole('button', { name: /\(\d+\)$/ })) {
      expect(b).toHaveAttribute('aria-pressed', 'true');
    }
    const search = screen.getByTestId('loc').textContent ?? '';
    expect(search).toContain('status=placed');
    expect(search).toContain('status=inactive');
  });

  it('no hint when nothing hidden by status matches, or when another facet hides the match', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?voucher=3');
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'sam');
    // Sam (2-BR, searching) is hidden by the VOUCHER facet, not by status.
    expect(screen.getByText(/No matches for .sam.\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all statuses' })).toBeNull();
  });
});

describe('ContactsList - sort and the last-heard line (spec 2026-10-12 5.7)', () => {
  it('defaults to last heard from: most recent first, never-heard last', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants');
    expect(tenantRowNames()).toEqual(['Rae Recent', 'Sam Searching', 'Nell Nostatus']);
    expect(screen.getByLabelText('Sort by')).toHaveValue('heard');
  });

  it('?sort=name orders by last name and round-trips through the select, merging the query string', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?sort=name');
    expect(tenantRowNames()).toEqual(['Nell Nostatus', 'Rae Recent', 'Sam Searching']);
    expect(screen.getByLabelText('Sort by')).toHaveValue('name');
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'heard');
    expect(screen.getByTestId('loc').textContent).not.toContain('sort=');
    expect(tenantRowNames()).toEqual(['Rae Recent', 'Sam Searching', 'Nell Nostatus']);
  });

  it('a sort write keeps the facet params, and a facet write keeps the sort', async () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts/tenants?voucher=2');
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'name');
    const afterSort = screen.getByTestId('loc').textContent ?? '';
    expect(afterSort).toContain('voucher=2');
    expect(afterSort).toContain('sort=name');
    // Deselect the (pressed, so always clickable) 2-BR chip: the facet write keeps the sort.
    await userEvent.click(screen.getByRole('button', { name: /^2-BR \(/ }));
    const afterFacet = screen.getByTestId('loc').textContent ?? '';
    expect(afterFacet).not.toContain('voucher=');
    expect(afterFacet).toContain('sort=name');
  });

  it('Tenants rows end with "Last heard from <label>" (title = the full stamp), after the Porting chip', () => {
    state = { status: 'ready', contacts: [...STATUS_TENANTS, T_SIX] };
    renderAt('/contacts/tenants');
    const sam = rowsOf('Tenants').getByRole('link', { name: /Sam Searching/ });
    const line = within(sam).getByText('Last heard from Mar 5, 2024');
    expect(line).toHaveAttribute('title', formatInboxTimeFull(S_SAM.last_heard_from_at as string));
    const nell = rowsOf('Tenants').getByRole('link', { name: /Nell Nostatus/ });
    expect(within(nell).getByText('Last heard from Never')).not.toHaveAttribute('title');
    const six = rowsOf('Tenants').getByRole('link', { name: /Tessa Six/ });
    const text = six.textContent ?? '';
    expect(text.indexOf('Porting')).toBeLessThan(text.indexOf('Last heard from'));
  });

  it('other views: no sort control, no last-heard line, no status facet, list order untouched', () => {
    state = { status: 'ready', contacts: STATUS_TENANTS };
    renderAt('/contacts', 'all');
    expect(screen.queryByLabelText('Sort by')).toBeNull();
    expect(screen.queryByText(/Last heard from/)).toBeNull();
    expect(rowsOf('Contacts').getAllByRole('listitem')).toHaveLength(5);
  });

  it('no sort control until the fetch is ready', () => {
    state = { status: 'loading', contacts: [] };
    renderAt('/contacts/tenants');
    expect(screen.queryByLabelText('Sort by')).toBeNull();
  });
});
