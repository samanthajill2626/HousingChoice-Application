import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ListingState } from './useListing.js';

const useListing = vi.fn();
vi.mock('./useListing.js', () => ({ useListing: (id: string) => useListing(id) }));

const deleteUnit = vi.fn();
const restoreUnit = vi.fn();
const updateUnit = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    deleteUnit: (...a: unknown[]) => deleteUnit(...a),
    restoreUnit: (...a: unknown[]) => restoreUnit(...a),
    updateUnit: (...a: unknown[]) => updateUnit(...a),
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
  casesOnUnit: [{ caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'applied' }],
  related: {
    status: 'ready',
    rows: [{ unitId: 'u2', status: 'placed', relation: 'same_landlord', label: 'Same landlord' }],
  },
  recipients: { status: 'pending' },
  similar: { status: 'pending' },
};

afterEach(() => vi.restoreAllMocks());

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
    expect(screen.getByRole('heading', { name: /1450 Joseph Blvd NW/ })).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText(/2 BR · 1 BA · \$1,400–1,600\/mo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Broadcast to tenants/ })).toBeInTheDocument();
    // Edit now lives under the ⋯ menu, not as a header button.
    expect(screen.queryByRole('button', { name: /^✎? ?Edit$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More actions/ })).toBeInTheDocument();
  });

  it('opens the edit dialog from the ⋯ menu and PATCHes only the changed fields', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({ ...READY, setUnit: vi.fn() });
    updateUnit.mockResolvedValue({ ...READY.unit });
    renderAt();

    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Edit listing/i }));

    // The edit dialog is open with the current values prefilled.
    const dialog = screen.getByRole('dialog', { name: /Edit listing/i });
    const utilities = within(dialog).getByLabelText(/Utilities/i);
    expect(utilities).toHaveValue('Tenant-paid');

    await user.clear(utilities);
    await user.type(utilities, 'Owner-paid');
    await user.click(within(dialog).getByRole('button', { name: /^Save$/i }));

    expect(updateUnit).toHaveBeenCalledWith('u1', { utilities: 'Owner-paid' });
  });

  it('shows an honest pending note for the flyer (no misleading JSON link)', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByText(/Public flyer page arrives with the new public routes/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View flyer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy public link/ })).not.toBeInTheDocument();
  });

  it('renders listing details and accepted vouchers as a bulleted list', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByText('$1,550')).toBeInTheDocument(); // payment standard
    expect(screen.getByText('Tenant-paid')).toBeInTheDocument();
    expect(screen.getByText('Cats only')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: /Accepted vouchers/i });
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Housing Choice Voucher (HCV)', 'Section 8', 'VASH']);
  });

  it('links roster rows to the contact page and cases to the case page', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('link', { name: /James Porter/ })).toHaveAttribute(
      'href',
      '/contacts/ll1',
    );
    expect(screen.getByRole('link', { name: /Applied/ })).toHaveAttribute('href', '/cases/c1');
  });

  it('links related listings to their listing page', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getByRole('link', { name: /u2/ })).toHaveAttribute('href', '/listings/u2');
  });

  it('renders pending panels for Sent-to-tenants (C4) and Similar (C6)', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    expect(screen.getAllByText('Arrives with the backend.').length).toBeGreaterThanOrEqual(2);
  });

  it('renders photos from media, with a placeholder for bare S3 keys', () => {
    useListing.mockReturnValue(READY);
    renderAt();
    // The URL media renders an <img>; the bare S3 key renders a placeholder (no img src).
    const imgs = screen.getAllByRole('img');
    expect(imgs.some((i) => i.getAttribute('src') === 'https://example.com/photo-1.jpg')).toBe(true);
    expect(screen.getByText(/Add/)).toBeInTheDocument();
  });

  it('falls back gracefully when optional fields are missing', () => {
    useListing.mockReturnValue({
      ...READY,
      unit: { unitId: 'u1', landlordId: 'll1', status: 'available' },
      casesOnUnit: [],
      related: { status: 'ready', rows: [] },
    });
    renderAt();
    // Still renders the page heading (unitId fallback) without throwing.
    expect(screen.getByRole('heading', { name: /u1/ })).toBeInTheDocument();
  });

  it('deleting confirms first, then DELETEs and navigates back to the Listings list', async () => {
    const user = userEvent.setup();
    useListing.mockReturnValue({ ...READY, setUnit: vi.fn() });
    deleteUnit.mockResolvedValue({ ...READY.unit, deleted_at: '2026-06-19T00:00:00.000Z' });

    render(
      <MemoryRouter initialEntries={['/listings/u1']}>
        <Routes>
          <Route path="/listings/:unitId" element={<ListingDetail />} />
          <Route path="/listings" element={<div>LISTINGS LIST</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /More actions/i }));
    await user.click(screen.getByRole('menuitem', { name: /Delete listing/i }));

    // A confirm dialog appears — nothing deleted yet.
    expect(screen.getByRole('dialog', { name: /Delete listing\?/i })).toBeInTheDocument();
    expect(deleteUnit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Delete$/i }));
    expect(deleteUnit).toHaveBeenCalledWith('u1');
    await screen.findByText('LISTINGS LIST');
  });

  it('shows the Deleted banner + Restore for a deleted listing and restores in place', async () => {
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
