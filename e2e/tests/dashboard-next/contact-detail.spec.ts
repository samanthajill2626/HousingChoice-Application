import { test, expect, type Page } from '@playwright/test';

// Contact-detail actions (:5174) against the real backend. Proves the hardened
// header + file pane actually FUNCTION end-to-end: the ⋯ menu, the Call menu's
// click-to-dial, the edit-contact round-trip (PATCH → persists across a reload),
// and the Manage-numbers dialog. Targets the seeded tenant (Tasha Nguyen,
// contact-tenant-0001). Mutations use the non-identifying `notes` field and are
// reverted so other specs' name assertions stay valid.
const NEXT = 'http://localhost:5174';
const TENANT = 'contact-tenant-0001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test.describe('Contact detail — header actions + edit', () => {
  test('the ⋯ menu and Call menu open with their actions', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await expect(page.getByText('Tasha Nguyen').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    // The ⋯ menu lists Edit / Copy link / Do-Not-Contact.
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Edit contact details/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Copy link to contact/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Mark Do-Not-Contact/i })).toBeVisible();
    await page.keyboard.press('Escape');

    // The Call menu dials a number from the device + is honest about masking.
    await page.getByRole('button', { name: /Call/i }).click();
    const dial = page.getByRole('menuitem', { name: /555/ }).first();
    await expect(dial).toBeVisible();
    await expect(dial).toHaveAttribute('href', /^tel:\+1555/);
    await expect(page.getByText(/Dials from your device/i)).toBeVisible();
  });

  test('editing a contact PATCHes and persists across a reload', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    const marker = 'E2E edit marker';

    // Open the Details "Edit" affordance, set a note, save.
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    await expect(page.getByRole('dialog', { name: /Edit contact/i })).toBeVisible();
    const notes = page.getByLabel('Notes');
    await notes.fill(marker);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The note now shows in the Preferences card (live, from the returned contact).
    await expect(page.getByText(marker)).toBeVisible();

    // It really persisted to the backend: a full reload refetches and still shows it.
    await page.reload();
    await expect(page.getByText(marker)).toBeVisible();

    // Cleanup — clear the note so the seeded contact is pristine for other specs.
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    await page.getByLabel('Notes').fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(marker)).toHaveCount(0);
  });

  test('housing authority displays (camelCase) and housing-authority + address edits persist', async ({
    page,
  }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    // The seeded housingAuthority now DISPLAYS (was blank under the camel/snake split).
    await expect(page.getByText('atlanta_housing')).toBeVisible();

    // Edit the housing authority + fill a structured address.
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    await page.getByLabel('Housing authority').fill('dekalb_housing');
    await page.getByLabel('Street address').fill('123 Peachtree St');
    await page.getByLabel('City', { exact: true }).fill('Atlanta');
    await page.getByLabel('State', { exact: true }).fill('GA');
    await page.getByLabel('ZIP', { exact: true }).fill('30303');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Persisted across a reload (housingAuthority re-indexes; address is structured).
    await page.reload();
    await expect(page.getByText('dekalb_housing')).toBeVisible();
    await expect(page.getByText(/123 Peachtree St/)).toBeVisible();

    // Cleanup — restore the seeded authority + clear the address.
    await page.getByRole('button', { name: 'Edit contact details' }).click();
    await page.getByLabel('Housing authority').fill('atlanta_housing');
    await page.getByLabel('Street address').fill('');
    await page.getByLabel('City', { exact: true }).fill('');
    await page.getByLabel('State', { exact: true }).fill('');
    await page.getByLabel('ZIP', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('dekalb_housing')).toHaveCount(0);
  });

  test('Manage numbers: add + remove a number round-trips through the backend', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    await page.getByRole('button', { name: /Manage phone numbers/i }).click();
    const dialog = page.getByRole('dialog', { name: /Manage numbers/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Primary')).toBeVisible();

    // Add a throwaway number; it appears in the roster (server returned phones[]).
    await dialog.getByLabel(/New phone number/i).fill('+15550109876');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog.getByText(/\(555\) 010-9876/)).toBeVisible();

    // Remove it again — back to just the primary. (Cleanup keeps the seed pristine.)
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog.getByText(/\(555\) 010-9876/)).toHaveCount(0);
  });

  test('Do-Not-Contact toggles sms_opt_out and back', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    // Mark Do-Not-Contact …
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Mark Do-Not-Contact/i }).click();
    // … the menu now offers to RE-enable (state flipped via the returned contact).
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Allow SMS \(clear opt-out\)/i })).toBeVisible();

    // Revert so the seeded tenant stays messageable for other specs.
    await page.getByRole('menuitem', { name: /Allow SMS \(clear opt-out\)/i }).click();
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Mark Do-Not-Contact/i })).toBeVisible();
  });
});
