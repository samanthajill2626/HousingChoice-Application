import { test, expect, type Page } from '@playwright/test';
import { sendAsParty, listThreads } from '../../fixtures/fakeTwilio.js';

// Comms round-trip rebuilt on the NEW entity-centric surface (:5174), replacing the
// legacy-inbox version deleted in 40bd4f0. Proves the full seam end-to-end against
// the merged C8 feed: a REAL-signed inbound SMS from the seeded tenant runs the
// app's inbound pipeline → surfaces in the new Inbox (unread) → opening the row lands
// on the contact page where the message is in the timeline → a staff reply goes out
// through the real driver and delivers in the tenant's fake thread.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TASHA = '+15550100001'; // contact-tenant-0001's primary number

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('inbound SMS → new Inbox (unread) → open contact → reply round-trips to the fake', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `Looking for a 2BR ${stamp}`;

  // 1) Tenant texts in through the fake (signed webhook → app /webhooks/twilio/sms).
  await sendAsParty(request, { from: TASHA, body: inbound });

  // 2) It surfaces in the new Inbox as the tenant's row, and shows under Unread.
  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toBeVisible();

  // 3) Opening the row lands on her contact page; the inbound message is in the
  //    timeline (comms live in the contact's context — no parallel thread surface).
  await page.getByRole('tab', { name: 'All' }).click();
  await page.getByRole('link', { name: /Tasha Nguyen/ }).click();
  await expect(page).toHaveURL(/\/contacts\/contact-tenant-0001$/);
  await expect(page.getByText(inbound)).toBeVisible({ timeout: 10_000 });

  // 4) Staff replies from the contact page; it renders in the timeline.
  const reply = `Yes — touring this week? ${stamp}`;
  await page.getByRole('textbox', { name: 'Reply message' }).fill(reply);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(reply)).toBeVisible();

  // 5) PROOF OF SEND: the outbound reply reached the tenant's fake thread and its
  //    delivery status progressed (status callbacks accepted by the app).
  await expect
    .poll(
      async () => {
        const threads = await listThreads(request);
        const t = threads.find((x) => x.partyNumber === TASHA);
        return (
          t?.messages.some(
            (m) => m.direction === 'outbound' && m.body === reply && m.state === 'delivered',
          ) ?? false
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});
