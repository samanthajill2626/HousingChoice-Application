// e2e/tests/dashboard-next/contact-notes-conflict.spec.ts
//
// The contact edit form's Notes stale-save guard (WP1 B2a spec D14.3; closes
// contact-edit-form-notes-save-drops-auto-lines), end to end against the real
// backend on the hermetic lane, modeled on tenant-staff-notes.spec.ts's
// stale-save test: two pages on the same tenant, BOTH edit forms opened
// before either saves. The first save lands; the second is refused 409
// notes_stale - the form keeps every typed field, shows the current notes
// beside the box and says nothing was saved - and a deliberate second Save
// then replaces the notes.
//
// The tenant is created run-unique through the API (no seeded record is
// touched). getByLabel is a case-insensitive SUBSTRING match, so First name
// passes `exact: true`. The Notes box is a WRAPPING label whose accessible
// name also holds the box's text, so an exact 'Notes' matches only while the
// box is empty: it is found with /^Notes/ (e2e/support/selectors.md:143).
import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The D14.3 copy's first sentence (the Staff notes card's pattern). */
const CONFLICT = 'These notes were changed since you opened this form.';

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'founder@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

function uniquePhone(): string {
  return `+1555${`${Date.now()}`.slice(-5)}${String(Math.floor(Math.random() * 90) + 10)}`;
}

function editDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: /Edit contact/i });
}

async function openEditForm(page: Page, contactId: string): Promise<Locator> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit contact details' }).click();
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function storedContact(page: Page, contactId: string): Promise<{ notes?: string; firstName?: string }> {
  const res = await page.request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { notes?: string; firstName?: string } }).contact;
}

test('a Notes save from a stale edit form is refused, keeps the typed fields, and saving again replaces the notes', async ({
  page,
  context,
}) => {
  await devLogin(page);
  const s = `${Date.now()}`.slice(-6);
  const firstName = `Notesa${s}`;
  const res = await page.request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName,
      lastName: 'Conflict',
      phone: uniquePhone(),
      status: 'searching',
      // A stamped box (the create stamps notes_updated_at, spec D14.3).
      notes: 'E2E notes - first line',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;

  const other = await context.newPage(); // same browser context = same session
  // Both forms open on the same stamp BEFORE either saves.
  const mine = await openEditForm(page, contactId);
  const theirs = await openEditForm(other, contactId);

  await mine.getByLabel(/^Notes/).fill('E2E mine - typed on the stale form');
  await mine.getByLabel('First name', { exact: true }).fill(`Notesb${s}`);

  // The colleague saves first, and it LANDS before mine is sent: the dialog
  // closes only on a successful save.
  await theirs.getByLabel(/^Notes/).fill('E2E theirs - saved first');
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editDialog(other)).toHaveCount(0);

  // Mine is refused: the panel shows the current notes, says nothing was
  // saved, and every typed field is still in the form.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = mine.getByRole('alert').filter({ hasText: CONFLICT });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('Nothing was saved.');
  await expect(conflict).toContainText('E2E theirs - saved first');
  await expect(mine.getByLabel(/^Notes/)).toHaveValue('E2E mine - typed on the stale form');
  await expect(mine.getByLabel('First name', { exact: true })).toHaveValue(`Notesb${s}`);
  // Nothing of mine reached the server - not the notes, not the name.
  const between = await storedContact(page, contactId);
  expect(between.notes).toBe('E2E theirs - saved first');
  expect(between.firstName).toBe(firstName);

  // A deliberate second Save, now informed, wins (the form re-based its
  // Notes stamp to the current contact).
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editDialog(page)).toHaveCount(0);
  const after = await storedContact(page, contactId);
  expect(after.notes).toBe('E2E mine - typed on the stale form');
  expect(after.firstName).toBe(`Notesb${s}`);
  await other.close();
});
