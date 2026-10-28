import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutboundTo } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

// Public-pages surface (spec section 5 e2e) - the UNAUTHENTICATED pages that mount
// OUTSIDE the auth gate (dashboard/src/App.tsx): `/p/:unitId` (the full-info flyer
// page - flyer-full-info 2026-07-16: the teaser -> "I'm interested" -> IntakeForm
// -> reveal FUNNEL is gone; every tenant-useful fact is shown UPFRONT) and `/join`
// (the standalone housing-fair intake -> thank-you). `/p/:unitId` is exactly what
// `flyerUrl()` emits, so every shared [FlyerLink] broadcast lands here.
//
// The flyer has TWO bottom-CTA variants, chosen by the `?cta=text` query param:
//   - bare `/p/:unitId`      -> the inline IntakeForm signup (a public visitor).
//   - `/p/:unitId?cta=text`  -> "I'm interested - text us", a tap-to-text sms: link
//                               to our business number (a KNOWN tenant we already
//                               text). The flag is STRIPPED from the URL on load (a
//                               copied/shared address stays clean) and the variant
//                               is remembered in sessionStorage per unit.
// NEVER click an sms: link (there is no page to land on) - assert its href only.
//
// What this asserts (no session/cookies for the public reads):
//   1. Full info is public with NO gate - the address heading (a Google Maps
//      link - href only, never clicked: it leaves the app), the area, beds and
//      the fee/utilities/RTA/video rows all render upfront; the intake form is
//      present; no login redirect. Plus a raw flyer-API sanity check
//      (contact_number). Rent, deposit, pets, accessibility and lease terms are
//      staff only since flyer-leads (2026-10-21): flyer-leads.spec.ts proves
//      them absent.
//   2. The bottom form submit swaps ONLY the CTA to a thank-you in place (the info
//      above stays), stamps the contact capture_source:'flyer' + unit_of_interest,
//      and records the welcome SMS in the dev outbox.
//   3. `?cta=text` shows the tap-to-text CTA (href only), hides the form, and the
//      cta flag is stripped from the address bar after load.
//   4. A staff edit flows straight to the public page (no funnel steps).
//   5. `/join` - no session -> fill + submit -> thank-you (unchanged).
//   6. Fallback (permanent-flyer-links D4, 2026-10-27) - a bogus id and a Setup
//      property show the neutral sign-up page in both variants (form -> the inline
//      sign-up, text -> a tap-to-text sms: CTA fed by the opaque-404 body's
//      contact_number); the seeded under_application unit serves its full flyer.
//   7. `/join` housing authority (join-housing-authority spec D8/D9, 2026-10-12) -
//      the select defaults to Atlanta Housing Authority; two sign-ups in a row via
//      "Sign up another person" (an empty form, consent unchecked, the authority
//      KEPT, no second list read); each lead starts Onboarding holding its
//      authority, read through the authenticated contacts API.
//   8. A sign-up FROM the fallback of a bogus id (D4, D5) - the fallback's own
//      thank-you; the lead is a plain housing-fair sign-up (no flyer credit, no
//      unit of interest) that starts in Needs review because a unitId was sent.
//
// Seeded data we lean on (app/src/lib/seedData.ts):
//   - contact-landlord-0001 = Marcus Bell (we own our test units under him).
//   - unit-0001 is seeded `under_application`, but its status follows the seeded
//     placement-0001, which other specs move. Every status that derivation yields
//     is public (every status but Setup - permanent-flyer-links D1), so its flyer is
//     always SERVED: the read-only UNDER_APPLICATION_UNIT case. Never flipped,
//     deleted or signed up from here, and its status is never asserted.
// No seeded unit is reliably `available`, so the spec CREATES its own units via the
// authenticated API (create with every public field -> flip to available via
// listing-status; the fallback case skips the flip and keeps its unit in `setup`).
// Every public submit uses a UNIQUE phone so the per-phone idempotent
// welcome never collides across cases (or specs). The e2e stack sets BUSINESS_PHONE_NUMBER
// (scripts/e2e-session.mjs), so the flyer's contact_number is non-null here.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SEEDED_LANDLORD = 'contact-landlord-0001';
// Seeded unit-0001: its status follows placement-0001, and every derived status
// serves the full flyer (read-only here - never assert its status).
const UNDER_APPLICATION_UNIT = 'unit-0001';
/** permanent-flyer-links D4: the fallback page's one h1 - a missing, deleted or
 *  Setup property, or any failed flyer load, in both variants. */
const FALLBACK_HEADING = 'Find a home that fits your voucher';
/** The retired page's words (spec section 1): no page we serve says a home is
 *  "no longer available", taken or removed. */
const RETIRED_COPY = /no longer available|taken|removed/i;
/** Every listing status label but Available (D3: no status word on a served
 *  flyer). NEVER /available/i - every flyer reads "Same-day tours available". */
const STATUS_WORDS = /under application|finalizing|occupied|on hold|off market/i;
// Two seeded housing authority NAMES (app/src/lib/seed/orgList.ts SEED_AUTHORITY;
// both reseed profiles write the starting list). No spec renames either, so the
// /join select always lists them.
const ATLANTA = 'Atlanta Housing Authority';
const DEKALB = 'DeKalb County Housing Authority';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A unique +1555 phone per submit so the idempotent (per-phone) welcome never
 *  collides across cases / specs. */
function uniquePhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

/** The city/state/zip every shareable unit here is created with. Named so the
 *  Google Maps assertion can rebuild the SAME full address the page links to
 *  (only line1 varies per run, via the stamp). */
const UNIT_CITY_STATE_ZIP = { city: 'Atlanta', state: 'GA', zip: '30314' } as const;

interface ShareableUnit {
  unitId: string;
  rent: number;
  beds: number;
  area: string;
  applicationFee: number;
  videoUrl: string;
  utilities: string;
  addressLine1: string;
  deposit: number;
  pets: string;
  accessibility: string;
  leaseTerms: string;
}

/**
 * Create an AVAILABLE (shareable) unit through the authenticated API: create it
 * with the full public field set (it lands in `setup`), then flip it to
 * `available` via the listing-status transition. `opts.setup` skips the flip and
 * returns the unit still in `setup` - the one listing status the public flyer
 * does not serve (permanent-flyer-links D1), so its /p/<id> shows the fallback.
 * `request` MUST carry the staff session (pass `page.request` after devLogin).
 * Returns the unit + the values we assert on the public flyer page.
 */
async function createShareableUnit(
  request: APIRequestContext,
  overrides: Partial<ShareableUnit> = {},
  opts: { setup?: boolean } = {},
): Promise<ShareableUnit> {
  const stamp = `${Date.now()}`.slice(-6);
  const u: ShareableUnit = {
    unitId: '', // filled from the create response
    rent: overrides.rent ?? 1725,
    beds: overrides.beds ?? 2,
    area: overrides.area ?? `Westside ${stamp}`,
    applicationFee: overrides.applicationFee ?? 45,
    videoUrl: overrides.videoUrl ?? `https://tours.example.com/${stamp}`,
    utilities: overrides.utilities ?? 'Tenant-paid electric',
    addressLine1: overrides.addressLine1 ?? `${stamp} Flyer Way NW`,
    deposit: overrides.deposit ?? 1500,
    pets: overrides.pets ?? 'Cats only',
    accessibility: overrides.accessibility ?? 'Ground floor',
    leaseTerms: overrides.leaseTerms ?? '12-month minimum',
  };

  // (1) Create - a new unit starts in `setup` (not shareable).
  const createRes = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: SEEDED_LANDLORD,
      accepted_authorities: ['atlanta_housing'],
      beds: u.beds,
      rent_min: u.rent,
      rent_max: u.rent,
      area: u.area,
      media: ['https://photos.example.com/a.jpg'],
      address: { line1: u.addressLine1, ...UNIT_CITY_STATE_ZIP },
      utilities: u.utilities,
      video_url: u.videoUrl,
      application_fee: u.applicationFee,
      same_day_rta: true,
      deposit: u.deposit,
      pets: u.pets,
      accessibility: u.accessibility,
      lease_terms: u.leaseTerms,
    },
  });
  expect(createRes.ok()).toBeTruthy();
  u.unitId = (await createRes.json()).unit.unitId as string;
  if (opts.setup === true) return u;

  // (2) Flip to `available` (skipped with opts.setup) - the one status a property
  // can be sent in. status is not a writable CRUD field; it routes through the
  // listing-status transition.
  const statusRes = await request.patch(`${NEXT}/api/units/${u.unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(statusRes.ok()).toBeTruthy();

  return u;
}

/** Fill + submit the public IntakeForm (accessibility-first selectors). */
async function fillIntake(
  page: Page,
  { firstName, lastName, phone, voucher }: { firstName: string; lastName: string; phone: string; voucher?: string },
): Promise<void> {
  await page.getByLabel('First name').fill(firstName);
  await page.getByLabel('Last name').fill(lastName);
  await page.getByLabel('Phone number').fill(phone);
  if (voucher !== undefined) await page.getByLabel(/Voucher size/).fill(voucher);
  // A2P/CTIA (spec 3.1): the required, unchecked-by-default consent checkbox gates
  // submit (client + server). Check it so the intake can proceed.
  await page.getByRole('checkbox', { name: /I agree to receive/i }).check();
}

/** The /join form as "Sign up another person" must leave it (spec D9): every
 *  person field blank and the consent box unchecked, exactly as on first load. */
async function expectEmptyIntake(page: Page): Promise<void> {
  await expect(page.getByLabel('First name')).toHaveValue('');
  await expect(page.getByLabel('Last name')).toHaveValue('');
  await expect(page.getByLabel('Phone number')).toHaveValue('');
  await expect(page.getByLabel(/Voucher size/)).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: /I agree to receive/i })).not.toBeChecked();
}

/** Read a contact through the AUTHENTICATED contacts API by its phone (the exact
 *  byPhone lookup returns the stored item). `request` MUST carry the staff
 *  session (pass `staff.request` after devLogin). Polls, like the flyer case. */
async function contactByPhone(
  request: APIRequestContext,
  phone: string,
): Promise<Record<string, unknown>> {
  let contact: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
        if (!res.ok()) return false;
        contact = ((await res.json()) as { contacts: Array<Record<string, unknown>> }).contacts[0];
        return contact !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return contact!;
}

test.describe('Public pages - the unauthenticated full-info flyer + /join', () => {
  test('full info is public with NO session and NO gate', async ({ page, request }) => {
    // Staff context (separate page) ONLY to mint the shareable unit; the public
    // navigation below uses the bare `page`, which has NO session/cookies.
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request);
    await staff.close();

    // Public navigation - the bare page carries no session.
    await page.goto(`${NEXT}/p/${unit.unitId}`);

    // The page renders (it must NOT redirect to login).
    await expect(page).toHaveURL(new RegExp(`/p/${unit.unitId}$`));
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);

    // Key facts (flyer-leads D3): the ADDRESS is the heading, the neighborhood
    // is the line under it, then beds. Rent is staff only now.
    await expect(page.getByRole('heading', { level: 1, name: unit.addressLine1 })).toBeVisible();
    await expect(page.getByText(unit.area, { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`${unit.beds}\\s*beds`))).toBeVisible();
    // No voucher size is recorded on this unit, so the flyer falls back to beds.
    await expect(page.getByText(`Fits a ${unit.beds}-bedroom voucher`)).toBeVisible();

    // Every tenant-useful fact is shown UPFRONT - no gate (this IS the feature).
    await expect(page.getByText(unit.addressLine1)).toBeVisible();
    // The address IS the map link - never click it (it leaves for google.com);
    // assert the href, like the sms: links. The query carries the whole address,
    // not just line1, so a Maps lookup is not ambiguous across cities.
    await expect(page.getByRole('link', { name: new RegExp(unit.addressLine1) })).toHaveAttribute(
      'href',
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        [
          unit.addressLine1,
          UNIT_CITY_STATE_ZIP.city,
          UNIT_CITY_STATE_ZIP.state,
          UNIT_CITY_STATE_ZIP.zip,
        ].join(', '),
      )}`,
    );
    await expect(page.getByText('Application fee')).toBeVisible();
    await expect(page.getByText(`$${unit.applicationFee}`)).toBeVisible();
    await expect(page.getByText(unit.utilities)).toBeVisible();
    await expect(page.getByText('Same-day RTA')).toBeVisible();
    await expect(page.getByRole('link', { name: /Watch the tour/i })).toHaveAttribute(
      'href',
      unit.videoUrl,
    );

    // The public (bare-link) variant's CTA is the inline intake form - shown
    // WITHOUT any "reveal" click. There is NO tap-to-text link on this variant.
    await expect(page.getByLabel('First name')).toBeVisible();
    await expect(page.getByRole('link', { name: /text us/i })).toHaveCount(0);

    // API sanity: the raw public flyer GET carries the full payload upfront, incl.
    // contact_number (the e2e stack sets BUSINESS_PHONE_NUMBER). The bare, unauthenticated
    // `request` fixture reaches it with no session.
    const flyerRes = await request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
    expect(flyerRes.ok()).toBeTruthy();
    const { flyer } = await flyerRes.json();
    expect(flyer.address.line1).toBe(unit.addressLine1);
    expect(flyer.application_fee).toBe(unit.applicationFee);
    expect(typeof flyer.contact_number).toBe('string');
  });

  test('the bottom form submit swaps to a thank-you in place; contact is flyer-attributed; welcome SMS sent', async ({
    page,
    request,
  }) => {
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request);

    // Public page - the intake form is INLINE at the bottom (no "reveal" click; the
    // funnel is gone). Fill it and submit.
    await page.goto(`${NEXT}/p/${unit.unitId}`);
    const phone = uniquePhone();
    await fillIntake(page, { firstName: 'Funnel', lastName: 'Tester', phone, voucher: '2' });
    // flyer-leads D3: the bare-link flyer's sign-up button reads "Sign up".
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();

    // ONLY the CTA swaps to the thank-you; the info above STAYS on screen.
    await expect(page.getByRole('heading', { name: /you're all set/i })).toBeVisible();
    await expect(page.getByText(unit.addressLine1)).toBeVisible();

    // Capture attribution - the created contact carries capture_source:'flyer' +
    // unit_of_interest:<unitId>. Looked up through the AUTHENTICATED contacts API.
    await expect
      .poll(
        async () => {
          const res = await staff.request.get(
            `${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`,
          );
          if (!res.ok()) return null;
          return (await res.json()).contacts[0] ?? null;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();
    const lookup = await staff.request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
    const contact = (await lookup.json()).contacts[0];
    expect(contact.capture_source).toBe('flyer');
    expect(contact.unit_of_interest).toBe(unit.unitId);

    // And the welcome SMS reached the fake's thread store for this phone.
    await expect
      .poll(async () => (await getOutboundTo(request, { to: phone })).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // ...and it was SENT FROM the very number this flyer advertises. Before
    // one-to-one-sender-not-pinned-to-ported-number (2026-08-06) the send path
    // passed no `from` at all and Twilio's Messaging Service picked from its
    // whole sender pool - which also holds the relay pool numbers - so the
    // flyer's "text us at this number" promise was aspirational. The send
    // service now pins BUSINESS_PHONE_NUMBER, the same value the flyer reads.
    const flyerForCta = await request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
    const advertised = (await flyerForCta.json()).flyer.contact_number as string;
    // Guard against a VACUOUS pass: with an unconfigured BUSINESS_PHONE_NUMBER the
    // flyer advertises null AND the send omits `from`, and undefined === null
    // would compare two absences. Pin that `advertised` is a real E.164 number
    // first, so the equality below can only pass by actually matching.
    expect(advertised).toMatch(/^\+1\d{10}$/);
    const welcome = (await getOutboundTo(request, { to: phone }))[0]!;
    expect(welcome.from).toBe(advertised);

    await staff.close();
  });

  test('?cta=text renders the tap-to-text CTA, no form, and strips the flag from the URL', async ({
    page,
  }) => {
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request);
    await staff.close();

    await page.goto(`${NEXT}/p/${unit.unitId}?cta=text`);

    // The known-tenant CTA is a tap-to-text sms: link. Assert its href ONLY - an
    // sms: link has no page to land on, so it must NEVER be clicked. Note the
    // apostrophe stays LITERAL: encodeURIComponent leaves "'" unescaped (it is an
    // unreserved mark), so the prefill encodes as "I'm%20interested", not "I%27m".
    await expect(page.getByRole('link', { name: /text us/i })).toHaveAttribute(
      'href',
      /^sms:\+1\d+\?&body=I'm%20interested%20in%20/,
    );
    // No signup form on the known-tenant variant.
    await expect(page.getByLabel('First name')).toHaveCount(0);
    // The cta flag is stripped from the address bar on load (a copied/shared URL
    // never carries it) - the URL is back to the bare /p/<unitId>.
    await expect(page).toHaveURL(new RegExp(`/p/${unit.unitId}$`));
  });

  test('a staff edit of the public fields flows straight to the public page', async ({ page }) => {
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request, { applicationFee: 30 });

    // Staff edits the fields (this is exactly what ListingEditForm PATCHes).
    const editedFee = 99;
    const editedVideo = `https://tours.example.com/edited-${Date.now()}`;
    // A recorded voucher size that DIFFERS from the unit's beds (2): the flyer
    // must state the recorded size, not the bedroom count (2026-10-12 prod report).
    const editedVoucherSize = unit.beds + 1;
    const patchRes = await staff.request.patch(`${NEXT}/api/units/${unit.unitId}`, {
      data: {
        application_fee: editedFee,
        video_url: editedVideo,
        same_day_rta: false,
        voucher_size_accepted: editedVoucherSize,
      },
    });
    expect(patchRes.ok()).toBeTruthy();

    // The bare public page (a FRESH context - no prior visit, so sessionStorage is
    // clean) shows the EDITED values immediately, with no funnel/reveal steps.
    await page.goto(`${NEXT}/p/${unit.unitId}`);
    await expect(page.getByText(`$${editedFee}`)).toBeVisible();
    await expect(page.getByRole('link', { name: /Watch the tour/i })).toHaveAttribute(
      'href',
      editedVideo,
    );
    // same_day_rta turned OFF -> that row is absent.
    await expect(page.getByText('Same-day RTA')).toHaveCount(0);
    // The stale fee never appears.
    await expect(page.getByText('$30')).toHaveCount(0);
    // The recorded voucher size wins over the bedroom count; the beds fact is
    // unchanged.
    await expect(page.getByText(`Fits a ${editedVoucherSize}-bedroom voucher`)).toBeVisible();
    await expect(page.getByText(`Fits a ${unit.beds}-bedroom voucher`)).toHaveCount(0);
    await expect(page.getByText(new RegExp(`${unit.beds}\\s*beds`))).toBeVisible();

    // Staff CLEARS the recorded size (null - what ListingEditForm sends when the
    // field is emptied): the stored field is removed, so the flyer falls back to
    // the bedroom count on the next load.
    const clearRes = await staff.request.patch(`${NEXT}/api/units/${unit.unitId}`, {
      data: { voucher_size_accepted: null },
    });
    expect(clearRes.ok()).toBeTruthy();
    expect('voucher_size_accepted' in (await clearRes.json()).unit).toBe(false);
    await staff.close();

    await page.reload();
    await expect(page.getByText(`Fits a ${unit.beds}-bedroom voucher`)).toBeVisible();
    await expect(page.getByText(`Fits a ${editedVoucherSize}-bedroom voucher`)).toHaveCount(0);
  });

  test('/join: standalone intake with no session -> thank-you (no reveal)', async ({ page }) => {
    // No session on `page` - the standalone housing-fair intake.
    await page.goto(`${NEXT}/join`);
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Find your next home/i })).toBeVisible();

    const phone = uniquePhone();
    await fillIntake(page, { firstName: 'Joiner', lastName: 'Public', phone, voucher: '3' });
    await page.getByRole('button', { name: 'Sign me up' }).click();

    // Generic thank-you - there is NO home to reveal here.
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
    await expect(page.getByText('Application fee')).toHaveCount(0);
    await expect(page.getByText('Address')).toHaveCount(0);
  });

  test('/join: housing authority defaults to Atlanta, Sign up another person keeps the choice, each lead starts Onboarding', async ({
    page,
    request,
  }) => {
    // (a) The list read that feeds the select (spec D1), straight through the
    // proxy with no session: housing authority NAMES only, never cached.
    const listRes = await request.get(`${NEXT}/public/housing-authorities`);
    expect(listRes.status()).toBe(200);
    expect(listRes.headers()['cache-control'] ?? '').toContain('no-store');
    const { names } = (await listRes.json()) as { names: string[] };
    expect(names).toEqual(expect.arrayContaining([ATLANTA, DEKALB]));
    expect(names).not.toContain('Step Up'); // a seeded AGENCY - never offered

    // Count the PAGE's own list reads. D9: none on "Sign up another person"
    // after a good read. React StrictMode may double the FIRST read in this dev
    // build, so only "no growth after the first sign-up" is asserted.
    let listReads = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/public/housing-authorities') listReads += 1;
    });

    // (b) No session on `page` - the public /join form, as staff use it at a fair.
    await page.goto(`${NEXT}/join`);
    await expect(page.getByRole('heading', { name: /Find your next home/i })).toBeVisible();
    const authority = page.getByRole('combobox', { name: 'Housing authority' });
    await expect(authority).toBeVisible();
    await expect(authority).toBeEnabled(); // D8: disabled ("Loading...") until the list arrives
    // The shown choice is the selected option's TEXT (whatever its `value`).
    await expect(authority.locator('option:checked')).toHaveText(ATLANTA); // the D8 default
    await expect(page.getByText('The organization that runs your voucher.')).toBeVisible();
    await expect(authority.getByRole('option').last()).toHaveText('Not sure');
    await expect(authority.getByRole('option', { name: 'Choose one' })).toHaveCount(0);
    await expect(authority.getByRole('option', { name: 'Step Up', exact: true })).toHaveCount(0);

    // (c) Person 1 leaves the default alone.
    const firstPhone = uniquePhone();
    await fillIntake(page, { firstName: 'Fairfirst', lastName: 'Lead', phone: firstPhone, voucher: '4' });
    await page.getByRole('button', { name: 'Sign me up' }).click();
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
    const readsBeforeReset = listReads;
    expect(readsBeforeReset).toBeGreaterThan(0);

    // (d) "Sign up another person": an EMPTY form, focus on First name, and the
    // authority KEPT (D9).
    await page.getByRole('button', { name: 'Sign up another person' }).click();
    await expect(page.getByLabel('First name')).toBeFocused();
    await expectEmptyIntake(page);
    await expect(authority.locator('option:checked')).toHaveText(ATLANTA);

    // (e) Person 2 picks another listed authority.
    const secondPhone = uniquePhone();
    await fillIntake(page, { firstName: 'Fairsecond', lastName: 'Lead', phone: secondPhone });
    await authority.selectOption({ label: DEKALB });
    await page.getByRole('button', { name: 'Sign me up' }).click();
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();

    // (f) The next form keeps DeKalb - the previous person's CHOICE, not the
    // Atlanta default - which is what tells "kept" apart from "reset".
    await page.getByRole('button', { name: 'Sign up another person' }).click();
    await expect(page.getByLabel('First name')).toBeFocused();
    await expectEmptyIntake(page);
    await expect(authority.locator('option:checked')).toHaveText(DEKALB);

    // (g) Each lead, read through the AUTHENTICATED contacts API from a separate
    // staff context: a new tenant in Onboarding holding its authority and the
    // post-change marker (D5), still attributed to the housing fair.
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const first = await contactByPhone(staff.request, firstPhone);
    expect(first).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housingAuthority: ATLANTA,
      capture_source: 'housing_fair',
      housing_fair_signup_v2: true,
      firstName: 'Fairfirst',
      voucherSize: 4,
    });
    const second = await contactByPhone(staff.request, secondPhone);
    expect(second).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housingAuthority: DEKALB,
      capture_source: 'housing_fair',
      housing_fair_signup_v2: true,
      firstName: 'Fairsecond',
    });
    // The voucher field really was cleared: person 2 sent none.
    expect(second['voucherSize']).toBeUndefined();
    await staff.close();

    // (h) D9: neither "Sign up another person" read the list again.
    expect(listReads).toBe(readsBeforeReset);
  });

  test('fallback: a bogus id and a setup property show the neutral sign-up page; the seeded under_application property serves its flyer', async ({
    page,
    request,
  }) => {
    // permanent-flyer-links D4: one neutral page for a missing, deleted or Setup
    // property. Every absence below is asserted AFTER a positive check on the
    // same load - the page shows a loading line first (selectors.md).
    const bogusId = `unit-does-not-exist-${Date.now()}`;

    // (a) A bogus id, BARE (form variant) -> the fallback h1, its line and the
    // inline sign-up form (no login redirect).
    await page.goto(`${NEXT}/p/${bogusId}`);
    await expect(page.getByRole('heading', { level: 1, name: FALLBACK_HEADING })).toBeVisible();
    await expect(
      page.getByText(
        "Sign up and we'll text you about homes that fit your voucher. Signing up does not book a tour.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();
    await expect(page.getByText(RETIRED_COPY)).toHaveCount(0);
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /See other homes/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign up for home alerts' })).toHaveCount(0);

    // The opaque 404 body the text variant's CTA is fed by.
    const bogusRes = await request.get(`${NEXT}/public/units/${bogusId}/flyer`);
    expect(bogusRes.status()).toBe(404);
    const notFound = (await bogusRes.json()) as { error: string; contact_number: string | null };
    expect(notFound).toEqual({ error: 'not_found', contact_number: expect.stringMatching(/^\+1\d{10}$/) });

    // (b) The same bogus id with ?cta=text (known-tenant variant) -> the SAME h1,
    // and its CTA is a tap-to-text sms: link to the 404 body's contact_number. A
    // FRESH browser context so this flagged visit's sessionStorage never bleeds
    // into the bare cases in this test (that persistence is EXPECTED).
    const flaggedContext = await page.context().browser()!.newContext();
    const flaggedPage = await flaggedContext.newPage();
    await flaggedPage.goto(`${NEXT}/p/${bogusId}?cta=text`);
    await expect(flaggedPage.getByRole('heading', { level: 1, name: FALLBACK_HEADING })).toBeVisible();
    // Assert the sms: href only - never click it.
    await expect(
      flaggedPage.getByRole('link', { name: "I'm looking for a home - text us", exact: true }),
    ).toHaveAttribute(
      'href',
      `sms:${notFound.contact_number}?&body=${encodeURIComponent("I'm looking for a home that fits my voucher.")}`,
    );
    await expect(flaggedPage.getByLabel('First name')).toHaveCount(0);
    await expect(flaggedPage.getByText(RETIRED_COPY)).toHaveCount(0);
    await flaggedContext.close();

    // (c) A fresh property left in Setup (the create's own status, read back
    // through the staff API first) -> the SAME fallback: the one status the
    // flyer does not serve (D1). Its flyer API answers the SAME opaque 404 as the
    // bogus id - no existence oracle (D2).
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const setupUnit = await createShareableUnit(staff.request, {}, { setup: true });
    const readBack = await staff.request.get(`${NEXT}/api/units/${setupUnit.unitId}`);
    expect(readBack.ok()).toBeTruthy();
    expect(((await readBack.json()) as { unit: { status: string } }).unit.status).toBe('setup');
    await staff.close();

    const setupRes = await request.get(`${NEXT}/public/units/${setupUnit.unitId}/flyer`);
    expect(setupRes.status()).toBe(404);
    expect(await setupRes.json()).toEqual(notFound);

    await page.goto(`${NEXT}/p/${setupUnit.unitId}`);
    await expect(page.getByRole('heading', { level: 1, name: FALLBACK_HEADING })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toBeVisible();
    await expect(page.getByText(RETIRED_COPY)).toHaveCount(0);
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    // Nothing of the Setup property leaks onto the fallback.
    await expect(page.getByText(setupUnit.addressLine1)).toHaveCount(0);
    await expect(page.getByText(setupUnit.area)).toHaveCount(0);

    // (d) The seeded under_application property is SERVED (every status but
    // Setup - D1, D2): the served flyer's sign-up heading, not the fallback, and
    // the flyer API answers 200 with no status key. Its status is never asserted
    // (it follows placement-0001, which other specs move); whatever it is, the
    // page prints no status word (D3). Its address is a plain seed string the
    // projection drops, so its h1 is the no-address heading - not asserted.
    await page.goto(`${NEXT}/p/${UNDER_APPLICATION_UNIT}`);
    await expect(page.getByRole('heading', { name: 'Sign up for home alerts', exact: true })).toBeVisible();
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: FALLBACK_HEADING })).toHaveCount(0);
    await expect(page.getByText(RETIRED_COPY)).toHaveCount(0);
    await expect(page.getByText(STATUS_WORDS)).toHaveCount(0);
    const servedRes = await request.get(`${NEXT}/public/units/${UNDER_APPLICATION_UNIT}/flyer`);
    expect(servedRes.status()).toBe(200);
    const { flyer: served } = (await servedRes.json()) as { flyer: Record<string, unknown> };
    expect(Object.keys(served)).not.toContain('status');
  });

  test('fallback sign-up: a bogus id signs up inline - its own thank-you, and a plain housing-fair lead in Needs review', async ({
    page,
  }) => {
    // permanent-flyer-links D4, D5: the fallback's form sends the route id (1 to
    // 200 characters after the trim) and the server decides the credit. A
    // made-up id earns none: capture_source 'housing_fair', no
    // unit_of_interest, and 'needs_review' because a unitId WAS sent (a sign-up
    // with no unitId would start 'onboarding').
    await page.goto(`${NEXT}/p/unit-does-not-exist-${Date.now()}`);
    await expect(page.getByRole('heading', { level: 1, name: FALLBACK_HEADING })).toBeVisible();
    const phone = uniquePhone();
    await fillIntake(page, { firstName: 'Fallback', lastName: 'Signup', phone, voucher: '2' });
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();

    // The fallback's OWN thank-you - not the served flyer's "about this home
    // and others" - under the same h1.
    await expect(page.getByRole('heading', { name: /you're all set/i })).toBeVisible();
    await expect(page.getByText("We'll text you about homes that fit your voucher.", { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: FALLBACK_HEADING })).toBeVisible();
    await expect(page.getByLabel('First name')).toHaveCount(0);
    await expect(page.getByText(RETIRED_COPY)).toHaveCount(0);

    // The lead, read through the AUTHENTICATED contacts API from a separate
    // staff context.
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const contact = await contactByPhone(staff.request, phone);
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'needs_review',
      capture_source: 'housing_fair',
      firstName: 'Fallback',
      lastName: 'Signup',
      voucherSize: 2,
    });
    expect(contact['unit_of_interest']).toBeUndefined();
    // The sign-up marked the new thread unread before it answered; leave it
    // read so no later spec inherits an unread row.
    const read = await staff.request.post(`${NEXT}/api/inbox/${String(contact['contactId'])}/read`);
    expect(read.ok(), await read.text()).toBeTruthy();
    await staff.close();
  });
});
