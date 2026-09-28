import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { failList, failNextSend, getOutboundTo, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { readLogTail, type LogLine } from '../../fixtures/groupText.js';
import { expectTodayReady } from '../../support/today.js';
import { dashboardUrl } from '../../support/urls.js';

// A ONE-TO-ONE 30003 RETRY WHOSE OUTCOME IS UNKNOWN ENDS IN A VERDICT - FOUND,
// RE-DRIVEN ONCE, OR "RETRY NOT CONFIRMED" - AND NOBODY IS TEXTED TWICE: the
// browser half of retry-send-adoption, send-outcome Stage 1b
// (docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md, section 4
// items 17-19; R3, R4, R5, R6, R9, R11).
//
// WHAT IS UNDER TEST. A staff text the carrier reports undelivered with 30003
// schedules ONE automatic retry (messaging.retrySend, retry-send-window). That
// job now claims a send-attempt record before its provider call, and a retry
// whose provider outcome is UNKNOWN (the connection dropped: the text may or
// may not exist) is handed to the send.reconcile job as its fourth owner kind,
// `retry_send`. The reconcile looks the retry up at the provider - at most
// three checks - and decides:
//   17. accept_then_drop    -> FOUND: the retry text is adopted as the retry
//                              row, with its lineage and root; never re-sent.
//   18. drop_before_create  -> NEVER SENT: re-driven exactly once, delivered.
//   19. drop_before_create + fail-list x3 -> UNRESOLVED: nothing is re-sent,
//       the retried row's promise is WITHDRAWN and it reads "retry not
//       confirmed" with no Retry, and the manual Retry route refuses it.
//
// THE LANE SHORTENS BOTH CLOCKS (scripts/e2e-session.mjs childEnv):
// E2E_SEND_RETRY_BACKOFF_MS=10000 sends the retry 10 s after the failure, and
// E2E_SEND_RECONCILE_DELAYS_MS=2000,4000,8000 runs the three checks 2 / 4 / 8 s
// after the retry attempt. Both reach only a FRESHLY booted lane (`npm run
// e2e:restart` keeps the launcher's old environment); a lane without the
// backoff seam fails expectFailureStamped below with a message naming it.
//
// FOUR KINDS OF EVIDENCE, because each proves what the others cannot.
// - The SCREEN is the product claim, read on the contact page staff use.
// - The FAKE'S THREAD STORE (getOutboundTo) is the carrier's view: the only
//   proof that nobody was texted twice. A stored row cannot see a duplicate.
// - The STORED ROWS (GET /api/conversations/:id/messages - raw rows, newest
//   first) carry the lineage and the promise stamps.
// - The APP'S LOG TAIL (/__dev/logtail, WARN and up) names the PATH: the
//   never_sent WARN (18) and the unresolved ERROR (19). The job's unknown
//   hand-off and the reconcile's found verdict are INFO and never reach the
//   tail, so item 17's proof that the seam fired is the retried row's
//   REFRESHED retry_due_at: the hand-off moves the promise to attemptedAt +
//   8 s + 120 s, far past the failure's own +10 s stamp.
//
// THE ARMING ORDER IS THE TRAP. The 30003 profile is armed BEFORE the staff
// send, which consumes it. failNextSend (and failList) are armed AFTER the
// original's create has landed and BEFORE the retry fires 10 s after the
// failure: armed earlier, the ORIGINAL staff text would eat the drop. A
// drop_before_create ends a create before the fake records it, so it consumes
// no delivery profile, and the one re-drive (18) goes through normally.
//
// LOG SCOPE. Under accept_then_drop the fake's status callbacks reach the app
// before the adoption, and the status webhook may log an unknown-SID ERROR (an
// expected artifact - send-outcome-reconcile.spec.ts). Every log assertion
// here is scoped to event 'send_reconcile' AND this test's own retry_send
// owner; never "no ERROR" globally.
//
// RECIPIENTS. One fresh, consented tenant per test on a per-run number - never
// the lean seed's Dario (contact-tenant-0002 / conv-0002), and no fail seam is
// ever armed on a shared seed number: an arming no create consumed survives
// until the fake's once-per-suite reset. The staff text goes through the API
// send route, not the composer, so the arming window is deterministic; that
// route records no recipient, so every attempt here is PHONE-keyed.
//
// LEAN LANE: each test builds its own data on a freshly reseeded lean world,
// and the file restores that world on the way out.
const NEXT = dashboardUrl;

/** MessageBubble's Retry action (Timeline.tsx); visible text is a glyph + "Retry". */
const RETRY_BUTTON = 'Retry sending this message';
/** The one-to-one chip once the reconcile ruled the retry unresolved (R5). */
const UNCONFIRMED_CHIP = 'Undelivered - Phone unreachable - retry not confirmed (error 30003)';
/** The positive control's chip: a 30007 is never retried, so Retry is offered. */
const CONTROL_CHIP = 'Undelivered - Carrier filtered the message (error 30007)';
/** RETRY_PROMISE_WITHDRAWN_AT (app/src/lib/retrySendWindow.ts): the WITHDRAW's stamp. */
const WITHDRAWN_AT = '1970-01-01T00:00:00.000Z';
/** Production's first one-to-one rung (retryBackoffMs(1), app/src/jobs/retrySend.ts). */
const PRODUCTION_FIRST_RUNG_MS = 60_000;
/** How far past the failure's own stamp the hand-off's REFRESH must have moved
 *  the promise (plan Task 8): the refresh lands near +128 s, the failure at +10 s. */
const REFRESH_MARGIN_MS = 60_000;

const BODY_17 = 'Adoption check - please confirm your tour';
const BODY_18 = 'Redrive check - please confirm your tour';
const BODY_19 = 'Unconfirmed check - please confirm your tour';
const CONTROL_BODY = 'Control check - a text that is never retried';

// --- Per-run-unique phones ---------------------------------------------------
// +1 555 8XX XXXX, the exchange the relay and reconcile specs mint from. The
// uid starts at 90 - disjoint from the relay specs (0, 40) and
// send-outcome-reconcile.spec.ts (70) - so a same-second run of another file
// cannot mint a number this one uses: the fake's armings and thread store are
// reset only once per suite.
let uid = 90;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

/** The stored fields this file reads (raw MessageItem rows). */
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
  retry_root?: string;
  retry_outcome?: string;
  broadcast_id?: string;
  automated?: boolean;
}

/** A failed original whose promise this test captured before the retry ran. */
type StampedFailure = StoredMessage & { retry_due_at: string };

interface Tenant {
  contactId: string;
  phone: string;
}

/** Reseed the lane with the LEAN profile (every test builds its own data). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Dev-login as the seeded VA - AFTER the reseed, so the session's cookie epoch
 *  matches the freshly re-seeded users table. Every app API call below goes
 *  through `page.request`, which carries this session's cookie; the bare
 *  `request` fixture is for the fake and the log tail only. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A fresh tenant on a per-run number, WITH recorded consent (a person's send
 *  to an unconsented contact is refused): `verbal_in_person`, as
 *  send-outcome-reconcile.spec.ts records it. */
async function createConsentedTenant(api: APIRequestContext, firstName: string): Promise<Tenant> {
  const phone = uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Adoption', phone, voucherSize: 2 },
  });
  expect(res.ok(), `tenant create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), `consent failed: ${consent.status()} ${await consent.text()}`).toBeTruthy();
  return { contactId, phone };
}

/** The tenant's one-to-one thread: POST /api/contacts/:id/conversation answers
 *  200 { conversation } (create-or-get, the composer's own path). */
async function conversationFor(api: APIRequestContext, contactId: string): Promise<string> {
  const res = await api.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), `conversation create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).conversation.conversationId as string;
}

/** A person's text through the API send route: 201 { conversationId,
 *  providerSid, tsMsgId, status }. When it answers, the create has already
 *  passed the fake. */
async function sendStaffText(
  api: APIRequestContext,
  conversationId: string,
  body: string,
): Promise<{ tsMsgId: string; providerSid: string }> {
  const res = await api.post(`${NEXT}/api/conversations/${conversationId}/messages`, { data: { body } });
  expect(res.status(), `staff send failed: ${await res.text()}`).toBe(201);
  return (await res.json()) as { tsMsgId: string; providerSid: string };
}

/** The thread's stored rows: GET /api/conversations/:id/messages answers
 *  { messages }, newest first (a fresh thread is far shorter than one page). */
async function storedRows(api: APIRequestContext, conversationId: string): Promise<StoredMessage[]> {
  const res = await api.get(`${NEXT}/api/conversations/${conversationId}/messages?limit=100`);
  expect(res.ok(), `messages fetch failed: ${res.status()}`).toBeTruthy();
  const { messages } = (await res.json()) as { messages: StoredMessage[] };
  return messages;
}

/** Poll the thread's stored rows every 500 ms until `pick` accepts one. */
async function pollRow(
  api: APIRequestContext,
  conversationId: string,
  pick: (m: StoredMessage) => boolean,
  timeout: number,
  message: string,
): Promise<StoredMessage> {
  let found: StoredMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await storedRows(api, conversationId)).find(pick);
        return found !== undefined;
      },
      { timeout, intervals: [500], message },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`pollRow passed without a row: ${message}`);
  return found;
}

/** The happens-after barrier for arming a fail seam: the fake holds the
 *  original's create, so the create that consumes the arming is the retry's. */
async function expectCreateLanded(
  request: APIRequestContext,
  phone: string,
  body: string,
  since: string,
): Promise<void> {
  await expect
    .poll(async () => (await getOutboundTo(request, { to: phone, since })).filter((m) => m.body === body).length, {
      timeout: 10_000,
      message: 'the staff text never reached the fake',
    })
    .toBe(1);
}

/** The staff text's failure: undelivered 30003 WITH its retry promise, in the
 *  one write the webhook makes. Captured before the retry runs, so the promise
 *  is still the failure's own stamp - one lane backoff out, never a production
 *  rung and never the hand-off's refresh. */
async function expectFailureStamped(
  api: APIRequestContext,
  conversationId: string,
  tsMsgId: string,
): Promise<StampedFailure> {
  const row = await pollRow(
    api,
    conversationId,
    (m) => m.tsMsgId === tsMsgId && m.error_code === '30003' && typeof m.retry_due_at === 'string',
    20_000,
    'the staff text never failed 30003 with a retry promise',
  );
  const dueAt = row.retry_due_at ?? '';
  expect(row.delivery_status).toBe('undelivered');
  expect(
    Date.parse(dueAt) - Date.parse(row.provider_ts),
    'the captured promise sits a production rung past the send: the lane lacks E2E_SEND_RETRY_BACKOFF_MS ' +
      '(boot it fresh), or the capture came after the retry had already refreshed it',
  ).toBeLessThan(PRODUCTION_FIRST_RUNG_MS);
  return { ...row, retry_due_at: dueAt };
}

/** The reconcile's own WARN+ lines (`event: 'send_reconcile'`) since `since`
 *  for THIS test's retry_send owner - the thread's retry attempts. */
async function retryOwnerLines(
  request: APIRequestContext,
  since: string,
  conversationId: string,
): Promise<LogLine[]> {
  const lines = await readLogTail(request, { since, event: 'send_reconcile' });
  return lines.filter((l) => {
    const owner = l['owner'];
    if (typeof owner !== 'object' || owner === null) return false;
    const o = owner as Record<string, unknown>;
    return o['kind'] === 'retry_send' && o['conversationId'] === conversationId;
  });
}

/** One reconcile log line, reduced to what decides the path. */
interface VerdictLine {
  level: number;
  checkNo: unknown;
  verdict: unknown;
  cause: unknown;
}

async function verdictLines(
  request: APIRequestContext,
  since: string,
  conversationId: string,
): Promise<VerdictLine[]> {
  return (await retryOwnerLines(request, since, conversationId)).map((l) => ({
    level: l.level,
    checkNo: l['checkNo'] ?? null,
    verdict: l['verdict'] ?? null,
    cause: l['cause'] ?? null,
  }));
}

/** R9's log contract on every line the tail kept for this owner: the owner
 *  names the thread, the retried row, the attempt (a STRING) and the root; the
 *  recipient key is redacted; no line carries the tenant's number or the body. */
function expectRetryOwnerContract(
  lines: LogLine[],
  original: StoredMessage,
  conversationId: string,
  phone: string,
  body: string,
): void {
  for (const line of lines) {
    expect(line['owner']).toEqual({
      kind: 'retry_send',
      conversationId,
      retriedTsMsgId: original.tsMsgId,
      attempt: '1',
      retryRoot: original.tsMsgId,
    });
    expect(line['recipientKey']).toBe('phone#redacted');
  }
  const serialized = JSON.stringify(lines);
  expect(serialized, 'a reconcile line carries the tenant phone').not.toContain(phone.slice(1));
  expect(serialized, 'a reconcile line carries the message body').not.toContain(body);
}

/** Every rendered bubble carrying `body`. A bubble is a bare div with no role,
 *  name or test id; its body text is the only addressable thing in it and its
 *  parent is the bubble (selectors.md, the meta-reveal row). */
function bubblesWithBody(page: Page, body: string): Locator {
  return page.getByText(body, { exact: true }).locator('xpath=..');
}

/** The tenant's contact page, where staff read the thread. */
async function openContact(page: Page, contactId: string): Promise<void> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(page.getByRole('region', { name: 'Communications and activity' })).toBeVisible({
    timeout: 15_000,
  });
}

/** The retry's own bubble replaced the failed original (the Timeline's retry
 *  collapse): ONE bubble for the body, delivered, promising nothing. */
async function expectDeliveredRetryBubble(page: Page, body: string): Promise<void> {
  const bubbles = bubblesWithBody(page, body);
  await expect(bubbles.getByText('Delivered', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(bubbles, 'the retry row supersedes the failed original: one bubble for the body').toHaveCount(1);
  await expect(bubbles).not.toContainText('Undelivered');
  await expect(bubbles).not.toContainText('Phone unreachable');
  await expect(bubbles.getByRole('button', { name: RETRY_BUTTON })).toHaveCount(0);
  await expect(page.getByText(/will retry/)).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('17 accept_then_drop on a one-to-one 30003 retry: the retry text is adopted as the retry row with its lineage and root, the promise was refreshed at the hand-off, and the tenant got ONE retry text', async ({
  page,
  request,
}) => {
  test.slow(); // reseed + sign-in + tenant setup, the 10 s backoff, then the first check (2 s).
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const tenant = await createConsentedTenant(api, `Adopt${stamp}`);
  const conversationId = await conversationFor(api, tenant.contactId);

  // --- Arrange: the NEXT create to the tenant fails 30003 - the staff text's. ---
  await setDeliveryOutcome(request, {
    partyNumber: tenant.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
  });
  const since = new Date().toISOString();

  // --- Act: the staff text fails 30003 and its retry is scheduled 10 s out.
  //     Inside that wait the retry's create is armed to be RECORDED (its
  //     status callbacks fire) and then dropped: the job sees an unknown
  //     outcome and hands the attempt to the reconcile. ---
  const sent = await sendStaffText(api, conversationId, BODY_17);
  await expectCreateLanded(request, tenant.phone, BODY_17, since);
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'accept_then_drop' });
  const original = await expectFailureStamped(api, conversationId, sent.tsMsgId);

  // --- Assert 1: THE RETRY ROW. The reconcile found the retry text at the
  //     provider and appended it as the row the job would have appended: its
  //     lineage (retry_of, attempt 1, the window measured from the original's
  //     send), the chain root, a person's send retried as one, and no share
  //     attribution the original never had. Delivered: the provider's status
  //     at the adoption. ---
  const retry = await pollRow(
    api,
    conversationId,
    (m) => m.retry_of === original.tsMsgId && m.delivery_status === 'delivered',
    40_000,
    'the adopted retry row never read delivered (lane backoff 10 s + first check 2 s)',
  );
  expect(retry).toMatchObject({
    body: BODY_17,
    retry_attempt: 1,
    retry_root: original.tsMsgId,
    retry_window_start: original.provider_ts,
    automated: false,
  });
  expect(retry.broadcast_id).toBeUndefined();
  expect(
    (await storedRows(api, conversationId)).filter((m) => m.body === BODY_17),
    'exactly the original and ONE retry row',
  ).toHaveLength(2);

  // --- Assert 2: THE PATH. The seam fired: the unknown hand-off REFRESHED the
  //     retried row's promise to cover the reconcile's whole window - it now
  //     sits far past the failure's own stamp (the hand-off is INFO, so this
  //     stamp is its only trace on a lane). And the reconcile logged no WARN
  //     or ERROR for this owner: found is INFO - nothing was re-driven or
  //     closed unresolved. ---
  const refreshed = await pollRow(
    api,
    conversationId,
    (m) =>
      m.tsMsgId === original.tsMsgId &&
      Date.parse(m.retry_due_at ?? '') > Date.parse(original.retry_due_at) + REFRESH_MARGIN_MS,
    10_000,
    `the retried row's promise was never refreshed past ${original.retry_due_at} - did the unknown hand-off fire?`,
  );
  expect(refreshed.retry_outcome).toBeUndefined();
  expect(
    await verdictLines(request, since, conversationId),
    'an adopted retry leaves no WARN or ERROR verdict - it is neither re-driven nor closed unresolved',
  ).toEqual([]);

  // --- Assert 3: TEXTED ONCE MORE. The carrier holds the original (30003) and
  //     ONE retry - the recorded create the reconcile adopted. A reconcile
  //     that re-drove instead of adopting would make this three. ---
  const texts = (await getOutboundTo(request, { to: tenant.phone, since })).filter((m) => m.body === BODY_17);
  expect(
    texts.map((m) => m.state),
    'the tenant must hold the body exactly twice: the original 30003, then ONE retry',
  ).toEqual(['undelivered', 'delivered']);

  // --- Assert 4: THE SCREEN. The retry's bubble replaces the failed one. ---
  await openContact(page, tenant.contactId);
  await expectDeliveredRetryBubble(page, BODY_17);
});

test('18 drop_before_create on a one-to-one 30003 retry: never_sent at the third check, re-driven exactly once, the retry row delivered, and the tenant got ONE retry text', async ({
  page,
  request,
}) => {
  test.slow(); // setup, the 10 s backoff, all three checks (8 s), then the re-drive.
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const tenant = await createConsentedTenant(api, `Redrive${stamp}`);
  const conversationId = await conversationFor(api, tenant.contactId);

  await setDeliveryOutcome(request, {
    partyNumber: tenant.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
  });
  const since = new Date().toISOString();

  // --- Act: the retry's create is dropped BEFORE the fake records it. Every
  //     check finds nothing of this attempt's (the original, same body, is the
  //     retried row's own message - never adoptable), the final check rules
  //     never_sent and re-drives the same attempt at once; the drop was
  //     consumed, so the re-drive goes through. ---
  const sent = await sendStaffText(api, conversationId, BODY_18);
  await expectCreateLanded(request, tenant.phone, BODY_18, since);
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'drop_before_create' });
  const original = await expectFailureStamped(api, conversationId, sent.tsMsgId);

  // --- Assert 1: THE RETRY ROW, appended by the re-driven job's own send:
  //     the same lineage, root and flags as an automatic retry. ---
  const retry = await pollRow(
    api,
    conversationId,
    (m) => m.retry_of === original.tsMsgId && m.delivery_status === 'delivered',
    45_000,
    'the re-driven retry never read delivered (backoff 10 s + final check 8 s + the re-drive)',
  );
  expect(retry).toMatchObject({
    body: BODY_18,
    retry_attempt: 1,
    retry_root: original.tsMsgId,
    retry_window_start: original.provider_ts,
    automated: false,
  });
  expect(retry.broadcast_id).toBeUndefined();
  expect(
    (await storedRows(api, conversationId)).filter((m) => m.body === BODY_18),
    'exactly the original and ONE retry row',
  ).toHaveLength(2);

  // --- Assert 2: THE PATH. On screen a re-driven retry looks exactly like one
  //     that went out first time; the log tail does not. Checks 0 and 1 found
  //     nothing adoptable (INFO); the final check logged ONE WARN: never_sent,
  //     re-driven once. ---
  await expect
    .poll(async () => verdictLines(request, since, conversationId), {
      timeout: 10_000,
      message: 'the reconcile never ruled never_sent at the final check',
    })
    .toEqual([{ level: 40, checkNo: 2, verdict: 'never_sent', cause: null }]);
  expectRetryOwnerContract(
    await retryOwnerLines(request, since, conversationId),
    original,
    conversationId,
    tenant.phone,
    BODY_18,
  );

  // --- Assert 3: TEXTED ONCE MORE. The dropped create recorded nothing, so
  //     the one retry the carrier holds is the re-drive's. Two retries would
  //     be the double send this branch exists to prevent; none, a lost retry. ---
  const texts = (await getOutboundTo(request, { to: tenant.phone, since })).filter((m) => m.body === BODY_18);
  expect(
    texts.map((m) => m.state),
    'the tenant must hold the body exactly twice: the original 30003, then the ONE re-driven retry',
  ).toEqual(['undelivered', 'delivered']);

  // --- Assert 4: THE SCREEN. ---
  await openContact(page, tenant.contactId);
  await expectDeliveredRetryBubble(page, BODY_18);
});

test('19 drop_before_create plus fail-list x3: the retry closes unresolved, the retried row reads "retry not confirmed" with no Retry, the route refuses retry_unresolved, and nothing is re-sent', async ({
  page,
  request,
}) => {
  test.slow(); // setup, the 10 s backoff, all three checks (8 s), then the screen and a control send.
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const tenant = await createConsentedTenant(api, `Unsure${stamp}`);
  const conversationId = await conversationFor(api, tenant.contactId);

  await setDeliveryOutcome(request, {
    partyNumber: tenant.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
  });
  const since = new Date().toISOString();

  // --- Act: the retry's create is dropped before anything is recorded
  //     (unknown), AND every lookup of that number fails for the whole window
  //     - one failed list per check, three checks. The platform cannot tell
  //     whether the retry went out, so it must neither re-send it nor offer a
  //     manual Retry that could text the tenant a second time. ---
  const sent = await sendStaffText(api, conversationId, BODY_19);
  await expectCreateLanded(request, tenant.phone, BODY_19, since);
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'drop_before_create' });
  await failList(request, { partyNumber: tenant.phone, count: 3 });
  const original = await expectFailureStamped(api, conversationId, sent.tsMsgId);

  // --- Assert 1: THE WITHDRAWAL. The final check closed the attempt
  //     unresolved and withdrew the retried row's promise: the withdrawn
  //     stamp AND retry_outcome 'unconfirmed', in one write. The failure
  //     itself is untouched. ---
  const closed = await pollRow(
    api,
    conversationId,
    (m) => m.tsMsgId === original.tsMsgId && m.retry_outcome === 'unconfirmed',
    45_000,
    'the retried row never read retry_outcome unconfirmed (backoff 10 s + final check 8 s)',
  );
  expect(closed.retry_due_at).toBe(WITHDRAWN_AT);
  expect(closed).toMatchObject({ delivery_status: 'undelivered', error_code: '30003' });

  // --- Assert 2: THE PATH. A failed lookup WARN at checks 0 and 1, then ONE
  //     ERROR at the final check naming the cause - the provider was
  //     unreachable for the whole window. ---
  await expect
    .poll(async () => verdictLines(request, since, conversationId), {
      timeout: 10_000,
      message: 'the reconcile never closed the retry unresolved at the final check',
    })
    .toEqual([
      { level: 40, checkNo: 0, verdict: null, cause: null },
      { level: 40, checkNo: 1, verdict: null, cause: null },
      { level: 50, checkNo: 2, verdict: 'unresolved', cause: 'provider_unreachable' },
    ]);
  expectRetryOwnerContract(
    await retryOwnerLines(request, since, conversationId),
    original,
    conversationId,
    tenant.phone,
    BODY_19,
  );

  // --- Assert 3: THE ROUTE REFUSES. A press on the unresolved row (a stale
  //     tab or a direct call: the screen offers none) is refused - the retry
  //     may have reached the tenant and nobody knows. ---
  const press = await api.post(
    `${NEXT}/api/conversations/${conversationId}/messages/${original.provider_sid}/retry`,
  );
  expect(press.status(), 'a Retry on an unresolved retry must be refused').toBe(409);
  expect(await press.json()).toEqual({ error: 'retry_unresolved' });

  // --- Assert 4: NEVER RE-SENT. The drop recorded nothing, the final check
  //     closed the attempt instead of re-driving it, and the refused press
  //     sent nothing: the carrier holds the original alone, and the thread
  //     stores no retry row. The verdict above was the LAST check. ---
  const texts = (await getOutboundTo(request, { to: tenant.phone, since })).filter((m) => m.body === BODY_19);
  expect(texts.map((m) => m.state), 'the tenant must hold the body exactly once: the original 30003').toEqual([
    'undelivered',
  ]);
  expect((await storedRows(api, conversationId)).filter((m) => m.body === BODY_19)).toHaveLength(1);

  // --- Assert 5: THE SCREEN. The failed bubble stays (nothing supersedes it),
  //     reads "retry not confirmed", and offers NO Retry - taken in ONE
  //     locator, chip and absence together. Nothing promises a retry. ---
  await openContact(page, tenant.contactId);
  const unconfirmed = bubblesWithBody(page, BODY_19).filter({ hasText: UNCONFIRMED_CHIP });
  await expect(unconfirmed, 'the unresolved retry never read "retry not confirmed"').toHaveCount(1, {
    timeout: 15_000,
  });
  const retryAction = page.getByRole('button', { name: RETRY_BUTTON });
  await expect(unconfirmed.filter({ hasNot: retryAction })).toHaveCount(1);
  await expect(page.getByText(/will retry/)).toHaveCount(0);

  // --- Assert 6: POSITIVE CONTROL for Assert 5 (selectors.md, the one-to-one
  //     row): a failure with no retry scheduled (30007, never retried) shows
  //     the SAME action under the SAME name on the same page, so Assert 5's
  //     absence could have failed. Do NOT press it. ---
  await setDeliveryOutcome(request, {
    partyNumber: tenant.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30007' },
  });
  const control = await sendStaffText(api, conversationId, CONTROL_BODY);
  await pollRow(
    api,
    conversationId,
    (m) => m.tsMsgId === control.tsMsgId && m.error_code === '30007',
    20_000,
    'the control text never failed 30007',
  );
  await openContact(page, tenant.contactId);
  const controlBubble = bubblesWithBody(page, CONTROL_BODY).filter({ hasText: CONTROL_CHIP });
  await expect(controlBubble, 'the control text never rendered its 30007 failure').toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(controlBubble.getByRole('button', { name: RETRY_BUTTON })).toBeVisible();
  await expect(
    bubblesWithBody(page, BODY_19).filter({ hasText: UNCONFIRMED_CHIP }).filter({ hasNot: retryAction }),
    'beside the control, the unresolved bubble still offers no Retry',
  ).toHaveCount(1);
});
