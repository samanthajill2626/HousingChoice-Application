// ContactNew tests — create success + the 409 contact_exists path. Mock the
// api barrel (stub createContact); no network.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';

const { createContactMock } = vi.hoisted(() => ({ createContactMock: vi.fn() }));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return { ...actual, createContact: createContactMock };
});

const { default: ContactNew } = await import('../ContactNew.js');
const { ToastProvider } = await import('../../ui/index.js');

function renderScreen(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/contacts/new']}>
        <Routes>
          <Route path="/contacts/new" element={<ContactNew />} />
          <Route path="/contacts/:contactId" element={<div>Detail for contact</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  createContactMock.mockReset();
});

describe('<ContactNew>', () => {
  it('POSTs a tenant with name + voucher and navigates to the new contact', async () => {
    createContactMock.mockResolvedValue({ contactId: 'k-new', type: 'tenant' } as Contact);
    renderScreen();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Keisha' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Jones' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+13135551234' } });
    fireEvent.change(screen.getByLabelText('Voucher size'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /create contact/i }));

    await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(1));
    expect(createContactMock).toHaveBeenCalledWith({
      type: 'tenant',
      firstName: 'Keisha',
      lastName: 'Jones',
      phone: '+13135551234',
      voucherSize: 2,
    });
    // Navigated to the detail route.
    expect(await screen.findByText('Detail for contact')).toBeInTheDocument();
  });

  it('rejects an out-of-range voucher inline without POSTing', async () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText('Voucher size'), { target: { value: '13' } });
    fireEvent.click(screen.getByRole('button', { name: /create contact/i }));

    expect(await screen.findByText(/0 to 12/i)).toBeInTheDocument();
    expect(createContactMock).not.toHaveBeenCalled();
  });

  it('handles 409 contact_exists by linking to the existing contact', async () => {
    const { ApiError } = await import('../../api/index.js');
    const existing: Contact = { contactId: 'k-existing', type: 'tenant', firstName: 'Sam', lastName: 'Lee' };
    createContactMock.mockRejectedValueOnce(
      new ApiError(409, 'contact_exists', 'contact_exists', { error: 'contact_exists', contact: existing }),
    );
    renderScreen();

    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+13135551234' } });
    fireEvent.click(screen.getByRole('button', { name: /create contact/i }));

    // The friendly duplicate notice with a link to the existing contact.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already exists/i);
    expect(alert).toHaveTextContent('Sam Lee');
    const link = screen.getByRole('link', { name: /open the existing contact/i });
    expect(link).toHaveAttribute('href', '/contacts/k-existing');
  });
});
