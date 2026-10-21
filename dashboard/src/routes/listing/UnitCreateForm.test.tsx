import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
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
import { PROPERTY_FORM_FIELDS } from './requirements.js';

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

/** Spec 2026-10-20 D5 / D7: the snapshot the form sends for a landlord with no
 *  requirements - every item, every key, null. */
function blankSnapshot(landlordId: string): Record<string, unknown> {
  return {
    landlordId,
    evictions: { no_evictions_on_program: null, evictions_notes: null },
    credit_requirements: { credit_requirements: null },
    income_requirements: { income_requirements: null },
    qualifications: { qualifications: null },
    pets: { no_pets: null, pets: null, pet_fee: null },
    deposit: { deposit_one_month: null, deposit: null, deposit_flexible: null, deposit_notes: null },
    application_fee: { application_fee: null },
    touring: { tour_type: null, tour_process: null },
  };
}

/** The dialog is open and the locked landlord's record has landed: Create is
 *  enabled (spec 2026-10-20 D7 - Create waits while it loads). */
async function dialogReady(): Promise<void> {
  await screen.findByRole('dialog', { name: /^New property$/ });
  await waitFor(() => expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled());
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
    expect(screen.getByRole('group', { name: 'Voucher sizes accepted' })).toBeInTheDocument();
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

    await dialogReady();
    await fill(user, 'Beds', '3');
    await fill(user, 'Baths', '2');
    await fill(user, 'Rent min', '1400');
    await fill(user, 'Rent max', '1500');
    await user.click(within(screen.getByRole('group', { name: 'Voucher sizes accepted' })).getByRole('button', { name: '2' }));
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
      voucher_size_accepted: [2],
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

    await dialogReady();
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
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
    expect(body).not.toHaveProperty('jurisdiction');
    expect(body).not.toHaveProperty('accepted_programs');
  });

  it('adds a housing authority through "Is this really new?" - agencies are never offered', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    addOrg.mockResolvedValue(orgEntry('Metro Housing Board'));
    setup({ landlordId: 'contact-landlord-0001' });

    await dialogReady();
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
  it('omits empty fields - a bare create sends landlordId and the all-blank requirements_snapshot', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });

    await dialogReady();
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    const body = createUnit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      landlordId: 'contact-landlord-0001',
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
  });

  // -- 5b: a chosen Tour type rides the create body; "Not set" is omitted --
  it('sends a chosen Tour type in the create body', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });

    await dialogReady();
    const select = screen.getByLabelText('Tour type');
    expect(select).toHaveValue(''); // defaults to "Not set"
    await user.selectOptions(select, 'pm_team');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    const body = createUnit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      landlordId: 'contact-landlord-0001',
      tour_type: 'pm_team',
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
  });

  // ── 6: an invalid (below-minimum) number blocks creation ──
  // Beds has min=0; a negative value fails the input's constraint validation so the
  // form does not submit — no property is created and the dialog stays open. (The
  // JS number guard in buildBody is belt-and-suspenders behind this + the server.)
  it('does not create the property when a numeric field is invalid (below its minimum)', async () => {
    const user = userEvent.setup();
    setup({ landlordId: 'contact-landlord-0001' });

    await dialogReady();
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

    await dialogReady();
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

    await dialogReady();
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

  // caseworker-integrity I3 (spec section 4): the owning landlord was refused.
  it.each([
    ['landlord_not_landlord', 409, "Only a landlord can be a property's landlord of record."],
    ['landlord_not_found', 404, 'That landlord no longer exists.'],
  ] as const)(
    'shows the server landlord refusal %s as its sentence; the dialog stays open',
    async (code, status, sentence) => {
      const user = userEvent.setup();
      createUnit.mockRejectedValue(new ApiError(status, code, code, { error: code }));
      const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });

      await dialogReady();
      await user.click(screen.getByRole('button', { name: /^Create$/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
      expect(screen.getByRole('dialog', { name: 'New property' })).toBeInTheDocument();
      expect(onCreated).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled();
    },
  );
});

// --- Code review R1-ADV-FE-7: a name "Is this really new?" answered with ----
// The form's list is read once when it opens; /check knows a name added since.
describe('UnitCreateForm - a name the server confirmed counts as on the list at once', () => {
  it('"Use <name>": its chip is not marked Not on the list', async () => {
    const user = userEvent.setup();
    const metro = { orgId: 'o-metro', kind: 'housing_authority' as const, name: 'Metro Housing Authority' };
    checkOrgText.mockResolvedValue({ match: metro, candidates: [], close: [], nameProblem: 'org_name_taken' });
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Metro HA');
    await user.click(await screen.findByRole('option', { name: 'Add Metro HA as a new housing authority' }));
    const isNew = screen.getByRole('dialog', { name: 'Is this really new?' });
    await user.click(await within(isNew).findByRole('button', { name: 'Use Metro Housing Authority' }));
    const chip = screen.getByRole('button', { name: 'Remove Metro Housing Authority' }).closest('li');
    expect(chip).not.toHaveTextContent('Not on the list');
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
    await dialogReady();
    await user.type(authorities(), 'Atlanta Housing Authority');
    await screen.findByRole('option', { name: /^Atlanta Housing Authority/ });
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    expect(createUnit.mock.calls[0]?.[0]).toEqual({
      landlordId: 'contact-landlord-0001',
      accepted_authorities: ['Atlanta Housing Authority'],
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
  });

  it('a spelling only one entry carries sends that entry (DCA, then Beds, then Create)', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(authorities(), 'DCA');
    await screen.findByRole('option', { name: /^Georgia Department of Community Affairs/ });
    await fill(user, 'Beds', '2');
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    expect(createUnit.mock.calls[0]?.[0]).toEqual({
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['Georgia Department of Community Affairs'],
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it.each([
    ['DCA', 'Save will use Georgia Department of Community Affairs.'],
    ['Metro Nowhere', 'Not saved - pick a name from the list, add it as new, or clear the text.'],
  ])('the note under the field says what Create will do with %s (R2-FE-6)', async (text, note) => {
    const user = userEvent.setup();
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(authorities(), text);
    await screen.findAllByRole('option');
    await user.tab();
    // The field's flyer tag joins the description after the note (spec 2026-10-20 D10).
    expect(authorities()).toHaveAccessibleDescription(`${note} On flyer`);
  });

  it.each([
    ['a spelling two entries share', 'AHA'],
    ['unknown text', 'Metro Nowhere'],
  ])('%s stops Create: nothing is sent, the picker says why and takes focus', async (_case, text) => {
    const user = userEvent.setup();
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
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

// --- Code review R2-FE-1, R3-FE-3: Create never waits on a picker staff -----
// cannot use, and never drops the authority staff typed. A list read that
// fails with no list in hand leaves the picker usable while it holds text -
// clear-only: nothing to pick or add - and Create says so until the text is
// cleared. Text typed before the read lands cannot be settled yet: Create says
// the list is still loading.
describe('UnitCreateForm - a picker whose list is not there', () => {
  const NOT_LOADED = 'The list did not load - clear the text to save without it.';
  const authorities = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authorities' });
  const create = (): HTMLElement => screen.getByRole('button', { name: /^Create$/ });

  it('the read fails while text is typed: the field stays clearable and Create waits for it (R3-FE-3)', async () => {
    const user = userEvent.setup();
    const held = { reject: (_err: unknown): void => {} };
    getOrgList.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        held.reject = reject;
      }),
    );
    createUnit.mockResolvedValue(newUnit());
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(authorities(), 'DCA');
    await act(async () => held.reject(new ApiError(503, 'org_list_busy', 'org_list_busy')));
    expect(screen.getByText("Couldn't load housing authorities")).toBeInTheDocument();
    // Clear-only: the text stays in an enabled field, with nothing to pick or add.
    expect(authorities()).toBeEnabled();
    expect(authorities()).toHaveValue('DCA');
    expect(authorities()).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // A property is never created without the authority staff typed.
    await user.click(create());
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_LOADED);
    expect(authorities()).toHaveFocus();
    expect(createUnit).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    // Cleared, the field is done with (disabled again) and Create goes on.
    await user.clear(authorities());
    expect(authorities()).toBeDisabled();
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalled());
    expect(createUnit.mock.calls[0]?.[0]).toEqual({
      landlordId: 'contact-landlord-0001',
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
  });

  it('Create before the list loads says it is still loading - nothing is created', async () => {
    const user = userEvent.setup();
    getOrgList.mockReturnValueOnce(new Promise(() => {}));
    const { onCreated } = setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(authorities(), 'DCA');
    await user.click(create());
    expect(await screen.findByRole('alert')).toHaveTextContent('Still loading the list - try again in a moment.');
    expect(authorities()).toHaveFocus();
    expect(createUnit).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

// --- Spec 2026-10-20 D7: the New form starts filled in from its landlord ----
describe("UnitCreateForm - the landlord's requirements (spec 2026-10-20 D7)", () => {
  const ROSA_WITH_REQS: Contact = {
    contactId: 'contact-landlord-0001',
    type: 'landlord',
    firstName: 'Rosa',
    lastName: 'Kim',
    company: 'Kim Realty',
    req_credit_requirements: '600+',
    req_no_pets: true,
    req_pets: 'Service animals only',
    req_pet_fee: '$300',
    req_deposit_one_month: true,
    req_application_fee: 0,
    req_tour_type: 'landlord_led',
    req_tour_process: 'Call the office first.',
  };
  const GENE: Contact = { contactId: 'contact-landlord-0002', type: 'landlord', firstName: 'Gene', lastName: 'Park' };
  const ROSA_SNAPSHOT = {
    landlordId: 'contact-landlord-0001',
    evictions: { no_evictions_on_program: null, evictions_notes: null },
    credit_requirements: { credit_requirements: '600+' },
    income_requirements: { income_requirements: null },
    qualifications: { qualifications: null },
    pets: { no_pets: true, pets: 'Service animals only', pet_fee: '$300' },
    deposit: { deposit_one_month: true, deposit: null, deposit_flexible: null, deposit_notes: null },
    application_fee: { application_fee: 0 },
    touring: { tour_type: 'landlord_led', tour_process: 'Call the office first.' },
  };
  const FILLED = "Filled in from Rosa Kim's requirements. Change anything that is different for this property.";
  const LOADING = "Loading Rosa Kim's requirements...";
  const FAILED =
    "Couldn't load Rosa Kim's requirements, so this property starts without them. You can apply them from the landlord page later.";
  const create = (): HTMLElement => screen.getByRole('button', { name: /^Create$/ });
  const sentBody = (): Record<string, unknown> => createUnit.mock.calls[0]?.[0] as Record<string, unknown>;

  it('locked: reads the landlord record and fills the section in from its requirements, saying so', async () => {
    getContact.mockResolvedValue(ROSA_WITH_REQS);
    setup({ landlordId: 'contact-landlord-0001' });
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    expect(getContact).toHaveBeenCalledWith('contact-landlord-0001', expect.any(AbortSignal));
    expect(screen.getByLabelText('Credit score')).toHaveValue('600+');
    expect(screen.getByLabelText('No pets')).toBeChecked();
    expect(screen.getByLabelText('Pets (details)')).toHaveValue('Service animals only');
    expect(screen.getByLabelText('Pet fee')).toHaveValue('$300');
    expect(screen.getByLabelText("One month's rent")).toBeChecked();
    expect(screen.getByLabelText('Fixed amount')).toBeDisabled();
    expect(screen.getByLabelText('No application fee')).toBeChecked();
    expect(screen.getByLabelText('Tour type')).toHaveValue('landlord_led');
    expect(screen.getByLabelText('Tour process')).toHaveValue('Call the office first.');
  });

  it('an untouched prefill is sent as those values plus requirements_snapshot naming the landlord (D5)', async () => {
    const user = userEvent.setup();
    getContact.mockResolvedValue(ROSA_WITH_REQS);
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await screen.findByText(FILLED);
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      landlordId: 'contact-landlord-0001',
      credit_requirements: '600+',
      no_pets: true,
      pets: 'Service animals only',
      pet_fee: '$300',
      deposit_one_month: true,
      application_fee: 0,
      tour_type: 'landlord_led',
      tour_process: 'Call the office first.',
      requirements_snapshot: ROSA_SNAPSHOT,
    });
  });

  it('a pre-filled field cleared before saving is left out while the snapshot keeps the landlord value (so it reads as set on this property)', async () => {
    const user = userEvent.setup();
    getContact.mockResolvedValue(ROSA_WITH_REQS);
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await screen.findByText(FILLED);
    await user.click(screen.getByLabelText('No pets'));
    await user.clear(screen.getByLabelText('Pets (details)'));
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).not.toHaveProperty('no_pets');
    expect(sentBody()).not.toHaveProperty('pets');
    expect(sentBody()).toHaveProperty('pet_fee', '$300');
    expect(sentBody()['requirements_snapshot']).toEqual(ROSA_SNAPSHOT);
  });

  it('the picker: a pick fills from its list record; a different pick refills, replacing what was typed', async () => {
    const user = userEvent.setup();
    getAllContacts.mockResolvedValue([ROSA_WITH_REQS, GENE]);
    createUnit.mockResolvedValue(newUnit({ landlordId: 'contact-landlord-0002' }));
    setup();
    const owner = screen.getByRole('combobox', { name: 'Owning landlord' });
    await user.type(owner, 'Rosa');
    await user.click(await screen.findByRole('option', { name: /Rosa Kim/ }));
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    expect(screen.getByLabelText('Pets (details)')).toHaveValue('Service animals only');
    await user.type(screen.getByLabelText('Income requirements'), '3x rent');
    await user.click(screen.getByRole('button', { name: 'Clear Owning landlord' }));
    await user.type(owner, 'Gene');
    await user.click(await screen.findByRole('option', { name: /Gene Park/ }));
    expect(screen.getByLabelText('Pets (details)')).toHaveValue('');
    expect(screen.getByLabelText('Income requirements')).toHaveValue('');
    expect(screen.getByLabelText('No pets')).not.toBeChecked();
    // Gene holds no requirements: the section starts blank, with no note (C7).
    expect(screen.queryByText(/^Filled in from/)).toBeNull();
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      landlordId: 'contact-landlord-0002',
      requirements_snapshot: blankSnapshot('contact-landlord-0002'),
    });
    // The picker list already holds full contacts (F11): no record read.
    expect(getContact).not.toHaveBeenCalled();
  });

  it('while the locked landlord loads: the section says so, shows no fields, and Create waits', async () => {
    const held = { resolve: (_c: Contact): void => {} };
    getContact.mockReturnValueOnce(
      new Promise<Contact>((resolve) => {
        held.resolve = resolve;
      }),
    );
    setup({ landlordId: 'contact-landlord-0001' });
    expect(await screen.findByText(LOADING)).toBeInTheDocument();
    expect(create()).toBeDisabled();
    expect(screen.queryByLabelText('Pets (details)')).toBeNull();
    await act(async () => held.resolve(ROSA_WITH_REQS));
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    expect(screen.queryByText(LOADING)).toBeNull();
    expect(create()).toBeEnabled();
  });

  it('a failed read: the section says so with Try again; Create still works and sends no snapshot', async () => {
    const user = userEvent.setup();
    getContact.mockRejectedValue(new ApiError(503, 'unavailable', 'unavailable'));
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(create()).toBeEnabled();
    await user.type(screen.getByLabelText('Credit score'), '650');
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ landlordId: 'contact-landlord-0001', credit_requirements: '650' });
  });

  it('Try again reads the landlord again and fills the section in', async () => {
    const user = userEvent.setup();
    getContact
      .mockRejectedValueOnce(new ApiError(503, 'unavailable', 'unavailable'))
      .mockResolvedValueOnce(ROSA_WITH_REQS);
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await screen.findByText(FAILED);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(getContact).toHaveBeenCalledTimes(2);
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()['requirements_snapshot']).toEqual(ROSA_SNAPSHOT);
  });

  // Code review R2D-6 (the RD-7 pattern): the loading and failure lines are
  // ONE live region mounted from the first render, whose TEXT changes - a
  // region inserted already filled may not be announced, and the failure
  // also re-enables Create silently.
  it('the loading and failure lines share ONE always-mounted status region whose text changes', async () => {
    const user = userEvent.setup();
    const first = { reject: (_e: unknown): void => {} };
    const second = { resolve: (_c: Contact): void => {} };
    getContact.mockReturnValueOnce(
      new Promise<Contact>((_resolve, reject) => {
        first.reject = reject;
      }),
    );
    setup({ landlordId: 'contact-landlord-0001' });
    const region = await screen.findByText(LOADING);
    expect(region).toHaveAttribute('role', 'status');
    await act(async () => first.reject(new ApiError(503, 'unavailable', 'unavailable')));
    expect(await screen.findByText(FAILED)).toBe(region);
    // Queued only now, so a failure above never leaks it into the next test.
    getContact.mockReturnValueOnce(
      new Promise<Contact>((resolve) => {
        second.resolve = resolve;
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(region).toHaveTextContent(LOADING);
    await act(async () => second.resolve(ROSA_WITH_REQS));
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    // Still mounted, now empty; the button is gone.
    expect(region.isConnected).toBe(true);
    expect(region).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a landlord with no requirements: the section starts blank, with no note (C7)', async () => {
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    expect(screen.getByLabelText('Pets (details)')).toHaveValue('');
    expect(screen.getByLabelText('No pets')).not.toBeChecked();
    expect(screen.queryByText(/^Filled in from/)).toBeNull();
  });

  it('sends the voucher sizes picked as a list, the subzone and washer / dryer (D3, D4)', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    const sizes = screen.getByRole('group', { name: 'Voucher sizes accepted' });
    await user.click(within(sizes).getByRole('button', { name: '3' }));
    await user.click(within(sizes).getByRole('button', { name: '2' }));
    await user.type(screen.getByLabelText('Subzone'), 'E8');
    await user.selectOptions(screen.getByLabelText('Washer / dryer'), 'hookups');
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ voucher_size_accepted: [2, 3], subzone: 'E8', washer_dryer: 'hookups' });
  });

  it("One month's rent sends the box and never an amount; No application fee sends 0 (D1)", async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(screen.getByLabelText('Fixed amount'), '1200');
    await user.click(screen.getByLabelText("One month's rent"));
    expect(screen.getByLabelText('Fixed amount')).toBeDisabled();
    await user.click(screen.getByLabelText('No application fee'));
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      landlordId: 'contact-landlord-0001',
      deposit_one_month: true,
      application_fee: 0,
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
  });

  // Code review R2D-5: "No application fee" is its own flag - typing a fee
  // that starts with 0 never ticks it or locks the box, and Create sends the
  // amount typed (never the form-only flag).
  it('a typed $0.50 fee is never mistaken for No application fee; Create sends 0.5', async () => {
    const user = userEvent.setup();
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    await user.type(screen.getByLabelText('Application fee'), '0.50');
    expect(screen.getByLabelText('Application fee')).toBeEnabled();
    expect(screen.getByLabelText('No application fee')).not.toBeChecked();
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      landlordId: 'contact-landlord-0001',
      application_fee: 0.5,
      requirements_snapshot: blankSnapshot('contact-landlord-0001'),
    });
  });

  it('a landlord deposit with cents (1250.5) pre-fills and Create sends it - native validation never blocks it (planner PR2-3)', async () => {
    const user = userEvent.setup();
    getContact.mockResolvedValue({
      contactId: 'contact-landlord-0001',
      type: 'landlord',
      firstName: 'Rosa',
      lastName: 'Kim',
      req_deposit: 1250.5,
    });
    createUnit.mockResolvedValue(newUnit());
    setup({ landlordId: 'contact-landlord-0001' });
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    const amount = screen.getByLabelText('Fixed amount');
    expect(amount).toHaveValue(1250.5);
    // step="any": the default step of 1 would mark 1250.5 a step mismatch and
    // stop the submit before onSubmit runs.
    expect(amount).toHaveAttribute('step', 'any');
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()['deposit']).toBe(1250.5);
    expect(sentBody()['requirements_snapshot']).toMatchObject({
      landlordId: 'contact-landlord-0001',
      deposit: { deposit_one_month: null, deposit: 1250.5, deposit_flexible: null, deposit_notes: null },
    });
  });

  // Mutant follow-up (U10 M11): the dashboard renders under StrictMode, whose
  // first mount starts this read and aborts it at once; since main b222a4ac the
  // client drops a signalled request aborted in that tick (it rejects with the
  // signal's reason). That dropped read must leave the section loading - never
  // the failure line, never an enabled Create that would send no snapshot.
  it('StrictMode: the dropped first-mount read never shows the failure line; Create waits for the live read', async () => {
    const user = userEvent.setup();
    const held = { resolve: (_c: Contact): void => {} };
    const live = new Promise<Contact>((resolve) => {
      held.resolve = resolve;
    });
    // request() since main b222a4ac: one microtask, then a signal aborted in
    // that tick rejects with its reason.
    getContact.mockImplementation(async (_id: string, signal?: AbortSignal) => {
      await Promise.resolve();
      if (signal?.aborted === true) throw signal.reason;
      return live;
    });
    createUnit.mockResolvedValue(newUnit());
    render(
      <StrictMode>
        <MemoryRouter>
          <UnitCreateForm landlordId="contact-landlord-0001" onClose={vi.fn()} onCreated={vi.fn()} />
        </MemoryRouter>
      </StrictMode>,
    );
    await waitFor(() => expect(getContact).toHaveBeenCalledTimes(2));
    await act(async () => {}); // the dropped read settles
    expect(screen.queryByText(/^Couldn't load/)).toBeNull();
    expect(screen.getByText(/^Loading .+'s requirements\.\.\.$/)).toBeInTheDocument();
    expect(create()).toBeDisabled();
    await act(async () => held.resolve(ROSA_WITH_REQS));
    expect(await screen.findByText(FILLED)).toBeInTheDocument();
    expect(create()).toBeEnabled();
    await user.click(create());
    await waitFor(() => expect(createUnit).toHaveBeenCalledTimes(1));
    expect(sentBody()['requirements_snapshot']).toEqual(ROSA_SNAPSHOT);
  });

  // Code review RD-9, amended by worklist OR-33 (R2D-4): the note, the loading
  // line and the failure line name the landlord by the ONE landlord name rule
  // (landlordDisplayName, shared with the property Requirements card) - the
  // contact page header's name: first + last, else the primary of phones[],
  // never the company - so they agree with this form's own landlord picker.
  const KIM_REALTY: Contact = {
    contactId: 'contact-landlord-0001',
    type: 'landlord',
    company: 'Kim Realty',
    phones: [{ phone: '+14045550123', primary: true }],
    req_credit_requirements: '600+',
  };
  const PHONES_ONLY: Contact = {
    contactId: 'contact-landlord-0001',
    type: 'landlord',
    phones: [
      { phone: '+14045550111', primary: false },
      { phone: '+14045550100', primary: true },
    ],
    req_credit_requirements: '600+',
  };
  const NAMED_BY_THE_RULE: Array<[string, Contact, string]> = [
    ['a company-only landlord', KIM_REALTY, '(404) 555-0123'],
    ['a landlord with only phones[]', PHONES_ONLY, '(404) 555-0100'],
  ];

  // Code review R2D-4: one landlord, one name - the picker's committed value
  // and the note under the Requirements heading.
  it('the picker: a company-only landlord reads as the same name in the owner field and in the note', async () => {
    const user = userEvent.setup();
    getAllContacts.mockResolvedValue([KIM_REALTY, GENE]);
    setup();
    const owner = screen.getByRole('combobox', { name: 'Owning landlord' });
    await user.type(owner, '555-0123');
    await user.click(await screen.findByRole('option', { name: /\(404\) 555-0123/ }));
    expect(owner).toHaveValue('(404) 555-0123');
    expect(
      await screen.findByText("Filled in from (404) 555-0123's requirements. Change anything that is different for this property."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Kim Realty/)).toBeNull();
  });

  it.each(NAMED_BY_THE_RULE)('%s: the loading line and the note name it by the landlord name rule', async (_label, landlord, name) => {
    getAllContacts.mockResolvedValue([landlord]);
    const held = { resolve: (_c: Contact): void => {} };
    getContact.mockReturnValueOnce(
      new Promise<Contact>((resolve) => {
        held.resolve = resolve;
      }),
    );
    setup({ landlordId: 'contact-landlord-0001' });
    expect(await screen.findByText(`Loading ${name}'s requirements...`)).toBeInTheDocument();
    await act(async () => held.resolve(landlord));
    expect(
      await screen.findByText(`Filled in from ${name}'s requirements. Change anything that is different for this property.`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unknown contact/)).toBeNull();
    // The locked box names it the same way.
    expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Kim Realty/)).toBeNull();
  });

  it.each(NAMED_BY_THE_RULE)('%s: the failure line names it by the landlord name rule', async (_label, landlord, name) => {
    getAllContacts.mockResolvedValue([landlord]);
    getContact.mockRejectedValue(new ApiError(503, 'unavailable', 'unavailable'));
    setup({ landlordId: 'contact-landlord-0001' });
    expect(
      await screen.findByText(
        `Couldn't load ${name}'s requirements, so this property starts without them. You can apply them from the landlord page later.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unknown contact/)).toBeNull();
    expect(screen.queryByText(/Kim Realty/)).toBeNull();
  });
});

// --- Spec 2026-10-20 D10, D10a: the flyer tags and the D10 order ------------
describe('UnitCreateForm - flyer tags and the D10 order (spec 2026-10-20)', () => {
  const TAG = { on_flyer: 'On flyer', staff_only: 'Staff only' } as const;
  const PUBLIC_NOTE = 'Tenants see this on the public flyer.';
  const ADDRESS_PARTS = ['Street address', 'Apt / unit', 'City', 'State', 'ZIP'];

  /** The control(s) one D10a row labels (the picker path, where every row has one). */
  function controlsFor(label: string): HTMLElement[] {
    if (label === 'Address') return ADDRESS_PARTS.map((part) => screen.getByLabelText(part));
    if (label === 'Owning landlord' || label === 'Housing authorities') {
      return [screen.getByRole('combobox', { name: label })];
    }
    if (label === 'Voucher sizes accepted') return [screen.getByRole('group', { name: label })];
    return [screen.getByLabelText(label)];
  }
  function describers(control: HTMLElement): HTMLElement[] {
    return (control.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
  }
  const describedTexts = (control: HTMLElement): string[] => describers(control).map((el) => el.textContent ?? '');

  it.each(PROPERTY_FORM_FIELDS.map((f) => [f.label, f.flyer] as const))(
    '%s carries its %s tag, outside its accessible name',
    async (label, flyer) => {
      setup();
      await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
      for (const control of controlsFor(label)) {
        expect(describedTexts(control)).toContain(TAG[flyer]);
        const tag = describers(control).find((el) => el.textContent === TAG[flyer]);
        expect(tag?.closest('label')).toBeNull();
        if (label !== 'Address') expect(control).toHaveAccessibleName(label);
      }
    },
  );

  it('locked: the Owning landlord label carries its Staff only tag beside it (planner ruling C8)', async () => {
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    expect(screen.getByText('Owning landlord').parentElement).toHaveTextContent('Staff only');
  });

  it('the fields run in the D10 order, the owning landlord first', async () => {
    setup();
    await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
    const firsts = PROPERTY_FORM_FIELDS.map((f) => controlsFor(f.label)[0]);
    for (let i = 1; i < firsts.length; i += 1) {
      const before = firsts[i - 1];
      const after = firsts[i];
      if (before === undefined || after === undefined) throw new Error('a D10a field has no control');
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${PROPERTY_FORM_FIELDS[i - 1]?.label} before ${PROPERTY_FORM_FIELDS[i]?.label}`,
      ).toBeTruthy();
    }
  });

  it('a legend under the title explains both tags, and the public free-text boxes say tenants see them', async () => {
    setup({ landlordId: 'contact-landlord-0001' });
    await dialogReady();
    expect(screen.getByText('On flyer - tenants see it on the public flyer.')).toBeInTheDocument();
    expect(screen.getByText('Staff only - never leaves the dashboard.')).toBeInTheDocument();
    for (const label of ['Tenant-paid utilities', 'Accessibility', 'Lease terms', 'Pets (details)', 'Pet fee']) {
      expect(describedTexts(screen.getByLabelText(label)), label).toContain(PUBLIC_NOTE);
    }
  });
});
