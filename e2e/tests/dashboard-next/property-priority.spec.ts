// e2e/tests/dashboard-next/property-priority.spec.ts
//
// WP1 B1 Ranking inputs (spec 2026-10-26 D6; plan S7.3), end to end against
// the real backend: the staff Priority switch on a property. Checked on the
// New property form it saves `priority: true`, and the property page shows a
// "Priority" row reading Yes in Property details and a "Priority" pill beside
// the status in the page header. Priority is never on the public flyer
// (WI12): published while it is ON, the flyer JSON carries no `priority` key
// and the flyer page shows no "Priority" text. Unchecked on the Edit form it
// saves `false` (PR28: off is stored as false), the row reads No and the pill
// is gone.
//
// ISOLATION: a run-unique landlord and property through the real routes and
// forms; nothing seeded is read or changed, so the lean world stays
// byte-stable. dashboard-next dialect (e2e/support/selectors.md): a local NEXT,
// a local devLogin, raw page.request for setup and server truth,
// accessibility-first locators. The helpers are copied from
// property-requirements.spec.ts (spec files are file-local by design).
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

interface Landlord {
  contactId: string;
  /** The display name the dashboard shows: "First Last". */
  name: string;
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

async function createLandlord(api: APIRequestContext, firstName: string): Promise<Landlord> {
  const lastName = 'Prilandlord';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'landlord', firstName, lastName, phone: uniquePhone() },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, name: `${firstName} ${lastName}` };
}

async function getUnit(api: APIRequestContext, unitId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: Record<string, unknown> }).unit;
}

/** Setup -> Available through the transition route (status is not a CRUD field). */
async function publish(api: APIRequestContext, unitId: string): Promise<void> {
  const res = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/**
 * "+ Add a property" on the landlord page opens the New property form locked to
 * that landlord. `edit` runs on the open form; then fill the address and
 * Create. The app lands on /listings/<unitId>, whose id is returned.
 */
async function addPropertyFromLandlordPage(
  page: Page,
  landlord: Landlord,
  line1: string,
  opts: { edit?: (dialog: Locator) => Promise<void> } = {},
): Promise<string> {
  await page.goto(`${NEXT}/contacts/${landlord.contactId}`);
  await page.getByRole('button', { name: 'Add a property for this landlord' }).click();
  const dialog = page.getByRole('dialog', { name: 'New property' });
  await expect(dialog).toBeVisible();
  if (opts.edit !== undefined) await opts.edit(dialog);
  await dialog.getByLabel('Street address', { exact: true }).fill(line1);
  await dialog.getByLabel('City', { exact: true }).fill('Atlanta');
  await dialog.getByLabel('State', { exact: true }).fill('GA');
  await dialog.getByLabel('ZIP', { exact: true }).fill('30314');
  await dialog.getByRole('button', { name: /^Create$/ }).click();
  await page.waitForURL(/\/listings\/[^/?#]+$/);
  const match = /\/listings\/([^/?#]+)/.exec(page.url());
  if (match === null || match[1] === undefined) throw new Error('expected a /listings/:id URL after Create');
  return decodeURIComponent(match[1]);
}

/** The Property details card's Priority row, read through its label span's
 *  parent (the KV `<div>`), so `PriorityYes` / `PriorityNo` is that row alone. */
function priorityRow(page: Page): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Property details' }) })
    .getByText('Priority', { exact: true })
    .locator('..');
}

/** The header pill: an EXACT "Priority" inside the page's own `<header>` (the
 *  one holding the street-line h1), never the Property details row. */
function priorityPill(page: Page, line1: string): Locator {
  return page
    .locator('header')
    .filter({ has: page.getByRole('heading', { level: 1, name: line1 }) })
    .getByText('Priority', { exact: true });
}

test('Priority: checked on the New form shows the row and the pill, never reaches the flyer, and unchecked on Edit reads No', async ({
  page,
}) => {
  test.slow(); // a New property form, a publish, the flyer, an Edit form and several page loads
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const landlord = await createLandlord(api, `Prio${stamp}`);
  // No "Priority" in the street line: the flyer's h1 and the property page's
  // h1 both carry it, and a substring match would find the address.
  const line1 = `${stamp} Pswitch Ave`;

  // --- 1. New property form: Priority starts off, tagged Staff only; check it. ---
  const unitId = await addPropertyFromLandlordPage(page, landlord, line1, {
    edit: async (dialog) => {
      const priority = dialog.getByRole('checkbox', { name: 'Priority', exact: true });
      await expect(priority).not.toBeChecked();
      await expect(priority).toHaveAccessibleDescription(/Staff only/);
      await priority.check();
      await expect(priority).toBeChecked();
    },
  });

  // --- 2. The property page: the row reads Yes and the pill is in the header. ---
  await expect(priorityRow(page)).toHaveText('PriorityYes');
  await expect(priorityPill(page, line1)).toBeVisible();
  expect((await getUnit(api, unitId))['priority']).toBe(true);

  // --- 3. WI12, while Priority is ON: publish (the flyer serves every status
  // but Setup, where a new property starts; Available is the plain case), then
  // neither the flyer JSON nor the flyer page carries it. The h1 is the
  // positive control on that load, before the absence. ---
  await publish(api, unitId);
  const flyerRes = await api.get(`${NEXT}/public/units/${unitId}/flyer`);
  expect(flyerRes.status(), await flyerRes.text()).toBe(200);
  const { flyer } = (await flyerRes.json()) as { flyer: Record<string, unknown> };
  expect(Object.keys(flyer)).not.toContain('priority');
  await page.goto(`${NEXT}/p/${unitId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(line1);
  await expect(page.getByText('Priority')).toHaveCount(0);

  // --- 4. Back on the property page: Edit, uncheck, Save. ---
  await page.goto(`${NEXT}/listings/${unitId}`);
  await expect(priorityRow(page)).toHaveText('PriorityYes');
  await expect(priorityPill(page, line1)).toBeVisible();
  await page.getByRole('button', { name: 'Edit property details', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit property' });
  await expect(edit).toBeVisible();
  const priority = edit.getByRole('checkbox', { name: 'Priority', exact: true });
  await expect(priority).toBeChecked();
  await expect(priority).toHaveAccessibleDescription(/Staff only/);
  await priority.uncheck();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toHaveCount(0, { timeout: 15_000 });

  // --- 5. The row reads No (the positive control) and the pill is gone; the
  // record holds `false`, and both survive a reload. ---
  await expect(priorityRow(page)).toHaveText('PriorityNo');
  await expect(priorityPill(page, line1)).toHaveCount(0);
  expect((await getUnit(api, unitId))['priority']).toBe(false);
  await page.reload();
  await expect(priorityRow(page)).toHaveText('PriorityNo');
  await expect(priorityPill(page, line1)).toHaveCount(0);
});
