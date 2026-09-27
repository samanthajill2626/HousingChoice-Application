# Recorded Voicemail Greeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin uploads an MP3/WAV greeting in Settings > Voice; a caller who reaches the business line's voicemail hears it (`<Play>`) before the beep, with today's spoken prompt as the time-bounded fallback.

**Architecture:** The greeting is ONE object under a fixed media-store key plus ONE optional map on the org settings record. Two admin-only routes under the existing `/api/settings` prefix write it (raw-body PUT streamed through a sniff-and-cap Transform into `mediaStore.put`; DELETE clears the record then best-effort deletes the object); one authed GET streams it back through a helper extracted from the call-recording route; the voice webhook's missed-call branch reads the record, HEADs the object, presigns a 10-minute URL and emits `<Play>`, all inside a 2.5 s budget that falls back to `<Say>`. The dashboard adds a sub-block to the Voice tab; fake-twilio records which verb preceded `<Record>` so the e2e can prove it at the boundary.

**Tech Stack:** Node 24 / Express 5 / TypeScript (app), `@aws-sdk/lib-storage` via the existing `MediaStore` adapter, DynamoDB (settings item), twilio `VoiceResponse`, React 19 + CSS modules (dashboard), vitest + supertest + RTL, Playwright (e2e workspace only), fast-xml-parser (fake-twilio).

**Spec:** `docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md` (DRAFT 3, approved). The plan argues from the spec; read both. Section numbers below refer to it. Plan status: DRAFT 2 after plan review round 1 (two reviewers, every finding accepted; adjudications in `docs/superpowers/reviews/2026-09-26-voicemail-greeting/plan-r1-adjudications.md`).

## Global Constraints

- Accepted upload types: `audio/mpeg`, `audio/wav`, `audio/x-wav` (stored canonical: `audio/mpeg` | `audio/wav`); server checks the Content-Type AND sniffs the first 12 bytes; declared type and header must agree (spec 3.1, 4.1).
- Size cap: 5 MB = `5 * 1024 * 1024` bytes. Reject message, verbatim: `Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.` (spec 3.1).
- Fixed key: `settings/voicemail-greeting`. Play URL TTL: 600 s. Lookup budget: 2500 ms. Rate limit: 10 uploads/min/user. File name cap: 120 code points. Header for the file name: `X-Greeting-File-Name`, URI-encoded (spec 4.1, 4.3).
- The webhook NEVER fails because of the greeting: any lookup-time failure or timeout -> `<Say>` prompt + one WARN with no PII; no log line when no greeting is set (spec 3.3, assumption F, 4.6).
- Never log: the file name, the presigned URL, audio bytes. ERROR level only for server faults (spec 4.10).
- Admin-only mutation; every logged-in user may read/play (assumption A). Remove has a confirmation dialog; Replace does not (assumption E).
- No new dependency, no infrastructure change, no message-catalog entry, no change to `<Record>` parameters or the thanks/goodbye (spec 3.5, 4.10).
- ASCII only in every new/touched line of code, tests, specs and docs. Never `Get-Content | -replace | Set-Content`. Commit explicit paths after a gating `git status`; end every commit message with a `Co-Authored-By:` trailer naming the model that AUTHORED the commit (the implementer child's own model, e.g. `Co-Authored-By: Claude Opus 4.1 <noreply@anthropic.com>`); the commit blocks below write `<AUTHORING MODEL>` where that name goes - never copy a placeholder literally.
- The test harness (`app/test/helpers/twilioWebhookHarness.ts`, supertest) sends `Connection: close` unless told otherwise; every large-body upload test sets `Connection: keep-alive` (Task 4), or the client resets before the 4xx JSON arrives and the failure looks like a route bug. It is not.
- Run fast checks per task from the worktree: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/<file>` and `cd W:/tmp/voicemail-greeting && npm run typecheck`. The slow gates (`npm test`, `npm run smoke`, `npm run e2e`, gate 5 lint) belong to the orchestrator's gate phase.
- Every e2e assertion uses accessibility-first selectors; NEVER `documentElement.scrollWidth` (a guard test fails the file); hermetic lane only.
- Never edit: `app/src/adapters/messaging.ts`, `app/src/services/sendMessage.ts`, `app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/relayFanOut.ts`, `app/src/jobs/relayRetryLeg.ts`, `app/src/jobs/retrySend.ts`, `app/src/repos/messagesRepo.ts`, `app/src/repos/broadcastsRepo.ts`, `dashboard/src/routes/contact/deliveryStatus.ts`, `dashboard/src/routes/contact/relayRetryJoin.ts`, `dashboard/src/routes/broadcasts/**`, broadcast seed fixtures. `dashboard/src/api/types.ts`, `client.ts`, `endpoints.ts`: additive edits only.

## Review Focus

1. An admin renames an M4A voice memo to `.mp3` and uploads it: the browser reports `audio/mpeg`, the server sniff must refuse it with the M4A message, and that message must REACH the browser (the socket must not be reset before the 400 is written). Pinned in Task 4 (sniff-mismatch route test asserts the JSON body) and Task 8 (the client maps `unsupported_media_type` to the message).
2. A greeting is set, then S3 hangs during a missed call: the caller must hear the spoken prompt inside the budget, and no `<Play>` may be appended after the `<Say>`. Pinned in Task 5 test (e).
3. A 5 MB upload from a slow connection while a caller reaches voicemail: the old greeting must still play byte-for-byte until the single PutObject lands. Pinned in Task 4 (refused second upload leaves the object byte-identical; the happy-path replace records exactly one put).
4. A VA opens Settings > Voice: no upload/remove controls, no alert at load, the cell-verification flow unchanged. Pinned in Task 8 (VA render test, load-failure renders a status not an alert) and Task 9 (VA e2e, zero alerts).
5. A stale or hand-edited settings item pointing `s3Key` at a call recording: the webhook and the audio route must treat it as "no greeting". Pinned in Task 2 (projection rejects a foreign key).

---

## File map

Create:
- `app/src/lib/voicemailGreeting.ts` - constants, type normalization, header sniff, `GreetingUploadGate`, file-name sanitizer, `withTimeout`.
- `app/src/routes/serveMediaObject.ts` - the range/416/404 streaming helper shared by recordings and the greeting audio route.
- `app/test/voicemailGreeting.test.ts`, `app/test/voicemailGreetingRoutes.test.ts`.
- `dashboard/src/routes/settings/useVoicemailGreeting.ts`, `VoicemailGreetingBlock.tsx`, `VoicemailGreetingBlock.test.tsx`.
- `e2e/tests/dashboard-next/voicemail-greeting.spec.ts`.
- `docs/issues/voicemail-greeting-format-normalization.md`.

Modify:
- `app/src/repos/settingsRepo.ts` (record type, projection, patch type).
- `app/src/routes/settings.ts` (patch type Omit, three new routes, `mediaStore` dep).
- `app/src/routes/api.ts` (pass `mediaStore` to the settings router; recording route uses the helper).
- `app/src/routes/webhooks/voice.ts` (greeting offer in the `/status` miss branch; budget dep).
- `app/test/helpers/twilioWebhookHarness.ts` (settings fake learns the field; media fake seams; harness option).
- `app/test/settings.test.ts`, `app/test/founderTriage.test.ts` (new cases).
- `fake-twilio/src/engine/twimlInterpreter.ts`, `voiceTypes.ts`, `callEngine.ts`; `fake-twilio/test/twimlInterpreter.test.ts` (new or extended), `callEngineVoicemail.test.ts`.
- `dashboard/src/api/types.ts`, `client.ts`, `endpoints.ts` (additive); `dashboard/src/api/mmsMedia.client.test.ts` sibling: new `voicemailGreeting.client.test.ts`.
- `dashboard/src/routes/settings/VoiceSection.tsx`, `VoiceSection.test.tsx`, `VoiceSection.module.css`.
- `e2e/performance/mutationCatalog.ts`, `mutationCatalog.test.ts` (108 -> 110), `routes.ts`, `routes.test.ts`.

---

### Task 1: Greeting library (types, sniff, gate, sanitizer, timeout)

**Files:**
- Create: `app/src/lib/voicemailGreeting.ts`
- Create: `app/test/helpers/audioFixtures.ts` (a shared WAV fixture; a HELPER, not a test file, so importing it never re-runs a suite)
- Test: `app/test/voicemailGreeting.test.ts`

**Interfaces:**
- Produces (used by Tasks 2, 4, 5, 8): every export below, byte-exact names; `minimalWav(silenceBytes?: number): Buffer` from the helper.

- [ ] **Step 0: The shared WAV fixture**

```ts
// app/test/helpers/audioFixtures.ts
// Audio fixtures shared by the voicemail-greeting suites. A HELPER module (no
// describe/it): importing it from several test files must never re-run a suite.
// minimalMp3() already lives in app/src/lib/seed/media.ts.

/** A minimal PCM WAV: 44-byte RIFF/WAVE header + `silenceBytes` zero samples. */
export function minimalWav(silenceBytes = 64): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + silenceBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(16000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(silenceBytes, 40);
  return Buffer.concat([header, Buffer.alloc(silenceBytes, 0)]);
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// app/test/voicemailGreeting.test.ts
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  GreetingRejectedError,
  GreetingLookupTimeoutError,
  GreetingUploadGate,
  normalizeGreetingContentType,
  sanitizeGreetingFileName,
  sniffGreetingHeader,
  VOICEMAIL_GREETING_MAX_BYTES,
  VOICEMAIL_GREETING_REJECT_MESSAGE,
  VOICEMAIL_GREETING_S3_KEY,
  withTimeout,
} from '../src/lib/voicemailGreeting.js';
import { minimalMp3 } from '../src/lib/seed/media.js';
import { minimalWav } from './helpers/audioFixtures.js';

async function drain(gate: GreetingUploadGate, input: Buffer[]): Promise<Buffer> {
  const out: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gate.on('data', (c: Buffer) => out.push(c));
    gate.on('end', resolve);
    gate.on('error', reject);
  });
  Readable.from(input).pipe(gate);
  await done;
  return Buffer.concat(out);
}

describe('normalizeGreetingContentType', () => {
  it('accepts the three given types and canonicalizes x-wav', () => {
    expect(normalizeGreetingContentType('audio/mpeg')).toEqual({ contentType: 'audio/mpeg', format: 'mp3' });
    expect(normalizeGreetingContentType('audio/wav')).toEqual({ contentType: 'audio/wav', format: 'wav' });
    expect(normalizeGreetingContentType('audio/x-wav')).toEqual({ contentType: 'audio/wav', format: 'wav' });
    expect(normalizeGreetingContentType('Audio/MPEG; charset=binary')).toEqual({ contentType: 'audio/mpeg', format: 'mp3' });
  });
  it('rejects everything else, including absent and empty', () => {
    for (const t of ['audio/mp4', 'audio/x-m4a', 'video/mp4', 'application/octet-stream', '', undefined]) {
      expect(normalizeGreetingContentType(t)).toBeUndefined();
    }
  });
});

describe('sniffGreetingHeader', () => {
  const ADTS = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0, 0, 0, 0, 0]);
  const ADTS_MPEG2 = Buffer.from([0xff, 0xf9, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0, 0, 0, 0, 0]);
  const M4A = Buffer.from('\u0000\u0000\u0000\u0018ftypM4A ', 'latin1');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  it('accepts an ID3 tag and MPEG frame syncs with non-zero layer bits', () => {
    expect(sniffGreetingHeader(minimalMp3().subarray(0, 12), 'mp3')).toBe(true);
    expect(sniffGreetingHeader(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'mp3')).toBe(true);
    expect(sniffGreetingHeader(Buffer.from([0xff, 0xe3, 0x18, 0xc4]), 'mp3')).toBe(true);
  });
  it('accepts RIFF/WAVE', () => {
    expect(sniffGreetingHeader(minimalWav().subarray(0, 12), 'wav')).toBe(true);
  });
  it('rejects ADTS AAC (layer bits 00, both 0xFFF1 and 0xFFF9 syncs), M4A ftyp and PNG under both formats', () => {
    for (const head of [ADTS, ADTS_MPEG2, M4A, PNG]) {
      expect(sniffGreetingHeader(head, 'mp3')).toBe(false);
      expect(sniffGreetingHeader(head, 'wav')).toBe(false);
    }
  });
  it('requires the declared type and the header to agree', () => {
    expect(sniffGreetingHeader(minimalWav().subarray(0, 12), 'mp3')).toBe(false);
    expect(sniffGreetingHeader(minimalMp3().subarray(0, 12), 'wav')).toBe(false);
  });
  it('rejects a header shorter than the sniff needs', () => {
    expect(sniffGreetingHeader(Buffer.from([0xff, 0xfb]), 'mp3')).toBe(false);
    expect(sniffGreetingHeader(Buffer.from('RIFF....WAV', 'latin1'), 'wav')).toBe(false);
  });
});

describe('GreetingUploadGate', () => {
  it('passes a valid MP3 through byte-exact, in chunks smaller than the sniff', async () => {
    const mp3 = minimalMp3();
    const gate = new GreetingUploadGate({ format: 'mp3', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
    const out = await drain(gate, [mp3.subarray(0, 5), mp3.subarray(5, 9), mp3.subarray(9)]);
    expect(out.equals(mp3)).toBe(true);
    expect(gate.bytesSeen).toBe(mp3.length);
  });
  it('passes a valid WAV through byte-exact', async () => {
    const wav = minimalWav(10);
    const gate = new GreetingUploadGate({ format: 'wav', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
    const out = await drain(gate, [wav]);
    expect(out.equals(wav)).toBe(true);
  });
  it('rejects a bad header with invalid_format having pushed ZERO bytes', async () => {
    const gate = new GreetingUploadGate({ format: 'mp3', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
    const pushed: Buffer[] = [];
    gate.on('data', (c: Buffer) => pushed.push(c));
    await expect(drain(gate, [minimalWav()])).rejects.toMatchObject({ reason: 'invalid_format' });
    expect(pushed).toHaveLength(0);
  });
  it('rejects at maxBytes + 1 with too_large having forwarded AT MOST maxBytes downstream', async () => {
    const mp3 = minimalMp3();
    const gate = new GreetingUploadGate({ format: 'mp3', maxBytes: mp3.length });
    let forwarded = 0;
    gate.on('data', (c: Buffer) => { forwarded += c.length; });
    await expect(drain(gate, [mp3, Buffer.from([0])])).rejects.toMatchObject({ reason: 'too_large' });
    // The chunk that crosses the cap is never pushed: lib-storage can never
    // open a multipart upload for a refused body (no AbortMultipartUpload grant).
    expect(forwarded).toBeLessThanOrEqual(mp3.length);
    const gate2 = new GreetingUploadGate({ format: 'mp3', maxBytes: 100 });
    let forwarded2 = 0;
    gate2.on('data', (c: Buffer) => { forwarded2 += c.length; });
    await expect(drain(gate2, [mp3.subarray(0, 60), mp3.subarray(60, 120), mp3.subarray(120)])).rejects.toMatchObject({ reason: 'too_large' });
    expect(forwarded2).toBeLessThanOrEqual(100);
  });
  it('rejects a zero-byte stream with empty and a 2-byte stream with invalid_format', async () => {
    await expect(drain(new GreetingUploadGate({ format: 'mp3', maxBytes: 10 }), [])).rejects.toMatchObject({ reason: 'empty' });
    await expect(drain(new GreetingUploadGate({ format: 'mp3', maxBytes: 10 }), [Buffer.from([0xff, 0xfb])])).rejects.toMatchObject({ reason: 'invalid_format' });
  });
  it('the rejection is a GreetingRejectedError', async () => {
    const err = await drain(new GreetingUploadGate({ format: 'wav', maxBytes: 10 }), [minimalMp3()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GreetingRejectedError);
  });
});

describe('sanitizeGreetingFileName', () => {
  it('keeps the last path segment, strips control characters, trims', () => {
    expect(sanitizeGreetingFileName('C:\\Users\\sam\\Desktop\\Greeting v2.mp3', 'mp3')).toBe('Greeting v2.mp3');
    expect(sanitizeGreetingFileName('/tmp/a/b/final.wav', 'wav')).toBe('final.wav');
    expect(sanitizeGreetingFileName('  na\u0000me\u001f.mp3 ', 'mp3')).toBe('name.mp3');
  });
  it('caps at 120 code points without splitting a surrogate pair', () => {
    const astral = '\u{1F600}'.repeat(130);
    const out = sanitizeGreetingFileName(astral, 'mp3');
    expect(Array.from(out)).toHaveLength(120);
    expect(out.endsWith('\u{1F600}')).toBe(true);
  });
  it('falls back per format for non-strings and empties', () => {
    expect(sanitizeGreetingFileName(undefined, 'mp3')).toBe('greeting.mp3');
    expect(sanitizeGreetingFileName(['a'], 'wav')).toBe('greeting.wav');
    expect(sanitizeGreetingFileName('   ', 'wav')).toBe('greeting.wav');
  });
});

describe('withTimeout', () => {
  it('resolves and rejects through, clearing its timer when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
    // If the timer were NOT cleared the process would hold a 1000ms handle;
    // vitest's own leak detection would flag it. Assert the observable part:
    // a resolved race settles well inside the budget.
    const t0 = Date.now();
    await withTimeout(Promise.resolve(1), 1000, 'x');
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it('times out with GreetingLookupTimeoutError and swallows the late rejection', async () => {
    let release!: (err: Error) => void;
    const never = new Promise<number>((_, reject) => { release = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(withTimeout(never, 20, 'lookup')).rejects.toBeInstanceOf(GreetingLookupTimeoutError);
      release(new Error('late'));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('constants', () => {
  it('pins the given values', () => {
    expect(VOICEMAIL_GREETING_S3_KEY).toBe('settings/voicemail-greeting');
    expect(VOICEMAIL_GREETING_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(VOICEMAIL_GREETING_REJECT_MESSAGE).toBe('Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/voicemailGreeting.test.ts`
Expected: FAIL - cannot resolve `../src/lib/voicemailGreeting.js`.

- [ ] **Step 3: Implement the library**

```ts
// app/src/lib/voicemailGreeting.ts
// The recorded voicemail greeting (spec 2026-09-26): ONE object under a fixed
// media-store key + ONE optional map on the org settings item. This file holds
// the pure pieces every surface shares - the routes (upload/remove/serve), the
// voice webhook (offer <Play>), the settings projection - so the limits and the
// format rules live in exactly one place.
import { Transform, type TransformCallback } from 'node:stream';

export const VOICEMAIL_GREETING_S3_KEY = 'settings/voicemail-greeting';
/** Decision 1: a 5 MB cap. Equals lib-storage's minimum part size, so an
 *  accepted greeting is sent to S3 as ONE PutObject after the stream ends. */
export const VOICEMAIL_GREETING_MAX_BYTES = 5 * 1024 * 1024;
/** Decision 3: the presigned <Play> URL is good for 10 minutes. */
export const VOICEMAIL_GREETING_PLAY_TTL_SECONDS = 600;
/** The WHOLE webhook lookup (GetItem + HeadObject + presign) must settle inside
 *  this budget or the caller hears the spoken prompt: neither the DynamoDB nor
 *  the S3 client carries a request timeout, and a hung call would otherwise
 *  hold the TwiML past Twilio's webhook budget. */
export const VOICEMAIL_GREETING_LOOKUP_BUDGET_MS = 2500;
export const VOICEMAIL_GREETING_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);
export const VOICEMAIL_GREETING_REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
/** The display name rides a header (NOT the query string: the OTel span exports
 *  the query and the mutation catalog needs a literal path). URI-encoded so the
 *  header value is always ASCII. */
export const VOICEMAIL_GREETING_FILE_NAME_HEADER = 'x-greeting-file-name';
export const VOICEMAIL_GREETING_FILE_NAME_MAX_CHARS = 120;
export const VOICEMAIL_GREETING_SNIFF_BYTES = 12;

export type VoicemailGreetingFormat = 'mp3' | 'wav';
export type VoicemailGreetingContentType = 'audio/mpeg' | 'audio/wav';

export interface NormalizedGreetingType {
  contentType: VoicemailGreetingContentType;
  format: VoicemailGreetingFormat;
}

/** Map a declared Content-Type onto the canonical stored type, or undefined. */
export function normalizeGreetingContentType(raw: string | undefined): NormalizedGreetingType | undefined {
  if (typeof raw !== 'string') return undefined;
  const bare = (raw.split(';')[0] ?? '').trim().toLowerCase();
  if (bare === 'audio/mpeg') return { contentType: 'audio/mpeg', format: 'mp3' };
  if (bare === 'audio/wav' || bare === 'audio/x-wav') return { contentType: 'audio/wav', format: 'wav' };
  return undefined;
}

/**
 * Does the first few bytes look like the declared format? WAV: RIFF....WAVE.
 * MP3: an ID3v2 tag, or an MPEG audio frame sync (11 set bits) whose LAYER
 * bits are non-zero - layer `00` is reserved and is exactly what an ADTS AAC
 * frame carries, so an AAC file declared as MP3 is refused here.
 */
export function sniffGreetingHeader(head: Buffer, format: VoicemailGreetingFormat): boolean {
  if (format === 'wav') {
    return head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE';
  }
  if (head.length < 3) return false;
  if (head.toString('latin1', 0, 3) === 'ID3') return true;
  const b0 = head[0] ?? 0;
  const b1 = head[1] ?? 0;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0;
}

export type GreetingRejectReason = 'invalid_format' | 'too_large' | 'empty';

export class GreetingRejectedError extends Error {
  constructor(readonly reason: GreetingRejectReason) {
    super(`voicemail greeting rejected: ${reason}`);
    this.name = 'GreetingRejectedError';
  }
}

/**
 * A pass-through that holds back the first VOICEMAIL_GREETING_SNIFF_BYTES,
 * checks them against the declared format, and only then lets ANY byte
 * through; it also counts bytes and destroys itself the moment the cap is
 * exceeded. The route pipes the request into it and hands IT to
 * mediaStore.put, so the app never holds the file: on a refusal downstream
 * has seen either nothing (bad header) or a stream that errors before it
 * ends (too large), and lib-storage sends nothing to S3 either way.
 */
export class GreetingUploadGate extends Transform {
  bytesSeen = 0;
  private held: Buffer[] = [];
  private heldBytes = 0;
  private verified = false;

  constructor(private readonly opts: { format: VoicemailGreetingFormat; maxBytes: number }) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesSeen += chunk.length;
    if (this.bytesSeen > this.opts.maxBytes) {
      callback(new GreetingRejectedError('too_large'));
      return;
    }
    if (this.verified) {
      callback(null, chunk);
      return;
    }
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    if (this.heldBytes < VOICEMAIL_GREETING_SNIFF_BYTES) {
      callback();
      return;
    }
    const head = Buffer.concat(this.held);
    this.held = [];
    if (!sniffGreetingHeader(head, this.opts.format)) {
      callback(new GreetingRejectedError('invalid_format'));
      return;
    }
    this.verified = true;
    callback(null, head);
  }

  override _flush(callback: TransformCallback): void {
    if (this.verified) {
      callback();
      return;
    }
    if (this.bytesSeen === 0) {
      callback(new GreetingRejectedError('empty'));
      return;
    }
    const head = Buffer.concat(this.held);
    this.held = [];
    if (!sniffGreetingHeader(head, this.opts.format)) {
      callback(new GreetingRejectedError('invalid_format'));
      return;
    }
    this.verified = true;
    callback(null, head);
  }
}

/** The staff-facing display name: last path segment, no control characters,
 *  trimmed, capped by CODE POINTS (never splitting a surrogate pair), with a
 *  per-format fallback. Never logged. */
export function sanitizeGreetingFileName(raw: unknown, format: VoicemailGreetingFormat): string {
  const fallback = format === 'mp3' ? 'greeting.mp3' : 'greeting.wav';
  if (typeof raw !== 'string') return fallback;
  const segments = raw.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return fallback;
  return Array.from(cleaned).slice(0, VOICEMAIL_GREETING_FILE_NAME_MAX_CHARS).join('');
}

export class GreetingLookupTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = 'GreetingLookupTimeoutError';
  }
}

/**
 * A plain race of `promise` against a timer. It carries NO flag: the caller
 * makes the abandoned work harmless by having it RETURN A RESULT and touch
 * nothing (the webhook's lookup returns what to play; only the caller emits
 * TwiML or logs, and only when the race resolved in time). A late rejection
 * of the abandoned promise is swallowed so it can never surface as unhandled;
 * the timer is cleared when the promise wins so nothing holds the loop.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GreetingLookupTimeoutError(label, ms)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/voicemailGreeting.test.ts`
Expected: PASS (all cases). Then `cd W:/tmp/voicemail-greeting && npm run typecheck` -> exit 0.

- [ ] **Step 5: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add app/src/lib/voicemailGreeting.ts app/test/helpers/audioFixtures.ts app/test/voicemailGreeting.test.ts && git commit -m "feat(voicemail-greeting): greeting library - type normalization, header sniff, upload gate, name sanitizer, lookup timeout

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 2: Settings record and patch types

**Files:**
- Modify: `app/src/repos/settingsRepo.ts` (after the `OrgSettings` interface and `OrgSettingsPatch`; inside `toOrgSettings`)
- Modify: `app/src/routes/settings.ts` (the local `SettingsPatch` type only)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the in-memory settings fake, ~line 2289)
- Test: `app/test/settings.test.ts` (append), `app/test/voicemailGreetingRoutes.test.ts` (created here with ONE case; Task 4 extends it)

**Interfaces:**
- Consumes: `VOICEMAIL_GREETING_S3_KEY` (Task 1).
- Produces: `VoicemailGreeting` interface; `OrgSettings.voicemailGreeting?`; `OrgSettingsPatch.voicemailGreeting?: VoicemailGreeting | null`; the harness fake honoring both.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/settings.test.ts` (it already imports `createSettingsRepo`, `DEFAULT_ORG_SETTINGS`, `UpdateCommand` and defines `fakeDocReturning`):

```ts
describe('settingsRepo - voicemailGreeting projection (voicemail-greeting spec 4.2)', () => {
  const GOOD = {
    s3Key: 'settings/voicemail-greeting',
    contentType: 'audio/mpeg',
    fileName: 'sam.mp3',
    sizeBytes: 427,
    uploadedAt: '2026-09-26T12:00:00.000Z',
    uploadedByUserId: 'user-0001',
    uploadedByEmail: 'founder@example.com',
  };

  it('projects a well-formed map', async () => {
    const repo = createSettingsRepo({ doc: fakeDocReturning({ settingId: 'org', voicemailGreeting: GOOD }) });
    const s = await repo.getOrgSettings();
    expect(s.voicemailGreeting).toEqual(GOOD);
  });

  it('is absent by default and absent for a malformed map', async () => {
    expect((await createSettingsRepo({ doc: fakeDocReturning({ settingId: 'org' }) }).getOrgSettings()).voicemailGreeting).toBeUndefined();
    for (const bad of [
      { ...GOOD, s3Key: 'recordings/CA1/RE1' }, // a foreign key can never be played
      { ...GOOD, contentType: 'audio/mp4' },
      { ...GOOD, sizeBytes: '427' },
      { ...GOOD, uploadedAt: undefined },
      'not-a-map',
    ]) {
      const repo = createSettingsRepo({ doc: fakeDocReturning({ settingId: 'org', voicemailGreeting: bad }) });
      expect((await repo.getOrgSettings()).voicemailGreeting, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('putOrgSettings({ voicemailGreeting: null }) issues a REMOVE', async () => {
    const sent: unknown[] = [];
    const doc = {
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return { Attributes: { settingId: 'org' } };
      },
    } as unknown as DynamoDBDocumentClient;
    await createSettingsRepo({ doc }).putOrgSettings({ voicemailGreeting: null });
    const update = sent[0] as UpdateCommand;
    expect(update.input.UpdateExpression).toBe('REMOVE #k0');
    expect(update.input.ExpressionAttributeNames).toEqual({ '#k0': 'voicemailGreeting' });
  });
});
```

Create `app/test/voicemailGreetingRoutes.test.ts` with the one case this task owns:

```ts
// Voicemail greeting routes (spec 2026-09-26 sections 4.3-4.5). Task 2 owns the
// parsePatch pin; Task 4 adds the upload/remove/serve cases below it.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { TEST_ADMIN_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const GREETING = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg',
  fileName: 'sam.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'user-0001',
  uploadedByEmail: 'founder@example.com',
} as const;

describe('PUT /api/settings ignores voicemailGreeting (only the greeting routes write it)', () => {
  it('a body carrying it changes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ voicemailGreeting: GREETING, missedCallAutoTextEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.voicemailGreeting).toBeUndefined();
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(world.settings.missedCallAutoTextEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/settings.test.ts test/voicemailGreetingRoutes.test.ts`
Expected: the projection cases FAIL (`voicemailGreeting` is never projected, so the "well-formed map" case fails); the REMOVE case passes already (generic null handling) - that is fine; the parsePatch pin passes already (unknown keys are ignored) - keep it as the guard.

- [ ] **Step 3: Implement the record**

In `app/src/repos/settingsRepo.ts`, add the import and the type after the `OrgSettings` doc comment block's imports:

```ts
import {
  VOICEMAIL_GREETING_S3_KEY,
  type VoicemailGreetingContentType,
} from '../lib/voicemailGreeting.js';
```

Add BEFORE `export interface OrgSettings`:

```ts
/**
 * The recorded voicemail greeting (voicemail-greeting spec 4.2): metadata for
 * the ONE object under VOICEMAIL_GREETING_S3_KEY. Written only by the two
 * greeting routes (routes/settings.ts); the generic PUT /api/settings ignores
 * it. `s3Key` is stored for forward compatibility but the projection accepts
 * ONLY the fixed key, so a hand-edited record can never point the webhook or
 * the audio route at a call recording or an MMS object.
 */
export interface VoicemailGreeting {
  s3Key: string;
  contentType: VoicemailGreetingContentType;
  /** Sanitized display name (lib/voicemailGreeting.ts). Never logged. */
  fileName: string;
  sizeBytes: number;
  /** ISO instant. */
  uploadedAt: string;
  uploadedByUserId: string;
  uploadedByEmail: string;
}

/** Project a stored map onto VoicemailGreeting, or undefined when any field is off. */
export function toVoicemailGreeting(raw: unknown): VoicemailGreeting | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const contentType = r['contentType'];
  if (r['s3Key'] !== VOICEMAIL_GREETING_S3_KEY) return undefined;
  if (contentType !== 'audio/mpeg' && contentType !== 'audio/wav') return undefined;
  if (typeof r['fileName'] !== 'string') return undefined;
  if (typeof r['sizeBytes'] !== 'number' || !Number.isFinite(r['sizeBytes']) || r['sizeBytes'] < 0) return undefined;
  if (typeof r['uploadedAt'] !== 'string') return undefined;
  if (typeof r['uploadedByUserId'] !== 'string') return undefined;
  if (typeof r['uploadedByEmail'] !== 'string') return undefined;
  return {
    s3Key: VOICEMAIL_GREETING_S3_KEY,
    contentType,
    fileName: r['fileName'],
    sizeBytes: r['sizeBytes'],
    uploadedAt: r['uploadedAt'],
    uploadedByUserId: r['uploadedByUserId'],
    uploadedByEmail: r['uploadedByEmail'],
  };
}
```

Add to `OrgSettings` (after `welcomeText?: string;`):

```ts
  /**
   * OPTIONAL - the recorded voicemail greeting (spec 4.2). Absent until an
   * admin uploads one; projected only when the stored map is well-formed.
   */
  voicemailGreeting?: VoicemailGreeting;
```

Replace the `OrgSettingsPatch` type with:

```ts
/** A settings patch. `welcomeText` and `voicemailGreeting` may be `null` - an
 *  explicit CLEAR that issues a DynamoDB REMOVE. Every other field keeps its
 *  OrgSettings type. */
export type OrgSettingsPatch = Partial<Omit<OrgSettings, 'welcomeText' | 'voicemailGreeting'>> & {
  welcomeText?: string | null;
  voicemailGreeting?: VoicemailGreeting | null;
};
```

In `toOrgSettings`, after the `welcomeText` spread add:

```ts
      ...(() => {
        const greeting = toVoicemailGreeting(item?.['voicemailGreeting']);
        return greeting !== undefined ? { voicemailGreeting: greeting } : {};
      })(),
```

In `app/src/routes/settings.ts`, replace the local `SettingsPatch` type:

```ts
/** The validated patch. `welcomeText` may be `null` (an explicit CLEAR the repo
 *  turns into a DynamoDB REMOVE). `voicemailGreeting` is Omitted on purpose:
 *  parsePatch never produces it - only the greeting routes below write it. */
type SettingsPatch = Partial<Omit<OrgSettings, 'welcomeText' | 'voicemailGreeting'>> & { welcomeText?: string | null };
```

In `app/test/helpers/twilioWebhookHarness.ts`, inside the fake `settingsRepo.putOrgSettings` (after the `welcomeText` branch, before `return { ...settings }`):

```ts
      if ('voicemailGreeting' in patch) {
        if (patch.voicemailGreeting === null) {
          delete settings.voicemailGreeting;
        } else if (patch.voicemailGreeting !== undefined) {
          settings.voicemailGreeting = patch.voicemailGreeting;
        }
      }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/settings.test.ts test/voicemailGreetingRoutes.test.ts && cd .. && npm run typecheck`
Expected: PASS; typecheck exit 0 (the dashboard mirror is Task 7; the app compiles alone).

- [ ] **Step 5: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add app/src/repos/settingsRepo.ts app/src/routes/settings.ts app/test/helpers/twilioWebhookHarness.ts app/test/settings.test.ts app/test/voicemailGreetingRoutes.test.ts && git commit -m "feat(voicemail-greeting): settings record - VoicemailGreeting map, fixed-key projection, null-REMOVE patch; PUT /api/settings ignores it

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 3: Extract `serveMediaObject` from the recording route

**Files:**
- Create: `app/src/routes/serveMediaObject.ts`
- Modify: `app/src/routes/api.ts` (the `GET /calls/:callId/recording` handler body from the `rangeHeader` line to `object.body.pipe(res)`, ~lines 2292-2360; the `MediaObject` / `RangeNotSatisfiableError` imports if they become unused)
- Test: `app/test/voiceRecording.test.ts` (UNCHANGED - it is the regression guard)

**Interfaces:**
- Produces: `serveMediaObject(req, res, opts)` used by Task 4.

- [ ] **Step 1: Run the guard BEFORE touching anything**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/voiceRecording.test.ts`
Expected: PASS (record the count; it must be identical after the extraction).

- [ ] **Step 2: Create the helper**

```ts
// app/src/routes/serveMediaObject.ts
// Stream ONE media-store object to an authed dashboard response with byte-range
// support. Extracted from GET /api/calls/:callId/recording so the voicemail
// greeting audio route (routes/settings.ts) serves the same way; the recording
// route's behavior (range forwarding, 206/416/404, Accept-Ranges on every
// success, the declared cache posture) is byte-identical to before.
import type { Request, Response } from 'express';
import { RangeNotSatisfiableError, type MediaObject, type MediaStore } from '../adapters/mediaStore.js';
import type { Logger } from '../lib/logger.js';

export interface ServeMediaObjectOptions {
  mediaStore: MediaStore;
  key: string;
  /** Used when the stored object carries no Content-Type. */
  defaultContentType: string;
  /** e.g. 'private, max-age=3600' - the caller states its posture explicitly. */
  cacheControl: string;
  /** The { error } value for a missing object. */
  notFoundError: string;
  log: Logger;
  /** Merged into every log line (IDs only - never bytes, names or URLs). */
  logContext: Record<string, unknown>;
  messages: { missing: string; streaming: string; errored: string };
}

/**
 * A SINGLE well-formed byte range only ("bytes=0-1023", "bytes=1024-",
 * "bytes=-500"). A multi-range value, another unit, or a malformed one is
 * IGNORED and answered with the full 200 - RFC 7233 explicitly lets a server
 * ignore a Range it does not wish to satisfy.
 */
function singleByteRange(req: Request): string | undefined {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : undefined;
  return rangeHeader !== undefined && /^bytes=(\d+-\d*|-\d+)$/.test(rangeHeader) ? rangeHeader : undefined;
}

export async function serveMediaObject(req: Request, res: Response, opts: ServeMediaObjectOptions): Promise<void> {
  const { mediaStore, key, log, logContext } = opts;
  const range = singleByteRange(req);
  let object: MediaObject | undefined;
  try {
    object = range !== undefined ? await mediaStore.getStream(key, { range }) : await mediaStore.getStream(key);
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      // 416 must carry the object size so the client can re-ask correctly.
      // HeadObject is best-effort and only on this malformed-client path.
      const meta = await mediaStore.head(key).catch(() => undefined);
      res.setHeader('Accept-Ranges', 'bytes');
      if (meta?.size !== undefined) res.setHeader('Content-Range', `bytes */${meta.size}`);
      res.status(416).json({ error: 'range_not_satisfiable' });
      return;
    }
    throw err;
  }
  if (!object) {
    log.warn(logContext, opts.messages.missing);
    res.status(404).json({ error: opts.notFoundError });
    return;
  }
  res.setHeader('Content-Type', object.contentType ?? opts.defaultContentType);
  // Accept-Ranges on EVERY successful response (the plain 200 included) is
  // what tells the browser the audio is SEEKABLE.
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', opts.cacheControl);
  if (object.contentLength !== undefined) {
    res.setHeader('Content-Length', String(object.contentLength));
  }
  // DEFENSIVE DEGRADE: a range was forwarded but the store answered without
  // a ContentRange - serve the full 200 rather than a malformed 206.
  if (range !== undefined && object.contentRange !== undefined) {
    res.setHeader('Content-Range', object.contentRange);
    res.status(206);
  }
  log.info(logContext, opts.messages.streaming);
  object.body.on('error', (err) => {
    log.error({ err, ...logContext }, opts.messages.errored);
    res.destroy(err);
  });
  object.body.pipe(res);
}
```

- [ ] **Step 3: Re-point the recording route**

In `app/src/routes/api.ts`, keep the handler's call lookup, `mergeContext`, key check and `!mediaStore` check exactly as they are, and replace everything from `const rangeHeader = ...` through `object.body.pipe(res);` with:

```ts
    await serveMediaObject(req, res, {
      mediaStore,
      key,
      defaultContentType: 'audio/mpeg',
      // SAME declared posture as the MMS media route below (Cameron, 2026-09-02):
      // immutable per CallSid, `private` so only this session's browser holds it.
      // The accepted residual is recorded in
      // docs/issues/authenticated-mms-media-browser-cache.md - the two routes are
      // deliberately kept in lockstep, so change them together or not at all.
      cacheControl: 'private, max-age=3600',
      notFoundError: 'recording_not_found',
      log,
      logContext: { callSid: callId },
      messages: {
        missing: 'recording key present but object not found in the media store',
        streaming: 'streaming founder-bridge recording to the dashboard',
        errored: 'recording stream errored mid-flight',
      },
    });
```

Add `import { serveMediaObject } from './serveMediaObject.js';` next to the other route imports. Remove `RangeNotSatisfiableError` and `type MediaObject` from the `../adapters/mediaStore.js` import ONLY if `npx eslint app/src/routes/api.ts` reports them unused (the MMS media route further down may still use them - check before deleting). Keep the explanatory comment block above the route.

- [ ] **Step 4: Run the guard AFTER**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/voiceRecording.test.ts test/mmsMedia.test.ts && cd .. && npm run typecheck && npx eslint app/src/routes/api.ts app/src/routes/serveMediaObject.ts`
Expected: identical pass count to Step 1; typecheck exit 0; no NEW lint errors (compare against `git stash`-free baseline by running the same eslint command on `main` for `api.ts` if any error appears - pre-existing ones are not yours).

- [ ] **Step 5: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add app/src/routes/serveMediaObject.ts app/src/routes/api.ts && git commit -m "refactor(media-serve): extract serveMediaObject from the call-recording route (behavior unchanged; greeting audio reuses it)

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 4: Greeting routes (upload, remove, audio) + harness seams + `head` abort signal

**Files:**
- Modify: `app/src/adapters/mediaStore.ts` (`MediaStore.head` signature; `S3MediaStore.head`)
- Modify: `app/src/routes/settings.ts` (deps, three routes)
- Modify: `app/src/routes/api.ts` (~line 724: pass `mediaStore` to `createSettingsRouter`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`FakeWorld` fields, `createFakeWorld` init, fake `head`/`presign`)
- Test: `app/test/voicemailGreetingRoutes.test.ts` (extend Task 2's file)
- Grep before editing: `grep -rn "head(key" app/src app/test --include=*.ts` and `grep -rln "implements MediaStore\|: MediaStore = {" app` - every other `MediaStore` implementation (test fakes) must accept the optional second parameter (TypeScript allows an implementation with FEWER parameters, so most fakes need no change; only ones that redeclare the type do).

**Interfaces:**
- Consumes: Task 1 library, Task 2 record, Task 3 `serveMediaObject`.
- Produces: `PUT /api/settings/voicemail-greeting` (raw body; header `X-Greeting-File-Name`; 200 `{ voicemailGreeting }`), `DELETE /api/settings/voicemail-greeting` (204), `GET /api/settings/voicemail-greeting/audio`; `MediaStore.head(key, opts?: { signal?: AbortSignal })`; harness: `world.mediaHeads: { key: string; signal: boolean }[]`, `world.mediaPresigns: { key: string; ttlSeconds: number }[]`, `world.failMediaHeads: Set<string>`, `world.hangMediaHeads: Set<string>`.

- [ ] **Step 1: Write the failing route tests**

Append to `app/test/voicemailGreetingRoutes.test.ts` (add the imports at the top of the file):

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { minimalMp3 } from '../src/lib/seed/media.js';
import { VOICEMAIL_GREETING_REJECT_MESSAGE, VOICEMAIL_GREETING_S3_KEY } from '../src/lib/voicemailGreeting.js';
import { TEST_ADMIN_USER, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { minimalWav } from './helpers/audioFixtures.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const KEY = VOICEMAIL_GREETING_S3_KEY;
const PATH = '/api/settings/voicemail-greeting';

// supertest/superagent send `Connection: close` by default. Node then closes
// the socket the moment the response finishes; a client still uploading gets
// RST before it reads the 4xx JSON (measured: ECONNRESET on every 3 MiB /
// 6 MiB refusal, 400/413 JSON with keep-alive). Browsers keep connections
// alive, so keep-alive is the realistic shape - and the ONLY way these tests
// can observe the JSON the route really sends.
function keepAlive(req: request.Test): request.Test {
  return req.set('connection', 'keep-alive');
}

/** A valid MP3 padded with zero bytes to `total` (still sniffs as MP3). */
function bigMp3(total: number): Buffer {
  const head = minimalMp3();
  return Buffer.concat([head, Buffer.alloc(total - head.length, 0)]);
}
/** WAV bytes padded to `total` - declared as MP3 they must FAIL the sniff. */
function bigWav(total: number): Buffer {
  return minimalWav(total - 44);
}

function admin(req: request.Test): request.Test {
  return keepAlive(req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_ADMIN_COOKIE));
}

async function upload(app: Parameters<typeof request>[0], body: Buffer, contentType: string, name = 'greeting.mp3', extra: (t: request.Test) => request.Test = (t) => t) {
  return extra(admin(request(app).put(PATH)))
    .set('content-type', contentType)
    .set('x-greeting-file-name', encodeURIComponent(name))
    .send(body);
}

describe('PUT /api/settings/voicemail-greeting - gates', () => {
  it('401 without a session, 403 for a VA', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).put(PATH).set('x-origin-verify', ORIGIN_SECRET).set('content-type', 'audio/mpeg').send(minimalMp3())).status).toBe(401);
    expect((await request(app).put(PATH).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).set('content-type', 'audio/mpeg').send(minimalMp3())).status).toBe(403);
  });

  it('503 media_storage_unavailable without a media store', async () => {
    const { app } = makeWebhookHarness({ withoutMediaStore: true });
    const res = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('media_storage_unavailable');
  });

  it('400 unsupported_media_type with the exact message for audio/mp4 and for an ABSENT type', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, minimalMp3(), 'audio/mp4');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
    const absent = await admin(request(app).put(PATH)).send(minimalMp3());
    expect(absent.status).toBe(400);
    expect(absent.body.error).toBe('unsupported_media_type');
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('400 empty_file for Content-Length: 0', async () => {
    const { app } = makeWebhookHarness();
    const res = await admin(request(app).put(PATH)).set('content-type', 'audio/mpeg').set('content-length', '0').send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_file');
  });
});

describe('PUT /api/settings/voicemail-greeting - the sniff and the cap (bodies big enough to expose a socket reset)', () => {
  it('a 3 MiB body of WAV bytes declared audio/mpeg is refused with the M4A message, the JSON reaches the client, no put, not logged as an abort', async () => {
    const { app, world, capture } = makeWebhookHarness();
    const res = await upload(app, bigWav(3 * 1024 * 1024), 'audio/mpeg');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
    expect(world.mediaPuts).toHaveLength(0);
    expect(capture.lines.some((l) => l['reason'] === 'client_aborted')).toBe(false);
  });

  it('413 file_too_large for a 6 MiB body with a Content-Length, and the JSON reaches the client', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, bigMp3(6 * 1024 * 1024), 'audio/mpeg');
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('file_too_large');
    expect(res.body.maxBytes).toBe(5 * 1024 * 1024);
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('413 file_too_large for a CHUNKED 6 MiB body (no Content-Length), and the JSON reaches the client', async () => {
    // superagent cannot stream a Readable, so drive a raw http.request with
    // Transfer-Encoding: chunked (two writes) against a real listener.
    const { app, world } = makeWebhookHarness();
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const body = bigMp3(6 * 1024 * 1024);
      const result = await new Promise<{ status: number; json: { error?: string } }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'PUT',
            path: PATH,
            headers: {
              'x-origin-verify': ORIGIN_SECRET,
              cookie: TEST_ADMIN_COOKIE,
              'content-type': 'audio/mpeg',
              'transfer-encoding': 'chunked',
              connection: 'keep-alive',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string } }));
          },
        );
        req.on('error', reject);
        req.write(body.subarray(0, 2 * 1024 * 1024));
        req.end(body.subarray(2 * 1024 * 1024));
      });
      expect(result.status).toBe(413);
      expect(result.json.error).toBe('file_too_large');
      expect(world.mediaPuts).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('PUT/DELETE /api/settings/voicemail-greeting - happy paths', () => {
  it('stores an MP3 under the fixed key, records it, audits it, and GET /api/settings carries it', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, minimalMp3(), 'audio/mpeg', 'Sam greeting.mp3');
    expect(res.status).toBe(200);
    expect(res.body.voicemailGreeting).toMatchObject({
      s3Key: KEY,
      contentType: 'audio/mpeg',
      fileName: 'Sam greeting.mp3',
      sizeBytes: minimalMp3().length,
      uploadedByUserId: TEST_ADMIN_USER.userId,
      uploadedByEmail: TEST_ADMIN_USER.email,
    });
    expect(typeof res.body.voicemailGreeting.uploadedAt).toBe('string');
    expect(world.mediaPuts).toEqual([{ key: KEY, contentType: 'audio/mpeg', bytes: minimalMp3().length }]);
    expect(world.mediaObjects.get(KEY)?.body.equals(minimalMp3())).toBe(true);
    expect(world.settings.voicemailGreeting?.fileName).toBe('Sam greeting.mp3');
    const audit = world.auditEvents.find((e) => e.event_type === 'settings_updated');
    expect(audit?.payload).toMatchObject({ fields: ['voicemailGreeting'], action: 'uploaded', actor: TEST_ADMIN_USER.userId });
    const settings = await admin(request(app).get('/api/settings'));
    expect(settings.body.settings.voicemailGreeting.fileName).toBe('Sam greeting.mp3');
  });

  it('accepts audio/x-wav and stores the canonical audio/wav', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await upload(app, minimalWav(), 'audio/x-wav', 'g.wav');
    expect(res.status).toBe(200);
    expect(res.body.voicemailGreeting.contentType).toBe('audio/wav');
    expect(world.mediaPuts[0]?.contentType).toBe('audio/wav');
  });

  it('decodes a percent-encoded non-ASCII name and falls back on a bad encoding', async () => {
    const { app } = makeWebhookHarness();
    const ok = await upload(app, minimalMp3(), 'audio/mpeg', 'Sam\u00e9 greeting.mp3');
    expect(ok.body.voicemailGreeting.fileName).toBe('Sam\u00e9 greeting.mp3');
    const bad = await admin(request(app).put(PATH)).set('content-type', 'audio/mpeg').set('x-greeting-file-name', '%E0%A4%A').send(minimalMp3());
    expect(bad.status).toBe(200);
    expect(bad.body.voicemailGreeting.fileName).toBe('greeting.mp3');
  });

  it('never logs the file name', async () => {
    const { app, capture } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg', 'SECRET-NAME.mp3');
    expect(JSON.stringify(capture.lines)).not.toContain('SECRET-NAME');
  });

  it('replace overwrites (second put, uploadedAt advances); a refused replace leaves the object byte-identical and the record unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    const first = await upload(app, minimalMp3(), 'audio/mpeg', 'one.mp3');
    await new Promise((r) => setTimeout(r, 5));
    const second = await upload(app, minimalWav(), 'audio/wav', 'two.wav');
    expect(second.status).toBe(200);
    expect(world.mediaPuts).toHaveLength(2);
    expect(second.body.voicemailGreeting.uploadedAt > first.body.voicemailGreeting.uploadedAt).toBe(true);
    expect(world.mediaObjects.get(KEY)?.body.equals(minimalWav())).toBe(true);

    const refused = await upload(app, bigWav(3 * 1024 * 1024), 'audio/mpeg', 'three.mp3');
    expect(refused.status).toBe(400);
    const tooBig = await upload(app, bigMp3(6 * 1024 * 1024), 'audio/mpeg', 'four.mp3');
    expect(tooBig.status).toBe(413);
    expect(world.mediaPuts).toHaveLength(2);
    expect(world.mediaObjects.get(KEY)?.body.equals(minimalWav())).toBe(true);
    expect(world.settings.voicemailGreeting?.fileName).toBe('two.wav');
  });

  it('an audit failure after a successful upload still answers 200 (ERROR logged)', async () => {
    const world = createFakeWorld();
    const original = world.auditRepo.append.bind(world.auditRepo);
    world.auditRepo.append = async (...args) => {
      if (args[1] === 'settings_updated') throw new Error('audit down');
      return original(...args);
    };
    const { app, capture } = makeWebhookHarness({ world });
    const res = await upload(app, minimalMp3(), 'audio/mpeg');
    expect(res.status).toBe(200);
    expect(capture.atLevel(50).some((l) => String(l['msg']).includes('audit'))).toBe(true);
  });

  it('DELETE clears the record, deletes the object (best effort), audits removed, 204; idempotent', async () => {
    const { app, world } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg');
    const res = await admin(request(app).delete(PATH));
    expect(res.status).toBe(204);
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(world.deletedMediaKeys).toEqual([KEY]);
    expect(world.mediaObjects.has(KEY)).toBe(false);
    const audit = world.auditEvents.filter((e) => e.event_type === 'settings_updated');
    expect(audit[audit.length - 1]?.payload).toMatchObject({ fields: ['voicemailGreeting'], action: 'removed' });
    expect((await admin(request(app).delete(PATH))).status).toBe(204);
  });

  it('DELETE still clears the record and answers 204 with a WARN when the object delete rejects', async () => {
    const { app, world, capture } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg');
    world.failMediaDeletes.add(KEY);
    const res = await admin(request(app).delete(PATH));
    expect(res.status).toBe(204);
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(capture.atLevel(40).some((l) => String(l['msg']).includes('voicemail greeting object delete failed'))).toBe(true);
  });

  it('DELETE is admin-only', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).delete(PATH).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)).status).toBe(403);
  });
});

describe('GET /api/settings/voicemail-greeting/audio', () => {
  const AUDIO = `${PATH}/audio`;
  function bytesOf(t: request.Test): request.Test {
    return t.buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  }

  it('404 greeting_not_found when nothing is set', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('greeting_not_found');
  });

  it('streams the bytes to ANY logged-in user with Accept-Ranges and the stored type; 206 on a range', async () => {
    const { app } = makeWebhookHarness();
    await upload(app, minimalWav(100), 'audio/wav');
    const res = await bytesOf(request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect((res.body as Buffer).equals(minimalWav(100))).toBe(true);
    const part = await bytesOf(request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).set('range', 'bytes=0-3'));
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${minimalWav(100).length}`);
    expect((part.body as Buffer).toString('latin1')).toBe('RIFF');
  });

  it('404 when the record is set but the object is gone', async () => {
    const { app, world } = makeWebhookHarness();
    await upload(app, minimalMp3(), 'audio/mpeg');
    world.mediaObjects.delete(KEY);
    const res = await request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('greeting_not_found');
  });

  it('401 without a session', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).get(AUDIO).set('x-origin-verify', ORIGIN_SECRET)).status).toBe(401);
  });
});
```

Every supertest request that carries a body goes through `admin()` (keep-alive). If a large-body refusal test reports ECONNRESET, check the request's `Connection` header before anything else: the route is not the suspect, the client's `Connection: close` is.

- [ ] **Step 2: Run to verify they fail**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/voicemailGreetingRoutes.test.ts`
Expected: FAIL - 404s (routes do not exist), and `world.mediaHeads` etc. are undefined.

- [ ] **Step 3: `MediaStore.head` gains an optional abort signal**

In `app/src/adapters/mediaStore.ts`, change the interface member and the implementation:

```ts
  /**
   * HeadObject metadata for `key` (outbound MMS send-route validation ... unchanged text ...).
   * `opts.signal` (optional, additive) aborts the underlying request: the
   * voicemail-greeting webhook hands it `AbortSignal.timeout(budget)` so an
   * abandoned HEAD releases its pooled socket instead of holding it until the
   * OS gives up. Callers that omit it get byte-identical behavior.
   */
  head(key: string, opts?: { signal?: AbortSignal }): Promise<MediaHead | undefined>;
```

```ts
  async head(key: string, opts?: { signal?: AbortSignal }): Promise<MediaHead | undefined> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        opts?.signal !== undefined ? { abortSignal: opts.signal } : undefined,
      );
```

(The rest of the method is unchanged. An aborted call rejects with the SDK's abort error, which is NOT a 404 and so re-throws - the webhook's catch turns it into the WARN.)

- [ ] **Step 4: Harness seams**

In `app/test/helpers/twilioWebhookHarness.ts`:

`FakeWorld` (next to `deletedMediaKeys`):

```ts
  /** Every mediaStore.head call, in order (voicemail greeting: the webhook's existence check). */
  mediaHeads: { key: string; signal: boolean }[];
  /** Every mediaStore.presign call, in order (voicemail greeting: the <Play> URL). */
  mediaPresigns: { key: string; ttlSeconds: number }[];
  /** Keys for which mediaStore.head should REJECT (the webhook's failed-check fallback). */
  failMediaHeads: Set<string>;
  /** Keys for which mediaStore.head NEVER settles until its abort signal fires (the webhook's budget). */
  hangMediaHeads: Set<string>;
```

In `createFakeWorld`, initialize them (`mediaHeads: []`, `mediaPresigns: []`, `failMediaHeads: new Set()`, `hangMediaHeads: new Set()`) wherever the sibling arrays/sets are initialized (search `deletedMediaKeys: []` / `failMediaDeletes: new Set()`), and expose them in the returned world object next to `deletedMediaKeys`. Replace the fake `presign` and `head`:

```ts
    async presign(key, ttlSeconds) {
      presignCounter += 1;
      mediaPresigns.push({ key, ttlSeconds });
      return `https://fake-s3.local/${key}?X-Amz-Signature=fakesig${presignCounter}&X-Amz-Expires=${ttlSeconds}`;
    },
    async head(key, opts) {
      mediaHeads.push({ key, signal: opts?.signal !== undefined });
      if (hangMediaHeads.has(key)) {
        // Models a stuck S3 connection: settles ONLY when the caller's abort
        // signal fires (the SDK rejects with an AbortError), never on its own.
        return new Promise((_resolve, reject) => {
          const signal = opts?.signal;
          if (signal === undefined) return; // truly never
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (failMediaHeads.has(key)) {
        throw new Error(`fake mediaStore: forced head failure for ${key}`);
      }
      const obj = mediaObjects.get(key);
      if (!obj) return undefined;
      return {
        ...(obj.contentType !== undefined && { contentType: obj.contentType }),
        size: obj.body.length,
      };
    },
```

(`mediaHeads`, `mediaPresigns`, `failMediaHeads`, `hangMediaHeads` are `const` locals declared beside `deletedMediaKeys` / `failMediaDeletes` and returned on the world.)

- [ ] **Step 5: Implement the routes**

In `app/src/routes/settings.ts`, add imports:

```ts
import { Readable } from 'node:stream';
import type { MediaStore } from '../adapters/mediaStore.js';
import {
  GreetingRejectedError,
  GreetingUploadGate,
  normalizeGreetingContentType,
  sanitizeGreetingFileName,
  VOICEMAIL_GREETING_FILE_NAME_HEADER,
  VOICEMAIL_GREETING_MAX_BYTES,
  VOICEMAIL_GREETING_REJECT_MESSAGE,
  VOICEMAIL_GREETING_S3_KEY,
} from '../lib/voicemailGreeting.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import { serveMediaObject } from './serveMediaObject.js';
import { type VoicemailGreeting } from '../repos/settingsRepo.js';
```

Add to `SettingsRouterDeps`:

```ts
  /** Media store for the voicemail greeting routes; undefined when MEDIA_BUCKET is unset (503 then). */
  mediaStore?: MediaStore;
```

Add above `createSettingsRouter`:

```ts
/** A request-side failure captured from `req` itself (error, abort, close before
 *  complete) and used to destroy the gate - so the route can tell "the client
 *  went away" from "the gate refused the file" by the ERROR alone. */
class GreetingClientAbortedError extends Error {
  constructor() {
    super('client aborted the greeting upload');
    this.name = 'GreetingClientAbortedError';
  }
}

function parseContentLength(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Decode the URI-encoded display-name header; a bad encoding reads as absent. */
function decodeFileNameHeader(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
```

Inside `createSettingsRouter`, after `const { config } = deps;`:

```ts
  const mediaStore = deps.mediaStore;
  // Same per-user mint fence shape as the MMS presign route: cheap abuse
  // protection on an admin-only route. ONE instance per router.
  const uploadLimiter = createUserRateLimit({
    routeKey: 'voicemail_greeting_upload',
    max: 10,
    windowMs: 60_000,
    logger: log,
  });
```

Add the three routes BEFORE `return router;`:

```ts
  // PUT /api/settings/voicemail-greeting (voicemail-greeting spec 4.3): the RAW
  // file bytes as the body, streamed through the sniff-and-cap gate into the
  // media store under the fixed key, then the record SET on the org settings.
  // A refusal must REACH the browser as JSON, which is why this uses req.pipe
  // (never stream.pipeline, which destroys req and its socket on a gate error)
  // and never Connection: close (proven on Node 24 to reset a client that is
  // still uploading). The cost of draining a refused body is bounded by the
  // Content-Length check below (at most 5 MiB reaches the gate for a
  // known-length body); the one unbounded shape - a chunked body over the cap,
  // which browsers never send for a Blob - is destroyed after the response
  // flushes. See docs/issues/mms-upload-endpoint-hardening.md for the same
  // trade-off on the retired MMS endpoint.
  router.put('/voicemail-greeting', requireRole('admin'), uploadLimiter, async (req: AuthedRequest, res) => {
    const actor = req.user?.userId;
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const normalized = normalizeGreetingContentType(
      Array.isArray(req.headers['content-type']) ? req.headers['content-type'][0] : req.headers['content-type'],
    );
    if (normalized === undefined) {
      res.status(400).json({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
      return;
    }
    const declaredLength = parseContentLength(req.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > VOICEMAIL_GREETING_MAX_BYTES) {
      res.status(413).json({ error: 'file_too_large', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
      return;
    }
    if (declaredLength === 0) {
      res.status(400).json({ error: 'empty_file' });
      return;
    }

    const gate = new GreetingUploadGate({ format: normalized.format, maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
    // A gate error must never surface as an unhandled 'error' event in the gap
    // before lib-storage attaches its consumer; put() rejects with it anyway.
    gate.on('error', () => {});
    const abortGate = () => gate.destroy(new GreetingClientAbortedError());
    req.on('error', abortGate);
    req.on('aborted', abortGate);
    req.on('close', () => {
      if (!req.complete) abortGate();
    });
    req.pipe(gate);
    const putPromise = mediaStore.put(VOICEMAIL_GREETING_S3_KEY, gate, normalized.contentType);

    let sizeBytes: number;
    try {
      await putPromise;
      sizeBytes = gate.bytesSeen;
    } catch (err) {
      if (err instanceof GreetingRejectedError) {
        req.unpipe(gate);
        // Drain what is left so the response can be READ by the client. For a
        // known length this is bounded (step 3 refused anything over 5 MiB);
        // for a chunked over-cap body it is not, and that is accepted: browsers
        // never send a Blob chunked, and destroying the request after the
        // response "finishes" was measured to RESET the client before it reads
        // the 413 (spec 4.3).
        req.resume();
        if (err.reason === 'invalid_format') {
          res.status(400).json({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
        } else if (err.reason === 'too_large') {
          res.status(413).json({ error: 'file_too_large', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
        } else {
          res.status(400).json({ error: 'empty_file' });
        }
        return;
      }
      if (err instanceof GreetingClientAbortedError) {
        log.warn({ actor, reason: 'client_aborted' }, 'voicemail greeting upload aborted by the client');
        if (!res.headersSent) res.destroy();
        return;
      }
      log.error({ err, actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting upload failed');
      res.status(500).json({ error: 'upload_failed' });
      return;
    }

    const record: VoicemailGreeting = {
      s3Key: VOICEMAIL_GREETING_S3_KEY,
      contentType: normalized.contentType,
      fileName: sanitizeGreetingFileName(decodeFileNameHeader(req.headers[VOICEMAIL_GREETING_FILE_NAME_HEADER]), normalized.format),
      sizeBytes,
      uploadedAt: new Date().toISOString(),
      uploadedByUserId: req.user?.userId ?? '',
      uploadedByEmail: req.user?.email ?? '',
    };
    try {
      await settings.putOrgSettings({ voicemailGreeting: record });
    } catch (err) {
      // The object holds the new bytes; the record is stale or absent. The
      // webhook reads the record, so the worst case is a stale name/date at the
      // same fixed key - never a broken call.
      log.error({ err, actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting stored but the settings record write failed');
      res.status(500).json({ error: 'greeting_record_failed' });
      return;
    }
    // Best effort: the greeting is LIVE once the record is written; a 500 here
    // would tell the admin the upload failed while callers already hear it.
    await audit
      .append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', { fields: ['voicemailGreeting'], action: 'uploaded', actor })
      .catch((err: unknown) => log.error({ err, actor }, 'voicemail greeting audit append failed'));
    // PII posture: the file name is never logged.
    log.info({ actor, s3Key: VOICEMAIL_GREETING_S3_KEY, contentType: normalized.contentType, sizeBytes }, 'voicemail greeting uploaded');
    res.json({ voicemailGreeting: record });
  });

  // DELETE /api/settings/voicemail-greeting (spec 4.4): the RECORD is the
  // authority - clear it first, then best-effort delete the object (a leftover
  // object under the fixed key is unreferenced and overwritten by the next
  // upload; on the versioned bucket this writes a delete marker).
  router.delete('/voicemail-greeting', requireRole('admin'), async (req: AuthedRequest, res) => {
    const actor = req.user?.userId;
    await settings.putOrgSettings({ voicemailGreeting: null });
    if (mediaStore) {
      await mediaStore
        .deleteObject(VOICEMAIL_GREETING_S3_KEY)
        .catch((err: unknown) => log.warn({ err, actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting object delete failed - record already cleared'));
    }
    await audit
      .append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', { fields: ['voicemailGreeting'], action: 'removed', actor })
      .catch((err: unknown) => log.error({ err, actor }, 'voicemail greeting audit append failed'));
    log.info({ actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting removed');
    res.status(204).end();
  });

  // GET /api/settings/voicemail-greeting/audio (spec 4.5): any logged-in user
  // (requireAuth from the /api mount) may play it; same streaming, range and
  // cache posture as GET /api/calls/:callId/recording.
  router.get('/voicemail-greeting/audio', async (_req, res) => {
    const current = await settings.getOrgSettings();
    const greeting = current.voicemailGreeting;
    if (greeting === undefined || !mediaStore) {
      res.status(404).json({ error: 'greeting_not_found' });
      return;
    }
    await serveMediaObject(_req, res, {
      mediaStore,
      key: greeting.s3Key,
      defaultContentType: greeting.contentType,
      cacheControl: 'private, max-age=3600',
      notFoundError: 'greeting_not_found',
      log,
      logContext: { s3Key: greeting.s3Key },
      messages: {
        missing: 'voicemail greeting record present but object not found in the media store',
        streaming: 'streaming the voicemail greeting to the dashboard',
        errored: 'voicemail greeting stream errored mid-flight',
      },
    });
  });
```

`Readable` import: remove it if unused after writing (it is not needed by the code above; delete the import line rather than leave an unused one).

In `app/src/routes/api.ts` (~line 724), pass the store:

```ts
    createSettingsRouter({
      config,
      logger: deps.logger,
      ...(deps.settingsRepo !== undefined && { settingsRepo: deps.settingsRepo }),
      auditRepo: audit,
      ...(mediaStore !== undefined && { mediaStore }),
    }),
```

- [ ] **Step 5b: Pin that `S3MediaStore.head` forwards the abort signal**

```ts
// app/test/mediaStore.head.test.ts
// The voicemail-greeting webhook bounds its HeadObject with an AbortSignal
// (spec 4.6). This pins that the signal actually reaches client.send as
// `abortSignal` - the only thing that releases a pooled socket when the
// lookup budget expires. Same fake-client shape as mediaStore.getStreamRange.test.ts.
import { describe, expect, it } from 'vitest';
import { S3MediaStore } from '../src/adapters/mediaStore.js';

describe('S3MediaStore.head', () => {
  it('passes opts.signal to client.send as abortSignal, and nothing when omitted', async () => {
    const seen: { input: Record<string, unknown>; options: unknown }[] = [];
    const client = {
      send: async (cmd: { input: Record<string, unknown> }, options?: unknown) => {
        seen.push({ input: { ...cmd.input }, options });
        return { ContentType: 'audio/mpeg', ContentLength: 427 };
      },
    } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
    const store = new S3MediaStore('bucket', client);
    const signal = AbortSignal.timeout(10_000);
    await expect(store.head('settings/voicemail-greeting', { signal })).resolves.toEqual({ contentType: 'audio/mpeg', size: 427 });
    expect(seen[0]?.input).toEqual({ Bucket: 'bucket', Key: 'settings/voicemail-greeting' });
    expect((seen[0]?.options as { abortSignal?: AbortSignal }).abortSignal).toBe(signal);
    await store.head('settings/voicemail-greeting');
    expect(seen[1]?.options).toBeUndefined();
  });
  it('an aborted send rejects (never reads as a 404)', async () => {
    const client = {
      send: async () => {
        const err = new Error('Request aborted');
        (err as { name?: string }).name = 'AbortError';
        throw err;
      },
    } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
    await expect(new S3MediaStore('bucket', client).head('k', { signal: AbortSignal.abort() })).rejects.toThrow('Request aborted');
  });
});
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/voicemailGreetingRoutes.test.ts test/mediaStore.head.test.ts test/settings.test.ts test/mmsMediaRoutes.test.ts test/mediaStore.test.ts && cd .. && npm run typecheck && npx eslint app/src/routes/settings.ts app/src/adapters/mediaStore.ts app/test/voicemailGreetingRoutes.test.ts app/test/mediaStore.head.test.ts app/test/helpers/twilioWebhookHarness.ts`
Expected: all PASS; typecheck 0; no new lint errors. If a large-body refusal test reports ECONNRESET: first confirm the request went through `admin()` / carries `Connection: keep-alive` (supertest's default `Connection: close` is the usual cause and has nothing to do with the route); only then look at the route - `stream.pipeline`, `Connection: close` on the response, or a `req.destroy()` after the response would each reset the client. Do not shrink the bodies.

- [ ] **Step 7: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add app/src/adapters/mediaStore.ts app/src/routes/settings.ts app/src/routes/api.ts app/test/helpers/twilioWebhookHarness.ts app/test/voicemailGreetingRoutes.test.ts app/test/mediaStore.head.test.ts && git commit -m "feat(voicemail-greeting): upload/remove/audio routes under /api/settings (streamed sniff-and-cap gate, fixed key, best-effort audit); MediaStore.head abort signal; harness head/presign seams

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 5: Voice webhook - offer the greeting with a time bound

**Files:**
- Modify: `app/src/routes/webhooks/voice.ts` (imports; `TwilioVoiceWebhookDeps`; a local helper inside `createTwilioVoiceRouter`; the `/status` miss branch at `reply.say(resolveMessage('voice.voicemail_prompt'))` ~line 1875)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`HarnessOptions.voicemailGreetingLookupBudgetMs` threaded into the `webhooks` deps next to `statusUnknownSidRetryDelayMs`)
- Test: `app/test/founderTriage.test.ts` (`founderHarness` widened to take harness options; `seedRingingBridgeWith` added beside `seedRingingBridge`; a nested `describe` added INSIDE the MISSED describe that owns `world`)

**Interfaces:**
- Consumes: Task 1 (`withTimeout`, `VOICEMAIL_GREETING_LOOKUP_BUDGET_MS`, `VOICEMAIL_GREETING_PLAY_TTL_SECONDS`), Task 2 (`world.settings.voicemailGreeting`), Task 4 harness seams (`mediaHeads`, `mediaPresigns`, `failMediaHeads`, `hangMediaHeads`, `head(key, { signal })`).
- Produces: `TwilioVoiceWebhookDeps.voicemailGreetingLookupBudgetMs?: number`; TwiML `<Play>` before `<Record>` when a greeting is offered; log lines `voicemail greeting offered` (INFO) and the three WARNs named below.

- [ ] **Step 1: Write the failing webhook tests**

In `app/test/founderTriage.test.ts` the harness helpers are NOT module-level: `founderHarness(world)` (~line 102) builds a fresh `makeWebhookHarness({ world })` and assigns the holder; `seedRingingBridge()` (~line 598) lives INSIDE `describe('founder call-triage - MISSED -> push + auto-text (M1.9b)')` (~lines 553-1136), which owns `world` and the job-wiring `beforeEach`. So:

(1) Widen `founderHarness` to accept harness options and forward them (every existing caller passes none):

```ts
function founderHarness(world: FakeWorld, opts: Omit<HarnessOptions, 'world'> = {}) {
  const harness = makeWebhookHarness({ world, ...opts });
  // ... the rest of the function is unchanged (admin cell + assignInboundVoiceLine) ...
}
```

Import `HarnessOptions` from `./helpers/twilioWebhookHarness.js` (export it there if it is not exported yet - it is declared `export interface HarnessOptions`).

(2) INSIDE that describe, next to `seedRingingBridge`, add a variant that returns the harness too, and make `seedRingingBridge` delegate to it so the existing callers are untouched:

```ts
  /** seedRingingBridge, but built with harness options and returning the
   *  capture too (the voicemail-greeting cases assert on log lines). */
  async function seedRingingBridgeWith(
    opts: Omit<HarnessOptions, 'world'>,
    caller: Record<string, unknown> = { type: 'unknown' },
  ) {
    world.contacts.push({ contactId: 'c-caller', phone: CALLER, ...caller } as (typeof world.contacts)[number]);
    const harness = founderHarness(world, opts);
    await signedTwilioPost(harness.app, '/webhooks/twilio/voice', bizVoiceParams());
    world.pushSends.length = 0;
    return harness;
  }

  async function seedRingingBridge(caller: Record<string, unknown> = { type: 'unknown' }) {
    return (await seedRingingBridgeWith({}, caller)).app;
  }
```

(3) INSIDE the same describe (before its closing `});`, after the last existing `it`), add:

```ts
  describe('voicemail greeting on the missed founder-bridge <Dial action> (voicemail-greeting spec 4.6)', () => {
    const GREETING = {
      s3Key: 'settings/voicemail-greeting',
      contentType: 'audio/mpeg' as const,
      fileName: 'sam.mp3',
      sizeBytes: 427,
      uploadedAt: '2026-09-26T12:00:00.000Z',
      uploadedByUserId: 'user-0001',
      uploadedByEmail: 'founder@example.com',
    };
    const MISS = { CallSid: 'CAbiz0001', DialCallStatus: 'no-answer', ApiVersion: '2010-04-01' };
    const greetingWarns = (capture: LogCapture) =>
      capture.atLevel(40).filter((l) => String(l['msg']).includes('voicemail greeting'));

    function seedGreeting(withObject = true) {
      world.settings.voicemailGreeting = { ...GREETING };
      if (withObject) {
        world.mediaObjects.set(GREETING.s3Key, { body: Buffer.from('greeting-bytes'), contentType: 'audio/mpeg' });
      }
    }

    it('(a) greeting set + object present -> <Play presigned> BEFORE <Record>, no spoken prompt, Record unchanged, offered INFO', async () => {
      seedGreeting();
      const { app, capture } = await seedRingingBridgeWith({});
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
      expect(res.status).toBe(200);
      const play = res.text.indexOf('<Play>');
      const record = res.text.indexOf('<Record');
      expect(play).toBeGreaterThan(-1);
      expect(record).toBeGreaterThan(play);
      expect(res.text).toMatch(/<Play>https:\/\/fake-s3\.local\/settings\/voicemail-greeting\?X-Amz-Signature=fakesig\d+&amp;X-Amz-Expires=600<\/Play>/);
      expect(res.text).not.toContain(resolveMessage('voice.voicemail_prompt'));
      expect(res.text).toContain('maxLength="120"');
      expect(res.text).toContain(resolveMessage('voice.voicemail_thanks'));
      expect(world.mediaHeads).toEqual([{ key: GREETING.s3Key, signal: true }]);
      expect(world.mediaPresigns).toEqual([{ key: GREETING.s3Key, ttlSeconds: 600 }]);
      expect(capture.lines.some((l) => l['msg'] === 'voicemail greeting offered')).toBe(true);
      expect(JSON.stringify(capture.lines)).not.toContain('X-Amz-Signature');
    });

    it('(b) no greeting -> the spoken prompt exactly as today and NO greeting log line', async () => {
      const { app, capture } = await seedRingingBridgeWith({});
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
      expect(res.text).toContain(resolveMessage('voice.voicemail_prompt'));
      expect(res.text).not.toContain('<Play>');
      expect(capture.lines.some((l) => String(l['msg']).includes('voicemail greeting'))).toBe(false);
      expect(world.mediaHeads).toHaveLength(0);
    });

    it('(c) greeting set but the object is missing -> spoken prompt + ONE WARN without a URL', async () => {
      seedGreeting(false);
      const { app, capture } = await seedRingingBridgeWith({});
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
      expect(res.status).toBe(200);
      expect(res.text).toContain(resolveMessage('voice.voicemail_prompt'));
      expect(res.text).not.toContain('<Play>');
      const warns = greetingWarns(capture);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.['msg']).toBe('voicemail greeting object missing - using the spoken prompt');
      expect(JSON.stringify(warns)).not.toContain('http');
    });

    it('(d) head throws -> spoken prompt + WARN, still 200', async () => {
      seedGreeting();
      world.failMediaHeads.add(GREETING.s3Key);
      const { app, capture } = await seedRingingBridgeWith({});
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
      expect(res.status).toBe(200);
      expect(res.text).toContain(resolveMessage('voice.voicemail_prompt'));
      expect(res.text).not.toContain('<Play>');
      expect(greetingWarns(capture).some((l) => l['msg'] === 'voicemail greeting lookup failed or timed out - using the spoken prompt')).toBe(true);
    });

    it('(e) head never settles -> the abort signal ends it inside the budget: spoken prompt, one WARN, no offered line even after a tick', async () => {
      seedGreeting();
      world.hangMediaHeads.add(GREETING.s3Key);
      const { app, capture } = await seedRingingBridgeWith({ voicemailGreetingLookupBudgetMs: 50 });
      const t0 = Date.now();
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(res.status).toBe(200);
      expect(res.text).toContain(resolveMessage('voice.voicemail_prompt'));
      expect(res.text).not.toContain('<Play>');
      expect(greetingWarns(capture)).toHaveLength(1);
      expect(world.mediaHeads[0]?.signal).toBe(true);
      await new Promise((r) => setTimeout(r, 120));
      expect(greetingWarns(capture)).toHaveLength(1);
      expect(capture.lines.some((l) => l['msg'] === 'voicemail greeting offered')).toBe(false);
    });

    it('(e2) the SETTINGS read never settles (no abort signal there) -> only withTimeout can end it: spoken prompt inside the budget, WARN names the budget', async () => {
      seedGreeting();
      const { app, capture } = await seedRingingBridgeWith({ voicemailGreetingLookupBudgetMs: 50 });
      // The router holds the repo OBJECT, so replacing the method on it after
      // the harness is built is what the router calls. Restore afterwards.
      const original = world.settingsRepo.getOrgSettings;
      world.settingsRepo.getOrgSettings = () => new Promise(() => {});
      try {
        const t0 = Date.now();
        const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(res.status).toBe(200);
        expect(res.text).toContain(resolveMessage('voice.voicemail_prompt'));
        expect(res.text).not.toContain('<Play>');
        const warns = greetingWarns(capture);
        expect(warns).toHaveLength(1);
        expect(String((warns[0]?.['err'] as { message?: string } | undefined)?.message)).toContain('exceeded 50ms');
        expect(world.mediaHeads).toHaveLength(0);
      } finally {
        world.settingsRepo.getOrgSettings = original;
      }
    });

    it('(f) greeting set, no media store -> spoken prompt + WARN', async () => {
      seedGreeting(false);
      const { app, capture } = await seedRingingBridgeWith({ withoutMediaStore: true });
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', MISS);
      expect(res.status).toBe(200);
      expect(res.text).toContain(resolveMessage('voice.voicemail_prompt'));
      expect(greetingWarns(capture).some((l) => l['msg'] === 'voicemail greeting set but no media store configured - using the spoken prompt')).toBe(true);
    });

    it('(g) a MASKED relay miss with a greeting set keeps the goodbye - no <Play>, no head', async () => {
      seedGreeting();
      seedRelayGroup(world);
      const { app } = makeWebhookHarness({ world });
      await signedTwilioPost(app, '/webhooks/twilio/voice', {
        CallSid: 'CAmasked1',
        From: ALICE,
        To: POOL,
        CallStatus: 'ringing',
        Direction: 'inbound',
        ApiVersion: '2010-04-01',
      });
      expect(world.messages.find((m) => m.provider_sid === 'CAmasked1')!.masked).toBe(true);
      const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
        CallSid: 'CAmasked1',
        DialCallStatus: 'no-answer',
        ApiVersion: '2010-04-01',
      });
      expect(res.status).toBe(200);
      expect(res.text).toContain(resolveMessage('voice.missed_call_goodbye'));
      expect(res.text).not.toContain('<Play>');
      expect(res.text).not.toContain('<Record');
      expect(world.mediaHeads).toHaveLength(0);
    });
  });
```

Add `import type { LogCapture } from './helpers/logCapture.js';` to the file's imports (the file already imports `createLogCapture` from there). Test (e) proves the ABORT-SIGNAL path (the fake head rejects when the signal fires, exactly as the S3 client does); test (e2) proves the `withTimeout` bound on its own, because the settings read has no signal - deleting `withTimeout` from the webhook turns (e2) red. Pino serializes `err` as an object with `message`, which (e2) reads.

- [ ] **Step 2: Run to verify they fail**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/founderTriage.test.ts -t "voicemail greeting"`
Expected: (a), (c), (d), (e), (e2), (f) FAIL (no `<Play>`, no greeting log lines, `voicemailGreetingLookupBudgetMs` unknown to the harness); (b) and (g) pass already (today's behavior) and stay as guards - (g) is the masked-call privacy guard and must keep passing after Step 3.

- [ ] **Step 3: Implement the webhook side**

`app/src/routes/webhooks/voice.ts` imports (next to the mediaStore import):

```ts
import {
  VOICEMAIL_GREETING_LOOKUP_BUDGET_MS,
  VOICEMAIL_GREETING_PLAY_TTL_SECONDS,
  withTimeout,
} from '../../lib/voicemailGreeting.js';
```

`TwilioVoiceWebhookDeps` (after `extractionRepo?`):

```ts
  /**
   * Voicemail-greeting lookup budget in ms (spec 4.6). Tests shrink it to prove
   * the bound; production always uses VOICEMAIL_GREETING_LOOKUP_BUDGET_MS.
   */
  voicemailGreetingLookupBudgetMs?: number;
```

Inside `createTwilioVoiceRouter`, after `const baseUrl = ...`:

```ts
  const greetingLookupBudgetMs = deps.voicemailGreetingLookupBudgetMs ?? VOICEMAIL_GREETING_LOOKUP_BUDGET_MS;

  // Voicemail greeting (spec 4.6). The LOOKUP returns a result and touches
  // nothing - no TwiML, no log line - so a lookup that resolves AFTER the
  // budget has nothing to append and nothing to log. Only the caller, and
  // only when the race resolved in time, emits <Play> and writes the one
  // INFO or WARN. PII: callSid + the fixed s3Key only; the presigned URL is a
  // bearer token and is never logged.
  type GreetingLookup =
    | { kind: 'play'; url: string; s3Key: string }
    | { kind: 'absent' }
    | { kind: 'no_store'; s3Key: string }
    | { kind: 'missing'; s3Key: string };

  async function lookupVoicemailGreeting(signal: AbortSignal): Promise<GreetingLookup> {
    const org = await settings.getOrgSettings();
    const greeting = org.voicemailGreeting;
    if (greeting === undefined) return { kind: 'absent' };
    if (!mediaStore) return { kind: 'no_store', s3Key: greeting.s3Key };
    const head = await mediaStore.head(greeting.s3Key, { signal });
    if (head === undefined) return { kind: 'missing', s3Key: greeting.s3Key };
    const url = await mediaStore.presign(greeting.s3Key, VOICEMAIL_GREETING_PLAY_TTL_SECONDS);
    return { kind: 'play', url, s3Key: greeting.s3Key };
  }

  /**
   * Append <Play greeting> to `reply` when a greeting is set AND its object
   * exists, inside the budget; returns whether it did. Every other outcome
   * (none set, store unconfigured, object missing, thrown error, timeout)
   * returns false so the caller speaks today's prompt - the webhook can never
   * fail because of the greeting (decision 3). No log line when no greeting is
   * set (the normal state of every org); WARN for the rest.
   */
  async function offerVoicemailGreeting(reply: InstanceType<typeof VoiceResponse>, callSid: string): Promise<boolean> {
    let result: GreetingLookup;
    try {
      result = await withTimeout(
        lookupVoicemailGreeting(AbortSignal.timeout(greetingLookupBudgetMs)),
        greetingLookupBudgetMs,
        'voicemail greeting lookup',
      );
    } catch (err) {
      log.warn(
        { err, callSid, budgetMs: greetingLookupBudgetMs },
        'voicemail greeting lookup failed or timed out - using the spoken prompt',
      );
      return false;
    }
    switch (result.kind) {
      case 'absent':
        return false;
      case 'no_store':
        log.warn({ callSid, s3Key: result.s3Key }, 'voicemail greeting set but no media store configured - using the spoken prompt');
        return false;
      case 'missing':
        log.warn({ callSid, s3Key: result.s3Key }, 'voicemail greeting object missing - using the spoken prompt');
        return false;
      case 'play':
        reply.play(result.url);
        log.info({ callSid, s3Key: result.s3Key }, 'voicemail greeting offered');
        return true;
    }
  }
```

In the `/status` handler, replace the single line `reply.say(resolveMessage('voice.voicemail_prompt'));` (inside the `if (isMissed && entry?.type === 'call' && entry.masked !== true && entry.direction !== 'outbound')` block) with:

```ts
      // Recorded greeting first (spec 4.6); today's spoken prompt when there is
      // none or it cannot be offered in time. Everything after this line -
      // <Record>, the thanks, the hangup - is untouched (decision 5).
      const played = await offerVoicemailGreeting(reply, entryCallSid);
      if (!played) reply.say(resolveMessage('voice.voicemail_prompt'));
```

Extend the block comment above the `const reply = new VoiceResponse();` (the one starting "/status is ALSO the <Dial action> URL") with one bullet: "INBOUND founder-bridge miss: when an admin has uploaded a voicemail greeting, `<Play>` it (presigned, time-bounded) instead of the spoken prompt (voicemail-greeting spec 4.6)".

Harness (`app/test/helpers/twilioWebhookHarness.ts`): add to `HarnessOptions`

```ts
  /** Voicemail-greeting lookup budget for the voice webhook (tests shrink the 2500ms default). */
  voicemailGreetingLookupBudgetMs?: number;
```

and next to the `statusUnknownSidRetryDelayMs` spread in the `webhooks` deps:

```ts
      ...(opts.voicemailGreetingLookupBudgetMs !== undefined && {
        voicemailGreetingLookupBudgetMs: opts.voicemailGreetingLookupBudgetMs,
      }),
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd W:/tmp/voicemail-greeting/app && npx vitest run test/founderTriage.test.ts test/voiceRecording.test.ts test/voiceWebhook.test.ts test/voiceMasking.test.ts && cd .. && npm run typecheck && npx eslint app/src/routes/webhooks/voice.ts app/test/founderTriage.test.ts`
Expected: PASS, including every pre-existing case in those files (the no-greeting path is byte-identical); typecheck 0; no new lint errors.

- [ ] **Step 5: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add app/src/routes/webhooks/voice.ts app/test/helpers/twilioWebhookHarness.ts app/test/founderTriage.test.ts && git commit -m "feat(voicemail-greeting): missed founder-bridge voicemail plays the uploaded greeting (<Play> presigned, 2.5s budget, spoken-prompt fallback)

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 6: fake-twilio - record the verb before `<Record>` and fetch the play URL

**Files:**
- Modify: `fake-twilio/src/engine/twimlInterpreter.ts` (the `record` plan shape; an ordered second parse)
- Modify: `fake-twilio/src/engine/voiceTypes.ts` (`CallState` fields)
- Modify: `fake-twilio/src/engine/callEngine.ts` (`CallEngineDeps.fetchStatus`; `leaveVoicemail`)
- Test: `fake-twilio/test/twimlInterpreter.test.ts` (create if absent; otherwise append), `fake-twilio/test/callEngineVoicemail.test.ts` (append)

**Interfaces:**
- Produces: `CallState.voicemailGreeting?: 'play' | 'say' | 'none'`, `CallState.voicemailGreetingFetchStatus?: number` (visible on `GET /control/calls`); `CallEngineDeps.fetchStatus?: (url: string) => Promise<number>`.

- [ ] **Step 1: Write the failing tests**

`fake-twilio/test/twimlInterpreter.test.ts`: if the file does NOT exist, create it with the two imports below; if it DOES exist, it already imports `vitest` and `interpretTwiml` - add ONLY the `const`s and the `describe` (a second import of the same binding is a SyntaxError):

```ts
import { describe, expect, it } from 'vitest';
import { interpretTwiml } from '../src/engine/twimlInterpreter.js';

const REC = '<Record maxLength="120" playBeep="true" action="https://app/webhooks/twilio/voice/voicemail-done" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" recordingStatusCallbackEvent="completed"/>';
const wrap = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

describe('interpretTwiml - the verb immediately before <Record> (voicemail greeting)', () => {
  it('Play+Record+Say -> play with the URL (entities decoded)', () => {
    const plan = interpretTwiml(wrap(`<Play>https://s3.local/settings/voicemail-greeting?a=1&amp;b=2</Play>${REC}<Say>Thanks.</Say><Hangup/>`));
    expect(plan.kind).toBe('record');
    expect(plan).toMatchObject({ greeting: 'play', playUrl: 'https://s3.local/settings/voicemail-greeting?a=1&b=2' });
  });
  it('Say+Record+Say -> say (the thanks after Record does not count)', () => {
    const plan = interpretTwiml(wrap(`<Say>Leave a message.</Say>${REC}<Say>Thanks.</Say><Hangup/>`));
    expect(plan).toMatchObject({ kind: 'record', greeting: 'say' });
    expect((plan as { playUrl?: string }).playUrl).toBeUndefined();
  });
  it('Record+Say -> none', () => {
    expect(interpretTwiml(wrap(`${REC}<Say>Thanks.</Say>`))).toMatchObject({ kind: 'record', greeting: 'none' });
  });
  it('Say+Play+Record -> play (only the verb immediately before Record counts)', () => {
    expect(interpretTwiml(wrap(`<Say>Hi</Say><Play>https://x/y</Play>${REC}`))).toMatchObject({ kind: 'record', greeting: 'play', playUrl: 'https://x/y' });
  });
  it('the existing record attributes are unchanged', () => {
    const plan = interpretTwiml(wrap(`<Say>Hi</Say>${REC}`));
    expect(plan).toMatchObject({ kind: 'record', maxLength: 120, playBeep: true, actionUrl: 'https://app/webhooks/twilio/voice/voicemail-done' });
  });
});
```

Append to `fake-twilio/test/callEngineVoicemail.test.ts` (reuse its `makeEngine`, `FOUNDER_DIAL`, `VOICEMAIL_TWIML`, the inbound drive used by the existing voicemail case, and its `RECORDING_BASE`):

```ts
const PLAY_VOICEMAIL_TWIML = VOICEMAIL_TWIML.replace(
  '<Say>Sorry we missed your call. Please leave a message after the tone.</Say>',
  '<Play>http://minio.local/hc-local-media/settings/voicemail-greeting?X-Amz-Signature=abc&amp;X-Amz-Expires=600</Play>',
);

describe('CallEngine voicemail greeting observation (voicemail-greeting spec 4.8)', () => {
  it('records the verb before <Record> and the play-URL fetch status', async () => {
    const fetched: string[] = [];
    const { engine, clock } = makeEngine(FOUNDER_DIAL, PLAY_VOICEMAIL_TWIML, {
      fetchStatus: async (url) => { fetched.push(url); return 200; },
    });
    // ... drive the same missed inbound founder-bridge call the existing
    //     'leaves a voicemail' case drives (placeCall with digit:null, then
    //     clock.flush() / await engine.settle() as that test does) ...
    const call = engine.getCalls()[0]!;
    expect(call.voicemailGreeting).toBe('play');
    expect(call.voicemailGreetingFetchStatus).toBe(200);
    expect(fetched).toEqual(['http://minio.local/hc-local-media/settings/voicemail-greeting?X-Amz-Signature=abc&X-Amz-Expires=600']);
    expect(call.status).toBe('completed');
  });
  it('a Say greeting records say and fetches nothing; a throwing fetch records 0 and the call still completes', async () => {
    const { engine } = makeEngine(FOUNDER_DIAL, VOICEMAIL_TWIML, { fetchStatus: async () => { throw new Error('no network'); } });
    // ... same drive ...
    expect(engine.getCalls()[0]!.voicemailGreeting).toBe('say');
    expect(engine.getCalls()[0]!.voicemailGreetingFetchStatus).toBeUndefined();
    const { engine: e2 } = makeEngine(FOUNDER_DIAL, PLAY_VOICEMAIL_TWIML, { fetchStatus: async () => { throw new Error('no network'); } });
    // ... same drive ...
    expect(e2.getCalls()[0]!.voicemailGreetingFetchStatus).toBe(0);
    expect(e2.getCalls()[0]!.status).toBe('completed');
  });
});
```

`makeEngine` in that file takes two arguments today; extend it with an optional third `extra: Partial<CallEngineDeps>` spread into the `new CallEngine({...})` call. The `// ... same drive ...` lines mean: copy the exact drive statements from the file's first voicemail test (they are three to five lines); do not invent a new drive.

- [ ] **Step 2: Run to verify they fail**

Run: `cd W:/tmp/voicemail-greeting/fake-twilio && npx vitest run test/twimlInterpreter.test.ts test/callEngineVoicemail.test.ts`
Expected: FAIL (`greeting` undefined; `voicemailGreeting` undefined; `fetchStatus` unknown).

- [ ] **Step 3: Implement**

`fake-twilio/src/engine/twimlInterpreter.ts`:

```ts
export type VoicemailGreetingVerb = 'play' | 'say' | 'none';
```

Change the `record` member of `TwimlPlan` to:

```ts
  | { kind: 'record'; maxLength?: number; playBeep?: boolean; actionUrl?: string; recordingStatusCallback?: string; greeting: VoicemailGreetingVerb; playUrl?: string }
```

Add after the existing `parser`:

```ts
// A SECOND, order-preserving parse used only to answer "which verb comes
// immediately before <Record>?" - the tag-keyed parse above discards sibling
// order, and a voicemail response always carries a thanks <Say> AFTER <Record>,
// so presence alone cannot tell a spoken prompt from a played greeting.
const orderedParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, parseTagValue: false });

type OrderedNode = Record<string, unknown>;

function textOf(node: unknown): string | undefined {
  if (!Array.isArray(node)) return undefined;
  const text = (node as OrderedNode[]).find((n) => '#text' in n);
  return text !== undefined ? String(text['#text']) : undefined;
}

/** The verb immediately preceding <Record> in document order, plus a <Play>'s URL. */
export function greetingBeforeRecord(xml: string): { greeting: VoicemailGreetingVerb; playUrl?: string } {
  const doc = orderedParser.parse(xml) as OrderedNode[];
  const response = doc.find((n) => 'Response' in n);
  const children = (response?.['Response'] as OrderedNode[] | undefined) ?? [];
  const at = children.findIndex((c) => 'Record' in c);
  if (at <= 0) return { greeting: 'none' };
  const prev = children[at - 1]!;
  if ('Play' in prev) {
    const url = textOf(prev['Play']);
    return { greeting: 'play', ...(url !== undefined && { playUrl: url }) };
  }
  if ('Say' in prev) return { greeting: 'say' };
  return { greeting: 'none' };
}
```

In `interpretTwiml`'s `if ('Record' in r)` branch, spread the observation:

```ts
    return {
      kind: 'record',
      ...greetingBeforeRecord(xml),
      ...(rec['@_maxLength'] !== undefined && { maxLength: Number(rec['@_maxLength']) }),
      ...(rec['@_playBeep'] !== undefined && { playBeep: String(rec['@_playBeep']) === 'true' }),
      ...(rec['@_action'] !== undefined && { actionUrl: String(rec['@_action']) }),
      ...(rec['@_recordingStatusCallback'] !== undefined && { recordingStatusCallback: String(rec['@_recordingStatusCallback']) }),
    };
```

`fake-twilio/src/engine/voiceTypes.ts`, in `CallState` after `viTranscriptSid?`:

```ts
  /** Voicemail greeting observation (voicemail-greeting spec 4.8): the verb the
   *  app's Dial-action TwiML placed immediately BEFORE <Record>. */
  voicemailGreeting?: 'play' | 'say' | 'none';
  /** HTTP status the fake got when it GET the <Play> URL (0 = network error);
   *  set only when the greeting was 'play'. */
  voicemailGreetingFetchStatus?: number;
```

`fake-twilio/src/engine/callEngine.ts`: in `CallEngineDeps` after `recordingServeBase?`:

```ts
  /** GET a <Play> URL and return its HTTP status (voicemail-greeting spec 4.8):
   *  the e2e's proof that the app's presigned MinIO URL actually serves the
   *  file. Defaults to a real fetch with a 5s timeout; 0 on any failure. Unit
   *  tests inject a stub. */
  fetchStatus?: (url: string) => Promise<number>;
```

Add a module-level default and the field/constructor wiring:

```ts
async function defaultFetchStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer(); // consume and discard
    return res.status;
  } catch {
    return 0;
  }
}
```

```ts
  private readonly fetchStatus: (url: string) => Promise<number>;
  // in the constructor:
  this.fetchStatus = deps.fetchStatus ?? defaultFetchStatus;
```

In `leaveVoicemail`, as the first statements:

```ts
    call.voicemailGreeting = plan.greeting;
    if (plan.playUrl !== undefined) {
      // Best effort and never fatal: the observation is for the e2e, the call
      // proceeds whatever the fetch returned - including an injected
      // fetchStatus that THROWS (the default never does; a stub might).
      try {
        call.voicemailGreetingFetchStatus = await this.fetchStatus(plan.playUrl);
      } catch {
        call.voicemailGreetingFetchStatus = 0;
      }
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd W:/tmp/voicemail-greeting/fake-twilio && npx vitest run && npm run typecheck`
Expected: the whole fake-twilio suite PASS (the existing voicemail cases use Say+Record+Say and never reach the fetch); typecheck 0.

- [ ] **Step 5: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add fake-twilio/src/engine/twimlInterpreter.ts fake-twilio/src/engine/voiceTypes.ts fake-twilio/src/engine/callEngine.ts fake-twilio/test/twimlInterpreter.test.ts fake-twilio/test/callEngineVoicemail.test.ts && git commit -m "feat(fake-twilio): record the verb before <Record> (play/say/none) and the <Play> URL fetch status on the call

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 7: Dashboard API layer + gate-2 static catalogs

**Files:**
- Modify (additive): `dashboard/src/api/types.ts` (~line 103-158), `dashboard/src/api/client.ts` (`RequestOptions` + `requestWithStatus`), `dashboard/src/api/endpoints.ts` (after `putSettings`, ~line 2037)
- Modify: `e2e/performance/mutationCatalog.ts` (after the `putSettings` entry, ~line 125), `e2e/performance/mutationCatalog.test.ts` (~line 373: `108` -> `110`), `e2e/performance/routes.ts` (~line 300 `VOICE_GETS`), `e2e/performance/routes.test.ts` (~line 112)
- Test: `dashboard/src/api/voicemailGreeting.client.test.ts` (create)

**Interfaces:**
- Produces: `VoicemailGreeting` (mirror), `OrgSettings.voicemailGreeting?`, `SettingsPatch` Omits it; `RequestOptions.rawBody?: Blob`, `RequestOptions.headers?: Record<string, string>`; `uploadVoicemailGreeting(file: File, contentType: string): Promise<VoicemailGreeting>`, `removeVoicemailGreeting(): Promise<void>`, `voicemailGreetingAudioUrl(greeting: VoicemailGreeting): string`.

- [ ] **Step 1: Write the failing client tests**

```ts
// dashboard/src/api/voicemailGreeting.client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { uploadVoicemailGreeting, removeVoicemailGreeting, voicemailGreetingAudioUrl } from './endpoints.js';
import { ApiError } from './client.js';
import * as serverClock from './serverClock.js';

const GREETING = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg' as const,
  fileName: 'sam.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'u1',
  uploadedByEmail: 'founder@example.com',
};

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', Date: 'Sat, 26 Sep 2026 12:00:00 GMT' }), json: async () => body }) as unknown as Response;
const errJson = (status: number, body: unknown) =>
  ({ ok: false, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }) as unknown as Response;
const noContent = () => ({ ok: true, status: 204, headers: new Headers() }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe('voicemail greeting client', () => {
  it('uploadVoicemailGreeting PUTs the raw file with its type and the encoded name header, never JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ voicemailGreeting: GREETING }));
    const noteSpy = vi.spyOn(serverClock, 'noteServerDate');
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], 'Sam greeting.mp3', { type: 'audio/mpeg' });
    const out = await uploadVoicemailGreeting(file, 'audio/mpeg');
    expect(out).toEqual(GREETING);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/voicemail-greeting', expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(file);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/mpeg');
    expect(headers['X-Greeting-File-Name']).toBe(encodeURIComponent('Sam greeting.mp3'));
    expect(noteSpy).toHaveBeenCalled();
  });
  it('maps a refusal to ApiError with the server code and message body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errJson(400, { error: 'unsupported_media_type', message: 'Upload an MP3 or WAV file.' }));
    const file = new File([new Uint8Array([1])], 'x.m4a', { type: 'audio/mp4' });
    const err = await uploadVoicemailGreeting(file, 'audio/mp4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('unsupported_media_type');
    expect((err as ApiError).status).toBe(400);
  });
  it('removeVoicemailGreeting DELETEs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(noContent());
    await removeVoicemailGreeting();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/voicemail-greeting', expect.objectContaining({ method: 'DELETE' }));
  });
  it('voicemailGreetingAudioUrl carries the upload instant as a cache-buster', () => {
    expect(voicemailGreetingAudioUrl(GREETING)).toBe('/api/settings/voicemail-greeting/audio?v=2026-09-26T12%3A00%3A00.000Z');
  });
  it('request() refuses body + rawBody together (programmer error) before any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { request } = await import('./client.js');
    await expect(request('/api/x', { method: 'PUT', body: { a: 1 }, rawBody: new Blob(['x']) })).rejects.toThrow('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd W:/tmp/voicemail-greeting/dashboard && npx vitest run src/api/voicemailGreeting.client.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement the additive API pieces**

`dashboard/src/api/types.ts`, after the `OrgSettings` interface's `welcomeText?` member add:

```ts
  /** OPTIONAL - the recorded voicemail greeting (voicemail-greeting spec 4.2).
   *  Absent until an admin uploads one. Written ONLY by the greeting routes;
   *  the generic PUT ignores it (see SettingsPatch). */
  voicemailGreeting?: VoicemailGreeting;
```

Add BEFORE `export interface OrgSettings`:

```ts
/** MIRRORS app/src/repos/settingsRepo.ts `VoicemailGreeting`. */
export interface VoicemailGreeting {
  s3Key: string;
  contentType: 'audio/mpeg' | 'audio/wav';
  /** Sanitized display name of the uploaded file. */
  fileName: string;
  sizeBytes: number;
  /** ISO instant; also the audio URL's cache-buster. */
  uploadedAt: string;
  uploadedByUserId: string;
  uploadedByEmail: string;
}
```

Replace `SettingsPatch`:

```ts
/** The PUT /api/settings patch: only the changed fields. `welcomeText` accepts
 *  an explicit `null` to CLEAR a previously-set value. `voicemailGreeting` is
 *  Omitted: the server ignores it on PUT - use uploadVoicemailGreeting /
 *  removeVoicemailGreeting. */
export type SettingsPatch = Partial<Omit<OrgSettings, 'welcomeText' | 'voicemailGreeting'>> & {
  welcomeText?: string | null;
};
```

`dashboard/src/api/client.ts` - `RequestOptions` gains two members (keep the existing ones):

```ts
  /** A RAW body (a File/Blob) sent as-is; the caller sets Content-Type via
   *  `headers`. Mutually exclusive with `body`. */
  rawBody?: Blob;
  /** Extra request headers (a raw upload's Content-Type and its name header). */
  headers?: Record<string, string>;
```

In `requestWithStatus`, replace the header/payload preamble with (ONE fetch call stays exactly `fetch(buildUrl(path, query), {...})` - the mutation-catalog scanner fingerprints it and refuses a second one or a hoisted URL):

```ts
  const { method = 'GET', body, rawBody, query, signal } = options;
  if (body !== undefined && rawBody !== undefined) {
    throw new Error('request: body and rawBody are mutually exclusive');
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const outgoing: BodyInit | undefined = payload ?? rawBody;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'same-origin',
      ...(outgoing !== undefined && { body: outgoing }),
      ...(signal !== undefined && { signal }),
    });
  } catch (err) {
```

(The `catch` and everything after it are unchanged.)

`dashboard/src/api/endpoints.ts`, after `putSettings`:

```ts
// --- Settings > Voice: the recorded voicemail greeting (/api/settings/voicemail-greeting)
// Admin-only writes; every logged-in user may read/play. The upload is the RAW
// file as the body (no multipart), its display name URI-encoded in a header so
// it never rides the URL (trace attributes) - spec 2026-09-26 section 4.3.

/** PUT /api/settings/voicemail-greeting - upload or replace. `contentType` is
 *  the canonical audio type the caller resolved (audio/mpeg | audio/wav |
 *  audio/x-wav). Throws ApiError: 400 unsupported_media_type (with `message`
 *  in the body) / empty_file, 413 file_too_large, 503 media_storage_unavailable,
 *  403 forbidden, 429 rate_limited. */
export function uploadVoicemailGreeting(file: File, contentType: string): Promise<VoicemailGreeting> {
  return request<{ voicemailGreeting: VoicemailGreeting }>('/api/settings/voicemail-greeting', {
    method: 'PUT',
    rawBody: file,
    headers: { 'Content-Type': contentType, 'X-Greeting-File-Name': encodeURIComponent(file.name) },
  }).then((r) => r.voicemailGreeting);
}

/** DELETE /api/settings/voicemail-greeting - 204; idempotent. */
export function removeVoicemailGreeting(): Promise<void> {
  return request<void>('/api/settings/voicemail-greeting', { method: 'DELETE' });
}

/** The authed audio URL for the in-page player. `?v=` is the upload instant so
 *  a Replace is never served from the browser cache. */
export function voicemailGreetingAudioUrl(greeting: VoicemailGreeting): string {
  return `/api/settings/voicemail-greeting/audio?v=${encodeURIComponent(greeting.uploadedAt)}`;
}
```

Add `VoicemailGreeting` to the `./types.js` import list at the top of `endpoints.ts` (and re-export it from `dashboard/src/api/index.ts` if that barrel enumerates types explicitly - check how `SettingsPatch` is exported there and mirror it).

- [ ] **Step 4: Gate-2 catalogs**

`e2e/performance/mutationCatalog.ts`, directly after the `putSettings` entry:

```ts
  entry(ENDPOINTS, 'uploadVoicemailGreeting', 'request:PUT', '/api/settings/voicemail-greeting'),
  entry(ENDPOINTS, 'removeVoicemailGreeting', 'request:DELETE', '/api/settings/voicemail-greeting'),
```

`e2e/performance/mutationCatalog.test.ts` ~line 373: `toHaveLength(108)` -> `toHaveLength(110)`, and extend the comment above it with one line: `+ uploadVoicemailGreeting and removeVoicemailGreeting (voicemail-greeting: PUT/DELETE /api/settings/voicemail-greeting).`

`e2e/performance/routes.ts` ~line 300:

```ts
// Voice tab (voicemail greeting): the org settings are required; the
// player's preload="metadata" audio GET happens only when a greeting is set.
const VOICE_GETS = Object.freeze([
  required('/api/users/me'),
  required('/api/settings'),
  conditional('/api/settings/voicemail-greeting/audio', ['v']),
]);
```

`e2e/performance/routes.test.ts` ~line 112 (mirror the exact string form the file uses for the other `conditional(...)` entries - read one first, e.g. grep `#conditional` in that file):

```ts
  '/settings/voice': ['/api/users/me?#required', '/api/settings?#required', '/api/settings/voicemail-greeting/audio?v#conditional'],
```

`e2e/performance/templates.ts` `ENDPOINT_TEMPLATES` (after `'/api/settings',`):

```ts
  '/api/settings/voicemail-greeting',
  '/api/settings/voicemail-greeting/audio',
```

(one template covers PUT and DELETE; the audio GET is its own path.) In `e2e/performance/routes.ts`, both `'/settings/voice'` source-citation strings (~lines 699 and 753) gain `; dashboard/src/routes/settings/useVoicemailGreeting.ts:1-40` so the citation names where the new required GET comes from (the citation test checks format only, so the exact line span is documentation, not a gate).

- [ ] **Step 5: Run to verify**

Run: `cd W:/tmp/voicemail-greeting/dashboard && npx vitest run src/api && cd ../e2e && npx vitest run performance/mutationCatalog.test.ts performance/routes.test.ts && cd .. && npm run typecheck`
Expected: PASS everywhere (the catalog test now discovers exactly 110 non-delegated mutations and both fingerprints match); typecheck 0.

- [ ] **Step 6: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add dashboard/src/api/types.ts dashboard/src/api/client.ts dashboard/src/api/endpoints.ts dashboard/src/api/index.ts dashboard/src/api/voicemailGreeting.client.test.ts e2e/performance/mutationCatalog.ts e2e/performance/mutationCatalog.test.ts e2e/performance/routes.ts e2e/performance/routes.test.ts e2e/performance/templates.ts && git commit -m "feat(voicemail-greeting): dashboard API (raw-body upload, remove, audio URL) + mutation catalog and Voice-tab GET contract

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

(Drop `dashboard/src/api/index.ts` from the `git add` if it needed no edit.)

---

### Task 8: Settings > Voice - the greeting block

**Files:**
- Create: `dashboard/src/routes/settings/useVoicemailGreeting.ts`, `dashboard/src/routes/settings/VoicemailGreetingBlock.tsx`, `dashboard/src/routes/settings/VoicemailGreetingBlock.test.tsx`
- Modify: `dashboard/src/routes/settings/VoiceSection.tsx` (mount the block after the ternary, inside the `<section>`), `dashboard/src/routes/settings/VoiceSection.test.tsx` (mock `getSettings`), `dashboard/src/routes/settings/VoiceSection.module.css` (new classes appended)

**Interfaces:**
- Consumes: Task 7 endpoints/types; `useOptionalAuth` from `../../app/AuthContext.js`; `Modal` from `../contact/Modal.js`; `Button`, `Spinner` from `../../ui/index.js`.
- Produces: the accessible names the e2e (Task 9) drives: heading "Voicemail greeting" (h3), file input `aria-label="Greeting audio file"`, buttons "Upload greeting" / "Replace greeting" / "Remove greeting", dialog title "Remove voicemail greeting?", dialog buttons "Cancel" / "Remove", `<audio aria-label="Voicemail greeting">`, status texts "No greeting uploaded - callers hear the built-in prompt.", "Greeting uploaded.", "Greeting replaced.", "Greeting removed.", "Couldn't load the voicemail greeting.", "The greeting file is missing or can't be played. Upload it again."

- [ ] **Step 1: Write the failing component tests**

```tsx
// dashboard/src/routes/settings/VoicemailGreetingBlock.test.tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { OrgSettings, SettingsResponse, VoicemailGreeting } from '../../api/index.js';

const getSettings = vi.fn();
const uploadVoicemailGreeting = vi.fn();
const removeVoicemailGreeting = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getSettings: (...a: unknown[]) => getSettings(...a),
    uploadVoicemailGreeting: (...a: unknown[]) => uploadVoicemailGreeting(...a),
    removeVoicemailGreeting: (...a: unknown[]) => removeVoicemailGreeting(...a),
  };
});

let isAdmin = true;
vi.mock('../../app/AuthContext.js', () => ({
  useOptionalAuth: () => ({
    status: 'authenticated',
    me: { userId: 'u1', email: 'x@example.com', role: isAdmin ? 'admin' : 'va' },
    isAdmin,
    refresh: vi.fn(),
  }),
}));

import { VoicemailGreetingBlock } from './VoicemailGreetingBlock.js';
import {
  GREETING_EMPTY_MESSAGE,
  GREETING_FORBIDDEN_MESSAGE,
  GREETING_REJECT_MESSAGE,
  GREETING_TOO_LARGE_MESSAGE,
} from './useVoicemailGreeting.js';

const BASE: OrgSettings = {
  missedCallAutoText: 'Sorry I missed you.',
  missedCallAutoTextEnabled: true,
  quickReplies: ['Please text me'],
  preRingPauseSeconds: 2,
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  timezone: 'America/New_York',
};
const GREETING: VoicemailGreeting = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg',
  fileName: 'sam-greeting.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'u1',
  uploadedByEmail: 'founder@example.com',
};
const wrap = (settings: OrgSettings): SettingsResponse => ({ settings, welcomeTextDefault: 'Welcome' });
const mp3 = (name = 'g.mp3', type = 'audio/mpeg', size = 3) => new File([new Uint8Array(size)], name, { type });
// applyAccept: false - user-event 14 otherwise DROPS a file whose type is not in
// the input's `accept` list (no change event, no alert), which would make the
// M4A-reject test time out for a reason unrelated to the code under test.
const user = userEvent.setup({ applyAccept: false });

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin = true;
  getSettings.mockResolvedValue(wrap(BASE));
});

describe('VoicemailGreetingBlock', () => {
  it('admin, no greeting: status line + Upload button, no alert', async () => {
    render(<VoicemailGreetingBlock />);
    expect(await screen.findByText('No greeting uploaded - callers hear the built-in prompt.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Voicemail greeting', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload greeting' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('VA sees the block without any action buttons', async () => {
    isAdmin = false;
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    render(<VoicemailGreetingBlock />);
    expect(await screen.findByText('sam-greeting.mp3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /greeting/i })).not.toBeInTheDocument();
    expect(screen.getByText(/An admin can upload or change it/)).toBeInTheDocument();
  });

  it('a load failure renders a status line with Retry and NO alert', async () => {
    getSettings.mockRejectedValueOnce(new ApiError(0, 'network_error', 'x'));
    render(<VoicemailGreetingBlock />);
    expect(await screen.findByText("Couldn't load the voicemail greeting.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    getSettings.mockResolvedValue(wrap(BASE));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No greeting uploaded - callers hear the built-in prompt.')).toBeInTheDocument();
  });

  it('an audio/mp4 file shows the reject message WITHOUT calling the endpoint', async () => {
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('memo.m4a', 'audio/mp4'));
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_REJECT_MESSAGE);
    expect(uploadVoicemailGreeting).not.toHaveBeenCalled();
  });

  it('an EMPTY type with a .mp3 name is sent as audio/mpeg (the server decides by header)', async () => {
    uploadVoicemailGreeting.mockResolvedValue(GREETING);
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('sam-greeting.mp3', ''));
    await waitFor(() => expect(uploadVoicemailGreeting).toHaveBeenCalledWith(expect.any(File), 'audio/mpeg'));
  });

  it('a 6 MB file shows the size message without a call; an empty file shows the empty message', async () => {
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.mp3', { type: 'audio/mpeg' });
    await user.upload(screen.getByLabelText('Greeting audio file'), big);
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_TOO_LARGE_MESSAGE);
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3('empty.mp3', 'audio/mpeg', 0));
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_EMPTY_MESSAGE);
    expect(uploadVoicemailGreeting).not.toHaveBeenCalled();
  });

  it('a valid file uploads and renders name, date, player and Replace/Remove', async () => {
    uploadVoicemailGreeting.mockResolvedValue(GREETING);
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect(await screen.findByText('Greeting uploaded.')).toBeInTheDocument();
    expect(screen.getByText('sam-greeting.mp3')).toBeInTheDocument();
    expect(screen.getByText(/Uploaded .* by founder@example.com/)).toBeInTheDocument();
    const audio = screen.getByLabelText('Voicemail greeting') as HTMLAudioElement;
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.getAttribute('src')).toContain('/api/settings/voicemail-greeting/audio?v=');
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(screen.getByRole('button', { name: 'Replace greeting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove greeting' })).toBeInTheDocument();
  });

  it("the player's error event renders the missing-file status line", async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    render(<VoicemailGreetingBlock />);
    const audio = await screen.findByLabelText('Voicemail greeting');
    fireEvent.error(audio);
    expect(await screen.findByText("The greeting file is missing or can't be played. Upload it again.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Remove: dialog, Cancel makes no call; Remove calls the endpoint and returns to the empty state', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    removeVoicemailGreeting.mockResolvedValue(undefined);
    render(<VoicemailGreetingBlock />);
    await user.click(await screen.findByRole('button', { name: 'Remove greeting' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove voicemail greeting?' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeVoicemailGreeting).not.toHaveBeenCalled();
    expect(dialog).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove greeting' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Greeting removed.')).toBeInTheDocument();
    expect(screen.getByText('No greeting uploaded - callers hear the built-in prompt.')).toBeInTheDocument();
    expect(removeVoicemailGreeting).toHaveBeenCalledTimes(1);
  });

  it('a forbidden upload renders the admin-only message as an alert', async () => {
    uploadVoicemailGreeting.mockRejectedValue(new ApiError(403, 'forbidden', 'forbidden'));
    render(<VoicemailGreetingBlock />);
    await screen.findByRole('button', { name: 'Upload greeting' });
    await user.upload(screen.getByLabelText('Greeting audio file'), mp3());
    expect(await screen.findByRole('alert')).toHaveTextContent(GREETING_FORBIDDEN_MESSAGE);
  });

  it('a failed Remove keeps the dialog open and shows the error INSIDE it (exactly one alert)', async () => {
    getSettings.mockResolvedValue(wrap({ ...BASE, voicemailGreeting: GREETING }));
    removeVoicemailGreeting.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<VoicemailGreetingBlock />);
    await user.click(await screen.findByRole('button', { name: 'Remove greeting' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove voicemail greeting?' });
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(dialog).toContainElement(alerts[0]!);
    expect(alerts[0]).toHaveTextContent("Couldn't remove the greeting. Try again.");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('sam-greeting.mp3')).toBeInTheDocument();
  });
});
```

In `dashboard/src/routes/settings/VoiceSection.test.tsx`: add `const getSettings = vi.fn();` beside the other mocks, add `getSettings: (...a: unknown[]) => getSettings(...a),` to the `vi.mock('../../api/index.js', ...)` factory, and in `beforeEach` after `vi.clearAllMocks()` add `getSettings.mockResolvedValue({ settings: { missedCallAutoText: 'x', missedCallAutoTextEnabled: true, quickReplies: [], preRingPauseSeconds: 2, quietHoursEnabled: true, quietHoursStart: '21:00', quietHoursEnd: '08:00', timezone: 'America/New_York' }, welcomeTextDefault: 'w' });`. Every existing assertion in that file stays byte-identical.

- [ ] **Step 2: Run to verify they fail**

Run: `cd W:/tmp/voicemail-greeting/dashboard && npx vitest run src/routes/settings/VoicemailGreetingBlock.test.tsx src/routes/settings/VoiceSection.test.tsx`
Expected: the new file FAILS (module missing); VoiceSection's suite passes (mock added, block not yet mounted).

- [ ] **Step 3: The hook**

```ts
// dashboard/src/routes/settings/useVoicemailGreeting.ts
// Owns the voicemail greeting for the Voice tab: one GET of the org settings
// (keeping only `voicemailGreeting`), the raw-body upload with the client-side
// pre-checks that mirror the server's rules, and the remove. A small dedicated
// hook rather than useSettings: that hook's `save` is the Templates JSON PUT
// and the greeting's writes are not a JSON patch.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getSettings,
  removeVoicemailGreeting,
  uploadVoicemailGreeting,
  type VoicemailGreeting,
} from '../../api/index.js';

export const GREETING_MAX_BYTES = 5 * 1024 * 1024;
/** Verbatim the server's message (decision 1). */
export const GREETING_REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
export const GREETING_TOO_LARGE_MESSAGE = 'That file is over 5 MB. Trim or re-export it at a lower bitrate.';
export const GREETING_EMPTY_MESSAGE = 'That file is empty.';
export const GREETING_STORAGE_MESSAGE = "Media storage isn't available right now. Try again in a minute.";
export const GREETING_FORBIDDEN_MESSAGE = 'Only an admin can change the greeting.';
export const GREETING_UPLOAD_FAILED_MESSAGE = "Couldn't upload the greeting. Try again.";
export const GREETING_REMOVE_FAILED_MESSAGE = "Couldn't remove the greeting. Try again.";

/**
 * The canonical audio type to declare for `file`, or undefined when it is not
 * an MP3/WAV. Browsers report `audio/mpeg` / `audio/wav` (Chrome) or aliases
 * (`audio/mp3`, `audio/x-wav`, `audio/wave`, `audio/vnd.wave`); an EMPTY type
 * with a .mp3/.wav name is mapped from the extension so the server, which
 * decides by the header bytes, gets to see it.
 */
export function greetingContentTypeFor(file: File): string | undefined {
  const type = file.type.trim().toLowerCase();
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'audio/mpeg';
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave' || type === 'audio/vnd.wave') return 'audio/wav';
  if (type === '') {
    const name = file.name.toLowerCase();
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    if (name.endsWith('.wav')) return 'audio/wav';
  }
  return undefined;
}

export type GreetingStatus = 'loading' | 'ready' | 'error';

export interface VoicemailGreetingState {
  status: GreetingStatus;
  greeting: VoicemailGreeting | undefined;
  busy: boolean;
  /** A USER-ACTION failure (rendered as an alert). */
  error: string | null;
  /** A success line (rendered as a status). */
  notice: string | null;
  upload: (file: File) => Promise<void>;
  remove: () => Promise<void>;
  retry: () => void;
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'unsupported_media_type':
        return GREETING_REJECT_MESSAGE;
      case 'file_too_large':
        return GREETING_TOO_LARGE_MESSAGE;
      case 'empty_file':
        return GREETING_EMPTY_MESSAGE;
      case 'media_storage_unavailable':
        return GREETING_STORAGE_MESSAGE;
      case 'forbidden':
        return GREETING_FORBIDDEN_MESSAGE;
      default:
        return fallback;
    }
  }
  return fallback;
}

export function useVoicemailGreeting(): VoicemailGreetingState {
  const [status, setStatus] = useState<GreetingStatus>('loading');
  const [greeting, setGreeting] = useState<VoicemailGreeting | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await getSettings(controller.signal);
      if (controller.signal.aborted) return;
      setGreeting(res.settings.voicemailGreeting);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  const upload = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    const contentType = greetingContentTypeFor(file);
    if (contentType === undefined) {
      setError(GREETING_REJECT_MESSAGE);
      return;
    }
    if (file.size === 0) {
      setError(GREETING_EMPTY_MESSAGE);
      return;
    }
    if (file.size > GREETING_MAX_BYTES) {
      setError(GREETING_TOO_LARGE_MESSAGE);
      return;
    }
    const replacing = greeting !== undefined;
    setBusy(true);
    try {
      const next = await uploadVoicemailGreeting(file, contentType);
      setGreeting(next);
      setNotice(replacing ? 'Greeting replaced.' : 'Greeting uploaded.');
    } catch (err) {
      setError(messageFor(err, GREETING_UPLOAD_FAILED_MESSAGE));
    } finally {
      setBusy(false);
    }
  }, [greeting]);

  const remove = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await removeVoicemailGreeting();
      setGreeting(undefined);
      setNotice('Greeting removed.');
    } catch (err) {
      setError(messageFor(err, GREETING_REMOVE_FAILED_MESSAGE));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, greeting, busy, error, notice, upload, remove, retry };
}
```

- [ ] **Step 4: The block**

```tsx
// dashboard/src/routes/settings/VoicemailGreetingBlock.tsx
// Settings > Voice > "Voicemail greeting" (voicemail-greeting spec 4.7). Every
// logged-in user sees the current greeting and can play it; only an admin can
// upload, replace or remove it. Load failures are a STATUS line (never an
// alert - the cell-verification flow above owns the section's alert semantics
// and the perf terminal forbids an alert at load); user-action failures are
// alerts. Mounted OUTSIDE VoiceSection's useMe ternary so a /users/me failure
// never hides the greeting.
import { useId, useRef, useState } from 'react';
import { useOptionalAuth } from '../../app/AuthContext.js';
import { voicemailGreetingAudioUrl } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { useVoicemailGreeting } from './useVoicemailGreeting.js';
import styles from './VoiceSection.module.css';

const ACCEPT = 'audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav';

function fmtUploadedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function VoicemailGreetingBlock(): React.JSX.Element {
  const auth = useOptionalAuth();
  const isAdmin = auth?.isAdmin === true;
  const state = useVoicemailGreeting();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [playerBroken, setPlayerBroken] = useState(false);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be chosen again
    if (!file) return;
    setPlayerBroken(false);
    await state.upload(file);
  }

  async function onConfirmRemove(): Promise<void> {
    try {
      await state.remove();
      setConfirming(false);
      setPlayerBroken(false);
    } catch {
      // the hook surfaced the message; keep the dialog open
    }
  }

  const g = state.greeting;

  return (
    // A plain div on purpose: an aria-labelledby here would give the wrapper the
    // SAME accessible name as the <audio aria-label="Voicemail greeting"> below,
    // and both RTL's getByLabelText and Playwright's getByLabel would then match
    // two elements.
    <div className={styles.greetingBlock}>
      <h3 id={headingId} className={styles.greetingHeading}>
        Voicemail greeting
      </h3>
      <p className={styles.greetingHelp}>
        When a call to the business line isn&apos;t answered, callers hear this greeting before the
        beep. Upload an MP3 or WAV file up to 5 MB. iPhone voice memos are M4A; export or convert the
        recording first. Without a greeting, callers hear the built-in spoken prompt.
        {isAdmin ? null : ' An admin can upload or change it.'}
      </p>

      {state.status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : state.status === 'error' ? (
        <div className={styles.greetingRow}>
          <span role="status" className={styles.greetingStatus}>
            Couldn&apos;t load the voicemail greeting.
          </span>
          <Button variant="secondary" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      ) : g === undefined ? (
        <div className={styles.greetingRow}>
          <span role="status" className={styles.greetingStatus}>
            No greeting uploaded - callers hear the built-in prompt.
          </span>
          {isAdmin ? (
            <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()} disabled={state.busy}>
              {state.busy ? 'Uploading...' : 'Upload greeting'}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={styles.greetingCurrent}>
          <div className={styles.greetingMeta}>
            <span className={styles.greetingName}>{g.fileName}</span>
            <span className={styles.greetingDate}>
              Uploaded {fmtUploadedAt(g.uploadedAt)} by {g.uploadedByEmail}
            </span>
          </div>
          {/* preload="metadata": the browser fetches the header at load, so a
              missing object surfaces (onError) without anyone pressing play. */}
          <audio
            className={styles.greetingPlayer}
            controls
            preload="metadata"
            src={voicemailGreetingAudioUrl(g)}
            aria-label="Voicemail greeting"
            onError={() => setPlayerBroken(true)}
          />
          {playerBroken ? (
            <span role="status" className={styles.greetingStatus}>
              The greeting file is missing or can&apos;t be played. Upload it again.
            </span>
          ) : null}
          {isAdmin ? (
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={state.busy}>
                {state.busy ? 'Uploading...' : 'Replace greeting'}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)} disabled={state.busy}>
                Remove greeting
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {state.notice !== null ? (
        <p role="status" className={styles.greetingNotice}>
          {state.notice}
        </p>
      ) : null}
      {state.error !== null && !confirming ? (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      ) : null}

      {isAdmin ? (
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          aria-label="Greeting audio file"
          className={styles.greetingInput}
          onChange={(e) => void onFileChosen(e)}
        />
      ) : null}

      {confirming ? (
        <Modal
          title="Remove voicemail greeting?"
          onClose={state.busy ? () => {} : () => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={state.busy}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void onConfirmRemove()} disabled={state.busy}>
                {state.busy ? 'Removing...' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className={styles.greetingDialogText}>
            Callers will hear the built-in spoken prompt instead. You can upload a new greeting any
            time.
          </p>
          {/* A failed Remove reports INSIDE the dialog (the ConfirmRemoveDialog
              shape): the block-level alert below sits behind the fixed modal
              backdrop and outside the aria-modal scope, where nobody sees it. */}
          {state.error !== null ? (
            <p role="alert" className={styles.error}>
              {state.error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
```

The file input is visually hidden but must stay in the accessibility tree and drivable by `setInputFiles` / `userEvent.upload` (NOT `hidden` and NOT `display: none`): use the `.greetingInput` class below.

Append to `VoiceSection.module.css`:

```css
/* --- Voicemail greeting block (voicemail-greeting spec 4.7) --- */
.greetingBlock {
  margin-top: var(--sp-6, 24px);
  padding-top: var(--sp-4, 16px);
  border-top: 1px solid var(--c-border, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3, 12px);
  min-width: 0;
}
.greetingHeading {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold, 600);
}
.greetingHelp {
  margin: 0;
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
}
.greetingRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3, 12px);
}
.greetingStatus {
  font-size: var(--fs-sm);
}
.greetingNotice {
  margin: 0;
  color: var(--c-success);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
}
.greetingCurrent {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2, 8px);
  min-width: 0;
}
.greetingMeta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.greetingName {
  font-weight: var(--fw-medium);
  overflow-wrap: anywhere;
}
.greetingDate {
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}
.greetingPlayer {
  width: 100%;
  max-width: 480px;
}
.greetingInput {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.greetingDialogText {
  margin: 0;
}
```

If `VoiceSection.module.css` uses different token names for muted text / border / spacing, read the top of the file and `dashboard/src/index.css` and use the tokens the file already uses; the fallbacks in `var(--x, y)` keep it rendering either way.

Mount in `VoiceSection.tsx`: import `{ VoicemailGreetingBlock } from './VoicemailGreetingBlock.js';` and render `<VoicemailGreetingBlock />` as the LAST child of the `<section>` (after the closing of the `status === 'loading' ? ... : ...` ternary, outside it).

- [ ] **Step 5: Run to verify they pass**

Run: `cd W:/tmp/voicemail-greeting/dashboard && npx vitest run src/routes/settings && cd .. && npm run typecheck && npx eslint dashboard/src/routes/settings/useVoicemailGreeting.ts dashboard/src/routes/settings/VoicemailGreetingBlock.tsx dashboard/src/routes/settings/VoicemailGreetingBlock.test.tsx dashboard/src/routes/settings/VoiceSection.tsx dashboard/src/routes/settings/VoiceSection.test.tsx`
Expected: PASS (every pre-existing settings suite included); typecheck 0; no new lint errors.

- [ ] **Step 6: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add dashboard/src/routes/settings/useVoicemailGreeting.ts dashboard/src/routes/settings/VoicemailGreetingBlock.tsx dashboard/src/routes/settings/VoicemailGreetingBlock.test.tsx dashboard/src/routes/settings/VoiceSection.tsx dashboard/src/routes/settings/VoiceSection.test.tsx dashboard/src/routes/settings/VoiceSection.module.css && git commit -m "feat(voicemail-greeting): Settings > Voice greeting block - upload/replace/remove with confirmation, in-page player, VA read-only

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 9: Playwright end-to-end spec (hermetic lane)

**Files:**
- Create: `e2e/tests/dashboard-next/voicemail-greeting.spec.ts`

**Interfaces:**
- Consumes: Task 8 accessible names; Task 6 `call.voicemailGreeting` / `call.voicemailGreetingFetchStatus` on `listCalls`; fixtures `placeCall`, `listCalls` (`e2e/fixtures/fakeVoice.ts`), `uniqueVoicePhone`, `NEXT` (`e2e/fixtures/voiceSetup.ts`), `reseed` (`e2e/fixtures/reseed.ts`), `expectTodayReady` (`e2e/support/today.ts`), `NARROW_360`, `WIDE_RESTORE`, `expectNoHorizontalOverflow`, `expectNoHorizontalOverflowIn` (`e2e/support/viewport.ts`).

- [ ] **Step 1: Write the spec**

```ts
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

async function openVoiceTab(page: Page): Promise<void> {
  await page.goto(`${NEXT}/settings/voice`);
  await expect(page.getByRole('heading', { name: 'Voicemail greeting', level: 3 })).toBeVisible();
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
  await expect(page.getByText('No greeting uploaded - callers hear the built-in prompt.')).toBeVisible();

  // (1) upload + listed + served
  await uploadWav(page);
  await expect(page.getByText('sam-greeting.wav')).toBeVisible();
  const audio = page.getByLabel('Voicemail greeting');
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
  await expect(page.getByText('No greeting uploaded - callers hear the built-in prompt.')).toBeVisible();
  expect((await page.request.get(`${NEXT}${src}`)).status()).toBe(404);

  const second = await placeCall(page.request, { from: uniqueVoicePhone(), to: BUSINESS, scenario: { digit: null, voicemail: { durationSec: 3 } } });
  const spoken = await greetingVerbOf(page, second);
  expect(spoken.verb).toBe('say');
  expect(spoken.fetchStatus).toBeUndefined();
});

test('the reject path in the real UI: an M4A shows the given message and nothing is listed', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  await openVoiceTab(page);
  await page.getByLabel('Greeting audio file').setInputFiles({ name: 'memo.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('\u0000\u0000\u0000\u0018ftypM4A ', 'latin1') });
  await expect(page.getByRole('alert')).toHaveText('Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.');
  await expect(page.getByText('No greeting uploaded - callers hear the built-in prompt.')).toBeVisible();
  // A renamed M4A the browser calls audio/mpeg passes the client pre-check and
  // is refused by the SERVER's sniff with the same message. The alert text is
  // identical to the client-side one above, so the proof is the PUT's 400
  // response, awaited explicitly, and the alert re-appearing after it (the
  // hook clears the previous error when a new file is chosen). 200 KB stays
  // under the Vite dev proxy's `Connection: close` window (spec 4.3).
  const refusal = page.waitForResponse((r) => r.url().includes('/api/settings/voicemail-greeting') && r.request().method() === 'PUT');
  await page.getByLabel('Greeting audio file').setInputFiles({ name: 'memo.mp3', mimeType: 'audio/mpeg', buffer: Buffer.concat([Buffer.from('\u0000\u0000\u0000\u0018ftypM4A ', 'latin1'), Buffer.alloc(200_000, 0)]) });
  const res = await refusal;
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe('unsupported_media_type');
  await expect(page.getByRole('alert')).toHaveText('Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.');
  await expect(page.getByText('No greeting uploaded - callers hear the built-in prompt.')).toBeVisible();
});

test('phone width: the block and the Remove dialog fit without sideways scroll', async ({ page }) => {
  await devLoginAs(page, 'founder@example.com');
  await page.setViewportSize(NARROW_360);
  try {
    await openVoiceTab(page);
    await uploadWav(page, 'a-rather-long-greeting-file-name-that-should-wrap-not-scroll.wav');
    await expectNoHorizontalOverflow(page, '/settings/voice with a greeting');
    await expect(page.getByLabel('Voicemail greeting')).toBeVisible();
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
  await expect(page.getByRole('alert')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it against a live session lane**

From the worktree: `cd W:/tmp/voicemail-greeting && npm run e2e:session` (background, per the orchestrator's WAITING rule), then the SANCTIONED single-spec entry point (AGENTS.md: Playwright only through the e2e workspace; `e2e/README.md` documents this form): `cd W:/tmp/voicemail-greeting && npm run e2e -- tests/dashboard-next/voicemail-greeting.spec.ts` (the config reuses the live session lane). Expected: 4 passed. If `placeCall` completes but `voicemailGreeting` stays undefined, the fake-twilio build in the lane predates Task 6 - `npm run e2e:restart`. Also re-run the neighbors this feature touches the same way: `npm run e2e -- tests/dashboard-next/voice-outbound.spec.ts tests/dashboard-next/voice-transcription.spec.ts tests/dashboard-next/settings.spec.ts tests/dashboard-next/call-inbox-unread.spec.ts`. Stop the session (`npm run e2e:stop`) before the full gate.

- [ ] **Step 3: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add e2e/tests/dashboard-next/voicemail-greeting.spec.ts && git commit -m "test(e2e): voicemail greeting - upload/serve, <Play> before <Record> via fake-twilio, remove restores <Say>, phone width, reject path, VA read-only

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

---

### Task 10: Issue filing, docs, and the gate run

**Files:**
- Create: `docs/issues/voicemail-greeting-format-normalization.md`
- Modify: `documentation/GLOSSARY.md` ONLY if it has a settings/voice vocabulary section (add "voicemail greeting" = the recorded audio an admin uploads; otherwise leave it - no new domain noun was introduced)
- Run: `npm run issues` (regenerates the gitignored index; nothing to commit from it)

- [ ] **Step 1: File the issue**

```markdown
---
id: voicemail-greeting-format-normalization
title: Voicemail greeting - no transcoding; Twilio behavior on an unplayable <Play> file is unverified
type: improvement
severity: low
status: open
area: app/voice
created: 2026-09-26
refs: app/src/routes/webhooks/voice.ts, app/src/lib/voicemailGreeting.ts, docs/superpowers/specs/2026-09-26-voicemail-greeting-design.md
---

**Problem.** The recorded voicemail greeting (spec 2026-09-26) accepts MP3 and
WAV by content type and header sniff, and plays the stored bytes as-is via
`<Play>`. Two gaps are accepted and recorded here:

1. No normalization or transcoding. A WAV encoding Twilio cannot decode (for
   example 32-bit float, or an unusual sample rate) passes the sniff and is
   stored. Twilio's documented `<Play>` support is MP3 and PCM/u-law WAV; the
   sniff cannot tell a playable WAV from an unplayable one.
2. UNVERIFIED: what Twilio does when a `<Play>` URL cannot be fetched or
   decoded at call time (skip to the next verb and record, or end the call).
   The app-side fallback (spec 4.6) covers lookup-time failures only: a
   greeting that exists but cannot be played, or one removed between the
   webhook's HEAD and Twilio's fetch, is outside it.

**Suggested fix.** Settle (2) with the dev check in the spec's section 7
(upload a 32-bit float WAV, call, do not answer, note what the caller hears
and what the Twilio debugger logs) and record the answer here. If Twilio
ends the call on a bad `<Play>`, the cheapest closure is a server-side
probe at upload time (decode the header's format/bit-depth fields for WAV and
refuse what Twilio does not list); a full transcode step (ffmpeg or a WASM
decoder) is a dependency decision and out of scope until the check says it
is needed.
```

Then `cd W:/tmp/voicemail-greeting && npm run issues` (do not commit `docs/issues/INDEX.md`; it is gitignored).

- [ ] **Step 2: Commit**

```bash
cd W:/tmp/voicemail-greeting && git status && git add docs/issues/voicemail-greeting-format-normalization.md && git commit -m "docs(issues): voicemail-greeting-format-normalization - no transcoding; Twilio unplayable-<Play> behavior to verify on dev

Co-Authored-By: <AUTHORING MODEL> <noreply@anthropic.com>"
```

- [ ] **Step 3: The handback carries these (write them into `.superpowers/sdd/handback.md` AND the tracked `docs/superpowers/reviews/2026-09-26-voicemail-greeting/handback.md`)**

1. The plain-text restatement of the mission and, under "Questions I would have stopped for", spec section 3 assumptions A-H verbatim with the reading taken for each.
2. Infra-side facts (spec 4.10): prior greeting versions persist on the versioned media bucket (a lifecycle rule would be the infra change); whether CloudFront's 30 s `origin_read_timeout` can fire during a slow 5 MB upload is UNVERIFIED.
3. The local-dev-only limitation (spec 4.3): through the Vite dev proxy a SERVER refusal of a body of roughly 3 MB or more resets before the JSON arrives; production is CloudFront -> origin and expected unaffected (UNVERIFIED).
4. The unbounded-drain acceptance (spec 4.3): a non-browser client streaming more than 5 MiB chunked is drained; admin-only + 10/min.
5. The dev verification script from spec section 7, including the optional unplayable-WAV check that settles `docs/issues/voicemail-greeting-format-normalization.md`.
6. Every issue filed, the gate outputs quoted per the orchestrator's handback format, and `MERGE-READY @<hash>` / `UNMERGED (human gate)`.

- [ ] **Step 4: The five gates (orchestrator phase; listed here so the plan is complete)**

From `W:/tmp/voicemail-greeting`, bare, real exit codes, output redirected to files under `.superpowers/` and grepped AFTER:

1. `npm run typecheck`
2. `npm test` (needs DynamoDB Local: `npm run db:start`; if a DynamoDB suite is red, re-run that FILE alone and at the merge base before blaming the branch - AGENTS.md)
3. `npm run smoke`
4. `timeout 1500 npm run e2e` (never with an interactive session live in the same worktree; confirm no listener survives on the lane's ports after any aborted run)
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` - attribute any error by BASELINE comparison at the merge base; only errors absent there are yours.

Then ONE `git merge main` (if main advanced), re-run all five, and hand back with the outputs quoted.

---

## Self-review (planner)

- Spec coverage: 4.1 -> T1; 4.2 -> T2; 4.3/4.4/4.5 -> T4 (+T3 helper); 4.6 -> T5; 4.7 -> T7+T8; 4.8 -> T6; 4.9 writers/readers -> T2 (parsePatch pin, harness fake), T5 (webhook), T4 (audio), T8 (block), gate-2 rows -> T7 (catalog, routes contract), T8 (VoiceSection tests), T9 (viewport helpers); 4.10 -> T4/T5 log posture (tests pin no file name, no URL); section 5 unit/route/webhook/fake/dashboard/e2e -> T1-T9; section 6 issue -> T10; assumptions A-H are carried by T4 (admin gate, uploader fields), T8 (VA read-only, Remove-only confirmation), T5 (no log when unset).
- Placeholder scan: the only `// ...` lines are in T5 (f)/(e) and T6 tests, each with an explicit instruction naming the exact existing helper/drive to copy; no TBD/TODO.
- Type consistency: `VoicemailGreeting` fields identical in T2 (app), T7 (dashboard mirror), T4/T5/T8/T9 fixtures; `head(key, { signal })` in T4 (adapter + fake) and T5 (caller); `withTimeout(promise, ms, label)` in T1 and T5; `greeting: 'play'|'say'|'none'` in T6 and T9; endpoint names `uploadVoicemailGreeting` / `removeVoicemailGreeting` / `voicemailGreetingAudioUrl` in T7 and T8; catalog symbol names match T7's exports.
- Review Focus: each of the five lines names its owning task and test above.
