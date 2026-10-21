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
  voucher_size: 3,
  voucher_sizes: [3],
  accepted_authorities: ['Atlanta (AHA)', 'DCA'],
  listing_link: 'https://external.example/listing/1',
  rent_min: 1800,
  rent_max: 2000,
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
  utilities: 'Electric and gas',
  video_url: 'https://video.example/tour',
  application_fee: 40,
  same_day_rta: true,
  pets: 'Cats only',
  no_pets: false,
  pet_fee: null,
  accessibility: 'Ground floor',
  deposit: 1800,
  deposit_one_month: false,
  deposit_flexible: false,
  washer_dryer: null,
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
    // D11 / D3: the neighborhood line is the area alone.
    expect(screen.getByRole('heading', { name: 'Decatur' })).toBeInTheDocument();
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

  it('the address links to Google Maps with the full address as the query', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage();

    const link = await screen.findByRole('link', { name: /88 Sycamore St/i });
    expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=' +
        encodeURIComponent('88 Sycamore St, Decatur, GA, 30030'),
    );
    // Opens away from the flyer (a tenant mid-funnel keeps their place), and the
    // hidden suffix leaves the address itself as the visible label.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAccessibleName(/open in Google Maps/i);
  });

  it('a partial address still maps; a blank one renders as plain text', async () => {
    // City + state only - the Maps free-text query still lands somewhere useful.
    getFlyer.mockResolvedValue({ ...FLYER, address: { city: 'Decatur', state: 'GA' } });
    const first = renderPage();
    expect(await screen.findByRole('link', { name: /Decatur, GA/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Decatur, GA'),
    );
    first.unmount();

    // Whitespace-only parts print (addressLines keeps them) but must not link.
    getFlyer.mockResolvedValue({ ...FLYER, address: { line1: '   ' } });
    renderPage();
    await screen.findByText('Address');
    expect(screen.queryByRole('link', { name: /google maps/i })).toBeNull();
  });

  it('renders the Accepts line from the projected authorities', async () => {
    // The public "Accepts:" line answers the tenant's actual question ("will this
    // home take MY voucher"): it lists the unit's accepted AUTHORITIES, not the
    // retired program-type labels (spec section 8).
    getFlyer.mockResolvedValue(FLYER);
    renderPage();

    expect(await screen.findByText(/Accepts: Atlanta \(AHA\), DCA/)).toBeInTheDocument();
  });

  it('hides the Accepts line when no authority is recorded', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, accepted_authorities: [] });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByText(/Accepts:/)).toBeNull();
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
    // No address line1 -> the neighborhood (the area alone).
    getFlyer.mockResolvedValue({ ...FLYER, address: {} });
    const first = renderPage('/p/unit-1?cta=text');
    expect(await screen.findByRole('link', { name: /text us/i })).toHaveAttribute(
      'href',
      'sms:+15550009999?&body=' + encodeURIComponent("I'm interested in Decatur"),
    );
    first.unmount();

    // No address AND no neighborhood -> "this home".
    getFlyer.mockResolvedValue({ ...FLYER, address: {}, area: null });
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

  it('whitespace-only detail values render NO row (edit form saves untrimmed)', async () => {
    getFlyer.mockResolvedValue({
      ...FLYER,
      pets: '   ',
      accessibility: '\t',
      lease_terms: ' ',
      utilities: '  ',
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

  it('the flyer form has no housing authority select, never sends one, and keeps its error copy (join-housing-authority D8)', async () => {
    const user = userEvent.setup();
    getFlyer.mockResolvedValue(FLYER);
    submitHousingFair
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' }))
      .mockRejectedValueOnce(
        new ApiError(400, 'housing_authority_not_listed', 'housing_authority_not_listed', {
          error: 'housing_authority_not_listed',
        }),
      );
    renderPage();

    await user.type(await screen.findByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    await user.type(screen.getByLabelText(/phone number/i), '4045551234');
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByLabelText(/housing authority/i)).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /I agree to receive/i }));

    // A 429: today's message, not the /join one.
    await user.click(screen.getByRole('button', { name: /i'm interested/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Sorry, we couldn't send that. Please try again.",
    );

    // A not-listed refusal: still today's message.
    await user.click(screen.getByRole('button', { name: /i'm interested/i }));
    await waitFor(() => expect(submitHousingFair).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Sorry, we couldn't send that. Please try again.",
    );
    expect(screen.queryByText(/too many sign-ups/i)).toBeNull();
    expect(screen.queryByText(/housing authority list was updated/i)).toBeNull();
    for (const call of submitHousingFair.mock.calls) {
      expect(call[0]).toMatchObject({ unitId: 'unit-1' });
      expect(call[0]).not.toHaveProperty('housingAuthority');
    }
  });
});

// D11 (property requirements spec 2026-10-20): the tenant-facing wording.
describe('FlyerPage - D11 wording', () => {
  async function renderFlyer(over: Partial<PublicFlyer>): Promise<void> {
    getFlyer.mockResolvedValue({ ...FLYER, ...over });
    renderPage();
    await screen.findByText('88 Sycamore St', { exact: false });
  }
  /** The facts list item that reads exactly `text` (its <strong> included). */
  const fact = (text: string): HTMLElement | null =>
    screen.queryByText((_, el) => el?.tagName === 'LI' && el.textContent === text);
  /** The detail row's value for `label`, or null when there is no such row. */
  const detail = (label: string): string | null =>
    screen.queryByText(label, { selector: 'dt' })?.nextElementSibling?.textContent ?? null;

  it.each<[number[], string]>([
    [[0], 'Fits a studio voucher'],
    [[2], 'Fits a 2-bedroom voucher'],
    [[2, 3], 'Fits a 2- or 3-bedroom voucher'],
    [[0, 1], 'Fits a studio or 1-bedroom voucher'],
    [[1, 2, 3], 'Fits a 1-, 2-, or 3-bedroom voucher'],
    [[3, 2, 2], 'Fits a 2- or 3-bedroom voucher'],
  ])('voucher sizes %j read "%s"', async (sizes, text) => {
    await renderFlyer({ voucher_sizes: sizes, voucher_size: sizes[0] ?? null });
    expect(fact(text)).not.toBeNull();
  });

  it('no voucher size: no voucher line', async () => {
    await renderFlyer({ voucher_sizes: [], voucher_size: null });
    expect(screen.queryByText(/Fits a/)).toBeNull();
  });

  it('Pets: "No pets", "No pets (<details>)" or the details; the pet fee is its own row', async () => {
    await renderFlyer({ no_pets: true, pets: 'service animals only', pet_fee: '$300' });
    expect(detail('Pets')).toBe('No pets (service animals only)');
    expect(detail('Pet fee')).toBe('$300');
  });

  it('Pets: the checkbox alone reads "No pets"', async () => {
    await renderFlyer({ no_pets: true, pets: null });
    expect(detail('Pets')).toBe('No pets');
    expect(detail('Pet fee')).toBeNull();
  });

  it('Pets: details alone read as written', async () => {
    await renderFlyer({ no_pets: false, pets: 'Cats OK' });
    expect(detail('Pets')).toBe('Cats OK');
  });

  it('a legacy boolean arrives already interpreted by the projection (true -> "Allowed", false -> No pets)', async () => {
    await renderFlyer({ no_pets: false, pets: 'Allowed' });
    expect(detail('Pets')).toBe('Allowed');
  });

  it('a blank pet fee shows no row', async () => {
    await renderFlyer({ pet_fee: '   ' });
    expect(detail('Pet fee')).toBeNull();
  });

  it.each<[Partial<PublicFlyer>, string]>([
    [{ deposit_one_month: true, deposit: null }, "One month's rent"],
    [{ deposit: 1800 }, '$1800'],
    [{ deposit: 1800, deposit_flexible: true }, '$1800, flexible / payment plan available'],
    [{ deposit_one_month: true, deposit: null, deposit_flexible: true }, "One month's rent, flexible / payment plan available"],
    [{ deposit: null, deposit_flexible: true }, 'Flexible / payment plan available'],
  ])('Deposit %j reads "%s"', async (over, text) => {
    await renderFlyer(over);
    expect(detail('Deposit')).toBe(text);
  });

  it('no deposit recorded: no Deposit row (the notes are staff only and never projected)', async () => {
    await renderFlyer({ deposit: null, deposit_one_month: false, deposit_flexible: false });
    expect(detail('Deposit')).toBeNull();
  });

  it('Application fee: "No application fee" for 0, "$N" otherwise, no row when absent', async () => {
    await renderFlyer({ application_fee: 0 });
    expect(detail('Application fee')).toBe('No application fee');
  });

  it('Application fee: no row when absent', async () => {
    await renderFlyer({ application_fee: null });
    expect(detail('Application fee')).toBeNull();
  });

  it.each<[PublicFlyer['washer_dryer'], string]>([
    ['hookups', 'Hookups'],
    ['included', 'Washer and dryer included'],
    ['none', 'No hookups'],
  ])('Washer / dryer %s reads "%s"', async (value, text) => {
    await renderFlyer({ washer_dryer: value });
    expect(detail('Washer / dryer')).toBe(text);
  });

  it('Washer / dryer: no row when not recorded', async () => {
    await renderFlyer({ washer_dryer: null });
    expect(detail('Washer / dryer')).toBeNull();
  });

  it('a stale subzone in the payload is never shown (D3: staff only)', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, subzone: 'Oakhurst' } as unknown as PublicFlyer);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Decatur' })).toBeInTheDocument();
    expect(screen.queryByText(/Oakhurst/)).toBeNull();
  });
});
