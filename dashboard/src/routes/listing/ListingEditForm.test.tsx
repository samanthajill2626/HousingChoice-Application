import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitItem } from '../../api/index.js';

const updateUnit = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, updateUnit: (...a: unknown[]) => updateUnit(...a) };
});

import { ListingEditForm } from './ListingEditForm.js';

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'll1',
  status: 'available',
  jurisdiction: 'ga_dca',
  beds: 3,
  baths: 1,
  rent_min: 1975,
  utilities: 'Tenant-paid',
  pets: 'Cats only',
  accepted_programs: ['HCV', 'VASH'],
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
};

beforeEach(() => vi.clearAllMocks());

describe('ListingEditForm', () => {
  it('prefills current values', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Utilities/i)).toHaveValue('Tenant-paid');
    expect(screen.getByLabelText(/Housing authority/i)).toHaveValue('ga_dca');
    expect(screen.getByLabelText(/Accepted vouchers/i)).toHaveValue('HCV, VASH');
    expect(screen.getByLabelText(/Street address/i)).toHaveValue('88 Sycamore St');
  });

  it('PATCHes only the changed fields and applies the returned unit', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateUnit.mockResolvedValue({ ...UNIT, utilities: 'Owner-paid' });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={onSaved} />);

    await user.clear(screen.getByLabelText(/Utilities/i));
    await user.type(screen.getByLabelText(/Utilities/i), 'Owner-paid');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Owner-paid' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('sends a changed number as a number, and the programs array', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Rent max/i), { target: { value: '2100' } });
    await user.clear(screen.getByLabelText(/Accepted vouchers/i));
    await user.type(screen.getByLabelText(/Accepted vouchers/i), 'HCV, VASH, Section 8');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      rent_max: 2100,
      accepted_programs: ['HCV', 'VASH', 'Section 8'],
    });
  });

  it('changing the status PATCHes { status }', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT, status: 'placed' });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText(/^Status$/i), 'placed');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { status: 'placed' });
  });

  it('does not call the API when nothing changed — just closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={UNIT} onClose={onClose} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a save failure and stays open', async () => {
    const user = userEvent.setup();
    updateUnit.mockRejectedValue(new Error('boom'));
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/Utilities/i));
    await user.type(screen.getByLabelText(/Utilities/i), 'X');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t save/i));
  });
});
