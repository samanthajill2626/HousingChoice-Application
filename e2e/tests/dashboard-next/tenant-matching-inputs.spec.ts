// e2e/tests/dashboard-next/tenant-matching-inputs.spec.ts
//
// WP1 B1 Ranking inputs (spec 2026-10-26 D1, D2; plan S7.1), end to end
// against the real backend: staff see the four tenant matching inputs as
// Eligibility intake rows, fill them in the Edit contact form (a text value is
// trimmed, the portion reads `$1,200 / month`), a fractional portion is refused
// in the form with the server's own copy (PR26: no native min / max, so never
// the browser's words), and a cleared field is REMOVEd from the record.
//
// ISOLATION: one run-unique tenant through the real routes; nothing seeded is
// read or changed, so the lean world stays byte-stable. dashboard-next dialect
// (e2e/support/selectors.md): a local NEXT, a local devLogin, raw page.request
// for setup and server truth, accessibility-first locators with `exact: true`
// for every new label (WI11).
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createTenant } from '../../support/followUpFixtures.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

const BLANK = String.fromCharCode(0x2014); // the dashboard's BLANK, Card.tsx:138

/** The four rows, in list order (dashboard/src/routes/contact/tenantMatchingInputs.ts). */
const MATCHING_LABELS = [
  'Area preference',
  'Maximum tenant portion',
  'Accessibility need',
  'Preferences and constraints',
] as const;

/** tenantMatchingDollarsInvalid('Maximum tenant portion') - the server's copy. */
const PORTION_ERROR = 'Maximum tenant portion must be a whole dollar amount from 0 to 20000.';

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

async function readContact(api: APIRequestContext, contactId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: Record<string, unknown> }).contact;
}

test('tenant matching inputs: staff fill the four fields, a text value is trimmed, a fractional portion is refused, a cleared field is removed', async ({
  page,
}) => {
  test.slow(); // three Edit contact round trips and a reload
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const { contactId } = await createTenant(api, `Matchin${stamp}`);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const intake = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Eligibility intake' }) });
  // A KV row is `<div><span>label</span><span>value</span></div>`: read it
  // through the label span's parent, so the value is checked against ITS label.
  const row = (label: string): Locator => intake.getByText(label, { exact: true }).locator('..');

  // --- 1. Four rows, labeled exactly, each BLANK on a fresh tenant. ---
  for (const label of MATCHING_LABELS) {
    await expect(row(label), label).toHaveText(`${label}${BLANK}`);
  }

  // --- 2. Fill all four in the Edit contact form. ---
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await page.getByRole('button', { name: 'Edit contact details' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Area preference', { exact: true }).fill('  Decatur or East Atlanta  ');
  await dialog.getByLabel('Maximum tenant portion', { exact: true }).fill('1200');
  await dialog.getByLabel('Accessibility need', { exact: true }).fill('Ground floor');
  await dialog.getByLabel('Preferences and constraints', { exact: true }).fill('Needs a yard');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  // --- 3. The rows show the saved values (the portion formatted), and they
  // persist across a reload; the record holds the TRIMMED text. ---
  const filled: Record<(typeof MATCHING_LABELS)[number], string> = {
    'Area preference': 'Decatur or East Atlanta',
    'Maximum tenant portion': '$1,200 / month',
    'Accessibility need': 'Ground floor',
    'Preferences and constraints': 'Needs a yard',
  };
  for (const label of MATCHING_LABELS) {
    await expect(row(label), label).toHaveText(`${label}${filled[label]}`);
  }
  await page.reload();
  for (const label of MATCHING_LABELS) {
    await expect(row(label), `${label} after reload`).toHaveText(`${label}${filled[label]}`);
  }
  const saved = await readContact(api, contactId);
  expect(saved['area_preference']).toBe('Decatur or East Atlanta');
  expect(saved['max_tenant_portion']).toBe(1200);
  expect(saved['accessibility_need']).toBe('Ground floor');
  expect(saved['preferences_constraints']).toBe('Needs a yard');

  // --- 4. A fractional portion: the form refuses it in the server's words and
  // saves nothing. The browser itself accepts the value (step="any", no
  // native min / max - PR26), so the message cannot be the browser's. ---
  await page.getByRole('button', { name: 'Edit contact details' }).click();
  await expect(dialog).toBeVisible();
  const portion = dialog.getByLabel('Maximum tenant portion', { exact: true });
  await expect(portion).toHaveValue('1200');
  await portion.fill('12.5');
  expect(await portion.evaluate((el) => (el as HTMLInputElement).validity.valid)).toBe(true);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: PORTION_ERROR })).toHaveText(PORTION_ERROR);
  await expect(dialog).toBeVisible();
  expect((await readContact(api, contactId))['max_tenant_portion']).toBe(1200);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row('Maximum tenant portion')).toHaveText('Maximum tenant portion$1,200 / month');

  // --- 5. Clear the area preference: saved, the row is BLANK again, and the
  // record no longer carries the key (the server REMOVEs it); the other three
  // stand. ---
  await page.getByRole('button', { name: 'Edit contact details' }).click();
  await expect(dialog).toBeVisible();
  const area = dialog.getByLabel('Area preference', { exact: true });
  await expect(area).toHaveValue('Decatur or East Atlanta');
  await area.fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(row('Area preference')).toHaveText(`Area preference${BLANK}`);
  await expect(row('Maximum tenant portion')).toHaveText('Maximum tenant portion$1,200 / month');
  const cleared = await readContact(api, contactId);
  expect(Object.keys(cleared)).not.toContain('area_preference');
  expect(cleared['max_tenant_portion']).toBe(1200);
  expect(cleared['accessibility_need']).toBe('Ground floor');
  expect(cleared['preferences_constraints']).toBe('Needs a yard');
});
