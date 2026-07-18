// e2e/tests/dashboard-next/voice-transcription.spec.ts
//
// Voice Intelligence (VI) transcription + platform voicemail, end-to-end against
// the REAL hermetic stack (app + the fake-twilio host, which now impersonates the
// VI REST API and fires the signed completion webhook). Spec section 7, E2E cases.
//
// The four scenarios:
//   1. Answered business-line call   -> dual-channel recording -> a VI transcript
//      with "Client:/Staff:" labels (source-attributed dual-channel bridge) + a player.
//   2. Missed business-line call     -> the caller leaves a voicemail -> a "Voicemail"
//      card with a SINGLE-channel transcript (no speaker labels) + player, AND the
//      missed-call auto-text still fires (asserted via /__dev/outbox).
//   3. Dropped VI completion webhook -> the card shows "Transcribing..." while the
//      transcript is pending, then the RECONCILE safety net (lane delay 2s) delivers
//      it WITHOUT any webhook. This test carries the pending-indicator proof.
//   4. Missed MASKED relay call      -> the do-not-record privacy invariant holds: the
//      fake never records it (no recordingSid), so no voicemail is ever offered.
//
// Driving + timing notes:
//   - We pre-create the caller as a tenant contact via the authenticated API (an
//     inbound founder-bridge call keys its `call` entry on the caller's phone-keyed
//     1:1 conversation, so a known contact's timeline shows it), then place the
//     inbound call FROM that phone and open /contacts/:id to read the call card.
//   - A scenario with digit:'1' auto-runs to an ANSWERED founder bridge (records +
//     transcribes); digit:null models the founder never accepting the whisper gate,
//     i.e. a MISS (which offers voicemail on the business line).
//   - HERMETIC-SPEED NOTE: in prod a transcript lands ~1-2 MINUTES after the recording,
//     so the SSE-driven contact timeline refetch (300ms trailing debounce) shows the
//     recording, then later the transcript. In the lane the fake fires the completion
//     webhook in ~milliseconds, so recording/pending/completed can coalesce and the
//     debounced refetch may not re-render the final state. To stay robust we POLL the
//     timeline API for readiness, THEN navigate so the initial page fetch is the
//     authoritative source (no live-SSE dependency). Test 3 keeps a real 2s pending
//     window (the dropped-webhook reconcile), so it observes "Transcribing..." live.
//   - All call-card assertions are scoped to the "Communications and activity" region
//     (accessibility-first per e2e/support/selectors.md).
//   - Test 4 needs a real relay pool number (getByPoolNumber), which lives only in the
//     FULL seed profile, so it reseeds full then restores the lean baseline in afterAll
//     (mirrors relay-group-view.spec.ts; workers:1 / fullyParallel:false = no race).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { placeCall, listCalls } from '../../fixtures/fakeVoice.js';
import { getOutbox } from '../../fixtures/outbox.js';
import { reseed } from '../../fixtures/reseed.js';
import { uniqueVoicePhone, callTimeline } from '../../fixtures/voiceSetup.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The app's own business number in the e2e stack (OUR_PHONE_NUMBERS[0]) -> the
 *  founder-bridge line. An inbound call here runs the whisper/press-1 bridge. */
const BUSINESS = '+15550009999';

// --- Live seed constants (app/src/lib/seed/live.ts, FULL profile only) --------
// The seeded live relay group's pool number + a rostered member, reused by the
// masked-miss test. Same values relay-group-view.spec.ts drives.
const RELAY_POOL = '+15550160001';
const RELAY_MEMBER = '+15550170001'; // Diana Osei (a rostered member of the group)

/** Dev-login as the seeded navigator, then land on the SPA so the session cookie
 *  is live for subsequent page.request API calls (mirrors voice-outbound.spec.ts). */
async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Create a fresh tenant contact via the authenticated API; returns its id + phone.
 *  An inbound call FROM that phone lands on this contact's 1:1 conversation. */
async function createContact(api: APIRequestContext): Promise<{ contactId: string; phone: string }> {
  const phone = uniqueVoicePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'Caller', lastName: 'Tester', phone },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return { contactId: contact.contactId, phone };
}

/** The contact's single `call` timeline entry (via the API), or undefined. */
async function latestCall(api: APIRequestContext, contactId: string): Promise<Record<string, unknown> | undefined> {
  const calls = await callTimeline(api, contactId);
  return calls[calls.length - 1];
}

/** The contact page's call/message transcript region (accessible name = the aria-label). */
function commsRegion(page: Page) {
  return page.getByRole('region', { name: 'Communications and activity' });
}

// Each case starts from a clean lean slate. Dev-login happens AFTER the reseed so the
// session epoch matches the re-seeded users.
test.beforeEach(async ({ request }) => {
  await reseed(request);
});

// Test 4 reseeds the FULL profile (the live relay group + its pool number live only
// there). Restore the lean baseline the rest of the suite expects, so a later
// non-reseeding spec is not surprised by a lingering full seed.
test.afterAll(async ({ request }) => {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean restore reseed failed: ${res.status()}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 1. Answered business-line call -> transcript (speaker labels) + player
// ---------------------------------------------------------------------------
test('an answered business-line call gets a transcript with speaker labels + a recording player', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);
  const { contactId, phone: caller } = await createContact(api);

  // Inbound to the business line; digit:'1' auto-runs the bridge to ANSWERED, which
  // records (record-from-answer-dual) and requests a VI transcript. Two sentences ->
  // the fake alternates media channels 1/2; the inbound bridge stamps source-attributed
  // roles (channel 1 = client, 2 = staff), so the app renders "Client:/Staff:" labels
  // (voice-extraction Layer 1) - NOT the legacy "Speaker N:" ordinals.
  await placeCall(api, {
    from: caller,
    to: BUSINESS,
    scenario: { digit: '1', transcript: 'Hello about the unit. Sounds good.' },
  });

  // Wait for the whole pipeline (recording + delivered VI transcript) at the API level,
  // then navigate so the page's initial fetch is authoritative.
  await expect
    .poll(async () => {
      const c = await latestCall(api, contactId);
      return typeof c?.['transcript'] === 'string' ? String(c['transcript']) : '';
    }, { timeout: 25_000 })
    .toContain('Client:');

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const region = commsRegion(page);

  // The audio player renders (recording_s3_key + call_sid), and the completed
  // transcript is a collapsible; expand it and assert the dual-channel labels.
  await expect(region.getByLabel('Call recording')).toBeVisible({ timeout: 15_000 });
  const transcript = region.getByText('Transcript', { exact: true });
  await expect(transcript).toBeVisible({ timeout: 15_000 });
  await transcript.click();
  await expect(region.getByText(/Client:/)).toBeVisible();
  await expect(region.getByText(/Staff:/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Missed business-line call -> voicemail card + single-channel transcript,
//    and the missed-call auto-text still fires
// ---------------------------------------------------------------------------
test('a missed business-line call takes a voicemail (single-channel transcript + player) and still auto-texts', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);
  const { contactId, phone: caller } = await createContact(api);

  // digit:null -> the founder never accepts the whisper gate -> the bridge MISSES ->
  // the app offers voicemail (Record TwiML); the fake leaves a ~6s message.
  await placeCall(api, {
    from: caller,
    to: BUSINESS,
    scenario: { digit: null, transcript: 'Please call me back.' },
  });

  // The missed-call auto-text fires at Dial-summary time (unchanged behavior).
  await expect
    .poll(
      async () => {
        const msgs = await getOutbox(api, { to: caller });
        return msgs.some((m) => /Sorry we missed your call/i.test(m.body ?? ''));
      },
      { timeout: 20_000, message: 'missed-call auto-text not observed in the outbox' },
    )
    .toBe(true);

  // Wait (API level) for the outcome to upgrade to voicemail AND the single-channel
  // transcript to persist, then navigate.
  await expect
    .poll(async () => {
      const c = await latestCall(api, contactId);
      return c ? `${String(c['call_outcome'])}|${typeof c['transcript'] === 'string' ? String(c['transcript']) : ''}` : '';
    }, { timeout: 25_000 })
    .toMatch(/^voicemail\|.*Please call me back/);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const region = commsRegion(page);

  await expect(region.getByText('Voicemail', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(region.getByLabel('Call recording')).toBeVisible({ timeout: 15_000 });

  // A voicemail is single-channel: the transcript has NO speaker labels.
  const transcript = region.getByText('Transcript', { exact: true });
  await expect(transcript).toBeVisible({ timeout: 15_000 });
  await transcript.click();
  await expect(region.getByText('Please call me back.', { exact: false })).toBeVisible();
  await expect(region.getByText(/Speaker \d:/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 3. Dropped VI completion webhook -> "Transcribing..." then reconcile delivers
// ---------------------------------------------------------------------------
test('a dropped VI webhook still transcribes via the reconcile safety net, showing Transcribing... meanwhile', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);
  const { contactId, phone: caller } = await createContact(api);

  // viWebhook:'drop' -> the fake mints + serves the transcript but NEVER posts the
  // completion webhook, so the app must self-heal via the reconcile job (lane delay
  // 2s). One sentence -> single channel -> no speaker label. The 2s gap gives a real
  // pending window (recording+pending land, then nothing for 2s), so we observe the
  // live "Transcribing..." indicator here.
  await placeCall(api, {
    from: caller,
    to: BUSINESS,
    scenario: { digit: '1', transcript: 'Reconciled text.', viWebhook: 'drop' },
  });

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const region = commsRegion(page);

  // Pending indicator while the (dropped) webhook is awaited (before reconcile).
  await expect(region.getByText('Transcribing...')).toBeVisible({ timeout: 15_000 });

  // The reconcile leg re-checks Twilio (the fake) and persists the transcript WITHOUT
  // any webhook delivery. Confirm at the API level, then reload for an authoritative fetch.
  await expect
    .poll(async () => {
      const c = await latestCall(api, contactId);
      return typeof c?.['transcript'] === 'string' ? String(c['transcript']) : '';
    }, { timeout: 25_000 })
    .toContain('Reconciled text.');

  await page.reload();
  const transcript = region.getByText('Transcript', { exact: true });
  await expect(transcript).toBeVisible({ timeout: 15_000 });
  await transcript.click();
  await expect(region.getByText('Reconciled text.', { exact: false })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Missed MASKED relay call -> no recording, hence no voicemail (privacy)
// ---------------------------------------------------------------------------
test('a missed masked relay call is never recorded, so no voicemail is taken', async ({ request }) => {
  // The live relay group + its pool number exist only in the FULL profile.
  const seeded = await request.post(`${NEXT}/__dev/reseed?profile=full`);
  expect(seeded.ok(), `full reseed failed: ${seeded.status()}`).toBeTruthy();

  // A rostered member calls the pool number; digit:null misses the bridge. A masked
  // relay <Dial> is record="do-not-record", so no recording callback EVER fires -
  // even on a miss - and the missed branch never offers a masked caller voicemail.
  const sid = await placeCall(request, {
    from: RELAY_MEMBER,
    to: RELAY_POOL,
    scenario: { digit: null },
  });

  // Let the fake run the masked bridge past the ringing state (to its missed terminal).
  await expect
    .poll(
      async () => {
        const c = (await listCalls(request)).find((x) => x.callSid === sid);
        return c?.status;
      },
      { timeout: 15_000, message: 'masked call never left the ringing state' },
    )
    .not.toBe('ringing');

  const call = (await listCalls(request)).find((x) => x.callSid === sid);
  expect(call, 'the masked call should exist in the fake control API').toBeDefined();
  // The masked privacy invariant: no recording (hence no voicemail) is ever produced.
  expect(call!['recordingSid'], 'a masked relay call must NEVER record a voicemail').toBeUndefined();
});
