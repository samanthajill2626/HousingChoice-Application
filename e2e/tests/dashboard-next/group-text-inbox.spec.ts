import { test, expect, type Page } from '@playwright/test';
import { registerParty, sendGroupAsParty } from '../../fixtures/fakeTwilio.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';

// SPEC 7 - the inbox surfaces: the Groups filter, its own cursor, mark-read,
// the deep link, and the unread walk.
//
// Group threads are a THIRD row source on their own DynamoDB partition, paged
// by their own TAGGED cursor. That last part is the one worth proving over
// HTTP: the group partition's cursor and the 'open' partition's cursor are not
// interchangeable, and a filter that silently accepted a foreign cursor would
// restart the walk at the newest row - a "Load more" that quietly loops.
//
// The lean seed's group thread is deliberately timestamped BEFORE the 1:1 one
// and carries unread_count 0, so nothing here depends on it being newest and
// nothing else in the suite inherits a permanent unread row.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:9001';
// The app's /api routes sit behind the CloudFront origin-secret validator (only
// /__dev/* is exempt); the dashboard's dev server adds this header for the
// browser, so a direct API read has to add it too. Same fallback the other
// fixtures use - the launcher sets it on its children, never on this process.
const ORIGIN_SECRET = process.env['CF_ORIGIN_SECRET'] ?? 'dev-placeholder-not-a-secret';
const apiHeaders = { 'x-origin-verify': ORIGIN_SECRET };

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('the Groups filter is a real deep link, pages on its own cursor, and refuses a foreign one', async ({
  page,
  request,
}) => {
  // Seed a SECOND group of this spec's own, so paging is proven against a list
  // this test controls rather than against whatever earlier specs left behind.
  const stamp = `${Date.now()}`.slice(-6);
  const PAGER = `+1555092${stamp.slice(-4)}`;
  await registerParty(request, { label: `Pager ${stamp}`, role: 'tenant', number: PAGER });
  await sendGroupAsParty(request, {
    from: PAGER,
    otherRecipients: [`+1555093${stamp.slice(-4)}`],
    body: `second group for paging ${stamp}`,
  });

  await devLogin(page);

  // 1) DEEP LINK. The filter lives in the URL, so a link to it is shareable and
  //    a reload keeps the operator where they were.
  await page.goto(`${NEXT}/inbox?filter=groups`);
  const groupsTab = page.getByRole('tab', { name: 'Groups' });
  await expect(groupsTab).toHaveAttribute('aria-selected', 'true');

  // 2) The filter shows GROUP rows and only group rows. `Relay group` is the
  //    chip on a masked relay thread - a different product that must not leak
  //    into this list.
  await expect(page.getByText('Group text').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Relay group')).toHaveCount(0);

  // 3) PAGING on the group partition's own cursor. limit=1 forces a real second
  //    page rather than asserting a boundary that the fixture never crosses.
  const first = await page.request.get(`${APP}/api/inbox?filter=groups&limit=1`, {
    headers: apiHeaders,
  });
  expect(first.ok()).toBe(true);
  const page1 = (await first.json()) as {
    rows: { conversationId: string; kind: string }[];
    nextCursor: string | null;
  };
  expect(page1.rows).toHaveLength(1);
  expect(page1.rows[0]?.kind).toBe('group_text');
  expect(page1.nextCursor, 'the lean fixture seeds enough group rows to page').not.toBeNull();

  const second = await page.request.get(
    `${APP}/api/inbox?filter=groups&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    { headers: apiHeaders },
  );
  expect(second.ok()).toBe(true);
  const page2 = (await second.json()) as { rows: { conversationId: string; kind: string }[] };
  expect(page2.rows[0]?.kind).toBe('group_text');
  expect(page2.rows[0]?.conversationId).not.toBe(page1.rows[0]?.conversationId);

  // 4) A cursor from the OTHER partition is refused, not silently restarted.
  const openPage = await page.request.get(`${APP}/api/inbox?filter=all&limit=1`, {
    headers: apiHeaders,
  });
  const openCursor = ((await openPage.json()) as { nextCursor: string | null }).nextCursor;
  if (openCursor) {
    const foreign = await page.request.get(
      `${APP}/api/inbox?filter=groups&limit=1&cursor=${encodeURIComponent(openCursor)}`,
      { headers: apiHeaders },
    );
    expect(foreign.status()).toBe(400);
  }
});

test('a group inbound goes unread, walks into the Unread tab, and clears on mark-read', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = `${Date.now()}`.slice(-6);
  const ANA = `+1555090${stamp.slice(-4)}`;
  const BEN = `+1555091${stamp.slice(-4)}`;
  const conversationId = conversationIdForGroup([ANA, BEN]);

  await registerParty(request, { label: `Ana inbox ${stamp}`, role: 'tenant', number: ANA });
  await sendGroupAsParty(request, {
    from: ANA,
    otherRecipients: [BEN],
    body: `unread group message ${stamp}`,
  });

  await devLogin(page);

  // The derived title falls back to formatted numbers for members with no name,
  // so the row is addressed by its href - the one identifier a derived-id
  // thread always has.
  const row = page.locator(`a[href="/conversations/${conversationId}"]`);

  // 1) It arrives UNREAD, in the Groups filter.
  await page.goto(`${NEXT}/inbox?filter=groups`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByLabel(/\d+ unread/)).toBeVisible();

  // 2) THE UNREAD WALK. The Unread tab reads a different query path than the
  //    Groups tab, so a group row that shows unread in one and is missing from
  //    the other would strand the message where nobody looks.
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.locator(`a[href="/conversations/${conversationId}"]`)).toBeVisible({
    timeout: 15_000,
  });

  // 3) MARK READ from the row itself, without opening the thread. The action
  //    sits OUTSIDE the row link (a click on it must not navigate), so it is
  //    scoped to the row's list item rather than picked off the page.
  await page.getByRole('tab', { name: 'Groups' }).click();
  const item = page
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/conversations/${conversationId}"]`) });
  await expect(item).toHaveCount(1);
  // The row action only becomes hittable on hover (`.actions` is opacity 0 +
  // pointer-events none until `.row:hover`), so the hover is part of the
  // interaction, not a workaround for one.
  await item.hover();
  await item.getByRole('button', { name: /^Mark .* read$/ }).click();

  await expect
    .poll(async () => item.getByLabel(/\d+ unread/).count(), {
      timeout: 15_000,
      message: 'the unread badge never cleared',
    })
    .toBe(0);
  // Still on the inbox: mark-read is not navigation.
  await expect(page).toHaveURL(/\/inbox/);

  // 4) ...and it leaves the Unread tab, which is the state that actually
  //    matters: a badge that clears while the row stays in Unread is a queue
  //    that never empties.
  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.locator(`a[href="/conversations/${conversationId}"]`)).toHaveCount(0);

  // 5) The thread still opens from the Groups filter, unchanged.
  await page.goto(`${NEXT}/inbox?filter=groups`);
  await page.locator(`a[href="/conversations/${conversationId}"]`).click();
  await expect(page.getByText(`unread group message ${stamp}`)).toBeVisible({ timeout: 15_000 });
});
