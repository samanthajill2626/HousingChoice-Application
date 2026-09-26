import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { getOutboundTo, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

// A ONE-TO-ONE 30003 PROMISES ITS RETRY WITH THE FAILURE, HIDES THE RETRY
// ACTION FOR THE WAIT, AND THE RETRY'S OWN BUBBLE REPLACES THE FAILED ONE -
// test intention 8 of docs/superpowers/specs/2026-09-24-retry-send-window-design.md
// (D3a, D6, D7, D8, D10, D13, D14). No one-to-one retry spec existed before
// this file; the relay ladder has its own (relay-30003-retry.spec.ts).
//
// WHAT IS UNDER TEST. A staff text from the contact page that the carrier
// reports `undelivered` with ErrorCode 30003. The status webhook decides
// whether a retry will be attempted BEFORE it writes the failure (D3a) and
// writes the failure and `retry_due_at` in ONE conditional write (D7), so the
// transition's single SSE carries both. The bubble must therefore read
// "Phone unreachable - will retry (error 30003)" the first time it reads as a
// failure at all - never a plain failure that later turns into a promise
// (spec section 1) - and must offer NO Retry action while that retry is
// scheduled (D10). The page is never reloaded: every state below arrives over
// SSE, which is the path under test. The contact page renders the chip with
// the Timeline's DEFAULT rosterKind ('relay'), which is exactly why the
// one-to-one chip must never pass the `relay` flag (D8).
//
// When the backed-off `messaging.retrySend` job sends, its row carries
// `retry_of` from the moment it is appended (D6), and the Timeline's retry
// collapse hides the original, so the thread keeps ONE bubble for the body:
// the retry's, delivered.
//
// THE RECIPIENT IS THE LEAN SEED'S TASHA NGUYEN (contact-tenant-0001,
// conv-0001) AND NEVER DARIO REYES (contact-tenant-0002, conv-0002), whose
// thread is switched off on purpose and whom the seed forbids as the
// recipient of any automated text or retry (spec D13, app/src/lib/seed/lean.ts).
// conv-0001 carries no `ai_mode`, which reads as auto. A composer send is a
// person's send, so its retry goes out as a person's send too (D14); the
// manual-mode half of D14 and every declined retry are proven below this
// layer (D13).
//
// THE LANE SHORTENS THE BACKOFF. E2E_SEND_RETRY_BACKOFF_MS (10000 in
// scripts/e2e-session.mjs's childEnv, read by resolveSendRetryBackoffMs in
// app/src/jobs/retrySend.ts, ignored whenever JOBS_QUEUE_URL is set) replaces
// the 60 s first rung, so the retry goes out ten seconds after the failure.
// That value is also this file's observation window for the promise. The
// stored `retry_due_at` is checked against it, so a lane booted without the
// seam fails with a message that names it instead of timing out. If the
// promise assertions ever go flaky, raise the lane value (and the relay one
// beside it) - NEVER weaken the assertions, which are the point of the file.
//
// ARMING IS ONE-SHOT PER DESTINATION (fixtures/fakeTwilio.ts
// setDeliveryOutcome): the armed 30003 is consumed by the original send, so
// the retry to the same handset runs the normal queued -> sent -> delivered
// progression with no second call.
//
// THE RETRY ACTION'S ABSENCE MEANS SOMETHING ONLY AT THE SAME INSTANT AS THE
// PROMISE. The action is not behind the bubble's reveal (it renders on every
// failed one-to-one bubble with no live promise), but once the retry lands the
// failed bubble is hidden, and a lazily re-resolved locator would find the
// delivered retry's bubble - which has no action either. So the absence is
// asserted in ONE locator filtered on the promise text AND on the action, and
// a positive control at the end proves the same accessible name IS found on a
// failed bubble that promises nothing: a 30007, which is never retried.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The lean seed's Tasha and her one-to-one thread. NEVER Dario - see above. */
const TASHA = {
  contactId: 'contact-tenant-0001',
  conversationId: 'conv-0001',
  phone: '+15550100001',
} as const;

/** MessageBubble's Retry action (Timeline.tsx); visible text is a glyph + "Retry". */
const RETRY_BUTTON = 'Retry sending this message';
/** The one-to-one chip while a retry is scheduled: the delivery label, then the
 *  reason with the template's code tail (spec section 7 copy). */
const PROMISE_CHIP = 'Undelivered - Phone unreachable - will retry (error 30003)';
/** The base 30003 reason, which promises nothing (spec D8). */
const PLAIN_30003 = 'Phone unreachable (error 30003)';
/** The control failure: 30007 is never retried (spec section 8). */
const CONTROL_CHIP = 'Undelivered - Carrier filtered the message (error 30007)';
/** E2E_SEND_RETRY_BACKOFF_MS on the lane (scripts/e2e-session.mjs). */
const LANE_BACKOFF_MS = 10_000;
/** Production's first one-to-one rung (retryBackoffMs(1), app/src/jobs/retrySend.ts). */
const PRODUCTION_FIRST_RUNG_MS = 60_000;

/** The stored fields this file reads. GET /api/conversations/:id/messages
 *  returns raw MessageItem rows, newest first. */
interface StoredMessage {
  tsMsgId: string;
  body?: string;
  provider_sid: string;
  provider_ts: string;
  delivery_status: string;
  error_code?: string;
  retry_of?: string;
  retry_attempt?: number;
  retry_window_start?: string;
  retry_due_at?: string;
  automated?: boolean;
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Tasha's stored rows whose body is exactly `body` (the reseed keeps her
 *  thread far shorter than one page). */
async function storedRows(request: APIRequestContext, body: string): Promise<StoredMessage[]> {
  const res = await request.get(`${NEXT}/api/conversations/${TASHA.conversationId}/messages?limit=100`);
  expect(res.ok(), `messages fetch failed: ${res.status()}`).toBeTruthy();
  const { messages } = (await res.json()) as { messages: StoredMessage[] };
  return messages.filter((m) => m.body === body);
}

/** Every rendered bubble carrying `body`. A bubble is a bare div with no role,
 *  name or test id; its body text is the only addressable thing in it and its
 *  parent is the bubble (selectors.md, the meta-reveal row). PLURAL on purpose:
 *  for a beat during a send the optimistic bubble can sit beside the server's. */
function bubblesWithBody(page: Page, body: string): Locator {
  return page.getByText(body, { exact: true }).locator('xpath=..');
}

/** Send `body` from the open contact page's composer - a person's send. */
async function sendFromComposer(page: Page, body: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill(body);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

// A clean lean world first: an earlier spec can leave Tasha opted out or a
// scheduled text aimed at her handset, which would eat the one-shot arming.
test.beforeEach(async ({ request }) => {
  await reseed(request);
});

// Failure hygiene for the specs after this file. A run that died before its
// send leaves the arming unconsumed (a reseed never touches the fake; re-arming
// `normal` replaces a pending profile), and a run that died during the wait
// leaves a retry job pending - after the reseed it finds no original to retry.
test.afterAll(async ({ request }) => {
  await setDeliveryOutcome(request, { partyNumber: TASHA.phone, profile: { kind: 'normal' } });
  await reseed(request);
});

test('a one-to-one 30003 promises its retry with the failure and hides Retry, then the retry replaces the failed bubble', async ({
  page,
  request,
}) => {
  test.slow(); // reseed + sign-in + the lane backoff + a second send for the control.
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${TASHA.contactId}`);
  await expect(page.getByRole('region', { name: 'Communications and activity' })).toBeVisible({
    timeout: 15_000,
  });

  // --- Arrange: the NEXT message to Tasha's handset fails 30003. ---
  await setDeliveryOutcome(request, {
    partyNumber: TASHA.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
  });

  // --- Act: a staff text from her contact page. ---
  const token = `one-to-one-30003-${Date.now()}`;
  await sendFromComposer(page, token);
  const bubbles = bubblesWithBody(page, token);

  // --- Assert 1: the promise arrives WITH the failure (spec section 1, D7).
  //     A tight, flat cadence samples the bubble from the send until the
  //     promise shows; any sample that shows the PLAIN 30003 first is the
  //     "plain failure that later turns into will retry" the ruling forbids.
  //     A sampled negative, not a proof - a regression tripwire. ---
  let sawPlainFailure = false;
  await expect
    .poll(
      async () => {
        const texts = await bubbles.allTextContents();
        if (texts.some((t) => t.includes(PLAIN_30003))) sawPlainFailure = true;
        return texts.some((t) => t.includes(PROMISE_CHIP));
      },
      {
        timeout: 20_000,
        intervals: [100],
        message:
          'the bubble never read "Phone unreachable - will retry (error 30003)" - is the 30003 arm ' +
          'stamping retry_due_at (D7) and the Timeline passing retryScheduled (D8)?',
      },
    )
    .toBe(true);
  expect(
    sawPlainFailure,
    'the bubble showed the plain 30003 before its promise - the failure and retry_due_at must land ' +
      'in ONE write (D7) and the screen must never turn a plain failure into "will retry"',
  ).toBe(false);

  // --- Assert 2: NO Retry action while the retry is scheduled (D10), taken
  //     at the SAME instant as the promise text: one locator, both filters. ---
  const promised = bubbles
    .filter({ hasText: PROMISE_CHIP })
    .filter({ hasNot: page.getByRole('button', { name: RETRY_BUTTON }) });
  await expect(
    promised,
    'a one-to-one bubble promising a retry must offer NO Retry action at the same instant (D10)',
  ).toHaveCount(1);

  // --- Assert 3: the stored failure carries the stamp, one LANE backoff out
  //     (D7, D13), and a Retry pressed during the wait - a stale tab, since
  //     the live screen hides the action - is refused on the server's clock
  //     (D10). Rows are picked by lineage, never by count, so a retry that
  //     lands early cannot break the read. ---
  const original = (await storedRows(page.request, token)).find((m) => m.retry_of === undefined);
  if (original === undefined) throw new Error('the failed original is not stored in conv-0001');
  expect(original.delivery_status).toBe('undelivered');
  expect(original.error_code).toBe('30003');
  expect(original.automated, "a composer text is a person's send (D14)").toBe(false);
  const originMs = Date.parse(original.provider_ts);
  const dueMs = Date.parse(original.retry_due_at ?? '');
  expect(Number.isNaN(dueMs), 'the failed row carries no parseable retry_due_at (D7)').toBe(false);
  expect(dueMs - originMs, 'retry_due_at must sit at least one lane backoff after the send').toBeGreaterThanOrEqual(
    LANE_BACKOFF_MS,
  );
  expect(
    dueMs - originMs,
    'retry_due_at sits a PRODUCTION rung out - is E2E_SEND_RETRY_BACKOFF_MS set on this lane (Task 9)?',
  ).toBeLessThan(PRODUCTION_FIRST_RUNG_MS);
  const pressed = await page.request.post(
    `${NEXT}/api/conversations/${TASHA.conversationId}/messages/${original.provider_sid}/retry`,
  );
  expect(pressed.status(), 'a Retry pressed while a retry is scheduled must be refused (D10)').toBe(409);
  expect(await pressed.json()).toMatchObject({ error: 'retry_pending' });

  // --- Assert 4: after the lane backoff the retry's OWN bubble replaces the
  //     failed one: one bubble for the body, delivered, no failure, no action. ---
  await expect(
    bubbles.getByText('Delivered', { exact: true }),
    'the automatic retry never delivered into the thread (lane backoff 10 s)',
  ).toBeVisible({ timeout: 45_000 });
  await expect(bubbles).toHaveCount(1);
  const retryBubble = bubbles.first();
  await expect(retryBubble).not.toContainText('Undelivered');
  await expect(retryBubble).not.toContainText('Phone unreachable');
  await expect(retryBubble.getByRole('button', { name: RETRY_BUTTON })).toHaveCount(0);

  // --- Assert 5: the carrier's own view - exactly two legs, the original 30003
  //     and ONE automatic retry. The screen cannot prove "no duplicate send". ---
  const legs = (await getOutboundTo(request, { to: TASHA.phone })).filter((m) => m.body === token);
  expect(
    legs.map((m) => m.state),
    'the handset must have received the body exactly twice: the original 30003, then the retry',
  ).toEqual(['undelivered', 'delivered']);
  expect(legs[0]?.errorCode).toBe('30003');

  // --- Assert 6: the replacing row IS the retry, lineage written at append:
  //     retry_of, attempt 1, the window origin carried from the original's
  //     send (D2, D6), a person's send retried as one (D14), and sent no
  //     earlier than its stamped run time (D7: retry_due_at is the run time;
  //     provider_ts is second-truncated, hence the one-second allowance). ---
  const rows = await storedRows(page.request, token);
  expect(
    rows,
    'exactly the original and ONE retry row - a third row means the Retry pressed during the wait was NOT refused (D10)',
  ).toHaveLength(2);
  const retry = rows.find((m) => m.retry_of !== undefined);
  if (retry === undefined) throw new Error('no stored row carries retry_of');
  expect(retry.retry_of).toBe(original.tsMsgId);
  expect(retry.retry_attempt).toBe(1);
  expect(retry.retry_window_start, 'the retry measures its window from the original send (D2)').toBe(
    original.provider_ts,
  );
  expect(retry.automated, "a person's text is retried as a person's send (D14)").toBe(false);
  expect(retry.delivery_status).toBe('delivered');
  expect(Date.parse(retry.provider_ts), 'the retry went out before its stamped run time').toBeGreaterThanOrEqual(
    dueMs - 1_000,
  );

  // --- Assert 7: POSITIVE CONTROL for Assert 2. A failure with no scheduled
  //     retry (30007, never retried) shows the SAME action under the SAME name,
  //     so Assert 2's absence could have failed. Do NOT press it. ---
  await setDeliveryOutcome(request, {
    partyNumber: TASHA.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30007' },
  });
  const control = `one-to-one-30007-control-${Date.now()}`;
  await sendFromComposer(page, control);
  const controlBubble = bubblesWithBody(page, control).filter({ hasText: CONTROL_CHIP });
  await expect(controlBubble, 'the control text never failed with 30007').toHaveCount(1, { timeout: 15_000 });
  await expect(controlBubble.getByRole('button', { name: RETRY_BUTTON })).toBeVisible();
  await expect(controlBubble).not.toContainText('will retry');
});
