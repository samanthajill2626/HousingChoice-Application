// ScheduleTourForm component tests — the "Schedule a tour" dialog (Tours card
// "+ Schedule"). Mirrors PlacementCreateForm.test.tsx idioms: mock the api
// barrel BEFORE importing the component, pick a unit via the typeahead, assert
// accessibility-first. The date is OPTIONAL — empty creates a timeless
// 'requested' tour (createTour called WITHOUT scheduledAt).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, Tour, UnitItem } from '../../api/index.js';

// Mock the api barrel: spread the real module, override only what the form
// calls. Each delegates to a vi.fn() so per-test mockResolvedValue works.
const createTour = vi.fn();
const getContacts = vi.fn();
const getUnits = vi.fn();
const getContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    createTour: (...a: unknown[]) => createTour(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getContact: (...a: unknown[]) => getContact(...a),
  };
});

// Import AFTER mocking.
import { ScheduleTourForm } from './ScheduleTourForm.js';

const TENANTS: Contact[] = [
  { contactId: 'contact-tenant-0001', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen' },
  { contactId: 'contact-tenant-0002', type: 'tenant', firstName: 'Omar', lastName: 'Diaz' },
];

const UNITS: UnitItem[] = [
  {
    unitId: 'unit-0001',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '1450 Joseph E. Boone Blvd NW', city: 'Atlanta', state: 'GA' },
  },
  {
    unitId: 'unit-0002',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA' },
  },
];

function newTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-new',
    tenantId: 'contact-tenant-0001',
    unitId: 'unit-0002',
    tourType: 'self_guided',
    status: 'requested',
    ...over,
  };
}

function setup(props?: Partial<Parameters<typeof ScheduleTourForm>[0]>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <ScheduleTourForm onClose={onClose} onCreated={onCreated} {...props} />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  getContacts.mockResolvedValue({ contacts: TENANTS, nextCursor: null });
  getUnits.mockResolvedValue({ units: UNITS, nextCursor: null });
  // The locked-label fallback is best-effort; reject so the list lookup wins.
  getContact.mockRejectedValue(new ApiError(404, 'not_found', 'not_found'));
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

describe('ScheduleTourForm', () => {
  // ── 1: renders the dialog + fields ──
  it('renders the dialog with Unit typeahead, Tour type select, and an optional Date and time', async () => {
    setup();
    // findBy flushes the mount fetches so their state updates land inside act().
    expect(await screen.findByRole('dialog', { name: 'Schedule a tour' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Unit' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tour type' })).toBeInTheDocument();
    expect(screen.getByLabelText('Date and time')).toBeInTheDocument();
    expect(screen.getByLabelText('Date and time')).not.toBeRequired();
    // The exact helper copy the e2e suite asserts on.
    expect(
      screen.getByText('Leave empty to create the tour without a time — book it later.'),
    ).toBeInTheDocument();
  });

  // ── 2: tour type select offers the three staff-facing labels ──
  it('Tour type offers Self-guided / Landlord-led / PM team, defaulting to self_guided', async () => {
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    const select = screen.getByRole('combobox', { name: 'Tour type' });
    expect(select).toHaveValue('self_guided');
    expect(screen.getByRole('option', { name: 'Self-guided' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Landlord-led' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'PM team' })).toBeInTheDocument();
  });

  // ── 3: locked tenant side when tenantId prop is passed ──
  it('with tenantId set: the Tenant side is locked read-only (role=group) with the resolved name', async () => {
    setup({ tenantId: 'contact-tenant-0001' });
    // Locked label resolves from the mocked getContacts list.
    const locked = await screen.findByRole('group', { name: 'Tenant' });
    expect(locked).toHaveTextContent('Tasha Nguyen');
    expect(screen.queryByRole('combobox', { name: 'Tenant' })).toBeNull();
  });

  // ── 4: submit disabled until tenant + unit are resolved ──
  it('Schedule is disabled until both a tenant and a unit are resolved', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    const schedule = () => screen.getByRole('button', { name: /^Schedule$/ });
    expect(schedule()).toBeDisabled(); // tenant locked, no unit yet
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    expect(schedule()).toBeEnabled();
  });

  // ── 5: empty date → createTour called WITHOUT scheduledAt ──
  it('submits WITHOUT scheduledAt when the date is left empty (timeless / requested)', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour());
    setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(createTour).toHaveBeenCalled());
    const body = createTour.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      tenantId: 'contact-tenant-0001',
      unitId: 'unit-0002',
      tourType: 'self_guided',
    });
    expect('scheduledAt' in body).toBe(false);
  });

  // ── 6: filled date → createTour called WITH an ISO scheduledAt ──
  it('submits WITH an ISO scheduledAt when the date is filled', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour({ status: 'scheduled', scheduledAt: '2026-07-15T14:00:00.000Z' }));
    setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.type(screen.getByLabelText('Date and time'), '2026-07-15T14:00');
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith({
        tenantId: 'contact-tenant-0001',
        unitId: 'unit-0002',
        tourType: 'self_guided',
        // The datetime-local value is normalized to a full ISO instant in the
        // user's timezone (the test computes the same conversion).
        scheduledAt: new Date('2026-07-15T14:00').toISOString(),
      }),
    );
  });

  // ── 7: picked tour type rides the body ──
  it('carries the picked tour type in the create body', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour({ tourType: 'landlord_led' }));
    setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tour type' }), 'landlord_led');
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith(
        expect.objectContaining({ tourType: 'landlord_led' }),
      ),
    );
  });

  // ── 8: editable tenant typeahead when no tenantId prop ──
  it('without tenantId: the Tenant typeahead is editable and its pick rides the body', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour());
    setup();

    await pickTenant(user, 'Tasha', /Tasha Nguyen/);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'contact-tenant-0001', unitId: 'unit-0002' }),
      ),
    );
  });

  // ── 9: on 201 calls onCreated with the returned tour (caller navigates) ──
  it('on a successful create (201), calls onCreated with the returned tour', async () => {
    const user = userEvent.setup();
    const created = newTour({ tourId: 'tour-xyz' });
    createTour.mockResolvedValue(created);
    const { onCreated } = setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  // ── 10: API error keeps the dialog open + shows an alert; onCreated NOT called ──
  it('on an API error keeps the dialog open and shows an inline error; onCreated is not called', async () => {
    const user = userEvent.setup();
    createTour.mockRejectedValue(new ApiError(400, 'bad_request', 'bad_request', {}));
    const { onCreated } = setup({ tenantId: 'contact-tenant-0001' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't schedule the tour/i),
    );
    expect(screen.getByRole('dialog', { name: 'Schedule a tour' })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    // Busy cleared → Schedule re-enabled (both sides still resolved).
    expect(screen.getByRole('button', { name: /^Schedule$/ })).toBeEnabled();
  });

  // ── 11: Cancel closes without creating ──
  it('Cancel calls onClose without creating anything', async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(onClose).toHaveBeenCalled();
    expect(createTour).not.toHaveBeenCalled();
  });
});
