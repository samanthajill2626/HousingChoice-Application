// UnitForm tests — create submit (with the required landlord + number
// validation) and edit submit (seeds from the loaded unit, PATCHes). Mock the
// api barrel; no network.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactsPage, UnitItem } from '../../api/index.js';

const { createUnitMock, updateUnitMock, getUnitMock, listContactsMock } = vi.hoisted(() => ({
  createUnitMock: vi.fn(),
  updateUnitMock: vi.fn(),
  getUnitMock: vi.fn(),
  listContactsMock: vi.fn(),
}));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return {
    ...actual,
    createUnit: createUnitMock,
    updateUnit: updateUnitMock,
    getUnit: getUnitMock,
    listContacts: listContactsMock,
  };
});

const { default: UnitForm } = await import('../UnitForm.js');
const { ToastProvider } = await import('../../ui/index.js');

function landlord(over: Partial<Contact> = {}): Contact {
  return { contactId: 'k-land', type: 'landlord', firstName: 'Lou', lastName: 'Land', ...over };
}
function contactsPage(contacts: Contact[]): ContactsPage {
  return { contacts, nextCursor: null };
}

function renderAt(path: string): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/units/new" element={<UnitForm />} />
          <Route path="/units/:unitId/edit" element={<UnitForm />} />
          <Route path="/units/:unitId" element={<div>Unit detail page</div>} />
          <Route path="/units" element={<div>Units list</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  createUnitMock.mockReset();
  updateUnitMock.mockReset();
  getUnitMock.mockReset();
  listContactsMock.mockReset();
  // Landlord picker gets a landlord; pm picker empty.
  listContactsMock.mockImplementation((params: { type?: string }) =>
    Promise.resolve(contactsPage(params.type === 'landlord' ? [landlord()] : [])),
  );
});

describe('<UnitForm> create', () => {
  it('requires a landlord before POSTing', async () => {
    renderAt('/units/new');
    await screen.findByText('New property');
    fireEvent.click(screen.getByRole('button', { name: /create property/i }));
    expect(await screen.findByText(/pick the landlord/i)).toBeInTheDocument();
    expect(createUnitMock).not.toHaveBeenCalled();
  });

  it('POSTs the parsed body and navigates to the new unit', async () => {
    createUnitMock.mockResolvedValue({ unitId: 'u-new', landlordId: 'k-land', status: 'available' } as UnitItem);
    renderAt('/units/new');
    // Wait for the landlord option to load into the Landlord picker (the same
    // landlord also appears in the primary-contact picker, so scope by select).
    const landlordSelect = screen.getByLabelText(/Landlord/);
    await waitFor(() =>
      expect(within(landlordSelect).getByRole('option', { name: /Lou Land/ })).toBeInTheDocument(),
    );

    fireEvent.change(landlordSelect, { target: { value: 'k-land' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '5 Oak Ave' } });
    fireEvent.change(screen.getByLabelText('Beds'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Min rent'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Max rent'), { target: { value: '1400' } });
    fireEvent.change(screen.getByLabelText('Accepted programs'), { target: { value: 'HCV, VASH' } });
    fireEvent.click(screen.getByRole('button', { name: /create property/i }));

    await waitFor(() => expect(createUnitMock).toHaveBeenCalledTimes(1));
    const body = createUnitMock.mock.calls[0]![0];
    expect(body).toMatchObject({
      landlordId: 'k-land',
      status: 'available',
      address: '5 Oak Ave',
      beds: 3,
      rent_min: 1000,
      rent_max: 1400,
      accepted_programs: ['HCV', 'VASH'],
    });
    expect(await screen.findByText('Unit detail page')).toBeInTheDocument();
  });

  it('rejects min rent greater than max rent', async () => {
    renderAt('/units/new');
    const landlordSelect = screen.getByLabelText(/Landlord/);
    await waitFor(() =>
      expect(within(landlordSelect).getByRole('option', { name: /Lou Land/ })).toBeInTheDocument(),
    );

    fireEvent.change(landlordSelect, { target: { value: 'k-land' } });
    fireEvent.change(screen.getByLabelText('Min rent'), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText('Max rent'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /create property/i }));

    expect(await screen.findByText(/at least the min rent/i)).toBeInTheDocument();
    expect(createUnitMock).not.toHaveBeenCalled();
  });
});

describe('<UnitForm> edit', () => {
  it('seeds from the loaded unit and PATCHes changed fields', async () => {
    getUnitMock.mockResolvedValue({
      unitId: 'u1',
      landlordId: 'k-land',
      status: 'available',
      address: '1 Old Rd',
      beds: 2,
    } as UnitItem);
    updateUnitMock.mockResolvedValue({ unitId: 'u1', landlordId: 'k-land', status: 'placed' } as UnitItem);

    renderAt('/units/u1/edit');
    // Form seeds the existing address.
    const address = (await screen.findByLabelText('Address')) as HTMLInputElement;
    expect(address.value).toBe('1 Old Rd');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'placed' } });
    fireEvent.click(screen.getByRole('button', { name: /save property/i }));

    await waitFor(() => expect(updateUnitMock).toHaveBeenCalledTimes(1));
    const [unitId, patch] = updateUnitMock.mock.calls[0]!;
    expect(unitId).toBe('u1');
    expect(patch).toMatchObject({ status: 'placed', landlordId: 'k-land', address: '1 Old Rd' });
    expect(await screen.findByText('Unit detail page')).toBeInTheDocument();
  });
});
