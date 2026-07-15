import { fileURLToPath } from 'node:url';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { dashboardUrl } from '../../support/urls.js';

// Property photos (unit-photos direct-upload, spec Sec 5) - drives the REAL
// dashboard Photos gallery against the hermetic lane stack + MinIO and proves the
// feature end to end. The upload now flows through the REAL direct-upload path:
// the browser presigns, POSTs the bytes STRAIGHT to MinIO, then confirms - no
// test-side special-casing (setInputFiles drives the app UI, which does it all).
//   (1) upload a REAL image -> the thumbnail AND the hero render loaded bytes
//       (naturalWidth > 0 - proof MinIO stored + served the object back);
//   (2) upload a SECOND photo + "Make cover" on it -> the hero flips to the new
//       cover key (the presigned pathname changes);
//   (3) "Remove" a photo (confirmed) -> it drops from the gallery;
//   (4) the PUBLIC flyer for that available unit renders the photo;
//   (5) NO multipart body ever hits the APP origin during upload (the bytes went
//       browser->MinIO) - pins the direct-upload architecture;
//   (6) E1 - flipping the unit to a non-shareable status (On hold) 404s the whole
//       flyer, photos included (the public must never learn a held unit exists).
//
// Isolation: every test owns a RUN-UNIQUE available unit created via the
// authenticated API (the blessed pattern for mutating specs), so no seeded unit
// is touched and concurrent lanes never collide.
const NEXT = dashboardUrl;

// The seeded landlord present in BOTH lean + full seed - our test units hang off
// it (we never mutate the landlord itself).
const SEEDED_LANDLORD = 'contact-landlord-0001';

// A real, tiny, valid PNG the file picker uploads. MinIO stores it and the
// presign-per-read serve pipeline streams it back, so naturalWidth > 0 asserts
// real bytes (the same fixture the outbound-MMS loaded-bytes assertion uses).
const FIXTURE_PNG = fileURLToPath(new URL('../../fixtures/tiny.png', import.meta.url));

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/**
 * Create a run-unique AVAILABLE (shareable) property through the authenticated
 * API: create (lands in `setup`) then flip to `available` via the listing-status
 * transition. `request` MUST carry the staff session (page.request post-login).
 */
async function createAvailableUnit(request: APIRequestContext): Promise<string> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const createRes = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: SEEDED_LANDLORD,
      jurisdiction: 'atlanta_housing',
      beds: 2,
      rent_min: 1600,
      rent_max: 1600,
      area: `Photos Ward ${stamp}`.slice(0, 40),
      address: { line1: `${`${Date.now()}`.slice(-6)} Photo Way NW`, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(createRes.ok(), `unit create failed: ${createRes.status()}`).toBeTruthy();
  const unitId = (await createRes.json()).unit.unitId as string;
  const statusRes = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(statusRes.ok(), `flip to available failed: ${statusRes.status()}`).toBeTruthy();
  return unitId;
}

/** The lone hidden file input in the Photos section (scoped so it can never
 *  match another file input on the page). setInputFiles drives it directly. */
function photoInput(page: Page): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Photos' }) })
    .locator('input[type="file"]');
}

/** Upload one file and wait for the upload to settle (the "+ Add" button
 *  re-enables from its "Uploading..." state). */
async function uploadPhoto(page: Page): Promise<void> {
  await photoInput(page).setInputFiles(FIXTURE_PNG);
  await expect(page.getByRole('button', { name: '+ Add' })).toBeEnabled({ timeout: 20_000 });
}

/**
 * Activate a per-thumbnail hover-action button (Make cover / Remove) via the
 * KEYBOARD path. The action bar reveals on `:hover` OR `:focus-within` and, once
 * revealed, overlaps the thumbnail center with `pointer-events: none` until
 * shown - so a mouse `.click()` hits a hit-test catch-22 (the img intercepts).
 * Focusing the button (which `:focus-within` reveals, unblocked by opacity/
 * pointer-events) then pressing Enter is what a keyboard user does and avoids the
 * pointer hit-test entirely - honest AND stable.
 */
async function activateThumbAction(button: Locator): Promise<void> {
  await button.focus();
  await button.press('Enter');
}

/**
 * Watch every BROWSER-initiated request for a multipart/form-data POST that hits
 * the APP origin (NEXT). The direct-upload architecture REQUIRES the photo bytes
 * go browser->MinIO; the app mints presigned grants + records keys over plain
 * JSON and must NEVER receive a multipart body again (the removed busboy route).
 * Any offender fails the architecture pin. The MinIO POST is multipart too but on
 * a DIFFERENT origin (:9000), so it is correctly ignored by the NEXT filter.
 */
function watchForMultipartToApp(page: Page): { offenders: string[] } {
  const offenders: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const url = req.url();
    if (!url.startsWith(NEXT)) return;
    const ct = req.headers()['content-type'] ?? '';
    if (ct.includes('multipart/form-data')) offenders.push(`${req.method()} ${url} (${ct})`);
  });
  return { offenders };
}

/** Poll an <img> until it has actually decoded bytes (naturalWidth > 0). */
async function expectLoadedBytes(img: Locator, message: string): Promise<void> {
  await expect(img).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 20_000,
      message,
    })
    .toBeGreaterThan(0);
}

/** The presigned key path (pathname only, sans the signature query) of an
 *  <img>'s current src - stable across re-reads of the SAME key, so a change
 *  proves the cover key itself changed. */
async function srcKeyPath(img: Locator): Promise<string> {
  const src = await img.getAttribute('src');
  expect(src, 'image has no src').toBeTruthy();
  return new URL(src!, NEXT).pathname;
}

test.describe('Property photos - upload, cover, remove, and the public flyer', () => {
  test('upload renders real bytes; a second photo + Make cover flips the hero; Remove drops it; the flyer shows the photo', async ({
    page,
  }) => {
    await devLogin(page);
    const unitId = await createAvailableUnit(page.request);

    // Pin the architecture: from here on, no multipart POST may hit the app.
    const watch = watchForMultipartToApp(page);

    await page.goto(`${NEXT}/listings/${unitId}`);
    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();

    // (1) Upload the first photo -> the thumbnail AND the hero render loaded bytes.
    await uploadPhoto(page);
    const thumb1 = page.getByRole('img', { name: 'Property photo 1' });
    const hero = page.getByRole('img', { name: /hero$/ });
    await expectLoadedBytes(thumb1, 'the first thumbnail never loaded bytes (presign-per-read serve)');
    await expectLoadedBytes(hero, 'the hero never loaded bytes (cover presign)');

    // (2) Upload a SECOND photo, then Make cover on it -> the hero flips to the
    // new cover key (its presigned pathname changes).
    const heroKeyBefore = await srcKeyPath(hero);
    await uploadPhoto(page);
    await expectLoadedBytes(
      page.getByRole('img', { name: 'Property photo 2' }),
      'the second thumbnail never loaded bytes',
    );
    await activateThumbAction(page.getByRole('button', { name: 'Make property photo 2 the cover' }));
    await expect
      .poll(async () => srcKeyPath(hero), {
        timeout: 20_000,
        message: 'the hero never flipped to the new cover key after Make cover',
      })
      .not.toBe(heroKeyBefore);
    // The flipped hero still renders real bytes.
    await expectLoadedBytes(hero, 'the hero never loaded bytes after the cover flip');

    // (3) Remove one photo (confirmed) -> the gallery drops from 2 thumbs to 1.
    await expect(page.getByRole('img', { name: /^Property photo \d+$/ })).toHaveCount(2);
    await activateThumbAction(page.getByRole('button', { name: 'Remove property photo 2' }));
    const removeDialog = page.getByRole('dialog', { name: 'Remove photo?' });
    await expect(removeDialog).toBeVisible();
    await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('img', { name: /^Property photo \d+$/ })).toHaveCount(1);

    // (4) The PUBLIC flyer for this available unit renders the surviving photo
    // (the teaser gallery mounts OUTSIDE the auth gate; alt = "Home photo N").
    await page.goto(`${NEXT}/p/${unitId}`);
    await expect(page.getByRole('button', { name: /I'm interested/i })).toBeVisible();
    await expectLoadedBytes(
      page.getByRole('img', { name: 'Home photo 1' }),
      'the public flyer photo never loaded bytes (public presign-per-read)',
    );

    // (5) The bytes went browser->MinIO: the app origin saw ZERO multipart POSTs
    // across both uploads (presign + confirm are plain JSON).
    expect(
      watch.offenders,
      `a multipart body reached the app origin - the direct-upload path regressed: ${watch.offenders.join(', ')}`,
    ).toEqual([]);
  });

  test('E1: a non-shareable (On hold) unit 404s the whole flyer, photos included', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const unitId = await createAvailableUnit(page.request);

    // Give it a photo, then confirm the AVAILABLE flyer serves both the page
    // photo and the flyer API (200 with a resolved media url).
    await page.goto(`${NEXT}/listings/${unitId}`);
    await uploadPhoto(page);
    await page.goto(`${NEXT}/p/${unitId}`);
    await expectLoadedBytes(
      page.getByRole('img', { name: 'Home photo 1' }),
      'the available flyer photo never loaded bytes',
    );
    const okFlyer = await request.get(`${NEXT}/public/units/${unitId}/flyer`);
    expect(okFlyer.ok()).toBeTruthy();
    expect((await okFlyer.json()).flyer.media.length).toBeGreaterThan(0);

    // Flip to a non-shareable status (On hold) via the listing-status transition.
    const held = await page.request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'on_hold', source: 'manual' },
    });
    expect(held.ok()).toBeTruthy();

    // The public funnel now shows the friendly whole-page "no longer available"
    // state (NO photos leak), and the flyer API 404s (no existence oracle).
    await page.goto(`${NEXT}/p/${unitId}`);
    await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    await expect(page.getByRole('img', { name: /^Home photo \d+$/ })).toHaveCount(0);
    const goneFlyer = await request.get(`${NEXT}/public/units/${unitId}/flyer`);
    expect(goneFlyer.status()).toBe(404);
  });
});
