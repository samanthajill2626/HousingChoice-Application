import { test, expect, type Locator, type Page } from '@playwright/test';
import { registerParty, sendAsParty, sendGroupAsParty } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';

// THE NAV INBOX BADGE - its first e2e coverage (inbox-unread-index spec 4.4/4.7).
//
// Two claims, and the second one IS the feature:
//   1. the badge renders the unread ROW count, and it is ABSENT - never a "0" -
//      the moment nothing is unread (NavContents.tsx renders no span at <= 0);
//   2. acting on a row decrements it IMMEDIATELY, inside the click's own event
//      handler, before the server count endpoint could possibly have answered.
//      The badge used to wait a full server round trip for that number.
//
// WHY EVERY BADGE READ GOES THROUGH THE NAVIGATION LANDMARK. An inbox ROW renders
// its own count span with the SAME accessible-name shape as the nav badge
// (InboxRow.tsx: aria-label={`${row.unreadCount} unread`}), so a bare
// getByLabel('1 unread') matches BOTH elements on /inbox and would cheerfully
// assert against the row while the nav badge sat unchanged. Reads here are
// anchored: navigation[Communications] -> link[Inbox] -> its following sibling.
//
// WHY THESE AFFORDANCES AND NOT THE CONTACT PAGE. Only useInbox.markRead feeds the
// optimistic layer. The contact page's own mark-read-on-view (useMarkContactRead)
// is DELIBERATELY unwired from it - a stated non-goal - so a test that leaned on
// opening a contact page would prove nothing about this feature: the badge would
// still clear, just later and for the wrong reason. Inbox.tsx wires BOTH row
// affordances to markRead (onOpen={inbox.markRead} onMarkRead={inbox.markRead}),
// so both are exercised below: the explicit Mark-read button (no navigation) and
// the row link (which runs markRead BEFORE navigating - the pending clear lives in
// UnreadProvider, which wraps AppFrame above the routes and survives the nav).
//
// WHY ROWS ARE ADDRESSED BY HREF. The lean seed's relay group is titled
// "Marcus Bell + Renee Carter" and its native group text is derived from the same
// two seeded people, so getByRole('link', { name: /Marcus Bell/ }) is a
// strict-mode collision with rows this test is not talking about. The href is the
// one identifier each row certainly has - the idiom group-text-inbox.spec.ts uses.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TASHA = '+15550100001'; // lean seed tenant   -> contact-tenant-0001
const MARCUS = '+15550100002'; // lean seed landlord -> contact-landlord-0001
/** The badge's ONLY request since this feature. Nothing else reads this path. */
const COUNT_PATH = '/api/inbox/unread-count';
/** UnreadContext's RECHECK_DELAY_MS (2s) plus room for the request it fires. */
const RECHECK_SETTLE_MS = 3_000;

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** The nav badge, and ONLY the nav badge (see the header note on the row twin). */
function navBadge(page: Page): Locator {
  return page
    .getByRole('navigation', { name: 'Communications' })
    .getByRole('link', { name: 'Inbox' })
    .locator('xpath=following-sibling::span[contains(@aria-label, "unread")]');
}

/**
 * Run `act`, then read the badge ONCE - no auto-retry - while the server count
 * request that action triggered is still on the wire.
 *
 * THE SNAPSHOT IS THE POINT. `expect(locator)` retries for seconds, so a plain
 * toHaveCount(0) here would also pass on a build with NO optimistic layer at all:
 * the server reconcile lands a few hundred ms later and clears the badge for the
 * wrong reason. So this takes a single evaluateAll query (one round trip, no
 * waiting) and guards it with the fact that the reconcile had not landed yet.
 * If that guard ever fires, the assertion window collapsed and the snapshot below
 * would prove nothing - it is a deliberate red, not a flake to paper over.
 *
 * `expected` is the badge's exact accessible name, or null for "no badge at all".
 */
async function expectBadgeAfter(
  page: Page,
  act: () => Promise<void>,
  expected: string | null,
): Promise<void> {
  let reconciled = false;
  const reconcile = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(COUNT_PATH) && response.status() === 200,
      { timeout: 15_000 },
    )
    .then(() => {
      reconciled = true;
    });

  await act();
  const labels = await navBadge(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label')),
  );
  expect(
    reconciled,
    'the server reconcile beat the snapshot - the optimistic assertion below would prove nothing',
  ).toBe(false);
  expect(labels, 'the badge did not move in the click handler').toEqual(
    expected === null ? [] : [expected],
  );

  // ...and the server agrees once it answers, so the optimistic number was not a
  // guess the reconcile has to walk back.
  await reconcile;
  if (expected === null) await expect(navBadge(page)).toHaveCount(0);
  else await expect(navBadge(page)).toHaveAttribute('aria-label', expected);
}

test.beforeEach(async ({ request }) => {
  // An EXACT count assertion needs a known world. The standing lean seed carries
  // no nonzero unread anywhere (guarded by app/test/seedUnreadFlag.test.ts), so
  // after a reseed every unread row on the lane is one this test put there.
  await reseed(request);
});

test('the nav Inbox badge counts unread rows and decrements the instant a row is acted on', async ({
  page,
  request,
}) => {
  test.slow(); // a reseed, two inbounds and two reconciles on a shared busy lane
  const stamp = `${Date.now()}`.slice(-7);
  await sendAsParty(request, { from: TASHA, body: `nav badge tenant ${stamp}` });
  await sendAsParty(request, { from: MARCUS, body: `nav badge landlord ${stamp}` });

  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);

  // TWO unread contacts: the badge counts ROWS, not messages.
  await expect(navBadge(page)).toHaveAttribute('aria-label', '2 unread', { timeout: 20_000 });

  // 1) THE EXPLICIT ROW AFFORDANCE. `.actions` is opacity 0 + pointer-events none
  //    until `.row:hover`, so the hover is part of the interaction, not a
  //    workaround for one.
  const tasha = page
    .getByRole('listitem')
    .filter({ has: page.locator('a[href="/contacts/contact-tenant-0001"]') });
  await expect(tasha).toHaveCount(1);
  await expectBadgeAfter(
    page,
    async () => {
      await tasha.hover();
      await tasha.getByRole('button', { name: 'Mark Tasha Nguyen read' }).click();
    },
    '1 unread',
  );
  // Mark-read is not navigation.
  await expect(page).toHaveURL(/\/inbox/);

  // The provider schedules ONE follow-up reconcile 2s after a clear expires
  // (UnreadContext RECHECK_DELAY_MS). Let it land BEFORE the next window is armed,
  // or that stray response arrives inside it and the ordering guard fires on
  // timing rather than on a regression.
  await page.waitForTimeout(RECHECK_SETTLE_MS);

  // 2) THE ROW LINK, which marks read and THEN navigates. The badge is decremented
  //    by the handler, and the pending clear survives the route change because it
  //    lives in the provider, not in the page.
  const marcus = page.locator('a[href="/contacts/contact-landlord-0001"]');
  await expect(marcus).toHaveCount(1);
  await expectBadgeAfter(
    page,
    async () => {
      await marcus.click();
    },
    null, // 1 -> 0, and at zero the span is ABSENT rather than showing "0"
  );
  await expect(page).toHaveURL(/\/contacts\/contact-landlord-0001$/);
});

test('a group-text row decrements the nav badge from its own Mark-read button', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = `${Date.now()}`.slice(-6);
  const ANA = `+1555094${stamp.slice(-4)}`;
  const BEN = `+1555095${stamp.slice(-4)}`;
  const conversationId = conversationIdForGroup([ANA, BEN]);

  await registerParty(request, { label: `Ana badge ${stamp}`, role: 'tenant', number: ANA });
  await sendGroupAsParty(request, {
    from: ANA,
    otherRecipients: [BEN],
    body: `nav badge group ${stamp}`,
  });

  await devLogin(page);
  await page.goto(`${NEXT}/inbox?filter=groups`);

  // A group thread is a row source of its own; its unread has to reach the SAME
  // badge, and clear from it, without a contact behind it.
  const item = page
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/conversations/${conversationId}"]`) });
  await expect(item).toHaveCount(1);
  await expect(navBadge(page)).toHaveAttribute('aria-label', '1 unread', { timeout: 20_000 });

  // The derived title falls back to formatted numbers for members with no name,
  // so the button is matched by shape and scoped to this row.
  await expectBadgeAfter(
    page,
    async () => {
      await item.hover();
      await item.getByRole('button', { name: /^Mark .* read$/ }).click();
    },
    null,
  );
  await expect(page).toHaveURL(/\/inbox/);
});
