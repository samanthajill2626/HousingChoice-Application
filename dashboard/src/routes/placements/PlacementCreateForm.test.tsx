import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, PlacementItem, UnitItem } from '../../api/index.js';

// Mock the api barrel: spread the real module, override only the four functions
// the form calls. Each delegates to a vi.fn() so per-test mockResolvedValue works.
const createPlacement = vi.fn();
const getPlacementsBy = vi.fn();
const getContacts = vi.fn();
const getUnits = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    createPlacement: (...a: unknown[]) => createPlacement(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
  };
});

// Import AFTER mocking.
import { PlacementCreateForm } from './PlacementCreateForm.js';

const TENANTS: Contact[] = [
  { contactId: 'contact-tenant-0001', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen' },
  { contactId: 'contact-tenant-0002', type: 'tenant', firstName: 'Omar', lastName: 'Diaz' },
];

const UNITS: UnitItem[] = [
  {
    unitId: 'unit-0001',
    landlordId: 'contact-landlord-0001',
    status: 'under_application',
    address: { line1: '1450 Joseph E. Boone Blvd NW', city: 'Atlanta', state: 'GA' },
  },
  {
    unitId: 'unit-0002',
    landlordId: 'contact-landlord-0001',
    status: 'occupied',
    address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA' },
  },
];

function newPlacement(over: Partial<PlacementItem> = {}): PlacementItem {
  return {
    placementId: 'placement-new',
    tenantId: 'contact-tenant-0001',
    unitId: 'unit-0002',
    stage: 'send_application',
    ...over,
  };
}

function setup(props?: Partial<Parameters<typeof PlacementCreateForm>[0]>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <PlacementCreateForm onClose={onClose} onCreated={onCreated} {...props} />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults; individual tests override.
  getContacts.mockResolvedValue({ contacts: TENANTS, nextCursor: null });
  getUnits.mockResolvedValue({ units: UNITS, nextCursor: null });
  getPlacementsBy.mockResolvedValue([]);
});

/** Pick a tenant via the typeahead (type a query, click the matching option). */
async function pickTenant(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(screen.getByRole('combobox', { name: 'Tenant' }), query);
  await user.click(await screen.findByRole('option', { name }));
}

/** Pick a unit via the typeahead (type a query, click the matching option). */
async function pickUnit(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(screen.getByRole('combobox', { name: 'Unit' }), query);
  await user.click(await screen.findByRole('option', { name }));
}

describe('PlacementCreateForm', () => {
  // ── 1: renders dialog + the four fields ──
  it('renders the dialog with Tenant, Unit, Starting stage, and Label fields', async () => {
    setup();
    // findBy flushes the mount fetches so their state updates land inside act().
    expect(await screen.findByRole('dialog', { name: 'New placement' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Unit' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Starting stage' })).toBeInTheDocument();
    expect(screen.getByLabelText('Label')).toBeInTheDocument();
  });

  // ── 2: stage defaults to send_application; offers ONLY non-terminal stages ──
  it('stage select defaults to Send application and offers only non-terminal stages', async () => {
    setup();
    const select = screen.getByRole('combobox', { name: 'Starting stage' });
    expect(select).toHaveValue('send_application');
    // A mid-ladder option is present…
    expect(screen.getByRole('option', { name: 'Awaiting inspection' })).toBeInTheDocument();
    // …but neither terminal stage is offered.
    expect(screen.queryByRole('option', { name: 'Moved in' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Lost' })).toBeNull();
    // Let the mount fetches settle so their state updates land inside act().
    await waitFor(() => expect(getContacts).toHaveBeenCalled());
  });

  // ── 3: tenant picker selects ──
  it('tenant picker: typing + clicking an option selects that tenant', async () => {
    const user = userEvent.setup();
    setup();
    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    expect(screen.getByRole('combobox', { name: 'Tenant' })).toHaveValue('Tasha Nguyen');
  });

  // ── 4: unit picker selects ──
  it('unit picker: typing + clicking an option (address) selects that unit', async () => {
    const user = userEvent.setup();
    setup();
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    // The picked value is the unit's full formatted address.
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue(
      '88 Sycamore St, Decatur, GA',
    );
  });

  // ── 5: submit disabled until BOTH chosen ──
  it('Create is disabled until both a tenant and a unit are chosen', async () => {
    const user = userEvent.setup();
    setup();
    const create = () => screen.getByRole('button', { name: /^Create$/ });
    expect(create()).toBeDisabled();
    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    expect(create()).toBeDisabled(); // tenant only — still disabled
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    expect(create()).toBeEnabled(); // both chosen
  });

  // ── 6a: submit calls createPlacement with the exact body (WITH placement_tag) ──
  it('submit calls createPlacement with the exact body including placement_tag', async () => {
    const user = userEvent.setup();
    createPlacement.mockResolvedValue(newPlacement());
    setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.type(screen.getByLabelText('Label'), '  Priority deal  ');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() =>
      expect(createPlacement).toHaveBeenCalledWith({
        tenantId: 'contact-tenant-0001',
        unitId: 'unit-0002',
        stage: 'send_application',
        placement_tag: 'Priority deal',
      }),
    );
  });

  // ── 6b: submit omits placement_tag when the Label is blank ──
  it('submit omits placement_tag when the Label is left blank', async () => {
    const user = userEvent.setup();
    createPlacement.mockResolvedValue(newPlacement());
    setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createPlacement).toHaveBeenCalled());
    const body = createPlacement.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      tenantId: 'contact-tenant-0001',
      unitId: 'unit-0002',
      stage: 'send_application',
    });
    expect('placement_tag' in body).toBe(false);
  });

  // ── 7a: overlap warning shows when an ACTIVE placement exists ──
  it('shows a non-blocking overlap notice (role=status) with a link when an active placement exists', async () => {
    const user = userEvent.setup();
    // The chosen tenant already has an active placement on unit-0001.
    getPlacementsBy.mockImplementation((params: { tenantId?: string; unitId?: string }) => {
      if (params.tenantId !== undefined) {
        return Promise.resolve([
          newPlacement({
            placementId: 'placement-0001',
            tenantId: 'contact-tenant-0001',
            unitId: 'unit-0001',
            stage: 'awaiting_inspection',
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/already has an active placement/i);
    expect(notice).toHaveTextContent(/Awaiting inspection/);
    expect(notice).toHaveTextContent(/1450 Joseph E\. Boone Blvd/); // the OTHER party (unit address)
    const link = screen.getByRole('link', { name: /Open it/i });
    expect(link).toHaveAttribute('href', '/placements/placement-0001');

    // Non-blocking: with a unit also chosen, Create is still enabled.
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled();
  });

  // ── 7b: NO notice when there are no active placements (empty / only terminal) ──
  it('shows no overlap notice when there are no active placements (empty or terminal-only)', async () => {
    const user = userEvent.setup();
    // Only a terminal (lost) row → no active overlap.
    getPlacementsBy.mockResolvedValue([
      newPlacement({ placementId: 'placement-old', stage: 'lost' }),
    ]);
    setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    // Give any async lookup a chance to resolve, then assert no status notice.
    await waitFor(() => expect(getPlacementsBy).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  // ── 8: on 201 calls onCreated with the returned placement ──
  it('on a successful create (201), calls onCreated with the returned placement', async () => {
    const user = userEvent.setup();
    const created = newPlacement({ placementId: 'placement-xyz' });
    createPlacement.mockResolvedValue(created);
    const { onCreated } = setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  // ── 9: on API error keeps the modal open + shows a role=alert; onCreated NOT called ──
  it('on an API error keeps the dialog open and shows an inline error; onCreated is not called', async () => {
    const user = userEvent.setup();
    createPlacement.mockRejectedValue(new ApiError(400, 'bad_request', 'bad_request', {}));
    const { onCreated } = setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't create the placement/i),
    );
    expect(screen.getByRole('dialog', { name: 'New placement' })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    // Busy cleared → Create re-enabled (both sides still chosen).
    expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled();
  });

  // ── 10a: pre-fill + lock the TENANT side (tenant locked, unit editable) ──
  it('with tenantId set: the Tenant side is locked read-only and the Unit picker is editable', async () => {
    const user = userEvent.setup();
    createPlacement.mockResolvedValue(newPlacement());
    const { onCreated } = setup({ tenantId: 'contact-tenant-0001' });

    // Locked tenant label resolves from the mocked getContacts list.
    expect(await screen.findByText('Tasha Nguyen')).toBeInTheDocument();
    // No editable Tenant combobox; the Unit combobox IS present.
    expect(screen.queryByRole('combobox', { name: 'Tenant' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Unit' })).toBeInTheDocument();

    // The locked tenant counts toward "resolved" — picking a unit enables Create.
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() =>
      expect(createPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'contact-tenant-0001', unitId: 'unit-0002' }),
      ),
    );
    expect(onCreated).toHaveBeenCalled();
  });

  // ── 10b: pre-fill + lock the UNIT side (unit locked, tenant editable) ──
  it('with unitId set: the Unit side is locked read-only and the Tenant picker is editable', async () => {
    const user = userEvent.setup();
    createPlacement.mockResolvedValue(newPlacement());
    setup({ unitId: 'unit-0002' });

    // Locked unit label resolves from the mocked getUnits list.
    expect(await screen.findByText(/88 Sycamore St/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Unit' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await user.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() =>
      expect(createPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'contact-tenant-0001', unitId: 'unit-0002' }),
      ),
    );
  });
});
