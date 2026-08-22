import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SUNFLOWER = 'rgb(244, 197, 66)';
const NAV_FOCUS_BLUE = 'rgb(23, 78, 166)';
const WHITE = 'rgb(255, 255, 255)';

function pathname(url: string): string {
  return new URL(url).pathname;
}

async function expectSunflowerTheme(page: Page): Promise<void> {
  const themeMeta = page.locator('meta[name="theme-color"]');
  await expect(themeMeta).toHaveCount(1);
  await expect(themeMeta).toHaveAttribute('content', '#f4c542');
}

async function expectNoEnvironmentCopy(page: Page): Promise<void> {
  await expect(page.getByText(/^(DEV|LOCAL|environment)$/i)).toHaveCount(0);
  await expect(page.getByRole('banner', { name: /environment/i })).toHaveCount(0);
}

async function expectPublicIdentity(
  browser: Browser,
  route: '/join' | '/p/missing-unit',
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const identityRequests: string[] = [];
    const authRequests: string[] = [];

    page.on('request', (request) => {
      const path = pathname(request.url());
      if (path === '/app-identity/config.json') identityRequests.push(path);
      if (path === '/auth/me') authRequests.push(path);
    });

    await page.goto(`${NEXT}${route}`);
    if (route === '/join') {
      await expect(page.getByRole('heading', { name: /Find your next home/i })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    }
    await expectSunflowerTheme(page);
    await page.waitForLoadState('networkidle');
    expect(identityRequests).toHaveLength(1);
    expect(authRequests).toHaveLength(0);
    await expectNoEnvironmentCopy(page);
  } finally {
    await context.close();
  }
}

async function focusByKeyboard(page: Page, target: Locator, maxTabs = 24): Promise<void> {
  for (let index = 0; index <= maxTabs; index += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

async function expectNavFocus(page: Page, target: Locator): Promise<void> {
  await focusByKeyboard(page, target);
  await expect(target).toBeFocused();
  expect(await target.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
  await expect(target).toHaveCSS('outline-color', NAV_FOCUS_BLUE);
}

test('anonymous and public pages use one runtime identity without widening auth', async ({
  browser,
  page,
}) => {
  test.slow();
  const identityRequests: string[] = [];
  const identityStatuses: number[] = [];
  const authRequests: string[] = [];
  const authStatuses: number[] = [];

  page.on('request', (request) => {
    const path = pathname(request.url());
    if (path === '/app-identity/config.json') identityRequests.push(path);
    if (path === '/auth/me') authRequests.push(path);
  });
  page.on('response', (response) => {
    const path = pathname(response.url());
    if (path === '/app-identity/config.json') identityStatuses.push(response.status());
    if (path === '/auth/me') authStatuses.push(response.status());
  });

  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('link', { name: /Sign in with Google/i })).toBeVisible();
  await expectSunflowerTheme(page);
  expect(identityRequests).toHaveLength(1);
  expect(identityStatuses).toEqual([200]);
  expect(authRequests.length).toBeGreaterThanOrEqual(1);
  expect(authStatuses).toContain(401);
  await expectNoEnvironmentCopy(page);

  await expectPublicIdentity(browser, '/join');
  await expectPublicIdentity(browser, '/p/missing-unit');

  const manifestResponse = await page.request.get(
    `${NEXT}/app-identity/manifest.webmanifest`,
  );
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
  expect(manifestResponse.headers()['cache-control']).toBe('no-cache');
  const manifest = (await manifestResponse.json()) as {
    theme_color: unknown;
    icons: Array<{ src: unknown }>;
  };
  expect(manifest.theme_color).toBe('#f4c542');
  expect(manifest.icons.map(({ src }) => src)).toEqual([
    '/app-identity/icon-192.png',
    '/app-identity/icon-512.png',
    '/app-identity/icon-maskable-512.png',
  ]);

  const selectors = [
    ['/app-identity/icon-192.png', '/icons/icon-nonprod-192.png'],
    ['/app-identity/icon-512.png', '/icons/icon-nonprod-512.png'],
    ['/app-identity/icon-maskable-512.png', '/icons/icon-nonprod-maskable-512.png'],
  ] as const;
  for (const [selector, destination] of selectors) {
    const response = await page.request.get(`${NEXT}${selector}`, { maxRedirects: 0 });
    expect(response.status(), selector).toBe(307);
    expect(response.headers()['cache-control'], selector).toBe('no-store');
    expect(response.headers()['location'], selector).toBe(destination);
  }
});

test('authenticated responsive navigation keeps the non-production visual contract', async ({
  page,
}) => {
  test.slow();
  await page.goto(`${NEXT}/`);
  await page
    .getByRole('button', { name: 'Continue as dev user (seeded VA)', exact: true })
    .click();
  await expectTodayReady(page);
  await expectSunflowerTheme(page);

  const desktopAside = page.locator('aside[aria-label="Primary"]:visible');
  await expect(desktopAside).toHaveCSS('background-color', SUNFLOWER);
  const brand = desktopAside.getByRole('link', {
    name: 'HousingChoice home',
    exact: true,
  });
  const collapse = desktopAside.getByRole('button', {
    name: 'Collapse navigation',
    exact: true,
  });
  const workspace = desktopAside.getByRole('navigation', { name: 'Workspace', exact: true });
  const today = workspace.getByRole('link', { name: 'Today', exact: true });
  const tenants = workspace.getByRole('link', { name: 'Tenants', exact: true });
  const account = desktopAside.getByRole('button', { name: 'Account menu', exact: true });

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expectNavFocus(page, brand);
  await expectNavFocus(page, collapse);
  await expectNavFocus(page, today);
  await expectNavFocus(page, tenants);
  await expectNavFocus(page, account);

  await collapse.click();
  await expect(
    desktopAside.getByRole('button', { name: 'Expand navigation', exact: true }),
  ).toBeVisible();

  await today.hover();
  const todayTooltip = today.getByText('Today', { exact: true });
  await expect(todayTooltip).toBeVisible();
  await expect(todayTooltip).toHaveCSS('background-color', WHITE);

  const contacts = workspace.getByRole('link', { name: 'Contacts', exact: true });
  await contacts.hover();
  await expect(tenants).toBeVisible();
  await expect(tenants.locator('..')).toHaveCSS('background-color', SUNFLOWER);

  await account.click();
  const accountMenu = page.getByRole('menu');
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu).toHaveCSS('background-color', WHITE);
  await account.click();
  await expect(accountMenu).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  const openNavigation = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
  });
  await expect(openNavigation).toBeVisible();
  await expect(openNavigation.locator('..')).toHaveCSS('background-color', WHITE);

  await openNavigation.click();
  const drawer = page.locator('aside[aria-label="Primary"]:visible');
  await expect(drawer).toHaveCSS('background-color', SUNFLOWER);
  const closeNavigation = drawer.getByRole('button', {
    name: 'Close navigation',
    exact: true,
  });
  await page.keyboard.press('Tab');
  await expect(closeNavigation).toBeFocused();
  expect(await closeNavigation.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
  await expect(closeNavigation).toHaveCSS('outline-color', NAV_FOCUS_BLUE);

  const drawerTenants = drawer
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('link', { name: 'Tenants', exact: true });
  await expect(drawerTenants).toBeVisible();
  await drawerTenants.click();
  await expect(page).toHaveURL(/\/contacts\/tenants$/);
  await expect(page.getByRole('heading', { name: 'Tenants', exact: true })).toBeVisible();
  await expect(drawer).toBeHidden();
});
