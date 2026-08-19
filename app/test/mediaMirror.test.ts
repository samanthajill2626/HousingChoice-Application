// The inbound-media mirror, with its retry policy (prod incident 2026-08-17/18).
//
// Twilio serves an inbound MMS's media a beat AFTER it fires the message
// webhook: 2 of 6 inbound MMS in one prod day 404'd ~140ms after the webhook
// and both had their media present on re-read minutes later. The webhook used
// to try ONCE, log ERROR, and keep the provider URL - which the dashboard never
// renders - so the photo was lost from the thread for good. The mirror now
// retries a transient fetch failure a few times INLINE (fast, inside Twilio's
// 15s webhook window) and hands anything still failing to the media.mirror job
// with a longer tail (see mediaMirrorJob.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { MediaFetchHttpError, MediaFetchRefusedError } from '../src/adapters/messaging.js';
import {
  INLINE_MIRROR_DELAYS_MS,
  isRetryableMediaFetchError,
  mirrorMediaSet,
} from '../src/services/mediaMirror.js';

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/** A getMediaStream that fails `failures` times with `err`, then streams. */
function flakyAdapter(failures: number, err: () => Error) {
  let calls = 0;
  const urls: string[] = [];
  return {
    calls: () => calls,
    urls,
    adapter: {
      async getMediaStream(url: string) {
        calls += 1;
        urls.push(url);
        if (calls <= failures) throw err();
        return Readable.from([Buffer.from('bytes')]);
      },
    },
  };
}

function storeSpy() {
  const puts: { key: string; contentType: string }[] = [];
  return {
    puts,
    mediaStore: {
      async put(key: string, _stream: Readable, contentType: string) {
        puts.push({ key, contentType });
      },
    },
  };
}

const TARGETS = [
  { index: 0, url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' },
  { index: 1, url: 'https://api.twilio.com/m/1', contentType: 'image/png' },
];

describe('isRetryableMediaFetchError', () => {
  it('a 404 (media not served yet), 408/425/429 and any 5xx are transient', () => {
    for (const status of [404, 408, 425, 429, 500, 502, 503]) {
      expect(isRetryableMediaFetchError(new MediaFetchHttpError('x', status))).toBe(true);
    }
  });
  it('other 4xx and the SSRF/size refusals are permanent', () => {
    for (const status of [400, 401, 403, 410, 415]) {
      expect(isRetryableMediaFetchError(new MediaFetchHttpError('x', status))).toBe(false);
    }
    expect(isRetryableMediaFetchError(new MediaFetchRefusedError('x', 'too_large'))).toBe(false);
    expect(isRetryableMediaFetchError(new MediaFetchRefusedError('x', 'host_not_allowed'))).toBe(false);
  });
  it('a network-level failure (fetch threw) is transient', () => {
    expect(isRetryableMediaFetchError(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('mirrorMediaSet', () => {
  it('mirrors every target once when the fetch succeeds first time', async () => {
    const f = flakyAdapter(0, () => new Error('never'));
    const s = storeSpy();
    const out = await mirrorMediaSet(
      { adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async () => {} },
      { conversationId: 'conv-1', messageSid: 'MM1', targets: TARGETS, delaysMs: INLINE_MIRROR_DELAYS_MS },
    );
    expect(out.attachments).toEqual([
      { index: 0, attachment: { s3Key: 'media/conv-1/MM1/0', contentType: 'image/jpeg' } },
      { index: 1, attachment: { s3Key: 'media/conv-1/MM1/1', contentType: 'image/png' } },
    ]);
    expect(out.failed).toEqual([]);
    expect(f.calls()).toBe(2);
    expect(s.puts.map((p) => p.key)).toEqual(['media/conv-1/MM1/0', 'media/conv-1/MM1/1']);
  });

  it('a 404 on the first try is RETRIED after a delay and the media lands - the prod race', async () => {
    const f = flakyAdapter(1, () => new MediaFetchHttpError('404 Not Found', 404));
    const s = storeSpy();
    const slept: number[] = [];
    const out = await mirrorMediaSet(
      { adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async (ms) => { slept.push(ms); } },
      { conversationId: 'conv-1', messageSid: 'MM1', targets: [TARGETS[0]!], delaysMs: [400, 800] },
    );
    expect(out.attachments).toHaveLength(1);
    expect(out.failed).toEqual([]);
    expect(f.calls()).toBe(2);
    expect(slept).toEqual([400]);
  });

  it('exhausting the inline delays reports the target as FAILED and RETRYABLE - the job takes it', async () => {
    const f = flakyAdapter(99, () => new MediaFetchHttpError('404 Not Found', 404));
    const s = storeSpy();
    const slept: number[] = [];
    const out = await mirrorMediaSet(
      { adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async (ms) => { slept.push(ms); } },
      { conversationId: 'conv-1', messageSid: 'MM1', targets: [TARGETS[0]!], delaysMs: [400, 800] },
    );
    expect(out.attachments).toEqual([]);
    expect(out.failed).toEqual([{ index: 0, retryable: true }]);
    // delays.length + 1 tries; every delay slept exactly once, in order.
    expect(f.calls()).toBe(3);
    expect(slept).toEqual([400, 800]);
    expect(s.puts).toEqual([]);
  });

  it('a PERMANENT refusal is not retried and is reported non-retryable', async () => {
    const f = flakyAdapter(99, () => new MediaFetchRefusedError('too big', 'too_large'));
    const s = storeSpy();
    const out = await mirrorMediaSet(
      { adapter: f.adapter, mediaStore: s.mediaStore, logger: silent, sleep: async () => {} },
      { conversationId: 'conv-1', messageSid: 'MM1', targets: [TARGETS[0]!], delaysMs: [400, 800] },
    );
    expect(out.failed).toEqual([{ index: 0, retryable: false }]);
    expect(f.calls()).toBe(1);
  });

  it('one bad target does not stop the others - each target has its own retries', async () => {
    let calls = 0;
    const adapter = {
      async getMediaStream(url: string) {
        calls += 1;
        if (url.endsWith('/0')) throw new MediaFetchHttpError('404', 404);
        return Readable.from([Buffer.from('bytes')]);
      },
    };
    const s = storeSpy();
    const out = await mirrorMediaSet(
      { adapter, mediaStore: s.mediaStore, logger: silent, sleep: async () => {} },
      { conversationId: 'conv-1', messageSid: 'MM1', targets: TARGETS, delaysMs: [1] },
    );
    expect(out.attachments.map((a) => a.index)).toEqual([1]);
    expect(out.failed).toEqual([{ index: 0, retryable: true }]);
    expect(calls).toBe(3); // 2 tries for target 0, 1 for target 1
  });

  it('a failed S3 put destroys the source stream and counts as retryable', async () => {
    const stream = Readable.from([Buffer.from('bytes')]);
    const adapter = { async getMediaStream() { return stream; } };
    const mediaStore = { async put() { throw new Error('S3 503'); } };
    const out = await mirrorMediaSet(
      { adapter, mediaStore, logger: silent, sleep: async () => {} },
      { conversationId: 'conv-1', messageSid: 'MM1', targets: [TARGETS[0]!], delaysMs: [] },
    );
    expect(out.failed).toEqual([{ index: 0, retryable: true }]);
    expect(stream.destroyed).toBe(true);
  });
});
