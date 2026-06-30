// FlyerFunnel tests (spec §9) — the teaser→intake→reveal state machine on the
// public /p/:unitId route. Covers: the full happy path (teaser → "I'm
// interested" → intake → submit → reveal); the teaser leaks NO address/fees/
// external link; the reveal shows address + video + utilities + app fee +
// same-day RTA; a 404/not-shareable unit shows the friendly unavailable state;
// a details-fetch failure still shows the thank-you. Public API module mocked.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import type { PublicFlyer, PublicFlyerDetails } from './publicApi.js';

const getFlyer = vi.fn();
const getFlyerDetails = vi.fn();
const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return {
    ...actual,
    getFlyer: (...a: unknown[]) => getFlyer(...a),
    getFlyerDetails: (...a: unknown[]) => getFlyerDetails(...a),
    submitHousingFair: (...a: unknown[]) => submitHousingFair(...a),
  };
});

import { FlyerFunnel } from './FlyerFunnel.js';

const FLYER: PublicFlyer = {
  unitId: 'unit-1',
  media: ['https://img.example/a.jpg'],
  beds: 3,
  baths: 2,
  area: 'Decatur',
  subzone: 'Oakhurst',
  voucher_size: 3,
  accepted_programs: ['HCV', 'VASH'],
  listing_link: 'https://external.example/listing/1',
  rent_min: 1800,
  rent_max: 2000,
};

const DETAILS: PublicFlyerDetails = {
  ...FLYER,
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
  utilities: 'Tenant-paid',
  video_url: 'https://video.example/tour',
  application_fee: 40,
  same_day_rta: true,
};

function renderFunnel(unitId = 'unit-1') {
  return render(
    <MemoryRouter initialEntries={[`/p/${unitId}`]}>
      <Routes>
        <Route path="/p/:unitId" element={<FlyerFunnel />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('FlyerFunnel', () => {
  it('walks teaser → interested → intake → submit → reveal', async () => {
    const user = userEvent.setup();
    getFlyer.mockResolvedValue(FLYER);
    submitHousingFair.mockResolvedValue(undefined);
    getFlyerDetails.mockResolvedValue(DETAILS);
    renderFunnel();

    // Teaser.
    await screen.findByRole('button', { name: /i'm interested/i });
    expect(screen.getByText(/Oakhurst/i)).toBeInTheDocument();

    // → intake.
    await user.click(screen.getByRole('button', { name: /i'm interested/i }));
    const phone = await screen.findByLabelText(/phone number/i);

    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.type(phone, '4045551234');
    await user.click(screen.getByRole('button', { name: /get the full details/i }));

    // Submitted WITH the unitId.
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalled());
    expect(submitHousingFair).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace', phone: '4045551234', unitId: 'unit-1' }),
    );

    // → reveal (full details).
    expect(await screen.findByText(/88 Sycamore St/i)).toBeInTheDocument();
    expect(screen.getByText(/Tenant-paid/i)).toBeInTheDocument();
    expect(screen.getByText(/\$40/)).toBeInTheDocument();
    expect(screen.getByText(/Same-day RTA/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /watch the tour/i })).toHaveAttribute(
      'href',
      'https://video.example/tour',
    );
  });

  it('teaser shows NO address, fees, or external listing link', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderFunnel();
    await screen.findByRole('button', { name: /i'm interested/i });

    expect(screen.queryByText(/88 Sycamore St/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/application fee/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /listing/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/external\.example/i)).not.toBeInTheDocument();
  });

  it('shows the friendly unavailable state on a 404 (missing/not-shareable)', async () => {
    getFlyer.mockRejectedValue(new ApiError(404, 'not_found', 'Not Found'));
    renderFunnel();
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /i'm interested/i })).not.toBeInTheDocument();
  });

  it('still shows the thank-you when the details fetch fails after submit', async () => {
    const user = userEvent.setup();
    getFlyer.mockResolvedValue(FLYER);
    submitHousingFair.mockResolvedValue(undefined);
    getFlyerDetails.mockRejectedValue(new ApiError(404, 'not_found', 'Not Found'));
    renderFunnel();

    await user.click(await screen.findByRole('button', { name: /i'm interested/i }));
    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.type(screen.getByLabelText(/phone number/i), '4045551234');
    await user.click(screen.getByRole('button', { name: /get the full details/i }));

    expect(await screen.findByText(/you're all set/i)).toBeInTheDocument();
    // No address surfaced (details failed) but the conversion is preserved.
    expect(screen.queryByText(/88 Sycamore St/i)).not.toBeInTheDocument();
  });
});
