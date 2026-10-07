import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError, type Contact, type OrgEntry } from '../../api/index.js';

const updateContact = vi.fn();
const setTenantStatus = vi.fn();
// The pickers' list and "Is this really new?" (spec 2026-10-06 D6).
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    updateContact: (...a: unknown[]) => updateContact(...a),
    setTenantStatus: (...a: unknown[]) => setTenantStatus(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
  };
});

vi.mock('./useContactVocabulary.js', () => ({
  useContactVocabulary: () => ({ roles: [], relationshipRoles: [], fieldLabels: [] }),
}));

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

function orgEntry(kind: OrgEntry['kind'], name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind,
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}

const ORG_ENTRIES: OrgEntry[] = [
  orgEntry('housing_authority', 'Atlanta Housing Authority', ['AHA']),
  orgEntry('housing_authority', 'DeKalb County Housing Authority', ['HADC']),
  orgEntry('agency', 'Step Up'),
];

// clearAllMocks keeps implementations, so every test starts from these.
beforeEach(() => {
  getOrgList.mockResolvedValue({ version: 1, entries: ORG_ENTRIES });
  checkOrgText.mockResolvedValue({ candidates: [], close: [] });
  addOrg.mockReset();
});

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
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'DeKalb County Housing Authority' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // A pick commits the entry's exact name (spec 2026-10-06 D3/D6); HADC is a spelling.
    await user.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'HADC');
    await user.click(await screen.findByRole('option', { name: /^DeKalb County Housing Authority/ }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'DeKalb County Housing Authority' });
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

  it('shows a voucher expiration date input for a tenant only', () => {
    const { unmount } = render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/Voucher expiration date/i)).toBeInTheDocument();
    unmount();
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText(/Voucher expiration date/i)).toBeNull();
  });

  it('PATCHes a set voucher expiration date as an ISO instant', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Voucher expiration date/i), {
      target: { value: '2026-08-15' },
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', {
        voucher_expiration_date: '2026-08-15T00:00:00.000Z',
      }),
    );
  });

  it('PATCHes null to CLEAR a previously-set voucher expiration date', async () => {
    const user = userEvent.setup();
    const withExp: Contact = { ...TENANT, voucher_expiration_date: '2026-08-15T00:00:00.000Z' };
    updateContact.mockResolvedValue({ ...withExp });
    render(<ContactEditForm contact={withExp} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Voucher expiration date/i), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', { voucher_expiration_date: null }),
    );
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

  it('giving the contact a role via Change type → Other → PATCH includes {role}', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, role: 'Case worker' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // Role now lives in the (collapsed) KindPicker — open it, go to Other, type
    // the role, then keep the Tenant base shape.
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Other' }));
    await user.type(screen.getByLabelText(/^Role$/i), 'Case worker');
    await user.click(screen.getByRole('radio', { name: /Tenant/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', { role: 'Case worker' }),
    );
    const patch = updateContact.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('relationships' in patch).toBe(false);
    expect('customFields' in patch).toBe(false);
  });

  it('adding a relationship (role + name) → PATCH includes {relationships: [...]}', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // Click "+ Add relationship" to expand the editor
    await user.click(screen.getByRole('button', { name: /\+ Add relationship/i }));
    await user.type(screen.getByLabelText(/Relationship role 1/i), 'Spouse');
    await user.type(screen.getByLabelText(/Contact search 1/i), 'Jane Doe');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith(
        'k1',
        expect.objectContaining({ relationships: [{ role: 'Spouse', name: 'Jane Doe' }] }),
      ),
    );
  });

  it('adding a custom field (label + value) → PATCH includes {customFields: [...]}', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // Click "+ Add custom field" to expand the editor
    await user.click(screen.getByRole('button', { name: /\+ Add custom field/i }));
    await user.type(screen.getByLabelText(/Field label 1/i), 'Notes');
    await user.type(screen.getByLabelText(/Field value 1/i), 'Prefers calls');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith(
        'k1',
        expect.objectContaining({ customFields: [{ label: 'Notes', value: 'Prefers calls' }] }),
      ),
    );
  });

  it('changing the Type swaps the type-specific fields and PATCHes { type }', async () => {
    const user = userEvent.setup();
    // A tenant on 'needs_review' resolves to the SAME default for a landlord, so
    // the type switch sends only { type } (no incidental status delta).
    const stable = { ...TENANT, status: 'needs_review' };
    updateContact.mockResolvedValue({ ...stable, type: 'landlord' });
    render(<ContactEditForm contact={stable} onClose={vi.fn()} onSaved={vi.fn()} />);

    // Starts as a tenant: voucher shown, company hidden.
    expect(screen.getByLabelText(/Voucher size/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Company$/i)).toBeNull();

    // Open the collapsed Type control and pick Landlord in the KindPicker.
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));

    // Fields swap immediately on the type change (no save needed).
    expect(screen.queryByLabelText(/Voucher size/i)).toBeNull();
    expect(screen.getByLabelText(/^Company$/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { type: 'landlord' });
  });

  it('editing Unknown to Property Manager sends the full landlord and role pair', async () => {
    const user = userEvent.setup();
    const unknown: Contact = { ...TENANT, contactId: 'u9', type: 'unknown', status: 'needs_review' };
    updateContact.mockResolvedValue({ ...unknown, type: 'landlord', role: 'Property Manager' });
    render(<ContactEditForm contact={unknown} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Property Manager' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('u9', { type: 'landlord', role: 'Property Manager' });
  });

  it('editing a stored Property Manager to plain Landlord clears only the role', async () => {
    const user = userEvent.setup();
    const propertyManager: Contact = { ...LANDLORD, role: 'Property Manager' };
    updateContact.mockResolvedValue({ ...propertyManager, role: '' });
    render(<ContactEditForm contact={propertyManager} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('L1', { role: '' });
  });

  it('does not send { type } when the type is left unchanged', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, firstName: 'Natasha' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const first = screen.getByLabelText(/First name/i);
    await user.clear(first);
    await user.type(first, 'Natasha');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    const patch = updateContact.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('type' in patch).toBe(false);
  });

  it('offers the 7 tenant statuses for a tenant and 2 for a non-tenant', () => {
    // A tenant already on a valid tenant status → exactly the 7 tenant options.
    render(
      <ContactEditForm contact={{ ...TENANT, status: 'searching' }} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    const tenantSelect = screen.getByRole('combobox', { name: /Status/i });
    expect(within(tenantSelect).getAllByRole('option')).toHaveLength(7);
    expect(within(tenantSelect).getByRole('option', { name: 'Searching' })).toBeInTheDocument();
    expect(within(tenantSelect).getByRole('option', { name: 'On hold' })).toBeInTheDocument();

    // A landlord -> the 5-value lead lifecycle (needs_review|interested|onboarding|active|parked).
    // EXACT 'Status' name: the landlord dialog also has "Contract status", and
    // the Status select now sits ABOVE the onboarding fieldset (2026-07-14
    // reorder), so a regex + positional pick would grab the wrong combobox.
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    const landlordSelect = screen.getAllByRole('combobox', { name: 'Status' }).at(-1)!;
    expect(within(landlordSelect).getAllByRole('option')).toHaveLength(5);
    expect(within(landlordSelect).getByRole('option', { name: 'Interested' })).toBeInTheDocument();
    expect(within(landlordSelect).getByRole('option', { name: 'Onboarding' })).toBeInTheDocument();
    expect(within(landlordSelect).getByRole('option', { name: 'Parked' })).toBeInTheDocument();
  });

  it('shows a porting checkbox for a tenant only', () => {
    const { unmount } = render(
      <ContactEditForm contact={{ ...TENANT, status: 'searching' }} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole('checkbox', { name: /Porting/i })).toBeInTheDocument();
    unmount();
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: /Porting/i })).toBeNull();
  });

  it('saving a tenant status change calls setTenantStatus (NOT updateContact)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const updated = { ...TENANT, status: 'placing' };
    setTenantStatus.mockResolvedValue(updated);
    render(
      <ContactEditForm contact={{ ...TENANT, status: 'searching' }} onClose={vi.fn()} onSaved={onSaved} />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /Status/i }), 'placing');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(setTenantStatus).toHaveBeenCalledWith('k1', {
        toStatus: 'placing',
        source: 'manual',
        porting: false,
      }),
    );
    expect(updateContact).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  });

  it('toggling porting round-trips through setTenantStatus (porting:true)', async () => {
    const user = userEvent.setup();
    setTenantStatus.mockResolvedValue({ ...TENANT, porting: true });
    render(
      <ContactEditForm contact={{ ...TENANT, status: 'searching' }} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await user.click(screen.getByRole('checkbox', { name: /Porting/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(setTenantStatus).toHaveBeenCalledWith('k1', {
        toStatus: 'searching',
        source: 'manual',
        porting: true,
      }),
    );
  });

  it('a non-tenant status change rides updateContact (plain PATCH)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD, status: 'active' });
    render(
      <ContactEditForm contact={{ ...LANDLORD, status: 'needs_review' }} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /^Status$/i }), 'active');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { status: 'active' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  // --- Off-list tenant status (the adversarial-review gap) -------------------
  // The TENANT fixture is stored on the legacy non-tenant 'active' status — an
  // off-list value for a tenant. The form must NEVER surface or submit it.

  it('a tenant stored on off-list "active" renders a VALID tenant status (not "active") and offers the 7 tenant statuses', () => {
    // TENANT.status === 'active' (off-list for a tenant).
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: /Status/i }) as HTMLSelectElement;
    // Exactly the 7 tenant statuses — no off-list 'active' prepended.
    const options = within(select).getAllByRole('option');
    expect(options).toHaveLength(7);
    expect(options.map((o) => (o as HTMLOptionElement).value)).not.toContain('active');
    // The effective selection defaults to the front door (a valid tenant value).
    expect(select.value).toBe('needs_review');
  });

  it('toggling porting on an off-list tenant saves via setTenantStatus with a VALID toStatus (NOT "active")', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const updated = { ...TENANT, status: 'needs_review', porting: true };
    setTenantStatus.mockResolvedValue(updated);
    // TENANT.status === 'active'; only toggle porting (don't touch the status select).
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole('checkbox', { name: /Porting/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(setTenantStatus).toHaveBeenCalled());
    const arg = setTenantStatus.mock.calls[0]?.[1] as { toStatus: string; porting: boolean };
    expect(arg.toStatus).toBe('needs_review'); // a valid TenantStatus, NOT 'active'
    expect(arg.porting).toBe(true);
    expect(arg.toStatus).not.toBe('active');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  });

  it('changing type landlord→tenant resets the status to a valid tenant value (never submits "active" as a tenant status)', async () => {
    const user = userEvent.setup();
    // LANDLORD.status === 'active' (valid for a non-tenant). Switching to tenant
    // must reset the selection to a valid tenant status.
    setTenantStatus.mockResolvedValue({ ...LANDLORD, type: 'tenant', status: 'needs_review' });
    updateContact.mockResolvedValue({ ...LANDLORD, type: 'tenant' });
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));

    // The status select now offers tenant statuses and the selection is valid.
    const select = screen.getByRole('combobox', { name: /Status/i }) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(7);
    expect(select.value).toBe('needs_review');
    expect((within(select).queryAllByRole('option') as HTMLOptionElement[]).map((o) => o.value)).not.toContain(
      'active',
    );

    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // A tenant status write (if any) never carries 'active'.
    for (const call of setTenantStatus.mock.calls) {
      expect((call[1] as { toStatus: string }).toStatus).not.toBe('active');
    }
  });

  // --- Landlord onboarding inputs (Task 4b) ---------------------------------

  it('shows the landlord onboarding inputs for a landlord only', () => {
    const { unmount } = render(
      <ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByLabelText(/^Contract status$/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^Registered landlord$/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^Submits RTA within 48h$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /^Passes inspection first try$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /^Voucher counts as income$/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Park reason$/i)).toBeInTheDocument();
    unmount();

    // None of these show for a tenant.
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText(/^Contract status$/i)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Registered landlord$/i })).toBeNull();
    expect(screen.queryByLabelText(/^Park reason$/i)).toBeNull();
  });

  it('PATCHes changed landlord onboarding fields', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD });
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText(/^Contract status$/i), 'signed');
    await user.click(screen.getByRole('checkbox', { name: /^Registered landlord$/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Submits RTA within 48h$/i }));
    await user.click(screen.getByRole('checkbox', { name: /^Voucher counts as income$/i }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    const patch = updateContact.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      contract_status: 'signed',
      registered_landlord: true,
      rta_within_48h: true,
      income_includes_voucher: true,
    });
    // Untouched booleans aren't sent.
    expect('pass_inspection_first_try' in patch).toBe(false);
  });

  it('no landlord preference / expected-rent inputs — those fields moved to the property', () => {
    // 2026-07-10: accepted programs / lease terms / pet policy / expected rent
    // are per-property facts edited on the UNIT (ListingEditForm), not here.
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText(/^Accepted vouchers \/ programs$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Lease terms$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Pet policy$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Expected rent$/i)).toBeNull();
  });

  it('PATCHes a park_reason for a landlord', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD });
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Park reason$/i), 'Declined the program');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('L1', { park_reason: 'Declined the program' }),
    );
  });

  it('moves a landlord to Parked via the Status select (plain PATCH)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD, status: 'parked' });
    render(
      <ContactEditForm
        contact={{ ...LANDLORD, status: 'interested' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /^Status$/i }), 'parked');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { status: 'parked' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('only changing the name does NOT include role/relationships/customFields in the patch', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, firstName: 'Natasha' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const first = screen.getByLabelText(/First name/i);
    await user.clear(first);
    await user.type(first, 'Natasha');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    const patch = updateContact.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('role' in patch).toBe(false);
    expect('relationships' in patch).toBe(false);
    expect('customFields' in patch).toBe(false);
  });

  // --- Housing authority + agency pickers (spec 2026-10-06 D6) ---------------
  // Each field is a picker over its own stored list (OrgPicker): a pick or a
  // removed chip is the only change, an untouched value never reaches the
  // PATCH (housingAuthority is a PROVENANCE field - including the key at all
  // supersedes a pending AI suggestion), and a stored value that is not on the
  // list stays as it is until staff change it.

  it('explains the housing authority field and offers names and spellings, never agencies', async () => {
    const user = userEvent.setup();
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    const picker = screen.getByRole('combobox', { name: 'Housing authority' });
    expect(picker).toHaveAccessibleDescription('The organization that runs the voucher');
    await user.type(picker, 'aha');
    expect(await screen.findByRole('option', { name: 'Atlanta Housing Authority (AHA)' })).toBeInTheDocument();
    await user.clear(picker);
    await user.type(picker, 'Step Up');
    expect(
      await screen.findByRole('option', { name: 'Add Step Up as a new housing authority' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Step Up/ })).not.toBeInTheDocument();
  });

  it('typed text is never dropped silently: part of a name stops Save and the picker says why', async () => {
    // Code review R1-ADV-FE-1: Save used to close as "nothing changed" here.
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContactEditForm contact={TENANT} onClose={onClose} onSaved={vi.fn()} />);
    const picker = screen.getByRole('combobox', { name: 'Housing authority' });
    await user.type(picker, 'Atl');
    await screen.findByRole('option', { name: /^Atlanta Housing Authority/ });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Pick a name from the list, add it as new, or clear the text.');
    expect(picker.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(picker).toHaveFocus();
    expect(picker).toHaveValue('Atl');
    expect(updateContact).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks stored values that are not on the list and never sends them untouched', async () => {
    const user = userEvent.setup();
    const stored: Contact = { ...TENANT, housingAuthority: 'Atlanta  (AHA) ', agency: 'Hope  Atlanta' };
    updateContact.mockResolvedValue({ ...stored, firstName: 'TashaX' });
    render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findAllByText('Not on the list')).toHaveLength(2);
    await user.type(screen.getByLabelText(/First name/i), 'X'); // dirty something else
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    // Neither org key rides the PATCH (D5: an unchanged value is never refused).
    expect(updateContact.mock.calls[0]?.[1]).toStrictEqual({ firstName: 'TashaX' });
  });

  it('removing the chip clears the field as an empty string', async () => {
    // The clear-it wire contract: the server turns '' into a REMOVE
    // (housingAuthority is a GSI key and DynamoDB rejects '' there).
    const user = userEvent.setup();
    const stored: Contact = { ...TENANT, housingAuthority: 'Atlanta Housing Authority' };
    updateContact.mockResolvedValue({ ...TENANT });
    render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: '' });
  });

  it('picks an agency from the agency list', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, agency: 'Step Up' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Agency' }), 'step');
    await user.click(await screen.findByRole('option', { name: 'Step Up' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { agency: 'Step Up' });
  });

  it('"Is this really new?" opens outside the form; "Yes, add it" fills the field without saving', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('housing_authority', 'Metro Housing Authority'));
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Metro Housing Authority' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'Metro Housing Authority');
    await user.click(
      await screen.findByRole('option', { name: 'Add Metro Housing Authority as a new housing authority' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    // Rendered after the </form>: nothing in it can submit the edit form.
    expect(dialog.closest('form')).toBeNull();
    const yes = within(dialog).getByRole('button', { name: 'Yes, add it' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(addOrg).toHaveBeenCalledWith({ kind: 'housing_authority', name: 'Metro Housing Authority' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Is this really new?' })).not.toBeInTheDocument(),
    );
    const chip = screen.getByRole('button', { name: 'Remove Metro Housing Authority' }).closest('li');
    // The name just added counts as on the list at once - even though this
    // test's re-read still answers the old list (useOrgList noteAdded).
    expect(chip).not.toHaveTextContent('Not on the list');
    // Adding to the list never saves the contact; Save does.
    expect(updateContact).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Metro Housing Authority' });
  });

  it('a close name offered by the dialog fills the field instead of adding', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({
      candidates: [],
      close: [{ orgId: 'id-Atlanta Housing Authority', kind: 'housing_authority', name: 'Atlanta Housing Authority' }],
    });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'Atlnta Housng');
    await user.click(await screen.findByRole('option', { name: 'Add Atlnta Housng as a new housing authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Use Atlanta Housing Authority' }));
    expect(screen.queryByRole('dialog', { name: 'Is this really new?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(addOrg).not.toHaveBeenCalled();
  });

  it('a housing authority picker given an agency name offers to put it in Agency', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({
      candidates: [],
      close: [],
      otherKind: [{ orgId: 'id-Step Up', kind: 'agency', name: 'Step Up' }],
      nameProblem: 'org_name_taken',
    });
    updateContact.mockResolvedValue({ ...TENANT, agency: 'Step Up' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'Step Up');
    await user.click(await screen.findByRole('option', { name: 'Add Step Up as a new housing authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Put it in Agency' }));
    expect(screen.getByRole('button', { name: 'Remove Step Up' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { agency: 'Step Up' });
  });

  it('a refused save (422 org_not_on_list) shows under its picker, worded from the body', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'housingAuthority',
        text: 'DeKalb County Housing Authority',
        candidates: [],
        close: [],
      }),
    );
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Housing authority' }), 'HADC');
    await user.click(await screen.findByRole('option', { name: /^DeKalb County Housing Authority/ }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'DeKalb County Housing Authority is not on the list - pick a name from the list or add it.',
    );
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
    // Changing the field clears the message.
    await user.click(screen.getByRole('button', { name: 'Remove DeKalb County Housing Authority' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a list that fails to load says so and leaves the rest of the form working', async () => {
    const user = userEvent.setup();
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    updateContact.mockResolvedValue({ ...TENANT, firstName: 'TashaX' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Couldn't load housing authorities")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load agencies")).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Housing authority' })).toBeDisabled();
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { firstName: 'TashaX' });
  });
});

// --- Code review R1-ADV-FE-7: a name "Is this really new?" answered with ----
// The form's list is read once when it opens. A name added (or renamed) by
// someone else since is not in it, but the server's /check knows it - the
// chip of a name taken from that answer must not say "Not on the list".
describe('ContactEditForm - a name the server confirmed counts as on the list at once', () => {
  const METRO = { orgId: 'o-metro', kind: 'housing_authority' as const, name: 'Metro Housing Authority' };
  const HOPE = { orgId: 'o-hope', kind: 'agency' as const, name: 'Hope Atlanta' };
  const housingAuthority = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authority' });
  const chipOf = (name: string): HTMLElement | null =>
    screen.getByRole('button', { name: `Remove ${name}` }).closest('li');

  it('"Use <name>": its chip is not marked Not on the list', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ match: METRO, candidates: [], close: [], nameProblem: 'org_name_taken' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Metro HA');
    await user.click(await screen.findByRole('option', { name: 'Add Metro HA as a new housing authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Use Metro Housing Authority' }));
    expect(chipOf('Metro Housing Authority')).not.toHaveTextContent('Not on the list');
  });

  it('"Put it in Agency": the agency chip is not marked either', async () => {
    const user = userEvent.setup();
    checkOrgText.mockResolvedValue({ candidates: [], close: [], otherKind: [HOPE], nameProblem: 'org_name_taken' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Hope Atlanta');
    await user.click(await screen.findByRole('option', { name: 'Add Hope Atlanta as a new housing authority' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Put it in Agency' }));
    expect(chipOf('Hope Atlanta')).not.toHaveTextContent('Not on the list');
  });

  it('"Use <name>" for an entry RENAMED since the form read its list: not marked either (R2-FE-7)', async () => {
    const user = userEvent.setup();
    // The form's list holds o-atl under its OLD name, and the re-read "Use"
    // starts never lands.
    getOrgList.mockResolvedValueOnce({
      version: 1,
      entries: [{ ...orgEntry('housing_authority', 'Atlanta HA'), orgId: 'o-atl' }],
    });
    getOrgList.mockReturnValue(new Promise(() => {}));
    const renamed = { orgId: 'o-atl', kind: 'housing_authority' as const, name: 'Atlanta Housing Authority' };
    checkOrgText.mockResolvedValue({ match: renamed, candidates: [], close: [], nameProblem: 'org_name_taken' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Atlanta Housing Authority');
    await user.click(
      await screen.findByRole('option', { name: 'Add Atlanta Housing Authority as a new housing authority' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Use Atlanta Housing Authority' }));
    expect(chipOf('Atlanta Housing Authority')).not.toHaveTextContent('Not on the list');
  });
});

// --- Code review R1-ADV-FE-1: text typed in a picker but never picked --------
// The pickers used to be free-text inputs: staff type the name and Save. Save
// now commits typed text that names exactly one entry (by name, or by a
// spelling only that entry carries), as a pick would, and refuses anything
// else - it is never silently dropped.
describe('ContactEditForm - text typed in a picker but never picked', () => {
  const BLOCKED = 'Pick a name from the list, add it as new, or clear the text.';
  // AHA is a spelling two entries share; DCA belongs to one.
  const TYPED_LIST: OrgEntry[] = [
    orgEntry('housing_authority', 'Atlanta Housing Authority', ['AHA']),
    orgEntry('housing_authority', 'Augusta Housing Authority', ['AHA']),
    orgEntry('housing_authority', 'DeKalb County Housing Authority', ['HADC']),
    orgEntry('housing_authority', 'Georgia Department of Community Affairs', ['DCA']),
    orgEntry('agency', 'Step Up'),
  ];
  const housingAuthority = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authority' });
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: TYPED_LIST });
  });

  it('a list name typed in full is saved as if it were picked', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Atlanta Housing Authority' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Atlanta Housing Authority');
    await screen.findByRole('option', { name: /^Atlanta Housing Authority/ });
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Atlanta Housing Authority' });
  });

  it("a spelling only one entry carries saves that entry's name", async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Georgia Department of Community Affairs' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'DCA');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Georgia Department of Community Affairs' });
  });

  it('the Agency picker commits its typed name too', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, agency: 'Step Up' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByRole('combobox', { name: 'Agency' }), 'step up');
    await screen.findByRole('option', { name: 'Step Up' });
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('k1', { agency: 'Step Up' });
  });

  it('a spelling two entries share stops Save: nothing is sent, the picker says why and takes focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContactEditForm contact={TENANT} onClose={onClose} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'AHA');
    await screen.findByRole('option', { name: /^Augusta Housing Authority/ });
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(BLOCKED);
    expect(housingAuthority().getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(housingAuthority()).toHaveFocus();
    expect(updateContact).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the stored chip removed after typing a new name: the name stays and Save saves it in its place (R2-FE-2)', async () => {
    const user = userEvent.setup();
    const stored: Contact = { ...TENANT, housingAuthority: 'DeKalb County Housing Authority' };
    updateContact.mockResolvedValue({ ...stored, housingAuthority: 'Georgia Department of Community Affairs' });
    render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Georgia Department of Community Affairs');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await user.click(screen.getByRole('button', { name: 'Remove DeKalb County Housing Authority' }));
    expect(housingAuthority()).toHaveValue('Georgia Department of Community Affairs');
    await user.click(save());
    // Never { housingAuthority: '' }: the typed name replaces the removed one.
    expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Georgia Department of Community Affairs' });
  });

  it('(PIN) a typed name equal to the stored one is still never sent', async () => {
    const user = userEvent.setup();
    const stored: Contact = { ...TENANT, housingAuthority: 'DeKalb County Housing Authority' };
    updateContact.mockResolvedValue({ ...stored, firstName: 'TashaX' });
    render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'HADC');
    await screen.findByRole('option', { name: /^DeKalb County Housing Authority/ });
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    // housingAuthority is a provenance field: an unchanged value never rides the PATCH.
    expect(updateContact.mock.calls[0]?.[1]).toStrictEqual({ firstName: 'TashaX' });
  });
});
