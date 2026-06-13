// Contacts list tests — type filter + phone search. Mock the api barrel
// (keeping useApi/ApiError/types real, stubbing listContacts); no network.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactsPage } from '../../api/index.js';

const { listContactsMock } = vi.hoisted(() => ({ listContactsMock: vi.fn() }));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return { ...actual, listContacts: listContactsMock };
});

const { default: Contacts } = await import('../Contacts.js');
const { ToastProvider } = await import('../../ui/index.js');

function contact(over: Partial<Contact> = {}): Contact {
  return { contactId: 'k1', type: 'tenant', status: 'active', phone: '+13135551234', ...over };
}

function page(contacts: Contact[]): ContactsPage {
  return { contacts, nextCursor: null };
}

function renderScreen(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/contacts']}>
        <Contacts />
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  listContactsMock.mockReset();
  listContactsMock.mockResolvedValue(page([]));
});

describe('<Contacts>', () => {
  it('defaults to listing tenants', async () => {
    listContactsMock.mockResolvedValue(page([contact({ firstName: 'Keisha', lastName: 'Jones' })]));
    renderScreen();
    expect(await screen.findByText('Keisha Jones')).toBeInTheDocument();
    // The first list call used type=tenant (the default filter).
    expect(listContactsMock.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ type: 'tenant' }),
    );
  });

  it('changes the type filter and refetches', async () => {
    listContactsMock.mockResolvedValue(page([contact({ type: 'landlord', firstName: 'Lou' })]));
    renderScreen();
    await screen.findByText(/Lou/);

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'landlord' } });

    await waitFor(() =>
      expect(listContactsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'landlord' }),
        expect.anything(),
      ),
    );
  });

  it('shows an honest "needs review" chip and the phone (no fabricated name)', async () => {
    listContactsMock.mockResolvedValue(
      page([contact({ contactId: 'ku', type: 'unknown', status: 'needs_review', firstName: undefined })]),
    );
    renderScreen();
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('(313) 555-1234')).toBeInTheDocument();
  });

  it('searches by exact phone (type requirement skipped) and shows results', async () => {
    listContactsMock.mockResolvedValueOnce(page([])); // initial tenant list
    renderScreen();
    await screen.findByText('No contacts yet');

    // The phone-lookup result for the committed search.
    listContactsMock.mockResolvedValueOnce(
      page([contact({ contactId: 'kp', firstName: 'Pat', lastName: 'Doe', phone: '+13135559999' })]),
    );
    fireEvent.change(screen.getByLabelText('Search by phone'), {
      target: { value: '+13135559999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Pat Doe')).toBeInTheDocument();
    // The search call sent ONLY phone (no type) — the exact-lookup path.
    const lastCall = listContactsMock.mock.calls.at(-1)![0];
    expect(lastCall).toEqual(expect.objectContaining({ phone: '+13135559999' }));
    expect(lastCall).not.toHaveProperty('type');
  });

  it('shows the empty state when there are no contacts', async () => {
    listContactsMock.mockResolvedValue(page([]));
    renderScreen();
    expect(await screen.findByText('No contacts yet')).toBeInTheDocument();
  });

  it('renders an error state with a retry', async () => {
    const { ApiError } = await import('../../api/index.js');
    listContactsMock.mockRejectedValueOnce(new ApiError(500, 'boom', 'boom'));
    renderScreen();
    expect(await screen.findByText("Couldn't load contacts")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
