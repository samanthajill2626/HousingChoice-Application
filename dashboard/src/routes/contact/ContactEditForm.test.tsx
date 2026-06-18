import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Contact } from '../../api/index.js';

const updateContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, updateContact: (...a: unknown[]) => updateContact(...a) };
});

import { ContactEditForm } from './ContactEditForm.js';

const TENANT: Contact = {
  contactId: 'k1',
  type: 'tenant',
  status: 'active',
  firstName: 'Tasha',
  lastName: 'Williams',
  voucherSize: 2,
  phone: '+14040100007',
};

const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  status: 'active',
  firstName: 'James',
  lastName: 'Porter',
  company: 'Porter Holdings',
  phone: '+14042220190',
};

beforeEach(() => vi.clearAllMocks());

describe('ContactEditForm', () => {
  it('shows tenant fields (voucher) and hides company for a tenant', () => {
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Voucher size/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Company/i)).toBeNull();
  });

  it('shows company and hides voucher for a landlord', () => {
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Company/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Voucher size/i)).toBeNull();
    // Tenant-only fields don't show for a landlord.
    expect(screen.queryByLabelText(/Housing authority/i)).toBeNull();
    expect(screen.queryByLabelText(/Street address/i)).toBeNull();
  });

  it('shows housing authority + structured address fields for a tenant', () => {
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Housing authority/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Street address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^City$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^State$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^ZIP$/i)).toBeInTheDocument();
  });

  it('PATCHes a changed housingAuthority (camelCase — the GSI key)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'dekalb_housing' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/Housing authority/i), 'dekalb_housing');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'dekalb_housing' });
  });

  it('PATCHes a structured address when any part changes', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/Street address/i), '123 Main St');
    await user.type(screen.getByLabelText(/^City$/i), 'Atlanta');
    await user.type(screen.getByLabelText(/^State$/i), 'GA');
    await user.type(screen.getByLabelText(/^ZIP$/i), '30301');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // The whole object is sent (server keeps the non-empty parts); line2 stays empty.
    expect(updateContact).toHaveBeenCalledWith('k1', {
      address: { line1: '123 Main St', line2: '', city: 'Atlanta', state: 'GA', zip: '30301' },
    });
  });

  it('PATCHes ONLY the changed field and applies the returned contact', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const updated = { ...TENANT, firstName: 'Natasha' };
    updateContact.mockResolvedValue(updated);
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={onSaved} />);

    const first = screen.getByLabelText(/First name/i);
    await user.clear(first);
    await user.type(first, 'Natasha');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    // Dirty-tracked: only firstName is sent (not the untouched fields).
    expect(updateContact).toHaveBeenCalledWith('k1', { firstName: 'Natasha' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  });

  it('does not call the API when nothing changed — just closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContactEditForm contact={TENANT} onClose={onClose} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('PATCHes a changed voucher size as an integer', async () => {
    const user = userEvent.setup();
    const updated = { ...TENANT, voucherSize: 3 };
    updateContact.mockResolvedValue(updated);
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // fireEvent.change sets the number input deterministically (userEvent.type on a
    // <input type=number> is flaky under jsdom). Out-of-range values are blocked by
    // the input's native min/max constraints before submit; the JS check is a
    // defensive backstop. Here we exercise a valid edit.
    fireEvent.change(screen.getByLabelText(/Voucher size/i), { target: { value: '3' } });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { voucherSize: 3 });
  });

  it('surfaces a save failure and stays open', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(new Error('boom'));
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t save/i));
  });
});
