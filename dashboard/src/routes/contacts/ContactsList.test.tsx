import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import type { ContactsState } from './useContacts.js';

// Drive the view through a mocked useContacts so these tests are independent of
// fetching (covered separately) and assert the route → filter behavior, the
// rendered rows/links, the search box, and the loading/error/empty states.
let state: ContactsState = { status: 'loading', contacts: [] };
vi.mock('./useContacts.js', () => ({ useContacts: () => state }));

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

beforeEach(() => {
  state = { status: 'loading', contacts: [] };
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
  });

  it('renders a row per contact with name, phone, type, and a detail link', () => {
    state = { status: 'ready', contacts: CONTACTS };
    renderList('all');
    const tasha = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(tasha).toHaveAttribute('href', '/contacts/c1');
    expect(within(tasha).getByText(/\(404\) 010-0007/)).toBeInTheDocument();
    expect(within(tasha).getByText(/tenant/i)).toBeInTheDocument();
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
