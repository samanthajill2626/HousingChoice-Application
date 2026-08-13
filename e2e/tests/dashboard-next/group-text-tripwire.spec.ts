import { test, expect, type Page } from '@playwright/test';
import { registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { clearLogTail, readLogTail } from '../../fixtures/groupText.js';

// SPEC 4 - the TRIPWIRE: what happens the day Twilio stops sending the envelope.
//
// `OtherRecipients` is undocumented. The entire detection path depends on it,
// and Twilio can remove it without notice. The tripwire is the only thing that
// would tell us: an `MM`-prefixed inbound with NO media and NO envelope is what
// a silently-withdrawn contract looks like from inside the webhook.
//
// It is deliberately a HEURISTIC, not a proof - a subject-only 1:1 MMS matches
// it too - so the message is FILED (fail open, never lost) and the alarm is a
// WARN, not an error. What must NOT happen is the message being dropped or
// quietly reinterpreted, and what must happen is that the filed message is
// excluded from AI extraction: its body may reference people who are not on
// the thread it landed on, and extracting facts from that would attribute a
// room's conversation to one person.
//
// A28: this shape is unproducible through the ordinary injection path, because
// the engine derives the SID prefix from media presence alone. `sidShape: 'MM'`
// is the override that exists for exactly this test.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:9001';
// The app's /api routes sit behind the CloudFront origin-secret validator (only
// /__dev/* is exempt); the dashboard's dev server adds this header for the
// browser, so a direct API read has to add it too.
const ORIGIN_SECRET = process.env['CF_ORIGIN_SECRET'] ?? 'dev-placeholder-not-a-secret';
const apiHeaders = { 'x-origin-verify': ORIGIN_SECRET };

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('an MM inbound with no media and no envelope files 1:1, WARNs, and is kept out of extraction', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now()}`.slice(-6);
  const SOLO = `+1555087${stamp.slice(-4)}`;
  const body = `EXTRACT:{"voucherSize":4} envelope gone ${stamp}`;

  await registerParty(request, { label: `Solo ${stamp}`, role: 'tenant', number: SOLO });
  await clearLogTail(request);

  await sendAsParty(request, { from: SOLO, body, sidShape: 'MM' });

  // 1) THE WARN. Not an ERROR: the shape is ambiguous by construction, and an
  //    error-level alarm on a heuristic that a plain subject-line MMS trips
  //    would train everyone to ignore it.
  await expect
    .poll(async () => (await readLogTail(request, { event: 'group_envelope_missing' })).length, {
      timeout: 15_000,
      message: 'the missing-envelope tripwire never fired',
    })
    .toBeGreaterThan(0);
  const [warn] = await readLogTail(request, { event: 'group_envelope_missing' });
  expect(warn?.level).toBe(40);

  // The alarm carries no phone numbers. The envelope's values ARE handsets, and
  // a tripwire that leaks them into CloudWatch would be its own incident.
  expect(JSON.stringify(warn)).not.toContain(SOLO);

  // 2) FAIL OPEN: the message is filed as an ordinary 1:1 and is readable. No
  //    inbound is ever lost, including one the classifier could not place.
  //
  //    Reached through the INBOX rather than a derived contact id on purpose:
  //    the 1:1 capture path mints a random contactId (only the GROUP path
  //    derives one from the phone), so arriving here through the inbox is both
  //    the honest route and a second proof that the message filed 1:1.
  await devLogin(page);
  await page.goto(`${NEXT}/inbox`);
  const row = page.getByRole('listitem').filter({ hasText: stamp });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('link').first().click();
  await expect(page.getByText(body)).toBeVisible({ timeout: 15_000 });
  // The 1:1 capture path mints a RANDOM contactId, so this thread's ids are
  // only knowable from where the inbox just took us. The extraction assertion
  // below matches on whichever one the row's link carries - a 1:1 row links to
  // the CONTACT, a group row to the conversation, and the run record names
  // both.
  const landedOnId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(landedOnId).not.toBe('');

  // 3) EXCLUDED FROM EXTRACTION. The body carries an EXTRACT: directive the
  //    fake extraction driver would otherwise act on, so a suggestion chip
  //    appearing here would mean a marked message reached the transcript.
  //    THAT THE RUN HAPPENED IS THE LOAD-BEARING PART. Discarding the tick
  //    result made "the marked message was excluded from the window" and
  //    "extraction never ran at all" pass identically - and the second is not
  //    evidence of anything.
  //
  //    The AI RUN RECORD is what says which of the two it was, and it says so
  //    exactly. It is deliberately NOT the tick's `processed` count: a run whose
  //    window came back EMPTY completes as `skipped`, so `processed` stays 0 for
  //    precisely the outcome this test wants - and `processed` is a global
  //    count over every due row in the lane, so a non-zero value would not have
  //    been about this conversation anyway. The record names the conversation,
  //    proves the run ran for it, and states WHY it did nothing.
  const tick = await request.post('/__dev/extraction/tick', { data: {} });
  expect(tick.ok()).toBe(true);

  // The run log is admin-only, and the page is signed in as the ordinary dev
  // user. Read it on the TEST's request context - a separate cookie jar - so
  // the browser session this spec is still asserting against is untouched.
  const adminLogin = await request.post(`${NEXT}/auth/dev-login`, {
    data: { email: 'founder@example.com' },
  });
  expect(adminLogin.ok()).toBe(true);
  const runsRes = await request.get(`${APP}/api/ai-runs?scope=global&limit=50`, {
    headers: apiHeaders,
  });
  expect(runsRes.ok()).toBe(true);
  const runs = (
    (await runsRes.json()) as {
      runs: {
        conversationId?: string;
        contactId?: string;
        outcome?: string;
        skipReason?: string;
      }[];
    }
  ).runs;
  const run = runs.find(
    (r) => r.conversationId === landedOnId || r.contactId === landedOnId,
  );
  expect(run, 'extraction never ran for the marked message thread at all').toBeDefined();
  // SKIPPED is the load-bearing half. The marked message is filtered out
  // BEFORE the transcript window is assembled, so the run finds nothing to work
  // from and completes without ever reaching the driver. Remove the filter and
  // this flips: the EXTRACT: directive is in the window, the fake driver acts on
  // it, and the outcome becomes `applied` - which is the failure the chip
  // assertion below then also catches.
  //
  // The reason is one of the two "nothing to work from" outcomes; today it is
  // `no_new_client`, because the filtered window contains no inbound message at
  // all and that branch is evaluated before the empty-window one. Accepting
  // either keeps this pinned on the PROPERTY rather than on the order of two
  // equivalent internal branches.
  expect(run?.outcome).toBe('skipped');
  expect(['no_new_client', 'empty_window']).toContain(run?.skipReason);

  await page.reload();
  await expect(page.getByText(body)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('group', { name: /AI suggestion for voucher size/ })).toHaveCount(0);
});
