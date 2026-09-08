import { expect, test } from '@playwright/test';
import { readMaintenanceCopy, renderMaintenancePage } from '../../support/maintenancePage.js';
import { dashboardUrl } from '../../support/urls.js';
import { expectNoHorizontalOverflow } from '../../support/viewport.js';

const parsedDashboardUrl = new URL(dashboardUrl);
if (!process.env['E2E_LANE'] || !process.env['E2E_DASHBOARD_URL'] ||
    parsedDashboardUrl.hostname !== '127.0.0.1' || ['5174', '8080'].includes(parsedDashboardUrl.port)) {
  throw new Error('Maintenance browser tests require the hermetic e2e workspace lane');
}

test.describe('CloudFront maintenance document', () => {
  let html: string;

  test.beforeAll(() => {
    html = renderMaintenancePage();
  });

  for (const status of [502, 504]) {
    for (const method of ['GET', 'POST'] as const) {
      for (const width of [320, 1280]) {
        test(`${status} ${method} recovers with GET home at width ${width}`, async ({ page }) => {
          await page.setViewportSize({ width, height: 800 });
          const copy = readMaintenanceCopy();
          const failedUrl = `${dashboardUrl}/__maintenance-proof?original=must-not-replay`;
          const startUrl = `${dashboardUrl}/__maintenance-form`;
          const failures: { method: string; body: string | null }[] = [];
          const dependencies: string[] = [];

          page.on('request', (request) => {
            if (['script', 'stylesheet', 'font', 'image'].includes(request.resourceType())) {
              dependencies.push(request.url());
            }
          });

          // This exact test-owned fulfillment proves local browser behavior only.
          // It does not emulate or prove hosted CloudFront error substitution.
          await page.route(failedUrl, async (route) => {
            failures.push({ method: route.request().method(), body: route.request().postData() });
            await route.fulfill({
              status,
              contentType: 'text/html; charset=utf-8',
              headers: { 'cache-control': 'no-store, max-age=0' },
              body: html,
            });
          });

          if (method === 'GET') {
            const response = await page.goto(failedUrl);
            expect(response?.status()).toBe(status);
          } else {
            await page.route(startUrl, (route) => route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><form method="post" action="/__maintenance-proof?original=must-not-replay">' +
                '<input type="hidden" name="submission" value="once"><button>Submit test form</button></form>',
            }));
            await page.goto(startUrl);
            const response = page.waitForResponse((item) =>
              item.url() === failedUrl && item.request().method() === 'POST');
            await page.getByRole('button', { name: 'Submit test form' }).click();
            expect((await response).status()).toBe(status);
          }

          await expect(page.getByRole('main')).toHaveAttribute('data-hc-maintenance', '1');
          await expect(page.getByText(copy.brand, { exact: true })).toBeVisible();
          await expect(page.getByRole('heading', { name: copy.heading, exact: true })).toBeVisible();
          await expect(page.getByText(copy.body, { exact: true })).toBeVisible();
          await expect(page).toHaveTitle(copy.title);
          const action = page.getByRole('link', { name: copy.action, exact: true });
          await expect(action).toHaveAttribute('href', '/');
          await expect(action).toBeVisible();
          await expectNoHorizontalOverflow(page, `maintenance document at ${width}`);

          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
          });
          await expect(action).toBeVisible();
          await expectNoHorizontalOverflow(page, `maintenance document with enlarged text at ${width}`);
          expect(dependencies).toEqual([]);
          expect(failures).toEqual([{
            method, body: method === 'POST' ? 'submission=once' : null,
          }]);

          await page.keyboard.press('Tab');
          await expect(action).toBeFocused();
          expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
          const homeResponse = page.waitForResponse((response) =>
            response.request().isNavigationRequest() && response.url() === `${dashboardUrl}/`);
          await page.keyboard.press('Enter');
          const healthy = await homeResponse;
          expect(healthy.status()).toBe(200);
          expect(healthy.request().method()).toBe('GET');
          expect(healthy.request().postData()).toBeNull();
          expect(new URL(healthy.url()).search).toBe('');
          await expect(page.getByRole('link', { name: 'Sign in with Google', exact: true })).toBeVisible();
          await expect(page.locator('[data-hc-maintenance]')).toHaveCount(0);
          expect(failures).toHaveLength(1);
        });
      }
    }
  }
});
