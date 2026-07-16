import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { sendAsParty, listThreads } from '../../fixtures/fakeTwilio.js';
import { dashboardUrl } from '../../support/urls.js';

// Outbound MMS media transcoding (spec 2026-07-16, fixes Twilio 12300).
// Drives the REAL composer upload path (presign -> browser POSTs the bytes
// DIRECTLY to the lane MinIO -> confirm transcodes) and proves, end to end:
//   (a) a .webp attachment reaches the carrier seam as image/jpeg - asserted by
//       FETCHING the presigned media URL the fake recorded and reading its
//       Content-Type header, exactly what Twilio does before raising 12300 -
//       and NO multipart bytes ever hit the app (direct-to-S3).
//   (b) a small .png flows through UNCHANGED (image/png; no transcode) and a
//       multi-page .pdf shows the soft page-1-only note and sends ONE jpeg.
const NEXT = dashboardUrl;

const FIXTURE_WEBP = fileURLToPath(new URL('../../fixtures/red.webp', import.meta.url));
const FIXTURE_PNG = fileURLToPath(new URL('../../fixtures/tiny.png', import.meta.url));
const FIXTURE_PDF = fileURLToPath(new URL('../../fixtures/three-page.pdf', import.meta.url));

// 1:1 target present in the lean seed (same as outbound-mms.spec.ts).
const TASHA = '+15550100001';
const TASHA_ID = 'contact-tenant-0001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Open Tasha's contact page with an open 1:1 thread to send into. */
async function openTashaComposer(page: Page, request: APIRequestContext, token: string): Promise<void> {
  await sendAsParty(request, { from: TASHA, body: `starting a thread ${token}` });
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${TASHA_ID}`);
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
}

/** Attach a file through the real (visually hidden) input and wait until the
 *  presign -> S3 POST -> confirm flow completes (Send re-enables). */
async function attachAndWait(page: Page, filePath: string): Promise<void> {
  await page.locator('#mms-attach-input').setInputFiles(filePath);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 30_000 });
}

/** Poll the fake for THIS run's outbound leg (by body token) carrying media. */
async function pollMediaLeg(
  request: APIRequestContext,
  token: string,
  expectedCount: number,
): Promise<string[]> {
  let urls: string[] = [];
  await expect
    .poll(
      async () => {
        const threads = await listThreads(request);
        const thread = threads.find((t) => t.partyNumber === TASHA);
        const leg = thread?.messages.find(
          (m) => m.direction === 'outbound' && (m.body ?? '').includes(token),
        );
        urls = leg?.mediaUrls ?? [];
        return urls.length;
      },
      { timeout: 20_000, message: `no outbound leg with ${expectedCount} media for ${token}` },
    )
    .toBe(expectedCount);
  return urls;
}

/** The Content-Type Twilio would see when it fetches this media URL. */
async function fetchedContentType(request: APIRequestContext, url: string): Promise<string> {
  const res = await request.get(url);
  expect(res.ok(), `presigned media URL fetch failed: ${res.status()}`).toBeTruthy();
  return (res.headers()['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
}

test.describe('Outbound MMS media transcoding (12300 fix)', () => {
  test('a webp attachment is sent to the carrier as image/jpeg; bytes never hit the app', async ({
    page,
    request,
  }) => {
    const token = `webp-transcode-${Date.now()}`;

    // Record any multipart POST that reaches OUR app origin - there must be none
    // (the original goes browser->S3 direct; confirm is a small JSON call).
    const netMultipart: string[] = [];
    page.on('request', (r) => {
      const ct = r.headers()['content-type'] ?? '';
      if (r.method() === 'POST' && ct.startsWith('multipart/form-data') && r.url().includes('/api/')) {
        netMultipart.push(r.url());
      }
    });

    await openTashaComposer(page, request, token);
    await attachAndWait(page, FIXTURE_WEBP);
    await page.getByRole('textbox', { name: 'Reply message' }).fill(token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const urls = await pollMediaLeg(request, token, 1);
    // THE 12300 assertion: fetch what Twilio would fetch; the webp source must
    // have become a deliverable jpeg by the time it reaches the carrier seam.
    expect(await fetchedContentType(request, urls[0]!)).toBe('image/jpeg');
    // Direct-to-S3: no multipart body ever traveled to the app.
    expect(netMultipart).toEqual([]);
  });

  test('a small png flows through unchanged; a multi-page pdf warns and sends one jpeg', async ({
    page,
    request,
  }) => {
    const token = `png-pdf-mix-${Date.now()}`;

    await openTashaComposer(page, request, token);

    // Small png (flow-through): no page note appears for it.
    await attachAndWait(page, FIXTURE_PNG);
    await expect(page.getByText(/only the first page/i)).toHaveCount(0);

    // Multi-page pdf: confirm rasterizes page 1 and the chip shows the soft note.
    // (The note renders only when the chip is 'done', so this also proves the
    // confirm-transcode finished before we send.)
    await attachAndWait(page, FIXTURE_PDF);
    await expect(page.getByText(/only the first page/i)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('textbox', { name: 'Reply message' }).fill(token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const urls = await pollMediaLeg(request, token, 2);
    const types = await Promise.all(urls.map((u) => fetchedContentType(request, u)));
    // png passthrough (unchanged) + pdf -> exactly one deliverable jpeg.
    expect(types.sort()).toEqual(['image/jpeg', 'image/png']);
  });
});
