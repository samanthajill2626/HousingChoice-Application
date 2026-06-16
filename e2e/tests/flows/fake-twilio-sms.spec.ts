import { test, expect } from '../../fixtures/auth.js';
import { sendAsParty, listThreads, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';

// The fake-phones UI is a static build served by the fake-twilio host on :8889.
const FAKE_UI = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';

// HTTP-seam proof: an inbound SMS from the seeded tenant, delivered through the
// fake-twilio service with a REAL signature, is processed by the real app
// (signature middleware + inbound pipeline). Then a staff reply goes out through
// the real TwilioMessagingDriver → fake REST → status callbacks land back.
//
// Selectors mirror the proven intake-to-reply.spec.ts flow and e2e/support/selectors.md:
//   - inbox row → getByRole('link').filter({ hasText })
//   - reply box → getByRole('textbox', { name: 'Message' })
//   - send      → getByRole('button', { name: 'Send' })
//   - timeline  → getByRole('log', { name: 'Message timeline' })
test('inbound SMS via fake-twilio reaches the staff inbox; reply round-trips', async ({ request, vaPage }) => {
  const tenant = '+15550100001';
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `Looking for a 2BR ${stamp}`;

  // 1) Tenant texts in through the fake (signed webhook → app /webhooks/twilio/sms).
  await sendAsParty(request, { from: tenant, body: inbound });

  // 2) The message surfaces in the staff dashboard inbox (proves the app accepted
  //    the SIGNED webhook and ran the inbound pipeline).
  await vaPage.goto('/');
  const convo = vaPage.getByRole('link').filter({ hasText: inbound });
  await expect(convo.first()).toBeVisible({ timeout: 10_000 });

  // 3) Staff opens the thread and replies; the reply goes out via the real driver.
  await convo.first().click();
  await expect(vaPage).toHaveURL(/\/conversations\//);
  const reply = `Yes — touring this week? ${stamp}`;
  await vaPage.getByRole('textbox', { name: 'Message' }).fill(reply);
  await vaPage.getByRole('button', { name: 'Send' }).click();

  // The reply renders in the thread timeline (presentational — appended
  // optimistically). The real proof-of-send is step 4 below.
  await expect(vaPage.getByRole('log', { name: 'Message timeline' }).getByText(reply)).toBeVisible();

  // 4) PROOF OF SEND: the outbound reply landed in the tenant's fake thread, and
  //    its delivery status progressed (status callbacks were accepted by the app).
  await expect
    .poll(async () => {
      const threads = await listThreads(request);
      const t = threads.find((x) => x.partyNumber === tenant);
      return t?.messages.some((m) => m.direction === 'outbound' && m.body === reply && m.state === 'delivered') ?? false;
    }, { timeout: 10_000 })
    .toBe(true);
});

// Canned MMS via the fake-phones UI: picking a canned image in the Composer and
// hitting Send must (a) NOT error — the picker used to emit Vite-inlined `data:`
// URIs, which the engine's http(s)-only media guard rejected — and (b) reach the
// real app as an inbound MMS. Drives the actual UI on :8889 (default `page`,
// unauthenticated — the fake UI needs no login), then proves it on the dashboard.
test('a canned MMS picked in the fake-phones UI sends without error and reaches the staff inbox', async ({
  page,
  request,
  vaPage,
}) => {
  const tenant = '+15550100001';
  const stamp = `${Date.now()}`.slice(-7);
  const body = `Here is the room ${stamp}`;

  // 1) Select the seeded tenant, attach the "Room" canned image, type, and Send.
  await page.goto(`${FAKE_UI}/`);
  await page.getByRole('button', { name: /Tasha Nguyen/ }).click();
  await page.getByRole('button', { name: /^Room$/ }).click(); // toggle the canned image on
  await page.getByRole('textbox', { name: 'Message' }).fill(body);
  await page.getByRole('button', { name: 'Send' }).click();

  // 2) The send SUCCEEDS: no error alert (the data:-URL bug 4xx'd here), the
  //    composer cleared, and the message renders in the phone thread with its
  //    image thumbnail (alt = the canned label).
  await expect(page.getByRole('img', { name: 'Room' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');

  // 3) The stored mediaUrl is a real absolute http(s) URL for the canned PNG —
  //    NOT a data: URI (which the engine would have rejected).
  await expect
    .poll(async () => {
      const t = (await listThreads(request)).find((x) => x.partyNumber === tenant);
      return t?.messages.find((m) => m.direction === 'inbound' && m.body === body)?.mediaUrls?.[0] ?? '';
    }, { timeout: 10_000 })
    .toMatch(/^https?:\/\/.*\/canned\/room\.png$/);

  // 4) END-TO-END: the inbound MMS mirrors to the local S3 (MinIO) and renders
  //    INLINE in the staff thread — an <img> served by the authed media endpoint.
  await vaPage.goto('/');
  const convo = vaPage.getByRole('link').filter({ hasText: body });
  await expect(convo.first()).toBeVisible({ timeout: 10_000 });
  await convo.first().click();
  await expect(vaPage).toHaveURL(/\/conversations\//);
  await expect(vaPage.getByText(body)).toBeVisible();

  const img = vaPage.getByRole('img', { name: /attachment/i });
  await expect(img.first()).toBeVisible();
  const src = await img.first().getAttribute('src');
  expect(src).toMatch(/^\/api\/messages\/.*\/media\/0$/);
  // The authed media endpoint serves the mirrored bytes inline as an image.
  const resp = await vaPage.request.get(src!);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toMatch(/^image\//);
});

// The PDF canned asset exercises the document path end-to-end: application/pdf is
// on the inline allowlist, so it mirrors to S3 and the dashboard shows a PDF
// viewer link whose media request serves application/pdf inline.
test('a canned PDF picked in the fake-phones UI mirrors and shows as a PDF link in the inbox', async ({
  page,
  vaPage,
}) => {
  const stamp = `${Date.now()}`.slice(-7);
  const body = `Lease doc ${stamp}`;

  await page.goto(`${FAKE_UI}/`);
  await page.getByRole('button', { name: /Tasha Nguyen/ }).click();
  await page.getByRole('button', { name: /^Lease doc$/ }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill(body);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await vaPage.goto('/');
  const convo = vaPage.getByRole('link').filter({ hasText: body });
  await expect(convo.first()).toBeVisible({ timeout: 10_000 });
  await convo.first().click();
  await expect(vaPage).toHaveURL(/\/conversations\//);

  const pdfLink = vaPage.getByRole('link', { name: /pdf attachment/i });
  await expect(pdfLink.first()).toBeVisible();
  const href = await pdfLink.first().getAttribute('href');
  expect(href).toMatch(/^\/api\/messages\/.*\/media\/0$/);
  const resp = await vaPage.request.get(href!);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toMatch(/^application\/pdf/);
});

// Failure injection: configure the tenant's NEXT outbound message to be reported
// undelivered by the fake. The staff reply still sends (the fake REST returns a
// SID), but the status callbacks drive it to `undelivered` — proving the app's
// status pipeline records the terminal failure state.
test('a staff reply that Twilio reports undelivered is reflected as failed', async ({ request, vaPage }) => {
  const tenant = '+15550100001';
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `ping ${stamp}`;
  await sendAsParty(request, { from: tenant, body: inbound });
  await setDeliveryOutcome(request, { partyNumber: tenant, profile: { kind: 'fail', failState: 'undelivered', errorCode: '30005' } });

  await vaPage.goto('/');
  const convo = vaPage.getByRole('link').filter({ hasText: inbound });
  await expect(convo.first()).toBeVisible({ timeout: 10_000 });
  await convo.first().click();
  await expect(vaPage).toHaveURL(/\/conversations\//);
  const reply = `reply ${stamp}`;
  await vaPage.getByRole('textbox', { name: 'Message' }).fill(reply);
  await vaPage.getByRole('button', { name: 'Send' }).click();

  await expect
    .poll(async () => {
      const threads = await listThreads(request);
      const t = threads.find((x) => x.partyNumber === tenant);
      return t?.messages.find((m) => m.body === reply)?.state;
    }, { timeout: 10_000 })
    .toBe('undelivered');
});
