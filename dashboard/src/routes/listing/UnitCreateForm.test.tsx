import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, UnitItem } from '../../api/index.js';

// Mock the api barrel: spread the real module, override only the functions the
// form calls. Each delegates to a vi.fn() so per-test mockResolvedValue works.
const createUnit = vi.fn();
const getContacts = vi.fn();
const getContact = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    createUnit: (...a: unknown[]) => createUnit(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getContact: (...a: unknown[]) => getContact(...a),
  };
});

// Import AFTER mocking.
import { UnitCreateForm } from './UnitCreateForm.js';

const LANDLORDS: Contact[] = [
  { contactId: 'contact-landlord-0001', type: 'landlord', firstName: 'Rosa', lastName: 'Kim', company: 'Kim Realty' },
  { contactId: 'contact-landlord-0002', type: 'landlord', firstName: 'Gene', lastName: 'Park' },
];

function newUnit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'unit-new',
    landlordId: 'contact-landlord-0001',
    status: 'setup',
    ...over,
  };
}

function setup(props?: Partial<Parameters<typeof UnitCreateForm>[0]>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <UnitCreateForm onClose={onClose} onCreated={onCreated} {...props} />
    </MemoryRouter>,
  );
  return { onClose, onCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  getContacts.mockResolvedValue({ contacts: LANDLORDS, nextCursor: null });
  getContact.mockResolvedValue(LANDLORDS[0]);
});

/** Fill a labelled number/text input by its accessible name. */
async function fill(user: ReturnType<typeof userEvent.setup>, name: RegExp | string, value: string) {
  await user.type(screen.getByLabelText(name), value);
}

describe('UnitCreateForm', () => {
  // ── 1: renders the dialog + the key intake fields ──
  it('renders the dialog with the core property-intake fields', async () => {
    setup({ landlordId: 'contact-landlord-0001' });
    expect(await screen.findByRole('dialog', { name: 'New property' })).toBeInTheDocument();
    expect(screen.getByLabelText('Beds')).toBeInTheDocument();
    expect(screen.getByLabelText('Baths')).toBeInTheDocument();
    expect(screen.getByLabelText('Rent min')).toBeInTheDocument();
    expect(screen.getByLabelText('Rent max')).toBeInTheDocument();
    expect(screen.getByLabelText('Voucher size accepted')).toBeInTheDocument();
    expect(screen.getByLabelText('Public listing link')).toBeInTheDocument();
    expect(screen.getByLabelText('Street address')).toBeInTheDocument();
  });

  // ── 2: with landlordId set, the landlord side is locked read-only ──
  it('with landlordId set: the landlord is locked read-only (name shown, no picker)', async () => {
    setup({ landlordId: 'contact-landlord-0001' });
    // Locked landlord label resolves from the mocked getContacts list.
    expect(await screen.findByText('Rosa Kim')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Owning landlord' })).toBeNull();
  });

  // ── 3: without landlordId, a landlord picker is shown; Create gated on it ──
  it('without landlordId: a landlord picker is shown and Create is disabled until one is chosen', async () => {
    const user = userEvent.setup();
    setup();
    const create = () => screen.getByRole('button', { name: /^Create$/ });
    expect(screen.getByRole('combobox', { name: 'Owning landlord' })).toBeInTheDocument();
    expect(create()).toBeDisabled();
    await user.type(screen.getByRole('combobox', { name: 'Owning landlord' }), 'Rosa');
    await user.click(await screen.findByRole('option', { name: /Rosa Kim/ }));
    expect(create()).toBeEnabled();
    // Let mount fetches settle.
    await waitFor(() => expect(getContacts).toHaveBeenCalled());
  });

  // ── 4: submit posts landlordId + coerced fields, then calls onCreated ──
  it('submit calls createUnit with the landlordId and entered fields (numbers coerced)', async () => {
    const user = userEvent.setup();
    const created = newUnit({ unitId: 'unit-xyz' });
    createUnit.mockResolvedValue(created);
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    await fill(user, 'Beds', '3');
    await fill(user, 'Baths', '2');
    await fill(user, 'Rent min', '1400');
    await fill(user, 'Rent max', '1500');
    await fill(user, 'Voucher size accepted', '2');
    await fill(user, 'Public listing link', 'https://example.com/x');
    await fill(user, 'Street address', '55 Elm Ct NW');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    const body = createUnit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      landlordId: 'contact-landlord-0001',
      beds: 3,
      baths: 2,
      rent_min: 1400,
      rent_max: 1500,
      voucher_size_accepted: 2,
      listing_link: 'https://example.com/x',
    });
    expect(body['address']).toMatchObject({ line1: '55 Elm Ct NW' });
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  // ── 5: empty optional fields are omitted from the body ──
  it('omits empty fields — a bare create sends only landlordId', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    const body = createUnit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ landlordId: 'contact-landlord-0001' });
  });

  // -- 5b: a chosen Tour type rides the create body; "Not set" is omitted --
  it('sends a chosen Tour type in the create body', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    const select = screen.getByLabelText('Tour type');
    expect(select).toHaveValue(''); // defaults to "Not set"
    await user.selectOptions(select, 'pm_team');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    const body = createUnit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ landlordId: 'contact-landlord-0001', tour_type: 'pm_team' });
  });

  // ── 6: an invalid (below-minimum) number blocks creation ──
  // Beds has min=0; a negative value fails the input's constraint validation so the
  // form does not submit — no property is created and the dialog stays open. (The
  // JS number guard in buildBody is belt-and-suspenders behind this + the server.)
  it('does not create the property when a numeric field is invalid (below its minimum)', async () => {
    const user = userEvent.setup();
    setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    fireEvent.change(screen.getByLabelText('Beds'), { target: { value: '-4' } });
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    // Flush any (blocked) submit, then assert nothing was POSTed.
    await Promise.resolve();
    expect(createUnit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New property' })).toBeInTheDocument();
  });

  // ── 7: on API error, dialog stays open + role=alert; onCreated not called ──
  it('on an API error keeps the dialog open with an inline error; onCreated is not called', async () => {
    const user = userEvent.setup();
    createUnit.mockRejectedValue(new ApiError(400, 'bad_request', 'bad_request', {}));
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't create/i),
    );
    expect(screen.getByRole('dialog', { name: 'New property' })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled();
  });
});
