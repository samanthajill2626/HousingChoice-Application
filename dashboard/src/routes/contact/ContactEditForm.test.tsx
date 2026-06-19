import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Contact } from '../../api/index.js';

const updateContact = vi.fn();
const setTenantStatus = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    updateContact: (...a: unknown[]) => updateContact(...a),
    setTenantStatus: (...a: unknown[]) => setTenantStatus(...a),
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

  it('editing the Role input → PATCH includes {role} and unchanged sections are NOT in the patch', async () => {
    const user = userEvent.setup();
    updateContact.mockResolvedValue({ ...TENANT, role: 'Case worker' });
    render(<ContactEditForm contact={TENANT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Role$/i), 'Case worker');
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

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'landlord');

    // Fields swap immediately on the type change (no save needed).
    expect(screen.queryByLabelText(/Voucher size/i)).toBeNull();
    expect(screen.getByLabelText(/^Company$/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(updateContact).toHaveBeenCalledWith('k1', { type: 'landlord' });
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

    // A landlord → the coarse needs_review|active lifecycle (2 options).
    render(<ContactEditForm contact={LANDLORD} onClose={vi.fn()} onSaved={vi.fn()} />);
    const landlordSelect = screen.getAllByRole('combobox', { name: /Status/i }).at(-1)!;
    expect(within(landlordSelect).getAllByRole('option')).toHaveLength(2);
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
    await user.selectOptions(screen.getByRole('combobox', { name: /Status/i }), 'active');
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

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'tenant');

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
});
