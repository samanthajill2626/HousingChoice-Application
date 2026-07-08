import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
const getUnits = vi.fn();
const getUnit = vi.fn();
const getContacts = vi.fn();
const getPlacementsBy = vi.fn();
const createPlacement = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    deleteUnit: (...a: unknown[]) => deleteUnit(...a),
    restoreUnit: (...a: unknown[]) => restoreUnit(...a),
    updateUnit: (...a: unknown[]) => updateUnit(...a),
    setListingStatus: (...a: unknown[]) => setListingStatus(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
    createPlacement: (...a: unknown[]) => createPlacement(...a),
  };
});

import { ListingDetail } from './ListingDetail.js';

function renderAt(unitId = 'u1'): void {
  render(
    <MemoryRouter initialEntries={[`/listings/${unitId}`]}>
      <Routes>
        <Route path="/listings/:unitId" element={<ListingDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const READY: ListingState = {
  status: 'ready',
  setUnit: vi.fn(),
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
    jurisdiction: 'Atlanta',
    area: 'West End',
    utilities: 'Tenant-paid',
    accessibility: 'Ground floor',
    pets: 'Cats only',
    application_fee: 25,
    same_day_rta: true,
    voucher_size_accepted: 2,
    video_url: 'https://example.com/tour.mp4',
    accepted_programs: ['Housing Choice Voucher (HCV)', 'Section 8', 'VASH'],
    tour_process: 'Text the landlord to arrange access.',
    application_process: 'Apply via the property portal.',
    media: ['https://example.com/photo-1.jpg', 'units/u1/photo-2.jpg'],
  },
  landlord: { contactId: 'll1', type: 'landlord', firstName: 'James', lastName: 'Porter' } as never,
  roster: [
    {
      contactId: 'll1',
      name: 'James Porter',
      roleLabel: 'Landlord',
      company: 'Porter Properties',
      primaryVoice: true,
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
};

// Default contacts so the placement card can resolve tenantId 't1' → "Fixture Tenant"
// (a name unique to this file, so it can't collide with other rows' contact names).
beforeEach(() => {
  useContacts.mockReturnValue({
    status: 'ready',
    contacts: [
      { contactId: 't1', type: 'tenant', status: 'active', firstName: 'Fixture', lastName: 'Tenant', phone: '+14045550111' },
    ],
  });
});

afterEach(() => vi.restoreAllMocks());

/** Change the property status via the interactive pill: open it, then pick an option. */
async function chooseStatus(
  user: ReturnType<typeof userEvent.setup>,
  optionLabel: string,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /Property status/i }));
  await user.click(screen.getByRole('menuitemradio', { name: optionLabel }));
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
    // IS available inline on the Property details + Tour & application cards (two
    // real, clickable CardAction buttons; the ⋯ menu's Edit is hidden until open).
    expect(screen.getAllByRole('button', { name: /Edit/ })).toHaveLength(2);
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
    const utilities = within(dialog).getByLabelText(/Utilities/i);
    expect(utilities).toHaveValue('Tenant-paid');

    await user.clear(utilities);
    await user.type(utilities, 'Owner-paid');
    await user.click(within(dialog).getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Owner-paid' });
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

  it('renders property details and accepted vouchers as a bulleted list', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByText('$1,550')).toBeInTheDocument(); // payment standard
    expect(screen.getByText('Tenant-paid')).toBeInTheDocument();
    expect(screen.getByText('Cats only')).toBeInTheDocument();
    // Flyer-detail fields now surface on the read view (staff see what's on the flyer).
    expect(screen.getByText('Application fee')).toBeInTheDocument();
    expect(screen.getByText('$25')).toBeInTheDocument();
    expect(screen.getByText('Same-day RTA')).toBeInTheDocument();
    // The accepted voucher size (distinct from beds) surfaces as a detail row.
    expect(screen.getByText('Voucher size accepted')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Watch video' })).toHaveAttribute(
      'href',
      'https://example.com/tour.mp4',
    );
    const list = screen.getByRole('list', { name: /Accepted vouchers/i });
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Housing Choice Voucher (HCV)', 'Section 8', 'VASH']);
  });

  it('omits the "Voucher size accepted" detail row when it is unset', () => {
    const { voucher_size_accepted: _omit, ...rest } = READY.unit!;
    useListing.mockReturnValue({ ...READY, unit: rest });
    renderAt();
    expect(screen.queryByText('Voucher size accepted')).not.toBeInTheDocument();
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

  it('renders Activity rows: staff copy labels, times, and contact link-outs', () => {
    useListing.mockReturnValue({
      ...READY,
      activity: {
        status: 'ready',
        rows: [
          {
            id: '2026-07-02T14:30:00.000Z#000002',
            at: '2026-07-02T14:30:00.000Z',
            type: 'listing_response_set',
            contactId: 'c-t1',
            contactName: 'Tina Renter',
            response: 'interested',
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
    // The response event links out to the tenant's contact file.
    expect(screen.getByRole('link', { name: /Tenant response - Interested/ })).toHaveAttribute(
      'href',
      '/contacts/c-t1',
    );
    expect(screen.getByText('Tina Renter')).toBeInTheDocument();
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

  it('renders photos from media, with a placeholder for bare S3 keys', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    // The URL media renders an <img>; the bare S3 key renders a placeholder (no img src).
    const imgs = screen.getAllByRole('img');
    expect(imgs.some((i) => i.getAttribute('src') === 'https://example.com/photo-1.jpg')).toBe(true);
    expect(screen.getByText(/Add/)).toBeInTheDocument();
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

  it('the ⋯ menu holds Start placement + Broadcast to tenants (moved off the hero)', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue(READY);
    renderAt();
    // Neither is a standalone hero button anymore.
    expect(screen.queryByRole('button', { name: 'Start placement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Broadcast to tenants/ })).not.toBeInTheDocument();
    // Both live in the ⋯ menu.
    await user.click(screen.getByRole('button', { name: /More actions/ }));
    expect(screen.getByRole('menuitem', { name: 'Start placement' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Broadcast to tenants' })).toBeInTheDocument();
  });

  it('the ⋯ menu "Start placement" opens the create dialog pre-filled+locked to this unit', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({
      ...READY,
      unit: { ...READY.unit!, address: { line1: '1450 Joseph Blvd NW' } },
    });
    getUnits.mockResolvedValue({ units: [], nextCursor: null });
    getUnit.mockResolvedValue({ unitId: 'u1', landlordId: 'll1', status: 'available', address: { line1: '1450 Joseph Blvd NW' } });
    getContacts.mockResolvedValue({ contacts: [], nextCursor: null });
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
  });
});
