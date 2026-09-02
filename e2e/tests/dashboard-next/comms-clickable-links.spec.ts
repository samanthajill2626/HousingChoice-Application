import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const CONVERSATION_ID = 'conv-0001';
const CONTACT_ID = 'contact-tenant-0001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

async function plantMessage(request: APIRequestContext, body: string): Promise<void> {
  const response = await request.post(`${NEXT}/__dev/extraction/message-fixture`, {
    data: {
      conversationId: CONVERSATION_ID,
      body,
      createdAt: new Date().toISOString(),
      direction: 'inbound',
      transport: { mode: 'legacy' },
    },
  });
  expect(
    response.ok(),
    `message fixture failed: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
}

test('communications body links are safe, complete, and do not toggle bubble metadata', async ({
  context,
  page,
  request,
}) => {
  const reseed = await request.post(`${NEXT}/__dev/reseed`);
  expect(reseed.ok(), `reseed failed: ${reseed.status()} ${await reseed.text()}`).toBeTruthy();

  const explicitText = 'https://example.com/explicit?x=1#top';
  const bareText = 'example.com/bare/path?unit=2#photos';
  const body = `Open ${explicitText}, then (${bareText}).`;
  await plantMessage(request, body);

  await context.route('https://example.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>Hermetic target</title>',
    });
  });
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${CONTACT_ID}`);

  const explicit = page.getByRole('link', { name: explicitText, exact: true });
  const bare = page.getByRole('link', { name: bareText, exact: true });
  await expect(explicit).toBeVisible({ timeout: 15_000 });
  await expect(bare).toBeVisible();
  await expect(explicit).toHaveAttribute('href', explicitText);
  await expect(bare).toHaveAttribute('href', `https://${bareText}`);
  await expect(explicit).toHaveAttribute('target', '_blank');
  await expect(bare).toHaveAttribute('target', '_blank');
  await expect(explicit).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(bare).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByRole('link', { name: `${explicitText},`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `(${bareText})`, exact: true })).toHaveCount(0);

  const bubble = explicit.locator('xpath=ancestor::*[contains(@class, "bubble")][1]');
  await expect(bubble).toContainText(body);
  await expect(bubble).not.toHaveClass(/\brevealed\b/);

  const [popup] = await Promise.all([page.waitForEvent('popup'), explicit.click()]);
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup).toHaveURL(explicitText);
  await popup.close();

  await expect(page).toHaveURL(new RegExp(`/contacts/${CONTACT_ID}$`));
  await expect(bubble).not.toHaveClass(/\brevealed\b/);
});
