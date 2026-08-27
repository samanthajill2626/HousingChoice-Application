import { test, expect, type Page } from '@playwright/test';
import { sendAsParty } from '../../fixtures/fakeTwilio.js';
import { dashboardUrl, fakeUrl } from '../../support/urls.js';
import { expectTodayReady } from '../../support/today.js';

// Inbound media content-type fidelity (spec 2026-08-26), end to end for the
// DECLARABLE tier - a type we know but never render inline.
//
// A tenant texts in a vCard. Before this feature the mirror collapsed every
// non-image type to application/octet-stream, so the timeline showed a bare
// "Attachment 1" and the serve route handed back octet-stream: the operator
// could neither tell what the file was nor open it. This proves both halves of
// the repair against the REAL stack:
//   (a) the timeline names the kind ("Contact card - Attachment 1") and renders
//       a file LINK, not an <img>, and
//   (b) following that exact href returns the true type with an attachment
//       disposition and a .vcf name the operating system will act on.
//
// A 1:1 THREAD, NOT A RELAY GROUP. The mirror is shared by both paths, so a 1:1
// proves the same thing - and a relay thread would additionally drive the
// fan-out, the known-broken forwarding path filed as
// docs/issues/relay-forwards-undeliverable-media.md, which this spec does not
// own.
const NEXT = dashboardUrl;

// 1:1 target present in the lean seed and registered on the fake as a party
// (same contact the outbound-mms and mms-transcode specs drive).
const TASHA = '+15550100001';
const TASHA_ID = 'contact-tenant-0001';

// The fake's canned vCard, served as a real same-origin static file so the
// app's inbound mirror can actually fetch the bytes. The webhook's
// MediaContentType0 is derived from this URL's extension by the fake's signer
// (inferMediaContentType -> text/vcard), exactly as the carrier supplies it.
const CANNED_VCARD = `${fakeUrl}/canned/contact-card.vcf`;

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

test.describe('Inbound declarable media', () => {
  test('a vCard MMS is named on the timeline and served typed, as a download', async ({
    page,
    request,
  }) => {
    const token = `vcard-inbound-${Date.now()}`;

    // The tenant texts the vCard in. Omitting `to` targets APP_NUMBER - the 1:1
    // path - rather than a pool number, which would be a relay leg.
    await sendAsParty(request, {
      from: TASHA,
      body: `here is my landlord ${token}`,
      mediaUrls: [CANNED_VCARD],
    });

    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TASHA_ID}`);

    const timeline = page.getByRole('region', { name: 'Communications and activity' });

    // (a) A LINK carrying the kind word, never an <img>: the browser cannot
    //     decode a vCard, so rendering one inline would be a broken image.
    //     `.first()` because a re-run against a warm lane leaves an earlier,
    //     equally correct vCard bubble on the thread - two matches would fail
    //     strict mode on a CORRECT render. Generous budget: the inbound webhook
    //     acks first and the media mirror (fetch + S3 put, with its own retry
    //     ladder) lands a beat later.
    const link = timeline.getByRole('link', { name: /Contact card - Attachment 1/i }).first();
    await expect(link, 'the vCard never rendered as a named file link').toBeVisible({
      timeout: 30_000,
    });

    // (b) Follow the href a human would click. Same page session, so the cookie
    //     the authed media route requires rides along; the relative URL resolves
    //     against the dashboard baseURL, whose Vite proxy adds the origin-verify
    //     header the app demands.
    const href = await link.getAttribute('href');
    expect(href, 'the file link has no href').not.toBeNull();
    const res = await page.request.get(href!);

    expect(res.status(), `serving ${href} failed`).toBe(200);
    // The TRUE type, not application/octet-stream, and no charset parameter.
    expect(res.headers()['content-type']).toBe('text/vcard');
    // Declarable means typed truthfully but ALWAYS downloaded, under a name
    // whose extension we chose from our own closed set.
    expect(res.headers()['content-disposition']).toMatch(/^attachment; filename=".*\.vcf"$/);
  });
});
