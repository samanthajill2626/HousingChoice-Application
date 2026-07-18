import { test, expect, type Page } from '@playwright/test';

// Settings > Group text numbers (:5174) - the admin-only, READ-ONLY pool-number
// inventory (spec docs/superpowers/specs/2026-07-18-pool-numbers-admin-design.md
// section 7). Proves the role-aware surface end-to-end against the real backend:
//   - ADMIN: create a relay group via POST /api/relay-groups (mints a pool
//     number); /settings/numbers shows that number's row (formatted display,
//     State "active", an open group, retirement "-" because an open group is not
//     retirement-eligible); expanding the row reveals the group row, which links
//     to its conversation thread; following the link lands on the group view.
//     The "Group text numbers" tab is visible for an admin.
//   - VA/default: the tab is absent and a direct nav to /settings/numbers is
//     route-guarded (AdminRoute) - it bounces to /settings/templates and the
//     numbers heading/table never render.
// The lean profile the harness boots seeds ZERO pool numbers, so the created
// group's number is matched directly (no reseed); the number is MINTED
// dynamically (+1555019XXXX) and captured from the create response - never
// hardcoded. Read-only feature: this spec asserts no mutation UI.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** Dev-login as a specific persona (founder@example.com -> admin, va@example.com ->
 *  va, per app/src/routes/dev.ts) by driving the dev-login endpoint directly, then
 *  loading the app so the page picks up the freshly-set session cookie. The DEFAULT
 *  dev-login and the "Continue as dev user" button are BOTH va@example.com (VA), so
 *  the admin path must call this with founder@example.com, never the button. */
async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

// --- Per-run-unique phones (relay-number-lifecycle.spec.ts idiom) -------------
// +1 555 8XX XXXX: the "8" exchange never collides with the fake's minted pool
// numbers (+1555019xxxx) or the seeded rosters. The last-4 of the wall clock plus
// an incrementing counter keep every number unique across the run.
let uid = 0;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

interface CreatedGroup {
  conversationId: string;
  pool_number: string;
}

/** Local mirror of dashboard/src/lib/phone.ts formatPhoneDisplay for a NANP E.164
 *  (research DRIFT 4): "+15550190102" -> "(555) 019-0102". The row renders the
 *  FORMATTED number, so the raw E.164 the API returns is reshaped to match it. */
function formatPhoneDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Create a relay group via POST /api/relay-groups under the current page session.
 *  Provisions a pool number (burn-as-claim ladder) and returns the conversation +
 *  its minted number. */
async function createGroup(
  page: Page,
  members: { phone: string; name: string }[],
): Promise<CreatedGroup> {
  const res = await page.request.post(`${NEXT}/api/relay-groups`, { data: { members } });
  expect(res.ok(), `create group failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  expect(res.status()).toBe(201);
  const { conversation } = (await res.json()) as { conversation: CreatedGroup };
  expect(typeof conversation.pool_number, 'created group carries a pool number').toBe('string');
  expect(conversation.pool_number.length).toBeGreaterThan(0);
  return conversation;
}

test.describe('Settings - Group text numbers (admin path)', () => {
  test('admin sees the minted pool number, expands it to the linked group thread, and the tab is visible', async ({
    page,
  }) => {
    await devLoginAs(page, 'founder@example.com');

    // Distinctive, run-unique member names so the server-built group label
    // ("With <A> & <B>") is assertable and isolated from any leftover groups on a
    // reused session stack; per-run-unique phones provision the group cleanly.
    const stamp = Date.now();
    const memberA = { phone: uniquePhone(), name: `PoolAlice${stamp}` };
    const memberB = { phone: uniquePhone(), name: `PoolBob${stamp}` };
    const group = await createGroup(page, [memberA, memberB]);

    // The pool number is MINTED (+1555019XXXX) - capture and reshape to the row's
    // formatted display; the raw E.164 is never rendered.
    const formatted = formatPhoneDisplay(group.pool_number);

    await page.goto(`${NEXT}/settings/numbers`);
    // The admin-only tab + the section heading render for an admin.
    await expect(page.getByRole('tab', { name: 'Group text numbers' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Group text numbers', level: 2 }),
    ).toBeVisible();

    // The pool number's row: formatted number, State "active" (the raw lowercase
    // lifecycle value), an open group, and retirement "-" (an open group is never
    // retirement-eligible, so no countdown). Matched on THIS number, so it stays
    // unique even if a reused stack hosts other pool numbers.
    const numberRow = page.getByRole('row').filter({ hasText: formatted });
    await expect(numberRow).toHaveCount(1, { timeout: 15_000 });
    const cells = numberRow.getByRole('cell');
    // Columns after the leading expander control: Number, State, Open groups,
    // Total groups, People burned, Last activity, Last closed, Retirement.
    await expect(cells.nth(1)).toHaveText(formatted);
    await expect(cells.nth(2)).toHaveText('active');
    await expect(cells.nth(3)).toHaveText(/^[1-9]\d*$/); // open groups >= 1
    await expect(cells.last()).toHaveText('-'); // Retirement: open group -> no countdown

    // Expand the row via its expander control (accessible name carries the number).
    await page.getByRole('button', { name: `Show groups for ${formatted}` }).click();

    // The group row is a link to the conversation thread, labelled with both members.
    const groupLink = page.getByRole('link', {
      name: `With ${memberA.name} & ${memberB.name}`,
    });
    await expect(groupLink).toBeVisible();
    await expect(groupLink).toHaveAttribute('href', `/conversations/${group.conversationId}`);

    // Following it lands on the group thread view (URL + a stable group-view signal).
    await groupLink.click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${group.conversationId}$`));
    await expect(page.getByText('Group text').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Settings - Group text numbers (VA path)', () => {
  test('a VA has no Group text numbers tab and a direct nav bounces to Templates (page never renders)', async ({
    page,
  }) => {
    await devLoginAs(page, 'va@example.com');
    await page.goto(`${NEXT}/settings`);
    // /settings redirects a VA to Templates (the first tab they can see).
    await page.waitForURL(/\/settings\/templates$/, { timeout: 15_000 });

    // The admin-only tab is absent for a VA.
    await expect(page.getByRole('tab', { name: 'Group text numbers' })).toHaveCount(0);

    // The route is GUARDED, not merely hidden: a VA hitting /settings/numbers
    // directly is redirected back to Templates, and the numbers heading + table
    // never render (the "People burned" column is unique to the numbers table).
    await page.goto(`${NEXT}/settings/numbers`);
    await expect(page).toHaveURL(/\/settings\/templates$/);
    await expect(
      page.getByRole('heading', { name: 'Group text numbers', level: 2 }),
    ).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'People burned' })).toHaveCount(0);
  });
});
