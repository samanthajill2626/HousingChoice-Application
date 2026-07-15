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
    // tour_process mentions "landlord" → deriveTourType → 'landlord_led'.
    tour_process: 'Text the landlord to arrange a walkthrough.',
  },
  {
    unitId: 'unit-0002',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA' },
    // tour_process mentions "self" → deriveTourType → 'self_guided'.
    tour_process: 'Self-guided via lockbox, weekdays 9-5.',
  },
  {
    unitId: 'unit-0003',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '12 Peachtree Way', city: 'Atlanta', state: 'GA' },
    // Structured tour_type set -> "From the property" wins over the free-text
    // guess (the tour_process DISAGREES, proving the structured field is used).
    tour_type: 'pm_team',
    tour_process: 'Self-guided via lockbox.',
  },
  {
    unitId: 'unit-0004',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    address: { line1: '400 Edgewood Ave', city: 'Atlanta', state: 'GA' },
    // No tour_type AND no tour_process -> the labeled self_guided default.
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

/** A datetime-local value `msFromNow` from the real clock — the date tests use
 *  RELATIVE times so they never rot into the past (or past the 14-day warning
 *  window) as the calendar advances. */
function localDatetime(msFromNow: number): string {
  const d = new Date(Date.now() + msFromNow);
  d.setSeconds(0, 0);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const DAY = 24 * 3_600_000;

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

    // 3 days out — inside the ordinary window (future, under 14 days), so no
    // odd-time warning interferes with the plain submit path.
    const at = localDatetime(3 * DAY);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.type(screen.getByLabelText('Date and time'), at);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith({
        tenantId: 'contact-tenant-0001',
        unitId: 'unit-0002',
        tourType: 'self_guided',
        // The datetime-local value is normalized to a full ISO instant in the
        // user's timezone (the test computes the same conversion).
        scheduledAt: new Date(at).toISOString(),
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

  // ── 7a: prefill tourType from the picked unit's tour_process (self_guided) ──
  it('prefills the Tour type from the picked unit tour_process (self → self_guided)', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);

    // unit-0002 tour_process mentions "self" → deriveTourType → 'self_guided'.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );
  });

  // ── 7b: prefill tourType landlord_led from a landlord-mentioning tour_process ──
  it('prefills the Tour type landlord_led when the picked unit tour_process mentions the landlord', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, 'Joseph', /1450 Joseph E\. Boone Blvd NW/);

    // unit-0001 tour_process mentions "landlord" → deriveTourType → 'landlord_led'.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led'),
    );
  });

  // ── 7c: a manual override sticks; re-deriving does not clobber the staff choice ──
  it('lets staff override the prefilled Tour type and the override sticks', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    // Pick a self_guided unit → prefill lands as self_guided.
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );

    // Override to landlord_led — the manual pick must persist (no re-derive).
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tour type' }), 'landlord_led');
    expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led');
  });

  // -- 7f: branch 1 - a structured tour_type prefills with "From the property" --
  it('prefills from the structured tour_type with a "From the property" provenance caption', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    // unit-0003 has tour_type: 'pm_team' (its free text says "self" - structured wins).
    await pickUnit(user, 'Peachtree', /12 Peachtree Way/);

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('pm_team'),
    );
    expect(screen.getByText('From the property')).toBeInTheDocument();
    // The free-text tour_process shows read-only as context.
    expect(screen.getByLabelText('Property tour notes')).toHaveTextContent('Self-guided via lockbox.');
  });

  // -- 7g: branch 2 - the keyword guess is captioned "Guessed from ..." --
  it('prefills the guess path with a "Guessed from the property tour notes" caption', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, 'Joseph', /1450 Joseph E\. Boone Blvd NW/);

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led'),
    );
    expect(
      screen.getByText("Guessed from the property's tour notes - check it"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Property tour notes')).toBeInTheDocument();
  });

  // -- 7h: branch 3 - no property tour info is captioned "Default ..." + no notes block --
  it('falls back to the self_guided default with a "Default" caption and no notes block', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    // unit-0004 has neither tour_type nor tour_process.
    await pickUnit(user, 'Edgewood', /400 Edgewood Ave/);

    await waitFor(() =>
      expect(screen.getByText('Default - no tour info on the property')).toBeInTheDocument(),
    );
    expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided');
    // No tour_process -> no read-only notes block.
    expect(screen.queryByLabelText('Property tour notes')).toBeNull();
  });

  // -- 7i: E1 - a manual override drops the property-provenance caption --
  it('drops the property-provenance caption once staff override the Tour type (E1)', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    // Pick the structured unit -> "From the property".
    await pickUnit(user, 'Peachtree', /12 Peachtree Way/);
    await waitFor(() => expect(screen.getByText('From the property')).toBeInTheDocument());

    // Override the type -> the caption must no longer claim property provenance.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tour type' }), 'self_guided');
    expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided');
    expect(screen.queryByText('From the property')).toBeNull();
  });

  // -- 7j: re-deriving across a unit change updates both the value and the caption --
  it('re-derives the type + caption when a different unit is picked', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    // First: a guess-path unit.
    await pickUnit(user, 'Joseph', /1450 Joseph E\. Boone Blvd NW/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led'),
    );

    // Clear + pick the structured unit -> caption + value switch.
    await user.click(screen.getByRole('button', { name: 'Clear Unit' }));
    await pickUnit(user, 'Peachtree', /12 Peachtree Way/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('pm_team'),
    );
    expect(screen.getByText('From the property')).toBeInTheDocument();
    expect(screen.queryByText("Guessed from the property's tour notes - check it")).toBeNull();
  });

  // -- 7k: E2 - clearing the unit resets type + caption + notes block --
  it('resets type, caption, and notes block when the unit is cleared (E2)', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    // Pick the structured unit -> pm_team + caption + notes block.
    await pickUnit(user, 'Peachtree', /12 Peachtree Way/);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('pm_team'),
    );
    expect(screen.getByText('From the property')).toBeInTheDocument();
    expect(screen.getByLabelText('Property tour notes')).toBeInTheDocument();

    // Clear -> the no-unit state: default type, no caption, no notes block.
    await user.click(screen.getByRole('button', { name: 'Clear Unit' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('self_guided'),
    );
    expect(screen.queryByText('From the property')).toBeNull();
    expect(screen.queryByLabelText('Property tour notes')).toBeNull();
  });

  // ── 7d: a PAST datetime warns on the first submit; a second submit confirms ──
  it('a past datetime warns and blocks the first submit; "Schedule anyway" confirms', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour({ status: 'scheduled' }));
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    const at = localDatetime(-2 * DAY);
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    await user.type(screen.getByLabelText('Date and time'), at);
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    // First submit: an inline warning, NO create, and the button re-labels.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/in the past/i));
    expect(createTour).not.toHaveBeenCalled();

    // Second submit ("Schedule anyway") is the confirmation — the tour is
    // created with the past instant (back-dating is legitimate).
    await user.click(screen.getByRole('button', { name: 'Schedule anyway' }));
    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledAt: new Date(at).toISOString() }),
      ),
    );
  });

  // ── 7e: a FAR-FUTURE datetime (>14 days) warns; editing the date clears it ──
  it('a >14-days-out datetime warns; editing to a near date clears the warning and submits clean', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour({ status: 'scheduled' }));
    setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });

    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    const dateField = screen.getByLabelText('Date and time');
    await user.type(dateField, localDatetime(30 * DAY));
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/more than 14 days/i));
    expect(createTour).not.toHaveBeenCalled();

    // Fixing the date withdraws the warning (button back to plain "Schedule")
    // and the next submit goes straight through.
    const near = localDatetime(2 * DAY);
    await user.clear(dateField);
    await user.type(dateField, near);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));
    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledAt: new Date(near).toISOString() }),
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

  // ── 11: initialUnitId pre-commits the unit side once the roster loads ──
  it('initialUnitId pre-commits the Unit typeahead (read-only + Clear) and derives the tour type', async () => {
    setup({ tenantId: 'contact-tenant-0001', initialUnitId: 'unit-0001' });

    const unitBox = screen.getByRole('combobox', { name: 'Unit' });
    await waitFor(() => expect(unitBox).toHaveValue('1450 Joseph E. Boone Blvd NW, Atlanta, GA'));
    // Committed like a hand pick: read-only + a Clear affordance.
    expect(unitBox).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Clear Unit' })).toBeInTheDocument();
    // Tour type derives from the pre-committed unit's tour_process ("landlord").
    // Wrapped in waitFor: the tour-type derivation reacts to the pre-committed
    // unit a microtask AFTER the unit box commits (line above), so under
    // full-suite CPU load the bare sync assert can lose that race (passes in
    // isolation, flaked in-suite).
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tour type' })).toHaveValue('landlord_led'),
    );
    // Both sides resolved -> ready to submit straight away.
    expect(screen.getByRole('button', { name: /^Schedule$/ })).toBeEnabled();
  });

  // ── 11a: the pre-committed unit rides the create body without any typing ──
  it('a pre-committed unit rides the create body without any typing', async () => {
    const user = userEvent.setup();
    createTour.mockResolvedValue(newTour({ unitId: 'unit-0001', tourType: 'landlord_led' }));
    setup({ tenantId: 'contact-tenant-0001', initialUnitId: 'unit-0001' });

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue(
        '1450 Joseph E. Boone Blvd NW, Atlanta, GA',
      ),
    );
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));
    await waitFor(() =>
      expect(createTour).toHaveBeenCalledWith(
        expect.objectContaining({ unitId: 'unit-0001', tourType: 'landlord_led' }),
      ),
    );
  });

  // ── 11b: Clear returns the pre-committed unit to free search ──
  it('Clear returns the pre-committed unit to free search (a different unit can be picked)', async () => {
    const user = userEvent.setup();
    setup({ tenantId: 'contact-tenant-0001', initialUnitId: 'unit-0001' });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue(
        '1450 Joseph E. Boone Blvd NW, Atlanta, GA',
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Clear Unit' }));
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('');
    await pickUnit(user, 'Sycamore', /88 Sycamore St/);
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('88 Sycamore St, Decatur, GA');
  });

  // ── 11c: an initialUnitId missing from the roster is ignored ──
  it('an initialUnitId missing from the roster is ignored (field stays free-typing empty)', async () => {
    setup({ tenantId: 'contact-tenant-0001', initialUnitId: 'unit-gone' });
    // Wait on the locked tenant label so the mount fetches have settled.
    expect(await screen.findByRole('group', { name: 'Tenant' })).toHaveTextContent('Tasha Nguyen');
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear Unit' })).toBeNull();
  });

  // ── 12: Cancel closes without creating ──
  it('Cancel calls onClose without creating anything', async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ tenantId: 'contact-tenant-0001' });
    await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(onClose).toHaveBeenCalled();
    expect(createTour).not.toHaveBeenCalled();
  });
});
