import { test, expect, type Page } from '@playwright/test';
import {
  registerParty,
  sendGroupAsParty,
  listConversations,
  setDeliveryOutcome,
} from '../../fixtures/fakeTwilio.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';
import { expectTodayReady } from '../../support/today.js';

// PER-RECIPIENT DELIVERY - the half of the feature jsdom structurally cannot
// prove. The unit suites own the presentation rules and the whole staleness
// table (15 real minutes is not an e2e, so nothing here waits for one). What
// only a real browser can establish is the end-to-end join: a real group send,
// real carrier receipts arriving one leg at a time, the reveal actually
// disclosing the list, and each row naming the RIGHT member against the RIGHT
// state.
//
// THE SHAPE THIS RECREATES is the 2026-08-23 drop: three handsets, two report
// delivered, one reports `sent` and then goes silent for ever. Before this
// feature the bubble read a bare "delivered 2/3" and there was no way, from the
// thread, to learn WHICH member was the missing one - which is why the drop was
// noticed days later by the recipient, not by staff.
//
// NATIVE GROUP TEXT is the product under test because it is the only one where
// a stalled leg is armable end to end: `setDeliveryOutcome` arms the fake per
// HANDSET, and a group send fans out to real handsets. A relay send is armed the
// same way, but its legs are the app's own fan-out and the stall would be a
// different mechanism.
//
// NOT RESEEDED, deliberately (orchestrator adjudication A6). No seed row in any
// profile carries a `delivery_recipients` map, so seed data cannot produce a
// mixed state at all, and the `lean` profile is the byte-stable e2e world. The
// thread is CREATED here from run-unique numbers, exactly the way
// `group-text-reply-all.spec.ts` creates its own.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/**
 * The label a row shows for a member with no name. MIRRORS
 * `dashboard/src/lib/phone.ts:79-83` (`formatPhoneDisplay`) rather than
 * importing it - the e2e workspace compiles the app and its own sources, not
 * the dashboard's.
 *
 * These members ARE unnamed, and that is a property of the fixture rather than
 * an accident: an ad-hoc number seen on a group envelope mints a
 * `type: 'unknown'` stub with no first or last name
 * (`app/src/services/groupMembers.ts:105-119`), so `displayName` is undefined
 * and the row falls to the phone. That still exercises the whole naming path -
 * a broken build shows a raw `phone#+1555...` key, or a blank row, neither of
 * which this matches.
 */
function display(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

test('a stalled leg is named on the bubble: the rows say WHICH member never confirmed', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = `${Date.now()}`.slice(-6);
  const ANA = `+1555085${stamp.slice(-4)}`;
  const BEN = `+1555086${stamp.slice(-4)}`;
  const CAL = `+1555087${stamp.slice(-4)}`;
  const conversationId = conversationIdForGroup([ANA, BEN, CAL]);
  const reply = `Saturday still works ${stamp}`;

  await registerParty(request, { label: `Ana ${stamp}`, role: 'tenant', number: ANA });
  await sendGroupAsParty(request, {
    from: ANA,
    otherRecipients: [BEN, CAL],
    body: `All three of us are in ${stamp}`,
  });

  // The rail is created by a job, so wait for the Conversation to exist before
  // replying - without a rail the send is REFUSED, and a spec that raced it
  // would fail with a refusal message about something else entirely.
  await expect
    .poll(
      async () => (await listConversations(request)).some((c) => c.uniqueName === conversationId),
      { timeout: 20_000, message: 'the group rail was never created' },
    )
    .toBe(true);

  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${conversationId}`);
  await expect(page.getByText(/Everyone in this group text sees everyone's real number/)).toBeVisible(
    { timeout: 15_000 },
  );

  // ARMED LAST, immediately before the send. `takeDeliveryProfile` is ONE-SHOT
  // and is consumed by the NEXT message to that handset, so arming any earlier -
  // before the rail poll, before dev-login - risks spending it on an unrelated
  // message and leaving this send fully green.
  //
  // `kind: 'stall'` stalls at `sent`: the engine plans ['queued','sent'] and
  // skips index 0 (real Conversations never reports `queued` as a receipt), so
  // Ben's leg emits exactly ONE `sent` receipt and then goes silent - the 8/23
  // shape exactly. A leg stuck at `queued` is NOT armed here: the fixture's
  // documented signature does not expose the engine's `stallAt`, and that half
  // is proven in the unit layer instead of widening the seam.
  await setDeliveryOutcome(request, { partyNumber: BEN, profile: { kind: 'stall' } });

  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled();
  await composer.fill(reply);
  // EXACT: a tenant's contact page also carries a "+ Send" aside whose
  // accessible name is "Send a property to this tenant", so a substring match
  // on "Send" is a strict-mode violation - and only on a tenant's page.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const bubbleBody = page.getByText(reply);
  await expect(bubbleBody).toBeVisible({ timeout: 15_000 });

  // 1) The rollup settles at TWO of three and stops there, because the third
  //    receipt is never coming. NOT RELOADED, for the same reason every other
  //    rollup poll in this directory is not: a reload would make this pass
  //    against a product that pushed no SSE at all, which is a defect a previous
  //    wave actually shipped. The rollup must arrive on its own.
  await expect
    .poll(async () => page.getByText('delivered 2/3').count(), {
      timeout: 60_000,
      message:
        'the per-recipient rollup never settled at 2/3 LIVE (no reload) - either the stall was not armed or the SSE push is missing',
    })
    .toBeGreaterThan(0);

  // 2) THE LIST IS DISCLOSED, NOT STANDING. It is conditionally rendered on the
  //    bubble's local `revealed` state, so this absence is what makes the
  //    assertions below mean something.
  const list = page.getByRole('list', { name: 'Delivery by recipient' });
  await expect(list).toHaveCount(0);

  // The bubble is a bare div with no role, name or test id; clicking the body
  // text bubbles up to its toggle.
  await bubbleBody.click();
  await expect(list).toBeVisible({ timeout: 15_000 });

  // 3) EVERY member is named, and each is named against their OWN state. This is
  //    the assertion the whole feature exists for: "2 of 3" is a coin flip, and
  //    the 8/23 drop was lost on exactly that toss.
  await expect(list.getByRole('listitem')).toHaveCount(3);
  for (const delivered of [ANA, CAL]) {
    const row = list.getByRole('listitem').filter({ hasText: display(delivered) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Delivered');
  }
  const stalled = list.getByRole('listitem').filter({ hasText: display(BEN) });
  await expect(stalled).toHaveCount(1);
  await expect(stalled).toContainText('Sent');
  // ...and NOT delivered. `toContainText('Sent')` alone would still pass on a
  // build that labelled every row from the message-level status, so the row that
  // matters is pinned negatively too.
  await expect(stalled).not.toContainText('Delivered');

  // 4) No row leaks the wire key or claims a membership it cannot know. A
  //    `phone#` prefix on screen means the naming path was skipped entirely -
  //    the exact "blank or unreadable row" this feature exists to prevent.
  await expect(list).not.toContainText('phone#');
  await expect(list).not.toContainText('former member');
});
