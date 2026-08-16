import { test, expect, type Page } from '@playwright/test';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { postInboundSms, listThreads } from '../../fixtures/fakeTwilio.js';
import { dashboardUrl } from '../../support/urls.js';

// Thread history paging (design section 5.2; plan Task 8). Proves an operator can
// reach relay-group messages OLDER than the newest server page: the newest page
// renders, the oldest message is absent, one "Load older messages" click brings it
// in, and the control retires once the history is exhausted.
//
// WHY A RELAY GROUP, NOT A 1:1: /conversations/:id REDIRECTS a plain 1:1 to its
// owning contact page (ConversationDetail.tsx:155-159), which runs
// useContactTimeline - the authoritative-cursor path. A relay group renders
// RelayGroupView -> useRelayThread at its own URL, which is the `before`-paging
// path with the page-size hasOlder heuristic: the riskier half of this change, and
// the half that would otherwise have no end-to-end coverage at all.
//
// DELIBERATE OMISSION: unlike the other world-building relay specs, this one does
// NOT reseed lean in beforeEach or restore it in afterAll. It builds every row it
// asserts on and every identifier is per-run unique, so it neither depends on nor
// disturbs the lean baseline; under workers: 1 / fullyParallel: false the two extra
// reseeds would be pure cost.
const NEXT = dashboardUrl;

// --- Per-run-unique phones + inbound SIDs ------------------------------------
// +1 555 8XX XXXX: the "8" exchange never collides with the fake's minted pool
// numbers (the "019" exchange - see POOL_NUMBER_RE in e2e/scenarios/steps.ts) or
// the seeded rosters. This is the settled RELAY idiom; the 1:1 specs' +1555<5 clock
// digits> generator can land on 019 and is deliberately NOT used here.
//
// Unique MessageSids are required because the inbound webhook dedupes by SID: the
// 55 inbounds below must be mutually unique WITHIN this run, and the spec must also
// survive a long-lived e2e:session lane, which is not reseeded between invocations.
// (A normal `npm run e2e` does clear the `sid#` pointers - globalSetup POSTs
// /__dev/reseed, which wipes the tables - so this is not a first-run-only concern.)
let uid = 0;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}
function uniqueSid(tag: string): string {
  uid += 1;
  return `SMhist${tag}${Date.now()}${uid}`;
}

/** Fresh dev-login via the seeded VA; page.request then shares the authenticated
 *  context for the /api calls below. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

// 55 inbounds on top of the ONE message a createGroupOpen group already carries -
// the relay.intro system announcement, persisted on both provisioning paths
// (relayProvisioning.ts:180 and relayNumberReady.ts:176 both enqueue relay.intro;
// relayAnnouncements.ts appends exactly one row per announcement). So the thread
// holds 56 entries: the newest page is 50 (probes 5..54, with the intro sitting
// wherever its async send landed), and ONE older page returns the remaining 6.
const TOTAL = 55;

test('staff can reach relay-group messages older than the newest page', async ({ page }) => {
  // The default per-test budget is 30s with retries: 0, and createGroupOpen's FRESH
  // path alone polls up to 30s for a warming pool number and then up to 60s for the
  // group to open - before this spec sends its 55 inbounds. The closing drain-wait
  // then costs up to another ~55s at the 1/sec A2P rate, so the budget covers the
  // fresh path AND a full drain rather than only the reuse path.
  test.setTimeout(300_000);
  await devLogin(page);

  // TWO members: every existing createGroupOpen caller passes two or three, and the
  // fixture describes the fresh path as "a fresh pair".
  const member = uniquePhone();
  const landlord = uniquePhone();
  const group = await createGroupOpen(page, [
    { phone: member, name: 'History Probe' },
    { phone: landlord, name: 'History Landlord' },
  ]);

  // Build the long thread. Sequential: each inbound needs a unique SID and the ORDER
  // is what the assertions depend on.
  for (let i = 0; i < TOTAL; i += 1) {
    const res = await postInboundSms(page.request, {
      from: member,
      to: group.pool_number,
      body: `history probe ${i}`,
      messageSid: uniqueSid(`${i}`),
    });
    expect(res.status, `inbound ${i} accepted`).toBe(200);
  }

  await page.goto(`${NEXT}/conversations/${group.conversationId}`);

  // The newest page is present; the oldest message is beyond it.
  await expect(page.getByText(`history probe ${TOTAL - 1}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('history probe 0')).toHaveCount(0);

  const loadOlder = page.getByRole('button', { name: 'Load older messages' });
  await expect(loadOlder).toBeVisible();

  // --- The reader must not move when older history lands (design 4.5) --------
  // This is the feature's headline promise and the ONLY check of it in an engine
  // that performs layout: every unit test of the anchor arithmetic runs in jsdom,
  // which does no layout, and all of them sit at scroll offset 0.
  //
  // MID-THREAD ON PURPOSE. Offset 0 is exactly where Chromium suppresses its own
  // CSS scroll anchoring, so it is the one position at which a double
  // compensation - the browser adjusting scrollTop for the prepend AND
  // Timeline.tsx's layout effect adding its own delta on top - would hide.
  // `.stream` carries `overflow-anchor: none` to make the manual correction the
  // only correction; this assertion is what keeps that true.
  //
  // Reached by CSS-module class, unavoidably: the scroll container is a plain
  // <div> with no accessible role of its own. Vite scopes CSS-module locals as
  // `_<local>_<hash>_<line>`, so `_stream_` (note the trailing underscore) matches
  // `.stream` and NOT `.streamWrap`, its non-scrolling flex parent.
  const stream = page.locator('[class*="_stream_"]');
  await expect(stream).toHaveCount(1);
  await stream.evaluate((el) => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
  });
  // The scroll event Chromium fires for that assignment is also what tells
  // <Timeline> the operator is no longer pinned to the bottom; polling until the
  // offset sticks waits for it without a bare timeout.
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const before = await stream.evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
  }));
  const distanceFromBottom = before.height - before.client - before.top;
  expect(distanceFromBottom, 'parked mid-thread, not at the bottom').toBeGreaterThan(0);

  await loadOlder.click();

  // The oldest message is now reachable and the control has retired for good -
  // assert on BOTH labels, since an in-flight control is merely relabeled.
  await expect(page.getByText('history probe 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Loading...' })).toHaveCount(0);

  // The prepend grew the stream; the reader's position must have moved by EXACTLY
  // that growth, which is what "the bubble you were reading did not move" means in
  // arithmetic. Under-compensating (no correction at all) leaves the delta at ~0;
  // double-compensating leaves it at roughly twice the growth. Tolerance is 2 CSS
  // px: `scrollHeight` is integer-rounded while the real content height is
  // fractional, and Chromium can hold a fractional `scrollTop` - so the exact
  // arithmetic can be off by about a pixel. Both failure modes are hundreds of
  // pixels away (six restored messages), so 2px cannot mask either.
  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight), { timeout: 10_000 })
    .toBeGreaterThan(before.height);
  const after = await stream.evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
  }));
  const growth = after.height - before.height;
  expect(
    Math.abs(after.top - (before.top + growth)),
    `reader moved: scrollTop ${before.top} -> ${after.top} while scrollHeight grew by ${growth}`,
  ).toBeLessThanOrEqual(2);

  // DRAIN OUR OWN BACKLOG BEFORE LEAVING. Each of the 55 inbounds above enqueues a
  // relay fan-out leg to the other member, and every SMS job - relay fan-out,
  // broadcast send, missed-call auto-text - acquires from ONE shared A2P token
  // bucket (app/src/jobs/registerHandlers.ts: "SMS handlers share tokenBucket so
  // the COMBINED outbound rate stays under the limit") refilling at
  // A2P_RATE_LIMIT_PER_SEC, default 1.0/sec. The inbound POSTs return as soon as the
  // row is persisted and the job is enqueued, so without this wait the test reports
  // "ok" in ~4s while ~55s of paced sending is still queued behind it.
  //
  // That is not theoretical: it made voice-transcription.spec.ts:151 fail in the
  // full suite. Its missed-call auto-text queued behind our legs and blew its own
  // 20s budget, while the same spec passed 4/4 in isolation. Draining here bounds
  // the interference to this test's own runtime instead of leaking it into whichever
  // spec runs next.
  await expect
    .poll(
      async () => {
        const threads = await listThreads(page.request);
        const toLandlord = threads.find((t) => t.partyNumber === landlord);
        return (toLandlord?.messages ?? []).filter((m) => m.direction === 'outbound').length;
      },
      {
        timeout: 120_000,
        intervals: [1000],
        message: 'relay fan-out legs did not drain - later specs would inherit the token backlog',
      },
    )
    .toBeGreaterThanOrEqual(TOTAL);
});
