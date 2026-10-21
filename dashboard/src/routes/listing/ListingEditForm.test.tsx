import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { PROPERTY_FORM_FIELDS } from './requirements.js';

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

  it('renders the public-flyer inputs (the fee by its exact label: "No application fee" sits beside it)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Video URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Application fee')).toBeInTheDocument();
    expect(screen.getByLabelText('No application fee')).toBeInTheDocument();
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
    expect(screen.getByLabelText('Application fee')).toHaveValue(25);
    expect(screen.getByLabelText(/Same-day RTA/i)).not.toBeChecked();

    await user.clear(screen.getByLabelText(/Video URL/i));
    await user.type(screen.getByLabelText(/Video URL/i), 'https://v.example/new');
    fireEvent.change(screen.getByLabelText('Application fee'), { target: { value: '40' } });
    await user.click(screen.getByLabelText(/Same-day RTA/i));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', {
      video_url: 'https://v.example/new',
      application_fee: 40,
      same_day_rta: true,
    });
  });

  // --- Voucher sizes accepted: picker B (spec 2026-10-20 D4) ----------------
  const sizes = (): HTMLElement => screen.getByRole('group', { name: 'Voucher sizes accepted' });

  it('shows the recorded voucher sizes as pressed chips and PATCHes the list when one is added', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, voucher_size_accepted: [2, 3] }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(within(sizes()).getByRole('button', { name: '2' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sizes()).getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sizes()).getByRole('button', { name: '4' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Accepts: 2 BR, 3 BR')).toBeInTheDocument();
    await user.click(within(sizes()).getByRole('button', { name: '4' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { voucher_size_accepted: [2, 3, 4] });
  });

  it('a stored single number shows as one pressed chip; left alone, nothing is sent', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={{ ...UNIT, voucher_size_accepted: 2 }} onClose={onClose} onSaved={vi.fn()} />);
    expect(within(sizes()).getByRole('button', { name: '2' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('emptying the picker PATCHes null (the property falls back to its bedroom count)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, voucher_size_accepted: 2 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(within(sizes()).getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { voucher_size_accepted: null });
  });

  it('never recorded and left empty sends nothing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={UNIT} onClose={onClose} onSaved={vi.fn()} />);
    expect(screen.getByText('Accepts: none recorded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a stored size of 5 or more opens the larger chips', () => {
    render(<ListingEditForm unit={{ ...UNIT, voucher_size_accepted: [6] }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(within(sizes()).getByRole('button', { name: '6' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'More sizes (5-12)' })).toBeNull();
  });

  it('a stored value with no chip is listed, and the next save drops it', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(
      <ListingEditForm unit={{ ...UNIT, voucher_size_accepted: [2, 2.5, 13] }} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('Not a valid size, removed when you save: 2.5, 13')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateUnit).toHaveBeenCalledWith('u1', { voucher_size_accepted: [2] });
  });

  it('clearing Beds still leaves it untouched (beds, baths, rent and the payment standard do not clear)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={UNIT} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Beds'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clearing the Fixed amount PATCHes null - the deposit is clearable now (spec 2026-10-20 D1)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, deposit: 1200 }} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('Fixed amount')).toHaveValue(1200);
    fireEvent.change(screen.getByLabelText('Fixed amount'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { deposit: null });
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

  it('a legend under the title explains both tags; the old single hint line is gone (spec 2026-10-20 D10)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('On flyer - tenants see it on the public flyer.')).toBeInTheDocument();
    expect(screen.getByText('Staff only - never leaves the dashboard.')).toBeInTheDocument();
    expect(screen.queryByText(/shown on the public flyer/i)).toBeNull();
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

  it('a list that fails to load marks no member "Not on the list" - nothing is known about it (R3-FE-5)', async () => {
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    const listed: UnitItem = { ...UNIT, accepted_authorities: ['Atlanta Housing Authority', ' DCA '] };
    render(<ListingEditForm unit={listed} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Couldn't load housing authorities")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
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

// --- Code review R1-ADV-FE-7: a name "Is this really new?" answered with ----
// The form's list is read once when it opens; /check knows a name added since.
describe('ListingEditForm - a name the server confirmed counts as on the list at once', () => {
  it('"Use <name>": its chip is not marked Not on the list', async () => {
    const user = userEvent.setup();
    const metro = { orgId: 'o-metro', kind: 'housing_authority' as const, name: 'Metro Housing Authority' };
    checkOrgText.mockResolvedValue({ match: metro, candidates: [], close: [], nameProblem: 'org_name_taken' });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Metro HA');
    await user.click(await screen.findByRole('option', { name: 'Add Metro HA as a new housing authority' }));
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(isNew).findByRole('button', { name: 'Use Metro Housing Authority' }));
    const chip = screen.getByRole('button', { name: 'Remove Metro Housing Authority' }).closest('li');
    expect(chip).not.toHaveTextContent('Not on the list');
  });
});

// --- Code review R1-ADV-FE-1: text typed in the picker but never picked ------
// Save adds typed text that names exactly one entry (by name, or by a spelling
// only that entry carries), as a pick would, and refuses anything else - it is
// never silently dropped.
describe('ListingEditForm - text typed in the picker but never picked', () => {
  const BLOCKED = 'Pick a name from the list, add it as new, or clear the text.';
  // AHA is a spelling two entries share; DCA belongs to one.
  const TYPED_LIST: OrgEntry[] = [
    orgEntry('Atlanta Housing Authority', ['AHA']),
    orgEntry('Augusta Housing Authority', ['AHA']),
    orgEntry('Georgia Department of Community Affairs', ['DCA']),
  ];
  const authorities = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authorities' });
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: TYPED_LIST });
  });

  it('a list name typed in full is added as if it were picked', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(authorities(), 'Atlanta Housing Authority');
    await screen.findByRole('option', { name: /^Atlanta Housing Authority/ });
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { accepted_authorities: ['ga_dca', 'Atlanta Housing Authority'] });
  });

  it('a spelling only one entry carries adds that entry', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(authorities(), 'DCA');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', {
      accepted_authorities: ['ga_dca', 'Georgia Department of Community Affairs'],
    });
  });

  it.each([
    ['a spelling two entries share', 'AHA'],
    ['unknown text', 'Metro Nowhere'],
  ])('%s stops Save: nothing is sent, the picker says why and takes focus', async (_case, text) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={UNIT} onClose={onClose} onSaved={vi.fn()} />);
    await user.type(authorities(), text);
    await screen.findAllByRole('option');
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(BLOCKED);
    expect(authorities().getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(authorities()).toHaveFocus();
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['DCA', 'Save will use Georgia Department of Community Affairs.'],
    ['AHA', 'Not saved - pick a name from the list, add it as new, or clear the text.'],
  ])('the note under the field says what Save will do with %s (R2-FE-6)', async (text, note) => {
    const user = userEvent.setup();
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(authorities(), text);
    await screen.findAllByRole('option');
    await user.tab();
    // The field's flyer tag joins the description after the note (spec 2026-10-20 D10).
    expect(authorities()).toHaveAccessibleDescription(`${note} On flyer`);
  });

  it('a member removed after typing a name: the name stays and Save adds it (R2-FE-2)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    const listed: UnitItem = { ...UNIT, accepted_authorities: ['Atlanta Housing Authority', 'ga_dca'] };
    render(<ListingEditForm unit={listed} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(authorities(), 'DCA');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await user.click(screen.getByRole('button', { name: 'Remove ga_dca' }));
    expect(authorities()).toHaveValue('DCA');
    await user.click(save());
    // The stale member goes AND the typed authority is added.
    expect(updateUnit).toHaveBeenCalledWith('u1', {
      accepted_authorities: ['Atlanta Housing Authority', 'Georgia Department of Community Affairs'],
    });
  });

  it('every refused Save is announced again - the alert is a new one each time (R2-FE-10)', async () => {
    const user = userEvent.setup();
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(authorities(), 'AHA');
    await screen.findAllByRole('option');
    await user.click(save());
    const first = await screen.findByRole('alert');
    await user.click(save());
    const second = screen.getByRole('alert');
    expect(second).not.toBe(first);
    expect(second).toHaveTextContent(BLOCKED);
    expect(updateUnit).not.toHaveBeenCalled();
  });

  it('the read fails while text is typed: the field stays clearable and Save waits for it (R3-FE-3)', async () => {
    const user = userEvent.setup();
    const held = { reject: (_err: unknown): void => {} };
    getOrgList.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        held.reject = reject;
      }),
    );
    updateUnit.mockResolvedValue({ ...UNIT });
    const onSaved = vi.fn();
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={onSaved} />);
    await user.type(authorities(), 'DCA');
    await act(async () => held.reject(new ApiError(503, 'org_list_busy', 'org_list_busy')));
    expect(screen.getByText("Couldn't load housing authorities")).toBeInTheDocument();
    // Clear-only: the text stays in an enabled field, with nothing to pick or add.
    expect(authorities()).toBeEnabled();
    expect(authorities()).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Tenant-paid utilities/i));
    await user.type(screen.getByLabelText(/Tenant-paid utilities/i), 'Gas only');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The list did not load - clear the text to save without it.',
    );
    expect(authorities()).toHaveFocus();
    expect(updateUnit).not.toHaveBeenCalled();
    // Cleared, the field is done with (disabled again) and the rest saves.
    await user.clear(authorities());
    expect(authorities()).toBeDisabled();
    await user.click(save());
    await waitFor(() => expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Gas only' }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('(PIN) a typed name the list already holds changes nothing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const listed: UnitItem = { ...UNIT, accepted_authorities: ['Atlanta Housing Authority', 'ga_dca'] };
    render(<ListingEditForm unit={listed} onClose={onClose} onSaved={vi.fn()} />);
    await screen.findByText('Not on the list'); // the list has loaded (ga_dca is marked)
    await user.type(authorities(), 'Atlanta Housing Authority');
    await user.click(save());
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// --- Spec 2026-10-20 (property requirements): the D10 fields, tags and order,
// subzone, washer / dryer, the requirement items, and the 409 ----------------
describe('ListingEditForm - property requirements and fields (spec 2026-10-20)', () => {
  const TAG = { on_flyer: 'On flyer', staff_only: 'Staff only' } as const;
  const PUBLIC_NOTE = 'Tenants see this on the public flyer.';
  const ADDRESS_PARTS = ['Street address', 'Apt / unit', 'City', 'State', 'ZIP'];
  // The D10a rows of THIS form: the Edit form has no landlord field (no
  // dashboard form PATCHes landlordId - spec section 2), so the New form's
  // first row, Owning landlord, is not here.
  const EDIT_FIELDS = PROPERTY_FORM_FIELDS.filter((f) => f.label !== 'Owning landlord');
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  /** The control(s) one D10a row labels. */
  function controlsFor(label: string): HTMLElement[] {
    if (label === 'Address') return ADDRESS_PARTS.map((part) => screen.getByLabelText(part));
    if (label === 'Housing authorities') return [screen.getByRole('combobox', { name: label })];
    if (label === 'Voucher sizes accepted') return [screen.getByRole('group', { name: label })];
    return [screen.getByLabelText(label)];
  }
  /** The elements a control's aria-describedby names. */
  function describers(control: HTMLElement): HTMLElement[] {
    return (control.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
  }
  const describedTexts = (control: HTMLElement): string[] => describers(control).map((el) => el.textContent ?? '');

  it.each(EDIT_FIELDS.map((f) => [f.label, f.flyer] as const))(
    '%s carries its %s tag, outside its accessible name (D10, D10a)',
    (label, flyer) => {
      render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
      for (const control of controlsFor(label)) {
        expect(describedTexts(control)).toContain(TAG[flyer]);
        const tag = describers(control).find((el) => el.textContent === TAG[flyer]);
        expect(tag?.closest('label')).toBeNull();
        if (label !== 'Address') expect(control).toHaveAccessibleName(label);
      }
    },
  );

  it('(PIN) has no Owning landlord field - that row is the New form only', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText('Owning landlord')).toBeNull();
    expect(EDIT_FIELDS).toHaveLength(PROPERTY_FORM_FIELDS.length - 1);
  });

  it('the fields run in the D10 order (the D10a table is in form order)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const firsts = EDIT_FIELDS.map((f) => controlsFor(f.label)[0]);
    for (let i = 1; i < firsts.length; i += 1) {
      const before = firsts[i - 1];
      const after = firsts[i];
      if (before === undefined || after === undefined) throw new Error('a D10a field has no control');
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${EDIT_FIELDS[i - 1]?.label} before ${EDIT_FIELDS[i]?.label}`,
      ).toBeTruthy();
    }
  });

  it('only Tenant-paid utilities says tenants see it; every other box does not (flyer-leads D2)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(describedTexts(screen.getByLabelText('Tenant-paid utilities'))).toContain(PUBLIC_NOTE);
    for (const label of [
      'Accessibility',
      'Lease terms',
      'Pets (details)',
      'Pet fee',
      'Notes',
      'Subzone',
      'Deposit notes',
      'Qualifications',
      'Public listing link',
    ]) {
      expect(describedTexts(screen.getByLabelText(label)), label).not.toContain(PUBLIC_NOTE);
    }
    expect(screen.getAllByText(PUBLIC_NOTE)).toHaveLength(1);
  });

  it('rent, accessibility, lease terms, pets and deposit read Staff only; the fee pair stays On flyer (flyer-leads D2)', () => {
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const label of [
      'Rent min',
      'Rent max',
      'Accessibility',
      'Lease terms',
      'No pets',
      'Pets (details)',
      'Pet fee',
      "One month's rent",
      'Fixed amount',
      'Flexible / payment terms available',
    ]) {
      const texts = describedTexts(screen.getByLabelText(label));
      expect(texts, label).toContain(TAG.staff_only);
      expect(texts, label).not.toContain(TAG.on_flyer);
    }
    for (const label of ['No application fee', 'Application fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).toContain(TAG.on_flyer);
    }
  });

  it('prefills Subzone and PATCHes it; clearing it sends an empty string (the server removes it, D3)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, subzone: 'E8' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Subzone')).toHaveValue('E8');
    await user.clear(screen.getByLabelText('Subzone'));
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { subzone: '' });
  });

  it('Washer / dryer offers the D3 choices and PATCHes the one picked', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const select = screen.getByLabelText('Washer / dryer');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Not recorded',
      'Hookups',
      'Washer and dryer included',
      'No hookups',
    ]);
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'included');
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { washer_dryer: 'included' });
  });

  it('setting Washer / dryer back to Not recorded sends an empty string', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, washer_dryer: 'none' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText('Washer / dryer'), '');
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { washer_dryer: '' });
  });

  it('a legacy pets false reads as No pets with blank details, and is not re-sent untouched (D1)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ListingEditForm unit={{ ...UNIT, pets: false }} onClose={onClose} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('No pets')).toBeChecked();
    expect(screen.getByLabelText('Pets (details)')).toHaveValue('');
    await user.click(save());
    expect(updateUnit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a legacy pets true reads as details "Allowed"; a pet fee edit alone sends only the pet fee', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, pets: true }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('No pets')).not.toBeChecked();
    expect(screen.getByLabelText('Pets (details)')).toHaveValue('Allowed');
    await user.type(screen.getByLabelText('Pet fee'), '$300');
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { pet_fee: '$300' });
  });

  it('ticking No evictions sends true', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByLabelText('No evictions while on the program'));
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { no_evictions_on_program: true });
  });

  it('unticking a recorded No evictions sends null (the server removes it)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, no_evictions_on_program: true }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByLabelText('No evictions while on the program'));
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { no_evictions_on_program: null });
  });

  it("ticking One month's rent clears and disables the fixed amount and sends the amount as null in the same save", async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, deposit: 1200 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByLabelText("One month's rent"));
    expect(screen.getByLabelText('Fixed amount')).toBeDisabled();
    expect(screen.getByLabelText('Fixed amount')).toHaveValue(null);
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { deposit_one_month: true, deposit: null });
  });

  it("ticking One month's rent sends the amount as null even when none was showing (D1: a colleague may have set one)", async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByLabelText("One month's rent"));
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { deposit_one_month: true, deposit: null });
  });

  it("unticking a recorded One month's rent sends null and makes the fixed amount editable", async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, deposit_one_month: true }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Fixed amount')).toBeDisabled();
    await user.click(screen.getByLabelText("One month's rent"));
    expect(screen.getByLabelText('Fixed amount')).toBeEnabled();
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { deposit_one_month: null });
  });

  it('No application fee records 0 and disables the amount', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByLabelText('No application fee'));
    expect(screen.getByLabelText('Application fee')).toBeDisabled();
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { application_fee: 0 });
  });

  it('a recorded 0 reads as No application fee; unticking it sends null (no fee recorded)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, application_fee: 0 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('No application fee')).toBeChecked();
    await user.click(screen.getByLabelText('No application fee'));
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { application_fee: null });
  });

  // Code review R2D-5: the checkbox is its own flag - a partial amount that
  // reads 0 never ticks it or locks the box, and Save sends the amount typed
  // (never the form-only flag).
  it('deleting the 4 of a stored 40 keeps the box editable and unticked; Save sends 0', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, application_fee: 40 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const fee = screen.getByLabelText('Application fee');
    await user.click(fee);
    await user.keyboard('{Home}{Delete}');
    expect(fee).toBeEnabled();
    expect(screen.getByLabelText('No application fee')).not.toBeChecked();
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { application_fee: 0 });
  });

  it('a typed $0.50 fee is never mistaken for No application fee; Save sends 0.5', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText('Application fee'), '0.50');
    expect(screen.getByLabelText('No application fee')).not.toBeChecked();
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { application_fee: 0.5 });
  });

  it('a cleared text requirement sends an empty string (the server removes it)', async () => {
    const user = userEvent.setup();
    updateUnit.mockResolvedValue({ ...UNIT });
    render(<ListingEditForm unit={{ ...UNIT, credit_requirements: '600+' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Credit score')).toHaveValue('600+');
    await user.clear(screen.getByLabelText('Credit score'));
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { credit_requirements: '' });
  });

  it('a 409 property_changed keeps the form open with what staff typed and says to save again (D5)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateUnit
      .mockRejectedValueOnce(new ApiError(409, 'property_changed', 'property_changed', { error: 'property_changed' }))
      .mockResolvedValueOnce({ ...UNIT, credit_requirements: '600+' });
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={onSaved} />);
    await user.type(screen.getByLabelText('Credit score'), '600+');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This property changed while you were saving. Save again.',
    );
    expect(screen.getByRole('dialog', { name: 'Edit property' })).toBeInTheDocument();
    expect(screen.getByLabelText('Credit score')).toHaveValue('600+');
    expect(onSaved).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateUnit).toHaveBeenCalledTimes(2);
    expect(updateUnit).toHaveBeenNthCalledWith(2, 'u1', { credit_requirements: '600+' });
  });

  it('a 400 deposit_conflict says why, keeps the form open with what staff typed, and is not the generic error (D1)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateUnit.mockRejectedValueOnce(
      new ApiError(400, 'deposit_conflict', 'deposit_conflict', { error: 'deposit_conflict' }),
    );
    render(<ListingEditForm unit={UNIT} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Fixed amount'), { target: { value: '1200' } });
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { deposit: 1200 });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "A deposit can be one month's rent or a fixed amount, not both. Reload the property and try again.",
    );
    expect(alert).not.toHaveTextContent(/couldn.t save/i);
    expect(screen.getByRole('dialog', { name: 'Edit property' })).toBeInTheDocument();
    expect(screen.getByLabelText('Fixed amount')).toHaveValue(1200);
    expect(onSaved).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
  });

  it('a stored deposit with cents (1250.5) never blocks Save: another field changed, the patch is sent (planner PR2-3)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateUnit.mockResolvedValue({ ...UNIT, deposit: 1250.5, utilities: 'Gas only' });
    render(<ListingEditForm unit={{ ...UNIT, deposit: 1250.5 }} onClose={vi.fn()} onSaved={onSaved} />);
    const amount = screen.getByLabelText('Fixed amount');
    expect(amount).toHaveValue(1250.5);
    // step="any": a number input's default step is 1, which would mark 1250.5 a
    // step mismatch and stop the submit before onSubmit runs.
    expect(amount).toHaveAttribute('step', 'any');
    await user.clear(screen.getByLabelText('Tenant-paid utilities'));
    await user.type(screen.getByLabelText('Tenant-paid utilities'), 'Gas only');
    await user.click(save());
    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Gas only' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
