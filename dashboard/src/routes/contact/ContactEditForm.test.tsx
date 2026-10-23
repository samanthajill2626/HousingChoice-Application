import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError, statusOptionsFor, type Contact, type ContactType, type OrgEntry } from '../../api/index.js';
import { MemoryRouter } from 'react-router-dom';
import { TYPE_CHANGE_LANDLORD_SENTENCE } from '../../lib/holdingRefusals.js';

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

import { CONTACT_TYPE_CHANGED_SAVE_COPY, ContactEditForm } from './ContactEditForm.js';

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
    // Spec 2026-10-23 D3: a type change moves the Status field to the new
    // type's first step (landlord Interested), and a non-tenant target's PATCH
    // carries that shown status explicitly.
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
    expect(updateContact).toHaveBeenCalledWith('k1', { type: 'landlord', status: 'interested' });
  });

  it('editing Unknown to Property Manager sends the full landlord and role pair', async () => {
    const user = userEvent.setup();
    const unknown: Contact = { ...TENANT, contactId: 'u9', type: 'unknown', status: 'needs_review' };
    updateContact.mockResolvedValue({ ...unknown, type: 'landlord', role: 'Property Manager' });
    render(<ContactEditForm contact={unknown} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Property Manager' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('u9', {
      type: 'landlord',
      role: 'Property Manager',
      status: 'interested',
    });
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
        // The type the Status list was built for (code review R1 FW1-1).
        expectedType: 'tenant',
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
        expectedType: 'tenant',
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

  it('changing type landlord to tenant shows Onboarding and saves ONE milestone - no follow-up setTenantStatus (spec 2026-10-23 D3)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const retyped = { ...LANDLORD, type: 'tenant' as const, status: 'onboarding' };
    updateContact.mockResolvedValue(retyped);
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={onSaved} />);

    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));

    // The tenant list, on the tenant's first step - never the landlord's 'active'.
    const select = screen.getByRole('combobox', { name: /^Status$/ }) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(7);
    expect(select.value).toBe('onboarding');

    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // The PATCH never carries a tenant status: the server's own auto-advance
    // writes Onboarding, which is what the field shows, so there is no second write.
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { type: 'tenant' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(retyped));
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
    // (2026-10-20, D9: the landlord's copy-only requirement defaults, pets
    // included, now live in the Requirements / Qualifications fieldset.)
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
    // A sentence of its own: a screen reader hears it apart from the note
    // that may follow it (code review R3-FE-8).
    expect(picker).toHaveAccessibleDescription('The organization that runs the voucher.');
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

  it('a list that fails to load marks no stored value "Not on the list" - nothing is known about it (R3-FE-5)', async () => {
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    const stored: Contact = { ...TENANT, housingAuthority: 'Atlanta Housing Authority', agency: 'Step Up' };
    render(<ContactEditForm contact={stored} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Couldn't load housing authorities")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load agencies")).toBeInTheDocument();
    // Both chips are shown as they are, with no claim about the list.
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Step Up' })).toBeInTheDocument();
    expect(screen.queryByText('Not on the list')).not.toBeInTheDocument();
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

  it('the note under each picker says what Save will do with its text (R2-FE-6)', async () => {
    const user = userEvent.setup();
    const agency = (): HTMLElement => screen.getByRole('combobox', { name: 'Agency' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    // Text naming one entry: Save will use it - never "Not saved".
    await user.type(housingAuthority(), 'DCA');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await user.tab();
    // Two sentences, not one run-on (code review R3-FE-8).
    expect(housingAuthority()).toHaveAccessibleDescription(
      'The organization that runs the voucher. Save will use Georgia Department of Community Affairs.',
    );
    // Text Save would refuse: not saved, and how to fix it.
    await user.type(agency(), 'Hope');
    await user.tab();
    expect(agency()).toHaveAccessibleDescription(
      'Not saved - pick a name from the list, add it as new, or clear the text.',
    );
  });

  it('(PIN) text typed in a tenant picker goes when the type changes away and back', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ContactEditForm contact={{ ...TENANT, status: 'needs_review' }} onClose={onClose} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Atlanta Housing Authority');
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(housingAuthority()).toHaveValue('');
    await user.click(save());
    // Nothing on screen asks for a change: nothing is saved.
    expect(updateContact).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it('every refused Save is announced again - the alert is a new one each time (R2-FE-10)', async () => {
    // A keyboard user pressing Enter again in the field must hear the refusal
    // again; an unchanged alert node would stay silent.
    const user = userEvent.setup();
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'AHA');
    await screen.findByRole('option', { name: /^Augusta Housing Authority/ });
    await user.click(save());
    const first = await screen.findByRole('alert');
    await user.click(save());
    const second = screen.getByRole('alert');
    expect(second).not.toBe(first);
    expect(second).toHaveTextContent(BLOCKED);
    expect(updateContact).not.toHaveBeenCalled();
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

// --- Code review R2-FE-1, R3-FE-3: Save never waits on a picker staff cannot --
// use, and never drops typed text. A re-read that fails keeps the list in
// hand: typed text settles against it as usual. A read that fails with no list
// in hand leaves a picker holding text usable - clear-only - and Save says so
// until the text is cleared. Text typed before the first read lands cannot be
// settled yet: Save says the list is still loading - not that it is unknown.
describe('ContactEditForm - a picker whose list is not there', () => {
  const BLOCKED = 'Pick a name from the list, add it as new, or clear the text.';
  const STILL_LOADING = 'Still loading the list - try again in a moment.';
  const NOT_LOADED = 'The list did not load - clear the text to save without it.';
  const housingAuthority = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authority' });
  const agency = (): HTMLElement => screen.getByRole('combobox', { name: 'Agency' });
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  /** The form's first list read, settled by the test. */
  function heldListRead(): { resolve: (value: unknown) => void; reject: (err: unknown) => void } {
    const held = { resolve: (_value: unknown): void => {}, reject: (_err: unknown): void => {} };
    getOrgList.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        held.resolve = resolve;
        held.reject = reject;
      }),
    );
    return held;
  }

  it('the read fails while text is typed: the field stays clearable and Save waits for it (R3-FE-3)', async () => {
    const user = userEvent.setup();
    const read = heldListRead();
    updateContact.mockResolvedValue({ ...TENANT, firstName: 'TashaX' });
    const onSaved = vi.fn();
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={onSaved} />);
    await user.type(housingAuthority(), 'Atlanta Housing Authority');
    await act(async () => read.reject(new ApiError(503, 'org_list_busy', 'org_list_busy')));
    expect(screen.getByText("Couldn't load housing authorities")).toBeInTheDocument();
    // Clear-only: the text stays in an enabled field, with nothing to pick or add.
    expect(housingAuthority()).toBeEnabled();
    expect(housingAuthority()).toHaveValue('Atlanta Housing Authority');
    expect(housingAuthority()).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // An empty picker is still disabled.
    expect(agency()).toBeDisabled();
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(save());
    // Never saved without the authority staff typed - and never silently.
    const refusal = await screen.findByText(NOT_LOADED);
    expect(refusal).toHaveAttribute('role', 'alert');
    expect(housingAuthority().getAttribute('aria-describedby')?.split(' ')).toContain(refusal.id);
    expect(screen.getByText("Couldn't load agencies")).toBeInTheDocument();
    expect(housingAuthority()).toHaveFocus();
    expect(updateContact).not.toHaveBeenCalled();
    // Cleared, the field is done with (disabled again) and the rest saves.
    await user.clear(housingAuthority());
    expect(housingAuthority()).toBeDisabled();
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('k1', { firstName: 'TashaX' }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('a re-read after "Yes, add it" fails: typed Agency text naming one entry is still saved (R3-FE-3)', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('housing_authority', 'Metro Housing Authority'));
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Metro Housing Authority', agency: 'Step Up' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(agency(), 'Step Up');
    await screen.findByRole('option', { name: 'Step Up' });
    // The read "Yes, add it" starts fails.
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    await user.type(housingAuthority(), 'Metro Housing Authority');
    await user.click(
      await screen.findByRole('option', { name: 'Add Metro Housing Authority as a new housing authority' }),
    );
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    const yes = within(isNew).getByRole('button', { name: 'Yes, add it' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(await screen.findByText("Couldn't load agencies")).toBeInTheDocument();
    // The list read before is still in hand: the text settles against it as usual.
    expect(agency()).toHaveAccessibleDescription(/^Save will use Step Up\./);
    await user.click(save());
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Metro Housing Authority', agency: 'Step Up' }),
    );
  });

  it('a re-read after "Yes, add it" fails while Agency holds refused text: still refused, still editable, and Save goes on once it is cleared (R3-FE-3)', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('housing_authority', 'Metro Housing Authority'));
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Metro Housing Authority' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(agency(), 'Hope');
    await screen.findByRole('option', { name: 'Add Hope as a new agency' });
    await user.click(save());
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    // The read "Yes, add it" starts fails.
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    await user.type(housingAuthority(), 'Metro Housing Authority');
    await user.click(
      await screen.findByRole('option', { name: 'Add Metro Housing Authority as a new housing authority' }),
    );
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    const yes = within(isNew).getByRole('button', { name: 'Yes, add it' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(await screen.findByText("Couldn't load housing authorities")).toBeInTheDocument();
    // The list in hand still refuses "Hope": the field says so and stays editable.
    expect(agency()).toBeEnabled();
    expect(agency()).toHaveValue('Hope');
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
    await user.click(save());
    expect(updateContact).not.toHaveBeenCalled();
    expect(agency()).toHaveFocus();
    await user.clear(agency());
    await user.click(save());
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Metro Housing Authority' }),
    );
  });

  it('a re-read after "Yes, add it" fails: a picker emptied to retype stays usable - the list is still in hand (code review R4-3)', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('housing_authority', 'Metro Housing Authority'));
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Metro Housing Authority', agency: 'Step Up' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(agency(), 'Hope');
    await screen.findByRole('option', { name: 'Add Hope as a new agency' });
    // The read "Yes, add it" starts fails.
    getOrgList.mockRejectedValue(new ApiError(503, 'org_list_busy', 'org_list_busy'));
    await user.type(housingAuthority(), 'Metro Housing Authority');
    await user.click(
      await screen.findByRole('option', { name: 'Add Metro Housing Authority as a new housing authority' }),
    );
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    const yes = within(isNew).getByRole('button', { name: 'Yes, add it' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(await screen.findByText("Couldn't load agencies")).toBeInTheDocument();
    // Staff clear "Hope" to type the name they meant: the field stays usable.
    await user.clear(agency());
    expect(agency()).toBeEnabled();
    // The Housing authority picker holds its new chip and no text: usable too.
    expect(housingAuthority()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove Metro Housing Authority' })).toBeEnabled();
    // The list in hand offers the name.
    await user.type(agency(), 'Step Up');
    await user.click(await screen.findByRole('option', { name: 'Step Up' }));
    await user.click(save());
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Metro Housing Authority', agency: 'Step Up' }),
    );
  });

  it('a refusal follows its text: once the list lands and settles the text, the alert goes (R3-FE-6)', async () => {
    const user = userEvent.setup();
    const read = heldListRead();
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'HADC');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(STILL_LOADING);
    await act(async () => read.resolve({ version: 1, entries: ORG_ENTRIES }));
    await user.tab();
    // Save will now use DeKalb: nothing refuses the text any more, so the
    // field never says both that and "still loading".
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(housingAuthority()).toHaveAccessibleDescription(
      'The organization that runs the voucher. Save will use DeKalb County Housing Authority.',
    );
  });

  it('a refusal follows its text: once the list lands and still refuses the text, the alert says why now (R3-FE-6)', async () => {
    const user = userEvent.setup();
    const read = heldListRead();
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Metro Nowhere');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(STILL_LOADING);
    await act(async () => read.resolve({ version: 1, entries: ORG_ENTRIES }));
    expect(screen.getByRole('alert')).toHaveTextContent(BLOCKED);
    expect(updateContact).not.toHaveBeenCalled();
  });

  it('Save before the list loads says it is still loading, not that the text is unknown - and works once it lands', async () => {
    const user = userEvent.setup();
    const read = heldListRead();
    updateContact.mockResolvedValue({ ...TENANT, housingAuthority: 'Atlanta Housing Authority' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(housingAuthority(), 'Atlanta Housing Authority');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(STILL_LOADING);
    expect(screen.queryByText(BLOCKED)).not.toBeInTheDocument();
    expect(updateContact).not.toHaveBeenCalled();
    await act(async () => read.resolve({ version: 1, entries: ORG_ENTRIES }));
    await user.click(save());
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('k1', { housingAuthority: 'Atlanta Housing Authority' }),
    );
  });
});

describe('ContactEditForm - caseworkers and the partner organization (spec 2026-10-06 D16, D17)', () => {
  const PARTNER: Contact = {
    contactId: 'p1',
    type: 'partner',
    status: 'active',
    firstName: 'Renee',
    lastName: 'Carter',
    phone: '+14045550123',
  };
  const CASEWORKER: Contact = { ...PARTNER, contactId: 'cw1', role: 'Caseworker', organization: 'Hope Atlanta' };
  const organization = (): HTMLElement => screen.getByRole('combobox', { name: 'Organization' });
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [...ORG_ENTRIES, orgEntry('agency', 'Hope Atlanta')] });
  });

  it('offers Caseworker in Change type only when the STORED contact is a caseworker (R4-15)', async () => {
    const user = userEvent.setup();
    for (const plain of [PARTNER, TENANT, LANDLORD]) {
      const { unmount } = render(<ContactEditForm contact={plain} onClose={vi.fn()} onSaved={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: /Change type/i }));
      expect(screen.queryByRole('button', { name: 'Caseworker' })).toBeNull();
      unmount();
    }
    render(<ContactEditForm contact={CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Caseworker - Partner')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    expect(screen.getByRole('button', { name: 'Caseworker' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a 409 caseworker_use_conversion points to the conversion, not a retry (R4-11)', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      new ApiError(409, 'caseworker_use_conversion', 'caseworker_use_conversion', {
        error: 'caseworker_use_conversion',
      }),
    );
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('To make this contact a caseworker, use More actions > Make caseworker.');
    expect(alert.textContent ?? '').not.toContain('caseworker_use_conversion');
  });

  it('a partner gets one Organization picker over both lists; a tenant does not', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Organization' })).toBeNull();
    unmount();
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Housing authority' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Agency' })).toBeNull();
    await user.type(organization(), 'atl');
    expect(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ })).toBeInTheDocument();
    await user.clear(organization());
    await user.type(organization(), 'step');
    expect(await screen.findByRole('option', { name: /^Step Up/ })).toBeInTheDocument();
  });

  it('a pick goes to organization by FIELD - a housing authority name never lands in housingAuthority (R2-F8)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...PARTNER, organization: 'Atlanta Housing Authority' });
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'atl');
    await user.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('p1', { organization: 'Atlanta Housing Authority' });
  });

  it('removing the chip clears organization as an empty string', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...CASEWORKER, organization: undefined });
    render(<ContactEditForm contact={CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove Hope Atlanta' }));
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('cw1', { organization: '' });
  });

  it('an untouched organization never reaches the wire, even when it is not on the list', async () => {
    const user = userEvent.setup();
    const carried: Contact = { ...CASEWORKER, organization: 'Hope Atlanta Inc' };
    updateContact.mockResolvedValue({ ...carried, firstName: 'ReneeX' });
    render(<ContactEditForm contact={carried} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('Not on the list')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/First name/i), 'X');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    expect(updateContact.mock.calls[0]?.[1]).toStrictEqual({ firstName: 'ReneeX' });
  });

  it('typed text naming one entry is saved as a pick would be; other text stops Save', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...PARTNER, organization: 'Step Up' });
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'Nowhere Partners');
    await user.click(save());
    expect(updateContact).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pick a name from the list, add it as new, or clear the text.',
    );
    await user.clear(organization());
    await user.type(organization(), 'Step Up');
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('p1', { organization: 'Step Up' });
  });

  it('"Add <text> as a new organization" opens the organization-mode dialog outside the form; the added name fills the field', async () => {
    const user = userEvent.setup();
    addOrg.mockResolvedValue(orgEntry('agency', 'Metro Partners'));
    updateContact.mockResolvedValue({ ...PARTNER, organization: 'Metro Partners' });
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'Metro Partners');
    await user.click(await screen.findByRole('option', { name: 'Add Metro Partners as a new organization' }));
    const dialog = screen.getByRole('dialog', { name: 'Is this really new?' });
    expect(dialog.closest('form')).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Agency' }));
    const yes = within(dialog).getByRole('button', { name: 'Yes, add it' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(addOrg).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agency', name: 'Metro Partners' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Is this really new?' })).not.toBeInTheDocument(),
    );
    // Written to organization, NOT to agency, although the entry is an agency.
    expect(updateContact).not.toHaveBeenCalled();
    await user.click(save());
    expect(updateContact).toHaveBeenCalledWith('p1', { organization: 'Metro Partners' });
  });

  it('a refused save (422 org_not_on_list) on organization shows under its picker', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'organization',
        text: 'Step Up',
        candidates: [],
        close: [],
      }),
    );
    render(<ContactEditForm contact={PARTNER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(organization(), 'step');
    await user.click(await screen.findByRole('option', { name: /^Step Up/ }));
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Step Up is not on the list/);
    // Changing the field clears it.
    await user.click(screen.getByRole('button', { name: 'Remove Step Up' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ContactEditForm - a refused type change (spec 2026-10-12 D2)', () => {
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  function typeChangeRefused(refusals: unknown[]): ApiError {
    return new ApiError(409, 'type_change_refused', 'type_change_refused', {
      error: 'type_change_refused',
      refusals,
    });
  }

  function renderForm(contact: Contact): {
    onSaved: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
  } {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ContactEditForm contact={contact} onClose={onClose} onSaved={onSaved} />
      </MemoryRouter>,
    );
    return { onSaved, onClose };
  }

  it('keeps the draft and shows each refusal with its View link beside the kind picker', async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(
      typeChangeRefused([
        { code: 'open_placement', placementId: 'p 7' },
        { code: 'open_tour', tourId: 't1' },
      ]),
    );
    const { onSaved, onClose } = renderForm({ ...TENANT, status: 'needs_review' });
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Tash');
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    await user.click(save());

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(alert).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(alert).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    // Beside the kind picker: inside the Type block that holds the picker.
    const picker = screen.getByRole('group', { name: 'Contact kind' });
    expect(picker.parentElement?.parentElement).toContainElement(alert);
    // The draft is kept: still open, on the picked kind, with the edited name.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Landlord' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/First name/i)).toHaveValue('Tash');
    expect(save()).toBeEnabled();
    // Never the raw code, never the generic retry line.
    expect(screen.queryByText("Couldn't save - please try again.")).toBeNull();
    expect(alert.textContent ?? '').not.toContain('type_change_refused');
  });

  it("a landlord of record gets the type change's own sentence, not the conversion's", async () => {
    const user = userEvent.setup();
    updateContact.mockRejectedValue(typeChangeRefused([{ code: 'landlord_of_record', unitId: 'u1' }]));
    renderForm(LANDLORD);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'View property' })).toHaveAttribute('href', '/listings/u1');
    expect(
      screen.queryByText("This contact is the landlord of record for a property. Change that property's landlord first."),
    ).toBeNull();
  });

  // R1 code review, dashboard finding 7: every save starts clean - a second
  // save that fails for another reason shows the save sentence, never the
  // first save's refusal list beside it.
  it("a second save that fails for another reason no longer shows the first save's refusals", async () => {
    const user = userEvent.setup();
    updateContact
      .mockRejectedValueOnce(typeChangeRefused([{ code: 'landlord_of_record', unitId: 'u1' }]))
      .mockRejectedValueOnce(new ApiError(500, 'http_500', 'Request failed (500)'));
    const { onSaved } = renderForm(LANDLORD);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    await user.click(save());
    expect(await screen.findByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();

    // Save again with the kind untouched (picking a kind clears the list on
    // its own), and fail for another reason.
    await user.click(save());
    expect(await screen.findByText("Couldn't save - please try again.")).toBeInTheDocument();
    expect(screen.queryByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeNull();
    expect(updateContact).toHaveBeenCalledTimes(2);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('picking another kind clears the refusals, and the next save asks the server again', async () => {
    const user = userEvent.setup();
    updateContact
      .mockRejectedValueOnce(typeChangeRefused([{ code: 'landlord_of_record', unitId: 'u1' }]))
      .mockResolvedValueOnce({ ...LANDLORD, role: 'Property Manager' });
    const { onSaved } = renderForm(LANDLORD);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    await user.click(save());
    expect(await screen.findByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Property Manager' }));
    expect(screen.queryByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeNull();
    await user.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateContact).toHaveBeenLastCalledWith('L1', { role: 'Property Manager' });
  });
});

// Property requirements D9: the landlord's Requirements / Qualifications
// fieldset - the shared RequirementsFields with the landlord tags, sending
// only the req_ keys that changed.
describe('ContactEditForm - landlord Requirements / Qualifications', () => {
  const WITH_REQUIREMENTS: Contact = {
    ...LANDLORD,
    req_no_pets: true,
    req_pet_fee: '$300',
    req_deposit: 1400,
    req_tour_type: 'self_guided',
  };
  const fieldset = (): HTMLElement => screen.getByRole('group', { name: 'Requirements / Qualifications' });

  it('shows the fieldset for a landlord, with the landlord tags and legend, filled from the req_ keys', () => {
    render(<ContactEditForm contact={WITH_REQUIREMENTS} onClose={vi.fn()} onSaved={vi.fn()} />);
    const group = fieldset();
    expect(within(group).getAllByText('On property flyers').length).toBeGreaterThan(0);
    expect(within(group).getAllByText('Staff only').length).toBeGreaterThan(0);
    expect(group).toHaveTextContent(/tenants see it once it is copied to a property/);
    // Tags stay out of the accessible names: exact names still resolve.
    expect(within(group).getByRole('checkbox', { name: 'No pets' })).toBeChecked();
    expect(within(group).getByLabelText('Pet fee')).toHaveDisplayValue('$300');
    expect(within(group).getByLabelText('Fixed amount')).toHaveDisplayValue('1400');
    expect(within(group).getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided');
    expect(within(group).getByRole('checkbox', { name: 'No evictions while on the program' })).not.toBeChecked();
  });

  it('Pets and Deposit read Staff only; On property flyers is only on the application-fee pair (flyer-leads D2)', () => {
    render(<ContactEditForm contact={WITH_REQUIREMENTS} onClose={vi.fn()} onSaved={vi.fn()} />);
    const group = fieldset();
    for (const label of ['Pets (details)', 'Pet fee', 'Fixed amount', 'Deposit notes']) {
      expect(within(group).getByLabelText(label), label).toHaveAccessibleDescription('Staff only');
    }
    for (const name of ['No pets', "One month's rent", 'Flexible / payment terms available']) {
      expect(within(group).getByRole('checkbox', { name }), name).toHaveAccessibleDescription('Staff only');
    }
    expect(within(group).getByRole('checkbox', { name: 'No application fee' })).toHaveAccessibleDescription(
      'On property flyers',
    );
    expect(within(group).getByLabelText('Application fee')).toHaveAccessibleDescription('On property flyers');
    // Exactly that pair: the legend line starts "On property flyers - ..."
    // and so is not an exact match - only the two TAGS are.
    expect(within(group).getAllByText('On property flyers')).toHaveLength(2);
    // The landlord legend is unchanged (spec D2).
    expect(group).toHaveTextContent(/tenants see it once it is copied to a property/);
  });

  it('never shows the fieldset for a tenant', () => {
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Requirements / Qualifications' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'No pets' })).toBeNull();
  });

  it('sends only the req_ key that changed', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...WITH_REQUIREMENTS });
    render(<ContactEditForm contact={WITH_REQUIREMENTS} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(within(fieldset()).getByRole('checkbox', { name: 'No evictions while on the program' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('L1', { req_no_evictions_on_program: true }),
    );
  });

  it('a typed pet fee rides the PATCH as req_pet_fee', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD });
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(within(fieldset()).getByLabelText('Pet fee'), '$300');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { req_pet_fee: '$300' }));
  });

  it('unchecking a requirement checkbox sends just that key as null (not a rule, D1)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...WITH_REQUIREMENTS });
    render(<ContactEditForm contact={WITH_REQUIREMENTS} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(within(fieldset()).getByRole('checkbox', { name: 'No pets' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { req_no_pets: null }));
  });

  it.each<[string, Contact]>([
    ['holds a fixed amount', { ...LANDLORD, req_deposit: 1400 }],
    ['holds no amount', LANDLORD],
  ])("checking One month's rent sends req_deposit null in the same save when the landlord %s (D1)", async (_label, contact) => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...contact });
    render(<ContactEditForm contact={contact} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(within(fieldset()).getByRole('checkbox', { name: "One month's rent" }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('L1', { req_deposit_one_month: true, req_deposit: null }),
    );
  });

  // Code review R2D-5: "No application fee" is its own flag - deleting the 4
  // of a stored 40 leaves an editable 0, and Save sends req_application_fee 0
  // (never the form-only flag).
  it('deleting the 4 of a stored 40 fee keeps the box editable and unticked; Save sends req_application_fee 0', async () => {
    const user = userEvent.setup();
    const contact: Contact = { ...LANDLORD, req_application_fee: 40 };
    updateContact.mockResolvedValue({ ...contact });
    render(<ContactEditForm contact={contact} onClose={vi.fn()} onSaved={vi.fn()} />);
    const fee = within(fieldset()).getByLabelText('Application fee');
    await user.click(fee);
    await user.keyboard('{Home}{Delete}');
    expect(fee).toBeEnabled();
    expect(within(fieldset()).getByRole('checkbox', { name: 'No application fee' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { req_application_fee: 0 }));
  });

  it('an untouched fieldset sends no req_ key', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...WITH_REQUIREMENTS });
    render(<ContactEditForm contact={WITH_REQUIREMENTS} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Park reason$/i), 'Declined');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { park_reason: 'Declined' }));
  });

  it('a 400 deposit_conflict says why, keeps the form open with what staff typed, and is not the generic error (AR32)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    updateContact.mockRejectedValue(
      new ApiError(400, 'deposit_conflict', 'deposit_conflict', { error: 'deposit_conflict' }),
    );
    render(<ContactEditForm contact={LANDLORD} onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(within(fieldset()).getByLabelText('Fixed amount'), { target: { value: '1400' } });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "A deposit can be one month's rent or a fixed amount, not both. Reload the landlord and try again.",
    );
    expect(updateContact).toHaveBeenCalledWith('L1', { req_deposit: 1400 });
    expect(screen.queryByText("Couldn't save - please try again.")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(fieldset()).getByLabelText('Fixed amount')).toHaveDisplayValue('1400');
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('a landlord retyped to a tenant sends no req_ key, even after a requirement was edited', async () => {
    const user = userEvent.setup();
    setTenantStatus.mockResolvedValue({ ...LANDLORD, type: 'tenant', status: 'needs_review' });
    updateContact.mockResolvedValue({ ...LANDLORD, type: 'tenant' });
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(within(fieldset()).getByRole('checkbox', { name: 'No pets' }));
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(updateContact).toHaveBeenCalled());
    const patch = updateContact.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch['type']).toBe('tenant');
    expect(Object.keys(patch).filter((k) => k.startsWith('req_'))).toEqual([]);
  });
});

// Spec 2026-10-23 D1/D3: the Status field offers exactly the header's list for
// every type, shows an Inactive caseworker as Inactive, writes a partner /
// team member / unknown status change the way the header does, and follows
// the type-change rules (measured against the STORED type).
describe('ContactEditForm - one status list per type and the type-change rules (spec 2026-10-23 D1, D3)', () => {
  const INACTIVE_CASEWORKER: Contact = {
    contactId: 'p1',
    type: 'partner',
    role: 'Caseworker',
    status: 'inactive',
    firstName: 'Renee',
    lastName: 'Carter',
    phone: '+14045550123',
  };
  const INACTIVE_PARTNER: Contact = {
    contactId: 'p2',
    type: 'partner',
    status: 'inactive',
    firstName: 'Pat',
    lastName: 'Moss',
    phone: '+14045550125',
  };
  const TEAM_MEMBER: Contact = {
    contactId: 'tm1',
    type: 'team_member',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Lee',
    phone: '+14045550124',
  };
  const UNKNOWN_REVIEW: Contact = { contactId: 'u9', type: 'unknown', status: 'needs_review', phone: '+15550100001' };
  const UNKNOWN_INACTIVE: Contact = { ...UNKNOWN_REVIEW, status: 'inactive' };

  // EXACT 'Status' name: a landlord's dialog also has "Contract status".
  const statusSelect = (): HTMLSelectElement => screen.getByRole('combobox', { name: /^Status$/ }) as HTMLSelectElement;
  const optionPairs = (): Array<[string, string]> =>
    within(statusSelect())
      .getAllByRole('option')
      .map((o) => [(o as HTMLOptionElement).value, o.textContent ?? '']);
  const save = (): HTMLElement => screen.getByRole('button', { name: /^Save$/i });

  const D1: Array<[ContactType, Array<[string, string]>]> = [
    [
      'tenant',
      [
        ['needs_review', 'Needs review'],
        ['onboarding', 'Onboarding'],
        ['searching', 'Searching'],
        ['placing', 'Placing'],
        ['placed', 'Placed'],
        ['on_hold', 'On hold'],
        ['inactive', 'Inactive'],
      ],
    ],
    [
      'landlord',
      [
        ['needs_review', 'Needs review'],
        ['interested', 'Interested'],
        ['onboarding', 'Onboarding'],
        ['active', 'Active'],
        ['parked', 'Parked'],
      ],
    ],
    ['partner', [['needs_review', 'Needs review'], ['active', 'Active'], ['inactive', 'Inactive']]],
    ['team_member', [['needs_review', 'Needs review'], ['active', 'Active'], ['inactive', 'Inactive']]],
    ['unknown', [['needs_review', 'Needs review'], ['inactive', 'Inactive']]],
  ];

  it.each(D1)('a %s offers exactly its D1 list - the same list the header dropdown offers', (type, pairs) => {
    render(
      <ContactEditForm
        contact={{ contactId: 'c1', type, status: 'needs_review', phone: '+14045550100' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(optionPairs()).toEqual(pairs);
    expect(optionPairs()).toEqual(statusOptionsFor(type).map((o) => [o.value, o.label]));
  });

  it('a legacy (unknown, active) contact shows Needs review - Active is not an unknown status', () => {
    render(<ContactEditForm contact={{ ...UNKNOWN_REVIEW, status: 'active' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(statusSelect().value).toBe('needs_review');
    expect(optionPairs().map(([value]) => value)).not.toContain('active');
  });

  it('DISPLAYS an Inactive caseworker as Inactive', () => {
    render(<ContactEditForm contact={INACTIVE_CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(statusSelect().value).toBe('inactive');
    expect(within(statusSelect()).getByRole('option', { name: 'Inactive' })).toHaveProperty('selected', true);
  });

  it('an Inactive caseworker stays Inactive across an unrelated-field save: no status write', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...INACTIVE_CASEWORKER, firstName: 'Rene' });
    render(<ContactEditForm contact={INACTIVE_CASEWORKER} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Rene');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('p1', { firstName: 'Rene' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['a caseworker', INACTIVE_CASEWORKER, 'active'],
    ['a team member', TEAM_MEMBER, 'inactive'],
    ['an unknown contact', UNKNOWN_REVIEW, 'inactive'],
  ] as const)(
    'with no type change, %s status change goes through the transition service, as the header does',
    async (_label, contact, toStatus) => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const updated = { ...contact, status: toStatus };
      setTenantStatus.mockResolvedValue(updated);
      render(<ContactEditForm contact={contact} onClose={vi.fn()} onSaved={onSaved} />);
      await user.selectOptions(statusSelect(), toStatus);
      await user.click(save());
      await waitFor(() =>
        expect(setTenantStatus).toHaveBeenCalledWith(contact.contactId, {
          toStatus,
          source: 'manual',
          expectedType: contact.type,
        }),
      );
      // Never the plain PATCH (no other field changed, so no PATCH at all).
      expect(updateContact).not.toHaveBeenCalled();
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    },
  );

  it('a type change from an Inactive partner to tenant shows Onboarding and writes it once', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const retyped = { ...INACTIVE_PARTNER, type: 'tenant' as const, status: 'onboarding' };
    updateContact.mockResolvedValue(retyped);
    render(<ContactEditForm contact={INACTIVE_PARTNER} onClose={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('p2', { type: 'tenant' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(retyped));
  });

  it('a type change to tenant with another status picked: the PATCH, then ONE setTenantStatus with that status', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    updateContact.mockResolvedValue({ ...UNKNOWN_INACTIVE, type: 'tenant', status: 'onboarding' });
    const searching = { ...UNKNOWN_INACTIVE, type: 'tenant' as const, status: 'searching' };
    setTenantStatus.mockResolvedValue(searching);
    render(<ContactEditForm contact={UNKNOWN_INACTIVE} onClose={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.selectOptions(statusSelect(), 'searching');
    await user.click(save());
    // The follow-up names the type the field was derived for: the NEW one.
    await waitFor(() =>
      expect(setTenantStatus).toHaveBeenCalledWith('u9', {
        toStatus: 'searching',
        source: 'manual',
        expectedType: 'tenant',
        porting: false,
      }),
    );
    expect(updateContact).toHaveBeenCalledWith('u9', { type: 'tenant' });
    expect(setTenantStatus).toHaveBeenCalledTimes(1);
    expect(updateContact.mock.invocationCallOrder[0]!).toBeLessThan(setTenantStatus.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(searching));
  });

  it('a type change from an Inactive unknown contact to partner shows Active and the PATCH carries it', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...UNKNOWN_INACTIVE, type: 'partner', status: 'active' });
    render(<ContactEditForm contact={UNKNOWN_INACTIVE} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Partner' }));
    expect(statusSelect().value).toBe('active');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('u9', { type: 'partner', status: 'active' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('on a type change staff may pick another status first: the PATCH carries the shown one', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...UNKNOWN_INACTIVE, type: 'landlord', status: 'parked' });
    render(<ContactEditForm contact={UNKNOWN_INACTIVE} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    expect(statusSelect().value).toBe('interested');
    await user.selectOptions(statusSelect(), 'parked');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('u9', { type: 'landlord', status: 'parked' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('(PIN) a role-only switch (Landlord to the Property Manager preset) keeps the stored status and writes none', async () => {
    const user = userEvent.setup();
    const onboarding: Contact = { ...LANDLORD, status: 'onboarding' };
    updateContact.mockResolvedValue({ ...onboarding, role: 'Property Manager' });
    render(<ContactEditForm contact={onboarding} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Property Manager' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { role: 'Property Manager' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('a change-and-back (tenant to landlord to tenant) is not a type change: the stored status shows and none is written', async () => {
    const user = userEvent.setup();
    const searching: Contact = { ...TENANT, status: 'searching' };
    updateContact.mockResolvedValue({ ...searching, firstName: 'Tash' });
    render(<ContactEditForm contact={searching} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    expect(statusSelect().value).toBe('interested');
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('searching');
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Tash');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('k1', { firstName: 'Tash' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  // Plan round 1 P1: the KindPicker's Other panel passes through type null on
  // the way to a base; the field must still come back to the stored status.
  it('a change-and-back through Other (tenant to landlord to Other to tenant) shows the stored status and writes none', async () => {
    const user = userEvent.setup();
    const searching: Contact = { ...TENANT, status: 'searching' };
    updateContact.mockResolvedValue({ ...searching, firstName: 'Tash' });
    render(<ContactEditForm contact={searching} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Landlord' }));
    expect(statusSelect().value).toBe('interested');
    await user.click(screen.getByRole('button', { name: 'Other' }));
    await user.click(screen.getByRole('radio', { name: /Tenant/i }));
    expect(statusSelect().value).toBe('searching');
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Tash');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('k1', { firstName: 'Tash' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('a Parked landlord through Tenant and Other back to Landlord stays Parked and writes no status', async () => {
    const user = userEvent.setup();
    const parked: Contact = { ...LANDLORD, status: 'parked', park_reason: 'Declined the program' };
    updateContact.mockResolvedValue({ ...parked, firstName: 'Jim' });
    render(<ContactEditForm contact={parked} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Change type/i }));
    await user.click(screen.getByRole('button', { name: 'Tenant' }));
    expect(statusSelect().value).toBe('onboarding');
    await user.click(screen.getByRole('button', { name: 'Other' }));
    await user.click(screen.getByRole('radio', { name: /Landlord/i }));
    expect(statusSelect().value).toBe('parked');
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Jim');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { firstName: 'Jim' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  // Plan round 2 R2P-1: the page re-reads the open contact on contact.updated
  // (S2.9) and passes the new one in; the form must diff against the contact
  // as OPENED, or a save writes another operator's change back.
  it('a contact prop changed under the open form is never written back: the PATCH carries only the edited field', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    updateContact.mockResolvedValue({ ...TEAM_MEMBER, firstName: 'Samuel' });
    const { rerender } = render(<ContactEditForm contact={TEAM_MEMBER} onClose={onClose} onSaved={onSaved} />);
    // Another operator re-types the contact, marks it Inactive and edits its
    // last name; the live re-read hands the form the new contact.
    rerender(
      <ContactEditForm
        contact={{ ...TEAM_MEMBER, type: 'partner', status: 'inactive', lastName: 'Leigh' }}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Samuel');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('tm1', { firstName: 'Samuel' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  // Code review R1 FW1-1 (ADV-1): the form's Status list is the OPENED type's
  // for as long as it stays open, so its status write names that type and the
  // route 409s it when a colleague re-typed the contact meanwhile - never a
  // status from the old list written onto the new type.
  it('the form re-rendered with a re-typed contact still names the OPENED type on its status write', async () => {
    const user = userEvent.setup();
    setTenantStatus.mockResolvedValue({ ...UNKNOWN_REVIEW, status: 'inactive' });
    const { rerender } = render(<ContactEditForm contact={UNKNOWN_REVIEW} onClose={vi.fn()} onSaved={vi.fn()} />);
    // A colleague's "Mark as Tenant" landed; the page's live re-read hands
    // the open form the tenant. Its Status list stays the unknown list.
    rerender(
      <ContactEditForm
        contact={{ ...UNKNOWN_REVIEW, type: 'tenant', status: 'onboarding' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(optionPairs().map(([value]) => value)).toEqual(['needs_review', 'inactive']);
    await user.selectOptions(statusSelect(), 'inactive');
    await user.click(save());
    await waitFor(() =>
      expect(setTenantStatus).toHaveBeenCalledWith('u9', {
        toStatus: 'inactive',
        source: 'manual',
        expectedType: 'unknown',
      }),
    );
    expect(updateContact).not.toHaveBeenCalled();
  });

  it.each([
    ['with a field edit (the field PATCH lands first)', true],
    ['with the status alone (no field PATCH)', false],
  ] as const)(
    'a 409 contact_type_changed on the status write, %s: says so, never the generic error, and keeps the form open on its draft',
    async (_label, editName) => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onSaved = vi.fn();
      updateContact.mockResolvedValue({ ...TEAM_MEMBER, type: 'partner', firstName: 'Samuel' });
      setTenantStatus.mockRejectedValue(
        new ApiError(409, 'contact_type_changed', 'contact_type_changed', { error: 'contact_type_changed' }),
      );
      render(<ContactEditForm contact={TEAM_MEMBER} onClose={onClose} onSaved={onSaved} />);
      if (editName) {
        await user.clear(screen.getByLabelText(/First name/i));
        await user.type(screen.getByLabelText(/First name/i), 'Samuel');
      }
      await user.selectOptions(statusSelect(), 'inactive');
      await user.click(save());

      expect(await screen.findByRole('alert')).toHaveTextContent(CONTACT_TYPE_CHANGED_SAVE_COPY);
      expect(setTenantStatus).toHaveBeenCalledWith('tm1', {
        toStatus: 'inactive',
        source: 'manual',
        expectedType: 'team_member',
      });
      expect(updateContact).toHaveBeenCalledTimes(editName ? 1 : 0);
      expect(screen.queryByText("Couldn't save - please try again.")).toBeNull();
      // The draft stays, as for every other save error.
      expect(onSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/First name/i)).toHaveValue(editName ? 'Samuel' : 'Sam');
      expect(statusSelect().value).toBe('inactive');
      expect(save()).toBeEnabled();
    },
  );

  it('(PIN) a Parked landlord keeps its park reason across an unrelated-field save', async () => {
    const user = userEvent.setup();
    const parked: Contact = { ...LANDLORD, status: 'parked', park_reason: 'Declined the program' };
    updateContact.mockResolvedValue({ ...parked, firstName: 'Jim' });
    render(<ContactEditForm contact={parked} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(statusSelect().value).toBe('parked');
    await user.clear(screen.getByLabelText(/First name/i));
    await user.type(screen.getByLabelText(/First name/i), 'Jim');
    await user.click(save());
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith('L1', { firstName: 'Jim' }));
    expect(setTenantStatus).not.toHaveBeenCalled();
  });

  it('(PIN) a landlord moved to Parked saves status and park reason in ONE PATCH - never the transition (it would overwrite park_reason)', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...LANDLORD, status: 'parked', park_reason: 'Not a fit' });
    render(<ContactEditForm contact={{ ...LANDLORD, status: 'interested' }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.selectOptions(statusSelect(), 'parked');
    await user.type(screen.getByLabelText(/^Park reason$/i), 'Not a fit');
    await user.click(save());
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('L1', { status: 'parked', park_reason: 'Not a fit' }),
    );
    expect(setTenantStatus).not.toHaveBeenCalled();
  });
});
