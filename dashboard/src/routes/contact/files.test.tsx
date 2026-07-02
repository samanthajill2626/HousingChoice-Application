import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import type { CommsMediaItem } from './media.js';
import type { PlacementItem, Contact, Tour, UnitItem, ListingSendRow } from '../../api/index.js';

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'L1',
  status: 'available',
  beds: 2,
  address: { line1: '1450 Joseph Blvd', city: 'Atlanta', state: 'GA' },
};
const PLACED_UNIT: UnitItem = { unitId: 'u2', landlordId: 'L1', status: 'occupied', beds: 1, address: '88 Lindbergh' };

const TENANT_CASE: PlacementItem = {
  placementId: 'k1',
  tenantId: 'T1',
  unitId: 'u1',
  stage: 'schedule_inspection',
};

const TOUR: Tour = {
  tourId: 'tour-1',
  tenantId: 'T1',
  unitId: 'u1',
  scheduledAt: '2026-06-13T14:00:00Z',
  tourType: 'self_guided',
  status: 'scheduled',
};

describe('TenantFile', () => {
  const contact: Contact = {
    contactId: 'T1',
    type: 'tenant',
    voucherSize: 2,
    status: 'Active',
    phone: '+14040100007',
  };

  function renderIt(
    opts: {
      listingsSentPending?: boolean;
      listingsSent?: ListingSendRow[];
      media?: CommsMediaItem[];
      tours?: Tour[];
    } = {},
  ) {
    return render(
      <MemoryRouter>
        <TenantFile
          contact={contact}
          phones={[{ phone: '+14040100007', primary: true }]}
          placements={[TENANT_CASE]}
          tours={opts.tours ?? []}
          units={[UNIT]}
          listingsSentPending={opts.listingsSentPending ?? true}
          listingsSent={opts.listingsSent ?? []}
          media={opts.media ?? []}
        />
      </MemoryRouter>,
    );
  }

  it('renders Details with voucher, phone, status', () => {
    renderIt();
    expect(screen.getByText('2 BR')).toBeInTheDocument();
    expect(screen.getByText('(404) 010-0007')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders REAL placements linking to the placement route', () => {
    renderIt();
    const placementLinks = screen.getAllByRole('link', { name: /1450 Joseph Blvd/ });
    expect(placementLinks.length).toBeGreaterThan(0);
    // The placements card links to /placements/:placementId
    const placementLink = placementLinks.find((a) => a.getAttribute('href') === '/placements/k1');
    expect(placementLink).toBeDefined();
  });

  it('renders the Tours card with "No tours yet." when empty', () => {
    renderIt({ tours: [] });
    expect(screen.getByText('No tours yet.')).toBeInTheDocument();
  });

  it('renders tours from the tours API — one row per tour with status + scheduledAt, linking to tour detail', () => {
    renderIt({ tours: [TOUR] });
    // Should NOT say "No tours yet."
    expect(screen.queryByText('No tours yet.')).not.toBeInTheDocument();
    // Find the tour link by href (multiple links may have the same address text as placements)
    const allLinks = screen.getAllByRole('link');
    const tourDetailLink = allLinks.find((a) => a.getAttribute('href') === '/tours/tour-1');
    expect(tourDetailLink).toBeDefined();
    // Shows the status label "Scheduled" (may also appear elsewhere, so check at least once)
    const statusCells = screen.getAllByText('Scheduled');
    expect(statusCells.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the pending state for listings-sent until the backend lands', () => {
    renderIt({ listingsSentPending: true });
    expect(screen.getAllByText(/Arrives with the backend/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders Properties-sent rows linking to the unit, with the response (C4 data)', () => {
    renderIt({
      listingsSentPending: false,
      listingsSent: [
        { contactId: 'T1', unitId: 'u1', response: 'no_reply', sentAt: '2026-06-30T10:00:00Z', via: 'broadcast' },
      ],
    });
    // The sent row links to the LISTING route (placements/tours link to /placements/* or /tours/*),
    // so a /listings/u1 link uniquely identifies the Properties-sent row.
    const sentLink = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/listings/u1');
    expect(sentLink).toBeDefined();
    expect(sentLink).toHaveTextContent(/1450 Joseph Blvd/);
    expect(screen.getByText('No reply')).toBeInTheDocument();
  });

  it('shows "No properties sent yet." when the slice is ready but empty', () => {
    renderIt({ listingsSentPending: false, listingsSent: [] });
    expect(screen.getByText('No properties sent yet.')).toBeInTheDocument();
  });

  it('renders a timeless (requested) tour row as "Not booked" — never "Invalid Date"', () => {
    const requestedTour: Tour = {
      tourId: 'tour-req',
      tenantId: 'T1',
      unitId: 'u1',
      tourType: 'landlord_led',
      status: 'requested',
    };
    renderIt({ tours: [requestedTour] });
    const allLinks = screen.getAllByRole('link');
    const tourDetailLink = allLinks.find((a) => a.getAttribute('href') === '/tours/tour-req');
    expect(tourDetailLink).toBeDefined();
    expect(tourDetailLink).toHaveTextContent(/1450 Joseph Blvd.*·.*Not booked/);
    expect(screen.queryByText(/Invalid Date/i)).not.toBeInTheDocument();
    // The rendered status label, not the raw enum.
    expect(screen.getByText('Requested')).toBeInTheDocument();
  });

  it('shows "No media yet" when there is no comms media', () => {
    renderIt({ media: [] });
    expect(screen.getByText(/No media yet/i)).toBeInTheDocument();
  });

  it('renders a media-from-comms thumbnail linking to the authed media URL', () => {
    renderIt({
      media: [{ key: 'MM1:0', src: '/api/messages/MM1/media/0', contentType: 'image/png', at: '2026-06-17T10:00:00Z' }],
    });
    const img = screen.getByRole('img', { name: /Attachment/i });
    expect(img).toHaveAttribute('src', '/api/messages/MM1/media/0');
    expect(screen.queryByText(/No media yet/i)).not.toBeInTheDocument();
  });
});

describe('LandlordFile', () => {
  const contact: Contact = {
    contactId: 'L1',
    type: 'landlord',
    status: 'Active',
    phone: '+14042220190',
    company: 'Porter Properties',
  };

  function renderIt(opts: { tours?: Tour[] } = {}) {
    return render(
      <MemoryRouter>
        <LandlordFile
          contact={contact}
          phones={[{ phone: '+14042220190', primary: true }]}
          placements={[{ ...TENANT_CASE, unitId: 'u1' }]}
          tours={opts.tours ?? []}
          units={[UNIT, PLACED_UNIT]}
          media={[]}
        />
      </MemoryRouter>,
    );
  }

  it('renders the landlord properties with status, linking to the property route', () => {
    renderIt();
    const link = screen.getByRole('link', { name: /1450 Joseph Blvd, Atlanta, GA · 2BR/ });
    expect(link).toHaveAttribute('href', '/listings/u1');
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Occupied')).toBeInTheDocument();
  });

  it('renders company + role in Details', () => {
    renderIt();
    expect(screen.getByText('Porter Properties')).toBeInTheDocument();
    expect(screen.getByText('Landlord')).toBeInTheDocument();
  });

  it('renders placements on their units linking to the placement route', () => {
    renderIt();
    const placementLink = screen.getByRole('link', { name: /1450 Joseph Blvd, Atlanta, GA Schedule inspection/i });
    expect(placementLink).toHaveAttribute('href', '/placements/k1');
  });

  it('renders the Tours card with "No tours on these properties yet." when empty', () => {
    renderIt({ tours: [] });
    expect(screen.getByText('No tours on these properties yet.')).toBeInTheDocument();
  });

  it('renders property tours from the tours API — one row per tour with status + date, linking to tour detail', () => {
    const landlordTour: Tour = {
      tourId: 'tour-L1',
      tenantId: 'T1',
      unitId: 'u1',
      scheduledAt: '2026-07-01T10:00:00Z',
      tourType: 'landlord_led',
      status: 'confirmed',
    };
    renderIt({ tours: [landlordTour] });
    expect(screen.queryByText('No tours on these properties yet.')).not.toBeInTheDocument();
    // Find the tour link by href (multiple links may have the same address text)
    const allLinks = screen.getAllByRole('link');
    const tourDetailLink = allLinks.find((a) => a.getAttribute('href') === '/tours/tour-L1');
    expect(tourDetailLink).toBeDefined();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('renders a timeless (requested) tour row as "Not booked" — never "Invalid Date"', () => {
    const requestedTour: Tour = {
      tourId: 'tour-L2',
      tenantId: 'T1',
      unitId: 'u1',
      tourType: 'pm_team',
      status: 'requested',
    };
    renderIt({ tours: [requestedTour] });
    const allLinks = screen.getAllByRole('link');
    const tourDetailLink = allLinks.find((a) => a.getAttribute('href') === '/tours/tour-L2');
    expect(tourDetailLink).toBeDefined();
    expect(tourDetailLink).toHaveTextContent(/1450 Joseph Blvd.*·.*Not booked/);
    expect(screen.queryByText(/Invalid Date/i)).not.toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
  });
});
