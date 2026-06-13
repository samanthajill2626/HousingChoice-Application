// Flyer (public) tests — renders the flyer fields; 404 → friendly "listing not
// available". Mock the api barrel (stub getUnitFlyer); no network/session.
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitFlyer } from '../../api/index.js';

const { getUnitFlyerMock } = vi.hoisted(() => ({ getUnitFlyerMock: vi.fn() }));

vi.mock('../../api/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../api/index.js')>();
  return { ...actual, getUnitFlyer: getUnitFlyerMock };
});

const { default: Flyer } = await import('../Flyer.js');

function flyer(over: Partial<UnitFlyer> = {}): UnitFlyer {
  return {
    unitId: 'u1',
    media: ['https://cdn.example.com/p1.jpg'],
    beds: 2,
    baths: 1,
    area: 'Eastside',
    subzone: 'North',
    voucher_size: 2,
    accepted_programs: ['HCV'],
    listing_link: 'https://listings.example.com/u1',
    rent_min: 1200,
    rent_max: 1500,
    ...over,
  };
}

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={['/flyer/u1']}>
      <Routes>
        <Route path="/flyer/:unitId" element={<Flyer />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getUnitFlyerMock.mockReset();
});

describe('<Flyer> (public)', () => {
  it('renders the flyer fields', async () => {
    getUnitFlyerMock.mockResolvedValue(flyer());
    renderAt();

    expect(await screen.findByText(/2-bed home in Eastside/)).toBeInTheDocument();
    // Rent appears as a subtitle (per month) and in the facts.
    expect(screen.getAllByText(/\$1,200–\$1,500/).length).toBeGreaterThan(0);
    expect(screen.getByText('HCV')).toBeInTheDocument();
    // The image media renders as an <img>.
    expect(screen.getByRole('img', { name: /Listing photo 1/ })).toHaveAttribute(
      'src',
      'https://cdn.example.com/p1.jpg',
    );
    // The full-listing link.
    expect(screen.getByRole('link', { name: /view the full listing/i })).toHaveAttribute(
      'href',
      'https://listings.example.com/u1',
    );
  });

  it('shows a friendly not-available message on 404', async () => {
    const { ApiError } = await import('../../api/index.js');
    getUnitFlyerMock.mockRejectedValueOnce(new ApiError(404, 'not_found', 'not_found'));
    renderAt();
    expect(await screen.findByText('Listing not available')).toBeInTheDocument();
  });
});
