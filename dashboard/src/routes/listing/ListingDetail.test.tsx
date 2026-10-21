import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, type UnitContact, type UnitPropertyContact } from '../../api/index.js';
import { listingRoster } from './buildListingFile.js';
import { BLANK } from '../contact/Card.js';
import type { ListingState } from './useListing.js';

const useListing = vi.fn();
vi.mock('./useListing.js', () => ({ useListing: (id: string) => useListing(id) }));

// The "Placements on this property" card resolves tenant names from useContacts.
const useContacts = vi.fn();
vi.mock('../contacts/useContacts.js', () => ({ useContacts: (filter: string) => useContacts(filter) }));

const deleteUnit = vi.fn();
const restoreUnit = vi.fn();
const updateUnit = vi.fn();
const setListingStatus = vi.fn();
// Used by the "Start placement" dialog (PlacementCreateForm) when opened.
const getAllUnits = vi.fn();
const getUnit = vi.fn();
const getAllContacts = vi.fn();
const getPlacementsBy = vi.fn();
const createPlacement = vi.fn();
// Direct-upload trio (unit-photos direct-upload R4): presign -> raw S3 POST -> confirm.
const presignUnitPhotos = vi.fn();
const uploadToPresignedPost = vi.fn();
const confirmUnitPhotos = vi.fn();
const removeUnitPhoto = vi.fn();
const setUnitPhotoCover = vi.fn();
// Contacts-card edit mode (contact-rosters Task 9): the two unit-contact writes.
const addUnitContact = vi.fn();
const removeUnitContact = vi.fn();
// The edit dialog's authorities picker reads the list (spec 2026-10-06 D6).
const getOrgList = vi.fn();
// last-heard-from 5.3: the "Sent to" outcome route and the tour form's create.
const setListingSendOutcome = vi.fn();
const createTour = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    deleteUnit: (...a: unknown[]) => deleteUnit(...a),
    restoreUnit: (...a: unknown[]) => restoreUnit(...a),
    updateUnit: (...a: unknown[]) => updateUnit(...a),
    setListingStatus: (...a: unknown[]) => setListingStatus(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
    createPlacement: (...a: unknown[]) => createPlacement(...a),
    presignUnitPhotos: (...a: unknown[]) => presignUnitPhotos(...a),
    uploadToPresignedPost: (...a: unknown[]) => uploadToPresignedPost(...a),
    confirmUnitPhotos: (...a: unknown[]) => confirmUnitPhotos(...a),
    removeUnitPhoto: (...a: unknown[]) => removeUnitPhoto(...a),
    setUnitPhotoCover: (...a: unknown[]) => setUnitPhotoCover(...a),
    addUnitContact: (...a: unknown[]) => addUnitContact(...a),
    removeUnitContact: (...a: unknown[]) => removeUnitContact(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
    setListingSendOutcome: (...a: unknown[]) => setListingSendOutcome(...a),
    createTour: (...a: unknown[]) => createTour(...a),
  };
});

import { ListingDetail } from './ListingDetail.js';

// Exposes the current router location as text (pathname + search) so a test can
// assert where a navigation landed, e.g. the "+ Send" card action.
function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <span data-testid="path">{`${loc.pathname}${loc.search}`}</span>;
}

function renderAt(unitId = 'u1', search = ''): void {
  render(
    <MemoryRouter initialEntries={[`/listings/${unitId}${search}`]}>
      <Routes>
        <Route path="/listings/:unitId" element={<ListingDetail />} />
        <Route path="*" element={<div />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

const READY: ListingState = {
  status: 'ready',
  setUnit: vi.fn(),
  setRecipientRow: vi.fn(),
  unit: {
    unitId: 'u1',
    landlordId: 'll1',
    status: 'available',
    beds: 2,
    baths: 1,
    rent_min: 1400,
    rent_max: 1600,
    payment_standard: 1550,
    deposit: 1400,
    // LEGACY: only the retired `jurisdiction` string is stored, so the Housing
    // authorities row below is produced by read-time synthesis (spec section 8).
    jurisdiction: 'Atlanta',
    area: 'West End',
    utilities: 'Electric and gas',
    accessibility: 'Ground floor',
    pets: 'Cats only',
    lease_terms: '12-month minimum',
    application_fee: 25,
    same_day_rta: true,
    voucher_size_accepted: 2,
    video_url: 'https://example.com/tour.mp4',
    tour_process: 'Text the landlord to arrange access.',
    application_process: 'Apply via the property portal.',
    media: ['units/u1/cover.jpg', 'units/u1/photo-2.jpg'],
    // Resolved display media (presign-per-read): the cover resolves to a URL, the
    // second entry is currently UNRESOLVABLE (no url -> "unavailable" tile).
    mediaDisplay: [
      { entry: 'units/u1/cover.jpg', url: 'https://cdn.example/p/cover.jpg?sig=1' },
      { entry: 'units/u1/photo-2.jpg' },
    ],
  },
  landlord: { contactId: 'll1', type: 'landlord', firstName: 'James', lastName: 'Porter' } as never,
  roster: [
    {
      contactId: 'll1',
      name: 'James Porter',
      role: 'landlord',
      roleLabel: 'Landlord',
      company: 'Porter Properties',
      primaryContact: true,
      fallback: true,
    },
  ],
  placementsOnUnit: [{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'awaiting_approval' }],
  related: {
    status: 'ready',
    rows: [{ unitId: 'u2', status: 'occupied', relation: 'same_landlord', label: 'Same landlord' }],
  },
  recipients: { status: 'pending' },
  similar: { status: 'pending' },
  activity: { status: 'pending' },
  tours: { status: 'pending' },
};

// Default contacts so the placement card can resolve tenantId 't1' → "Fixture Tenant"
// (a name unique to this file, so it can't collide with other rows' contact names).
// The page asks for BOTH the live ('all') and soft-deleted ('deleted') lists —
// answer per filter (deleted empty by default).
beforeEach(() => {
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: [] });
  useContacts.mockImplementation((filter: string) =>
    filter === 'deleted'
      ? { status: 'ready', contacts: [] }
      : {
          status: 'ready',
          contacts: [
            { contactId: 't1', type: 'tenant', status: 'active', firstName: 'Fixture', lastName: 'Tenant', phone: '+14045550111' },
          ],
        },
  );
});

afterEach(() => vi.restoreAllMocks());

/** The deleted banner's sentence after a restore choice answered 409
 *  restore_landlord_not_needed while the property is still deleted (spec
 *  revision 7 section 4 "Dashboard copy for section 4"), byte for byte. */
const RESTORE_LANDLORD_CHANGED = "This property's landlord changed while you were choosing. Choose Restore again.";

/** Change the property status via the interactive pill: open it, then pick an option. */
async function chooseStatus(
  user: ReturnType<typeof userEvent.setup>,
  optionLabel: string,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /Property status/i }));
  await user.click(screen.getByRole('menuitemradio', { name: optionLabel }));
}

/** The card whose heading starts with `title` (a card heading also carries
 *  its action's accessible name, so match the start). */
function cardTitled(title: RegExp): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
}

describe('ListingDetail', () => {
  it('shows a spinner while loading', () => {
    useListing.mockReturnValue({ ...READY, status: 'loading', unit: null });
    renderAt();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error alert on failure', () => {
    useListing.mockReturnValue({ ...READY, status: 'error', unit: null });
    renderAt();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders the header: address, status badge, facts, and actions', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, address: { line1: '1450 Joseph Blvd NW' } },
    });
    renderAt();
    const heading = screen.getByRole('heading', { name: /1450 Joseph Blvd NW/ });
    expect(heading).toBeInTheDocument();
    // Status now lives in the interactive pill (a menu-button labelled "Property
    // status"), not a badge in the heading.
    expect(screen.getByRole('button', { name: /Property status/i })).toHaveTextContent('Available');
    expect(screen.getByText((t) => t.includes('2 BR') && t.includes('1 BA') && t.includes('$1,400') && t.includes('1,600/mo'))).toBeInTheDocument();
    // Broadcast + Start placement moved into the ⋯ menu (asserted in its own test).
    // Edit is not a standalone HEADER button either — it's under the ⋯ menu — but it
    // IS available inline on the Property details + Requirements + Notes +
    // Tour & application + Contacts cards (five real, clickable CardAction
    // buttons - Contacts gained its "Edit contacts" toggle with the roster
    // editor, Requirements its own Edit (D10); the More-actions menu's Edit is
    // hidden until open).
    expect(screen.getAllByRole('button', { name: /Edit/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: /More actions/ })).toBeInTheDocument();
  });

  it('opens the edit dialog from the ? menu and PATCHes only the changed fields', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({ ...READY, setUnit: vi.fn() });
    updateUnit.mockResolvedValue({ ...READY.unit });
    renderAt();

    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Edit property/i }));

    // The edit dialog is open with the current values prefilled.
    const dialog = screen.getByRole('dialog', { name: /Edit property/i });
    const utilities = within(dialog).getByLabelText(/Tenant-paid utilities/i);
    expect(utilities).toHaveValue('Electric and gas');

    await user.clear(utilities);
    await user.type(utilities, 'Gas only');
    await user.click(within(dialog).getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Gas only' });
  });

  it('shows the public flyer link + copy for an available property', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('link', { name: /View flyer/ })).toHaveAttribute('href', '/p/u1');
    expect(screen.getByRole('button', { name: /Copy public link/ })).toBeInTheDocument();
    expect(screen.queryByText(/arrives with the new public routes/)).not.toBeInTheDocument();
  });

  it('shows an honest note for a non-available property (flyer not public yet)', () => {
    useListing.mockReturnValue({ ...READY, unit: { ...READY.unit, status: 'setup' } });
    renderAt();
    expect(
      screen.getByText(/public flyer goes live when this property is Available/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View flyer/ })).not.toBeInTheDocument();
  });

  it('renders property details and the Housing authorities row', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    const details = cardTitled(/^Property details/);
    expect(within(details).getByText('$1,550')).toBeInTheDocument(); // payment standard
    // Utilities carry tenant-paid semantics: the label says WHO pays, the value
    // lists WHICH utilities.
    expect(within(details).getByText('Tenant-paid utilities')).toBeInTheDocument();
    expect(within(details).getByText('Electric and gas')).toBeInTheDocument();
    // Lease terms are a per-unit fact (moved off the landlord contact 2026-07-10).
    expect(within(details).getByText('Lease terms')).toBeInTheDocument();
    expect(within(details).getByText('12-month minimum')).toBeInTheDocument();
    expect(within(details).getByText('Same-day RTA')).toBeInTheDocument();
    // D4: the RECORDED voucher sizes, as a list (a stored single number reads too).
    expect(within(details).getByText('Voucher sizes accepted')).toBeInTheDocument();
    expect(within(details).getByText('2 BR')).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: 'Watch video' })).toHaveAttribute(
      'href',
      'https://example.com/tour.mp4',
    );
    // ONE authorities row from the synthesized list - the legacy `jurisdiction`
    // value shows here now (spec section 8).
    expect(within(details).getByText('Housing authorities')).toBeInTheDocument();
    expect(within(details).getByText('Atlanta')).toBeInTheDocument();
    // Both retired surfaces are gone: the Jurisdiction KV and the accepted
    // vouchers bulleted list.
    expect(screen.queryByText('Jurisdiction')).toBeNull();
    expect(screen.queryByRole('list', { name: /Accepted vouchers/i })).toBeNull();
    expect(screen.queryByText('Accepted vouchers')).toBeNull();
  });

  it('D10: Property details gains Subzone and Washer / dryer; Deposit, Pets and Application fee move to Requirements', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, subzone: 'SE11', washer_dryer: 'hookups' },
    });
    renderAt();
    const details = cardTitled(/^Property details/);
    expect(within(details).getByText('Subzone')).toBeInTheDocument();
    expect(within(details).getByText('SE11')).toBeInTheDocument();
    expect(within(details).getByText('Washer / dryer')).toBeInTheDocument();
    expect(within(details).getByText('Hookups')).toBeInTheDocument();
    expect(within(details).queryByText('Deposit')).toBeNull();
    expect(within(details).queryByText('Pets')).toBeNull();
    expect(within(details).queryByText('Application fee')).toBeNull();
    const requirements = cardTitled(/^Requirements/);
    expect(within(requirements).getByRole('group', { name: 'Deposit' })).toHaveTextContent('$1,400');
    expect(within(requirements).getByRole('group', { name: 'Pets' })).toHaveTextContent('Cats only');
    expect(within(requirements).getByRole('group', { name: 'Application fee' })).toHaveTextContent('$25');
  });

  it('shows several recorded voucher sizes, Studio first', () => {
    useListing.mockReturnValue({ ...READY, unit: { ...READY.unit!, voucher_size_accepted: [3, 0, 2] } });
    renderAt();
    expect(within(cardTitled(/^Property details/)).getByText('Studio, 2 BR, 3 BR')).toBeInTheDocument();
  });

  it('joins a multi-authority list into the Housing authorities row', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit, accepted_authorities: ['Atlanta (AHA)', 'DCA'] },
    });
    renderAt();
    expect(screen.getByText('Atlanta (AHA), DCA')).toBeInTheDocument();
    // The stored list wins over the legacy string it replaced.
    expect(screen.queryByText('Atlanta')).toBeNull();
  });

  it('tour type and process are the Touring requirement; the tour card keeps only the application process (D10)', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit, tour_type: 'landlord_led' },
    } as ListingState);
    renderAt();
    const touring = within(cardTitled(/^Requirements/)).getByRole('group', { name: 'Touring' });
    expect(touring).toHaveTextContent('Landlord-led; Text the landlord to arrange access.');
    const process = cardTitled(/^Tour & application process/);
    expect(within(process).getByText('Apply via the property portal.')).toBeInTheDocument();
    expect(within(process).queryByText('Tour type')).toBeNull();
    expect(within(process).queryByText('Text the landlord to arrange access.')).toBeNull();
  });

  it('the tour card shows its empty state when no application process is recorded', () => {
    // READY.unit records a tour process: it lives under Requirements > Touring
    // now (D10), so the empty state names the APPLICATION process only (code
    // review RD-5) and never says no process is recorded at all.
    useListing.mockReturnValue({ ...READY, unit: { ...READY.unit!, application_process: undefined } });
    renderAt();
    const process = cardTitled(/^Tour & application process/);
    expect(within(process).getByText('No application process recorded yet.')).toBeInTheDocument();
    expect(within(process).queryByText('No process recorded yet.')).toBeNull();
  });

  it('renders the Notes card: property notes when present, an empty state with "+ Add" otherwise', () => {
    // No notes (the READY fixture) → empty state, and the action reads "+ Add".
    useListing.mockReturnValue(READY);
    const { unmount } = render(
      <MemoryRouter initialEntries={['/listings/u1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit property notes' })).toHaveTextContent('+ Add');
    unmount();

    // With notes → the full text renders (author's line breaks preserved by
    // NotesText) and the action reads "Edit".
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, notes: 'In-unit washer/dryer.\nNo dishwasher.' },
    });
    renderAt();
    expect(screen.getByText(/In-unit washer\/dryer\./)).toBeInTheDocument();
    expect(screen.queryByText('No notes yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit property notes' })).toHaveTextContent('Edit');
  });

  it('shows "Voucher sizes accepted" with the blank marker when none is recorded - never the bedrooms fallback (D4)', () => {
    const { voucher_size_accepted: _omit, ...rest } = READY.unit!;
    useListing.mockReturnValue({ ...READY, unit: rest }); // beds: 2 is still on the unit
    renderAt();
    const row = within(cardTitled(/^Property details/)).getByText('Voucher sizes accepted').parentElement as HTMLElement;
    expect(row).toHaveTextContent(BLANK);
    expect(row).not.toHaveTextContent('2 BR');
  });

  it('the Requirements card compares with the landlord OF RECORD: tags and the no-requirements note (D6)', () => {
    // READY's landlord IS the landlord of record (ll1) and has no requirements yet.
    useListing.mockReturnValue(READY);
    renderAt();
    const requirements = cardTitled(/^Requirements/);
    expect(within(requirements).getByText('James Porter has no requirements recorded yet.')).toBeInTheDocument();
    const pets = within(requirements).getByRole('group', { name: 'Pets' });
    expect(within(pets).getByText('Set on this property')).toBeInTheDocument();
    expect(within(pets).getByText('Landlord: blank')).toBeInTheDocument();
  });

  it('the Requirements card never compares with a held contact that is not the landlord of record', () => {
    // A roster claim / restore changed landlordId and the re-read has not landed.
    useListing.mockReturnValue({
      ...READY,
      landlord: { contactId: 'll-previous', type: 'landlord', firstName: 'Old', lastName: 'Owner' } as never,
    });
    renderAt();
    const requirements = cardTitled(/^Requirements/);
    expect(within(requirements).queryByText(/has no requirements recorded yet/)).toBeNull();
    expect(within(requirements).queryByText('Set on this property')).toBeNull();
    expect(within(requirements).queryByText(/^Landlord: /)).toBeNull();
  });

  it('the Contacts fallback row never names a held contact that is not the landlord of record (OR-22)', async () => {
    // A restore's re-read with no contacts[] becomes the Contacts card's
    // roster source, so its one row is synthesized from the unit's landlordId
    // plus the held landlord contact. Until useListing's re-read lands, that
    // contact can be the PREVIOUS landlord's: the row stays id-only rather than
    // put the old name and company on the landlord of record's row.
    const user = userEvent.setup();
    restoreUnit.mockReset().mockResolvedValue({ ...READY.unit });
    getUnit.mockReset().mockResolvedValue({ ...READY.unit });
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      landlord: {
        contactId: 'll-previous',
        type: 'landlord',
        firstName: 'Old',
        lastName: 'Owner',
        company: 'Old Owner Co',
      } as never,
      setUnit: vi.fn(),
    });
    renderAt();
    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    // The re-read is now the roster source: the row is the landlord of
    // record's id, linked, and no borrowed name or company shows anywhere.
    expect(await screen.findByRole('link', { name: /^ll1\b/ })).toHaveAttribute('href', '/contacts/ll1');
    expect(screen.queryByText(/Old Owner/)).toBeNull();
  });

  it('no landlord contact: the Requirements card shows values only', () => {
    useListing.mockReturnValue({ ...READY, landlord: null });
    renderAt();
    const requirements = cardTitled(/^Requirements/);
    expect(within(requirements).getByRole('group', { name: 'Pets' })).toHaveTextContent('Cats only');
    expect(within(requirements).queryByText('Set on this property')).toBeNull();
    expect(within(requirements).queryByText(/^Landlord/)).toBeNull();
  });

  it('the Requirements card Edit opens the property edit form; a deleted property offers no Edit', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    const { unmount } = render(
      <MemoryRouter initialEntries={['/listings/u1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Edit property requirements' }));
    expect(screen.getByRole('dialog', { name: /Edit property/i })).toBeInTheDocument();
    unmount();

    useListing.mockReturnValue({ ...READY, unit: { ...READY.unit!, deleted_at: '2026-07-01T00:00:00.000Z' } });
    renderAt();
    expect(screen.queryByRole('button', { name: 'Edit property requirements' })).toBeNull();
  });

  it('does not render a video link for a non-http(s) (javascript:) URL — XSS guard', () => {
    useListing.mockReturnValue({ ...READY, unit: { ...READY.unit, video_url: 'javascript:alert(1)' } });
    renderAt();
    expect(screen.queryByRole('link', { name: 'Watch video' })).not.toBeInTheDocument();
  });

  it('links roster rows to the contact page and placements to the placement page', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('link', { name: /James Porter/ })).toHaveAttribute(
      'href',
      '/contacts/ll1',
    );
    expect(screen.getByRole('link', { name: /Awaiting approval/ })).toHaveAttribute('href', '/placements/c1');
  });

  it('links related properties to their property page', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('link', { name: /u2/ })).toHaveAttribute('href', '/listings/u2');
  });

  it('shows the tenant NAME (not the raw id) for a placement on this property', () => {
    useListing.mockReturnValue(READY); // placementsOnUnit tenantId 't1'
    renderAt();
    const row = screen.getByRole('link', { name: /Fixture Tenant/ });
    expect(row).toHaveAttribute('href', '/placements/c1');
    // The raw tenantId must never be surfaced.
    expect(screen.queryByText('t1')).not.toBeInTheDocument();
  });

  it('resolves a SOFT-DELETED tenant to their name on the placements card (never the raw id)', () => {
    // The placement outlived its tenant (deleted after move-in/loss): the contact
    // exists ONLY in the deleted list, and the row must still show the name.
    useContacts.mockImplementation((filter: string) =>
      filter === 'deleted'
        ? {
            status: 'ready',
            contacts: [
              { contactId: 't-del', type: 'tenant', status: 'active', firstName: 'Dora', lastName: 'Departed', phone: '+14045550999', deleted_at: '2026-07-20T00:00:00Z' },
            ],
          }
        : { status: 'ready', contacts: [] },
    );
    useListing.mockReturnValue({
      ...READY,
      placementsOnUnit: [{ placementId: 'c9', tenantId: 't-del', unitId: 'u1', stage: 'moved_in' }],
    });
    renderAt();
    const row = screen.getByRole('link', { name: /Dora Departed/ });
    expect(row).toHaveAttribute('href', '/placements/c9');
    expect(screen.queryByText('t-del')).not.toBeInTheDocument();
  });

  it('resolves a PARTNER contact to their name on the placements card - the widened fan-out reaches this map', () => {
    // Same id->name map as the tours list: TYPES_FOR.all gained 'partner' on
    // 2026-08-18, and without partners in the resolution set a placement row
    // pointing at one renders its raw id.
    // See docs/issues/partner-widening-consumer-test-gap.md.
    useContacts.mockImplementation((filter: string) =>
      filter === 'deleted'
        ? { status: 'ready', contacts: [] }
        : {
            status: 'ready',
            contacts: [
              { contactId: 'c-partner', type: 'partner', firstName: 'Renata', lastName: 'Cole', phone: '+14045550190' },
            ],
          },
    );
    useListing.mockReturnValue({
      ...READY,
      placementsOnUnit: [{ placementId: 'p-part', tenantId: 'c-partner', unitId: 'u1', stage: 'moved_in' }],
    });
    renderAt();
    const row = screen.getByRole('link', { name: /Renata Cole/ });
    expect(row).toHaveAttribute('href', '/placements/p-part');
    expect(screen.queryByText('c-partner')).not.toBeInTheDocument();
  });

  it('renders the "Tours on this property" card: tenant name + date rows linking to the tour, status on the right', () => {
    useListing.mockReturnValue({
      ...READY,
      tours: {
        status: 'ready',
        rows: [
          // Pre-sorted by the hook (unbooked first, then newest) — the card renders as given.
          { tourId: 'tour-1', tenantId: 't1', unitId: 'u1', status: 'requested' },
          {
            tourId: 'tour-2',
            tenantId: 't1',
            unitId: 'u1',
            status: 'toured',
            scheduledAt: '2026-07-05T15:00:00.000Z',
          },
        ],
      },
    });
    renderAt();

    expect(screen.getByRole('heading', { name: /Tours on this property/ })).toBeInTheDocument();
    // Unbooked request: tenant name + "Needs booking", status label on the right.
    const requested = screen.getByRole('link', { name: /Fixture Tenant.*Needs booking.*Requested/s });
    expect(requested).toHaveAttribute('href', '/tours/tour-1');
    // Booked + toured: carries the date and the Toured status.
    const toured = screen.getByRole('link', { name: /Fixture Tenant.*Toured/s });
    expect(toured).toHaveAttribute('href', '/tours/tour-2');
  });

  it('an undated TOURED tour row on the Tours card reads "Undated" - it is not a request, so never "Needs booking"', () => {
    useListing.mockReturnValue({
      ...READY,
      tours: {
        status: 'ready',
        rows: [{ tourId: 'tour-3', tenantId: 't1', unitId: 'u1', status: 'toured' }],
      },
    });
    renderAt();

    const undated = screen.getByRole('link', { name: /Fixture Tenant.*Undated.*Toured/s });
    expect(undated).toHaveAttribute('href', '/tours/tour-3');
    expect(undated).not.toHaveTextContent(/Needs booking/);
  });

  it('shows the tours empty state when the property has no tours', () => {
    useListing.mockReturnValue({ ...READY, tours: { status: 'ready', rows: [] } });
    renderAt();
    expect(screen.getByText('No tours on this property yet.')).toBeInTheDocument();
  });

  it('caps related properties at 4 with a "Show more" toggle that expands + collapses', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      unitId: `rel-${i + 1}`,
      status: 'available' as const,
      relation: 'same_landlord' as const,
      label: 'Same landlord',
    }));
    useListing.mockReturnValue({ ...READY, related: { status: 'ready', rows } });
    const user = userEvent.setup();
    renderAt();

    // Only the first 4 render; #5-#8 are hidden behind the toggle.
    expect(screen.getByRole('link', { name: /rel-4/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /rel-5/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show 4 more' }));

    // Expanded: all 8 render and the toggle flips to "Show less".
    expect(screen.getByRole('link', { name: /rel-5/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /rel-8/ })).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: 'Show less' });

    await user.click(collapse);
    expect(screen.queryByRole('link', { name: /rel-5/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 4 more' })).toBeInTheDocument();
  });

  it('renders pending panels for Sent-to-tenants (C4) and Similar (C6)', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getAllByText('Arrives with the backend.').length).toBeGreaterThanOrEqual(2);
  });

  it('renders "Sent to" rows: identity links to the contact, no chip without a tour', () => {
    useListing.mockReturnValue({
      ...READY,
      recipients: {
        status: 'ready',
        rows: [
          {
            contactId: 'c-t9',
            unitId: 'u1',
            sentAt: '2026-06-30T10:00:00Z',
            via: 'broadcast',
            outcome: 'no_reply',
            interestedSupported: true,
            interestedMode: 'route',
            eligible: true,
          },
        ],
      },
    });
    renderAt();
    const identity = screen.getByRole('link', { name: 'c-t9' });
    expect(identity).toHaveAttribute('href', '/contacts/c-t9');
    // The dead response label is gone (no "No reply"/"Interested"/"Not a fit").
    expect(screen.queryByText('No reply')).not.toBeInTheDocument();
    // No qualifying tour -> no tour chip.
    expect(screen.queryByRole('link', { name: /^Tour|^Toured$/ })).not.toBeInTheDocument();
  });

  it('identifies a "Sent to" row by the recipient NAME when the wire provides one', () => {
    useListing.mockReturnValue({
      ...READY,
      recipients: {
        status: 'ready',
        rows: [
          {
            contactId: 'c-t9',
            unitId: 'u1',
            sentAt: '2026-06-30T10:00:00Z',
            via: 'broadcast',
            tenantName: 'Brianna Whitfield',
            outcome: 'no_reply',
            interestedSupported: true,
            interestedMode: 'route',
            eligible: true,
          },
        ],
      },
    });
    renderAt();
    const identity = screen.getByRole('link', { name: 'Brianna Whitfield' });
    expect(identity).toHaveAttribute('href', '/contacts/c-t9');
    // The raw id never renders once a name is known.
    expect(screen.queryByText('c-t9')).not.toBeInTheDocument();
  });

  it('caseworkers D20: a resolved non-tenant "Sent to" row shows its displayKind beside the name; tenant and unresolved rows show none', () => {
    useListing.mockReturnValue({
      ...READY,
      recipients: {
        status: 'ready',
        rows: [
          { contactId: 'c-ten', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast', tenantName: 'Tia Moss', type: 'tenant', outcome: 'no_reply', interestedSupported: true, interestedMode: 'route', eligible: true },
          { contactId: 'c-cw', unitId: 'u1', sentAt: '2026-06-29T10:00:00Z', via: 'broadcast', tenantName: 'Cora Reyes', type: 'partner', role: 'Caseworker', outcome: 'no_reply', interestedSupported: false, interestedMode: 'route', eligible: true },
          { contactId: 'c-pt', unitId: 'u1', sentAt: '2026-06-28T10:00:00Z', via: 'broadcast', tenantName: 'Pat Lin', type: 'partner', outcome: 'no_reply', interestedSupported: false, interestedMode: 'route', eligible: true },
          { contactId: 'c-ll', unitId: 'u1', sentAt: '2026-06-27T10:00:00Z', via: 'broadcast', tenantName: 'Lee Park', type: 'landlord', outcome: 'no_reply', interestedSupported: false, interestedMode: 'route', eligible: true },
          { contactId: 'c-gone', unitId: 'u1', sentAt: '2026-06-26T10:00:00Z', via: 'broadcast', outcome: 'no_reply', interestedSupported: false, eligible: false, recipientMissing: true },
        ],
      },
    });
    renderAt();
    const card = screen.getByRole('heading', { name: /^Sent to\b/ }).closest('section') as HTMLElement;
    const rowOf = (name: string): HTMLElement =>
      within(card).getByRole('link', { name }).closest('div') as HTMLElement;
    // The label is OUTSIDE the link: the link's name stays the person's name.
    expect(within(rowOf('Cora Reyes')).getByText('Caseworker')).toBeInTheDocument();
    expect(within(rowOf('Pat Lin')).getByText('Partner')).toBeInTheDocument();
    expect(within(rowOf('Lee Park')).getByText('Landlord')).toBeInTheDocument();
    // Tenant and unresolved rows carry NO kind label (rows grew dates and an
    // outcome chip, so the old textContent-equals-name check was rewritten).
    for (const name of ['Tia Moss', 'c-gone']) {
      for (const label of ['Tenant', 'Partner', 'Caseworker', 'Landlord']) {
        expect(within(rowOf(name)).queryByText(label)).not.toBeInTheDocument();
      }
    }
  });

  it('renders each tour-chip state on "Sent to" rows, linking to the tour', () => {
    useListing.mockReturnValue({
      ...READY,
      recipients: {
        status: 'ready',
        rows: [
          { contactId: 'c-r', unitId: 'u1', sentAt: '2026-06-30T10:00:00Z', via: 'individual', tour: { tourId: 't-a', state: 'requested' }, outcome: 'interested', interestedSupported: true, interestedMode: 'route', eligible: true },
          { contactId: 'c-s', unitId: 'u1', sentAt: '2026-06-29T10:00:00Z', via: 'broadcast', tour: { tourId: 't-b', state: 'scheduled' }, outcome: 'interested', interestedSupported: true, interestedMode: 'route', eligible: true },
          { contactId: 'c-t', unitId: 'u1', sentAt: '2026-06-28T10:00:00Z', via: 'broadcast', tour: { tourId: 't-c', state: 'toured' }, outcome: 'interested', interestedSupported: true, interestedMode: 'route', eligible: true },
        ],
      },
    });
    renderAt();
    expect(screen.getByRole('link', { name: 'Tour requested' })).toHaveAttribute('href', '/tours/t-a');
    expect(screen.getByRole('link', { name: 'Tour scheduled' })).toHaveAttribute('href', '/tours/t-b');
    expect(screen.getByRole('link', { name: 'Toured' })).toHaveAttribute('href', '/tours/t-c');
  });

  it('renders Activity rows: staff copy labels, times, and contact link-outs', () => {
    useListing.mockReturnValue({
      ...READY,
      activity: {
        status: 'ready',
        rows: [
          {
            id: '2026-07-02T14:30:00.000Z#000002',
            at: '2026-07-02T14:30:00.000Z',
            type: 'unit_contact_added',
            contactId: 'c-t1',
            contactName: 'Tina Renter',
            role: 'pm',
          },
          {
            id: '2026-07-01T09:00:00.000Z#000001',
            at: '2026-07-01T09:00:00.000Z',
            type: 'unit_updated',
            fields: ['rent_min', 'deposit'],
          },
          {
            id: '2026-06-30T09:00:00.000Z#000000',
            at: '2026-06-30T09:00:00.000Z',
            type: 'listing_status_changed',
            from: 'setup',
            to: 'available',
            source: 'manual',
          },
        ],
      },
    });
    renderAt();
    // A contact-referencing event links out to the tenant's contact file.
    expect(screen.getByRole('link', { name: /Contact added/ })).toHaveAttribute(
      'href',
      '/contacts/c-t1',
    );
    expect(screen.getByText(/Tina Renter/)).toBeInTheDocument();
    // Edit event: label + humanized changed fields.
    expect(screen.getByText('Property updated')).toBeInTheDocument();
    expect(screen.getByText('Rent min, Deposit')).toBeInTheDocument();
    // Status event with the from → to detail.
    expect(screen.getByText('Status changed to Available')).toBeInTheDocument();
    expect(screen.getByText(/from Setup/)).toBeInTheDocument();
  });

  it('renders "No activity yet." for a real-but-empty Activity trail', () => {
    useListing.mockReturnValue({ ...READY, activity: { status: 'ready', rows: [] } });
    renderAt();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });

  it('renders an honest error row when Activity fails to load', () => {
    useListing.mockReturnValue({ ...READY, activity: { status: 'error' } });
    renderAt();
    expect(screen.getByText(/couldn.t load activity/i)).toBeInTheDocument();
  });

  it('renders the gallery from mediaDisplay: a resolved entry as an image, an unresolved one as an "unavailable" tile', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    const photos = screen.getByRole('heading', { name: 'Photos' }).closest('section') as HTMLElement;
    // The resolved entry renders an <img> with its (presigned) display URL.
    const imgs = within(photos).getAllByRole('img');
    expect(imgs.some((i) => i.getAttribute('src') === 'https://cdn.example/p/cover.jpg?sig=1')).toBe(true);
    // The unresolved entry renders an honest "unavailable" tile (no img).
    expect(within(photos).getByLabelText(/Property photo 2 \(unavailable\)/)).toBeInTheDocument();
    // The "+ Add" affordance is present (and enabled below the cap).
    expect(within(photos).getByRole('button', { name: /Add/ })).toBeEnabled();
  });

  it('uses the cover (first mediaDisplay url) as the hero image', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    const hero = screen.getByRole('img', { name: /hero/ });
    expect(hero).toHaveAttribute('src', 'https://cdn.example/p/cover.jpg?sig=1');
  });

  // A presign grant per file, in order (the server preserves order). The direct
  // POST target is a stand-in MinIO endpoint the mock never actually hits.
  function grantsFor(files: File[]): { key: string; post: { url: string; fields: Record<string, string> } }[] {
    return files.map((_, i) => ({
      key: `unit-media/u1/key-${i}`,
      post: { url: 'https://minio.local/hc-media', fields: { key: `unit-media/u1/key-${i}` } },
    }));
  }

  it('the "+ Add" flow presigns, POSTs the file directly to S3, then confirms and applies the returned unit', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    const updated = {
      ...READY.unit!,
      mediaDisplay: [
        ...READY.unit!.mediaDisplay!,
        { entry: 'unit-media/u1/key-0', url: 'https://cdn.example/p/new.jpg?sig=9' },
      ],
    };
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(updated);
    renderAt();

    const file = new File(['x'], 'porch.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(presignUnitPhotos).toHaveBeenCalledWith('u1', [file]));
    // The raw S3 POST carries the grant's post target + the File itself.
    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(1));
    expect(uploadToPresignedPost.mock.calls[0]![1]).toBe(file);
    // Confirm records the uploaded key and the returned unit is applied in place.
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledWith('u1', ['unit-media/u1/key-0']));
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(updated));
  });

  it('a multi-file selection POSTs every file directly then confirms all uploaded keys in ONE wave', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const files = Array.from({ length: 3 }, (_, i) => new File(['x'], `p-${i}.jpg`, { type: 'image/jpeg' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(3));
    // One wave (<= 20 files) -> one presign, one confirm carrying all three keys.
    expect(presignUnitPhotos).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledTimes(1));
    const confirmedKeys = (confirmUnitPhotos.mock.calls[0]![1] as string[]).slice().sort();
    expect(confirmedKeys).toEqual(['unit-media/u1/key-0', 'unit-media/u1/key-1', 'unit-media/u1/key-2']);
    expect(setUnit).toHaveBeenCalledTimes(1);
  });

  it('a selection larger than the wave size uploads in sequential 20-file waves', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const files = Array.from({ length: 25 }, (_, i) => new File(['x'], `p-${i}.jpg`, { type: 'image/jpeg' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    // Two waves: 20 then 5 -> two presign calls, two confirm calls, 25 direct POSTs.
    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(25));
    expect(presignUnitPhotos).toHaveBeenCalledTimes(2);
    const waveSizes = presignUnitPhotos.mock.calls.map((c) => (c[1] as File[]).length);
    expect(waveSizes).toEqual([20, 5]);
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledTimes(2));
    // The unit state applied after EACH wave (progressive rendering).
    expect(setUnit).toHaveBeenCalledTimes(2);
  });

  it('a partial upload failure confirms the successes and reports "Uploaded N of M"', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    // The 2nd file's direct POST fails; the other two reach S3.
    uploadToPresignedPost
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError(403, 's3_upload_failed', 's3_upload_failed'))
      .mockResolvedValueOnce(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const files = Array.from({ length: 3 }, (_, i) => new File(['x'], `p-${i}.jpg`, { type: 'image/jpeg' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Uploaded 2 of 3/));
    // Confirm still recorded the two that made it; the returned unit is applied.
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledTimes(1));
    expect(confirmUnitPhotos.mock.calls[0]![1] as string[]).toHaveLength(2);
    expect(setUnit).toHaveBeenCalledTimes(1);
  });

  it('surfaces the mapped server error when PRESIGN is rejected (nothing uploaded or confirmed)', async () => {
    useListing.mockReturnValue({ ...READY, setUnit: vi.fn() });
    presignUnitPhotos.mockRejectedValue(
      new ApiError(400, 'unsupported_media_type', 'unsupported_media_type'),
    );
    renderAt();

    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/JPEG, PNG, GIF, or WebP/i));
    expect(uploadToPresignedPost).not.toHaveBeenCalled();
    expect(confirmUnitPhotos).not.toHaveBeenCalled();
  });

  it('surfaces the mapped server error when CONFIRM is rejected (cap re-guard race)', async () => {
    useListing.mockReturnValue({ ...READY, setUnit: vi.fn() });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockRejectedValue(
      new ApiError(400, 'photo_cap_exceeded', 'photo_cap_exceeded'),
    );
    renderAt();

    const file = new File(['x'], 'porch.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/past the 100-photo limit/i));
  });

  /** jsdom File.size derives from content; override it so a 1-byte body can
   *  stand in for a 26MB photo. */
  function photoOfSize(name: string, bytes: number): File {
    const f = new File(['x'], name, { type: 'image/jpeg' });
    Object.defineProperty(f, 'size', { value: bytes });
    return f;
  }

  it('drops a >20MB file with a NAMED message and uploads the rest', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const ok = photoOfSize('ok.jpg', 1 * 1024 * 1024);
    const huge = photoOfSize('backyard.jpg', 27262976); // 26.0MB
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [ok, huge] } });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'backyard.jpg is 26.0MB - the limit is 20MB per photo.',
      ),
    );
    // Only the in-limit file was presigned + uploaded.
    expect(presignUnitPhotos).toHaveBeenCalledTimes(1);
    expect((presignUnitPhotos.mock.calls[0]![1] as File[]).map((f) => f.name)).toEqual(['ok.jpg']);
    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(1));
  });

  it('confirms >5MB files in their OWN requests (one transcode per request) and small files as a batch', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const files = [
      photoOfSize('a.jpg', 1 * 1024 * 1024),
      photoOfSize('b.jpg', 8 * 1024 * 1024), // > 5MB -> its own confirm
      photoOfSize('c.jpg', 2 * 1024 * 1024),
    ];
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledTimes(2));
    const batches = confirmUnitPhotos.mock.calls.map((c) => (c[1] as string[]).slice().sort());
    // One batch with BOTH small keys (indexes 0 + 2), one singleton with the big key (index 1).
    expect(batches).toContainEqual(['unit-media/u1/key-0', 'unit-media/u1/key-2']);
    expect(batches).toContainEqual(['unit-media/u1/key-1']);
    // Unit state applied after EACH confirm (progressive rendering).
    expect(setUnit).toHaveBeenCalledTimes(2);
  });

  it('combines the partial-failure "Uploaded N of M" text with the named oversize message (DEC-5c)', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    // First in-limit file reaches S3; the second in-limit file's direct POST fails.
    uploadToPresignedPost
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError(403, 's3_upload_failed', 's3_upload_failed'));
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const ok = photoOfSize('ok.jpg', 1 * 1024 * 1024);
    const fail = photoOfSize('sideyard.jpg', 2 * 1024 * 1024);
    const huge = photoOfSize('backyard.jpg', 27262976); // 26.0MB - dropped pre-presign
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [ok, fail, huge] } });

    // The named oversize message is NOT lost behind the partial-failure text -
    // the alert carries BOTH (DEC-5c combined precedence).
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Uploaded 1 of 2 photos');
      expect(alert).toHaveTextContent('backyard.jpg is 26.0MB - the limit is 20MB per photo.');
    });
    // The oversize file was never presigned; only the two in-limit files were.
    expect((presignUnitPhotos.mock.calls[0]![1] as File[]).map((f) => f.name)).toEqual([
      'ok.jpg',
      'sideyard.jpg',
    ]);
  });

  it('a failed big-file confirm does NOT abandon later batches - all settle, then one adjudicated alert (N2)', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    // Batches: smalls [key-0], big1 [key-1] (503s), big2 [key-2] (succeeds).
    confirmUnitPhotos.mockImplementation((_id: string, keys: string[]) =>
      keys.length === 1 && keys[0] === 'unit-media/u1/key-1'
        ? Promise.reject(new ApiError(503, 'transcode_busy', 'transcode_busy'))
        : Promise.resolve(READY.unit!),
    );
    renderAt();

    const files = [
      photoOfSize('a.jpg', 1 * 1024 * 1024),
      photoOfSize('b.jpg', 8 * 1024 * 1024), // its own confirm - rejected 503
      photoOfSize('c.jpg', 9 * 1024 * 1024), // its own confirm - MUST still run
    ];
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    // ALL THREE batches were attempted (smalls + both bigs) despite the 503.
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledTimes(3));
    // The two successes applied unit state; the alert carries the count AND the
    // mapped transcode_busy copy.
    expect(setUnit).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Uploaded 2 of 3 photos');
      expect(alert).toHaveTextContent('The server is busy fitting large photos');
    });
  });

  it('disables "+ Add" with a note at the 100-photo cap', () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      entry: `units/u1/p-${i}.jpg`,
      url: `https://cdn.example/p/p-${i}.jpg?sig=${i}`,
    }));
    useListing.mockReturnValue({ ...READY, unit: { ...READY.unit!, mediaDisplay: full } });
    renderAt();
    const photos = screen.getByRole('heading', { name: 'Photos' }).closest('section') as HTMLElement;
    expect(within(photos).getByRole('button', { name: /Add/ })).toBeDisabled();
    expect(within(photos).getByText(/maximum of 100 photos/i)).toBeInTheDocument();
  });

  it('makes a non-cover photo the cover (Make cover hidden on the first entry)', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    setUnitPhotoCover.mockResolvedValue({ ...READY.unit! });
    renderAt();

    // The cover (first) entry has NO "Make cover" action; the 2nd does.
    expect(
      screen.queryByRole('button', { name: /Make property photo 1 the cover/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Make property photo 2 the cover/ }));

    expect(setUnitPhotoCover).toHaveBeenCalledWith('u1', 'units/u1/photo-2.jpg');
    await waitFor(() => expect(setUnit).toHaveBeenCalled());
  });

  it('removes a photo through a confirm dialog', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    removeUnitPhoto.mockResolvedValue({ ...READY.unit! });
    renderAt();

    await user.click(screen.getByRole('button', { name: /Remove property photo 2/ }));
    // A confirm dialog appears - nothing removed yet.
    expect(screen.getByRole('dialog', { name: /Remove photo\?/ })).toBeInTheDocument();
    expect(removeUnitPhoto).not.toHaveBeenCalled();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Remove$/ }));
    expect(removeUnitPhoto).toHaveBeenCalledWith('u1', 'units/u1/photo-2.jpg');
    await waitFor(() => expect(setUnit).toHaveBeenCalled());
  });

  it('the status pill calls setListingStatus and applies the returned unit (pill updates)', async () => {
    const user = userEvent.setup();
    // Drive useListing from a mutable state so setUnit (called by the component on
    // a successful write) re-renders with the new status, like the real hook.
    let current = { ...READY };
    const setUnit = vi.fn((unit) => {
      current = { ...current, unit };
    });
    useListing.mockImplementation(() => ({ ...current, setUnit }));
    setListingStatus.mockResolvedValue({ ...READY.unit!, status: 'off_market' });

    renderAt();
    await chooseStatus(user, 'Off market');

    await waitFor(() =>
      expect(setListingStatus).toHaveBeenCalledWith('u1', {
        toStatus: 'off_market',
        source: 'manual',
      }),
    );
    await waitFor(() =>
      expect(setUnit).toHaveBeenCalledWith(expect.objectContaining({ status: 'off_market' })),
    );
  });

  it('surfaces an inline error when setListingStatus rejects, and clears it on a later success', async () => {
    const user = userEvent.setup();
    let current = { ...READY };
    const setUnit = vi.fn((unit) => {
      current = { ...current, unit };
    });
    useListing.mockImplementation(() => ({ ...current, setUnit }));

    // First change FAILS ? an inline error appears (no silent swallow).
    setListingStatus.mockRejectedValueOnce(new Error('boom'));
    renderAt();
    await chooseStatus(user, 'Off market');
    await waitFor(() =>
      expect(screen.getByText(/Couldn.t update the property status/i)).toBeInTheDocument(),
    );

    // A subsequent SUCCESSFUL change clears the error.
    setListingStatus.mockResolvedValueOnce({ ...READY.unit!, status: 'on_hold' });
    await chooseStatus(user, 'On hold');
    await waitFor(() =>
      expect(screen.queryByText(/Couldn.t update the property status/i)).not.toBeInTheDocument(),
    );
  });

  it('the More actions menu holds Start placement + Send this property (moved off the hero)', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    // Neither is a standalone hero button: the ONLY button named "Send this
    // property" before the menu opens is the "Sent to" card's "+ Send".
    expect(screen.queryByRole('button', { name: 'Start placement' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Send this property' })).toHaveLength(1);
    // Both live in the More actions menu (spec 2026-10-06 D22: neutral words).
    await user.click(screen.getByRole('button', { name: /More actions/ }));
    expect(screen.getByRole('menuitem', { name: 'Start placement' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Send this property' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /tenants/ })).not.toBeInTheDocument();
  });

  it('the "Sent to" card (D20: titled "Sent to") has a "+ Send" action that opens the composer for this property', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('heading', { name: /^Sent to\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Sent to tenants/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send this property' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/new?unitId=u1');
  });

  it('the ⋯ menu "Start placement" opens the create dialog pre-filled+locked to this unit', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, address: { line1: '1450 Joseph Blvd NW' } },
    });
    getAllUnits.mockResolvedValue([]);
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'available', address: { line1: '1450 Joseph Blvd NW' } });
    getAllContacts.mockResolvedValue([]);
    getPlacementsBy.mockResolvedValue([]);
    renderAt();

    await user.click(screen.getByRole('button', { name: /More actions/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Start placement' }));

    const dialog = await screen.findByRole('dialog', { name: 'New placement' });
    // Unit side is LOCKED (read-only label, NOT a combobox); the label resolves to
    // the unit's address. The Tenant side stays an editable picker.
    expect(within(dialog).queryByRole('combobox', { name: 'Unit' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Unit')).toHaveTextContent('1450 Joseph Blvd NW'),
    );
    expect(within(dialog).getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();
  });

  it('hides the "Start placement" button for a deleted property', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
    });
    renderAt();
    expect(screen.queryByRole('button', { name: 'Start placement' })).not.toBeInTheDocument();
  });

  it('Tours card has a "+ Tour" action that opens Schedule-a-tour pre-committed to this property', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, address: { line1: '1450 Joseph Blvd NW' } },
    });
    // ScheduleTourForm's mount fetches: tenant candidates + the unit roster (the
    // roster must contain THIS unit for the pre-commit to take).
    getAllContacts.mockResolvedValue([]);
    getAllUnits.mockResolvedValue([{ unitId: 'u1', landlordId: 'll1', status: 'available', address: { line1: '1450 Joseph Blvd NW' } }]);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Schedule a tour on this property' }));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    // Unit side pre-committed like a hand pick (read-only + Clear); tenant side
    // stays a free typeahead.
    const unitBox = within(dialog).getByRole('combobox', { name: 'Unit' });
    await waitFor(() => expect(unitBox).toHaveValue('1450 Joseph Blvd NW'));
    expect(unitBox).toHaveAttribute('readonly');
    expect(within(dialog).getByRole('button', { name: 'Clear Unit' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();
  });

  it('Placements card has a "+ Placement" action that opens the create dialog locked to this unit', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, address: { line1: '1450 Joseph Blvd NW' } },
    });
    getAllUnits.mockResolvedValue([]);
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'available', address: { line1: '1450 Joseph Blvd NW' } });
    getAllContacts.mockResolvedValue([]);
    getPlacementsBy.mockResolvedValue([]);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Start a placement on this property' }));

    const dialog = await screen.findByRole('dialog', { name: 'New placement' });
    expect(within(dialog).queryByRole('combobox', { name: 'Unit' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Unit')).toHaveTextContent('1450 Joseph Blvd NW'),
    );
  });

  it('hides the "+ Tour" and "+ Placement" card actions for a deleted property', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
    });
    renderAt();
    expect(screen.queryByRole('button', { name: 'Schedule a tour on this property' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a placement on this property' })).not.toBeInTheDocument();
  });

  it('the Tours + Placements card headers hold the action, not a count', () => {
    useListing.mockReturnValue({
      ...READY,
      tours: {
        status: 'ready',
        rows: [
          { tourId: 'tour-1', tenantId: 't1', unitId: 'u1', status: 'requested' },
          { tourId: 'tour-2', tenantId: 't1', unitId: 'u1', status: 'toured', scheduledAt: '2026-07-05T15:00:00.000Z' },
        ],
      },
    });
    renderAt();
    expect(screen.getByRole('heading', { name: /Tours on this property/ })).toHaveTextContent(
      /^Tours on this property\+ Tour$/,
    );
    expect(screen.getByRole('heading', { name: /Placements on this property/ })).toHaveTextContent(
      /^Placements on this property\+ Placement$/,
    );
  });

  it('a deleted property shows a display-only status badge — no live status pill', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
    });
    renderAt();
    // No interactive control on a deleted record (matches the contact header)...
    expect(screen.queryByRole('button', { name: /Property status/i })).not.toBeInTheDocument();
    // ...but the status still reads, as a plain badge next to the Deleted tag.
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Deleted')).toBeInTheDocument();
  });

  it('falls back gracefully when optional fields are missing', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { unitId: 'u1', landlordId: 'll1', status: 'available' },
      placementsOnUnit: [],
      related: { status: 'ready', rows: [] },
    });
    renderAt();
    // Still renders the page heading (unitId fallback) without throwing.
    expect(screen.getByRole('heading', { name: /u1/ })).toBeInTheDocument();
  });

  it('deleting confirms first, then DELETEs and navigates back to the Properties list', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({ ...READY, setUnit: vi.fn() });
    deleteUnit.mockResolvedValue({ ...READY.unit, deleted_at: '2026-06-19T00:00:00.000Z' });

    render(
      <MemoryRouter initialEntries={['/listings/u1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="/listings" element={<div>PROPERTIES LIST</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete property/i }));

    // A confirm dialog appears - nothing deleted yet.
    expect(screen.getByRole('dialog', { name: /Delete property\?/i })).toBeInTheDocument();
    expect(deleteUnit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Delete$/i }));
    expect(deleteUnit).toHaveBeenCalledWith('u1');
    await screen.findByText('PROPERTIES LIST');
  });

  it('shows the Deleted banner + Restore for a deleted property and restores in place', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    restoreUnit.mockResolvedValue({ ...READY.unit }); // restored (no deleted_at)
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue({ ...READY.unit });
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    expect(screen.getByRole('status')).toHaveTextContent(/deleted/i);
    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(setUnit).toHaveBeenCalled());
    // The normal case: no landlord dialog.
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();
  });

  it('a restore that needs a landlord opens the landlord dialog; restoring through it applies the unit and closes it', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    const restored = { ...READY.unit!, landlordId: 'll9' };
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue(restored);
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockResolvedValueOnce(restored);
    getAllContacts.mockReset().mockResolvedValue([]);
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    expect(
      within(dialog).getByText(
        "James Porter is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    expect(setUnit).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    expect(restoreUnit).toHaveBeenLastCalledWith('u1', { landlordId: null });
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(restored));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
  });

  it('a conflict inside the landlord dialog re-reads the property into the page AND the Contacts card, and keeps the dialog while it is still deleted', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    // The concurrent change put a new landlord of record on the property: the
    // re-read carries its enriched contact row, which the Contacts card must show.
    const fresh = {
      ...READY.unit!,
      landlordId: 'll2',
      deleted_at: '2026-06-19T00:00:00.000Z',
      contacts: [{ contactId: 'll2', role: 'landlord' as const, primaryContact: true, name: 'Nora Lane' }],
    };
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', { error: 'restore_needs_landlord' }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'unit_roster_conflict', 'unit_roster_conflict', { error: 'unit_roster_conflict' }),
      );
    getUnit.mockReset().mockResolvedValue(fresh);
    getAllContacts.mockReset().mockResolvedValue([]);
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    expect(
      within(dialog).getByText(
        "This property's landlord is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(fresh));
    // applyRosterUnit, not setUnit alone: the Contacts card renders the
    // re-read's landlord row (useListing is mocked, so only the card's own
    // roster state can show it).
    expect(await screen.findByText('Nora Lane')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
  });

  // Gap pins from the S4b mutant check (extra mutants X1, X2, X5): behavior the
  // restore wiring promises (plan Task 4.11 Goal, CONTRACT ISSUE 9, watch item
  // W7) that no case above pinned.
  it('(PIN) restoring through the landlord dialog puts the restored roster on the Contacts card, not just the page unit', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    // The body-path answer carries the ENRICHED roster (CONTRACT ISSUE 9): the
    // chosen landlord's row, which only applyRosterUnit puts on the card.
    const restored = {
      ...READY.unit!,
      landlordId: 'll9',
      contacts: [{ contactId: 'll9', role: 'landlord' as const, primaryContact: true, name: 'Nora Lane' }],
    };
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue(restored);
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', { error: 'restore_needs_landlord' }),
      )
      .mockResolvedValueOnce(restored);
    getAllContacts
      .mockReset()
      .mockResolvedValue([{ contactId: 'll9', type: 'landlord', firstName: 'Nora', lastName: 'Lane' }]);
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
    await user.type(within(dialog).getByRole('combobox', { name: 'Landlord' }), 'Nora');
    await user.click(await screen.findByRole('option', { name: /Nora Lane/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Restore with this landlord' }));

    expect(restoreUnit).toHaveBeenLastCalledWith('u1', { landlordId: 'll9' });
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(restored));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
    // applyRosterUnit, not setUnit alone: useListing is mocked, so only the
    // card's own roster state can show the restored landlord row.
    expect(screen.getByRole('link', { name: /Nora Lane/ })).toBeInTheDocument();
  });

  // caseworker-integrity spec revision 5 section 4 "Restore" (Cameron's Q5
  // ruling; fix wave 2 FW2-13), as primary-contact-integrity spec 4.6 now
  // rules it: "Restore without a landlord" on a property whose cleared
  // landlord was its primary contact hands the primary contact, in the same
  // write, to the earliest-added remaining contact eligible for automatic
  // routing (typed landlord, live, not a routing pointer). The page renders
  // the roster the server answers with.
  it('Restore without a landlord that promotes the earliest-added eligible contact shows that contact as the primary contact', async () => {
    const user = userEvent.setup();
    // Deleted: James (landlord of record and primary contact) was re-typed;
    // Dana, a property manager typed landlord, is still on the list.
    const james = { contactId: 'll1', role: 'landlord' as const, primaryContact: true, name: 'James Porter' };
    const dana = { contactId: 'pm2', role: 'pm' as const, primaryContact: false, name: 'Dana Reyes' };
    const deletedUnit: NonNullable<ListingState['unit']> = {
      ...READY.unit!,
      deleted_at: '2026-06-19T00:00:00.000Z',
      landlordId: 'll1',
      primary_contact: 'll1',
      contacts: [james, dana],
    };
    // The server's answer: no landlord of record, James's row dropped, Dana
    // promoted (her row flagged, the primary_contact scalar naming her).
    const { landlordId: _cleared, deleted_at: _live, ...restoredBase } = deletedUnit;
    const restored: NonNullable<ListingState['unit']> = {
      ...restoredBase,
      primary_contact: 'pm2',
      contacts: [{ ...dana, primaryContact: true }],
    };
    // primary-contact-integrity spec 7.5: the page re-reads after a restore.
    getUnit.mockReset().mockResolvedValue(restored);
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockResolvedValueOnce(restored);
    getAllContacts.mockReset().mockResolvedValue([]);
    // As the real hook: setUnit replaces the unit and keeps the roster rows
    // derived at load (James primary), which only the Contacts card's own
    // roster state can supersede.
    let current: ListingState = {
      ...READY,
      unit: deletedUnit,
      roster: [
        { contactId: 'll1', name: 'James Porter', role: 'landlord', roleLabel: 'Landlord', primaryContact: true, fallback: false },
        { contactId: 'pm2', name: 'Dana Reyes', role: 'pm', roleLabel: 'Property manager', primaryContact: false, fallback: false },
      ],
      setUnit: vi.fn((unit: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit };
      }),
    };
    useListing.mockImplementation(() => current);
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    expect(restoreUnit).toHaveBeenLastCalledWith('u1', { landlordId: null });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );

    // Live again; the Contacts card lists Dana as the primary contact.
    const card = screen.getByRole('heading', { name: /^Contacts/ }).closest('section') as HTMLElement;
    expect(within(card).getAllByRole('link')[0]).toHaveTextContent('Dana Reyes (primary)');
    expect(within(card).queryByText(/James Porter/)).not.toBeInTheDocument();
    // Edit mode: her row is the primary and offers no Make primary.
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    expect(
      screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }).parentElement,
    ).toHaveTextContent('Dana Reyes (primary)');
    expect(within(card).getAllByText('(primary)')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Make Dana Reyes the primary contact' })).not.toBeInTheDocument();
  });

  it('(PIN) a conflict whose re-read shows the property already restored closes the landlord dialog', async () => {
    const user = userEvent.setup();
    const setUnit = vi.fn();
    // Someone else restored the property meanwhile: the re-read is live.
    const fresh = { ...READY.unit!, landlordId: 'll2' };
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', { error: 'restore_needs_landlord' }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'unit_roster_conflict', 'unit_roster_conflict', { error: 'unit_roster_conflict' }),
      );
    getUnit.mockReset().mockResolvedValue(fresh);
    getAllContacts.mockReset().mockResolvedValue([]);
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit,
    });
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));

    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    await waitFor(() => expect(setUnit).toHaveBeenCalledWith(fresh));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
  });

  // Spec revision 7 section 4 "Restore" (final review A2 and round 2 R2-1): a
  // landlord choice that arrives when the plain restore would apply - here
  // another staff member restored the property, with their own landlord, while
  // this dialog was open - answers 409 restore_landlord_not_needed and writes
  // nothing. The dialog closes and the page re-reads; the property is live, so
  // the page shows the real state - live, with the re-read's landlord on the
  // Contacts card, never the one picked here - and no landlord-changed
  // sentence. Nothing re-runs the plain restore.
  it('a landlord choice answered 409 restore_landlord_not_needed closes the dialog; the re-read is live - the page shows the re-read property and no sentence', async () => {
    const user = userEvent.setup();
    const deletedUnit: NonNullable<ListingState['unit']> = {
      ...READY.unit!,
      deleted_at: '2026-06-19T00:00:00.000Z',
      landlordId: 'll1',
      primary_contact: 'll1',
      contacts: [{ contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' }],
    };
    // The re-read: staff B restored it with Yolanda as its landlord of record.
    const { deleted_at: _live, ...liveBase } = deletedUnit;
    const fresh: NonNullable<ListingState['unit']> = {
      ...liveBase,
      landlordId: 'll7',
      primary_contact: 'll7',
      contacts: [{ contactId: 'll7', role: 'landlord', primaryContact: true, name: 'Yolanda Banks' }],
    };
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_landlord_not_needed', 'restore_landlord_not_needed', {
          error: 'restore_landlord_not_needed',
        }),
      );
    getUnit.mockReset().mockResolvedValue(fresh);
    getAllContacts
      .mockReset()
      .mockResolvedValue([{ contactId: 'll9', type: 'landlord', firstName: 'Nora', lastName: 'Lane' }]);
    // As the real hook: setUnit replaces the unit and keeps the roster rows
    // derived at load, which only the Contacts card's own roster state can
    // supersede.
    let current: ListingState = {
      ...READY,
      unit: deletedUnit,
      roster: [
        { contactId: 'll1', name: 'James Porter', role: 'landlord', roleLabel: 'Landlord', primaryContact: true, fallback: false },
      ],
      setUnit: vi.fn((unit: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit };
      }),
    };
    useListing.mockImplementation(() => current);
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
    await user.type(within(dialog).getByRole('combobox', { name: 'Landlord' }), 'Nora');
    await user.click(await screen.findByRole('option', { name: /Nora Lane/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Restore with this landlord' }));

    expect(restoreUnit).toHaveBeenLastCalledWith('u1', { landlordId: 'll9' });
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
    // The real state: live - no Deleted badge or Restore action, the status
    // pill is back ...
    await waitFor(() => expect(screen.queryByText('Deleted')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Restore$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Property status/i })).toBeInTheDocument();
    // ... and the re-read's landlord on the Contacts card, not the pick.
    const card = screen.getByRole('heading', { name: /^Contacts/ }).closest('section') as HTMLElement;
    expect(within(card).getAllByRole('link')[0]).toHaveTextContent('Yolanda Banks (primary)');
    expect(within(card).queryByText(/Nora Lane/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/James Porter/)).not.toBeInTheDocument();
    // No landlord-changed sentence on a live property, and no retry sentence.
    expect(screen.queryByText(RESTORE_LANDLORD_CHANGED)).not.toBeInTheDocument();
    expect(screen.queryByText('The property contacts changed - try that change again.')).not.toBeInTheDocument();
    // The choice was sent once; nothing re-ran the plain restore.
    expect(restoreUnit.mock.calls).toEqual([['u1'], ['u1', { landlordId: 'll9' }]]);
  });

  // Spec revision 7 section 4 "Restore" (final review round 2 R2-1): the same
  // 409 restore_landlord_not_needed when the property is STILL deleted - its
  // stored landlord, James, became a landlord again while the dialog was open,
  // so the plain restore applies now. Under revision 6 this answered
  // unit_roster_conflict and the dialog stayed open saying "try that change
  // again" to a choice that could never succeed. Now the dialog closes, the
  // page re-reads, and the deleted banner (its role="status" region) says why:
  // the landlord changed while staff were choosing, so choose Restore again.
  // The plain restore is NOT re-run automatically - it would silently override
  // the choice staff made.
  /** Restore, then 409 restore_needs_landlord opens the dialog; its "Restore
   *  without a landlord" answers 409 restore_landlord_not_needed. */
  function refuseTheLateChoice(): void {
    restoreUnit.mockReset();
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_landlord_not_needed', 'restore_landlord_not_needed', {
          error: 'restore_landlord_not_needed',
        }),
      );
  }

  async function chooseRestoreWithoutLandlord(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
  }

  /** A deleted property whose setUnit replaces the unit, as the real hook does. */
  function deletedPropertyState(unit: NonNullable<ListingState['unit']>): { state: () => ListingState } {
    let current: ListingState = {
      ...READY,
      unit,
      setUnit: vi.fn((next: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit: next };
      }),
    };
    useListing.mockImplementation(() => current);
    return { state: () => current };
  }

  it('a landlord choice answered 409 restore_landlord_not_needed closes the dialog; the re-read is still deleted - the deleted banner says the landlord changed', async () => {
    const user = userEvent.setup();
    const deletedUnit = { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' };
    // The re-read: still deleted, James (a landlord again) still its landlord of record.
    const fresh: NonNullable<ListingState['unit']> = {
      ...deletedUnit,
      contacts: [{ contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' }],
    };
    refuseTheLateChoice();
    getUnit.mockReset().mockResolvedValue(fresh);
    getAllContacts.mockReset().mockResolvedValue([]);
    const { state } = deletedPropertyState(deletedUnit);
    renderAt();

    await chooseRestoreWithoutLandlord(user);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
    expect(getUnit).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(state().setUnit).toHaveBeenCalledWith(fresh));
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/This property is deleted/);
    expect(await within(banner).findByText(RESTORE_LANDLORD_CHANGED)).toBeInTheDocument();
    expect(screen.queryByText('The property contacts changed - try that change again.')).not.toBeInTheDocument();
    // The choice was sent once; nothing re-ran the plain restore.
    expect(restoreUnit.mock.calls).toEqual([['u1'], ['u1', { landlordId: null }]]);
  });

  it('the landlord-changed sentence clears on the next Restore press', async () => {
    const user = userEvent.setup();
    const deletedUnit = { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' };
    refuseTheLateChoice();
    // The next press fails, so the property stays deleted: only the press
    // itself can clear the sentence.
    restoreUnit.mockRejectedValueOnce(new ApiError(500, 'http_500', 'Request failed (500)'));
    getUnit.mockReset().mockResolvedValue(deletedUnit);
    getAllContacts.mockReset().mockResolvedValue([]);
    deletedPropertyState(deletedUnit);
    renderAt();

    await chooseRestoreWithoutLandlord(user);
    const banner = screen.getByRole('status');
    expect(await within(banner).findByText(RESTORE_LANDLORD_CHANGED)).toBeInTheDocument();

    await user.click(within(banner).getByRole('button', { name: 'Restore' }));
    expect(restoreUnit).toHaveBeenLastCalledWith('u1');
    expect(within(screen.getByRole('status')).queryByText(RESTORE_LANDLORD_CHANGED)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByRole('status')).getByRole('button', { name: 'Restore' })).toBeEnabled(),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/This property is deleted/);
    expect(screen.queryByText(RESTORE_LANDLORD_CHANGED)).not.toBeInTheDocument();
    expect(restoreUnit).toHaveBeenCalledTimes(3);
  });

  // A failed re-read leaves the page showing the property deleted, so the
  // banner still says why the dialog closed (Choose Restore again resolves it
  // either way); still no automatic plain restore.
  it('a failed re-read after 409 restore_landlord_not_needed still closes the dialog and the deleted banner says the landlord changed', async () => {
    const user = userEvent.setup();
    const deletedUnit = { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' };
    refuseTheLateChoice();
    getUnit.mockReset().mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    getAllContacts.mockReset().mockResolvedValue([]);
    const { state } = deletedPropertyState(deletedUnit);
    renderAt();

    await chooseRestoreWithoutLandlord(user);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
    expect(await within(screen.getByRole('status')).findByText(RESTORE_LANDLORD_CHANGED)).toBeInTheDocument();
    expect(getUnit).toHaveBeenCalledWith('u1');
    expect(state().setUnit).not.toHaveBeenCalled();
    expect(restoreUnit.mock.calls).toEqual([['u1'], ['u1', { landlordId: null }]]);
  });

  // The sentence belongs to the property it was said for, like the dialog
  // (R1 code review, dashboard finding 8): the /listings/:unitId element is
  // not keyed, so a history move re-renders this same instance - the sentence
  // must not show on another property, nor come back with the first one.
  it('the landlord-changed sentence is reset by a history move to another property', async () => {
    const user = userEvent.setup();
    const deletedUnit = { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' };
    refuseTheLateChoice();
    getUnit.mockReset().mockResolvedValue(deletedUnit);
    getAllContacts.mockReset().mockResolvedValue([]);
    const deletedU1: ListingState = { ...READY, unit: deletedUnit, setUnit: vi.fn() };
    const deletedU2: ListingState = {
      ...READY,
      unit: { ...deletedUnit, unitId: 'u2', address: { line1: '22 Elm St' } },
      setUnit: vi.fn(),
    };
    useListing.mockImplementation((id: string) => (id === 'u2' ? deletedU2 : deletedU1));
    let go: ((delta: number) => void) | undefined;
    function HistoryProbe(): null {
      const navigate = useNavigate();
      go = (delta) => void navigate(delta);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/listings/u2', '/listings/u1']} initialIndex={1}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
        </Routes>
        <HistoryProbe />
      </MemoryRouter>,
    );

    await chooseRestoreWithoutLandlord(user);
    expect(await within(screen.getByRole('status')).findByText(RESTORE_LANDLORD_CHANGED)).toBeInTheDocument();

    // Back to u2, also deleted: its banner never says u1's sentence.
    act(() => go?.(-1));
    expect(await screen.findByRole('heading', { name: /22 Elm St/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/This property is deleted/);
    expect(screen.queryByText(RESTORE_LANDLORD_CHANGED)).not.toBeInTheDocument();

    // Forward to u1 again: reset, not merely hidden.
    act(() => go?.(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/This property is deleted/);
    expect(screen.queryByText(RESTORE_LANDLORD_CHANGED)).not.toBeInTheDocument();
  });

  it.each([
    [404, 'unit_not_found'],
    [409, 'unit_roster_conflict'],
    [500, 'http_500'],
  ] as const)(
    '(PIN, W7) a plain restore refused %i %s opens no landlord dialog; the property stays deleted and Restore re-enables',
    async (status, code) => {
      const user = userEvent.setup();
      const setUnit = vi.fn();
      restoreUnit.mockReset().mockRejectedValue(new ApiError(status, code, code, { error: code }));
      useListing.mockReturnValue({
        ...READY,
        unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
        setUnit,
      });
      renderAt();

      await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
      expect(restoreUnit).toHaveBeenCalledWith('u1');
      await waitFor(() => expect(screen.getAllByRole('button', { name: /^Restore$/i })[0]).toBeEnabled());
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();
      expect(setUnit).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent(/deleted/i);
    },
  );

  // R1 code review, dashboard finding 8: the landlord dialog belongs to the
  // property it opened for. The /listings/:unitId element is not keyed, so a
  // history move (browser Back / Forward) to another property re-renders this
  // SAME instance: the dialog must close then - never post its choice against
  // the other property - and must not come back with the first one.
  it('the landlord dialog is reset by a history move to another property and never restores that property', async () => {
    const user = userEvent.setup();
    restoreUnit.mockReset().mockRejectedValue(
      new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
        error: 'restore_needs_landlord',
        landlordName: 'James Porter',
      }),
    );
    getAllContacts.mockReset().mockResolvedValue([]);
    const deletedU1: ListingState = {
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit: vi.fn(),
    };
    const liveU2: ListingState = {
      ...READY,
      unit: { ...READY.unit!, unitId: 'u2', address: { line1: '22 Elm St' } },
      setUnit: vi.fn(),
    };
    useListing.mockImplementation((id: string) => (id === 'u2' ? liveU2 : deletedU1));
    let go: ((delta: number) => void) | undefined;
    function HistoryProbe(): null {
      const navigate = useNavigate();
      go = (delta) => void navigate(delta);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/listings/u2', '/listings/u1']} initialIndex={1}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
        </Routes>
        <HistoryProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    // The dialog's own action, held from before the move (R2 code review,
    // dashboard finding A4; fix wave 2 FW2-7): pressed after the move it must
    // reach no handler. A dialog that survived the move would still hold this
    // button, now bound to the page's current property, and post its choice
    // against u2 - so the u2 check below can fail.
    const withoutLandlord = within(dialog).getByRole('button', { name: 'Restore without a landlord' });

    // Back to u2 with the dialog open: it closes, and its action posts nothing.
    act(() => go?.(-1));
    expect(await screen.findByRole('heading', { name: /22 Elm St/ })).toBeInTheDocument();
    fireEvent.click(withoutLandlord);
    expect(restoreUnit.mock.calls.map(([id]) => id)).toEqual(['u1']);
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();

    // Forward to u1 again: reset, not merely hidden.
    act(() => go?.(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/deleted/i);
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();

    // Only u1's own plain restore was ever sent.
    expect(restoreUnit).toHaveBeenCalledTimes(1);
    expect(restoreUnit).toHaveBeenCalledWith('u1');
  });

  // R2 code review, dashboard finding A4 (fix wave 2 FW2-7): FW-11 also drops
  // a restore_needs_landlord 409 that answers AFTER the move. The answer
  // belongs to the property it was asked for, so it opens no dialog on the
  // other property, nor on going Forward back to its own. An effect-based
  // reset keyed on the unitId would miss it: that effect runs at the move,
  // before the late answer lands.
  it('a restore_needs_landlord 409 that answers after a history move to another property opens no dialog there, nor on going Forward', async () => {
    const user = userEvent.setup();
    let refuse: ((err: unknown) => void) | undefined;
    restoreUnit.mockReset().mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    getAllContacts.mockReset().mockResolvedValue([]);
    const deletedU1: ListingState = {
      ...READY,
      unit: { ...READY.unit!, deleted_at: '2026-06-19T00:00:00.000Z' },
      setUnit: vi.fn(),
    };
    const liveU2: ListingState = {
      ...READY,
      unit: { ...READY.unit!, unitId: 'u2', address: { line1: '22 Elm St' } },
      setUnit: vi.fn(),
    };
    useListing.mockImplementation((id: string) => (id === 'u2' ? liveU2 : deletedU1));
    let go: ((delta: number) => void) | undefined;
    function HistoryProbe(): null {
      const navigate = useNavigate();
      go = (delta) => void navigate(delta);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/listings/u2', '/listings/u1']} initialIndex={1}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
        </Routes>
        <HistoryProbe />
      </MemoryRouter>,
    );

    // On deleted u1: the plain restore is sent and left in flight.
    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    expect(restoreUnit).toHaveBeenCalledWith('u1');

    // Back to u2, then u1's answer lands: it needs a landlord.
    act(() => go?.(-1));
    expect(await screen.findByRole('heading', { name: /22 Elm St/ })).toBeInTheDocument();
    await act(async () => {
      refuse?.(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      );
    });
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();

    // Forward to u1: the late answer was dropped, not parked.
    act(() => go?.(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/deleted/i);
    expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument();
    expect(restoreUnit).toHaveBeenCalledTimes(1);
  });
});

// --- Contacts card EDIT MODE (contact-rosters Task 9, spec 6.1 / D9) --------
// The property roster is where `primaryContact` is set, so these tests pin the
// four things an operator can do (add / remove / make primary / re-role), that
// each one persists ON CLICK against the real endpoints, and that a lost race
// never reads as a dead click.
//
// The fixture is a PM-MANAGED property - the motivating case: the PM is the
// primary contact, the OWNER is the landlord of record (`unit.landlordId`, which
// may never leave the roster), and a second PM is the ordinary removable row.
const ROSTER_UNIT: NonNullable<ListingState['unit']> = {
  ...READY.unit!,
  landlordId: 'll1',
  primary_contact: 'pm1',
  contacts: [
    { contactId: 'pm1', role: 'pm', primaryContact: true, name: 'Alicia Grant', company: 'Grant Mgmt' },
    { contactId: 'll1', role: 'landlord', primaryContact: false, name: 'James Porter', company: 'Porter Properties' },
    { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' },
  ],
};

const ROSTER_READY: ListingState = {
  ...READY,
  unit: ROSTER_UNIT,
  // Primary first, exactly as listingRoster() sorts it.
  roster: [
    { contactId: 'pm1', name: 'Alicia Grant', role: 'pm', roleLabel: 'Property manager', company: 'Grant Mgmt', primaryContact: true, fallback: false },
    { contactId: 'll1', name: 'James Porter', role: 'landlord', roleLabel: 'Landlord', company: 'Porter Properties', primaryContact: false, fallback: false },
    { contactId: 'pm2', name: 'Dana Reyes', role: 'pm', roleLabel: 'Property manager', primaryContact: false, fallback: false },
  ],
};

describe('ListingDetail - Contacts card edit mode', () => {
  beforeEach(() => {
    // A searchable candidate for the "+ Add contact" typeahead, plus the tenant
    // the placements card resolves.
    useContacts.mockImplementation((filter: string) =>
      filter === 'deleted'
        ? { status: 'ready', contacts: [] }
        : {
            status: 'ready',
            contacts: [
              { contactId: 't1', type: 'tenant', status: 'active', firstName: 'Fixture', lastName: 'Tenant', phone: '+14045550111' },
              { contactId: 'pm9', type: 'landlord', status: 'active', firstName: 'Renata', lastName: 'Vale', phone: '+14045550188' },
            ],
          },
    );
  });

  it('Edit flips the card into edit mode (rows stop being links) and Done returns', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    renderAt();

    // Read mode is unchanged: the name is the row link, no per-row controls.
    expect(screen.getByRole('link', { name: /Alicia Grant/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove Alicia Grant from this property' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    expect(
      screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }),
    ).toBeInTheDocument();
    // Rows are NOT links while editing (a row-wide anchor cannot host buttons).
    expect(screen.queryByRole('link', { name: /Alicia Grant/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done editing contacts' }));
    expect(screen.getByRole('link', { name: /Alicia Grant/ })).toBeInTheDocument();
  });

  it('adds a contact: committed search pick + role -> POST { contactId, role, primaryContact: false }', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact.mockResolvedValue({
      ...ROSTER_UNIT,
      contacts: [
        ...ROSTER_UNIT.contacts!,
        { contactId: 'pm9', role: 'pm', primaryContact: false, name: 'Renata Vale' },
      ],
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: '+ Add contact' }));

    // Committed-pick typeahead (the UnitSearchField contract): typing alone can
    // never add anybody - only a PICKED candidate carries a contactId.
    await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Renata');
    // Substring, not exact: a chooser option's accessible name is the contact's
    // name PLUS their kind (ContactSearchField renders it so a first-name-only
    // roster is navigable), so an exact name never matches.
    await user.click(screen.getByRole('option', { name: /Renata Vale/ }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Role for the new contact' }),
      'pm',
    );
    await user.click(screen.getByRole('button', { name: 'Add contact to this property' }));

    expect(addUnitContact).toHaveBeenCalledWith('u1', {
      contactId: 'pm9',
      role: 'pm',
      primaryContact: false,
    });
    // Persisted on click: the server's roster is what the card re-renders.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Renata Vale from this property' }),
      ).toBeInTheDocument(),
    );
  });

  it('auto-primary: an add the server answers with the new row as primary renders it as the primary contact', async () => {
    // caseworker-integrity spec revision 4 section 4 "Auto-primary": on a
    // property with no primary contact and no landlord of record (e.g. restored
    // without a landlord) the server makes the added contact its primary
    // contact. This page still posts primaryContact: false and renders the
    // roster the server answers with.
    const user = userEvent.setup();
    const { landlordId: _dropped, primary_contact: _noPrimary, ...ownerless } = ROSTER_UNIT;
    const dana = { contactId: 'pm2', role: 'pm' as const, primaryContact: false, name: 'Dana Reyes' };
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ownerless, contacts: [dana] } as NonNullable<ListingState['unit']>,
      landlord: null,
      roster: [ROSTER_READY.roster[2]!],
    });
    addUnitContact.mockReset().mockResolvedValue({
      ...ownerless,
      primary_contact: 'pm9',
      contacts: [dana, { contactId: 'pm9', role: 'pm', primaryContact: true, name: 'Renata Vale' }],
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    const card = screen.getByRole('heading', { name: /^Contacts/ }).closest('section') as HTMLElement;
    // Before: nobody is the primary contact - no marker, and Dana offers Make primary.
    expect(within(card).queryByText('(primary)')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ Add contact' }));
    await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Renata');
    await user.click(screen.getByRole('option', { name: /Renata Vale/ }));
    await user.click(screen.getByRole('button', { name: 'Add contact to this property' }));

    // The page asks for a NON-primary row; the server decides.
    expect(addUnitContact).toHaveBeenCalledTimes(1);
    expect(addUnitContact).toHaveBeenCalledWith('u1', { contactId: 'pm9', role: 'pm', primaryContact: false });
    // After: the card's primary marker is on the added row, which offers no
    // Make primary; Dana still does.
    const renataRemove = await screen.findByRole('button', { name: 'Remove Renata Vale from this property' });
    expect(renataRemove.parentElement).toHaveTextContent('Renata Vale (primary)');
    expect(within(card).getAllByText('(primary)')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Make Renata Vale the primary contact' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' })).toBeInTheDocument();

    // Read mode lists the primary contact first, marked.
    await user.click(screen.getByRole('button', { name: 'Done editing contacts' }));
    expect(within(card).getAllByRole('link')[0]).toHaveTextContent('Renata Vale (primary)');
  });

  it('refuses to silently replace the landlord of record when adding a Landlord contact', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact.mockRejectedValue(
      new ApiError(409, 'landlord_reassignment_required', 'conflict'),
    );
    getUnit.mockResolvedValue(ROSTER_UNIT);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: '+ Add contact' }));
    await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Renata');
    await user.click(screen.getByRole('option', { name: /Renata Vale/ }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Role for the new contact' }),
      'landlord',
    );
    await user.click(screen.getByRole('button', { name: 'Add contact to this property' }));

    expect(addUnitContact).toHaveBeenCalledWith('u1', {
      contactId: 'pm9',
      role: 'landlord',
      primaryContact: false,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This property already has a landlord of record - reassign it before choosing Landlord.',
    );
    expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
  });

  // A typed contact-list refusal names its own reason, and (final review A3;
  // fix wave FWF-2) settles like every other 409: the roster write answers
  // these codes only when the property changed after the route's read (a seat
  // removed, the landlord cleared) - exactly when this card is stale - so the
  // page re-reads the property onto the card. The sentence stays.
  it.each([
    ['contact_list_caseworker', "Caseworkers can't be on a property's contact list."],
    ['landlord_not_landlord', "Only a landlord can be a property's landlord of record."],
  ] as const)(
    'a %s refusal names its own reason - not the landlord-of-record catch-all - and re-reads the property onto the Contacts card',
    async (code, sentence) => {
      const user = userEvent.setup();
      useListing.mockReturnValue(ROSTER_READY);
      // The re-read: meanwhile another operator removed Dana's seat.
      getUnit.mockReset().mockResolvedValue({
        ...ROSTER_UNIT,
        contacts: ROSTER_UNIT.contacts!.filter((row) => row.contactId !== 'pm2'),
      });
      addUnitContact.mockReset().mockRejectedValue(new ApiError(409, code, code, { error: code }));
      renderAt();

      await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
      expect(screen.getByRole('button', { name: 'Remove Dana Reyes from this property' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '+ Add contact' }));
      await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Renata');
      await user.click(screen.getByRole('option', { name: /Renata Vale/ }));
      await user.click(screen.getByRole('button', { name: 'Add contact to this property' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(sentence);
      expect(alert).not.toHaveTextContent(/landlord of record now/);
      await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
      // Settled onto the card: Dana's seat is gone ...
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Remove Dana Reyes from this property' }),
        ).not.toBeInTheDocument(),
      );
      // ... and the refusal's sentence stays on the add row, with the pick.
      expect(screen.getByRole('alert')).toHaveTextContent(sentence);
      expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
    },
  );

  it("a typed refusal of a row's edit keeps that row's sentence after the re-read settles the card", async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    // The re-read: meanwhile the landlord of record was cleared (James's row
    // and landlordId gone), so Dana's Landlord role was a claim of the vacant
    // slot by a contact not typed landlord.
    const { landlordId: _cleared, ...ownerless } = ROSTER_UNIT;
    getUnit.mockReset().mockResolvedValue({
      ...ownerless,
      contacts: ROSTER_UNIT.contacts!.filter((row) => row.contactId !== 'll1'),
    });
    addUnitContact
      .mockReset()
      .mockRejectedValue(
        new ApiError(409, 'landlord_not_landlord', 'landlord_not_landlord', { error: 'landlord_not_landlord' }),
      );
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Dana Reyes' }), 'landlord');

    expect(addUnitContact).toHaveBeenCalledWith('u1', { contactId: 'pm2', role: 'landlord', primaryContact: false });
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    // Settled onto the card: James is no longer listed ...
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Remove James Porter from this property' }),
      ).not.toBeInTheDocument(),
    );
    // ... and Dana's row still carries its sentence.
    const danaRow = screen.getByRole('button', { name: 'Remove Dana Reyes from this property' })
      .parentElement?.parentElement as HTMLElement;
    expect(within(danaRow).getByRole('alert')).toHaveTextContent(
      "Only a landlord can be a property's landlord of record.",
    );
  });

  it('asks the operator to retry when repeated concurrent roster writes exhaust retries', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact.mockRejectedValue(new ApiError(409, 'unit_roster_conflict', 'conflict'));
    getUnit.mockResolvedValue(ROSTER_UNIT);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: '+ Add contact' }));
    await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Renata');
    await user.click(screen.getByRole('option', { name: /Renata Vale/ }));
    await user.click(screen.getByRole('button', { name: 'Add contact to this property' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    expect(screen.getByRole('combobox', { name: 'Add contact' })).toHaveValue('Renata Vale');
  });

  it('the Add contact picker never offers a caseworker (I4) - other kinds still show', async () => {
    const user = userEvent.setup();
    useContacts.mockImplementation((filter: string) =>
      filter === 'deleted'
        ? { status: 'ready', contacts: [] }
        : {
            status: 'ready',
            contacts: [
              { contactId: 'pm9', type: 'landlord', status: 'active', firstName: 'Renata', lastName: 'Vale', phone: '+14045550188' },
              { contactId: 'cw1', type: 'partner', role: 'Caseworker', status: 'active', firstName: 'Renee', lastName: 'Casey', phone: '+14045550199' },
              { contactId: 'pt1', type: 'partner', role: 'Navigator', status: 'active', firstName: 'Renaldo', lastName: 'Park', phone: '+14045550177' },
            ],
          },
    );
    useListing.mockReturnValue(ROSTER_READY);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: '+ Add contact' }));
    await user.type(screen.getByRole('combobox', { name: 'Add contact' }), 'Ren');

    expect(screen.getByRole('option', { name: /Renata Vale/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Renaldo Park/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Renee Casey/ })).not.toBeInTheDocument();
  });

  it('make primary contact re-POSTs the row with primaryContact: true, role preserved', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact.mockResolvedValue({
      ...ROSTER_UNIT,
      primary_contact: 'll1',
      contacts: [
        { contactId: 'pm1', role: 'pm', primaryContact: false, name: 'Alicia Grant' },
        { contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' },
        { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' },
      ],
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Make James Porter the primary contact' }));

    expect(addUnitContact).toHaveBeenCalledWith('u1', {
      contactId: 'll1',
      role: 'landlord',
      primaryContact: true,
    });
    // The star moved: the old primary now offers the control, the new one does not.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Make Alicia Grant the primary contact' }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Make James Porter the primary contact' }),
    ).not.toBeInTheDocument();
  });

  it('changing a row role re-POSTs with the new role and the row primary flag preserved', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact.mockResolvedValue(ROSTER_UNIT);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Dana Reyes' }), 'owner');

    expect(addUnitContact).toHaveBeenCalledWith('u1', {
      contactId: 'pm2',
      role: 'owner',
      primaryContact: false,
    });
  });

  it('the landlord-of-record row cannot be removed, and says why', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    expect(
      screen.getByRole('button', { name: 'Remove James Porter from this property' }),
    ).toBeDisabled();
    expect(
      screen.getByText("Landlord of record - reassign the property's landlord first"),
    ).toBeInTheDocument();
    expect(removeUnitContact).not.toHaveBeenCalled();
  });

  it('removing the CURRENT primary confirms first and NAMES the heir the server reports', async () => {
    const user = userEvent.setup();
    // primary-contact-integrity spec 7.3: the heir comes from the server's
    // propertyContact block, never from a client-side copy of the rule.
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    });
    removeUnitContact.mockResolvedValue({
      ...ROSTER_UNIT,
      primary_contact: 'll1',
      contacts: [
        { contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' },
        { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' },
      ],
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));

    // Nothing is written until the operator has read WHO inherits the routing.
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText(
        'James Porter becomes the primary contact - new tours and relay groups for this property will use them.',
      ),
    ).toBeInTheDocument();
    expect(removeUnitContact).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Remove contact' }));
    expect(removeUnitContact).toHaveBeenCalledWith('u1', 'pm1');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Remove Alicia Grant from this property' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('names the NO-primary outcome when the server reports no heir', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ROSTER_UNIT, landlordId: '', contacts: [ROSTER_UNIT.contacts![0]!] },
      roster: [ROSTER_READY.roster[0]!],
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: null },
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));

    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText(
        "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.",
      ),
    ).toBeInTheDocument();
  });

  it('an OWNERLESS property (no landlordId at all, e.g. restored without a landlord) names the NO-primary outcome without crashing', async () => {
    const user = userEvent.setup();
    const { landlordId: _dropped, ...ownerless } = ROSTER_UNIT;
    useListing.mockReturnValue({
      ...ROSTER_READY,
      unit: { ...ownerless, contacts: [ROSTER_UNIT.contacts![0]!] } as NonNullable<ListingState['unit']>,
      roster: [ROSTER_READY.roster[0]!],
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: null },
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));

    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText(
        "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.",
      ),
    ).toBeInTheDocument();
  });

  it('an heir with no name on record: "Another contact on this property becomes the primary contact."', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1' } },
    });
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText('Another contact on this property becomes the primary contact.'),
    ).toBeInTheDocument();
  });

  it('no propertyContact block (the server could not tell): another contact MAY take over', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText('Another contact on this property may become the primary contact.'),
    ).toBeInTheDocument();
    // Never a client-side guess at the landlord of record.
    expect(within(dialog).queryByText(/James Porter/)).not.toBeInTheDocument();
  });

  it("the notice reads the LATEST roster write's block, not the load-time one", async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    });
    // Make Dana primary; the write answers with its own block - Alicia would
    // take over from Dana.
    addUnitContact.mockReset().mockResolvedValue({
      ...ROSTER_UNIT,
      primary_contact: 'pm2',
      contacts: [
        { contactId: 'pm1', role: 'pm', primaryContact: false, name: 'Alicia Grant' },
        { contactId: 'll1', role: 'landlord', primaryContact: false, name: 'James Porter' },
        { contactId: 'pm2', role: 'pm', primaryContact: true, name: 'Dana Reyes' },
      ],
      propertyContact: { contactId: 'pm2', heirIfPrimaryRemoved: { contactId: 'pm1', name: 'Alicia Grant' } },
    });
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' }));
    // Wait for the write to land: Dana is the primary row now.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }).parentElement,
      ).toHaveTextContent('Dana Reyes (primary)'),
    );
    await user.click(screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }));
    const dialog = await screen.findByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      within(dialog).getByText(
        'Alicia Grant becomes the primary contact - new tours and relay groups for this property will use them.',
      ),
    ).toBeInTheDocument();
  });

  it('a 409 primary_contact_deleted on Make primary names its own reason, and the re-read marks the row deleted', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    addUnitContact
      .mockReset()
      .mockRejectedValue(
        new ApiError(409, 'primary_contact_deleted', 'primary_contact_deleted', { error: 'primary_contact_deleted' }),
      );
    getUnit.mockReset().mockResolvedValue({
      ...ROSTER_UNIT,
      contacts: ROSTER_UNIT.contacts!.map((row) =>
        row.contactId === 'pm2' ? { ...row, deleted: true as const } : row,
      ),
    });
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That contact was deleted - restore them first or choose someone else.');
    expect(alert).not.toHaveTextContent(/landlord of record/);
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    // Settled: Dana is marked deleted and no longer offers Make primary.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Make Dana Reyes the primary contact' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }).parentElement,
    ).toHaveTextContent('Dana Reyes (deleted)');
  });

  it('a 503 roster_read_failed on removing the primary says the other contacts could not be checked, and re-reads nothing', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...ROSTER_READY,
      propertyContact: { contactId: 'pm1', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    });
    removeUnitContact
      .mockReset()
      .mockRejectedValue(
        new ApiError(503, 'roster_read_failed', 'roster_read_failed', { error: 'roster_read_failed' }),
      );
    getUnit.mockReset();
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this property' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the primary contact\?/i });
    await user.click(within(dialog).getByRole('button', { name: 'Remove contact' }));

    expect(removeUnitContact).toHaveBeenCalledWith('u1', 'pm1');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Couldn't check the other contacts - try again.",
    );
    // Nothing was written, so there is nothing to settle.
    expect(getUnit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Remove the primary contact\?/i })).toBeInTheDocument();
  });

  it('a 409 renders inline on the row, refetches the unit, and the row VISIBLY SETTLES', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(ROSTER_READY);
    // The lost race: another operator reassigned the property's landlord of
    // record to Dana while this page was open, so her remove now 409s.
    removeUnitContact.mockRejectedValue(
      new ApiError(409, 'cannot_remove_landlord_of_record', 'conflict'),
    );
    getUnit.mockResolvedValue({
      ...ROSTER_UNIT,
      landlordId: 'pm2',
      contacts: [
        { contactId: 'pm1', role: 'pm', primaryContact: true, name: 'Alicia Grant' },
        { contactId: 'pm2', role: 'landlord', primaryContact: false, name: 'Dana Reyes' },
        { contactId: 'll1', role: 'other', primaryContact: false, name: 'James Porter' },
      ],
    });
    renderAt();

    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/landlord of record/i);
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    // SETTLED into the truth: Dana is the landlord of record now, so her remove
    // is disabled - the click read as a real outcome, not a dead button.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }),
      ).toBeDisabled(),
    );
  });
});

// --- primary-contact-integrity (spec 7.3 / 7.4 / 7.5) ------------------------
// The server marks each roster row `deleted` / `caseworker` / `autoEligible`
// and sends a propertyContact block (7.5); the page renders them and never
// re-derives the heir rule or the automatic-routing rule. 470 Bolton is the
// motivating shape: no landlord of record, one contact (Mark, a property
// manager), nobody primary.

/** Mark Passmore, the 470 Bolton property manager - typed landlord (the
 *  server's `autoEligible`), live, not primary. */
const MARK: UnitContact = {
  contactId: 'pm-mark',
  role: 'pm',
  primaryContact: false,
  name: 'Mark Passmore',
  autoEligible: true,
};

/** A TENANT on the contact list (live, not a caseworker, never autoEligible). */
const TIA_TENANT: UnitContact = { contactId: 'tn-tia', role: 'other', primaryContact: false, name: 'Tia Tenant' };

/** A row whose contact was soft-deleted (the server's `deleted: true`). */
const GINA_DELETED: UnitContact = {
  contactId: 'pm-gone',
  role: 'pm',
  primaryContact: false,
  name: 'Gina Gone',
  deleted: true,
};

/** An OWNERLESS property whose roster is `contacts`, with the hook's rows
 *  derived exactly as useListing derives them (listingRoster) and the
 *  load-time propertyContact block when given. */
function integrityState(
  contacts: UnitContact[],
  propertyContact?: UnitPropertyContact,
  unitOver: Partial<NonNullable<ListingState['unit']>> = {},
): ListingState {
  const { landlordId: _ownerless, ...base } = READY.unit!;
  const unit: NonNullable<ListingState['unit']> = { ...base, contacts, ...unitOver };
  return {
    ...READY,
    unit,
    landlord: null,
    roster: listingRoster(unit, null),
    ...(propertyContact !== undefined && { propertyContact }),
  };
}

/** The Contacts card (its own <section>). */
function contactsCard(): HTMLElement {
  return screen.getByRole('heading', { name: /^Contacts/ }).closest('section') as HTMLElement;
}

describe('ListingDetail - deleted contact rows (primary-contact-integrity spec 7.4)', () => {
  beforeEach(() => {
    addUnitContact.mockReset();
    removeUnitContact.mockReset();
  });

  it('marks a deleted row "(deleted)" in view mode', () => {
    useListing.mockReturnValue(integrityState([{ ...MARK, primaryContact: true }, GINA_DELETED]));
    renderAt();
    const card = contactsCard();
    expect(within(card).getByRole('link', { name: /Gina Gone/ })).toHaveTextContent('Gina Gone (deleted)');
    expect(within(card).getByRole('link', { name: /Mark Passmore/ })).not.toHaveTextContent('(deleted)');
  });

  it('in edit mode a deleted row says "(deleted)" and offers no Make primary - its role select and Remove stay', async () => {
    const user = userEvent.setup();
    const dana: UnitContact = { contactId: 'pm-dana', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
    useListing.mockReturnValue(integrityState([{ ...MARK, primaryContact: true }, GINA_DELETED, dana]));
    renderAt();
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));

    const remove = screen.getByRole('button', { name: 'Remove Gina Gone from this property' });
    expect(remove.parentElement).toHaveTextContent('Gina Gone (deleted)');
    expect(remove).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Role for Gina Gone' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Make Gina Gone the primary contact' })).not.toBeInTheDocument();
    // A live non-primary row still offers it.
    expect(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' })).toBeInTheDocument();
  });

  it('the header facts subline skips a deleted row when naming the company', () => {
    useListing.mockReturnValue(
      integrityState([
        { ...GINA_DELETED, primaryContact: true, company: 'Gone LLC' },
        { ...MARK, company: 'BNS Property Management' },
      ]),
    );
    renderAt();
    expect(
      screen.getByText((t) => t.includes('2 BR') && t.includes('BNS Property Management')),
    ).toBeInTheDocument();
    expect(screen.queryByText((t) => t.includes('2 BR') && t.includes('Gone LLC'))).not.toBeInTheDocument();
  });

  it('the empty state says tours need a primary contact', () => {
    useListing.mockReturnValue(integrityState([]));
    renderAt();
    expect(within(contactsCard()).getByText('No contacts on this property yet. Tours need a primary contact.')).toBeInTheDocument();
  });
});

describe('ListingDetail - the no-primary box (primary-contact-integrity spec 7.4)', () => {
  /** The server's block for a property with no property contact. */
  const NO_PRIMARY: UnitPropertyContact = { contactId: null, reason: 'none', heirIfPrimaryRemoved: null };
  /** The no-eligible line (spec 7.4; planner fix wave F3 copy). */
  const NO_ELIGIBLE = 'Add a property manager or owner - they become the primary automatically.';
  const DANA: UnitContact = {
    contactId: 'pm-dana',
    role: 'pm',
    primaryContact: false,
    name: 'Dana Reyes',
    autoEligible: true,
  };
  const CASEY_CASEWORKER: UnitContact = {
    contactId: 'cw-casey',
    role: 'other',
    primaryContact: false,
    name: 'Casey Worker',
    caseworker: true,
  };

  beforeEach(() => {
    addUnitContact.mockReset();
    removeUnitContact.mockReset();
  });

  it('exactly one autoEligible row: "Make <Name> primary" above the rows - the same write as Make primary', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([MARK], NO_PRIMARY));
    const { landlordId: _ownerless, ...base } = READY.unit!;
    addUnitContact.mockResolvedValue({
      ...base,
      primary_contact: 'pm-mark',
      contacts: [{ ...MARK, primaryContact: true }],
      propertyContact: { contactId: 'pm-mark', heirIfPrimaryRemoved: null },
    });
    renderAt();

    const card = contactsCard();
    const box = within(card).getByRole('status');
    expect(within(box).getByText('No primary contact.')).toBeInTheDocument();
    expect(
      within(box).getByText("New tours won't include the landlord, and tour group texts use the general intro."),
    ).toBeInTheDocument();
    // ABOVE the rows.
    const row = within(card).getByRole('link', { name: /Mark Passmore/ });
    expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(box).getByRole('button', { name: 'Make Mark Passmore primary' }));
    expect(addUnitContact).toHaveBeenCalledWith('u1', { contactId: 'pm-mark', role: 'pm', primaryContact: true });
    // The write's own block names a property contact now: the box goes.
    await waitFor(() => expect(within(card).queryByRole('status')).not.toBeInTheDocument());
    expect(within(card).getByRole('link', { name: /Mark Passmore/ })).toHaveTextContent('Mark Passmore (primary)');
  });

  it('counts only autoEligible rows: a deleted row and a caseworker row do not count', () => {
    useListing.mockReturnValue(integrityState([MARK, GINA_DELETED, CASEY_CASEWORKER], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByRole('button', { name: 'Make Mark Passmore primary' })).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Choose a primary' })).not.toBeInTheDocument();
  });

  it('one autoEligible row next to a TENANT: the one-click names the landlord-typed row, never the tenant (planner fix wave F1)', () => {
    useListing.mockReturnValue(integrityState([TIA_TENANT, MARK], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByRole('button', { name: 'Make Mark Passmore primary' })).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Make Tia Tenant primary' })).not.toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Choose a primary' })).not.toBeInTheDocument();
    expect(within(box).queryByText(NO_ELIGIBLE)).not.toBeInTheDocument();
  });

  it('a TENANT the only live row: no one-click - the no-eligible line AND "Choose a primary", whose edit mode still offers the tenant by name (planner fix wave F1)', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([TIA_TENANT], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).queryByRole('button', { name: 'Make Tia Tenant primary' })).not.toBeInTheDocument();
    expect(within(box).getByText(NO_ELIGIBLE)).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Choose a primary' }));
    // Edit mode's per-row Make primary stays type-agnostic: a deliberate pick
    // with the name on the row.
    expect(screen.getByRole('button', { name: 'Make Tia Tenant the primary contact' })).toBeInTheDocument();
    expect(addUnitContact).not.toHaveBeenCalled();
  });

  it('two or more autoEligible rows: "Choose a primary" opens the edit mode, and no no-eligible line', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([MARK, TIA_TENANT, DANA], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).queryByRole('button', { name: /^Make .* primary$/ })).not.toBeInTheDocument();
    expect(within(box).queryByText(NO_ELIGIBLE)).not.toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: 'Choose a primary' }));
    expect(screen.getByRole('button', { name: 'Make Mark Passmore the primary contact' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Dana Reyes the primary contact' })).toBeInTheDocument();
    expect(addUnitContact).not.toHaveBeenCalled();
  });

  it('no live row that is not a caseworker (a deleted row and a caseworker): the line only, no button', () => {
    useListing.mockReturnValue(integrityState([GINA_DELETED, CASEY_CASEWORKER], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByText('No primary contact.')).toBeInTheDocument();
    expect(
      within(box).getByText('Add a property manager or owner - they become the primary automatically.'),
    ).toBeInTheDocument();
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });

  it('caseworkers only: the line only, no button', () => {
    useListing.mockReturnValue(integrityState([CASEY_CASEWORKER], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByText(NO_ELIGIBLE)).toBeInTheDocument();
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });

  it('every row deleted: the line only, no button', () => {
    const oscarDeleted: UnitContact = {
      contactId: 'ow-oscar',
      role: 'owner',
      primaryContact: false,
      name: 'Oscar Owner',
      deleted: true,
    };
    useListing.mockReturnValue(integrityState([GINA_DELETED, oscarDeleted], NO_PRIMARY));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByText(NO_ELIGIBLE)).toBeInTheDocument();
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });

  it("a deleted property contact leads with \"This property's contact was deleted.\"", () => {
    useListing.mockReturnValue(
      integrityState([{ ...GINA_DELETED, primaryContact: true }, MARK], {
        contactId: null,
        reason: 'deleted',
        heirIfPrimaryRemoved: { contactId: 'pm-mark', name: 'Mark Passmore' },
      }),
    );
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    expect(within(box).getByText("This property's contact was deleted.")).toBeInTheDocument();
    expect(within(box).queryByText('No primary contact.')).not.toBeInTheDocument();
    expect(
      within(box).getByText("New tours won't include the landlord, and tour group texts use the general intro."),
    ).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Make Mark Passmore primary' })).toBeInTheDocument();
  });

  it('no box when the block is absent (the server could not tell)', () => {
    useListing.mockReturnValue(integrityState([MARK]));
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('no box when the block names a property contact', () => {
    useListing.mockReturnValue(
      integrityState([{ ...MARK, primaryContact: true }], { contactId: 'pm-mark', heirIfPrimaryRemoved: null }),
    );
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('no box on a soft-deleted property (the card is read-only there)', () => {
    useListing.mockReturnValue(integrityState([MARK], NO_PRIMARY, { deleted_at: '2026-06-19T00:00:00.000Z' }));
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('no box with zero roster rows - the empty state speaks instead', () => {
    useListing.mockReturnValue(integrityState([], NO_PRIMARY));
    renderAt();
    expect(within(contactsCard()).queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/Tours need a primary contact\./)).toBeInTheDocument();
  });

  it('a failed write from the box shows its error inside the box', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(integrityState([MARK], NO_PRIMARY));
    addUnitContact.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    renderAt();
    const box = within(contactsCard()).getByRole('status');
    await user.click(within(box).getByRole('button', { name: 'Make Mark Passmore primary' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent("Couldn't save that change - please try again.");
  });
});

describe('ListingDetail - a restore re-reads the roster source (primary-contact-integrity spec 7.5)', () => {
  beforeEach(() => {
    restoreUnit.mockReset();
    getUnit.mockReset();
    getAllContacts.mockReset().mockResolvedValue([]);
  });

  it('a plain restore re-reads the property, and the re-read becomes the Contacts card roster', async () => {
    const user = userEvent.setup();
    const james: UnitContact = { contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' };
    const dana: UnitContact = { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
    const deletedUnit: NonNullable<ListingState['unit']> = {
      ...READY.unit!,
      deleted_at: '2026-06-19T00:00:00.000Z',
      contacts: [james, dana],
    };
    const { deleted_at: _live, ...liveUnit } = deletedUnit;
    // The re-read: the server's own roster now (Dana primary) and its block.
    const fresh: NonNullable<ListingState['unit']> = {
      ...liveUnit,
      contacts: [{ ...james, primaryContact: false }, { ...dana, primaryContact: true }],
      propertyContact: { contactId: 'pm2', heirIfPrimaryRemoved: { contactId: 'll1', name: 'James Porter' } },
    };
    restoreUnit.mockResolvedValue(liveUnit);
    getUnit.mockResolvedValue(fresh);
    let current: ListingState = {
      ...READY,
      unit: deletedUnit,
      roster: listingRoster(deletedUnit, null),
      setUnit: vi.fn((unit: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit };
      }),
    };
    useListing.mockImplementation(() => current);
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    expect(restoreUnit).toHaveBeenCalledWith('u1');
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));
    await waitFor(() =>
      expect(within(contactsCard()).getAllByRole('link')[0]).toHaveTextContent('Dana Reyes (primary)'),
    );
  });

  it('a restore through the landlord dialog re-reads the property; the re-read REPLACES the restore answer as the roster source', async () => {
    const user = userEvent.setup();
    const james: UnitContact = { contactId: 'll1', role: 'landlord', primaryContact: true, name: 'James Porter' };
    const dana: UnitContact = { contactId: 'pm2', role: 'pm', primaryContact: false, name: 'Dana Reyes' };
    const deletedUnit: NonNullable<ListingState['unit']> = {
      ...READY.unit!,
      deleted_at: '2026-06-19T00:00:00.000Z',
      landlordId: 'll1',
      primary_contact: 'll1',
      contacts: [james, dana],
    };
    const { landlordId: _cleared, deleted_at: _live, ...restoredBase } = deletedUnit;
    // The restore's own answer: James's row gone, Dana handed the primary - and
    // no propertyContact block (restore responses carry none).
    const restoreAnswer: NonNullable<ListingState['unit']> = {
      ...restoredBase,
      primary_contact: 'pm2',
      contacts: [{ ...dana, primaryContact: true }],
    };
    // The re-read carries the block: nobody would take over from Dana.
    const reread: NonNullable<ListingState['unit']> = {
      ...restoreAnswer,
      propertyContact: { contactId: 'pm2', heirIfPrimaryRemoved: null },
    };
    restoreUnit
      .mockRejectedValueOnce(
        new ApiError(409, 'restore_needs_landlord', 'restore_needs_landlord', {
          error: 'restore_needs_landlord',
          landlordName: 'James Porter',
        }),
      )
      .mockResolvedValueOnce(restoreAnswer);
    getUnit.mockResolvedValue(reread);
    let current: ListingState = {
      ...READY,
      unit: deletedUnit,
      roster: listingRoster(deletedUnit, null),
      setUnit: vi.fn((unit: NonNullable<ListingState['unit']>) => {
        current = { ...current, unit };
      }),
    };
    useListing.mockImplementation(() => current);
    renderAt();

    await user.click(screen.getAllByRole('button', { name: /^Restore$/i })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Restore property' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore without a landlord' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Restore property' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('u1'));

    // The re-read's block is what the remove confirm reads: the server says
    // nobody takes over. The restore answer alone (no block) would only let
    // the page say that someone MAY take over.
    await user.click(screen.getByRole('button', { name: 'Edit contacts' }));
    await user.click(screen.getByRole('button', { name: 'Remove Dana Reyes from this property' }));
    const confirm = await screen.findByRole('dialog', { name: /Remove the primary contact\?/i });
    expect(
      await within(confirm).findByText(
        "This property will have no primary contact. New tours won't include a landlord, and tour group texts will use the general intro.",
      ),
    ).toBeInTheDocument();
  });
});

describe('ListingDetail - "Sent to" outcomes (last-heard-from spec 5.5)', () => {
  const unit = { ...READY.unit!, address: { line1: '12 Oak St' } };
  const sent = (over: Record<string, unknown> = {}) => ({
    contactId: 'c-1', unitId: 'u1', sentAt: '2026-10-01T10:00:00.000Z', via: 'broadcast', tenantName: 'Tia Moss',
    outcome: 'no_reply', interestedSupported: true, interestedMode: 'route', eligible: true, ...over,
  });
  const card = (): HTMLElement => screen.getByRole('heading', { name: /^Sent to\b/ }).closest('section') as HTMLElement;

  beforeEach(() => {
    setListingSendOutcome.mockReset();
    createTour.mockReset();
    getAllContacts.mockResolvedValue([{ contactId: 'c-1', type: 'tenant', firstName: 'Tia', lastName: 'Moss' }]);
    getAllUnits.mockResolvedValue([{ unitId: 'u1', landlordId: 'll1', status: 'available', address: { line1: '12 Oak St' } }]);
  });

  it('renders the rows as four named lists in order - Waiting, Interested, Not interested, Not eligible (R1)', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [
          sent({ contactId: 'c-ne', tenantName: 'Ned Ineligible', eligible: false, sentAt: '2026-10-09T10:00:00.000Z' }),
          sent({ contactId: 'c-ni', tenantName: 'Nia Declined', outcome: 'not_interested', declined: { at: '2026-10-03T10:00:00.000Z', by: 'staff' } }),
          sent({ contactId: 'c-in', tenantName: 'Ian Toured', outcome: 'interested', tour: { tourId: 't-1', state: 'toured' } }),
          sent({ contactId: 'c-w', tenantName: 'Wes Waiting', sentAt: '2026-10-05T10:00:00.000Z' }),
          sent({ contactId: 'c-w2', tenantName: 'Wanda Older', sentAt: '2026-10-02T10:00:00.000Z' }),
        ],
      },
    });
    renderAt();
    const lists = within(card()).getAllByRole('list');
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual(['Waiting', 'Interested', 'Not interested', 'Not eligible']);
    // Every listitem in the card is one roster row - 5 rows, 5 listitems.
    expect(within(card()).getAllByRole('listitem')).toHaveLength(5);
    const namesIn = (label: string): Array<string | null> =>
      within(within(card()).getByRole('list', { name: label }))
        .getAllByRole('listitem')
        .map((li) => within(li).getAllByRole('link').find((a) => a.getAttribute('href')?.startsWith('/contacts/'))?.textContent ?? null);
    expect(namesIn('Waiting')).toEqual(['Wes Waiting', 'Wanda Older']);
    expect(namesIn('Interested')).toEqual(['Ian Toured']);
    expect(namesIn('Not interested')).toEqual(['Nia Declined']);
    expect(namesIn('Not eligible')).toEqual(['Ned Ineligible']);
  });

  it('an empty group renders no list', () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [sent()] } });
    renderAt();
    expect(within(card()).getAllByRole('list').map((l) => l.getAttribute('aria-label'))).toEqual(['Waiting']);
    expect(within(card()).getAllByRole('listitem')).toHaveLength(1);
  });

  // flyer-leads D8: a flyer sign-up on the property page - an eligible
  // recipient files under Interested with the waiting actions; an ineligible
  // one under Not eligible.
  it('a signed_up row files under Interested with "Signed up from the flyer <date>", the "Signed up" chip and both actions', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [sent({ outcome: 'signed_up' }), sent({ contactId: 'c-ne', tenantName: 'Ned Ineligible', outcome: 'signed_up', eligible: false })],
      },
    });
    renderAt();
    expect(within(card()).getAllByRole('list').map((l) => l.getAttribute('aria-label'))).toEqual(['Interested', 'Not eligible']);
    const li = within(within(card()).getByRole('list', { name: 'Interested' })).getByRole('listitem');
    expect(within(li).getByRole('link', { name: 'Tia Moss' })).toHaveAttribute('href', '/contacts/c-1');
    expect(within(li).getByText(/^Signed up from the flyer /)).toBeInTheDocument();
    expect(within(li).getByText('Signed up', { exact: true })).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' })).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' })).toBeInTheDocument();
    expect(within(within(card()).getByRole('list', { name: 'Not eligible' })).getByRole('link', { name: 'Ned Ineligible' })).toBeInTheDocument();
  });

  // flyer-leads AR13, PIN (pure rendering - the app projection owns the
  // label): a RESOLVED contact with no name (an auto-captured unknown sign-up)
  // arrives with its formatted phone in tenantName, and the row is named by
  // it - never by the raw contactId. A MISSING contact still has no
  // tenantName and keeps the contactId fallback (ListingDetail.tsx:1343).
  it('a nameless resolved recipient is labelled by the phone the server sends in tenantName; a missing one keeps the id', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [
          sent({ contactId: 'c-unk', tenantName: '(470) 555-0182', type: 'unknown', interestedSupported: false, outcome: 'signed_up' }),
          sent({ contactId: 'c-gone', tenantName: undefined, interestedSupported: false, eligible: false, recipientMissing: true }),
        ],
      },
    });
    renderAt();
    const link = within(card()).getByRole('link', { name: '(470) 555-0182' });
    expect(link).toHaveAttribute('href', '/contacts/c-unk');
    const li = link.closest('li') as HTMLElement;
    expect(within(li).getByText('Unknown')).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Mark (470) 555-0182 not interested in 12 Oak St' })).toBeInTheDocument();
    expect(within(card()).queryByText('c-unk')).not.toBeInTheDocument();
    expect(within(card()).getByRole('link', { name: 'c-gone' })).toHaveAttribute('href', '/contacts/c-gone');
  });

  it('Not interested calls the route and applies the returned { row } through setRecipientRow', async () => {
    const setRecipientRow = vi.fn();
    const returned = sent({ outcome: 'not_interested', declined: { at: '2026-10-13T10:00:00.000Z', by: 'staff' } });
    setListingSendOutcome.mockResolvedValue({ row: returned });
    useListing.mockReturnValue({ ...READY, unit, setRecipientRow, recipients: { status: 'ready', rows: [sent()] } });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss not interested in 12 Oak St' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c-1', 'not_interested');
    await waitFor(() => expect(setRecipientRow).toHaveBeenCalledWith('u1', 'c-1', returned));
  });

  it("Interested in 'route' mode calls the route with interested", async () => {
    setListingSendOutcome.mockResolvedValue({ row: sent({ outcome: 'interested', tour: { tourId: 't-new', state: 'requested' } }) });
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [sent()] } });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    expect(setListingSendOutcome).toHaveBeenCalledWith('u1', 'c-1', 'interested');
  });

  it("Interested in 'form' mode NAVIGATES to ?tour=new&tenantId=, the form opens with the tenant LOCKED, creates nothing, and Cancel clears both params (R4)", async () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [sent({ interestedMode: 'form' })] } });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/listings/u1?tour=new&tenantId=c-1'));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('group', { name: 'Tenant' })).toHaveTextContent('Tia Moss'));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toHaveValue('12 Oak St'));
    expect(setListingSendOutcome).not.toHaveBeenCalled();
    expect(createTour).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument());
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/);
  });

  it('a PARTNER row links "Request a tour" to ?tour=new on this page; the form opens with NO tenant, and Cancel clears the params', async () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: { status: 'ready', rows: [sent({ contactId: 'c-cw', tenantName: 'Cora Reyes', type: 'partner', role: 'Caseworker', interestedSupported: false })] },
    });
    renderAt();
    const link = screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 12 Oak St' });
    expect(link).toHaveAttribute('href', '/listings/u1?tour=new');
    await userEvent.click(link);
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    expect(within(dialog).getByRole('combobox', { name: 'Tenant' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument());
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/);
  });

  it('a LANDLORD row gets NO "Request a tour" link and no Interested button - only Not interested (B8)', () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: { status: 'ready', rows: [sent({ contactId: 'c-ll', tenantName: 'Lee Park', type: 'landlord', interestedSupported: false })] },
    });
    renderAt();
    expect(screen.queryByRole('link', { name: /^Request a tour/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Lee Park interested in 12 Oak St' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Lee Park not interested in 12 Oak St' })).toBeInTheDocument();
  });

  it('the dialog adds NO history entry: open (Interested, + Tour or the partner link) then Cancel, and Back leaves the property page', async () => {
    useListing.mockReturnValue({
      ...READY,
      unit,
      recipients: {
        status: 'ready',
        rows: [
          sent({ interestedMode: 'form' }),
          sent({ contactId: 'c-cw', tenantName: 'Cora Reyes', type: 'partner', interestedSupported: false }),
        ],
      },
    });
    function Back(): React.JSX.Element {
      const navigate = useNavigate();
      return <button type="button" onClick={() => void navigate(-1)}>test-back</button>;
    }
    render(
      <MemoryRouter initialEntries={['/elsewhere', '/listings/u1']} initialIndex={1}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="*" element={<div />} />
        </Routes>
        <LocationProbe />
        <Back />
      </MemoryRouter>,
    );
    const cancel = async (): Promise<void> => {
      const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/));
    };
    await userEvent.click(screen.getByRole('button', { name: 'Mark Tia Moss interested in 12 Oak St' }));
    await cancel();
    await userEvent.click(screen.getByRole('button', { name: 'Schedule a tour on this property' }));
    await cancel();
    await userEvent.click(screen.getByRole('link', { name: 'Request a tour for Cora Reyes at 12 Oak St' }));
    await cancel();
    // Three open/cancel cycles, still ONE entry for the property page.
    await userEvent.click(screen.getByRole('button', { name: 'test-back' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/elsewhere$/));
  });

  it('the URL entry ?tour=new&tenantId= opens the form on load with that tenant locked', async () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [] } });
    renderAt('u1', '?tour=new&tenantId=c-1');
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('group', { name: 'Tenant' })).toHaveTextContent('Tia Moss'));
  });

  it('a tenantId change while the form is open re-locks it to the NEW tenant (no stale label)', async () => {
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [] } });
    function Go(): React.JSX.Element {
      const navigate = useNavigate();
      return <button type="button" onClick={() => void navigate('/listings/u1?tour=new&tenantId=c-2', { replace: true })}>test-go</button>;
    }
    render(
      <MemoryRouter initialEntries={['/listings/u1?tour=new&tenantId=c-1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="*" element={<div />} />
        </Routes>
        <LocationProbe />
        <Go />
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('group', { name: 'Tenant' })).toHaveTextContent('Tia Moss'));
    // c-2 is not in the candidate list (and getContact is unmocked), so the
    // locked side falls back to the id - never the previous tenant's name.
    fireEvent.click(screen.getByRole('button', { name: 'test-go', hidden: true }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/listings/u1?tour=new&tenantId=c-2'));
    const reopened = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(reopened).getByRole('group', { name: 'Tenant' })).toHaveTextContent('c-2'));
    expect(within(reopened).getByRole('group', { name: 'Tenant' })).not.toHaveTextContent('Tia Moss');
  });

  it('after a create from the URL entry, Back returns to the card WITHOUT reopening the form', async () => {
    createTour.mockResolvedValue({ tourId: 't-new', tenantId: 'c-1', unitId: 'u1', tourType: 'self_guided', status: 'requested' });
    useListing.mockReturnValue({ ...READY, unit, recipients: { status: 'ready', rows: [] } });
    function Back(): React.JSX.Element {
      const navigate = useNavigate();
      return <button type="button" onClick={() => void navigate(-1)}>test-back</button>;
    }
    render(
      <MemoryRouter initialEntries={['/listings/u1?tour=new&tenantId=c-1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="*" element={<div />} />
        </Routes>
        <LocationProbe />
        <Back />
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Schedule a tour' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Schedule$/ })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Schedule$/ }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/tours/t-new'));
    await userEvent.click(screen.getByRole('button', { name: 'test-back' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/listings\/u1$/));
    expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument();
  });

  it('a deleted property shows the outcomes but no actions, and ?tour=new does not open the form', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { ...unit, deleted_at: '2026-10-01T00:00:00.000Z' },
      recipients: { status: 'ready', rows: [sent()] },
    });
    renderAt('u1', '?tour=new');
    expect(within(card()).getByText('No reply yet')).toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: /^Mark / })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Schedule a tour' })).not.toBeInTheDocument();
  });
});
