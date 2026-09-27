// e2e/tests/dashboard-next/voicemail-greeting.spec.ts
//
// Recorded voicemail greeting (spec 2026-09-26). Proves, against the hermetic
// lane (app + fake-twilio + MinIO):
//   1. an admin uploads a WAV in Settings > Voice; it is listed and the authed
//      audio endpoint serves it (content-type + Accept-Ranges = the playability
//      proxy; a headless <audio> cannot be observed playing);
//   2. a missed business-line call gets <Play> BEFORE <Record>, and the fake
//      Twilio actually fetched the presigned MinIO URL (status 200);
//   3. Remove (with the confirmation dialog) puts the spoken prompt back:
//      the next missed call's verb before <Record> is <Say>;
//   4. phone width: no sideways scroll of the routed <main>, the dialog fits;
//   5. the reject path in the real UI; 6. a VA sees no controls and no alert.
// Selectors are accessibility-first (e2e/support/selectors.md). Overflow is
// measured ONLY through the viewport helpers below: the guard-banned
// document-width expression (see support/viewport.guard.test.ts) must never
// appear in this file, comments included.
//
// Two name-matching traps, avoided on purpose:
//   - getByLabel is a case-insensitive SUBSTRING match, and the open Remove
//     dialog is aria-labelledby its title "Remove voicemail greeting?", so the
//     player is ALWAYS addressed as getByLabel('Voicemail greeting', { exact: true }).
//   - that dialog title is an h2 whose name also contains "voicemail greeting",
//     so the block's own heading is addressed with level: 3.
//
// Upload budget: the PUT route allows 10 uploads per minute per user (spec
// 4.3) and one pass of this file makes 3 as the founder (two uploads + the
// server-side refusal). More than three passes inside one minute against the
// same app process (e.g. --repeat-each=4 on a live session) therefore trip
// that limiter's 429 BY DESIGN - the upload then shows "Couldn't upload the
// greeting." - which is not a flake. A fresh or restarted app resets it.
import { test, expect, type Page } from '@playwright/test';
import { listCalls, placeCall } from '../../fixtures/fakeVoice.js';
import { reseed } from '../../fixtures/reseed.js';
import { uniqueVoicePhone, NEXT } from '../../fixtures/voiceSetup.js';
import { expectTodayReady } from '../../support/today.js';
import {
  expectNoHorizontalOverflow,
  expectNoHorizontalOverflowIn,
  NARROW_360,
  WIDE_RESTORE,
} from '../../support/viewport.js';

/** The app's business number in the e2e stack (BUSINESS_PHONE_NUMBER). */
const BUSINESS = '+15550009999';
const AUDIO_PATH = '/api/settings/voicemail-greeting/audio';
/** The block's empty state - after a reseed, its LOADED state for every role. */
const NO_GREETING = 'No greeting uploaded - callers hear the built-in prompt.';
/** Verbatim the server's (and the client pre-check's) refusal (spec 3.1). */
const REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
/** The first 12 bytes of an iPhone voice memo: an MPEG-4 `ftyp` box, brand "M4A ". */
const M4A_HEADER = Buffer.from('\u0000\u0000\u0000\u0018ftypM4A ', 'latin1');

/** A minimal PCM WAV: 44-byte RIFF/WAVE header + zero samples. */
function minimalWav(silenceBytes = 4000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + silenceBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(silenceBytes, 40);
  return Buffer.concat([header, Buffer.alloc(silenceBytes, 0)]);
}

async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/**
 * Open Settings > Voice and wait for the greeting block's LOADED state, not
 * just its heading (which renders while the block's GET /api/settings is still
 * in flight). Every test starts from a reseed, so that state is the empty-state
 * line for admin and VA alike. Without this wait an upload could race the first
 * GET (whose stale response would overwrite the fresh greeting), and the VA's
 * toHaveCount(0) checks could pass before the block had rendered anything.
 */
async function openVoiceTab(page: Page): Promise<void> {
  await page.goto(`${NEXT}/settings/voice`);
  await expect(page.getByRole('heading', { name: 'Voicemail greeting', level: 3 })).toBeVisible();
  await expect(page.getByText(NO_GREETING)).toBeVisible();
}

async function uploadWav(page: Page, name = 'sam-greeting.wav'): Promise<void> {
  await page.getByLabel('Greeting audio file').setInputFiles({ name, mimeType: 'audio/wav', buffer: minimalWav() });
  await expect(page.getByText('Greeting uploaded.')).toBeVisible({ timeout: 15_000 });
}

/** The fake's record of a missed call's greeting verb, polled until the call settles. */
async function greetingVerbOf(page: Page, callSid: string): Promise<{ verb?: string; fetchStatus?: number }> {
  let out: { verb?: string; fetchStatus?: number } = {};
  await expect
    .poll(
      async () => {
        const call = (await listCalls(page.request)).find((c) => c.callSid === callSid);
        if (!call || call.status !== 'completed') return false;
        out = { verb: call['voicemailGreeting'] as string | undefined, fetchStatus: call['voicemailGreetingFetchStatus'] as number | undefined };
        return true;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return out;
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test('admin uploads a greeting; a missed call plays it (fake fetched the presigned URL); Remove restores the spoken prompt', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  await openVoiceTab(page);

  // (1) upload + listed + served
  await uploadWav(page);
  await expect(page.getByText('sam-greeting.wav')).toBeVisible();
  const audio = page.getByLabel('Voicemail greeting', { exact: true });
  await expect(audio).toBeVisible();
  const src = await audio.getAttribute('src');
  expect(src).toContain(`${AUDIO_PATH}?v=`);
  const served = await page.request.get(`${NEXT}${src}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toContain('audio/wav');
  expect(served.headers()['accept-ranges']).toBe('bytes');

  // (2) a missed business-line call: <Play> before <Record>, and the fake GOT the file
  const first = await placeCall(page.request, { from: uniqueVoicePhone(), to: BUSINESS, scenario: { digit: null, voicemail: { durationSec: 3 } } });
  const played = await greetingVerbOf(page, first);
  expect(played.verb).toBe('play');
  expect(played.fetchStatus).toBe(200);

  // (3) remove with confirmation -> spoken prompt again
  await page.getByRole('button', { name: 'Remove greeting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove voicemail greeting?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Greeting removed.')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(NO_GREETING)).toBeVisible();
  expect((await page.request.get(`${NEXT}${src}`)).status()).toBe(404);

  const second = await placeCall(page.request, { from: uniqueVoicePhone(), to: BUSINESS, scenario: { digit: null, voicemail: { durationSec: 3 } } });
  const spoken = await greetingVerbOf(page, second);
  expect(spoken.verb).toBe('say');
  expect(spoken.fetchStatus).toBeUndefined();
});

test('the reject path in the real UI: an M4A shows the given message and nothing is listed', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  await openVoiceTab(page);
  await page.getByLabel('Greeting audio file').setInputFiles({ name: 'memo.m4a', mimeType: 'audio/mp4', buffer: M4A_HEADER });
  await expect(page.getByRole('alert')).toHaveText(REJECT_MESSAGE);
  await expect(page.getByText(NO_GREETING)).toBeVisible();
  // A renamed M4A the browser calls audio/mpeg passes the client pre-check and
  // is refused by the SERVER's sniff with the same message. The alert text is
  // identical to the client-side one above, so the proof is the PUT's 400
  // response, awaited explicitly, and the alert re-appearing after it (the
  // hook clears the previous error when a new file is chosen). 200 KB stays
  // under the Vite dev proxy's `Connection: close` window (spec 4.3).
  const refusal = page.waitForResponse((r) => r.url().includes('/api/settings/voicemail-greeting') && r.request().method() === 'PUT');
  await page.getByLabel('Greeting audio file').setInputFiles({ name: 'memo.mp3', mimeType: 'audio/mpeg', buffer: Buffer.concat([M4A_HEADER, Buffer.alloc(200_000, 0)]) });
  const res = await refusal;
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe('unsupported_media_type');
  await expect(page.getByRole('alert')).toHaveText(REJECT_MESSAGE);
  await expect(page.getByText(NO_GREETING)).toBeVisible();
  // "Nothing is listed" on the SERVER too, not just in the block's local
  // state: the org record holds no greeting, so the audio route answers 404.
  expect((await page.request.get(`${NEXT}${AUDIO_PATH}`)).status()).toBe(404);
});

test('phone width: the block and the Remove dialog fit without sideways scroll', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  await page.setViewportSize(NARROW_360);
  try {
    await openVoiceTab(page);
    await uploadWav(page, 'a-rather-long-greeting-file-name-that-should-wrap-not-scroll.wav');
    await expectNoHorizontalOverflow(page, '/settings/voice with a greeting');
    await expect(page.getByLabel('Voicemail greeting', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace greeting' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove greeting' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove greeting' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove voicemail greeting?' });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalOverflowIn(dialog, 'Remove voicemail greeting dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await page.setViewportSize(WIDE_RESTORE);
  }
});

test('a VA sees the greeting block read-only: no controls, no alert at load', async ({ page }) => {
  await devLoginAs(page, 'va@example.com');
  await openVoiceTab(page);
  await expect(page.getByText(/An admin can upload or change it/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload greeting' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove greeting' })).toHaveCount(0);
  // The sr-only file input stays in the tab order for an admin once the block
  // has loaded (which openVoiceTab waited for), so its absence here is real.
  await expect(page.getByLabel('Greeting audio file')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
