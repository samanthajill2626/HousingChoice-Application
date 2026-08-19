import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { registerParty, sendGroupAsParty, listConversations } from '../../fixtures/fakeTwilio.js';
import { readLogTail } from '../../fixtures/groupText.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';
import { expectTodayReady } from '../../support/today.js';

// SPEC 5 - conversion: an imported relay group becomes the native group text it
// always was, and CONVERGES however many times it is retried.
//
// The 132 imported "groups" are relay groups waiting on a pool number that will
// now never be bought. Conversion is forward-only and re-runnable by design,
// because the alternative - a migration you can only run once, correctly - is
// how a cutover goes wrong at 2am.
//
// The lean seed carries one `connecting` relay group whose id is DERIVED from
// its roster, exactly as a real imported group's is. That derivation is what
// makes case (c) work at all: a group inbound from the same two people lands on
// the SAME id, finds a connecting relay row there, and converts it in place
// instead of minting a second thread for the same people.
//
// SCOPE NOTE, stated rather than hidden: the BULK runner's own convergence
// (`runConvertGroups`, including rerun-after-partial-failure) is proven by
// app/test/importConvertGroups.test.ts, which drives it directly. It is not
// reachable over HTTP - the CLI reads Quo/Airtable export directories the
// hermetic lane has no fixture for - so what this spec proves is the RUNTIME
// half of the same convergence contract: the auto-convert path, and that a
// second arrival at an already-converted thread changes nothing but the
// transcript.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:9001';
// /api sits behind the origin-secret validator (only /__dev/* is exempt), so a
// direct API read has to send the header the dashboard's dev server adds.
const ORIGIN_SECRET = process.env['CF_ORIGIN_SECRET'] ?? 'dev-placeholder-not-a-secret';

// The lean connecting fixture's roster (app/src/lib/seed/lean.ts).
const MARCUS = '+15550100002';
const RENEE = '+15550100003';
const CONNECTING_ID = conversationIdForGroup([MARCUS, RENEE]);

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post('/__dev/reseed');
  if (!res.ok()) throw new Error(`reseed failed: ${res.status()}`);
}

test.describe('conversion of an imported connecting relay group', () => {
  test.beforeEach(async ({ request }) => {
    // This spec MUTATES a seeded row (that is the point), so it restores the
    // fixture rather than leaving a converted thread behind for its neighbours.
    await reseedLean(request);
  });

  test.afterAll(async ({ request }) => {
    await reseedLean(request);
  });

  test('an inbound from the same roster converts the thread in place and converges on a re-run', async ({
    page,
    request,
  }) => {
    test.slow();
    const stamp = `${Date.now()}`.slice(-6);
    const first = `Group is live ${stamp}`;
    const second = `And again ${stamp}`;

    await registerParty(request, { label: `Marcus ${stamp}`, role: 'landlord', number: MARCUS });

    // BEFORE: the seeded row is a relay group still waiting for a number, so it
    // is NOT in the group partition at all.
    await devLogin(page);
    await page.goto(`${NEXT}/inbox?filter=groups`);
    await expect(page.getByRole('link', { name: /^With Marcus & Renee/ })).toHaveCount(0);

    // CASE (c): a carrier group text from the same two people.
    await sendGroupAsParty(request, { from: MARCUS, otherRecipients: [RENEE], body: first });

    // 1) The SAME row is now a native group text. Same id - so nothing forked -
    //    and the group-only unmasked affordance proves the type actually
    //    flipped rather than the row merely being re-rendered.
    await page.goto(`${NEXT}/conversations/${CONNECTING_ID}`);
    await expect(
      page.getByText(/Everyone in this group text sees everyone's real number/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(first)).toBeVisible();
    const members = page.getByRole('list', { name: 'Group members' });
    await expect(members.getByRole('listitem')).toHaveCount(2);

    // 2) It is in the group partition, and the roster names survived the
    //    transition (a conversion that dropped them would leave a thread titled
    //    by bare phone numbers).
    await page.goto(`${NEXT}/inbox?filter=groups`);
    await expect(page.getByRole('link', { name: /^With Marcus & Renee/ })).toBeVisible({
      timeout: 15_000,
    });

    // 3) The converted thread GETS A RAIL. Conversion that leaves a thread
    //    rail-less is a thread nobody can reply to - the migration's whole
    //    point is a group staff can use.
    await expect
      .poll(
        async () => (await listConversations(request)).some((c) => c.uniqueName === CONNECTING_ID),
        { timeout: 25_000, message: 'the converted thread never got a Conversations rail' },
      )
      .toBe(true);

    // 4) CONVERGENCE. A second arrival at an already-converted thread must be a
    //    no-op plus one message - not a refusal, not a second thread, and not
    //    an error line. This is the re-run semantics the cutover depends on.
    await sendGroupAsParty(request, { from: MARCUS, otherRecipients: [RENEE], body: second });

    await page.goto(`${NEXT}/conversations/${CONNECTING_ID}`);
    await expect(page.getByText(second)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(first)).toBeVisible();

    // Still exactly ONE group row for these two people.
    await page.goto(`${NEXT}/inbox?filter=groups`);
    await expect(page.getByRole('link', { name: /^With Marcus & Renee/ })).toHaveCount(1);

    // And nothing complained. A conversion refusal on the second pass is
    // exactly what a non-convergent migration looks like.
    const errors = await readLogTail(request, { level: 'error' });
    expect(
      errors.filter((l) => String(l['conversationId'] ?? '') === CONNECTING_ID),
    ).toHaveLength(0);

    // 5) The relay side is genuinely gone: the row no longer answers the
    //    connecting-relay reader, so the cutover check ("zero remaining
    //    connecting rows") can actually reach zero.
    const connecting = await page.request.get(`${APP}/api/inbox?filter=all&limit=100`, {
      headers: { 'x-origin-verify': ORIGIN_SECRET },
    });
    expect(connecting.ok()).toBe(true);
    const rows = ((await connecting.json()) as { rows: { conversationId: string; kind: string }[] }).rows;
    const row = rows.find((r) => r.conversationId === CONNECTING_ID);
    // ASSERT IT IS THERE FIRST. `if (row) expect(...)` no-ops when the row is
    // absent, which hides exactly the failure this step is about: the thread
    // vanishing from the inbox feed altogether during conversion. A converted
    // group must still be a row, and that row must be a group_text.
    expect(row, 'the converted thread left the inbox feed entirely').toBeDefined();
    expect(row?.kind).toBe('group_text');
  });
});
