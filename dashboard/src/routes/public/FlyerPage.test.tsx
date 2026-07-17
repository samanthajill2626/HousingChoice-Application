// FlyerPage tests (flyer-full-info) - the single public /p/:unitId page: all
// tenant-useful info shown UPFRONT (no teaser/intake/reveal funnel), with a
// bottom CTA chosen by ?cta=text. Covers: the public (form) variant shows every
// detail row + the intake form and swaps ONLY the CTA to a thank-you on submit;
// the known-tenant (text) variant renders a tap-to-text sms: link with an
// encoded prefill and NO form, strips the cta param from the URL on load, and
// survives a same-tab remount via sessionStorage; the null-contact degrade; the
// unsafe-URL guard; and the variant-aware unavailable state. Public API mocked.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import type { PublicFlyer } from './publicApi.js';

const getFlyer = vi.fn();
const submitHousingFair = vi.fn();
vi.mock('./publicApi.js', async () => {
  const actual = await vi.importActual<typeof import('./publicApi.js')>('./publicApi.js');
  return {
    ...actual,
    getFlyer: (...a: unknown[]) => getFlyer(...a),
    submitHousingFair: (...a: unknown[]) => submitHousingFair(...a),
  };
});

import { FlyerPage } from './FlyerPage.js';

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
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
  utilities: 'Electric and gas',
  video_url: 'https://video.example/tour',
  application_fee: 40,
  same_day_rta: true,
  pets: 'Cats only',
  accessibility: 'Ground floor',
  deposit: 1800,
  lease_terms: '12-month minimum',
  contact_number: '+15550009999',
};

// A location probe rendered next to the page so URL-stripping is assertable.
function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderPage(entry = '/p/unit-1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/p/:unitId"
          element={
            <>
              <FlyerPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('FlyerPage', () => {
  it('public variant shows ALL info upfront plus the intake form', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.getByRole('heading', { name: /Oakhurst/i })).toBeInTheDocument();
    // Detail rows are all present upfront (no gate).
    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('$1800')).toBeInTheDocument();
    expect(screen.getByText('Application fee')).toBeInTheDocument();
    expect(screen.getByText('$40')).toBeInTheDocument();
    expect(screen.getByText('Tenant pays')).toBeInTheDocument();
    expect(screen.getByText('Electric and gas')).toBeInTheDocument();
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('Cats only')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
    expect(screen.getByText('Ground floor')).toBeInTheDocument();
    expect(screen.getByText('Lease terms')).toBeInTheDocument();
    expect(screen.getByText('12-month minimum')).toBeInTheDocument();
    expect(screen.getByText('Same-day RTA')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /watch the tour/i })).toHaveAttribute(
      'href',
      'https://video.example/tour',
    );
    expect(screen.getByRole('link', { name: /see the full listing/i })).toHaveAttribute(
      'href',
      'https://external.example/listing/1',
    );
    // The public variant's CTA is the intake form; NO tap-to-text link.
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /text us/i })).toBeNull();
  });

  it('submit swaps ONLY the CTA to a thank-you; the info stays', async () => {
    const user = userEvent.setup();
    getFlyer.mockResolvedValue(FLYER);
    submitHousingFair.mockResolvedValue(undefined);
    renderPage();

    await user.type(await screen.findByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.type(screen.getByLabelText(/phone number/i), '4045551234');
    // A2P/CTIA consent gate - the required checkbox must be checked to submit.
    await user.click(screen.getByRole('checkbox', { name: /I agree to receive/i }));
    await user.click(screen.getByRole('button', { name: /i'm interested/i }));

    await waitFor(() => expect(submitHousingFair).toHaveBeenCalled());
    expect(submitHousingFair).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+14045551234',
        unitId: 'unit-1',
        smsConsent: true,
      }),
    );

    // Only the CTA section swaps; the info above stays on screen and the form is gone.
    const thanks = await screen.findByRole('heading', {
      name: /you're all set|we've got your info/i,
    });
    expect(thanks).toBeInTheDocument();
    // a11y: on the thank-you swap (the conversion moment) focus moves to the new
    // heading so screen readers announce the state change.
    expect(thanks).toHaveFocus();
    expect(screen.getByText('88 Sycamore St', { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText(/first name/i)).toBeNull();
  });

  it('?cta=text renders the text-us CTA, no form, and strips the cta param from the URL', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage('/p/unit-1?cta=text');

    expect(await screen.findByRole('link', { name: /text us/i })).toHaveAttribute(
      'href',
      'sms:+15550009999?&body=' + encodeURIComponent("I'm interested in 88 Sycamore St, Decatur"),
    );
    expect(screen.queryByLabelText(/first name/i)).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('/p/unit-1');
  });

  it('the known variant survives a remount WITHOUT the param (sessionStorage)', async () => {
    getFlyer.mockResolvedValue(FLYER);
    const first = renderPage('/p/unit-1?cta=text');
    await screen.findByRole('link', { name: /text us/i });
    first.unmount();

    renderPage('/p/unit-1');
    expect(await screen.findByRole('link', { name: /text us/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/first name/i)).toBeNull();
  });

  it('known variant with a null contact_number degrades to the reply prompt', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, contact_number: null });
    renderPage('/p/unit-1?cta=text');

    expect(await screen.findByText(/reply to the text we sent you/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /text us/i })).toBeNull();
    expect(screen.queryByLabelText(/first name/i)).toBeNull();
  });

  it('sms prefill falls back to neighborhood, then to "this home"', async () => {
    // No address line1 -> neighborhood ("subzone, area").
    getFlyer.mockResolvedValue({ ...FLYER, address: {} });
    const first = renderPage('/p/unit-1?cta=text');
    expect(await screen.findByRole('link', { name: /text us/i })).toHaveAttribute(
      'href',
      'sms:+15550009999?&body=' + encodeURIComponent("I'm interested in Oakhurst, Decatur"),
    );
    first.unmount();

    // No address AND no neighborhood -> "this home".
    getFlyer.mockResolvedValue({ ...FLYER, address: {}, area: null, subzone: null });
    renderPage('/p/unit-1?cta=text');
    expect(await screen.findByRole('link', { name: /text us/i })).toHaveAttribute(
      'href',
      'sms:+15550009999?&body=' + encodeURIComponent("I'm interested in this home"),
    );
  });

  it('empty-string detail values render NO row (label suppressed)', async () => {
    // Staff can save '' for the free-text fields (the write validator accepts
    // it); a labeled <dt> with a blank <dd> must simply not render.
    getFlyer.mockResolvedValue({
      ...FLYER,
      pets: '',
      accessibility: '',
      lease_terms: '',
      utilities: '',
    });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByText('Pets')).toBeNull();
    expect(screen.queryByText('Accessibility')).toBeNull();
    expect(screen.queryByText('Lease terms')).toBeNull();
    expect(screen.queryByText('Tenant pays')).toBeNull();
  });

  it('unsafe (javascript:) video/listing URLs are not rendered as links', async () => {
    getFlyer.mockResolvedValue({
      ...FLYER,
      video_url: 'javascript:alert(1)',
      listing_link: 'javascript:alert(2)',
    });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByRole('link', { name: /watch the tour/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /see the full listing/i })).toBeNull();
  });

  it('unavailable (public variant) keeps the /join link', async () => {
    getFlyer.mockRejectedValue(
      new ApiError(404, 'not_found', 'not_found', {
        error: 'not_found',
        contact_number: '+15550009999',
      }),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: /no longer available/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see other homes/i })).toHaveAttribute('href', '/join');
    expect(screen.queryByRole('link', { name: /text us/i })).toBeNull();
  });

  it('unavailable (known variant) offers the text-us CTA from the 404 body', async () => {
    getFlyer.mockRejectedValue(
      new ApiError(404, 'not_found', 'not_found', {
        error: 'not_found',
        contact_number: '+15550009999',
      }),
    );
    const first = renderPage('/p/unit-1?cta=text');
    expect(await screen.findByRole('link', { name: /text us/i })).toHaveAttribute(
      'href',
      'sms:+15550009999?&body=' +
        encodeURIComponent(
          "The home I was looking at is no longer available - I'm interested in similar homes.",
        ),
    );
    first.unmount();

    // A null contact_number in the 404 body -> the reply-prompt copy, no dead button.
    getFlyer.mockRejectedValue(
      new ApiError(404, 'not_found', 'not_found', { error: 'not_found', contact_number: null }),
    );
    renderPage('/p/unit-1?cta=text');
    expect(await screen.findByText(/reply to the text we sent you/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /text us/i })).toBeNull();
  });
});
