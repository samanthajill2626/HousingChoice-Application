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
  it('exposes no byteLength, length, size, start+end or path that lib-storage would read as the body length', async () => {
    // mediaStore.put hands the gate to lib-storage as the Body, and lib-storage
    // takes the first numeric byteLength / length / size (or start+end, or a
    // file path) it finds on a Body as the upload's total size. The gate's
    // size is unknown until the stream ends, so it must expose none of them -
    // before or after bytes flow. Its counter is named `bytesSeen` for this.
    const gate = new GreetingUploadGate({ format: 'mp3', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
    const expectNoLengthShape = (): void => {
      const body = gate as unknown as Record<string, unknown>;
      expect(typeof body['byteLength']).not.toBe('number');
      expect(typeof body['length']).not.toBe('number');
      expect(typeof body['size']).not.toBe('number');
      expect(typeof body['start'] === 'number' && typeof body['end'] === 'number').toBe(false);
      expect(typeof body['path']).not.toBe('string');
    };
    expectNoLengthShape();
    await drain(gate, [minimalMp3()]);
    expectNoLengthShape();
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
