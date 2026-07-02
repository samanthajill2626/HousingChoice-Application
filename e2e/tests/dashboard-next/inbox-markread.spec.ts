import { test, expect, type Page } from '@playwright/test';
import { sendAsParty } from '../../fixtures/fakeTwilio.js';

// Inbox unread ↔ contact-page "mark read on view" (the Slack/iMessage model).
// Proves the bug fix end-to-end: viewing a contact's page (while the tab is
// visible) clears its Inbox unread, INCLUDING a reply that arrives while you're
// already looking at the page. Uses the seeded tenant (Tasha, contact-tenant-0001).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TASHA = '+15550100001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('opening a contact page clears its Inbox unread', async ({ page, request }) => {
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `Read-on-open ${stamp}`;
  await sendAsParty(request, { from: TASHA, body: inbound });

  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);
  // She's unread.
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toBeVisible({ timeout: 10_000 });

  // Open her contact page → the message is in the timeline (and the page marks read).
  await page.getByRole('tab', { name: 'All' }).click();
  await page.getByRole('link', { name: /Tasha Nguyen/ }).click();
  await expect(page).toHaveURL(/\/contacts\/contact-tenant-0001$/);
  await expect(page.getByText(inbound)).toBeVisible({ timeout: 10_000 });

  // Back in the Inbox she's no longer Unread — the contact page cleared it live.
  await page.goto(`${NEXT}/inbox`);
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toHaveCount(0);
});

test('a reply that arrives WHILE on the contact page does not re-mark unread', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now()}`.slice(-7);

  // Land on Tasha's contact page first (read).
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

  // A reply arrives while we're looking — it appears live in the timeline.
  const reply = `Reply-while-viewing ${stamp}`;
  await sendAsParty(request, { from: TASHA, body: reply });
  await expect(page.getByText(reply)).toBeVisible({ timeout: 10_000 });

  // The Inbox does NOT show her as unread (the open+visible page marked it read).
  await page.goto(`${NEXT}/inbox`);
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toHaveCount(0);
});
