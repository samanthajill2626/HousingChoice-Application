import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { failList, failNextSend, getOutboundTo, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { readLogTail, type LogLine } from '../../fixtures/groupText.js';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { statValue, statusPill } from '../../support/broadcastSelectors.js';
import { expectTodayReady } from '../../support/today.js';
import { dashboardUrl } from '../../support/urls.js';

// AN AMBIGUOUS SEND ENDS IN A VERDICT, AND NOBODY IS TEXTED TWICE - the browser
// half of send-outcome-reconcile Stage 1
// (docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md, Sec 8's
// E2E paragraph, D13a, D19, D20, D22, D16a).
//
// WHAT IS UNDER TEST. A send whose provider outcome is UNKNOWN (the connection
// dropped: the text may or may not exist) is no longer thrown for a redelivery
// that re-sends it. The send site claims a per-recipient attempt record, hands
// the recipient to the `send.reconcile` job, and that job looks the message up
// at the provider - at most three checks - and decides: FOUND (adopt it, never
// re-send), NEVER SENT (re-drive it exactly once), or UNRESOLVED (close the
// recipient "Not confirmed", never re-sent). A provider REJECTION is decided at
// the send boundary and never reaches the reconcile. One test per fake mode
// (D19), plus the unresolved close:
//   1. accept_then_drop on a relay leg  -> adopted, Delivered on the open thread;
//   2. drop_before_create on a share    -> never_sent, re-driven once, share Sent;
//   3. reject (21211) on a share        -> Failed with the code, no reconcile;
//   4. drop_before_create + fail-list   -> unresolved, Not confirmed, share Failed.
//
// THE LANE SHORTENS THE WINDOW. E2E_SEND_RECONCILE_DELAYS_MS (2000,4000,8000 in
// scripts/e2e-session.mjs's childEnv, read by reconcileCheckDelaysMs in
// app/src/jobs/sendReconcile.ts) replaces the production 5 s / 30 s / 240 s
// checks for this lane only, so the final check - the one that decides
// never_sent or unresolved - runs 8 s after the attempt. A lane booted before
// that entry existed runs the production window and tests 2 and 4 time out:
// boot the lane FRESH (`npm run e2e:stop`, then run) - `npm run e2e:restart`
// keeps the launcher's old environment.
//
// THREE KINDS OF EVIDENCE, because each proves what the others cannot.
// - The SCREEN is the product claim: the row, the chip, the pill, the alert,
//   read the way staff read them - and on the relay thread WITHOUT a reload,
//   because the relay thread refetches only on an SSE event and the adoption
//   has to send one (build ruling A1).
// - The FAKE'S THREAD STORE is the carrier's view (getOutboundTo): the only
//   proof that nobody was texted twice, and that a re-drive or a
//   "never re-sent" close is what it says. A chip counts SLOTS, not texts.
// - The APP'S LOG TAIL (/__dev/logtail, WARN and up, the app process - where
//   the fan-outs and the reconcile run on a lane) names the PATH. On screen a
//   re-driven recipient and one that went out first time look identical, and
//   "Not confirmed" reads the same for every unresolved cause; the verdict
//   lines tell them apart, and the hand-off line proves the seam really fired.
//   The reconcile's INFO lines (found, continue) never reach the tail, so a
//   found adoption shows as the ABSENCE of any WARN verdict beside a hand-off.
//
// ARMING. The fake's fail seams are keyed on the DESTINATION number and
// consumed per create (fail-next-send) or per lookup (fail-list); an arming no
// call consumed survives until the fake's once-per-suite reset. So every number
// here is minted per run, and a relay group's create-time intros are SETTLED
// before a member is armed - otherwise the intro, not the leg, eats the arming.
// No test here touches the lean seed's switched-off tenant (contact-tenant-0002 /
// conv-0002, spec Sec 2a): every recipient is a fresh, consented tenant.
//
// LEAN LANE, like relay-30003-retry.spec.ts: each test builds its own data on a
// freshly reseeded lean world, and the file restores that world on the way out.
//
// ORDER: THE RELAY TEST STAYS FIRST. Under accept_then_drop the fake's status
// callbacks reach the app before the adoption exists, and the status webhook
// re-looks an unknown SID up once, 2.5 s later
// (STATUS_UNKNOWN_SID_RETRY_DELAY_MS, app/src/routes/webhooks/twilio.ts). The
// test is usually over by then, so the next test's reseed can wipe the pointer
// under that re-lookup, which then logs one `status callback for unknown
// provider SID` ERROR - an expected accept_then_drop artifact (build finding
// T16-4), harmless here because every log read below is scoped to its own
// owner. First in the file, that line lands in this file's own next test; last,
// it would land in whichever spec runs next, and a spec asserting "no
// unknown-SID ERROR" (group-text-reply-all.spec.ts) must not inherit it.
const NEXT = dashboardUrl;

// The settle barrier for a relay group's create-time intro fan-out: a
// substring of `relay.intro` (app/src/messages/catalog.ts), matched as a
// substring for the reason relay-30003-retry.spec.ts gives.
const INTRO_NEEDLE = 'Use this group text';

// --- Per-run-unique phones ---------------------------------------------------
// +1 555 8XX XXXX, the exchange the relay specs mint from: it never collides
// with the fake's pool numbers (the "019" exchange) or a seeded roster. The uid
// starts at 70 so a same-second run of this file cannot mint a number another
// relay spec mints (those start at 0 and 40): the fake's arming and thread
// store are reset only once per suite, so a shared number would carry an
// arming or a proof-of-send count across files. Tenants are minted the same
// way for the same reason.
let uid = 70;
function uniquePhone(): string {
  uid += 1;
  return `+15558${`${Date.now()}`.slice(-4)}${String(uid).padStart(2, '0')}`;
}

/** Reseed the lane with the LEAN profile (every test builds its own data). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Dev-login as the seeded VA - AFTER the reseed, so the session's cookie epoch
 *  matches the freshly re-seeded users table. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Poll the fake's thread store until the create-time intro to `phone` FROM the
 *  pool has landed - the happens-after barrier that makes an arming land on the
 *  leg under test rather than on the intro. */
async function expectIntroSettled(
  request: APIRequestContext,
  phone: string,
  pool: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: phone })).some(
          (m) => (m.body ?? '').includes(INTRO_NEEDLE) && m.from === pool,
        ),
      { timeout: 15_000, message: `the create-time intro to ${phone} never landed` },
    )
    .toBe(true);
}

/** Texts the carrier holds for `phone` whose body carries `needle`. */
async function textsTo(request: APIRequestContext, phone: string, needle: string): Promise<number> {
  return (await getOutboundTo(request, { to: phone })).filter((m) => (m.body ?? '').includes(needle))
    .length;
}

/** A fresh Available property: the share send guard refuses any other status,
 *  and the seeded units must keep theirs for other specs. */
async function createAvailableUnit(request: APIRequestContext, stamp: string): Promise<string> {
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['atlanta_housing'],
      address: { line1: `${stamp} Reconcile Way`, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1400,
      rent_max: 1500,
    },
  });
  expect(res.ok(), `unit create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), `listing-status flip failed: ${flip.status()} ${await flip.text()}`).toBeTruthy();
  return unitId;
}

interface Tenant {
  contactId: string;
  phone: string;
  /** The results row's primary label: `<firstName> Reconcile`. */
  name: string;
}

/** A fresh tenant on a per-run number, WITH recorded consent: a client may set
 *  only a human consent method (`inbound_text` is the system's own stamp and is
 *  refused), so this is `verbal_in_person` - as broadcasts.spec.ts and
 *  share-skip-fix.spec.ts record it. */
async function createConsentedTenant(request: APIRequestContext, firstName: string): Promise<Tenant> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Reconcile', phone, voucherSize: 2 },
  });
  expect(res.ok(), `tenant create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), `consent failed: ${consent.status()} ${await consent.text()}`).toBeTruthy();
  return { contactId, phone, name: `${firstName} Reconcile` };
}

/** Share `unitId` with exactly `contactIds` through the API - a seeds-only draft
 *  sent by explicit selection, the route the dashboard's Send button posts. The
 *  body is `[Address] [FlyerLink]`, so every text of this share carries
 *  `/p/<unitId>` and is countable in the fake's thread store. */
async function shareViaApi(
  request: APIRequestContext,
  unitId: string,
  contactIds: string[],
): Promise<string> {
  const draft = await request.post(`${NEXT}/api/broadcasts`, {
    data: { unitId, body_template: '[Address] [FlyerLink]', seedContactIds: contactIds },
  });
  expect(draft.ok(), `draft failed: ${draft.status()} ${await draft.text()}`).toBeTruthy();
  const broadcastId = (await draft.json()).broadcastId as string;
  const send = await request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
    data: { recipientContactIds: contactIds },
  });
  expect(send.ok(), `send failed: ${send.status()} ${await send.text()}`).toBeTruthy();
  return broadcastId;
}

/** Open a share's results page and wait for its chips. */
async function openResults(page: Page, broadcastId: string): Promise<void> {
  await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
  await expect(page.getByLabel('Delivery stats')).toBeVisible({ timeout: 15_000 });
}

/** One recipient's row, SCOPED to the Recipients list: its badge text repeats
 *  chip labels ("Failed", "Delivered", "Not confirmed"), so an unscoped read
 *  is a strict-mode collision with the Delivery stats chips (T14-10). */
function recipientRow(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Recipients' }).getByRole('listitem').filter({ hasText: name });
}

/** One reconcile log line, reduced to what decides the path. */
interface VerdictLine {
  level: number;
  checkNo: unknown;
  verdict: unknown;
  cause: unknown;
}

/** The reconcile job's own WARN+ lines (`event: 'send_reconcile'`) since
 *  `since` for the owner `ownerMatches` picks, oldest first. */
async function reconcileLines(
  request: APIRequestContext,
  since: string,
  ownerMatches: (owner: Record<string, unknown>) => boolean,
): Promise<VerdictLine[]> {
  const lines = await readLogTail(request, { since, event: 'send_reconcile' });
  return lines
    .filter((l) => {
      const owner = l['owner'];
      return typeof owner === 'object' && owner !== null && ownerMatches(owner as Record<string, unknown>);
    })
    .map((l) => ({
      level: l.level,
      checkNo: l['checkNo'] ?? null,
      verdict: l['verdict'] ?? null,
      cause: l['cause'] ?? null,
    }));
}

/** The app's WARN+ lines since `since` whose message carries `contains` and
 *  that `pick` accepts - a send site's own lines, which carry no `event`. */
async function siteLines(
  request: APIRequestContext,
  since: string,
  contains: string,
  pick: (line: LogLine) => boolean,
): Promise<LogLine[]> {
  return (await readLogTail(request, { since, contains })).filter(pick);
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run last).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
});

test('accept_then_drop on a relay leg: adopted by the reconcile, Delivered on the open thread without a reload, and sent once', async ({
  page,
  request,
}) => {
  test.slow(); // group create + connect-when-ready handshake + two intro settles + the first check.
  await devLogin(page);

  // --- Arrange: an OPEN two-member relay group on one pool number, both
  //     members contactless {phone, name} participants (a row is named by the
  //     member's own name). ---
  const stamp = `${Date.now()}`.slice(-6);
  const author = { phone: uniquePhone(), name: `Adopt Author ${stamp}` };
  const member = { phone: uniquePhone(), name: `Adopt Member ${stamp}` };
  const group = await createGroupOpen(page, [author, member]);
  const pool = group.pool_number;
  // SETTLE both intros before arming: the arming is consumed by the NEXT create
  // to the member, and the author must be a registered party on the fake before
  // it can text the pool (its intro landing is what registers it).
  await expectIntroSettled(request, author.phone, pool);
  await expectIntroSettled(request, member.phone, pool);

  // OPEN THE THREAD FIRST. It is on screen before the member's text exists, so
  // every change after this - the bubble, the member's row, its Delivered - has
  // to arrive over SSE. Nothing below reloads: a reload would make this pass
  // against an adoption that told the open thread nothing (build ruling A1).
  await page.goto(`${NEXT}/conversations/${group.conversationId}`);
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toBeEnabled({ timeout: 15_000 });

  // --- Act: the fake RECORDS the member's leg (its status callbacks fire, and
  //     reach the app before any SID pointer exists), then drops the
  //     connection: the app sees an unknown outcome, never a failure. ---
  const since = new Date().toISOString();
  await failNextSend(request, { partyNumber: member.phone, mode: 'accept_then_drop' });
  const token = `sor-adopt-${Date.now()}`;
  await sendAsParty(request, { from: author.phone, to: pool, body: token });

  // The bubble is a bare div with no role, name or test id; its BODY is the
  // addressable thing in it, and the body's parent is the bubble.
  const bodyText = page.getByText(token).first();
  await expect(bodyText).toBeVisible({ timeout: 15_000 });
  const bubble = bodyText.locator('xpath=..');

  // --- Assert 1: THE ROW READS DELIVERED, LIVE. The per-recipient list is
  //     rendered only once the bubble is revealed, so its absence before the
  //     click is what makes its presence after it mean anything. The author's
  //     own text is not fanned out to the author, so the member's row is the
  //     leg under test. Adopted at the lane's first check (2 s after the
  //     attempt) with the provider's CURRENT status - delivered by then. ---
  const list = bubble.getByRole('list', { name: 'Delivery by recipient' });
  await expect(list).toHaveCount(0);
  await bodyText.click();
  const memberRow = list.getByRole('listitem').filter({ hasText: member.name });
  await expect(memberRow).toContainText('Delivered', { timeout: 20_000 });
  await expect(memberRow).not.toContainText('Not confirmed');

  // --- Assert 2: THE PATH. The leg's send really came back unknown - the seam
  //     fired, and the send site handed the member to the reconcile rather than
  //     failing or re-sending it. From there only the adoption can move the leg:
  //     the fake's early status callbacks name a SID that no pointer knows until
  //     the adoption claims it. And the reconcile logged no WARN or ERROR verdict
  //     for the leg - no failed lookup, no re-drive, no unresolved close (its
  //     `found` is INFO, which never reaches the tail). Polled: the send site
  //     logs as the leg fails, which the screen does not wait on. ---
  await expect
    .poll(
      async () =>
        (
          await siteLines(
            request,
            since,
            'member handed to reconcile',
            (l) => l['conversationId'] === group.conversationId,
          )
        ).length,
      { timeout: 10_000, message: 'the relay fan-out never handed the member to the reconcile' },
    )
    .toBe(1);
  expect(
    await reconcileLines(request, since, (o) => o['relayConversationId'] === group.conversationId),
    'an adopted leg leaves no WARN or ERROR verdict - it is neither re-driven nor closed unresolved',
  ).toEqual([]);

  // --- Assert 3: SENT ONCE. The fake recorded the leg before dropping the
  //     connection; a reconcile that re-drove instead of adopting would make
  //     this two. The relayed copy carries the author's name ahead of the body
  //     (composeRelayBody), so it is matched by inclusion. The author is never
  //     sent their own text. ---
  const memberTexts = (await getOutboundTo(request, { to: member.phone })).filter((m) =>
    (m.body ?? '').includes(token),
  );
  expect(
    memberTexts.map((m) => m.state),
    'the member must hold exactly ONE copy of the text, delivered',
  ).toEqual(['delivered']);
  expect(await textsTo(request, author.phone, token)).toBe(0);
});

test('drop_before_create on a share recipient: the provider holds nothing, the recipient is re-driven exactly once, and the share finishes Sent', async ({
  page,
  request,
}) => {
  test.slow(); // unit + tenant + share setup, then the lane's 8 s window before the re-drive.
  await devLogin(page);
  const stamp = `${Date.now()}`.slice(-6);
  const unitId = await createAvailableUnit(page.request, stamp);
  const tenant = await createConsentedTenant(page.request, `Redrive${stamp}`);
  const needle = `/p/${unitId}`;

  // --- Act: the connection drops BEFORE the fake records anything. The app
  //     sees an unknown outcome; every lookup finds nothing; the final check
  //     (8 s on the lane) rules never_sent and re-drives the one recipient. The
  //     arming was consumed by the first create, so the re-drive goes through. ---
  const since = new Date().toISOString();
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'drop_before_create' });
  const broadcastId = await shareViaApi(page.request, unitId, [tenant.contactId]);

  // --- Assert 1: THE SHARE ENDS SENT, DELIVERED. The results page is live
  //     (SSE plus a poll while sending); nothing reloads it. ---
  await openResults(page, broadcastId);
  await expect
    .poll(async () => statValue(page, 'Delivered'), {
      timeout: 40_000,
      message: 'the re-driven recipient never reached Delivered',
    })
    .toBe(1);
  await expect(statusPill(page, 'Sent')).toBeVisible({ timeout: 15_000 });
  expect(await statValue(page, 'Failed')).toBe(0);
  expect(await statValue(page, 'Not confirmed')).toBe(0);
  await expect(recipientRow(page, tenant.name)).toContainText('Delivered');

  // --- Assert 2: THE PATH. On screen a re-driven recipient looks exactly like
  //     one that went out first time; the log tail does not. One hand-off (the
  //     dropped attempt - the re-drive went through, so no second one), then
  //     ONE reconcile WARN: never_sent at the final check. Checks 0 and 1 found
  //     nothing adoptable, which is INFO. ---
  const handOffs = await siteLines(
    request,
    since,
    'recipient handed to reconcile',
    (l) => l['broadcastId'] === broadcastId,
  );
  expect(handOffs, 'the dropped attempt must have been handed to the reconcile, once').toHaveLength(1);
  await expect
    .poll(async () => reconcileLines(request, since, (o) => o['broadcastId'] === broadcastId), {
      timeout: 10_000,
      message: 'the reconcile never ruled never_sent at the final check',
    })
    .toEqual([{ level: 40, checkNo: 2, verdict: 'never_sent', cause: null }]);

  // --- Assert 3: TEXTED ONCE. The dropped create recorded nothing, so the one
  //     text the carrier holds is the re-drive's. Two would be the double send
  //     this branch exists to prevent; zero would be a lost recipient. ---
  expect(await textsTo(request, tenant.phone, needle)).toBe(1);
});

test('reject 21211 on one share recipient: that recipient fails with the code and never reaches the reconcile, and the other is sent', async ({
  page,
  request,
}) => {
  test.slow();
  await devLogin(page);
  const stamp = `${Date.now()}`.slice(-6);
  const unitId = await createAvailableUnit(page.request, stamp);
  const rejected = await createConsentedTenant(page.request, `Rejectme${stamp}`);
  const fine = await createConsentedTenant(page.request, `Fineme${stamp}`);
  const needle = `/p/${unitId}`;

  // --- Act: a Twilio 400 with code 21211 for the first recipient, nothing
  //     recorded - a REJECTION, decided at the send boundary. ---
  const since = new Date().toISOString();
  await failNextSend(request, { partyNumber: rejected.phone, mode: 'reject', code: 21211 });
  const broadcastId = await shareViaApi(page.request, unitId, [rejected.contactId, fine.contactId]);

  // --- Assert 1: THE BUCKETS. One failed, one delivered, and the Not
  //     confirmed chip present and EMPTY - a rejection is a failure the
  //     platform is sure of, never an unconfirmed send. One chip snapshot. ---
  await openResults(page, broadcastId);
  await expect
    .poll(
      async () => ({
        failed: await statValue(page, 'Failed'),
        delivered: await statValue(page, 'Delivered'),
      }),
      { timeout: 30_000, message: 'the share never settled to one Failed and one Delivered' },
    )
    .toEqual({ failed: 1, delivered: 1 });
  await expect(
    page.getByLabel('Delivery stats').getByText('Not confirmed', { exact: true }),
  ).toBeVisible();
  expect(await statValue(page, 'Not confirmed')).toBe(0);
  await expect(statusPill(page, 'Sent')).toBeVisible({ timeout: 15_000 });

  // --- Assert 2: THE ROWS. The rejected row names the code through the
  //     unmapped-code fallback and - being a failure the platform is sure of -
  //     keeps its "open conversation to retry" hint: the positive control for
  //     that hint's absence in the Not confirmed test below. ---
  const rejectedRow = recipientRow(page, rejected.name);
  await expect(rejectedRow).toContainText('Failed');
  await expect(rejectedRow).toContainText('Delivery failed (error 21211)');
  await expect(rejectedRow.getByRole('link', { name: /open conversation to retry/ })).toHaveCount(1);
  await expect(recipientRow(page, fine.name)).toContainText('Delivered');

  // --- Assert 3: THE PATH - the pass's rejected arm, never the reconcile. The
  //     rejection WARN follows the slot write the screen shows, so it is polled.
  //     The hand-off decision is made AT the send, which is behind us once the
  //     rejection is logged, so its absence is a settled fact, not a race. ---
  await expect
    .poll(
      async () =>
        (
          await siteLines(request, since, 'send rejected by the provider', (l) => l['broadcastId'] === broadcastId)
        ).map((l) => ({ errorCode: String(l['errorCode']), status: l['status'] })),
      { timeout: 10_000, message: 'the rejection must be logged once, with its provider code and HTTP status' },
    )
    .toEqual([{ errorCode: '21211', status: 400 }]);
  expect(
    await siteLines(request, since, 'recipient handed to reconcile', (l) => l['broadcastId'] === broadcastId),
    'a rejected send is never handed to the reconcile',
  ).toHaveLength(0);

  // --- Assert 4: THE TEXTS. The rejected create recorded nothing; the other
  //     recipient holds exactly one text. ---
  expect(await textsTo(request, rejected.phone, needle)).toBe(0);
  expect(await textsTo(request, fine.phone, needle)).toBe(1);
});

test('fail-list for the whole window: the recipient closes Not confirmed, is never re-sent, and the share reads Failed with the unconfirmed prose', async ({
  page,
  request,
}) => {
  test.slow(); // unit + tenant + share setup, then all three of the lane's checks (8 s).
  await devLogin(page);
  const stamp = `${Date.now()}`.slice(-6);
  const unitId = await createAvailableUnit(page.request, stamp);
  const tenant = await createConsentedTenant(page.request, `Unsure${stamp}`);
  const needle = `/p/${unitId}`;

  // --- Act: the connection drops before anything is recorded (unknown), AND
  //     every lookup of that number fails for the whole window - one failed
  //     list per check, three checks. The platform cannot tell whether the
  //     text went out, so it must neither re-send it nor call it failed. ---
  const since = new Date().toISOString();
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'drop_before_create' });
  await failList(request, { partyNumber: tenant.phone, count: 3 });
  const broadcastId = await shareViaApi(page.request, unitId, [tenant.contactId]);

  // --- Assert 1: THE BUCKET. The unconfirmed recipient lands in its own chip
  //     (D22), in no other bucket. ---
  await openResults(page, broadcastId);
  await expect
    .poll(async () => statValue(page, 'Not confirmed'), {
      timeout: 40_000,
      message: 'the recipient never closed Not confirmed',
    })
    .toBe(1);
  expect(await statValue(page, 'Failed')).toBe(0);
  expect(await statValue(page, 'Delivered')).toBe(0);

  // --- Assert 2: THE ROW (scoped to the Recipients list - the chip says "Not
  //     confirmed" too): the D20 label and reason, and NO retry hint - the text
  //     may have gone out, and a resend is the double text this prevents. ---
  const row = recipientRow(page, tenant.name);
  await expect(row).toContainText('Not confirmed');
  await expect(row).toContainText("Couldn't confirm whether this text went out");
  await expect(row).not.toContainText('Failed');

  // --- Assert 3: THE SHARE (D16a). An all-unconfirmed share has no "not
  //     confirmed" status, so it reads Failed, and its last_error is the
  //     unconfirmed prose rather than "all recipients failed". ---
  await expect(statusPill(page, 'Failed')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('alert').filter({ hasText: "Couldn't confirm any text went out" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /open conversation to retry/ })).toHaveCount(0);

  // --- Assert 4: THE PATH. One hand-off, a failed lookup WARN at checks 0 and
  //     1, and ONE ERROR at the final check naming the cause - the provider was
  //     unreachable for the whole window. Any other unresolved cause (a stray
  //     candidate, a digest mismatch) would read the same on screen. ---
  const handOffs = await siteLines(
    request,
    since,
    'recipient handed to reconcile',
    (l) => l['broadcastId'] === broadcastId,
  );
  expect(handOffs, 'the dropped attempt must have been handed to the reconcile, once').toHaveLength(1);
  await expect
    .poll(async () => reconcileLines(request, since, (o) => o['broadcastId'] === broadcastId), {
      timeout: 10_000,
      message: 'the reconcile never closed the recipient unresolved at the final check',
    })
    .toEqual([
      { level: 40, checkNo: 0, verdict: null, cause: null },
      { level: 40, checkNo: 1, verdict: null, cause: null },
      { level: 50, checkNo: 2, verdict: 'unresolved', cause: 'provider_unreachable' },
    ]);

  // --- Assert 5: NEVER RE-SENT. The drop recorded nothing and the final check
  //     closed the recipient instead of re-driving it, so the carrier holds no
  //     text for this share at all. The verdict above was the LAST check, so no
  //     later re-drive can still be pending. ---
  expect(await textsTo(request, tenant.phone, needle)).toBe(0);
});
