// FlyerPage tests (flyer-full-info) - the single public /p/:unitId page: all
// tenant-useful info shown UPFRONT (no teaser/intake/reveal funnel), with a
// bottom CTA chosen by ?cta=text. Covers: the public (form) variant shows every
// detail row + the intake form and swaps ONLY the CTA to a thank-you on submit;
// the known-tenant (text) variant renders a tap-to-text sms: link with an
// encoded prefill and NO form, strips the cta param from the URL on load, and
// survives a same-tab remount via sessionStorage; the null-contact degrade; the
// unsafe-URL guard; and the variant-aware unavailable state. Public API mocked.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import type { PublicFlyer } from './publicApi.js';
import styles from './FlyerPage.module.css';

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
  address: { line1: '88 Sycamore St', city: 'Decatur', state: 'GA', zip: '30030' },
  utilities: 'Electric and gas',
  video_url: 'https://video.example/tour',
  application_fee: 40,
  same_day_rta: true,
  washer_dryer: null,
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
    // flyer-leads D3: the address is the heading; the area is the line under it.
    expect(screen.getByRole('heading', { level: 1, name: '88 Sycamore St' })).toBeInTheDocument();
    expect(screen.getByText('Decatur')).toBeInTheDocument();
    // Detail rows are all present upfront (no gate) - the public ones only
    // (flyer-leads D1, D3: no rent, deposit, pets, accessibility or lease).
    expect(screen.getByText('Application fee')).toBeInTheDocument();
    expect(screen.getByText('$40')).toBeInTheDocument();
    expect(screen.getByText('Tenant pays')).toBeInTheDocument();
    expect(screen.getByText('Electric and gas')).toBeInTheDocument();
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

    // Whitespace-only parts are no address (flyer-leads D3): the heading falls
    // back to the area, as plain text - no Maps link.
    getFlyer.mockResolvedValue({ ...FLYER, address: { line1: '   ' } });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Decatur' })).toBeInTheDocument();
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

  it('an empty-string detail value renders NO row (label suppressed)', async () => {
    // Staff can save '' for a free-text field (the write validator accepts
    // it); a labeled <dt> with a blank <dd> must simply not render.
    getFlyer.mockResolvedValue({ ...FLYER, utilities: '' });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByText('Tenant pays')).toBeNull();
  });

  it('a whitespace-only detail value renders NO row (edit form saves untrimmed)', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, utilities: '  ' });
    renderPage();

    await screen.findByText('88 Sycamore St', { exact: false });
    expect(screen.queryByText('Tenant pays')).toBeNull();
  });

  // flyer-leads D1, D3: the projection no longer sends these ten keys. A
  // stale payload that still carries them (hand-fed here) shows none of them:
  // the page never reads them.
  const STALE_TRIMMED_KEYS = {
    rent_min: 1800,
    rent_max: 2000,
    lease_terms: '12-month minimum',
    accessibility: 'Ground floor',
    pets: 'Cats only',
    no_pets: true,
    pet_fee: '$300',
    deposit: 1500,
    deposit_one_month: true,
    deposit_flexible: true,
  };

  it('shows no rent, deposit, pets, pet fee, accessibility or lease row, even from a stale payload (flyer-leads D1, D3)', async () => {
    getFlyer.mockResolvedValue({ ...FLYER, ...STALE_TRIMMED_KEYS } as unknown as PublicFlyer);
    renderPage();
    // A positive read on the same load first: the page is ready.
    expect(await screen.findByText('Tenant pays')).toBeInTheDocument();
    for (const label of ['Deposit', 'Pets', 'Pet fee', 'Accessibility', 'Lease terms']) {
      expect(screen.queryAllByText(label, { selector: 'dt' }), label).toHaveLength(0);
    }
    // Exactly the public rows (worklist OR-9): no Address row either - the
    // address is the heading (spec 5: "no ... address row, even when a stale
    // payload is hand-fed those keys").
    expect(Array.from(document.querySelectorAll('dt'), (dt) => dt.textContent)).toEqual([
      'Application fee',
      'Tenant pays',
      'Same-day RTA',
      'Video tour',
      'Listing',
    ]);
    for (const text of ['12-month minimum', 'Ground floor', 'Cats only', '$300', '$1500', "One month's rent"]) {
      expect(screen.queryAllByText(text, { exact: false }), text).toHaveLength(0);
    }
    expect(screen.queryAllByText(/No pets/)).toHaveLength(0);
    expect(screen.queryAllByText(/flexible/i)).toHaveLength(0);
    // No rent fact: neither amount, and no "/mo".
    expect(screen.queryAllByText(/\$1800|\$2000|\/mo/)).toHaveLength(0);
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
    // Code review RC-11: plan 1.1's general rule with a studio inside three
    // or more sizes - studio as "studio", the other non-final sizes as "<n>-".
    [[0, 2, 3], 'Fits a studio, 2-, or 3-bedroom voucher'],
    // Code review R2D-8: "an" when the phrase starts with 8 or 11 (said
    // "eight", "eleven"); every other start keeps "a".
    [[8], 'Fits an 8-bedroom voucher'],
    [[11], 'Fits an 11-bedroom voucher'],
    [[8, 9], 'Fits an 8- or 9-bedroom voucher'],
    [[11, 12], 'Fits an 11- or 12-bedroom voucher'],
    [[8, 10, 12], 'Fits an 8-, 10-, or 12-bedroom voucher'],
    [[1, 8], 'Fits a 1- or 8-bedroom voucher'],
    [[0, 11], 'Fits a studio or 11-bedroom voucher'],
    [[10], 'Fits a 10-bedroom voucher'],
    [[12], 'Fits a 12-bedroom voucher'],
  ])('voucher sizes %j read "%s"', async (sizes, text) => {
    await renderFlyer({ voucher_sizes: sizes, voucher_size: sizes[0] ?? null });
    expect(fact(text)).not.toBeNull();
  });

  it('no voucher size: no voucher line', async () => {
    await renderFlyer({ voucher_sizes: [], voucher_size: null });
    expect(screen.queryByText(/Fits a/)).toBeNull();
  });

  it('Application fee: "No application fee" for 0, "$N" otherwise, no row when absent', async () => {
    await renderFlyer({ application_fee: 0 });
    expect(detail('Application fee')).toBe('No application fee');
  });

  it('Application fee: no row when absent', async () => {
    await renderFlyer({ application_fee: null });
    expect(detail('Application fee')).toBeNull();
  });

  // Planner ruling PR-4 (code review PA-4): the application fee prints through
  // flyerMoney - a whole number exactly as before, any other amount with two
  // decimals (the forms accept cents, D1). flyer-leads D3: the deposit row is
  // gone, so the fee is flyerMoney's only reader.
  // Plain its, not it.each (orchestrator note O-1): an it.each title has every
  // `$<word>` read as a case field AFTER the %s substitution, so "$37.50"
  // printed as "undefined". A template-literal title prints the text as is.
  const MONEY_CASES: Array<[string, Partial<PublicFlyer>, string]> = [
    ['Application fee', { application_fee: 37.5 }, '$37.50'],
    ['Application fee', { application_fee: 40 }, '$40'],
  ];
  for (const [row, over, text] of MONEY_CASES) {
    it(`${row} ${JSON.stringify(over)} reads "${text}" (cents print two decimals, a whole amount as before)`, async () => {
      await renderFlyer(over);
      expect(detail(row)).toBe(text);
    });
  }

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
    expect(await screen.findByRole('heading', { level: 1, name: '88 Sycamore St' })).toBeInTheDocument();
    expect(screen.queryByText(/Oakhurst/)).toBeNull();
  });
});

// flyer-leads D3: the address is the heading - a Maps link holding the street
// line (the h1), the city line and the sr-only suffix the old Address row
// carried; the area is a line under it; fallbacks when parts are missing.
describe('FlyerPage - the address heading (flyer-leads D3)', () => {
  const MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  async function renderReady(over: Partial<PublicFlyer>): Promise<void> {
    getFlyer.mockResolvedValue({ ...FLYER, ...over });
    renderPage();
    await screen.findByText('Tenant pays');
  }
  /** The Maps heading link; null when the heading is plain text. */
  const mapsLink = (): HTMLElement | null => screen.queryByRole('link', { name: /open in Google Maps/ });

  it('the h1 is the street line inside the Maps link, with the city line and the sr-only suffix', async () => {
    await renderReady({
      address: { line1: '88 Sycamore St', line2: 'Apt 2', city: 'Decatur', state: 'GA', zip: '30030' },
    });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName('88 Sycamore St, Apt 2');
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    expect(link).toContainElement(heading);
    expect(link).toHaveAttribute('href', MAPS + encodeURIComponent('88 Sycamore St, Apt 2, Decatur, GA, 30030'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    // The whole heading block is the tap target: the city line is in the SAME link.
    expect(within(link).getByText('Decatur, GA 30030')).toBeInTheDocument();
    // WCAG 2.5.3: the visible text leads the name; the hidden suffix only adds
    // to it and says where the link goes (a new tab).
    expect(link).toHaveAccessibleName(/^88 Sycamore St, Apt 2\s*Decatur, GA 30030 - open in Google Maps$/);
    expect(within(link).getByText('- open in Google Maps')).toHaveClass(styles.srOnly!);
    // The separate Address row is gone.
    expect(screen.queryByText('Address', { selector: 'dt' })).toBeNull();
  });

  it('the area is a line directly under an address heading, outside the link; photos stay first', async () => {
    await renderReady({});
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    // Exact text: the city line inside the link reads "Decatur, GA 30030".
    const area = screen.getByText('Decatur');
    expect(link).not.toContainElement(area);
    expect(link.nextElementSibling).toBe(area);
    const photo = screen.getByRole('img', { name: 'Home photo 1' });
    expect(photo.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each<[string, PublicFlyer['address'], string, string]>([
    ['zip only', { zip: '30030' }, '30030', '30030'],
    ['state and zip', { state: 'GA', zip: '30030' }, 'GA 30030', 'GA, 30030'],
    ['city and zip', { city: 'Decatur', zip: '30030' }, 'Decatur, 30030', 'Decatur, 30030'],
    ['city and state', { city: 'Decatur', state: 'GA' }, 'Decatur, GA', 'Decatur, GA'],
  ])('no street line, %s: the h1 is the city line, linked, with no second line', async (_case, address, title, query) => {
    await renderReady({ address });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName(title);
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    expect(link).toContainElement(heading);
    expect(link).toHaveAttribute('href', MAPS + encodeURIComponent(query));
    // Name = the h1 and the suffix only: no second line.
    expect(link).toHaveAccessibleName(`${title} - open in Google Maps`);
  });

  it('line2 alone is a street line; every part is trimmed', async () => {
    await renderReady({ address: { line1: '  88 Sycamore St ', line2: '   ', city: ' Decatur', state: 'GA ', zip: ' 30030 ' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('88 Sycamore St');
    const link = mapsLink();
    if (link === null) throw new Error('no Maps heading link');
    expect(within(link).getByText('Decatur, GA 30030').textContent).toBe('Decatur, GA 30030');
    getFlyer.mockResolvedValue({ ...FLYER, address: { line2: 'Unit 4', city: 'Decatur' } });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Unit 4' })).toBeInTheDocument();
  });

  it('no address at all: the area as plain text - no link, and no second area line', async () => {
    await renderReady({ address: {} });
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Decatur');
    expect(mapsLink()).toBeNull();
    expect(screen.getAllByText('Decatur')).toHaveLength(1);
  });

  it.each<[string, string | null]>([
    ['no area', null],
    ['a blank area', '   '],
  ])('no address and %s: the plain text "Home for rent"', async (_case, area) => {
    await renderReady({ address: {}, area });
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Home for rent');
    expect(mapsLink()).toBeNull();
  });

  it('a recorded area prints trimmed (D10)', async () => {
    await renderReady({ area: '  Decatur  ' });
    expect(screen.getByText('Decatur').textContent).toBe('Decatur');
  });

  it('"A home for you" appears nowhere, whatever the payload', async () => {
    for (const over of [{}, { address: {} }, { address: {}, area: null }] as Partial<PublicFlyer>[]) {
      getFlyer.mockResolvedValue({ ...FLYER, ...over });
      const view = renderPage();
      await screen.findByText('Tenant pays');
      expect(screen.queryByText(/A home for you/)).toBeNull();
      view.unmount();
    }
  });

  it('the detail rows run Application fee, Tenant pays, Washer / dryer, Same-day RTA, Video tour, Listing', async () => {
    await renderReady({ washer_dryer: 'hookups' });
    expect(Array.from(document.querySelectorAll('dt'), (dt) => dt.textContent)).toEqual([
      'Application fee',
      'Tenant pays',
      'Washer / dryer',
      'Same-day RTA',
      'Video tour',
      'Listing',
    ]);
  });
});

// flyer-leads D3 items 4 and 6: the highlight line on every flyer (Sam,
// tracker #13) and the bolder housing authority line.
describe('FlyerPage - the highlight and the authority line (flyer-leads D3)', () => {
  const BARE: PublicFlyer = {
    unitId: 'unit-bare',
    media: [],
    beds: null,
    baths: null,
    area: null,
    voucher_size: null,
    voucher_sizes: [],
    accepted_authorities: [],
    listing_link: null,
    address: {},
    utilities: null,
    video_url: null,
    application_fee: null,
    same_day_rta: null,
    washer_dryer: null,
    contact_number: null,
  };

  it('"Same-day tours available" shows on a bare property: static copy, not the Same-day RTA row', async () => {
    getFlyer.mockResolvedValue(BARE);
    renderPage('/p/unit-bare');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home for rent' })).toBeInTheDocument();
    expect(screen.getByText('Same-day tours available')).toHaveClass(styles.highlight!);
    expect(screen.queryByText('Same-day RTA')).toBeNull();
  });

  it('sits under the heading group and above the facts, on both CTA variants', async () => {
    getFlyer.mockResolvedValue(FLYER);
    for (const entry of ['/p/unit-1', '/p/unit-1?cta=text']) {
      const view = renderPage(entry);
      const line = await screen.findByText('Same-day tours available');
      const area = screen.getByText('Decatur');
      const beds = screen.getByText((_, el) => el?.tagName === 'LI' && el.textContent === '3 beds');
      expect(area.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(line.compareDocumentPosition(beds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      view.unmount();
      sessionStorage.clear();
    }
  });

  it('(PIN) the unavailable state keeps its copy, with no highlight', async () => {
    getFlyer.mockRejectedValue(
      new ApiError(404, 'not_found', 'not_found', { error: 'not_found', contact_number: null }),
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: /no longer available/i })).toBeInTheDocument();
    expect(screen.queryByText('Same-day tours available')).toBeNull();
  });

  it('(PIN) the authority line keeps its wording and the class the CSS pin reads', async () => {
    getFlyer.mockResolvedValue(FLYER);
    renderPage();
    expect(await screen.findByText('Accepts: Atlanta (AHA), DCA')).toHaveClass(styles.authorities!);
  });
});
