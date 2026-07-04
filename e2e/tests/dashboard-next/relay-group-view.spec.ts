import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { getOutbox } from '../../fixtures/outbox.js';

// Relay-group conversation view (/conversations/:conversationId) — spec §10.
// Drives the real dashboard + API against the hermetic lane stack and proves the
// group view end-to-end: open from the Inbox AND from a contact's Group-texts
// card, read the transcript, post a team reply and assert the FAN-OUT in the
// fake-phones outbox, manage the roster (add by contact search + by raw phone,
// then remove), and close the group (composer hard-disables).
//
// SEEDING: the live relay group (`conv-live-relay-group`, app/src/lib/seed/live.ts)
// only exists in the FULL profile, but the harness boots + reseeds LEAN. So this
// file reseeds with `?profile=full` in beforeEach (the dev-only seam gained a
// `profile` option; default stays lean so no other spec is affected), then
// restores the lean baseline in afterAll. Sequential workers (workers:1,
// fullyParallel:false) mean no other spec races these reseeds. We deliberately
// use the live group (well-formed roster) — NOT the cast.ts relay fixtures, whose
// bare-id participants never roster-match (they surface only as pool-number rows).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// --- Live seed constants (app/src/lib/seed/live.ts, LIVE_IDS) ----------------
const CONV_ID = 'conv-live-relay-group';
const POOL = '+15550160001';
const DIANA_ID = 'contact-live-tenant-a';
const DIANA_PHONE = '+15550170001'; // Diana Osei (tenant)
const GLORIA_PHONE = '+15550170003'; // Gloria Mensah (landlord)
// Inbox label = "With <all member names>"; contact-card label = "With <others>".
const INBOX_LABEL = 'With Diana Osei & Gloria Mensah';
const CARD_LABEL = 'With Gloria Mensah';

/** Reseed the lane with the FULL profile so the live relay group is present. */
async function reseedFull(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed?profile=full`);
  expect(res.ok(), `full reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Fresh dev-login via the seeded VA (session minted AFTER the reseed, so its
 *  cookie epoch matches the freshly re-seeded users table). */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** The group view's roster list — its aria-label is stable ("Group members"). */
function memberList(page: Page) {
  return page.getByRole('list', { name: 'Group members' });
}

// Reseed full before EACH test so every flow starts from the pristine live group
// (add/remove/close mutate it). ~2s per reseed; workers:1 means no cross-spec race.
test.beforeEach(async ({ request }) => {
  await reseedFull(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not be
// the last to run; a lingering full seed would surprise a later non-reseeding spec).
test.afterAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean restore reseed failed: ${res.status()}`).toBeTruthy();
});

test('Inbox: a relay group appears as a group row and opens the conversation view', async ({
  page,
}) => {
  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // The live relay group renders as a group row (glyph + member-name label +
  // "Group text" chip). Headroom for the feed fetch under full-suite load.
  const row = page.getByRole('link', { name: new RegExp(INBOX_LABEL) });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${CONV_ID}$`));

  // Group view header: identity band + Open status pill.
  await expect(page.getByText('Group text').first()).toBeVisible();
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();
  await expect(page.getByText('Open').first()).toBeVisible();
});

test('Contact Group-texts card: a member row opens the conversation view', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${DIANA_ID}`);

  // Diana's "Group texts" card lists the group by the OTHER member ("With Gloria
  // Mensah"), linking to the conversation view (no longer the owner page).
  const cardRow = page.getByRole('link', { name: new RegExp(CARD_LABEL) });
  await expect(cardRow).toBeVisible({ timeout: 15_000 });

  await cardRow.click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${CONV_ID}$`));
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();
});

test('Team reply fans out to every member on the pool number (headline)', async ({
  page,
  request,
}) => {
  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${CONV_ID}`);
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();

  // A unique body so the outbox assertion is independent of the seed's prior
  // reminder sends and of any concurrent state.
  const token = `relay-fanout-${Date.now()}`;

  const reply = page.getByRole('textbox', { name: 'Reply message' });
  await reply.fill(token);
  await page.getByRole('button', { name: 'Send' }).click();

  // Read the transcript: the sent message renders as a bubble (transcript starts
  // empty — the live group seeds no messages — so this bubble is the known one).
  await expect(page.getByText(token)).toBeVisible({ timeout: 15_000 });

  // Fan-out: exactly one outbound to each non-opted-out member, FROM the pool
  // number, carrying the reply body (the server brand-prefixes it, so match a
  // substring). Poll — the fan-out job runs asynchronously in-process.
  for (const memberPhone of [DIANA_PHONE, GLORIA_PHONE]) {
    await expect
      .poll(
        async () => {
          const msgs = await getOutbox(request, { to: memberPhone });
          return msgs.filter((m) => (m.body ?? '').includes(token) && m.from === POOL).length;
        },
        { timeout: 15_000, message: `fan-out to ${memberPhone} not observed in outbox` },
      )
      .toBe(1);
  }
});

test('Roster: add by contact search + by raw phone, then remove', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${CONV_ID}`);
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();

  const list = memberList(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // --- Add by CONTACT SEARCH (Leon Abara, contact-live-tenant-b) -------------
  await page.getByRole('button', { name: 'Add member' }).click();
  const search = page.getByRole('combobox', { name: 'Add member' });
  await search.fill('Leon');
  await page.getByRole('option', { name: /Leon Abara/ }).click();
  // The picked name still matches its own suggestion, so the listbox stays open
  // and overlays the Add button — dismiss it (Escape) as a user would.
  await search.press('Escape');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('Leon Abara')).toBeVisible();

  // --- Add by RAW PHONE (normalize path; a non-seed number, no suggestions) ---
  await page.getByRole('button', { name: 'Add member' }).click();
  await page.getByRole('combobox', { name: 'Add member' }).fill('4045550199');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(4);

  // --- Remove a member (× → confirm) → roster shrinks ------------------------
  await page.getByRole('button', { name: 'Remove Leon Abara' }).click();
  const removeDialog = page.getByRole('dialog', { name: 'Remove member?' });
  await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('Leon Abara')).toHaveCount(0);
});

test('Close group: the composer hard-disables', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${CONV_ID}`);
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();

  // Sending is available while open.
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  // Close (header action → confirm dialog).
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const closeDialog = page.getByRole('dialog', { name: 'Close group?' });
  await closeDialog.getByRole('button', { name: 'Close group' }).click();

  // Composer disables: the closed hint shows and Send is disabled; the status
  // pill flips to Closed.
  await expect(page.getByText(/This group is closed/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.getByText('Closed').first()).toBeVisible();
});
