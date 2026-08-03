// e2e/tests/dashboard-next/recording-range.spec.ts
//
// Call-recording playback must be SEEKABLE (2026-08-03). The serving route used
// to answer 200 with the whole body and no Accept-Ranges, so browsers treated
// the audio as non-seekable: play/pause worked but the native scrubber refused
// to move. The fix forwards a single byte range to S3 and mirrors the partial
// response back.
//
// Why this lives in e2e and not only in app/test: the unit tests drive a
// MediaStore DOUBLE. Only this spec exercises the REAL path - S3MediaStore ->
// the aws-sdk client -> MinIO - which is where a Range that never reaches S3,
// or a ContentRange that never comes back, would actually show up. The second
// test then proves the thing the user reported, in a real browser: the <audio>
// element reports a seekable range and a seek STICKS.
//
// Driving notes (mirrors voice-transcription.spec.ts): create the caller as a
// tenant contact via the authenticated API, then place an inbound call from that
// phone with digit:'1' so the founder bridge auto-answers, records, and mirrors
// the recording into MinIO. Poll the timeline API for the stored recording
// before asserting.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { placeCall } from '../../fixtures/fakeVoice.js';
import { uniqueVoicePhone, callTimeline, NEXT } from '../../fixtures/voiceSetup.js';

/** The app's own business number in the e2e stack -> the founder-bridge line. */
const BUSINESS = '+15550009999';

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function createContact(api: APIRequestContext): Promise<{ contactId: string; phone: string }> {
  const phone = uniqueVoicePhone();
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: 'Range', lastName: 'Tester', phone },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { contact } = (await res.json()) as { contact: { contactId: string } };
  return { contactId: contact.contactId, phone };
}

/** Place an ANSWERED founder-bridge call and wait until its recording is stored.
 *  Returns the bare CallSid the player's URL uses. */
async function recordedCall(api: APIRequestContext, contactId: string, phone: string): Promise<string> {
  await placeCall(api, { from: phone, to: BUSINESS, scenario: { digit: '1' } });
  let callSid = '';
  await expect
    .poll(
      async () => {
        const calls = await callTimeline(api, contactId);
        const withRecording = calls.find(
          (c) => typeof c['call_sid'] === 'string' && c['recording_s3_key'] !== undefined,
        );
        if (withRecording) callSid = withRecording['call_sid'] as string;
        return callSid;
      },
      { timeout: 20_000, message: 'the bridge call never stored a recording' },
    )
    .toBeTruthy();
  return callSid;
}

test.describe('call recording serving - HTTP Range (seekable audio)', () => {
  test('serves Accept-Ranges, honors a byte range with 206, and 416s an unsatisfiable one', async ({
    page,
  }) => {
    await devLogin(page);
    const api = page.request;
    const { contactId, phone } = await createContact(api);
    const callSid = await recordedCall(api, contactId, phone);
    const url = `${NEXT}/api/calls/${callSid}/recording`;

    // 1. The plain read advertises range support - this header alone is what
    //    makes the element seekable in the browser.
    const full = await api.get(url);
    expect(full.status()).toBe(200);
    expect(full.headers()['accept-ranges']).toBe('bytes');
    const total = (await full.body()).length;
    expect(total).toBeGreaterThan(0);

    // 2. A byte range comes back as a real partial response from MinIO.
    const partial = await api.get(url, { headers: { Range: 'bytes=0-99' } });
    expect(partial.status()).toBe(206);
    expect(partial.headers()['content-range']).toBe(`bytes 0-99/${total}`);
    expect(partial.headers()['accept-ranges']).toBe('bytes');
    const partialBody = await partial.body();
    expect(partialBody.length).toBe(100);
    expect(partialBody.equals((await full.body()).subarray(0, 100))).toBe(true);

    // 3. A range past the end is a client error, not a 500 and not a 404.
    const unsatisfiable = await api.get(url, { headers: { Range: `bytes=${total + 1000}-` } });
    expect(unsatisfiable.status()).toBe(416);
    expect(unsatisfiable.headers()['content-range']).toBe(`bytes */${total}`);

    // 4. A multi-range value is IGNORED and degrades to the full 200 (RFC 7233).
    const multi = await api.get(url, { headers: { Range: 'bytes=0-10,20-30' } });
    expect(multi.status()).toBe(200);
    expect(multi.headers()['content-range']).toBeUndefined();
    expect((await multi.body()).length).toBe(total);
  });

  test('the rendered player is actually seekable in the browser (the reported bug)', async ({ page }) => {
    await devLogin(page);
    const api = page.request;
    const { contactId, phone } = await createContact(api);
    await recordedCall(api, contactId, phone);

    await page.goto(`${NEXT}/contacts/${contactId}`);
    const player = page.getByLabel('Call recording').first();
    await expect(player).toBeVisible();

    // preload="none" means nothing loads until playback starts, so start it
    // (muted) and wait for metadata before asking about seekability.
    const result = await player.evaluate(async (el: HTMLAudioElement) => {
      el.muted = true;
      await el.play().catch(() => undefined);
      if (el.readyState < 1) {
        await new Promise((resolve) => el.addEventListener('loadedmetadata', resolve, { once: true }));
      }
      el.pause();
      const seekableRanges = el.seekable.length;
      const duration = el.duration;
      // Seek to the midpoint and confirm the position STICKS - this is exactly
      // what dragging the scrubber does, and what used to silently snap back.
      const target = Number.isFinite(duration) && duration > 0 ? duration / 2 : 0.5;
      el.currentTime = target;
      await new Promise((resolve) => el.addEventListener('seeked', resolve, { once: true }));
      return { seekableRanges, duration, target, currentTime: el.currentTime };
    });

    // A non-seekable resource reports ZERO seekable ranges - that was the bug.
    expect(result.seekableRanges).toBeGreaterThan(0);
    expect(Math.abs(result.currentTime - result.target)).toBeLessThan(0.5);
  });
});
