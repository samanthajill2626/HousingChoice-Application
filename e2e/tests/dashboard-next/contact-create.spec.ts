import { test, expect, type Page } from '@playwright/test';

// Extensible contact creation (:5174) against the real backend. Proves the
// "New contact" flow end-to-end: the unified Kind picker's Other→base-type
// guided path, free-text relationships + custom fields, the role badge + display
// cards on the contact page (persisting across a reload), AND the 409 "that
// number already belongs to <name>" ask that does NOT auto-navigate.
//
// Self-contained: the custom kind/label carry a per-run timestamp so repeated
// runs never collide; the 409 case reuses the seeded tenant's number and must
// NOT create a duplicate.
const NEXT = 'http://localhost:5174';
const SEEDED_TENANT = 'contact-tenant-0001'; // Tasha Nguyen, phone +15550100001
const SEEDED_TENANT_PHONE = '+15550100001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test.describe('Extensible contact creation', () => {
  test('creates a custom "Case worker" kind with a relationship + custom field', async ({
    page,
  }) => {
    const stamp = Date.now();
    const role = `Case worker ${stamp}`;
    const relRole = 'Client';
    const relName = 'Tasha N (text)';
    const fieldLabel = `Agency ${stamp}`;
    const fieldValue = 'Atlanta Housing';

    await devLogin(page);
    await page.goto(`${NEXT}/contacts`);

    // Open the create dialog.
    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: /New contact/i });
    await expect(dialog).toBeVisible();

    // Kind picker → Other → role text → base type Tenant.
    await dialog.getByRole('group', { name: 'Contact kind' }).getByRole('button', { name: 'Other' }).click();
    await dialog.getByLabel('Role').fill(role);
    await dialog
      .getByRole('group', { name: 'Base contact type' })
      .getByRole('button', { name: 'Tenant' })
      .click();

    // Standard fields (phone left blank — optional, avoids any seeded collision).
    await dialog.getByLabel('First name').fill('Cory');
    await dialog.getByLabel('Last name').fill('Worker');

    // Reveal + fill a free-text relationship (no candidate pick → text only).
    await dialog.getByRole('button', { name: '+ Add relationship' }).click();
    await dialog.getByLabel('Relationship role 1').fill(relRole);
    await dialog.getByLabel('Contact search 1').fill(relName);

    // Reveal + fill a custom field.
    await dialog.getByRole('button', { name: '+ Add custom field' }).click();
    await dialog.getByLabel('Field label 1').fill(fieldLabel);
    await dialog.getByLabel('Field value 1').fill(fieldValue);

    // Create → navigates to the new contact page.
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/contacts\/[A-Za-z0-9_-]+$/);

    // The role badge (role ?? type) + the two cards render.
    await expect(page.getByText(role).first()).toBeVisible();
    await expect(page.getByText(relRole)).toBeVisible();
    await expect(page.getByText(relName)).toBeVisible();
    await expect(page.getByText(fieldLabel)).toBeVisible();
    await expect(page.getByText(fieldValue)).toBeVisible();

    // It persisted to the backend: a full reload refetches and still shows it.
    await page.reload();
    await expect(page.getByText(role).first()).toBeVisible();
    await expect(page.getByText(relName)).toBeVisible();
    await expect(page.getByText(fieldValue)).toBeVisible();
  });

  test('a phone already in use shows the conflict ask without auto-navigating', async ({
    page,
  }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts`);

    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: /New contact/i });
    await expect(dialog).toBeVisible();

    // A standard Tenant whose phone already belongs to the seeded tenant.
    await dialog.getByRole('group', { name: 'Contact kind' }).getByRole('button', { name: 'Tenant' }).click();
    await dialog.getByLabel('First name').fill('Dup');
    await dialog.getByLabel('Phone').fill(SEEDED_TENANT_PHONE);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    // The dialog STAYS OPEN with the conflict ask naming the existing contact —
    // and we did NOT navigate (no auto-nav).
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/already belongs to/i)).toBeVisible();
    await expect(dialog.getByText(/Tasha Nguyen/)).toBeVisible();
    await expect(page).toHaveURL(/\/contacts$/);

    // Only on clicking "Open their page" do we navigate to the existing contact.
    await dialog.getByRole('button', { name: /Open their page/i }).click();
    await expect(page).toHaveURL(new RegExp(`/contacts/${SEEDED_TENANT}$`));
    await expect(page.getByText('Tasha Nguyen').first()).toBeVisible();
  });
});
