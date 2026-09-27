// Staff notes on the tenant file (Sam's item 22; spec
// docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md 3.6).
// Against the real backend on the hermetic lane: add -> save -> the text and a
// "Last edited" line show -> a reload still shows them -> the AI-appended
// "Preferences & notes" card is byte-identical throughout -> clear (cleanup:
// the box reads as never set again; the server keeps a stamp by design).
// Also proves the card in edit mode does not overflow at 360px, and (spec 3.9)
// that a save from a stale page is refused with the newer note shown.
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

  // The stale-save guard (spec 3.9), end to end: two staff on the same tenant,
  // both pages loaded BEFORE either saves (nothing refreshes staff notes on an
  // open page). The second Save is refused, shows the first person's note,
  // keeps the typed draft - and a deliberate second Save then wins.
  test('a save from a stale page is refused and shows the newer note; saving again replaces it', async ({
    page,
    context,
  }) => {
    await devLogin(page);
    const other = await context.newPage(); // same browser context = same session
    await page.goto(`${NEXT}/contacts/${TENANT}`);
    await other.goto(`${NEXT}/contacts/${TENANT}`);
    const cardOn = (p: Page) =>
      p.locator('section', { has: p.getByRole('heading', { name: /Staff notes/ }) });
    const mine = cardOn(page);
    const theirs = cardOn(other);
    await expect(mine).toBeVisible();
    await expect(theirs).toBeVisible();

    // Both open their editors on the same (empty) box.
    await mine.getByRole('button', { name: 'Add staff notes', exact: true }).click();
    await mine.getByLabel('Staff notes', { exact: true }).fill('E2E mine - typed on the stale page');
    await theirs.getByRole('button', { name: 'Add staff notes', exact: true }).click();
    await theirs.getByLabel('Staff notes', { exact: true }).fill('E2E theirs - saved first');

    // The colleague saves first; it lands.
    await theirs.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(theirs.getByText('E2E theirs - saved first')).toBeVisible();

    // My save is refused with their note shown and my draft kept.
    await mine.getByRole('button', { name: 'Save', exact: true }).click();
    const conflict = mine.getByRole('alert');
    await expect(conflict).toContainText('Someone else saved these notes while you were editing.');
    await expect(conflict).toContainText('E2E theirs - saved first');
    await expect(mine.getByLabel('Staff notes', { exact: true })).toHaveValue(
      'E2E mine - typed on the stale page',
    );
    // Nothing of mine reached the server: a fresh read still has theirs.
    const between = await page.request.get(`${NEXT}/api/contacts/${TENANT}`);
    expect(((await between.json()) as { contact: { staff_notes?: string } }).contact.staff_notes).toBe(
      'E2E theirs - saved first',
    );

    // A deliberate second Save, now informed, wins.
    await mine.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(mine.getByText('E2E mine - typed on the stale page')).toBeVisible();
    await expect(mine.getByRole('alert')).toHaveCount(0);
    const after = await page.request.get(`${NEXT}/api/contacts/${TENANT}`);
    expect(((await after.json()) as { contact: { staff_notes?: string } }).contact.staff_notes).toBe(
      'E2E mine - typed on the stale page',
    );

    // Cleanup: clear from the current page (its stamp is the newest).
    await mine.getByRole('button', { name: 'Edit staff notes', exact: true }).click();
    await mine.getByLabel('Staff notes', { exact: true }).fill('');
    await mine.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(mine.getByText('No staff notes yet.')).toBeVisible();
    await other.close();
  });
});
