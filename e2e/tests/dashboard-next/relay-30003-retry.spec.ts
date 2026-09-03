import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutboundTo, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { expectTodayReady } from '../../support/today.js';

// ONE FAILED RELAY LEG RETRIES TO DELIVERED, WITHOUT DUPLICATING - the browser
// half of spec D16/D19/D20/D21
// (docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md).
//
// WHAT IS UNDER TEST. A relay fan-out leg that a carrier reports `undelivered`
// with ErrorCode 30003 is now RETRIED to that member alone: the status webhook
// claims a retry by appending a new source row addressed to just that handset,
// and a backed-off job sends it. This spec is the end-to-end join no unit suite
// can make: a real relay send, a real status callback landing in the member's
// slot, a real claim, a real job, a real second send - and every render position
// agreeing about all of it, at both moments.
//
// THIS FILE WAS `relay-30003-no-retry-promise.spec.ts`. It pinned the OPPOSITE
// world - a 30003 that promised nothing because nothing retried. The promise it
// pinned OUT is still pinned out: `will retry` was, and remains, a native
// group-text string, and every `not.toContainText('will retry')` below is
// inherited unchanged. What moved is the positive half: a relay 30003 no longer
// reads `Undelivered`, it reads `Retrying` and then `Delivered on retry`.
//
// THREE POSITIONS, NOT ONE (D21). One derived retry state feeds the rollup chip,
// that chip's accessible-name recital and the per-recipient row, and the whole
// content of D21 is that they cannot be allowed to disagree - so a spec asserting
// one of them does not test D21. All three are asserted here, and the recital is
// asserted at BOTH moments.
//
// TWO MOMENTS, AND THE FIRST ONE IS THE POINT OF D16. The chip must read
// `1 retrying` BEFORE any backoff elapses: the claim emits its own SSE precisely
// so the surface never sits on a false terminal `1 failed` for a whole backoff
// interval. Asserting only the settled state would pass on a build that pushed
// nothing at claim time and let the browser find out when the retry landed.
//
// THE CARRIER CODE SURVIVES, and where it survives moved. On the settled chip it
// is gone by design (D19: `delivered 2/2 - 1 on retry` states no failure), so the
// old spec's `(error 30003)` check is preserved at the position that still owes
// it - the recital, while the rung is in flight, reading
// `Retrying, Phone unreachable (error 30003)`. Deleting that check would leave
// the build free to drop the code an operator needs.
//
// NO DUPLICATE SEND is the assertion a green chip cannot make (Sec 7 intention
// 7). The fake's thread store is read directly at the end: the reachable member
// received the body ONCE, the unreachable member exactly TWICE - the original
// leg, undelivered, then the retry, delivered.
//
// LEAN LANE, deliberately. The group is built here from run-unique numbers via
// `createGroupOpen`, so nothing depends on the FULL demo profile (AGENTS.md
// fences full-profile assumptions out of lean tests). The cost of the lean lane
// is that creating a group texts an intro to every member, and
// `setDeliveryOutcome` is ONE-SHOT keyed on the DESTINATION number - so the
// intro must SETTLE before the arming, or the intro leg eats the armed profile
// and this send lands fully green. That same one-shot property is what makes the
// retry land clean with no second arming call: the profile was consumed by the
// original leg, so the next message to that handset runs the normal
// queued -> sent -> delivered progression. The settle pattern is relay-open-stop's.
//
// THE LANE SHORTENS THE LADDER. `E2E_RELAY_RETRY_BACKOFF_MS` (set to 3000 in
// scripts/e2e-session.mjs's childEnv, read in app/src/jobs/registerHandlers.ts)
// replaces the 60/120/240 production ladder for this lane only, so rung 1 fires
// three seconds after the claim instead of sixty. It is configuration, not
// structural absence: production reads nothing and keeps its ladder.
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

test('a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts', async ({
  page,
  request,
}) => {
  test.slow(); // group create + connect-when-ready handshake + two 15s intro settles + the ladder.
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
  // legs rather than to the bubble. Arming is ONE-SHOT per destination, so the
  // ladder's rung 1 to this same handset needs no second call and no un-arming.
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
  // below is scoped to one of those bubbles so the create-time intro's own bubble
  // - which carries a delivery map of its own - can never satisfy one of them.
  //
  // TWO LOCATORS OFF ONE QUERY, and the split is load-bearing. The delivered
  // retry appends a SECOND row carrying the same raw body (D2/D12), so this query
  // resolves to two elements by the end of the test: `bubbles` is the COUNT
  // locator and must stay plural, while every single-element use goes through
  // `.first()` / `.nth()`. Calling `toBeVisible`, `xpath=..` or `.click()` on the
  // plural locator is a strict-mode violation the moment the retry lands.
  const bubbles = page.getByText(token);
  const original = bubbles.first();
  await expect(original).toBeVisible({ timeout: 15_000 });
  const originalBubble = original.locator('xpath=..');

  // --- Assert 1: THE CLAIM IS LIVE ON SCREEN BEFORE THE BACKOFF (D16).
  //     role="img" is what lets the chip carry a name (a bare span maps to
  //     role=generic, on which ARIA prohibits one), and the rollup is the only
  //     such node in the bubble. NOT RELOADED: the receipt and the claim both
  //     arrive over SSE, and a reload would make this pass against a product that
  //     pushed nothing. ---
  const rollup = originalBubble.getByRole('img');
  await expect(rollup).toBeVisible({ timeout: 30_000 });

  // ONE evaluate, not two assertions. The retrying window is only as long as the
  // lane's backoff, so reading the chip's text and its accessible name in two
  // polled assertions could straddle the retry landing and fail on a state that
  // was genuinely observed. Both facts are taken from ONE DOM instant, and the
  // name is read off `aria-label`, which is where `rollupName` is put
  // (Timeline.tsx, the role="img" span) - so this is the accessible name.
  let retryingText = '';
  let retryingName = '';
  await expect
    .poll(
      async () => {
        const seen = await rollup.evaluate((el) => ({
          text: el.textContent ?? '',
          name: el.getAttribute('aria-label') ?? '',
        }));
        if (seen.text.includes('1 retrying')) {
          retryingText = seen.text;
          retryingName = seen.name;
        }
        return retryingText;
      },
      {
        timeout: 30_000,
        // A TIGHT, FLAT CADENCE, deliberately. The retrying window is exactly as
        // long as the lane's backoff (3s) minus the SSE round trip, and the
        // default schedule has already widened to 1s intervals by the time the
        // claim lands - about three samples inside the window, fewer on a slow
        // machine. 250ms costs ~120 cheap evaluates at the ceiling and buys an
        // order of magnitude more chances to observe a state that is REAL.
        intervals: [250],
        message:
          'the rollup chip never read "1 retrying" - the claim must emit its own SSE (D16), ' +
          'not wait for the retry to land',
      },
    )
    .toContain('1 retrying');
  expect(retryingText, 'a relay 30003 never promises a retry in words').not.toContain('will retry');
  // The recital, at the SAME instant: the failed member is named against the
  // in-flight state AND against the carrier code. This is where the old spec's
  // `(error 30003)` check lives now - the settled chip states no failure, so it
  // carries no code, and only this position still owes one.
  expect(
    retryingName,
    'the recital must name the retrying member and keep the carrier code',
  ).toContain(`${unreachable.name}: Retrying, Phone unreachable (error 30003)`);
  expect(retryingName).not.toContain('will retry');

  // --- Assert 2: THE RETRY LANDS AND THE ORIGINAL BECOMES TRUTHFUL (D19). The
  //     failed leg is subtracted from `failed` and added to `delivered`, and the
  //     suffix says a ladder ran. ---
  await expect(rollup).toContainText('delivered 2/2 - 1 on retry', { timeout: 60_000 });
  await expect(rollup).not.toContainText('will retry');

  // --- Assert 3: A SECOND BUBBLE, addressed to the one member (D20 renders it
  //     only because its own leg delivered and the original was outbound). Its
  //     own chip says the same thing in its own voice, which is what keeps it
  //     from reading as a phantom second send (D22). The two chips reading
  //     DIFFERENT strings is also what proves `.first()` is the original. ---
  await expect(bubbles).toHaveCount(2);
  const retryBubble = bubbles.nth(1).locator('xpath=..');
  const retryRollup = retryBubble.getByRole('img');
  await expect(retryRollup).toContainText('delivered 1/1 on retry');
  await expect(retryBubble).not.toContainText('will retry');

  // --- Assert 4a: THE ACCESSIBLE NAME on the original's chip - computed
  //     unconditionally, so it is what a screen-reader user gets from a bubble
  //     they cannot open. It recites every recipient, so the retried member is
  //     named against their own settled state here. ---
  await expect(rollup).toHaveAccessibleName(
    new RegExp(`${unreachable.name}: Delivered on retry`),
  );
  await expect(rollup).not.toHaveAccessibleName(/will retry/);

  // --- Assert 4b: THE PER-RECIPIENT ROW. The list is CONDITIONALLY RENDERED on
  //     the bubble's local `revealed` state, so this absence is what makes the
  //     assertions after the click mean anything: written without the reveal they
  //     pass on a completely broken build (selectors.md:48-49). ---
  const list = originalBubble.getByRole('list', { name: 'Delivery by recipient' });
  await expect(list).toHaveCount(0);
  await original.click();
  await expect(list).toBeVisible({ timeout: 15_000 });

  const retriedRow = list.getByRole('listitem').filter({ hasText: unreachable.name });
  await expect(retriedRow).toHaveCount(1);
  await expect(retriedRow).toContainText('Delivered on retry');
  await expect(retriedRow).not.toContainText('will retry');
  // The reason belongs to the rung that failed, not to the member: once the
  // ladder delivered, the row states the outcome and drops the carrier code.
  await expect(retriedRow).not.toContainText('Undelivered');

  // The other member's row is the control: the ladder is scoped to the FAILED
  // leg and must not have touched a delivered one.
  const deliveredRow = list.getByRole('listitem').filter({ hasText: reachable.name });
  await expect(deliveredRow).toHaveCount(1);
  await expect(deliveredRow).toContainText('Delivered');

  // One page-shaped sweep of the whole bubble, now that all three positions are
  // rendered at once: the promise appears NOWHERE on it.
  await expect(originalBubble).not.toContainText('will retry');

  // --- Assert 5: NO DUPLICATE SEND (Sec 7 intention 7). The chip cannot prove
  //     this: a rollup counts SLOTS, and a ladder that re-fanned the whole
  //     message would still show one slot per member. Only the carrier's own view
  //     can tell a retry to ONE handset from a second fan-out. `getOutboundTo`
  //     returns that view oldest-first. ---
  const reachableSends = (await getOutboundTo(request, { to: reachable.phone })).filter((m) =>
    (m.body ?? '').includes(token),
  );
  expect(
    reachableSends.map((m) => m.state),
    'the reachable member must have received the body exactly once - a retry addresses ONE member',
  ).toEqual(['delivered']);

  const unreachableSends = (await getOutboundTo(request, { to: unreachable.phone })).filter((m) =>
    (m.body ?? '').includes(token),
  );
  expect(
    unreachableSends.map((m) => m.state),
    'the retried member must have exactly two legs: the original 30003, then the retry',
  ).toEqual(['undelivered', 'delivered']);
  expect(unreachableSends[0]?.errorCode).toBe('30003');
});
