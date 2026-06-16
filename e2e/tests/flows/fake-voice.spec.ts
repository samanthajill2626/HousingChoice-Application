import { test, expect } from '../../fixtures/auth.js';
import { placeCall } from '../../fixtures/fakeVoice.js';

// Scripted VOICE proofs over the HTTP seam (Phase 8). The fake-twilio CallEngine
// drives the REAL app voice webhooks (place-call → /webhooks/twilio/voice →
// whisper → press-1 gate → <Dial action> status, plus the recording +
// transcription callbacks for a recorded founder-bridge), exactly as Twilio's
// voice runtime would. We then assert the PERSISTED app-side `call` entity via
// the app's OWN authed API — never the fake's view of the call.
//
// ASSERTION SURFACE (the real one): GET /api/calls/:callId → { call, conversation }
//   (app/src/routes/api.ts). `:callId` is the Twilio CallSid == the call entry's
//   provider_sid == the callSid placeCall() returns. The call carries the M1.9
//   fields: call_status, call_outcome, answered_at, masked, recording_s3_key,
//   transcript (app/src/repos/messagesRepo.ts MessageItem). This router sits
//   behind requireAuth, so we hit it with the VA context's request
//   (vaPage.request) — the Vite dev proxy forwards /api → the app (:8080).
//
// LIVE-RUN CAVEATS (the human must confirm these at the joint live step — the
// current e2e-session.mjs env does NOT set them, and each is REQUIRED for the
// corresponding assertion below to pass; see the per-test notes):
//   • FOUNDER_CELL — without it, handleFounderTriage() degrades to the "text us"
//     fallback and NEVER persists a `call` entry (founder triage is DISABLED).
//     Proof 1 needs founder triage ENABLED (a business number + a founder cell).
//   • MEDIA_BUCKET — without a media store, the /voice/recording callback logs
//     "recording NOT mirrored" and does NOT stamp recording_s3_key. Proof 1's
//     recording assertion needs MEDIA_BUCKET set (the transcript does NOT — it
//     persists with no S3 dependency).
//   • RELAY_LIVE_PROVISIONING — defaults to (messagingDriver==='console'); the
//     e2e env runs the twilio driver, so it defaults to FALSE and "Set up relay
//     thread" returns 503 relay_provisioning_disabled. Proof 2 (and boards.spec)
//     need it TRUE so the pool number is minted through the fake (Phase 6).

// Seeded by db:seed (app/src/lib/seedData.ts) — both carry a phone.
const TENANT_ID = 'contact-tenant-0001';
const UNIT_ID = 'unit-0001';
// The hermetic business number the app owns (scripts/e2e-session.mjs:
// OUR_PHONE_NUMBERS) — an inbound call to it routes to founder triage.
const BUSINESS_NUMBER = '+15550009999';
// An arbitrary external caller (NOT one of our numbers, NOT a pool number).
const CALLER_PHONE = '+15550107777';

/** The shape GET /api/calls/:callId returns (the fields these proofs read). */
interface CallApiResponse {
  call: {
    provider_sid: string;
    type: string;
    masked?: boolean;
    call_status?: string;
    call_outcome?: string;
    answered_at?: string;
    recording_s3_key?: string;
    transcript?: string;
  };
  conversation: unknown;
}

/**
 * Poll GET /api/calls/:callSid until the call entry exists (status < 404), then
 * return the parsed { call }. Uses the AUTHED VA request context (the /api mount
 * is behind requireAuth). The fake auto-runs the placed call on its real clock
 * AFTER place-call returns, so the entry appears + advances asynchronously.
 */
async function pollCall(
  vaPageRequest: import('@playwright/test').APIRequestContext,
  callSid: string,
): Promise<CallApiResponse> {
  let last: CallApiResponse | undefined;
  await expect
    .poll(
      async () => {
        const res = await vaPageRequest.get(`/api/calls/${callSid}`);
        if (res.status() === 404) return 404;
        if (!res.ok()) throw new Error(`GET /api/calls/${callSid} failed: ${res.status()}`);
        last = (await res.json()) as CallApiResponse;
        return res.status();
      },
      { timeout: 15_000 },
    )
    .toBe(200);
  if (last === undefined) throw new Error('call response never captured');
  return last;
}

// PROOF 1 — FOUNDER-TRIAGE (recorded + transcribed). A caller dials the business
// number; the fake answers the founder leg, presses 1 (accept), records, and
// posts a transcript. The app persists a NON-masked `call`, marks it answered,
// mirrors the recording (recording_s3_key) and saves the verbatim transcript.
//
// NEEDS at live-run: FOUNDER_CELL (else no call entry persisted) AND MEDIA_BUCKET
// (else recording_s3_key is never stamped — the transcript still is). See the
// file header. The transcript + answered assertions are env-independent of
// MEDIA_BUCKET; only the recording_s3_key assertion depends on it.
test('founder-triage: an inbound business call is answered, recorded, and transcribed', async ({
  vaPage,
}) => {
  const transcript = `Founder triage verbatim ${Date.now()}`;
  const callSid = await placeCall(vaPage.request, {
    from: CALLER_PHONE,
    to: BUSINESS_NUMBER,
    scenario: { answerLeg: 'founder', digit: '1', record: true, transcript },
  });

  // The founder-bridge `call` is persisted NON-masked and progresses to answered
  // (press-1 stamps answered_at; the <Dial action> summary completes it).
  await expect
    .poll(
      async () => {
        const res = await vaPage.request.get(`/api/calls/${callSid}`);
        if (!res.ok()) return undefined;
        return ((await res.json()) as CallApiResponse).call.answered_at;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();

  const { call } = await pollCall(vaPage.request, callSid);
  expect(call.type).toBe('call');
  expect(call.masked).not.toBe(true); // founder-bridge — recordable
  expect(call.call_outcome).toBe('answered');

  // The verbatim transcript is saved by the /voice/transcription callback (no S3
  // dependency — persists regardless of MEDIA_BUCKET).
  await expect
    .poll(
      async () => (await pollCall(vaPage.request, callSid)).call.transcript,
      { timeout: 15_000 },
    )
    .toBe(transcript);

  // The recording is mirrored to S3 → recording_s3_key is stamped.
  // ENV-DEPENDENT: only when MEDIA_BUCKET is configured (see the file header). If
  // the live env has MEDIA_BUCKET unset, the human should expect this single
  // assertion to need MEDIA_BUCKET added to the e2e env (the answered + transcript
  // proofs above already exercise the full recorded founder-bridge path).
  await expect
    .poll(
      async () => (await pollCall(vaPage.request, callSid)).call.recording_s3_key,
      { timeout: 15_000 },
    )
    .toBeTruthy();
});

// PROOF 2 — MASKED RELAY (answered, NEVER recorded). First set up a relay thread
// through the boards UI (which provisions a pool number THROUGH the fake — the
// same path boards.spec.ts exercises), learn the minted pool number from the
// app, then place a masked call to it. The masked bridge is recorded as answered,
// and — the guardrail — carries NO recording (masked calls are do-not-record).
//
// NEEDS at live-run: RELAY_LIVE_PROVISIONING=true (else "Set up relay thread"
// 503s and no pool number is minted — see the file header AND the Task 8.2
// boards-regression note).
test('masked-relay: a pool-number call bridges answered with NO recording', async ({ vaPage }) => {
  const stamp = `${Date.now()}`.slice(-7);
  const tag = `E2E voice relay ${stamp}`;

  // 1) Open a NEW case for the seeded tenant + listing (mirrors boards.spec.ts).
  await vaPage.goto('/boards/new');
  await expect(vaPage.getByRole('heading', { name: 'New case' })).toBeVisible();
  await vaPage.getByLabel('Tenant').selectOption(TENANT_ID);
  await vaPage.getByLabel('Listing').selectOption(UNIT_ID);
  await vaPage.getByLabel('Placement tag').fill(tag);
  await vaPage.getByRole('button', { name: 'Open case' }).click();

  // 2) Land on the case detail; capture the caseId from the URL.
  await expect(vaPage).toHaveURL(/\/boards\/case-/);
  await expect(vaPage.getByRole('heading', { name: tag })).toBeVisible();
  const caseId = new URL(vaPage.url()).pathname.split('/').pop() as string;

  // 3) Set up the masked relay thread (provisions a pool number through the fake).
  await vaPage.getByRole('button', { name: 'Set up relay thread' }).click();
  await expect(vaPage.getByRole('link', { name: 'Open relay thread' })).toBeVisible();

  // 4) Learn the minted pool number from the app: case.group_thread → the relay
  //    conversation → its pool_number. (GET /api/cases/:id and
  //    GET /api/conversations/:id are both behind requireAuth → vaPage.request.)
  const caseRes = await vaPage.request.get(`/api/cases/${caseId}`);
  expect(caseRes.ok()).toBe(true);
  const groupThread = ((await caseRes.json()) as { case: { group_thread?: string } }).case.group_thread;
  expect(groupThread, 'case.group_thread should be set after relay setup').toBeTruthy();

  const convoRes = await vaPage.request.get(`/api/conversations/${groupThread}`);
  expect(convoRes.ok()).toBe(true);
  const poolNumber = ((await convoRes.json()) as { conversation: { pool_number?: string } }).conversation
    .pool_number;
  expect(poolNumber, 'the relay conversation should carry a pool_number').toBeTruthy();

  // 5) Place a MASKED call: the seeded tenant calls the pool number; the fake
  //    answers the callee (landlord) leg + presses 1 to accept the bridge.
  const callSid = await placeCall(vaPage.request, {
    from: '+15550100001', // the seeded tenant (a relay participant)
    to: poolNumber as string,
    scenario: { answerLeg: 'callee', digit: '1' },
  });

  // 6) The bridge is recorded as ANSWERED…
  const { call } = await pollCall(vaPage.request, callSid);
  expect(call.type).toBe('call');
  expect(call.masked).toBe(true);
  await expect
    .poll(
      async () => (await pollCall(vaPage.request, callSid)).call.call_outcome,
      { timeout: 15_000 },
    )
    .toBe('answered');

  // 7) …and the GUARDRAIL: a masked call is NEVER recorded — no recording_s3_key,
  //    no transcript, ever. Assert it stays absent (let the call fully settle).
  const settled = await pollCall(vaPage.request, callSid);
  expect(settled.call.recording_s3_key).toBeFalsy();
  expect(settled.call.transcript).toBeFalsy();
});
