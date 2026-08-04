import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { sendAsParty } from '../../fixtures/fakeTwilio.js';

// Deleted-contact resurfacing (2026-08-03 spec) - the end-to-end proof for the
// whole feature. A soft-deleted contact who texts back resurfaces their ORIGINAL
// thread in the inbox (tagged "Deleted") until it is read; the thread is
// read-only until they are restored, and restoring re-enables the reply.
//
// The round-trip this spec drives, in order:
//   0. Pre-delete: Tasha's row IS in the inbox (so step 2 is a real before/after).
//   1. Soft-delete her from the contact page (kebab -> confirm dialog).
//   2. Her row leaves the inbox (on the lean seed the inbox goes empty).
//   3. She texts back -> the SAME thread resurfaces, chipped "Deleted".
//   4. Opening it shows the new message but NO composer - a note offering to
//      restore stands in its place. Seeing before deciding.
//   5. Opening it marked it read -> back in the inbox the row re-hides (the
//      "until read" half of the rule).
//   6. A second text resurfaces it again; restore from the composer note.
//   7. Restored: the composer is back and a reply really sends.
//   8. The inbox row is normal again - visible, no "Deleted" chip.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TASHA = '+15550100001'; // contact-tenant-0001's primary number (a seeded fake persona)

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  // exact: a non-exact name is a case-insensitive SUBSTRING match, and the Today
  // board's "Tours today" group heading would then collide (strict-mode).
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Assert the inbox has finished loading and holds NO Tasha row. On the lean seed
 *  her thread is the ONLY conversation, so "hidden" means the inbox is empty -
 *  anchoring on the loaded empty state first keeps the toHaveCount(0) from passing
 *  vacuously against a still-booting SPA (it would be satisfied by an unrendered
 *  page just as happily as by a correctly hidden row). */
async function expectTashaHidden(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('No conversations yet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toHaveCount(0);
}

// Reseed BEFORE the login (the reseed wipes the users table, so a session minted
// beforehand would carry a stale cookie epoch).
test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects - this file may not run
// last, there is no per-file DB isolation, and roughly a dozen later specs key off
// contact-tenant-0001. A run that ended with Tasha deleted would cascade.
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('deleted contact texts back: resurfaces with Deleted chip, read-only until restore, restore re-enables reply', async ({
  page,
  request,
}) => {
  test.slow(); // eight stages, two inbound webhooks and a real send - triple the budget.
  await devLogin(page);

  // --- 0) Before: her row IS in the inbox, so the disappearance below is a
  //     genuine before/after rather than a locator that never matched. ---
  await page.goto(`${NEXT}/inbox`);
  await expect(page.getByRole('link', { name: /Tasha Nguyen/ })).toBeVisible({ timeout: 10_000 });

  // --- 1) Delete Tasha (kebab menu -> confirm dialog); lands back on Contacts. ---
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete contact' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/contacts$/);

  // --- 2) Her row is gone from the inbox. ---
  await page.goto(`${NEXT}/inbox`);
  await expectTashaHidden(page);

  // --- 3) She texts back in; the thread resurfaces with the Deleted chip. ---
  const stamp = `${Date.now()}`.slice(-7);
  const inbound = `Hey, it's Tasha again ${stamp}`;
  await sendAsParty(request, { from: TASHA, body: inbound });
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // The chip is rendered INSIDE the row's <Link> (InboxRow.tsx, right after the
  // triage chip), which is what makes this scoped lookup valid - if it ever moves
  // out to the sibling actions div this assertion fails loudly.
  await expect(row.getByText('Deleted', { exact: true })).toBeVisible();

  // --- 4) Open it: the message is there, the deleted banner shows, and the whole
  //     composer is replaced by the restore note. Seeing BEFORE restoring. ---
  //     Arm the mark-read waiter BEFORE the click: opening the row fires
  //     POST /api/inbox/contact-tenant-0001/read (optimistically from the row and
  //     again from the contact page on mount), and step 5's navigation could
  //     otherwise abort it in flight and leave the row stubbornly unread.
  const markedRead = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/inbox\/contact-tenant-0001\/read$/.test(r.url()),
    { timeout: 20_000 },
  );
  await row.click();
  await expect(page).toHaveURL(/\/contacts\/contact-tenant-0001$/);
  await expect(page.getByText(inbound)).toBeVisible({ timeout: 10_000 });
  // The composer note - "restore them to reply" appears ONLY there (the deleted
  // BANNER, which predates this feature, does not contain that phrase), so this
  // proves the locked composer specifically.
  await expect(page.getByText(/restore them to reply/i)).toBeVisible();
  // ...and every send affordance is really gone, not merely disabled: no reply
  // box, no Send, and no channel toggle (which would otherwise expose the email
  // composer as a side door).
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Message channel' })).toHaveCount(0);
  await markedRead;

  // --- 5) Opening read the thread -> back in the inbox the row re-hides. ---
  await page.goto(`${NEXT}/inbox`);
  await expectTashaHidden(page);

  // --- 6) A second text resurfaces it; this time restore via the composer note. ---
  const inbound2 = `One more thing ${stamp}`;
  await sendAsParty(request, { from: TASHA, body: inbound2 });
  await page.goto(`${NEXT}/inbox`);
  const row2 = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(row2).toBeVisible({ timeout: 10_000 });
  await expect(row2.getByText('Deleted', { exact: true })).toBeVisible();
  await row2.click();
  await expect(page.getByText(inbound2)).toBeVisible({ timeout: 10_000 });
  // 'Restore contact' (never a bare 'Restore': the header and banner buttons are
  // both named exactly 'Restore', and a non-exact name is a substring match, so
  // 'Restore contact' matches only the composer note's button).
  await page.getByRole('button', { name: 'Restore contact' }).click();

  // --- 7) Restored: the composer returns and a reply really goes out. ---
  const reply = `Welcome back! ${stamp}`;
  const box = page.getByRole('textbox', { name: 'Reply message' });
  await expect(box).toBeVisible({ timeout: 10_000 });
  await box.fill(reply);
  // Send arms once there is a draft AND the timeline has resolved a conversation
  // to send into.
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
  await expect(sendBtn).toBeEnabled({ timeout: 20_000 });
  await sendBtn.click();
  await expect(page.getByText(reply)).toBeVisible({ timeout: 10_000 });

  // --- 8) The inbox row is back to normal - visible, no Deleted chip. ---
  await page.goto(`${NEXT}/inbox`);
  const restoredRow = page.getByRole('link', { name: /Tasha Nguyen/ });
  await expect(restoredRow).toBeVisible({ timeout: 10_000 });
  await expect(restoredRow.getByText('Deleted', { exact: true })).toHaveCount(0);
});
