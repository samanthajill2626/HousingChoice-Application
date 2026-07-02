import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutbox } from '../../fixtures/outbox.js';

// Public-pages surface (spec §9 e2e) — the UNAUTHENTICATED conversion funnel that
// mounts OUTSIDE the auth gate (dashboard/src/App.tsx): `/p/:unitId` (the
// FlyerFunnel: teaser → "I'm interested" → IntakeForm → reveal) and `/join` (the
// standalone housing-fair intake → thank-you). `/p/:unitId` is exactly what
// `flyerUrl()` emits, so every shared [FlyerLink] broadcast lands here.
//
// What this asserts (no session/cookies for the public reads):
//   1. Reachability — /p/<shareable> renders the TEASER (beds/rent/neighborhood)
//      with NO address and NO application fee, and does NOT redirect to login.
//   2. Funnel — "I'm interested" → fill the IntakeForm → submit → the REVEAL
//      shows address + application fee + video tour + utilities + same-day RTA.
//   3. Capture attribution — the created contact is stamped capture_source:'flyer'
//      + unit_of_interest:<unitId> (asserted via the authenticated contacts API),
//      and the welcome SMS is recorded in the dev outbox.
//   4. Staff edit flows to the reveal — a staff PATCH of the new detail fields
//      shows up on a fresh funnel run (unique phone).
//   5. /join — no session → fill + submit → thank-you (no reveal).
//   6. Unavailable — /p/<bogus> and /p/<non-shareable> → the friendly
//      "no longer available" state (no crash, no login redirect).
//
// Seeded data we lean on (app/src/lib/seedData.ts):
//   - contact-landlord-0001 = Marcus Bell (we own our test units under him).
//   - unit-0001 is `under_application` (NOT shareable) → reused as the
//     "non-shareable id is still an opaque 404" case.
// No seeded unit is `available`, so the spec CREATES its own shareable unit via
// the authenticated API (create → flip to available via listing-status → set the
// detail fields), keeping it isolated from the shared seed. Every public submit
// uses a UNIQUE phone so the per-phone idempotent welcome never collides across
// cases (or with other specs).

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SEEDED_LANDLORD = 'contact-landlord-0001';
const NON_SHAREABLE_UNIT = 'unit-0001'; // seeded `under_application` → opaque 404

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
}

/**
 * Create an AVAILABLE (shareable) unit through the authenticated API: create
 * (lands in `setup`), flip it to `available` via the listing-status transition,
 * then PATCH the teaser + reveal detail fields. `request` MUST carry the staff
 * session (pass `page.request` after devLogin). Returns the unit + the values we
 * assert on the teaser/reveal.
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
  };

  // (1) Create — a new unit starts in `setup` (not shareable).
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
    },
  });
  expect(createRes.ok()).toBeTruthy();
  u.unitId = (await createRes.json()).unit.unitId as string;

  // (2) Flip to `available` — the ONLY shareable status (§6). status is not a
  // writable CRUD field; it routes through the listing-status transition.
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
  // A2P/CTIA (spec §3.1): the required, unchecked-by-default consent checkbox gates
  // submit (client + server). Check it so the intake can proceed.
  await page.getByRole('checkbox', { name: /I agree to receive/i }).check();
}

test.describe('Public pages — the unauthenticated flyer funnel + /join', () => {
  test('teaser is reachable with NO session and hides the address + fee (no login redirect)', async ({
    page,
    request,
  }) => {
    // Staff context (separate page) ONLY to mint the shareable unit; the public
    // navigation below uses the bare `page`, which has NO session/cookies.
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request);
    await staff.close();

    // Public navigation — the bare page carries no session.
    await page.goto(`${NEXT}/p/${unit.unitId}`);

    // The teaser renders (it must NOT redirect to login).
    await expect(page).toHaveURL(new RegExp(`/p/${unit.unitId}$`));
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    // Neighborhood heading + beds + rent.
    await expect(page.getByRole('heading', { name: new RegExp(unit.area) })).toBeVisible();
    // Beds ("<strong>2</strong> beds") + rent ("<strong>$1725</strong>/mo").
    await expect(page.getByText(new RegExp(`${unit.beds}\\s*beds`))).toBeVisible();
    await expect(page.getByText(`$${unit.rent}`, { exact: false }).first()).toBeVisible();
    // The "I'm interested" CTA is present.
    await expect(page.getByRole('button', { name: /I'm interested/i })).toBeVisible();

    // The teaser exposes NO address and NO application fee (the wall is the
    // allowlist — these only appear post-intake on the reveal).
    await expect(page.getByText(unit.addressLine1)).toHaveCount(0);
    await expect(page.getByText('Application fee')).toHaveCount(0);
    await expect(page.getByText(`$${unit.applicationFee}`)).toHaveCount(0);

    // Sanity: the public flyer GET itself never carries address/fee (the bare,
    // unauthenticated `request` fixture reaches it with no session).
    const flyerRes = await request.get(`${NEXT}/public/units/${unit.unitId}/flyer`);
    expect(flyerRes.ok()).toBeTruthy();
    const { flyer } = await flyerRes.json();
    expect(flyer.application_fee).toBeUndefined();
    expect(flyer.address).toBeUndefined();
  });

  test('funnel: I\'m interested → intake → reveal shows address + fee + extras; contact is flyer-attributed', async ({
    page,
    request,
  }) => {
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request);

    // Public funnel — no session on `page`.
    await page.goto(`${NEXT}/p/${unit.unitId}`);
    await page.getByRole('button', { name: /I'm interested/i }).click();

    // The intake form.
    await expect(page.getByRole('heading', { name: /how to reach you/i })).toBeVisible();
    const phone = uniquePhone();
    await fillIntake(page, { firstName: 'Funnel', lastName: 'Tester', phone, voucher: '2' });
    await page.getByRole('button', { name: 'Get the full details' }).click();

    // The reveal — the thank-you + the full details that the teaser withheld.
    await expect(page.getByRole('heading', { name: /you're all set/i })).toBeVisible();
    await expect(page.getByText(unit.addressLine1)).toBeVisible();
    await expect(page.getByText('Application fee')).toBeVisible();
    await expect(page.getByText(`$${unit.applicationFee}`)).toBeVisible();
    await expect(page.getByText(unit.utilities)).toBeVisible();
    await expect(page.getByText('Same-day RTA')).toBeVisible();
    await expect(page.getByRole('link', { name: /Watch the tour/i })).toHaveAttribute(
      'href',
      unit.videoUrl,
    );

    // Capture attribution — the created contact carries capture_source:'flyer' +
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

  test('a staff edit of the new detail fields flows through to the public reveal', async ({
    page,
  }) => {
    const staff = await page.context().browser()!.newPage();
    await devLogin(staff);
    const unit = await createShareableUnit(staff.request, { applicationFee: 30 });

    // Staff edits the new fields (this is exactly what ListingEditForm PATCHes).
    const editedFee = 99;
    const editedVideo = `https://tours.example.com/edited-${Date.now()}`;
    const patchRes = await staff.request.patch(`${NEXT}/api/units/${unit.unitId}`, {
      data: { application_fee: editedFee, video_url: editedVideo, same_day_rta: false },
    });
    expect(patchRes.ok()).toBeTruthy();

    // Re-run the public funnel with a FRESH phone → the EDITED values appear.
    await page.goto(`${NEXT}/p/${unit.unitId}`);
    await page.getByRole('button', { name: /I'm interested/i }).click();
    const phone = uniquePhone();
    await fillIntake(page, { firstName: 'Edit', lastName: 'Flow', phone });
    await page.getByRole('button', { name: 'Get the full details' }).click();

    await expect(page.getByRole('heading', { name: /you're all set/i })).toBeVisible();
    await expect(page.getByText(`$${editedFee}`)).toBeVisible();
    await expect(page.getByRole('link', { name: /Watch the tour/i })).toHaveAttribute(
      'href',
      editedVideo,
    );
    // same_day_rta turned OFF → that row is absent on the reveal.
    await expect(page.getByText('Same-day RTA')).toHaveCount(0);
    // The stale fee never appears.
    await expect(page.getByText('$30')).toHaveCount(0);

    await staff.close();
  });

  test('/join: standalone intake with no session → thank-you (no reveal)', async ({ page }) => {
    // No session on `page` — the standalone housing-fair intake.
    await page.goto(`${NEXT}/join`);
    await expect(page).toHaveURL(/\/join$/);
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Find your next home/i })).toBeVisible();

    const phone = uniquePhone();
    await fillIntake(page, { firstName: 'Joiner', lastName: 'Public', phone, voucher: '3' });
    await page.getByRole('button', { name: 'Sign me up' }).click();

    // Generic thank-you — there is NO home to reveal here.
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
    await expect(page.getByText('Application fee')).toHaveCount(0);
    await expect(page.getByText('Address')).toHaveCount(0);
  });

  test('unavailable: a bogus id and a non-shareable unit both show the friendly state (no login redirect)', async ({
    page,
  }) => {
    // (a) A bogus unitId → the friendly "no longer available" state.
    await page.goto(`${NEXT}/p/unit-does-not-exist-${Date.now()}`);
    await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
    // The fallback link points at /join (see other homes).
    await expect(page.getByRole('link', { name: /See other homes/i })).toHaveAttribute('href', '/join');

    // (b) A REAL but non-shareable unit (seeded `under_application`) → the SAME
    // opaque state (no existence oracle, no crash, no login redirect).
    await page.goto(`${NEXT}/p/${NON_SHAREABLE_UNIT}`);
    await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    await expect(page.getByText('Sign in with Google')).toHaveCount(0);
  });
});
