import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type OrgEntry, type UnitItem } from '../../api/index.js';

const updateUnit = vi.fn();
// The authorities picker's list and "Is this really new?" (spec 2026-10-06 D6).
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    updateUnit: (...a: unknown[]) => updateUnit(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

import { ListingEditForm } from './ListingEditForm.js';

function orgEntry(name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind: 'housing_authority',
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}

const ORG_ENTRIES: OrgEntry[] = [
  orgEntry('Atlanta Housing Authority', ['AHA']),
  orgEntry('Georgia Department of Community Affairs', ['DCA']),
];

// A LEGACY unit: it carries only the retired `jurisdiction` string and no
// `accepted_authorities`, so every authority assertion below exercises the
// read-time synthesis (spec section 8) rather than a pre-migrated fixture.
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
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getOrgList.mockResolvedValue({ version: 1, entries: ORG_ENTRIES });
  checkOrgText.mockResolvedValue({ candidates: [], close: [] });
});

describe('ListingEditForm', () => {
  it('prefills current values', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // The utilities label carries the tenant-paid semantics.
    expect(screen.getByLabelText('Tenant-paid utilities')).toHaveValue('Electric and gas');
    // The authorities picker, prefilled from the SYNTHESIZED list - a legacy
    // jurisdiction-only unit shows its stored authority as a chip (spec
    // section 8; spec 2026-10-06 D6).
    expect(screen.getByRole('combobox', { name: 'Housing authorities' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove ga_dca' })).toBeInTheDocument();
    // Both retired inputs are gone: the single "Housing authority" field and the
    // "Accepted vouchers / programs" list collapsed into the one above.
    expect(screen.queryByLabelText('Housing authority')).toBeNull();
    expect(screen.queryByLabelText(/Accepted vouchers/i)).toBeNull();
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

  it('sends a changed number as a number, and the authorities array', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Rent max/i), { target: { value: '2100' } });
    // Picking a name keeps the synthesized legacy authority beside it (the
    // first real edit migrates it into the new list rather than dropping it).
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'DCA');
    await user.click(await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      rent_max: 2100,
      accepted_authorities: ['ga_dca', 'Georgia Department of Community Affairs'],
    });
  });

  it('never sends the retired jurisdiction / accepted_programs keys', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    // A unit still carrying BOTH retired keys: stored legacy data must not leak
    // back onto the wire (both are server-side tombstones - app/src/lib/unitFields.ts).
    const legacy: UnitItem = { ...UNIT, accepted_programs: ['HCV', 'VASH'] };
    render(<ListingEditForm unit={legacy} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Remove ga_dca' }));
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    await user.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      accepted_authorities: ['Atlanta Housing Authority'],
    });
    const patch = updateUnit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('jurisdiction');
    expect(patch).not.toHaveProperty('accepted_programs');
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

  it('sets the Tour type from Not set and PATCHes the chosen value', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);

    const select = screen.getByLabelText('Tour type');
    expect(select).toHaveValue(''); // unset -> "Not set"
    await user.selectOptions(select, 'landlord_led');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { tour_type: 'landlord_led' });
  });

  it('clears the Tour type back to Not set and PATCHes an empty string (backend removes it)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const withType: UnitItem = { ...UNIT, tour_type: 'pm_team' };
    render(<ListingEditForm unit={withType} onClose={vi.fn()} onSaved={vi.fn()} />);

    const select = screen.getByLabelText('Tour type');
    expect(select).toHaveValue('pm_team');
    await user.selectOptions(select, '');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { tour_type: '' });
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

  it('tells staff which facts are publicly visible on the flyer', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText(/shown on the public flyer/i)).toBeInTheDocument();
  });

  // --- the authorities picker (spec 2026-10-06 D5, D6) -----------------------

  it('marks members that are not on the list, and an untouched list never reaches the PATCH', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const listed: UnitItem = { ...UNIT, accepted_authorities: ['Atlanta Housing Authority', ' DCA '] };
    render(<ListingEditForm unit={listed} onClose={vi.fn()} onSaved={vi.fn()} />);
    // Only the member that is not exactly a list name is marked.
    expect(await screen.findAllByText('Not on the list')).toHaveLength(1);
    await user.clear(screen.getByLabelText(/Tenant-paid utilities/i));
    await user.type(screen.getByLabelText(/Tenant-paid utilities/i), 'Gas only');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Gas only' });
  });

  it('removing one member sends the rest byte-exact', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const listed: UnitItem = { ...UNIT, accepted_authorities: ['Atlanta Housing Authority', ' DCA '] };
    render(<ListingEditForm unit={listed} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { accepted_authorities: [' DCA '] });
  });

  it('adds a housing authority through "Is this really new?" without saving the property', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('Metro Housing Board'));
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Metro Housing Board');
    await user.click(await screen.findByRole('option', { name: 'Add Metro Housing Board as a new housing authority' }));
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    expect(isNew.closest('form')).toBeNull();
    await waitFor(() => expect(within(isNew).getByRole('button', { name: 'Yes, add it' })).toBeEnabled());
    await user.click(within(isNew).getByRole('button', { name: 'Yes, add it' }));
    expect(addOrg).toHaveBeenCalledWith({ kind: 'housing_authority', name: 'Metro Housing Board' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Metro Housing Board' })).toBeInTheDocument());
    // Only the stored ga_dca is marked; the name just added counts at once (useOrgList noteAdded).
    expect(screen.getAllByText('Not on the list')).toHaveLength(1);
    expect(updateUnit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { accepted_authorities: ['ga_dca', 'Metro Housing Board'] });
  });

  it('shows a refused save (422 org_not_on_list) under the picker, worded from the body', async () => {
    const user = userEvent.setup();
    updateUnit.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'accepted_authorities',
        text: 'Atlanta Housing Authority',
        candidates: [],
        close: [],
      }),
    );
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    await user.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Atlanta Housing Authority is not on the list - pick a name from the list or add it.',
    );
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
  });
});
