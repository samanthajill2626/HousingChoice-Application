import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { getOutboundTo } from '../../fixtures/fakeTwilio.js';
// The final "group is closed" copy (single source of truth) - close now sends it.
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';
import { expectTodayReady } from '../../support/today.js';

// Relay-group conversation view (/conversations/:conversationId) — spec §10.
// Drives the real dashboard + API against the hermetic lane stack and proves the
// group view end-to-end: open from the Inbox AND from a contact's Relay-groups
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
// The close route sends this to every member (the send may brand-prefix it).
const CLOSED_COPY = MESSAGE_CATALOG['relay.group_closed'].default;

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
  await expectTodayReady(page);
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
  // "Relay group" chip). Headroom for the feed fetch under full-suite load.
  const row = page.getByRole('link', { name: new RegExp(INBOX_LABEL) });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${CONV_ID}$`));

  // Group view header: identity band + Open status pill.
  await expect(page.getByText('Relay group').first()).toBeVisible();
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();
  await expect(page.getByText('Open').first()).toBeVisible();
});

test('Contact Relay-groups card: a member row opens the conversation view', async ({ page }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${DIANA_ID}`);

  // Diana's "Relay groups" card lists the group by the OTHER member ("With Gloria
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
          const msgs = await getOutboundTo(request, { to: memberPhone });
          return msgs.filter((m) => (m.body ?? '').includes(token) && m.from === POOL).length;
        },
        { timeout: 15_000, message: `fan-out to ${memberPhone} not observed in the thread store` },
      )
      .toBe(1);
  }
});

test('Roster: add by contact search + by raw phone, then remove', async ({ page, request }) => {
  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${CONV_ID}`);
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();

  const list = memberList(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // --- Add by CONTACT SEARCH (Leon Abara, contact-live-tenant-b) -------------
  await page.getByRole('button', { name: 'Add member' }).click();
  const search = page.getByRole('combobox', { name: 'Add member' });
  await search.fill('Leon');
  // Picking COMMITS the field (committed-selection typeahead): the listbox
  // hides itself and the input goes read-only until cleared.
  await page.getByRole('option', { name: /Leon Abara/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('Leon Abara')).toBeVisible();
  // The join is ANNOUNCED in the thread - but since Phase B (spec 9.6, Cameron
  // 2026-08-31) the ONE persisted row carries the NEW MEMBER's copy, which is
  // the naked intro naming the post-add roster, NOT the group's "Hey, adding
  // Leon to the group." line. That group line goes out to the existing members
  // and is deliberately not shown here; it is asserted on Diana's outbox below.
  // FIRST names only (founder decision 2026-08-20), so "Leon", not "Leon Abara".
  await expect(
    page.getByText(/You're now connected with Diana, Gloria, and Leon/),
  ).toBeVisible({ timeout: 15_000 });
  // The group half, on an EXISTING member's real outbox.
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: DIANA_PHONE })).some(
          (m) => (m.body ?? '') === 'Hey, adding Leon to the group.',
        ),
      { timeout: 15_000, message: 'the group-side join line never reached Diana' },
    )
    .toBe(true);

  // --- Add by RAW PHONE (normalize path; a non-seed number, no suggestions) ---
  await page.getByRole('button', { name: 'Add member' }).click();
  await page.getByRole('combobox', { name: 'Add member' }).fill('4045550199');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(4);
  // A phone-only member has no name - the group line uses the neutral label,
  // lower-cased since Phase B because it now sits MID-sentence. THE ONLY
  // nameless-joiner coverage in the suite: never delete it. It moved to the
  // OUTBOX because the thread bubble is now the new member's naked intro, which
  // names only the members it can name and so says nothing about the joiner.
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: DIANA_PHONE })).some(
          (m) => (m.body ?? '') === 'Hey, adding a new member to the group.',
        ),
      { timeout: 15_000, message: 'the nameless join line never reached Diana' },
    )
    .toBe(true);
  // Two adds, so TWO naked-intro bubbles now - both name the same three known
  // members (the joiner has no name to add to the list).
  await expect(page.getByText(/You're now connected with Diana, Gloria, and Leon/)).toHaveCount(
    2,
    { timeout: 15_000 },
  );

  // --- Remove a member (× → confirm) → roster shrinks ------------------------
  await page.getByRole('button', { name: 'Remove Leon Abara' }).click();
  const removeDialog = page.getByRole('dialog', { name: 'Remove member?' });
  await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('Leon Abara')).toHaveCount(0);
});

test('Close group: final message sent to both, number kept, composer hard-disables', async ({
  page,
  request,
}) => {
  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${CONV_ID}`);
  await expect(page.getByText(INBOX_LABEL)).toBeVisible();

  // Sending is available while open.
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  // Close (header action -> confirm dialog). Baseline the proof-of-send clock
  // FIRST: the thread store is cleared once per suite (preflight), not per
  // reseed, so an unscoped absence read here would span the whole run - any
  // earlier spec sending CLOSED_COPY to these FIXED seeded numbers would fail
  // this test for a reason unrelated to close.
  const t0 = new Date().toISOString();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const closeDialog = page.getByRole('dialog', { name: 'Close group?' });
  await closeDialog.getByRole('button', { name: 'Close group' }).click();

  // Composer disables: the closed hint shows and Send is disabled; the status
  // pill flips to Closed.
  await expect(page.getByText(/This group is closed/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.getByText('Closed').first()).toBeVisible();

  // FOUNDER DECISION 2026-08-18: closing no longer texts anyone. The template,
  // the copy and the announcement plumbing are all still in place (the message is
  // expected back), but RELAY_CLOSE_ANNOUNCEMENT_ENABLED is off, so NO member
  // receives a final note. Everything else about close still has to work, which
  // the assertions above and below cover.
  //
  // Asserted against the same UI settle points used above, so this is not a
  // vacuous "nothing arrived yet" check: by the time the Closed pill renders the
  // close request has completed server-side.
  for (const memberPhone of [DIANA_PHONE, GLORIA_PHONE]) {
    const msgs = await getOutboundTo(request, { to: memberPhone, since: t0 });
    expect(
      msgs.some((m) => (m.body ?? '').includes(CLOSED_COPY)),
      `no close message should reach ${memberPhone}`,
    ).toBe(false);
  }

  // The pool number is KEPT on the closed conversation (never released now).
  // Authenticated /api call rides the page's dev-login session (page.request).
  const res = await page.request.get(`${NEXT}/api/conversations/${CONV_ID}`);
  expect(res.ok(), `conversation fetch failed: ${res.status()}`).toBeTruthy();
  const { conversation } = (await res.json()) as {
    conversation: { status?: string; pool_number?: string };
  };
  expect(conversation.status).toBe('closed');
  expect(conversation.pool_number).toBe(POOL);
});
