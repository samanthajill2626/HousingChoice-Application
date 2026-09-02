import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutboundTo, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { expectTodayReady } from '../../support/today.js';

// RELAY 30003 PROMISES NO RETRY - the browser half of spec D19/D21
// (docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md).
//
// WHAT IS UNDER TEST. A relay fan-out leg that a carrier reports `undelivered`
// with ErrorCode 30003 used to read "Phone unreachable - will retry". No relay
// retry is scheduled - the status webhook returns on the relay-pointer branch
// before the 1:1 retry branch - so the promise was false, and this branch
// removes it while KEEPING the carrier code. The unit suites own the presenter
// rules and every product exclusion (a native group text, whose 30003 retry is
// real, keeps the promise). What only a real browser can establish is the
// end-to-end join: a real relay send, a real status callback landing in the
// member's slot, and all THREE render positions agreeing.
//
// THREE POSITIONS, NOT ONE (D21). One flag feeds the rollup chip, that chip's
// accessible name and the per-recipient row, and the whole content of D21 is
// that they cannot be allowed to disagree - so a spec asserting one of them
// does not test D21.
//
// THE PROVING ASSERTION IS THE NEGATIVE, `not.toContainText('will retry')`, at
// each position. The tail `(error 30003)` is asserted PRESENT at each position
// too: half of this change is that the carrier code survives, and a test that
// only checked the promise was gone would stay green if someone later moved
// 30003 into the internal-code map, which would silently delete the code an
// operator needs.
//
// LEAN LANE, deliberately. The group is built here from run-unique numbers via
// `createGroupOpen`, so nothing depends on the FULL demo profile (AGENTS.md
// fences full-profile assumptions out of lean tests). The cost of the lean lane
// is that creating a group texts an intro to every member, and
// `setDeliveryOutcome` is ONE-SHOT keyed on the DESTINATION number - so the
// intro must SETTLE before the arming, or the intro leg eats the armed profile
// and this send lands fully green. The settle pattern is relay-open-stop's.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// The settle barrier for the create-time intro fan-out: a substring of
// `relay.intro` (app/src/messages/catalog.ts). Matched as a substring so a
// future edit to the surrounding sentence does not silently un-settle the
// barrier; if this phrase itself is ever removed, this spec fails loudly at the
// settle rather than mysteriously at the chip.
const INTRO_NEEDLE = 'Use this group text';

// --- Per-run-unique phones ---------------------------------------------------
// +1 555 8XX XXXX, the same exchange relay-open-stop.spec.ts uses: the "8"
// exchange never collides with the fake's minted pool numbers (the "019"
// exchange) or with any seeded roster. The uid starts at 40 so a same-second
// run of this file and relay-open-stop (which starts at 1) cannot mint the same
// number - the fake's thread store is reset once per suite, at preflight, so a
// collision would cross-contaminate proof-of-send reads.
let uid = 40;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

/** Reseed the lane with the LEAN profile (this spec builds all its own data). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Fresh dev-login via the seeded VA (session minted AFTER the reseed so its
 *  cookie epoch matches the freshly re-seeded users table). */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Poll the fake's thread store until an outbound to `phone` FROM `from` whose
 *  body includes `needle` is observed - the happens-after barrier that makes the
 *  arming below land on the team send rather than on the create-time intro. */
async function expectOutboxIncludes(
  request: APIRequestContext,
  phone: string,
  needle: string,
  from: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const msgs = await getOutboundTo(request, { to: phone });
        return msgs.some((m) => (m.body ?? '').includes(needle) && m.from === from);
      },
      { timeout: 15_000, message: `the create-time intro to ${phone} never landed` },
    )
    .toBe(true);
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('a relay leg that failed 30003 promises no retry: chip, accessible name and row', async ({
  page,
  request,
}) => {
  test.slow(); // group create + connect-when-ready handshake + two 15s intro settles.
  await devLogin(page);

  // --- Arrange: a two-member OPEN relay group on one pool number. Both members
  //     are contactless {phone, name} participants, so each row is named by the
  //     member's own name (groupMemberLabel: name, else formatted number). ---
  const stamp = `${Date.now()}`.slice(-6);
  const unreachable = { phone: uniquePhone(), name: `Relay Unreachable ${stamp}` };
  const reachable = { phone: uniquePhone(), name: `Relay Reachable ${stamp}` };
  const group = await createGroupOpen(page, [unreachable, reachable]);
  const pool = group.pool_number;

  // SETTLE the create-time intro on BOTH members before arming. `setDeliveryOutcome`
  // is consumed by the NEXT message to that handset, so arming any earlier spends
  // it on the intro and leaves the send under test fully green.
  await expectOutboxIncludes(request, unreachable.phone, INTRO_NEEDLE, pool);
  await expectOutboxIncludes(request, reachable.phone, INTRO_NEEDLE, pool);

  // ARM one leg only: queued -> sent -> undelivered(30003). The other member is
  // left `normal` so the rollup has a real mixed state to summarize - a chip that
  // read "0/2 - 2 failed" would not prove the reason is attached to the failed
  // legs rather than to the bubble.
  await setDeliveryOutcome(request, {
    partyNumber: unreachable.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
  });

  // --- Act: a team send into the group. ---
  await page.goto(`${NEXT}/conversations/${group.conversationId}`);
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  const token = `relay-30003-${Date.now()}`;
  await composer.fill(token);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // The bubble is a bare div with no role, name or test id; its BODY is the only
  // addressable thing in it, and its parent is the bubble itself. Every assertion
  // below is scoped to that bubble so the create-time intro's own bubble - which
  // carries a delivery map of its own - can never satisfy one of them.
  const bubbleBody = page.getByText(token);
  await expect(bubbleBody).toBeVisible({ timeout: 15_000 });
  const bubble = bubbleBody.locator('xpath=..');

  // --- Assert 1: THE ROLLUP CHIP. role="img" is what lets the chip carry a name
  //     (a bare span maps to role=generic, on which ARIA prohibits one), and the
  //     rollup is the only such node in the bubble. NOT RELOADED: the receipt
  //     arrives over SSE, and a reload would make this pass against a product
  //     that pushed nothing. ---
  const rollup = bubble.getByRole('img');
  // The positive FIRST, with the headroom: asserting the negative before the
  // receipt has landed would pass on any build at all.
  await expect(rollup).toContainText('delivered 1/2 - 1 failed - Phone unreachable (error 30003)', {
    timeout: 60_000,
  });
  await expect(rollup).not.toContainText('will retry');

  // --- Assert 2: THE ACCESSIBLE NAME on that same chip - computed
  //     unconditionally, so it is what a screen-reader user gets from a bubble
  //     they cannot open. It recites every recipient, so the failed member is
  //     named against their own state here. ---
  await expect(rollup).toHaveAccessibleName(
    new RegExp(`${unreachable.name}: Undelivered, Phone unreachable \\(error 30003\\)`),
  );
  await expect(rollup).not.toHaveAccessibleName(/will retry/);

  // --- Assert 3: THE PER-RECIPIENT ROW. The list is CONDITIONALLY RENDERED on
  //     the bubble's local `revealed` state, so this absence is what makes the
  //     assertions after the click mean anything: written without the reveal they
  //     pass on a completely broken build (selectors.md:48-49). ---
  const list = bubble.getByRole('list', { name: 'Delivery by recipient' });
  await expect(list).toHaveCount(0);
  await bubbleBody.click();
  await expect(list).toBeVisible({ timeout: 15_000 });

  const failedRow = list.getByRole('listitem').filter({ hasText: unreachable.name });
  await expect(failedRow).toHaveCount(1);
  await expect(failedRow).toContainText('Undelivered - Phone unreachable (error 30003)');
  await expect(failedRow).not.toContainText('will retry');

  // The other member's row is the control: the override is scoped to a FAILED
  // leg's reason and must not have touched a delivered one.
  const deliveredRow = list.getByRole('listitem').filter({ hasText: reachable.name });
  await expect(deliveredRow).toHaveCount(1);
  await expect(deliveredRow).toContainText('Delivered');

  // One page-shaped sweep of the whole bubble, now that all three positions are
  // rendered at once: the promise appears NOWHERE on it.
  await expect(bubble).not.toContainText('will retry');
});
