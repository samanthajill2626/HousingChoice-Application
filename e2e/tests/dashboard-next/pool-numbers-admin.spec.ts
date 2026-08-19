import { test, expect, type Page } from '@playwright/test';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { APP_NUMBER } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';

// Settings > Phone numbers (:5174) - the READ-ONLY numbers surface, whose two
// blocks have DIFFERENT audiences (spec docs/superpowers/specs/
// 2026-07-18-pool-numbers-admin-design.md section 7, amended by
// 2026-08-06-business-number-config-design.md D7). Proves the role-aware surface
// end-to-end against the real backend:
//   - ADMIN: create a relay group via POST /api/relay-groups (mints a pool
//     number); /settings/numbers shows that number's row (formatted display,
//     State "active", an open group, retirement "-" because an open group is not
//     retirement-eligible); expanding the row reveals the group row, which links
//     to its conversation thread; following the link lands on the group view.
//     An admin sees BOTH blocks: "Our number" and "Relay group numbers".
//   - VA/default: the "Phone numbers" tab IS visible and the route is NOT
//     guarded any more - a VA lands on /settings/numbers, sees OUR one business
//     number, and sees NOTHING of the pool: no "Relay group numbers" block, no
//     table, and no /api/pool-numbers request is ever fired (that route stays
//     admin-only on the server - this is UX gating, not the security boundary).
// The lean profile the harness boots seeds ZERO pool numbers, so the created
// group's number is matched directly (no reseed); the number is MINTED
// dynamically (POOL_NUMBER_RE in e2e/scenarios/steps.ts: the "019" exchange is
// the fake's marker, while the AREA segment tracks whichever buy hint won) and
// captured from the create response - never hardcoded. Read-only feature: this
// spec asserts no mutation UI.
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
  await expectTodayReady(page);
}

// --- Per-run-unique phones (relay-number-lifecycle.spec.ts idiom) -------------
// +1 555 8XX XXXX: the "8" exchange never collides with the fake's minted pool
// numbers (the "019" exchange, whose area segment tracks the buy hint - see
// POOL_NUMBER_RE in e2e/scenarios/steps.ts) or the seeded rosters. The last-4 of
// the wall clock plus an incrementing counter keep every number unique across
// the run.
let uid = 0;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

/** Local mirror of dashboard/src/lib/phone.ts formatPhoneDisplay for a NANP E.164
 *  (research DRIFT 4): "+15550190102" -> "(555) 019-0102". The row renders the
 *  FORMATTED number, so the raw E.164 the API returns is reshaped to match it. */
function formatPhoneDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

test.describe('Settings - Phone numbers (admin path)', () => {
  test('admin sees both blocks: our business number and the minted pool number, expanded to its linked group thread', async ({
    page,
  }) => {
    await devLoginAs(page, 'founder@example.com');

    // Distinctive, run-unique member names so the server-built group label
    // ("With <A> & <B>") is assertable and isolated from any leftover groups on a
    // reused session stack; per-run-unique phones provision the group cleanly.
    const stamp = Date.now();
    const memberA = { phone: uniquePhone(), name: `PoolAlice${stamp}` };
    const memberB = { phone: uniquePhone(), name: `PoolBob${stamp}` };
    // A fresh pair with no reusable twilio number lands CONNECTING; createGroupOpen
    // completes the connect-when-ready handshake so the number is warmed then
    // promoted to ACTIVE - exactly the active-state row this admin surface asserts.
    const group = await createGroupOpen(page, [memberA, memberB]);

    // The pool number is MINTED (the "019" exchange; the area segment reflects the
    // winning buy hint) - capture and reshape to the row's formatted display; the
    // raw E.164 is never rendered.
    const formatted = formatPhoneDisplay(group.pool_number);

    await page.goto(`${NEXT}/settings/numbers`);
    // The tab + the section heading render for an admin.
    await expect(page.getByRole('tab', { name: 'Phone numbers' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Phone numbers', level: 2 })).toBeVisible();

    // BLOCK 1 - "Our number": the ONE business number this stack is configured
    // to send from (BUSINESS_PHONE_NUMBER), rendered in the same formatted
    // display shape as the pool rows. An admin sees it too, not just a VA.
    await expect(page.getByRole('heading', { name: 'Our number', level: 3 })).toBeVisible();
    await expect(page.getByText(formatPhoneDisplay(APP_NUMBER))).toBeVisible();

    // BLOCK 2 - the admin-only pool inventory.
    await expect(page.getByRole('heading', { name: 'Relay group numbers', level: 3 })).toBeVisible();

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
    await expect(page.getByText('Relay group').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Settings - Phone numbers (VA path)', () => {
  test('a VA reaches the tab and sees our business number, but never the pool inventory or its request', async ({
    page,
  }) => {
    // Record every admin-only pool request this page fires. Registered BEFORE
    // the first navigation so nothing can slip through un-observed.
    const poolRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/pool-numbers')) poolRequests.push(req.url());
    });

    await devLoginAs(page, 'va@example.com');
    await page.goto(`${NEXT}/settings`);
    // /settings still redirects a VA to Templates (the first tab they can see).
    await page.waitForURL(/\/settings\/templates$/, { timeout: 15_000 });

    // The tab is VISIBLE for a VA now, and reaching the section from it does
    // not bounce: the route carries no AdminRoute wrapper any more.
    const tab = page.getByRole('tab', { name: 'Phone numbers' });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.click();
    await page.waitForURL(/\/settings\/numbers$/, { timeout: 15_000 });

    // A direct navigation lands there too (no redirect back to Templates).
    await page.goto(`${NEXT}/settings/numbers`);
    await expect(page).toHaveURL(/\/settings\/numbers$/);

    // What a VA DOES see: the section and our one business number. The section
    // is a NAMED region (its <section> is aria-labelledby its own <h2>), so
    // every assertion below scopes to it rather than the whole page.
    await expect(page.getByRole('heading', { name: 'Phone numbers', level: 2 })).toBeVisible();
    const section = page.getByRole('region', { name: 'Phone numbers' });
    await expect(section.getByRole('heading', { name: 'Our number', level: 3 })).toBeVisible();
    await expect(section.getByText(formatPhoneDisplay(APP_NUMBER))).toBeVisible();

    // What a VA does NOT see: any part of the pool inventory - its heading, its
    // table (the "People burned" column is unique to it), its error alert, or
    // its "no numbers yet" empty state (which would be a false claim, not just
    // a leak). The whole block is gated, not merely the table.
    await expect(section.getByRole('heading', { name: 'Relay group numbers' })).toHaveCount(0);
    await expect(section.getByRole('columnheader', { name: 'People burned' })).toHaveCount(0);
    await expect(section.getByRole('table')).toHaveCount(0);
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(section.getByText(/No relay group numbers yet/)).toHaveCount(0);

    // ...and no admin-only request was ever fired (the server would 403 it; the
    // UI must not ask in the first place).
    expect(poolRequests).toEqual([]);
  });
});
