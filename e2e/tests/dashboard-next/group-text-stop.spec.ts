import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { registerParty, sendGroupAsParty, listConversations } from '../../fixtures/fakeTwilio.js';
import { minutesFromNow, readLogTail, tickGuardrails } from '../../fixtures/groupText.js';
import { conversationIdForGroup, contactIdForPhone } from '../../../app/src/lib/import/ids.js';
import { expectTodayReady } from '../../support/today.js';

// SPEC 3 - STOP on a group text, scoped to the person who sent it.
//
// The rule this proves is the one most likely to be got wrong, and getting it
// wrong is an A2P violation in one direction and a silenced room in the other:
// a STOP from one member suppresses THAT PERSON, on THAT NUMBER. It does not
// suppress the group thread, and it does not stop the other members hearing
// from us. Twilio's own service sends the confirmation; the app deliberately
// sends no keyword copy on a group path, so there is no reply to assert here.
//
// Both suppression SCOPES are covered, because the words differ and the wrong
// words libel someone: a STOP from a contact's PRIMARY number reads
// "Opted out"; a STOP from a SECOND number they own reads "This number opted
// out" - the person is still reachable, one of their handsets is not.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// FULL-profile cast contact with TWO numbers - the only seeded person who has
// one, and the reason the secondary case reseeds.
const MONIQUE_ID = 'contact-cast-searching-tenant';
const MONIQUE_SECOND = '+15550100105';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

async function reseed(request: APIRequestContext, profile: 'lean' | 'full'): Promise<void> {
  const res = await request.post(`/__dev/reseed?profile=${profile}`);
  if (!res.ok()) throw new Error(`reseed(${profile}) failed: ${res.status()}`);
}

/** Wait for the rail, so a send is never refused for the wrong reason. */
async function awaitRail(request: APIRequestContext, conversationId: string): Promise<void> {
  await expect
    .poll(
      async () => (await listConversations(request)).some((c) => c.uniqueName === conversationId),
      { timeout: 20_000, message: 'the group rail was never created' },
    )
    .toBe(true);
}

test('a group STOP suppresses the SENDER on their primary number, not the thread; START restores', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = `${Date.now()}`.slice(-6);
  const ANA = `+1555082${stamp.slice(-4)}`;
  const BEN = `+1555083${stamp.slice(-4)}`;
  const CAL = `+1555084${stamp.slice(-4)}`;
  const conversationId = conversationIdForGroup([ANA, BEN, CAL]);

  await registerParty(request, { label: `Ana ${stamp}`, role: 'tenant', number: ANA });
  await registerParty(request, { label: `Ben ${stamp}`, role: 'tenant', number: BEN });
  await sendGroupAsParty(request, {
    from: ANA,
    otherRecipients: [BEN, CAL],
    body: `Opening the group ${stamp}`,
  });
  await awaitRail(request, conversationId);

  // BEN stops - on the group thread, in front of everyone.
  await sendGroupAsParty(request, { from: BEN, otherRecipients: [ANA, CAL], body: 'STOP' });

  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${conversationId}`);
  const members = page.getByRole('list', { name: 'Group members' });
  await expect(members).toBeVisible({ timeout: 15_000 });

  // 1) The chip, on the PRIMARY-number wording. Ben's contact was minted from
  //    this very number, so it IS his primary and the flat "Opted out" is the
  //    true statement.
  // EXACT: `getByText` is a case-insensitive SUBSTRING match, so a bare
  // 'Opted out' would also match the SECOND-number chip 'This number opted
  // out' - the two strings this spec exists to keep apart.
  await expect
    .poll(async () => members.getByText('Opted out', { exact: true }).count(), {
      timeout: 15_000,
      message: 'the suppression chip never appeared on the member panel',
    })
    .toBe(1);
  await expect(members.getByText('This number opted out')).toHaveCount(0);

  // 2) THE GROUP THREAD IS NOT SUPPRESSED. One member's STOP silencing the
  //    room would be the loudest possible over-application of the rule.
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: /opted out/ })).toBeVisible();

  // 3) The next send PARTIALLY delivers. NOTHING IS ARMED HERE, and that is the
  //    point: live QA round 2 established that Twilio SKIPS an opted-out
  //    participant - no leg, no delivery attempt, no 21610, and NO DELIVERY
  //    RECEIPT, EVER. The fake now models that silence (it used to fan out to
  //    Ben and let this spec arm a 21610, which manufactured a receipt
  //    production never sends). So Ben's slot can only be right if the SEND
  //    labelled it from the suppression we already knew about.
  const partial = `Still on for Saturday ${stamp}`;
  await composer.fill(partial);
  // EXACT: a tenant's contact page also carries a "+ Send" aside whose
  // accessible name is "Send a property to this tenant", so a substring match
  // on "Send" is a strict-mode violation - and only on a tenant's page.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(partial)).toBeVisible({ timeout: 15_000 });
  // Two reachable members, both delivered - the opted-out leg is excluded from
  // the count rather than counted as a failure. NOT RELOADED, for the same
  // reason the reply-all spec is not: this poll used to reload every sample,
  // which hid the fact that group receipts pushed no SSE at all. The receipts
  // path now emits `message.persisted` like the relay path, so the rollup must
  // arrive on its own. If this goes flaky, the push is broken - do not restore
  // the reload.
  await expect
    .poll(async () => page.getByText('Delivered 2/2').count(), {
      timeout: 60_000,
      message: 'the delivery rollup never finalized LIVE around the opted-out leg (no reload)',
    })
    .toBeGreaterThan(0);
  // The opted-out member is EXPLAINED on the bubble, not silently missing.
  //
  // TWO SURFACES SAY IT NOW (fix wave 5, adversarial 22c), so the old loose
  // regex is a strict-mode violation rather than a failure: the thread HEADER
  // carries a reachability flag at every width - the Details pane that used to
  // be the only carrier is hidden at <=860px, so on a phone the thread looked
  // entirely normal - and the BUBBLE carries the per-send note. Assert the
  // bubble note specifically (this test is about the send's own rollup), and
  // assert the header flag beside it rather than letting a substring pick one
  // of them at random.
  await expect(
    page.getByText(/1 member opted out - Twilio skips them/),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('1 member opted out', { exact: true })).toBeVisible();

  // 3b) AND THE ALARM STAYS QUIET. This is the L3 regression, at the level it
  //     actually bit: with Ben's slot left `queued` (no receipt will ever come
  //     for him), the per-send staleness sweep raises
  //     "group delivery receipts silent - check Conversations service webhook
  //     config" on EVERY send to this group - and after spec 16.2 that alarm is
  //     the ONLY detector of a genuinely dead receipts webhook, so false-firing
  //     it teaches the operator to ignore the one alarm that matters.
  await tickGuardrails(request, {
    now: minutesFromNow(30),
    duties: ['send_staleness'],
  });
  const stale = await readLogTail(request, { event: 'group_send_receipts_stale' });
  expect(
    stale.filter((l) => String(l['conversationId'] ?? '') === conversationId),
  ).toHaveLength(0);

  // 4) Ben's OWN 1:1 is flagged. This is where the suppression has to live: a
  //    proactive send to him is refused, by the same gate that would refuse it
  //    if he had stopped in a 1:1.
  await page.goto(`${NEXT}/contacts/${contactIdForPhone(BEN)}`);
  const oneToOne = page.getByRole('textbox', { name: 'Reply message' });
  await expect(oneToOne).toBeVisible({ timeout: 10_000 });
  await oneToOne.fill(`should be refused ${stamp}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Do-Not-Contact/i);

  // 5) START restores him - the chip goes, on the same surface it appeared on.
  //
  // ANCHORED ON THE RESOLVED ROSTER, and it has to be. `GroupTextView` seeds
  // the member list from the conversation HEADER with `suppressed: false`
  // hard-coded, so the panel renders complete and chip-free BEFORE
  // `getGroupMembers` resolves. A bare "count the chips, expect 0" poll is
  // therefore satisfied by the very first, pre-API paint: delete the entire
  // opt-in path from numberSuppression.ts and it still goes green. Two things
  // fix that. First a POSITIVE assertion on this surface, so we know the chip
  // is genuinely here to be removed. Then every poll sample waits for the
  // group-members RESPONSE that reload triggered, so the zero can only ever be
  // read off API-resolved state.
  const membersResponse = /\/api\/conversations\/[^/]+\/group-members/;
  await page.goto(`${NEXT}/conversations/${conversationId}`);
  const restored = page.getByRole('list', { name: 'Group members' });
  await expect(restored).toBeVisible({ timeout: 15_000 });
  // EXACT: `getByText` is a case-insensitive SUBSTRING match, so a bare
  // 'Opted out' also matches 'This number opted out' - the two chips this spec
  // exists to keep apart.
  await expect
    .poll(async () => restored.getByText('Opted out', { exact: true }).count(), {
      timeout: 15_000,
      message: 'the chip was not present before START, so its absence after would prove nothing',
    })
    .toBe(1);

  await sendGroupAsParty(request, { from: BEN, otherRecipients: [ANA, CAL], body: 'START' });
  await expect
    .poll(
      async () => {
        await Promise.all([
          page.waitForResponse(
            (r) => membersResponse.test(new URL(r.url()).pathname) && r.status() === 200,
            { timeout: 15_000 },
          ),
          page.reload(),
        ]);
        const list = page.getByRole('list', { name: 'Group members' });
        await list.waitFor({ timeout: 15_000 });
        return list.getByText('Opted out', { exact: true }).count();
      },
      { timeout: 30_000, message: 'the suppression chip never cleared after START' },
    )
    .toBe(0);
});

test.describe('the SECOND-number case (full profile)', () => {
  test.afterAll(async ({ request }) => {
    // Every other spec in the suite assumes lean. Restoring it is not optional.
    await reseed(request, 'lean');
  });

  test('a STOP from a contact SECOND number says so - the person stays reachable', async ({
    page,
    request,
  }) => {
    test.slow();
    await reseed(request, 'full');

    const stamp = `${Date.now()}`.slice(-6);
    const OTHER = `+1555085${stamp.slice(-4)}`;
    const THIRD = `+1555086${stamp.slice(-4)}`;
    const conversationId = conversationIdForGroup([MONIQUE_SECOND, OTHER, THIRD]);

    await registerParty(request, {
      label: `Monique second ${stamp}`,
      role: 'tenant',
      number: MONIQUE_SECOND,
    });
    await sendGroupAsParty(request, {
      from: MONIQUE_SECOND,
      otherRecipients: [OTHER, THIRD],
      body: `From my other phone ${stamp}`,
    });
    await sendGroupAsParty(request, {
      from: MONIQUE_SECOND,
      otherRecipients: [OTHER, THIRD],
      body: 'STOP',
    });

    await devLogin(page);
    await page.goto(`${NEXT}/conversations/${conversationId}`);
    const members = page.getByRole('list', { name: 'Group members' });
    await expect(members).toBeVisible({ timeout: 15_000 });

    // The SCOPED words. Rendering the flat "Opted out" here would tell staff
    // that Monique cannot be texted at all, which is false and would cost a
    // placement.
    await expect
      .poll(async () => members.getByText('This number opted out').count(), {
        timeout: 15_000,
        message: 'the secondary-scope chip never appeared',
      })
      .toBe(1);
    await expect(members.getByText('Opted out', { exact: true })).toHaveCount(0);

    // And her PRIMARY number is untouched: the 1:1 thread on it still sends.
    await page.goto(`${NEXT}/contacts/${MONIQUE_ID}`);
    const composer = page.getByRole('textbox', { name: 'Reply message' });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill(`still reachable ${stamp}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(`still reachable ${stamp}`)).toBeVisible({ timeout: 15_000 });
  });
});
