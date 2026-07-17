import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutbox } from '../../fixtures/outbox.js';

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
//   1. Full info is public with NO gate - address/deposit/fee/utilities/pets/
//      accessibility/lease-terms/RTA/video all render upfront; the intake form is
//      present; no login redirect. Plus a raw flyer-API sanity check (contact_number).
//   2. The bottom form submit swaps ONLY the CTA to a thank-you in place (the info
//      above stays), stamps the contact capture_source:'flyer' + unit_of_interest,
//      and records the welcome SMS in the dev outbox.
//   3. `?cta=text` shows the tap-to-text CTA (href only), hides the form, and the
//      cta flag is stripped from the address bar after load.
//   4. A staff edit flows straight to the public page (no funnel steps).
//   5. `/join` - no session -> fill + submit -> thank-you (unchanged).
//   6. Unavailable - a bogus id and a non-shareable unit stay opaque; BOTH CTA
//      variants land somewhere (public -> /join, text -> a tap-to-text sms: CTA fed
//      by the opaque-404 body's contact_number).
//
// Seeded data we lean on (app/src/lib/seedData.ts):
//   - contact-landlord-0001 = Marcus Bell (we own our test units under him).
//   - unit-0001 is `under_application` (NOT shareable) -> reused as the
//     "non-shareable id is still an opaque 404" case.
// No seeded unit is `available`, so the spec CREATES its own shareable unit via the
// authenticated API (create -> flip to available via listing-status -> set every
// public field). Every public submit uses a UNIQUE phone so the per-phone idempotent
// welcome never collides across cases (or specs). The e2e stack sets OUR_PHONE_NUMBERS
// (scripts/e2e-session.mjs), so the flyer's contact_number is non-null here.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SEEDED_LANDLORD = 'contact-landlord-0001';
const NON_SHAREABLE_UNIT = 'unit-0001'; // seeded `under_application` -> opaque 404

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** A unique +1555 phone per submit so the idempotent (per-phone) welcome never
 *  collides across cases / specs. */
function uniquePhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

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
 * Create an AVAILABLE (shareable) unit through the authenticated API: create
 * (lands in `setup`), flip it to `available` via the listing-status transition,
 * then PATCH the full public field set. `request` MUST carry the staff session
 * (pass `page.request` after devLogin). Returns the unit + the values we assert
 * on the public flyer page.
 */
async function createShareableUnit(
  request: APIRequestContext,
  overrides: Partial<ShareableUnit> = {},
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
      jurisdiction: 'atlanta_housing',
      beds: u.beds,
      rent_min: u.rent,
      rent_max: u.rent,
      area: u.area,
      media: ['https://photos.example.com/a.jpg'],
      address: { line1: u.addressLine1, city: 'Atlanta', state: 'GA', zip: '30314' },
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

  // (2) Flip to `available` - the ONLY shareable status. status is not a writable
  // CRUD field; it routes through the listing-status transition.
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

    // Key facts: neighborhood heading + beds + rent.
    await expect(page.getByRole('heading', { name: new RegExp(unit.area) })).toBeVisible();
    await expect(page.getByText(new RegExp(`${unit.beds}\\s*beds`))).toBeVisible();
    await expect(page.getByText(`$${unit.rent}`, { exact: false }).first()).toBeVisible();

    // Every tenant-useful fact is shown UPFRONT - no gate (this IS the feature).
    await expect(page.getByText(unit.addressLine1)).toBeVisible();
    await expect(page.getByText('Deposit')).toBeVisible();
    await expect(page.getByText(`$${unit.deposit}`)).toBeVisible();
    await expect(page.getByText('Application fee')).toBeVisible();
    await expect(page.getByText(`$${unit.applicationFee}`)).toBeVisible();
    await expect(page.getByText(unit.utilities)).toBeVisible();
    await expect(page.getByText('Pets')).toBeVisible();
    await expect(page.getByText(unit.pets)).toBeVisible();
    await expect(page.getByText('Accessibility')).toBeVisible();
    await expect(page.getByText(unit.accessibility)).toBeVisible();
    await expect(page.getByText('Lease terms')).toBeVisible();
    await expect(page.getByText(unit.leaseTerms)).toBeVisible();
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
    // contact_number (the e2e stack sets OUR_PHONE_NUMBERS). The bare, unauthenticated
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
    await page.getByRole('button', { name: /I'm interested/i }).click();

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

    // And the welcome SMS was recorded in the dev outbox for this phone.
    await expect
      .poll(async () => (await getOutbox(request, { to: phone })).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

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
    const patchRes = await staff.request.patch(`${NEXT}/api/units/${unit.unitId}`, {
      data: { application_fee: editedFee, video_url: editedVideo, same_day_rta: false },
    });
    expect(patchRes.ok()).toBeTruthy();
    await staff.close();

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

  test('unavailable: a bogus id and a non-shareable unit stay opaque; both CTA variants land somewhere', async ({
    page,
  }) => {
    // (a) A bogus id, BARE (public variant) -> the friendly "no longer available"
    // state with the "See other homes" -> /join fallback (no login redirect).
    await page.goto(`${NEXT}/p/unit-does-not-exist-${Date.now()}`);
    await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /See other homes/i })).toHaveAttribute('href', '/join');

    // (b) A bogus id with ?cta=text (known-tenant variant) -> the SAME friendly state,
    // but its CTA is a tap-to-text sms: link fed by the opaque-404 body's
    // contact_number. A FRESH browser context so this flagged visit's sessionStorage
    // never bleeds into the bare cases in this test (that persistence is EXPECTED).
    const flaggedContext = await page.context().browser()!.newContext();
    const flaggedPage = await flaggedContext.newPage();
    await flaggedPage.goto(`${NEXT}/p/unit-does-not-exist-${Date.now()}?cta=text`);
    await expect(flaggedPage.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    // Assert the sms: href only - never click it.
    await expect(flaggedPage.getByRole('link', { name: /text us/i })).toHaveAttribute('href', /^sms:/);
    await flaggedContext.close();

    // (c) A REAL but non-shareable unit (seeded `under_application`), BARE -> the SAME
    // opaque state (no existence oracle, no crash, no login redirect).
    await page.goto(`${NEXT}/p/${NON_SHAREABLE_UNIT}`);
    await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
  });
});
