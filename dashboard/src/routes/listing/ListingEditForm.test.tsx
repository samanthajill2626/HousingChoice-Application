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
  utilities: 'Electric and gas',
  pets: 'Cats only',
  accepted_programs: ['HCV', 'VASH'],
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
};

beforeEach(() => vi.clearAllMocks());

describe('ListingEditForm', () => {
  it('prefills current values', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // The utilities label carries the tenant-paid semantics.
    expect(screen.getByLabelText('Tenant-paid utilities')).toHaveValue('Electric and gas');
    expect(screen.getByLabelText(/Housing authority/i)).toHaveValue('ga_dca');
    expect(screen.getByLabelText(/Accepted vouchers/i)).toHaveValue('HCV, VASH');
    expect(screen.getByLabelText(/Street address/i)).toHaveValue('88 Sycamore St');
  });

  it('PATCHes only the changed fields and applies the returned unit', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateUnit.mockResolvedValue({ ...UNIT, utilities: 'Gas only' });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={onSaved} />);

    await user.clear(screen.getByLabelText(/Tenant-paid utilities/i));
    await user.type(screen.getByLabelText(/Tenant-paid utilities/i), 'Gas only');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Gas only' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('prefills property notes and PATCHes them when changed', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const withNotes: UnitItem = { ...UNIT, notes: 'In-unit washer/dryer' };
    render(<ListingEditForm unit={withNotes} onClose={vi.fn()} onSaved={vi.fn()} />);

    const notes = screen.getByLabelText('Notes');
    expect(notes).toHaveValue('In-unit washer/dryer');
    await user.type(notes, '; no dishwasher');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      notes: 'In-unit washer/dryer; no dishwasher',
    });
  });

  it('prefills lease terms and PATCHes them when changed (moved off the landlord contact)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const withTerms: UnitItem = { ...UNIT, lease_terms: '12-month minimum' };
    render(<ListingEditForm unit={withTerms} onClose={vi.fn()} onSaved={vi.fn()} />);

    const terms = screen.getByLabelText('Lease terms');
    expect(terms).toHaveValue('12-month minimum');
    await user.type(terms, ', month-to-month after');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      lease_terms: '12-month minimum, month-to-month after',
    });
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

  it('does not call the API when nothing changed — just closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={UNIT} onClose={onClose} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the new public-flyer inputs', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Video URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Application fee/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Same-day RTA/i)).toBeInTheDocument();
  });

  it('prefills the new fields and includes them (typed) in the PATCH when changed', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const withDetails: UnitItem = {
      ...UNIT,
      video_url: 'https://v.example/old',
      application_fee: 25,
      same_day_rta: false,
    };
    render(<ListingEditForm unit={withDetails} onClose={vi.fn()} onSaved={vi.fn()} />);

    // Prefilled from the unit.
    expect(screen.getByLabelText(/Video URL/i)).toHaveValue('https://v.example/old');
    expect(screen.getByLabelText(/Application fee/i)).toHaveValue(25);
    expect(screen.getByLabelText(/Same-day RTA/i)).not.toBeChecked();

    await user.clear(screen.getByLabelText(/Video URL/i));
    await user.type(screen.getByLabelText(/Video URL/i), 'https://v.example/new');
    fireEvent.change(screen.getByLabelText(/Application fee/i), { target: { value: '40' } });
    await user.click(screen.getByLabelText(/Same-day RTA/i));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      video_url: 'https://v.example/new',
      application_fee: 40,
      same_day_rta: true,
    });
  });

  it('renders the "Voucher size accepted" input, prefills it, and PATCHes it (as a number) when changed', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const withVoucher: UnitItem = { ...UNIT, voucher_size_accepted: 2 };
    render(<ListingEditForm unit={withVoucher} onClose={vi.fn()} onSaved={vi.fn()} />);

    const input = screen.getByLabelText('Voucher size accepted');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(2);

    fireEvent.change(input, { target: { value: '3' } });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { voucher_size_accepted: 3 });
  });

  it('surfaces a save failure and stays open', async () => {
    const user = userEvent.setup();
    updateUnit.mockRejectedValue(new Error('boom'));
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/Tenant-paid utilities/i));
    await user.type(screen.getByLabelText(/Tenant-paid utilities/i), 'X');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t save/i));
  });
});
