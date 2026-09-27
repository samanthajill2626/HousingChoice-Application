// Staff notes on the tenant file (Sam's item 22; spec
// docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md 3.6).
// Against the real backend on the hermetic lane: add -> save -> the text and a
// "Last edited" line show -> a reload still shows them -> the AI-appended
// "Preferences & notes" card is byte-identical throughout -> clear (cleanup:
// the box reads as never set again; the server keeps a stamp by design).
// Also proves the card in edit mode does not overflow at 360px.
//
// getByLabel is a case-insensitive SUBSTRING match that also reads aria-label,
// so every label here is `exact: true`: "Edit staff notes" / "Add staff notes"
// would otherwise match "Staff notes".
import { test, expect, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';
import {
  NARROW_360,
  WIDE_RESTORE,
  expectNoHorizontalOverflow,
  expectNoHorizontalOverflowIn,
} from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT = 'contact-tenant-0001'; // Tasha Nguyen (lean seed)

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
});

test.describe('Tenant file - Staff notes card', () => {
  test('add, save, survive a reload, leave Preferences & notes untouched, then clear', async ({ page }) => {
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    const staffCard = page.locator('section', { has: page.getByRole('heading', { name: /Staff notes/ }) });
    const prefsCard = page.locator('section', { has: page.getByRole('heading', { name: /Preferences & notes/ }) });
    await expect(staffCard).toBeVisible();
    await expect(prefsCard).toBeVisible();
    const prefsBefore = await prefsCard.innerText();

    // Empty at seed time.
    await expect(staffCard.getByText('No staff notes yet.')).toBeVisible();
    await expect(staffCard.getByText(/Last edited/)).toHaveCount(0);

    const marker = 'E2E staff note marker';
    await staffCard.getByRole('button', { name: 'Add staff notes', exact: true }).click();
    const box = staffCard.getByLabel('Staff notes', { exact: true });
    await expect(box).toBeVisible();
    await expect(box).toBeFocused();
    // The aside affordance is hidden while editing.
    await expect(staffCard.getByRole('button', { name: /staff notes/i })).toHaveCount(0);
    await box.fill(marker);
    await staffCard.getByRole('button', { name: 'Save', exact: true }).click();

    // Live, from the returned contact.
    await expect(staffCard.getByText(marker)).toBeVisible();
    await expect(staffCard.getByText(/^Last edited [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
    await expect(staffCard.getByLabel('Staff notes', { exact: true })).toHaveCount(0);
    // The AI's card did not move.
    expect(await prefsCard.innerText()).toBe(prefsBefore);

    // Persisted: a full reload refetches and still shows it.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(staffCard.getByText(marker)).toBeVisible();
    await expect(staffCard.getByText(/Last edited/)).toBeVisible();
    expect(await prefsCard.innerText()).toBe(prefsBefore);

    // Narrow: the editor must not push the file pane sideways. At phone width
    // the contact page opens on the Comms pane and the profile pane (the
    // file cards) is display:none until the segmented "View" toggle's
    // "Profile" button is pressed (ContactDetail.tsx, the `pane` state).
    await page.setViewportSize(NARROW_360);
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Profile' }).click();
    await expect(staffCard).toBeVisible();
    await staffCard.getByRole('button', { name: 'Edit staff notes', exact: true }).click();
    await expect(staffCard.getByLabel('Staff notes', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'tenant file with the Staff notes editor open at 360px');
    // The page-level check cannot see this card on its own: the file cards sit
    // in the profile pane, a NESTED scroll container inside <main> that keeps
    // its own overflow, so a too-wide editor would read 0 there. Measure the
    // card's own box (the Card root <section>, overflow visible) as well.
    await expectNoHorizontalOverflowIn(staffCard, 'Staff notes card in edit mode at 360px');
    await staffCard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize(WIDE_RESTORE);

    // Cleanup: clear so the seeded tenant reads pristine for other specs. The
    // server keeps a stamp on a clear (spec 3.1) but the card hides it while
    // the box is empty (spec 3.6).
    await staffCard.getByRole('button', { name: 'Edit staff notes', exact: true }).click();
    await staffCard.getByLabel('Staff notes', { exact: true }).fill('');
    await staffCard.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(staffCard.getByText('No staff notes yet.')).toBeVisible();
    await expect(staffCard.getByText(marker)).toHaveCount(0);
    await expect(staffCard.getByText(/Last edited/)).toHaveCount(0);
  });
});
