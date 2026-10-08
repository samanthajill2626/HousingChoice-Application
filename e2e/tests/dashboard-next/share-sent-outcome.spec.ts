import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { failList, failNextSend, getOutboundTo, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { statValue, statusPill } from '../../support/broadcastSelectors.js';
import { expectTodayReady } from '../../support/today.js';
import { dashboardUrl } from '../../support/urls.js';

// A PROPERTY SEND TELLS ONE TRUE STORY PER TENANT - the browser half of
// share-sent-outcome (Branch B of the share-skip mission):
// docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md, section 7's
// four end-to-end scenarios (D1, D2, D3, D4, D5, D6).
//
// WHAT IS UNDER TEST. A share recipient's state is derived from the slot plus,
// for a failed 30003, the newest attempt's OWN message row (D1); a retry
// reaches the slot through one attempt-ordered transition (D2); and every
// surface reads that one state: the results row and its "open conversation to
// retry" hint (D3), the share's pill on the results page AND on the list (D4),
// the property Activity entry (D5), the tenant timeline milestone (D6),
// "Properties sent" and the composer's "Already sent" flag (D1's safe reading).
//   (a) 30003, the retry delivers    -> pending (API), then Delivered, Sent,
//                                       flagged, listed under Properties sent;
//   (b) 30003 x4, the chain exhausts -> the OPEN list turns Not sent with no
//                                       reload; Failed with the plain 30003
//                                       and the hint; not flagged, not listed,
//                                       "Property text failed";
//   (c) 30007, a final failure       -> Failed with the hint, Not sent, not
//                                       flagged, "No recipients reached";
//   (d) SOR's unresolved close       -> Not confirmed, flagged, not listed, and
//                                       no last_error alert.
//
// THE LANE SHORTENS BOTH CLOCKS (scripts/e2e-session.mjs childEnv):
// E2E_SEND_RETRY_BACKOFF_MS=10000 sends each automatic retry 10 s after its
// failure, and E2E_SEND_RECONCILE_DELAYS_MS=2000,4000,8000 runs the
// reconcile's three checks 2 / 4 / 8 s after an unknown attempt. Both reach
// only a FRESHLY booted lane (`npm run e2e:restart` keeps the launcher's old
// environment); a lane without the backoff seam fails expectFailureStamped
// with a message naming it. The cap is MAX_SEND_RETRY_ATTEMPTS (3): the
// original plus three retries is four failed texts, about 32 s on a lane.
//
// ARMING IS SINGLE-USE (fake-twilio engine: the create consumes the profile).
// setDeliveryOutcome arms the NEXT create to a number, so (b) re-arms 30003
// after EACH text lands in the fake's thread store - the happens-after
// barrier - and before the next rung fires 10 s later. (a) arms once: its
// retry runs the normal progression and delivers. (d) copies
// send-outcome-reconcile.spec.ts's arming (drop_before_create + fail-list x3).
//
// RECIPIENTS. One fresh, consented tenant per test on a per-run number, never
// the lean seed's Dario (contact-tenant-0002 / conv-0002), and no fail seam is
// ever armed on a shared seed number: an arming no create consumed survives
// until the fake's once-per-suite reset. Each test owns its property and its
// tenant, so the file needs no serial mode. Shares go through the API send
// route (the dashboard Send button's route), so every arming window is
// deterministic.
//
// EVIDENCE. The SCREEN is the product claim. Each screen read has an API
// precondition (results, listings-sent, timeline, unit activity), so the page
// is opened after the fact it shows has landed and an ABSENCE on screen is
// read against a positive on the same surface. The stored rows and the fake's
// thread store prove the chain's shape: its texts, their lineage, the promise.
const NEXT = dashboardUrl;

/** The fake's failure profiles (setDeliveryOutcome), each consumed by ONE create. */
const FAIL_30003 = { kind: 'fail', failState: 'undelivered', errorCode: '30003' } as const;
const FAIL_30007 = { kind: 'fail', failState: 'undelivered', errorCode: '30007' } as const;
/** The results row's plain 30003 reason: no promise, no unresolved ruling. */
const PLAIN_30003 = 'Phone unreachable (error 30003)';
/** The results row's 30007 reason: a final carrier failure, never retried. */
const REASON_30007 = 'Carrier filtered the message (error 30007)';
/** The failed row's hint (D3): plain text in the row link's accessible name. */
const RETRY_HINT = /open conversation to retry/;
/** The all-unconfirmed share's stored last_error (broadcastFanOut finalize). */
const UNCONFIRMED_LAST_ERROR = "Couldn't confirm any text went out";
/** Production's first one-to-one rung (retryBackoffMs(1), app/src/jobs/retrySend.ts). */
const PRODUCTION_FIRST_RUNG_MS = 60_000;

// --- Per-run-unique phones ---------------------------------------------------
// +1 555 8XX XXXX, the exchange the relay, reconcile and retry specs mint from.
// The uid block from 90 is the retry family's: retry-send-adoption.spec.ts
// mints 91-93, so this file starts at 94 (it mints 95-98) - disjoint from it,
// from the relay specs (0, 40) and from send-outcome-reconcile.spec.ts (70),
// because the fake's armings and thread store are reset only once per suite.
// The two-digit suffix must stay below 100.
let uid = 94;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

interface Tenant {
  contactId: string;
  phone: string;
  firstName: string;
  /** The results row's primary label: `<firstName> Outcome`. */
  name: string;
}

/** The stored fields this file reads (raw MessageItem rows). */
interface StoredMessage {
  tsMsgId: string;
  provider_ts: string;
  delivery_status: string;
  error_code?: string;
  retry_of?: string;
  retry_attempt?: number;
  retry_due_at?: string;
  retry_root?: string;
  broadcast_id?: string;
}

/** A failed original whose promise this test captured before the retry ran. */
type StampedFailure = StoredMessage & { retry_due_at: string };

/** One recipient as GET /api/broadcasts/:id/results returns it (the fields read here). */
interface ResultsRecipient {
  status: string;
  conversationId?: string;
  tsMsgId?: string;
  latestAttempt?: string;
  errorCode?: string;
  retryDueAt?: string;
  retryPending?: boolean;
}

/** The results payload (the fields read here); `stats.retry_pending` is always present on it. */
interface ShareResults {
  status: string;
  last_error?: string;
  stats: { delivered: number; failed: number; unconfirmed?: number; retry_pending?: number };
  recipients: Record<string, ResultsRecipient>;
}

// Restore the lean baseline for the specs that run after this file: every test
// here leaves a property, a tenant, a share and a composer draft behind. Same
// pattern as share-skip-fix.spec.ts.
test.afterAll(async ({ request }) => {
  await reseed(request);
});

/** Dev-login as the seeded VA. Every app API call below goes through
 *  `page.request`, which carries this session's cookie; the bare `request`
 *  fixture is for the fake and the reseed only. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A fresh Available 2-BR property: the share send guard refuses any other
 *  status, and the seeded units must keep theirs for other specs. */
async function createAvailableUnit(
  api: APIRequestContext,
  stamp: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp} Share Outcome Way`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['atlanta_housing'],
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1400,
      rent_max: 1500,
    },
  });
  expect(res.ok(), `unit create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), `listing-status flip failed: ${flip.status()} ${await flip.text()}`).toBeTruthy();
  return { unitId, line1 };
}

/** A fresh 2-BR tenant on a per-run number, WITH recorded consent
 *  (`verbal_in_person`, as send-outcome-reconcile.spec.ts records it). */
async function createConsentedTenant(api: APIRequestContext, firstName: string): Promise<Tenant> {
  const phone = uniquePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Outcome', phone, voucherSize: 2 },
  });
  expect(res.ok(), `tenant create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), `consent failed: ${consent.status()} ${await consent.text()}`).toBeTruthy();
  return { contactId, phone, firstName, name: `${firstName} Outcome` };
}

/** Share `unitId` with exactly `contactIds` through the API - a seeds-only
 *  draft sent by explicit selection. The body is `[Address] [FlyerLink]`, so
 *  every text of the share (a retry included) carries `/p/<unitId>`. */
async function shareViaApi(api: APIRequestContext, unitId: string, contactIds: string[]): Promise<string> {
  const draft = await api.post(`${NEXT}/api/broadcasts`, {
    data: { unitId, body_template: '[Address] [FlyerLink]', seedContactIds: contactIds },
  });
  expect(draft.ok(), `draft failed: ${draft.status()} ${await draft.text()}`).toBeTruthy();
  const broadcastId = (await draft.json()).broadcastId as string;
  const send = await api.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
    data: { recipientContactIds: contactIds },
  });
  expect(send.ok(), `send failed: ${send.status()} ${await send.text()}`).toBeTruthy();
  return broadcastId;
}

/** GET /api/broadcasts/:id/results - the share's derived stats and its recipients. */
async function readResults(api: APIRequestContext, broadcastId: string): Promise<ShareResults> {
  const res = await api.get(`${NEXT}/api/broadcasts/${broadcastId}/results`);
  expect(res.ok(), `results fetch failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as ShareResults;
}

/** Poll the results API every 250 ms until `pick` accepts a payload; returns it. */
async function pollResults(
  api: APIRequestContext,
  broadcastId: string,
  pick: (r: ShareResults) => boolean,
  message: string,
): Promise<ShareResults> {
  let found: ShareResults | undefined;
  await expect
    .poll(
      async () => {
        const r = await readResults(api, broadcastId);
        if (!pick(r)) return false;
        found = r;
        return true;
      },
      { timeout: 30_000, intervals: [250], message },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`pollResults passed without a payload: ${message}`);
  return found;
}

/** The slot's own message pointer, once the fan-out recorded the share text. */
async function expectSlotPointer(
  api: APIRequestContext,
  broadcastId: string,
  contactId: string,
): Promise<{ conversationId: string; tsMsgId: string }> {
  const r = await pollResults(
    api,
    broadcastId,
    (x) => typeof x.recipients[contactId]?.conversationId === 'string' && typeof x.recipients[contactId]?.tsMsgId === 'string',
    'the fan-out never recorded the share text on the recipient slot',
  );
  const slot = r.recipients[contactId];
  if (slot?.conversationId === undefined || slot.tsMsgId === undefined) {
    throw new Error('the recipient slot lost its message pointer');
  }
  return { conversationId: slot.conversationId, tsMsgId: slot.tsMsgId };
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
  message: string,
): Promise<StoredMessage> {
  let found: StoredMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await storedRows(api, conversationId)).find(pick);
        return found !== undefined;
      },
      { timeout: 30_000, intervals: [500], message },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`pollRow passed without a row: ${message}`);
  return found;
}

/** The share text's failure: undelivered 30003 WITH its retry promise, in the
 *  one write the webhook makes. Captured before the retry runs, so the promise
 *  is the failure's own stamp - one lane backoff out, never a production rung. */
async function expectFailureStamped(
  api: APIRequestContext,
  conversationId: string,
  tsMsgId: string,
): Promise<StampedFailure> {
  const row = await pollRow(
    api,
    conversationId,
    (m) => m.tsMsgId === tsMsgId && m.error_code === '30003' && typeof m.retry_due_at === 'string',
    'the share text never failed 30003 with a retry promise',
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

/** The happens-after barrier for re-arming the fake: exactly `count` share
 *  texts to `phone` have been created, so the latest one has consumed the
 *  previous arming and the next arming lands on the next rung. */
async function expectCreatesLanded(
  request: APIRequestContext,
  phone: string,
  needle: string,
  since: string,
  count: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: phone, since })).filter((m) => (m.body ?? '').includes(needle)).length,
      { timeout: 30_000, message: `share text ${count} never reached the fake (the lane backoff is 10 s a rung)` },
    )
    .toBe(count);
}

/** The carrier's view: the state of every share text to `phone`, oldest first. */
async function textStates(request: APIRequestContext, phone: string, needle: string, since: string): Promise<string[]> {
  return (await getOutboundTo(request, { to: phone, since }))
    .filter((m) => (m.body ?? '').includes(needle))
    .map((m) => m.state);
}

/** Open a share's results page and wait for its chips. */
async function openResults(page: Page, broadcastId: string): Promise<void> {
  await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
  await expect(page.getByLabel('Delivery stats')).toBeVisible({ timeout: 15_000 });
}

/** One recipient's row, SCOPED to the Recipients list: its badge repeats chip
 *  labels ("Failed", "Delivered", "Not confirmed"), so an unscoped read is a
 *  strict-mode collision with the Delivery stats chips. */
function recipientRow(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Recipients' }).getByRole('listitem').filter({ hasText: name });
}

/** Open the seeded one-to-one composer for (property, tenant) and go to the
 *  review list; returns the tenant's row locator (its "Already sent" tag is
 *  the preview's safe reading, D1). */
async function openReviewRow(page: Page, unitId: string, contactId: string, firstName: string): Promise<Locator> {
  await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}&contactId=${contactId}`);
  await expect(page.getByLabel('Message')).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), { timeout: 10_000 });
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await previewBtn.click();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  await expect(list).toBeVisible();
  return list.locator('li', { hasText: firstName });
}

/** The properties the tenant's "Properties sent" card lists (GET
 *  /api/contacts/:id/listings-sent - counted ledger rows only, D7). */
async function listedUnitIds(api: APIRequestContext, contactId: string): Promise<string[]> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/listings-sent`);
  expect(res.ok(), `listings-sent fetch failed: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { sent: Array<{ unitId: string }> }).sent.map((s) => s.unitId);
}

/** The words of the tenant's "Property sent" milestones for `unitId`, as the
 *  timeline composes them at request time from the ledger (D6). */
async function propertyMilestoneLabels(api: APIRequestContext, contactId: string, unitId: string): Promise<string[]> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}/timeline?kinds=milestone`);
  expect(res.ok(), `timeline fetch failed: ${res.status()}`).toBeTruthy();
  const { items } = (await res.json()) as {
    items: Array<{ kind: string; type?: string; refType?: string; refId?: string; label?: string }>;
  };
  return items
    .filter((i) => i.kind === 'milestone' && i.type === 'listing_sent' && i.refType === 'unit' && i.refId === unitId)
    .map((i) => i.label ?? '');
}

/** The share's `broadcast_sent` entry on the property Activity feed: its
 *  tenantCount, recounted at read time (D5), or null while none exists. */
async function shareActivityCount(api: APIRequestContext, unitId: string, broadcastId: string): Promise<number | null> {
  const res = await api.get(`${NEXT}/api/units/${unitId}/activity`);
  expect(res.ok(), `activity fetch failed: ${res.status()}`).toBeTruthy();
  const { events } = (await res.json()) as {
    events: Array<{ type: string; broadcastId?: string; tenantCount?: number }>;
  };
  return events.find((e) => e.type === 'broadcast_sent' && e.broadcastId === broadcastId)?.tenantCount ?? null;
}

/** The tenant's contact page, where staff read the file and the timeline. */
async function openContact(page: Page, contactId: string): Promise<void> {
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(page.getByRole('region', { name: 'Communications and activity' })).toBeVisible({
    timeout: 15_000,
  });
}

/** The tenant file's "Properties sent" card (a Card is an unnamed section; its
 *  heading's name also carries the "+ Send" action, hence the regex). */
function propertiesSentCard(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /Properties sent/ }) });
}

test.describe('share-sent-outcome - one recipient state behind every surface', () => {
  test('(a) a 30003 whose retry delivers: pending while the retry is promised, then Delivered, the share Sent, the tenant "Already sent" and the property under Properties sent', async ({
    page,
    request,
  }) => {
    test.slow(); // setup, the 10 s lane backoff, then four page visits.
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createAvailableUnit(api, stamp);
    const tenant = await createConsentedTenant(api, `Retryok${stamp}`);
    const needle = `/p/${unitId}`;
    const since = new Date().toISOString();

    // --- Act: the share's text fails 30003 (the arming is consumed by that
    //     create), so its retry runs the normal progression and delivers. ---
    await setDeliveryOutcome(request, { partyNumber: tenant.phone, profile: FAIL_30003 });
    const broadcastId = await shareViaApi(api, unitId, [tenant.contactId]);
    const pointer = await expectSlotPointer(api, broadcastId, tenant.contactId);
    const original = await expectFailureStamped(api, pointer.conversationId, pointer.tsMsgId);

    // --- Assert 1: PENDING, read through the API (D1, D3, D4). An ordering
    //     guard: the poll starts after the failure is stamped, and the retry
    //     cannot land before the 10 s backoff, so the window certainly exists;
    //     it lasts about 10 s, which is why the API is read and not the page.
    //     The row's retryDueAt IS the message row's own promise (I5). The
    //     "will retry" COPY is DeliveryBadge's unit test's to pin. ---
    const pending = await pollResults(
      api,
      broadcastId,
      (r) => r.stats.retry_pending === 1 && r.recipients[tenant.contactId]?.retryPending === true,
      'the share never read its recipient pending a retry (stats.retry_pending 1)',
    );
    expect(pending.recipients[tenant.contactId]).toMatchObject({
      status: 'failed',
      errorCode: '30003',
      retryDueAt: original.retry_due_at,
    });

    // --- Assert 2: THE RETRY REACHES THE SLOT (D2). The retry row carries the
    //     share's id and the chain's root; the slot moves to Delivered and
    //     records the retry as its newest attempt, keeping its original
    //     pointer. ---
    const retry = await pollRow(
      api,
      pointer.conversationId,
      (m) => m.retry_of === original.tsMsgId && m.delivery_status === 'delivered',
      'the retry never delivered (lane backoff 10 s)',
    );
    expect(retry).toMatchObject({ retry_attempt: 1, retry_root: original.tsMsgId, broadcast_id: broadcastId });
    const settled = await pollResults(
      api,
      broadcastId,
      (r) => r.recipients[tenant.contactId]?.status === 'delivered',
      "the retry's delivery never reached the share slot",
    );
    expect(settled.recipients[tenant.contactId]).toMatchObject({
      tsMsgId: original.tsMsgId,
      latestAttempt: retry.tsMsgId,
    });
    expect(settled.stats).toMatchObject({ delivered: 1, failed: 0, retry_pending: 0 });
    expect(
      await textStates(request, tenant.phone, needle, since),
      'the tenant must hold the share text twice: the original 30003, then ONE retry',
    ).toEqual(['undelivered', 'delivered']);

    // --- Assert 3: THE RESULTS PAGE. The row Delivered, the share Sent, and
    //     nothing left Retrying. ---
    await openResults(page, broadcastId);
    await expect(recipientRow(page, tenant.name)).toContainText('Delivered');
    await expect(statusPill(page, 'Sent')).toBeVisible();
    expect(await statValue(page, 'Retrying')).toBe(0);
    expect(await statValue(page, 'Delivered')).toBe(1);
    expect(await statValue(page, 'Failed')).toBe(0);

    // --- Assert 4: THE COMPOSER. The next share of the property flags the
    //     tenant "Already sent" (reached). ---
    const review = await openReviewRow(page, unitId, tenant.contactId, tenant.firstName);
    await expect(review.getByText('Already sent')).toBeVisible();

    // --- Assert 5: PROPERTIES SENT lists the property (the ledger counts the
    //     delivered retry, D7). ---
    await expect
      .poll(async () => listedUnitIds(api, tenant.contactId), {
        timeout: 30_000,
        message: "the tenant's listings-sent never listed the property",
      })
      .toEqual([unitId]);
    await openContact(page, tenant.contactId);
    await expect(propertiesSentCard(page).getByRole('link', { name: line1 })).toHaveAttribute(
      'href',
      `/listings/${unitId}`,
    );
  });

  test('(b) a 30003 chain that exhausts at four failed texts: the open list turns Not sent live, the row Failed with the plain 30003 and the hint, not flagged, not listed, "Property text failed"', async ({
    page,
    request,
  }) => {
    // Four rungs at the lane's 10 s backoff (about 32 s), then four page visits.
    test.setTimeout(120_000);
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createAvailableUnit(api, stamp);
    const tenant = await createConsentedTenant(api, `Exhaust${stamp}`);
    const needle = `/p/${unitId}`;
    const since = new Date().toISOString();

    // --- Act 1: the share's text fails 30003 and promises its first retry. ---
    await setDeliveryOutcome(request, { partyNumber: tenant.phone, profile: FAIL_30003 });
    const broadcastId = await shareViaApi(api, unitId, [tenant.contactId]);
    const pointer = await expectSlotPointer(api, broadcastId, tenant.contactId);
    const original = await expectFailureStamped(api, pointer.conversationId, pointer.tsMsgId);
    // Re-arm for retry 1 NOW, before the list opens: the original's create has
    // landed (its failure is stamped) and retry 1 fires 10 s after it, so a
    // slow page load cannot let retry 1 slip through unarmed.
    await expectCreatesLanded(request, tenant.phone, needle, since, 1);
    await setDeliveryOutcome(request, { partyNumber: tenant.phone, profile: FAIL_30003 });

    // --- Assert 1: THE LIST, opened AFTER the failure is stamped, so the row
    //     is on the page (the list hook patches only rows it holds) and reads
    //     Sending from the route's own retry_pending count. From here the page
    //     is never reloaded. ---
    await page.goto(`${NEXT}/broadcasts`);
    const shareRow = page
      .getByRole('list', { name: 'Property sends' })
      .locator(`a[href="/broadcasts/${broadcastId}"]`);
    await expect(shareRow.getByText('Sending', { exact: true })).toBeVisible();

    // --- Act 2: re-arm 30003 after EACH retry lands, so retries 2 and 3 fail
    //     too. The third retry is the cap: its failure schedules nothing. ---
    for (const landed of [2, 3]) {
      await expectCreatesLanded(request, tenant.phone, needle, since, landed);
      await setDeliveryOutcome(request, { partyNumber: tenant.phone, profile: FAIL_30003 });
    }
    const last = await pollRow(
      api,
      pointer.conversationId,
      (m) => m.retry_attempt === 3 && m.error_code === '30003',
      'the third retry never failed 30003 (four rungs at the lane backoff of 10 s)',
    );
    expect(last).toMatchObject({
      delivery_status: 'undelivered',
      retry_root: original.tsMsgId,
      broadcast_id: broadcastId,
    });
    expect(last.retry_due_at, 'the capped rung promises no further retry').toBeUndefined();

    // --- Assert 2: THE STILL-OPEN LIST turns Not sent WITHOUT a reload: the
    //     final failure's event omits the count, so the row refetches the
    //     share's stats (D4's merge) and reads the route's truth. ---
    await expect(shareRow.getByText('Not sent', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(shareRow.getByText('Sending', { exact: true })).toHaveCount(0);

    // --- Assert 3: THE CHAIN'S SHAPE. Four stored attempts, each a 30003, and
    //     the carrier holds four undelivered texts. ---
    const attempts = (await storedRows(api, pointer.conversationId)).filter((m) => m.broadcast_id === broadcastId);
    expect(attempts.map((m) => m.retry_attempt ?? 0).sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
    expect(attempts.every((m) => m.error_code === '30003' && m.delivery_status === 'undelivered')).toBe(true);
    expect(await textStates(request, tenant.phone, needle, since)).toEqual([
      'undelivered',
      'undelivered',
      'undelivered',
      'undelivered',
    ]);

    // --- Assert 4: THE RESULTS PAGE. The row Failed with the PLAIN 30003 (no
    //     "will retry" once the chain has ended) and the hint (the text has a
    //     message row and no live promise); the share Not sent. ---
    const results = await readResults(api, broadcastId);
    expect(results.stats.retry_pending).toBe(0);
    await openResults(page, broadcastId);
    const row = recipientRow(page, tenant.name);
    await expect(row).toContainText('Failed');
    await expect(row).toContainText(PLAIN_30003);
    await expect(row).not.toContainText('will retry');
    await expect(row.getByRole('link', { name: RETRY_HINT })).toHaveCount(1);
    await expect(statusPill(page, 'Not sent')).toBeVisible();
    expect(await statValue(page, 'Failed')).toBe(1);
    expect(await statValue(page, 'Retrying')).toBe(0);

    // --- Assert 5: THE COMPOSER does not flag the tenant (a final failure). ---
    const review = await openReviewRow(page, unitId, tenant.contactId, tenant.firstName);
    await expect(review).toBeVisible();
    await expect(review.getByText('Already sent')).toHaveCount(0);

    // --- Assert 6: THE TENANT'S FILE. Properties sent does not list the
    //     property (the ledger entry is failed, D7), and the milestone written
    //     at the original's acceptance reads its words from that entry (D6). ---
    await expect
      .poll(async () => listedUnitIds(api, tenant.contactId), {
        timeout: 30_000,
        message: "the tenant's listings-sent still lists the property",
      })
      .toEqual([]);
    await expect
      .poll(async () => propertyMilestoneLabels(api, tenant.contactId, unitId), {
        timeout: 30_000,
        message: 'the Property sent milestone never read "Property text failed"',
      })
      .toEqual(['Property text failed']);
    await openContact(page, tenant.contactId);
    const card = propertiesSentCard(page);
    await expect(card.getByText('No properties sent yet.')).toBeVisible();
    await expect(card.getByRole('link', { name: line1 })).toHaveCount(0);
    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    const milestone = timeline.getByRole('link', { name: 'Property text failed', exact: true });
    await expect(milestone).toBeVisible();
    await expect(milestone).toHaveAttribute('href', `/listings/${unitId}`);
    await expect(timeline.getByRole('link', { name: /^Property sent/ })).toHaveCount(0);
  });

  test('(c) a final 30007 failure: the row Failed with the hint, the share Not sent, the tenant not flagged, the property Activity "No recipients reached"', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId } = await createAvailableUnit(api, stamp);
    const tenant = await createConsentedTenant(api, `Final${stamp}`);

    // --- Act: the share's text is accepted, then fails 30007 - never retried. ---
    await setDeliveryOutcome(request, { partyNumber: tenant.phone, profile: FAIL_30007 });
    const broadcastId = await shareViaApi(api, unitId, [tenant.contactId]);
    const failed = await pollResults(
      api,
      broadcastId,
      (r) =>
        r.status !== 'sending' &&
        r.recipients[tenant.contactId]?.status === 'failed' &&
        r.recipients[tenant.contactId]?.errorCode === '30007',
      'the share never finished with its recipient failed 30007',
    );
    // The text has a message row (the hint's precondition) and no promise.
    expect(typeof failed.recipients[tenant.contactId]?.tsMsgId).toBe('string');
    expect(failed.stats.retry_pending).toBe(0);

    // --- Assert 1: THE RESULTS PAGE. ---
    await openResults(page, broadcastId);
    const row = recipientRow(page, tenant.name);
    await expect(row).toContainText('Failed');
    await expect(row).toContainText(REASON_30007);
    await expect(row.getByRole('link', { name: RETRY_HINT })).toHaveCount(1);
    await expect(statusPill(page, 'Not sent')).toBeVisible();
    expect(await statValue(page, 'Failed')).toBe(1);

    // --- Assert 2: THE COMPOSER does not flag the tenant. ---
    const review = await openReviewRow(page, unitId, tenant.contactId, tenant.firstName);
    await expect(review).toBeVisible();
    await expect(review.getByText('Already sent')).toHaveCount(0);

    // --- Assert 3: THE PROPERTY ACTIVITY entry recounts the share at read
    //     time (D5): nobody reached, and it still links to the share. ---
    await expect
      .poll(async () => shareActivityCount(api, unitId, broadcastId), {
        timeout: 30_000,
        message: "the share's broadcast_sent Activity entry never read tenantCount 0",
      })
      .toBe(0);
    await page.goto(`${NEXT}/listings/${unitId}`);
    const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
    const entry = activity.getByRole('link', { name: /No recipients reached/ });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute('href', `/broadcasts/${broadcastId}`);
  });

  test('(d) an unconfirmed share (the reconcile closes it unresolved): the share Not confirmed, the tenant "Already sent", no Properties sent, no last_error alert', async ({
    page,
    request,
  }) => {
    test.slow(); // setup, then all three of the lane's reconcile checks (8 s).
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createAvailableUnit(api, stamp);
    const tenant = await createConsentedTenant(api, `Unsure${stamp}`);

    // --- Act (send-outcome-reconcile.spec.ts's arming): the connection drops
    //     before anything is recorded, and every lookup of the number fails for
    //     the whole window, so the reconcile closes the recipient unresolved. ---
    await failNextSend(request, { partyNumber: tenant.phone, mode: 'drop_before_create' });
    await failList(request, { partyNumber: tenant.phone, count: 3 });
    const broadcastId = await shareViaApi(api, unitId, [tenant.contactId]);
    const closed = await pollResults(
      api,
      broadcastId,
      (r) => r.status === 'failed' && r.recipients[tenant.contactId]?.errorCode === 'send_unconfirmed',
      'the share never finished with its recipient closed Not confirmed (lane checks at 2 / 4 / 8 s)',
    );
    // The stored last_error exists - so its absence on screen below is D4's
    // rule (shown under Not sent only), not a missing value.
    expect(closed.last_error).toBe(UNCONFIRMED_LAST_ERROR);
    expect(closed.stats.unconfirmed).toBe(1);

    // --- Assert 1: THE RESULTS PAGE. The share reads Not confirmed, the row
    //     Not confirmed with no hint, and the stored last_error is NOT shown. ---
    await openResults(page, broadcastId);
    await expect(statusPill(page, 'Not confirmed')).toBeVisible();
    const row = recipientRow(page, tenant.name);
    await expect(row).toContainText('Not confirmed');
    await expect(row.getByRole('link', { name: RETRY_HINT })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: UNCONFIRMED_LAST_ERROR })).toHaveCount(0);
    expect(await statValue(page, 'Not confirmed')).toBe(1);
    expect(await statValue(page, 'Failed')).toBe(0);

    // --- Assert 2: THE COMPOSER flags the tenant: the text may have gone out
    //     (D1's safe reading), and a resend is the double text SOR prevents. ---
    const review = await openReviewRow(page, unitId, tenant.contactId, tenant.firstName);
    await expect(review.getByText('Already sent')).toBeVisible();

    // --- Assert 3: PROPERTIES SENT does not list the property (strict reading:
    //     an unconfirmed text counts for no ledger, D7). ---
    expect(await listedUnitIds(api, tenant.contactId)).toEqual([]);
    await openContact(page, tenant.contactId);
    const card = propertiesSentCard(page);
    await expect(card.getByText('No properties sent yet.')).toBeVisible();
    await expect(card.getByRole('link', { name: line1 })).toHaveCount(0);
  });
});
