import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ListingState } from './useListing.js';

const useListing = vi.fn();
vi.mock('./useListing.js', () => ({ useListing: (id: string) => useListing(id) }));

const setListingStatus = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, setListingStatus: (...a: unknown[]) => setListingStatus(...a) };
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
  casesOnUnit: [{ caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'awaiting_approval' }],
  related: {
    status: 'ready',
    rows: [{ unitId: 'u2', status: 'occupied', relation: 'same_landlord', label: 'Same landlord' }],
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
    const heading = screen.getByRole('heading', { name: /1450 Joseph Blvd NW/ });
    expect(heading).toBeInTheDocument();
    // The status badge lives inside the heading (the select option also reads
    // "Available", so scope to the heading to disambiguate).
    expect(within(heading).getByText('Available')).toBeInTheDocument();
    expect(screen.getByText(/2 BR · 1 BA · \$1,400–1,600\/mo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Broadcast to tenants/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More actions/ })).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: /Awaiting approval/ })).toHaveAttribute('href', '/cases/c1');
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

  it('the status select calls setListingStatus and applies the returned unit (badge updates)', async () => {
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
    await user.selectOptions(screen.getByRole('combobox', { name: /Listing status/i }), 'off_market');

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

    // First change FAILS → an inline error appears (no silent swallow).
    setListingStatus.mockRejectedValueOnce(new Error('boom'));
    renderAt();
    await user.selectOptions(screen.getByRole('combobox', { name: /Listing status/i }), 'off_market');
    await waitFor(() =>
      expect(screen.getByText(/Couldn.t update the listing status/i)).toBeInTheDocument(),
    );

    // A subsequent SUCCESSFUL change clears the error.
    setListingStatus.mockResolvedValueOnce({ ...READY.unit!, status: 'on_hold' });
    await user.selectOptions(screen.getByRole('combobox', { name: /Listing status/i }), 'on_hold');
    await waitFor(() =>
      expect(screen.queryByText(/Couldn.t update the listing status/i)).not.toBeInTheDocument(),
    );
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
});
