import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TenantFile } from './TenantFile.js';
import { LandlordFile } from './LandlordFile.js';
import type { CommsMediaItem } from './media.js';
import type { PlacementItem, Contact, UnitItem } from '../../api/index.js';

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
  tours: [{ date: '2026-06-13', outcome: 'Toured' }],
};

describe('TenantFile', () => {
  const contact: Contact = {
    contactId: 'T1',
    type: 'tenant',
    voucherSize: 2,
    status: 'Active',
    phone: '+14040100007',
  };

  function renderIt(opts: { listingsSentPending?: boolean; media?: CommsMediaItem[] } = {}) {
    return render(
      <MemoryRouter>
        <TenantFile
          contact={contact}
          phones={[{ phone: '+14040100007', primary: true }]}
          placements={[TENANT_CASE]}
          units={[UNIT]}
          listingsSentPending={opts.listingsSentPending ?? true}
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

  it('renders REAL placements + tours linking to the placement route', () => {
    renderIt();
    const placementLinks = screen.getAllByRole('link', { name: /1450 Joseph Blvd/ });
    expect(placementLinks.length).toBeGreaterThan(0);
    expect(placementLinks[0]).toHaveAttribute('href', '/placements/k1');
    expect(screen.getByText('Toured')).toBeInTheDocument();
  });

  it('shows the pending state for listings-sent until the backend lands', () => {
    renderIt({ listingsSentPending: true });
    expect(screen.getAllByText(/Arrives with the backend/i).length).toBeGreaterThanOrEqual(1);
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

  function renderIt() {
    return render(
      <MemoryRouter>
        <LandlordFile
          contact={contact}
          phones={[{ phone: '+14042220190', primary: true }]}
          placements={[{ ...TENANT_CASE, unitId: 'u1' }]}
          units={[UNIT, PLACED_UNIT]}
          media={[]}
        />
      </MemoryRouter>,
    );
  }

  it('renders the landlord listings with status, linking to the listing route', () => {
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
});
