// ScheduleTourDialog.test.tsx — TDD spec for the "Schedule a tour" dialog.
// Tests are accessibility-first (getByRole / getByLabel). Mirrors the
// PlacementCreateForm.test.tsx pattern.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, Tour, UnitItem } from '../../api/index.js';

// ── Mock the api barrel ─────────────────────────────────────────────────────
// Spread the real module; override only the two functions the dialog calls.
const createTour = vi.fn();
const getContact = vi.fn();
const getUnits = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    createTour: (...a: unknown[]) => createTour(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
  };
});

// Import AFTER mocking.
import { ScheduleTourDialog } from './ScheduleTourDialog.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const TENANT: Contact = {
  contactId: 'contact-tenant-0001',
  type: 'tenant',
  firstName: 'Alicia',
  lastName: 'Torres',
};

const UNITS: UnitItem[] = [
  {
    unitId: 'unit-0001',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '120 Peachtree St NW', city: 'Atlanta', state: 'GA' },
    tour_process: 'self_guided',
  },
  {
    unitId: 'unit-0002',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA' },
    tour_process: 'landlord_led',
  },
  {
    unitId: 'unit-0003',
    landlordId: 'contact-landlord-0002',
    status: 'available',
    address: { line1: '55 Auburn Ave', city: 'Atlanta', state: 'GA' },
    // no tour_process — defaults to 'self_guided'
  },
];

function newTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-new-0001',
    tenantId: 'contact-tenant-0001',
    unitId: 'unit-0001',
    scheduledAt: '2026-08-01T14:00:00.000Z',
    tourType: 'self_guided',
    status: 'scheduled',
    ...over,
  };
}

function newRequestedTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-req-0001',
    tenantId: 'contact-tenant-0001',
    unitId: 'unit-0001',
    scheduledAt: '',
    tourType: 'self_guided',
    status: 'requested' as Tour['status'],
    ...over,
  };
}

function setup(props?: Partial<Parameters<typeof ScheduleTourDialog>[0]>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <ScheduleTourDialog
        tenantId={TENANT.contactId}
        onClose={onClose}
        onCreated={onCreated}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

/** Pick a unit via the typeahead (type a query, click the matching option). */
async function pickUnit(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(screen.getByRole('combobox', { name: 'Property' }), query);
  await user.click(await screen.findByRole('option', { name }));
}

// ── Default mock setup ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  getContact.mockResolvedValue(TENANT);
  getUnits.mockResolvedValue({ units: UNITS, nextCursor: null });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ScheduleTourDialog', () => {

  // ── 1: TenantFile shows "Schedule a tour" once wired; clicking opens dialog ──
  // Note: this test verifies the dialog itself renders with the correct role and
  // accessible name — the TenantFile wiring is verified in ContactDetail tests.
  it('renders a dialog with role=dialog and an accessible name', async () => {
    setup();
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    expect(dialog).toBeInTheDocument();
  });

  it('shows the tenant name in the dialog after resolving the contact', async () => {
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    expect(await screen.findByText('Alicia Torres')).toBeInTheDocument();
  });

  // ── 2: Picking a unit prefills tourType from its tour_process; override works ──
  it('prefills tourType from the picked unit tour_process (self_guided → Self-Guided)', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);

    // tour_process 'self_guided' on unit-0001 → select has value 'self_guided'
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );
  });

  it('prefills tourType landlord_led when the picked unit has that tour_process', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led'),
    );
  });

  it('allows overriding the prefilled tourType', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);
    // Wait for the prefill to land
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );

    // Override to landlord_led
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tour type' }), 'landlord_led');
    expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led');
  });

  // ── 3: Submit WITH a datetime → POST body {tenantId, unitId, scheduledAt, tourType} ──
  it('submit WITH a datetime sends correct body and closes the dialog', async () => {
    const user = userEvent.setup();
    const created = newTour();
    createTour.mockResolvedValue(created);
    const { onCreated } = setup();

    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );

    // Fill in a future datetime
    const dtInput = screen.getByLabelText(/Date & time/i);
    // Use a datetime-local value (local time format required for datetime-local input)
    await user.clear(dtInput);
    await user.type(dtInput, '2030-08-15T10:00');

    await user.click(screen.getByRole('button', { name: /Schedule/i }));

    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'contact-tenant-0001',
          unitId: 'unit-0001',
          tourType: 'self_guided',
          scheduledAt: expect.stringMatching(/2030-08-15/),
        }),
      ),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  // ── 4: Submit WITHOUT a datetime → POST body has NO scheduledAt; "tour request" copy visible ──
  it('shows "tour request" copy when the date/time is empty', async () => {
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    // The "No time yet" copy should be visible before any interaction
    expect(screen.getByText(/No time yet/i)).toBeInTheDocument();
  });

  it('submit WITHOUT a datetime sends body without scheduledAt', async () => {
    const user = userEvent.setup();
    const created = newRequestedTour();
    createTour.mockResolvedValue(created);
    const { onCreated } = setup();

    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );

    // Leave the datetime empty (don't fill it in)
    await user.click(screen.getByRole('button', { name: /Schedule/i }));

    await waitFor(() => expect(createTour).toHaveBeenCalled());
    const body = createTour.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      tenantId: 'contact-tenant-0001',
      unitId: 'unit-0001',
      tourType: 'self_guided',
    });
    expect('scheduledAt' in body).toBe(false);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  // ── 5: Past datetime → inline error, no POST ──
  it('past datetime shows an inline error and does not POST', async () => {
    const user = userEvent.setup();
    setup();

    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );

    // Type a date in the past
    const dtInput = screen.getByLabelText(/Date & time/i);
    await user.clear(dtInput);
    await user.type(dtInput, '2020-01-01T10:00');

    await user.click(screen.getByRole('button', { name: /Schedule/i }));

    // Should show an inline error (role=alert)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/past/i),
    );
    expect(createTour).not.toHaveBeenCalled();
  });

  // ── 6: API error → surfaced inline, dialog stays open ──
  it('on an API error shows an inline error and keeps the dialog open', async () => {
    const user = userEvent.setup();
    createTour.mockRejectedValue(new ApiError(500, 'server_error', 'server_error', {}));
    const { onCreated } = setup();

    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );

    await user.click(screen.getByRole('button', { name: /Schedule/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't schedule/i),
    );
    // Dialog stays open
    expect(screen.getByRole('dialog', { name: 'Schedule a tour' })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  // ── Submit button disabled until a unit is chosen ──
  it('Schedule button is disabled until a unit is picked', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    const btn = screen.getByRole('button', { name: /Schedule/i });
    expect(btn).toBeDisabled();

    await pickUnit(user, '120 Peachtree', /120 Peachtree St NW/);
    await waitFor(() => expect(btn).toBeEnabled());
  });
});
