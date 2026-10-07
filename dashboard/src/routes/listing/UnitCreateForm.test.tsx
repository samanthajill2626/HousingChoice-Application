import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, OrgEntry, UnitItem } from '../../api/index.js';

// Mock the api barrel: spread the real module, override only the functions the
// form calls. Each delegates to a vi.fn() so per-test mockResolvedValue works.
const createUnit = vi.fn();
const getAllContacts = vi.fn();
const getContact = vi.fn();
// The authorities picker's list and "Is this really new?" (spec 2026-10-06 D6).
const getOrgList = vi.fn();
const checkOrgText = vi.fn();
const addOrg = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    createUnit: (...a: unknown[]) => createUnit(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    checkOrgText: (...a: unknown[]) => checkOrgText(...a),
    addOrg: (...a: unknown[]) => addOrg(...a),
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

function orgEntry(name: string, spellings: string[] = [], kind: OrgEntry['kind'] = 'housing_authority'): OrgEntry {
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
  orgEntry('Atlanta Housing Authority', ['AHA']),
  orgEntry('Georgia Department of Community Affairs', ['DCA']),
  orgEntry('Step Up', [], 'agency'),
];

beforeEach(() => {
  vi.clearAllMocks();
  getAllContacts.mockResolvedValue(LANDLORDS);
  getContact.mockResolvedValue(LANDLORDS[0]);
  getOrgList.mockResolvedValue({ version: 1, entries: ORG_ENTRIES });
  checkOrgText.mockResolvedValue({ candidates: [], close: [] });
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
    // The housing authorities picker (spec 2026-10-06 D6) replaces the retired
    // single 'Housing authority' field and the 'Accepted vouchers / programs'
    // list (spec section 8).
    expect(screen.getByLabelText('Housing authorities')).toBeInTheDocument();
    expect(screen.queryByLabelText('Housing authority')).toBeNull();
    expect(screen.queryByLabelText(/Accepted vouchers/i)).toBeNull();
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
    await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
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

  // -- 4b: the picked housing authorities become accepted_authorities --
  it('sends the picked housing authorities as accepted_authorities and never the retired keys', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    const picker = screen.getByRole('combobox', { name: 'Housing authorities' });
    await user.type(picker, 'AHA');
    await user.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.type(picker, 'DCA');
    await user.click(await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ }));
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    const body = createUnit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      landlordId: 'contact-landlord-0001',
      accepted_authorities: ['Atlanta Housing Authority', 'Georgia Department of Community Affairs'],
    });
    expect(body).not.toHaveProperty('jurisdiction');
    expect(body).not.toHaveProperty('accepted_programs');
  });

  it('adds a housing authority through "Is this really new?" - agencies are never offered', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    addOrg.mockResolvedValue(orgEntry('Metro Housing Board'));
    setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    const picker = screen.getByRole('combobox', { name: 'Housing authorities' });
    await user.type(picker, 'Step Up');
    // An agency is not offered here (the add option is, as for any unknown text).
    expect(await screen.findByRole('option', { name: 'Add Step Up as a new housing authority' })).toBeInTheDocument();
    await user.clear(picker);
    await user.type(picker, 'Metro Housing Board');
    await user.click(await screen.findByRole('option', { name: 'Add Metro Housing Board as a new housing authority' }));
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    expect(isNew.closest('form')).toBeNull();
    await waitFor(() => expect(within(isNew).getByRole('button', { name: 'Yes, add it' })).toBeEnabled());
    await user.click(within(isNew).getByRole('button', { name: 'Yes, add it' }));
    expect(addOrg).toHaveBeenCalledWith({ kind: 'housing_authority', name: 'Metro Housing Board' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Metro Housing Board' })).toBeInTheDocument());
    // The name just added counts as on the list at once (useOrgList noteAdded).
    expect(screen.getByRole('button', { name: 'Remove Metro Housing Board' }).closest('li')).not.toHaveTextContent(
      'Not on the list',
    );
    await user.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    expect((createUnit.mock.calls[0]?.[0] as Record<string, unknown>)['accepted_authorities']).toEqual([
      'Metro Housing Board',
    ]);
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

  // -- 8: a refused authority (422 org_not_on_list, spec D5) shows under the picker --
  it('shows a refused housing authority under the picker, worded from the body', async () => {
    const user = userEvent.setup();
    createUnit.mockRejectedValue(
      new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
        error: 'org_not_on_list',
        field: 'accepted_authorities',
        text: 'Atlanta Housing Authority',
        candidates: [],
        close: [],
      }),
    );
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });

    await screen.findByRole('dialog', { name: 'New property' });
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'AHA');
    await user.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Atlanta Housing Authority is not on the list - pick a name from the list or add it.',
    );
    expect(alert.textContent ?? '').not.toContain('org_not_on_list');
    expect(onCreated).not.toHaveBeenCalled();
  });
});

// --- Code review R1-ADV-FE-1: text typed in the picker but never picked ------
// Create sends typed text that names exactly one entry (by name, or by a
// spelling only that entry carries), as a pick would, and refuses anything
// else - a property is never created without the authority staff typed.
describe('UnitCreateForm - text typed in the picker but never picked', () => {
  const BLOCKED = 'Pick a name from the list, add it as new, or clear the text.';
  // AHA is a spelling two entries share; DCA belongs to one.
  const TYPED_LIST: OrgEntry[] = [
    orgEntry('Atlanta Housing Authority', ['AHA']),
    orgEntry('Augusta Housing Authority', ['AHA']),
    orgEntry('Georgia Department of Community Affairs', ['DCA']),
    orgEntry('Step Up', [], 'agency'),
  ];
  const authorities = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authorities' });
  const create = (): HTMLElement => screen.getByRole('button', { name: /^Create$/ });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: TYPED_LIST });
  });

  it('a list name typed in full is sent as if it were picked', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await screen.findByRole('dialog', { name: 'New property' });
    await user.type(authorities(), 'Atlanta Housing Authority');
    await screen.findByRole('option', { name: /^Atlanta Housing Authority/ });
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    expect(createUnit.mock.calls[0]?.[0]).toEqual({
      landlordId: 'contact-landlord-0001',
      accepted_authorities: ['Atlanta Housing Authority'],
    });
  });

  it('a spelling only one entry carries sends that entry (DCA, then Beds, then Create)', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });
    await screen.findByRole('dialog', { name: 'New property' });
    await user.type(authorities(), 'DCA');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await fill(user, 'Beds', '2');
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    expect(createUnit.mock.calls[0]?.[0]).toEqual({
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['Georgia Department of Community Affairs'],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it.each([
    ['a spelling two entries share', 'AHA'],
    ['unknown text', 'Metro Nowhere'],
  ])('%s stops Create: nothing is sent, the picker says why and takes focus', async (_case, text) => {
    const user = userEvent.setup();
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });
    await screen.findByRole('dialog', { name: 'New property' });
    await user.type(authorities(), text);
    await screen.findAllByRole('option');
    await user.click(create());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(BLOCKED);
    expect(authorities().getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(authorities()).toHaveFocus();
    expect(createUnit).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
