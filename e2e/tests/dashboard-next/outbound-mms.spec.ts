import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import {
  sendAsParty,
  listThreads,
  registerParty,
  type FakeThread,
} from '../../fixtures/fakeTwilio.js';
import { dashboardUrl, fakeUrl } from '../../support/urls.js';
// The single source of truth for automated-message copy. Import the PURE catalog
// module (no repo/AWS deps) so the media-only relay body is asserted against the
// catalog default rather than a hard-coded string.
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';

// Outbound MMS - attach + send media everywhere staff send SMS (design Sec 12).
// Drives the REAL dashboard composer against the hermetic lane stack and proves
// the feature end to end:
//   (a) a 1:1 contact send with a device-uploaded image: the fake thread records
//       an outbound leg carrying a (presigned) media URL AND the timeline renders
//       the sent attachment through the authed serve pipeline (media_attachments).
//   (b) a team group MMS: both member fake threads receive legs WITH media.
//   (c) a member's inbound photo forwards to the OTHER member WITH media.
//   (d) a media-only team group send delivers legs whose body is the
//       relay.media_only catalog copy ("<name> sent an attachment.").
//   (e) the composer attach control is usable at 360px with no horizontal overflow.
const NEXT = dashboardUrl;

// The 5-byte-ish valid PNG fixture Playwright's file picker uploads (a real file
// is required; the fake never fetches outbound media - a valid URL is enough).
const FIXTURE_PNG = fileURLToPath(new URL('../../fixtures/tiny.png', import.meta.url));

// --- 1:1 target (present in both lean + full seed) ---------------------------
const TASHA = '+15550100001'; // contact-tenant-0001's primary number
const TASHA_ID = 'contact-tenant-0001';

// --- Live relay group constants (app/src/lib/seed/live.ts, full profile) ------
const CONV_ID = 'conv-live-relay-group';
const POOL = '+15550160001';
const DIANA_ID = 'contact-live-tenant-a';
const DIANA_PHONE = '+15550170001'; // Diana Osei (tenant)
const GLORIA_PHONE = '+15550170003'; // Gloria Mensah (landlord)
const INBOX_LABEL = 'With Diana Osei & Gloria Mensah';

// The relay.media_only default is "{name} sent an attachment."; a media-only
// relay leg body must match that copy with SOME non-empty sender name. Building
// the matcher from the catalog (not a literal) keeps the assertion honest if the
// copy is edited.
const MEDIA_ONLY_TEMPLATE = MESSAGE_CATALOG['relay.media_only'].default; // "{name} sent an attachment."
const MEDIA_ONLY_SUFFIX = MEDIA_ONLY_TEMPLATE.replace('{name}', '').trim(); // "sent an attachment."

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Attach the fixture image on the shared composer and wait for the upload to
 *  finish (Send re-enables only when nothing is uploading). Optionally type a
 *  body first (a 1:1 send needs body OR attachments; a media-only send does not). */
async function attachFixtureAndArmSend(page: Page, body?: string): Promise<void> {
  if (body !== undefined) {
    await page.getByRole('textbox', { name: 'Reply message' }).fill(body);
  }
  // The input is visually hidden (srOnly) but setInputFiles drives it directly.
  await page.locator('#mms-attach-input').setInputFiles(FIXTURE_PNG);
  // The chip appears immediately (aria-busy while uploading); wait for the upload
  // to complete via the Send button re-enabling (disabled while hasUploading).
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 20_000 });
}

/** Outbound legs on a member's fake thread that carry at least one media URL. */
function outboundMediaLegs(threads: FakeThread[], party: string) {
  const thread = threads.find((t) => t.partyNumber === party);
  return (thread?.messages ?? []).filter(
    (m) => m.direction === 'outbound' && (m.mediaUrls?.length ?? 0) > 0,
  );
}

test.describe('Outbound MMS - 1:1 contact composer', () => {
  test('(a) attach + send an image: the fake records media AND the timeline renders it', async ({
    page,
    request,
  }) => {
    const token = `mms-1to1-${Date.now()}`;

    // Establish an open 1:1 conversation (an inbound from the tenant), exactly as
    // the comms round-trip spec does, so the composer has a single send target.
    await sendAsParty(request, { from: TASHA, body: `starting a thread ${token}` });

    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TASHA_ID}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    // Upload from device via the REAL file input, then send with a text body.
    await attachFixtureAndArmSend(page, token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // (i) Proof of send: the tenant's fake thread has an outbound leg carrying a
    //     presigned media URL (the app presigns per attempt and passes it to the
    //     Twilio driver, which the fake records).
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const thread = threads.find((t) => t.partyNumber === TASHA);
          return (
            thread?.messages.some(
              (m) =>
                m.direction === 'outbound' &&
                (m.body ?? '').includes(token) &&
                (m.mediaUrls?.length ?? 0) > 0,
            ) ?? false
          );
        },
        { timeout: 20_000, message: 'no outbound media leg recorded on the tenant fake thread' },
      )
      .toBe(true);

    // (ii) The sent attachment renders in the timeline through the AUTHED serve
    //      endpoint (media_attachments bubble). Assert the image element is present
    //      AND actually loaded bytes (naturalWidth > 0) - proof the private-bucket
    //      serve pipeline streamed the uploaded object back.
    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    const img = timeline.getByRole('img', { name: 'Attachment 1' }).last();
    await expect(img).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: 20_000,
        message: 'the sent attachment image never loaded (authed serve pipeline)',
      })
      .toBeGreaterThan(0);
  });

  test('(e) the attach control is usable at 360px with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TASHA_ID}`);

    // Mobile lands on the Comms pane (a Comms/Profile toggle; "Details" lives under
    // Profile), so gate readiness on the composer's attach affordance itself - the
    // thing under test - which the mobile composer renders inline.
    const attach = page.getByRole('button', { name: 'Attach a file' });
    await expect(attach).toBeVisible({ timeout: 15_000 });
    const box = await attach.boundingBox();
    expect(box, 'attach button has no layout box').not.toBeNull();
    // Its right edge sits within the viewport (not clipped off-screen).
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);

    // The document itself does not scroll horizontally at 360px.
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX, 'page overflows horizontally at 360px').toBeLessThanOrEqual(1);
  });
});

test.describe('Outbound MMS - relay group media both directions', () => {
  /** Reseed FULL so the live relay group (full-profile only) exists. */
  async function reseedFull(request: APIRequestContext): Promise<void> {
    const res = await request.post(`${NEXT}/__dev/reseed?profile=full`);
    expect(res.ok(), `full reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  }

  test.beforeEach(async ({ request }) => {
    await reseedFull(request);
  });

  // Restore the lean baseline the rest of the suite expects.
  test.afterAll(async ({ request }) => {
    const res = await request.post(`${NEXT}/__dev/reseed`);
    expect(res.ok(), `lean restore reseed failed: ${res.status()}`).toBeTruthy();
  });

  test('(b) team group MMS: both member fake threads receive legs WITH media', async ({
    page,
    request,
  }) => {
    const token = `relay-mms-${Date.now()}`;

    await devLogin(page);
    await page.goto(`${NEXT}/conversations/${CONV_ID}`);
    await expect(page.getByText(INBOX_LABEL)).toBeVisible();

    // Team send WITH text + an attachment through the group composer.
    await attachFixtureAndArmSend(page, token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(token)).toBeVisible({ timeout: 15_000 });

    // Each member's fake thread gets exactly this run's leg carrying media (the
    // fan-out re-presigns the hub attachment per leg). A unique token isolates
    // this run from any leftover legs on the persistent fake threads.
    for (const memberPhone of [DIANA_PHONE, GLORIA_PHONE]) {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(request);
            const thread = threads.find((t) => t.partyNumber === memberPhone);
            return (
              thread?.messages.some(
                (m) =>
                  m.direction === 'outbound' &&
                  m.from === POOL &&
                  (m.body ?? '').includes(token) &&
                  (m.mediaUrls?.length ?? 0) > 0,
              ) ?? false
            );
          },
          { timeout: 20_000, message: `no media leg fanned out to ${memberPhone}` },
        )
        .toBe(true);
    }
  });

  test('(c) a member photo forwards to the OTHER member WITH media', async ({ request }) => {
    const token = `member-photo-${Date.now()}`;

    // Diana must be a known party on the fake before she can send-as-party.
    await registerParty(request, { label: 'Diana Osei', role: 'tenant', number: DIANA_PHONE });

    // Diana texts the POOL a photo (a canned raster the app's inbound mirror
    // allowlists + mirrors to our bucket). The relay fan-out forwards it to the
    // other member (Gloria) - re-presigning the mirrored key per leg.
    await sendAsParty(request, {
      from: DIANA_PHONE,
      to: POOL,
      body: `here is a photo ${token}`,
      mediaUrls: [`${fakeUrl}/canned/room.png`],
    });

    // Gloria's fake thread receives the forwarded leg FROM the pool, carrying the
    // token body (Diana's attribution prefix rides along) AND media.
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const thread = threads.find((t) => t.partyNumber === GLORIA_PHONE);
          return (
            thread?.messages.some(
              (m) =>
                m.direction === 'outbound' &&
                m.from === POOL &&
                (m.body ?? '').includes(token) &&
                (m.mediaUrls?.length ?? 0) > 0,
            ) ?? false
          );
        },
        { timeout: 20_000, message: 'the member photo was not forwarded to the other member' },
      )
      .toBe(true);
  });

  test('(d) a media-only team send delivers the relay.media_only catalog body', async ({
    page,
    request,
  }) => {
    // Snapshot the media-only legs already on each thread (the fake threads persist
    // across reseeds) so we assert THIS run added a NEW one - a media-only send has
    // no text token to isolate on.
    const before = await listThreads(request);
    const beforeCount = (party: string): number =>
      outboundMediaLegs(before, party).filter((m) => (m.body ?? '').includes(MEDIA_ONLY_SUFFIX))
        .length;
    const dianaBefore = beforeCount(DIANA_PHONE);
    const gloriaBefore = beforeCount(GLORIA_PHONE);

    await devLogin(page);
    await page.goto(`${NEXT}/conversations/${CONV_ID}`);
    await expect(page.getByText(INBOX_LABEL)).toBeVisible();

    // Media-only: attach WITHOUT typing a body; Send arms on the attachment alone.
    await attachFixtureAndArmSend(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Each member gets a NEW leg whose body is the media_only catalog copy
    // ("<name> sent an attachment.") AND carries media.
    const mediaOnlyMatch = new RegExp(`^.+ ${escapeRegExp(MEDIA_ONLY_SUFFIX)}$`);
    for (const [memberPhone, prior] of [
      [DIANA_PHONE, dianaBefore],
      [GLORIA_PHONE, gloriaBefore],
    ] as const) {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(request);
            return outboundMediaLegs(threads, memberPhone).filter((m) =>
              mediaOnlyMatch.test(m.body ?? ''),
            ).length;
          },
          {
            timeout: 20_000,
            message: `no NEW media-only catalog leg fanned out to ${memberPhone}`,
          },
        )
        .toBeGreaterThan(prior);
    }
  });
});

/** Escape a literal string for use inside a RegExp (mirrors the scenarios helper). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
