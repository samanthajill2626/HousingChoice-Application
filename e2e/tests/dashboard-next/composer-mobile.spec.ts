import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// Mobile composer layout — regression cover for "the reply box gets squished on
// mobile when the reply is long" (tour / placement group text, and every other
// page that mounts the shared <Timeline> composer).
//
// TWO defects, both only reachable at phone widths:
//
//  1. Auto-grow died on a hidden mount. Below 860px the twoPaneShell hides the
//     inactive pane with `display: none` but keeps it MOUNTED, and the tour page
//     opens on Details — so the composer first measured itself with no layout box.
//     scrollHeight reads 0 there, so useAutoGrowTextarea sized the textarea to
//     just its borders, and its ResizeObserver then read the reveal (0 -> laid
//     out) as a manual drag and disarmed auto-grow for the rest of the message.
//     A long reply stayed clipped inside that sliver.
//
//  2. The composer could overflow the bottom of the pane. `.comms` is bounded and
//     is NOT a scroller, so once the box legitimately grew, Send and the reply
//     note fell off the bottom edge with nothing to scroll to them.
//
// Both assertions are geometric on purpose: the accessible tree looked perfectly
// healthy while the box was two pixels tall, so only measurement catches this.
//
// SEEDING: the live tour + its relay group (`tour-live-tomorrow`,
// `conv-live-relay-group`, app/src/lib/seed/live.ts) exist only in the FULL
// profile, but the harness boots LEAN — so we reseed full here and restore the
// lean baseline in afterAll, exactly as relay-group-view.spec.ts does. Sequential
// workers (workers:1, fullyParallel:false) mean no other spec races these.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

const TOUR_ID = 'tour-live-tomorrow'; // landlord-led, has a group thread
const PHONE = { width: 390, height: 844 }; // iPhone 14-ish

/** A draft long enough to need several lines in a phone-width composer. */
const LONG_REPLY =
  'Hi both - just confirming tomorrow at 10:00 AM at 718 Ponce de Leon Ave NE. ' +
  'Please text here if anything changes and I will let the other party know right away. Thanks!';

async function reseedFull(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed?profile=full`);
  expect(res.ok(), `full reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** The narrow-width pane toggle (twoPaneShell's segMobile, aria-label "View").
 *  Scoped so "Details" / "Conversation" can never collide with page content that
 *  happens to use those words. */
function paneToggle(page: Page) {
  return page.getByRole('group', { name: 'View' });
}

test.beforeEach(async ({ request }) => {
  await reseedFull(request);
});

test.afterAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean restore reseed failed: ${res.status()}`).toBeTruthy();
});

test('mobile group text: a long reply grows the box instead of squishing it', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await devLogin(page);
  await page.goto(`${NEXT}/tours/${TOUR_ID}`);

  // The tour opens on Details, so the composer mounts inside the display:none
  // pane — the exact path that used to collapse it. Reveal it.
  await paneToggle(page).getByRole('button', { name: 'Conversation' }).click();
  const reply = page.getByRole('textbox', { name: 'Reply message' });
  await expect(reply).toBeVisible();

  // Revealed, it must be a real one-line box — not the borders-only sliver.
  const empty = await reply.boundingBox();
  expect(empty).not.toBeNull();
  expect(empty!.height).toBeGreaterThan(24);

  await reply.fill(LONG_REPLY);

  // It grew to fit, and the text is not clipped inside it.
  const grown = await reply.boundingBox();
  expect(grown!.height).toBeGreaterThan(empty!.height);
  const clipped = await reply.evaluate(
    (el) => el.scrollHeight > (el as HTMLTextAreaElement).clientHeight + 1,
  );
  expect(clipped, 'the draft is clipped inside the reply box').toBe(false);
});

test('mobile group text: the whole composer stays inside the pane', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await devLogin(page);
  await page.goto(`${NEXT}/tours/${TOUR_ID}`);
  await paneToggle(page).getByRole('button', { name: 'Conversation' }).click();

  const reply = page.getByRole('textbox', { name: 'Reply message' });
  await expect(reply).toBeVisible();
  await reply.fill(LONG_REPLY);

  // The comms pane is bounded and does not scroll, so anything past its bottom
  // edge is simply unreachable — Send and the "Reply sends to ..." note included.
  const overflow = await reply.evaluate((el) => {
    const comms = el.closest('section');
    return comms === null ? -1 : comms.scrollHeight - comms.clientHeight;
  });
  expect(overflow, 'the comms pane overflows its own bottom edge').toBe(0);

  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeInViewport();
  // Full-size, not compressed by the long group-roster note beside it.
  const sendBox = await send.boundingBox();
  expect(sendBox!.height).toBeGreaterThanOrEqual(24);

  // The group note names every member, so at phone width it takes its own line
  // UNDER the controls rather than squeezing them mid-row.
  const note = page.getByText('everyone in this group text');
  await expect(note).toBeVisible();
  const noteBox = await note.boundingBox();
  expect(noteBox!.y).toBeGreaterThan(sendBox!.y);
});

test('mobile: hiding and re-showing the pane keeps auto-grow armed', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await devLogin(page);
  await page.goto(`${NEXT}/tours/${TOUR_ID}`);

  // Reveal, hide, reveal. Each display:none round-trip used to look like a manual
  // drag to the ResizeObserver, which froze the box at its current height.
  await paneToggle(page).getByRole('button', { name: 'Conversation' }).click();
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toBeVisible();
  await paneToggle(page).getByRole('button', { name: 'Details' }).click();
  await paneToggle(page).getByRole('button', { name: 'Conversation' }).click();

  const reply = page.getByRole('textbox', { name: 'Reply message' });
  await expect(reply).toBeVisible();
  const empty = await reply.boundingBox();

  await reply.fill(LONG_REPLY);
  const grown = await reply.boundingBox();
  expect(grown!.height).toBeGreaterThan(empty!.height);
});
