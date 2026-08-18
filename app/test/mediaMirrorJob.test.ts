// media.mirror - the DEFERRED tail of the inbound-media mirror (prod incident
// 2026-08-17/18). The webhook's inline tries cover the ~140ms "media not
// served yet" beat; this job covers a provider that stays slow for longer,
// with a schedule of minutes rather than a webhook's seconds: +5s, +15s, +45s,
// +2min, then an ERROR that names the message. It re-mirrors ONLY the
// attachments still missing, appends what lands to the message's stored
// attachments, and hands the rest to the next attempt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { MediaFetchHttpError, MediaFetchRefusedError } from '../src/adapters/messaging.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { _resetForTests, dispatchJob, registeredJobNames } from '../src/jobs/jobs.js';
import {
  MAX_MEDIA_MIRROR_ATTEMPTS,
  MEDIA_MIRROR_JOB,
  mediaMirrorBackoffMs,
  parseMediaMirrorPayload,
  registerMediaMirrorJobHandler,
  type MediaMirrorPayload,
} from '../src/jobs/mediaMirror.js';

const PAYLOAD: MediaMirrorPayload = {
  conversationId: 'conv-1',
  tsMsgId: '2026-08-18T00:21:14.000Z#MM1',
  messageSid: 'MM1',
  media: [
    { index: 0, url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' },
    { index: 1, url: 'https://api.twilio.com/m/1', contentType: 'image/png' },
  ],
  attempt: 1,
};

function harness(opts: {
  fetchOutcome: (url: string, call: number) => Readable | Error;
  existing?: MessageItem['media_attachments'];
} ) {
  let calls = 0;
  const adapter = {
    async getMediaStream(url: string) {
      calls += 1;
      const r = opts.fetchOutcome(url, calls);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const puts: string[] = [];
  const mediaStore = { async put(key: string) { puts.push(key); } };
  const annotated: unknown[] = [];
  const messagesRepo = {
    async getByTsMsgId() {
      return {
        conversationId: 'conv-1',
        tsMsgId: PAYLOAD.tsMsgId,
        ...(opts.existing !== undefined && { media_attachments: opts.existing }),
      } as MessageItem;
    },
    async annotateMessage(_c: string, _t: string, a: unknown) {
      annotated.push(a);
    },
  };
  const enqueued: { payload: MediaMirrorPayload; runAt?: Date }[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  registerMediaMirrorJobHandler({
    messagingAdapter: adapter as never,
    mediaStore: mediaStore as never,
    messagesRepo: messagesRepo as never,
    logger: log as never,
    sleep: async () => {},
    enqueueMirror: async (payload, runAt) => {
      enqueued.push({ payload, runAt });
    },
    now: () => new Date('2026-08-18T00:21:20.000Z'),
  });
  return { calls: () => calls, puts, annotated, enqueued, log };
}

async function run(payload: MediaMirrorPayload) {
  await dispatchJob({
    jobId: `job-${Math.random()}`,
    jobName: MEDIA_MIRROR_JOB,
    payload,
    correlationId: 'corr-1',
    hopCount: 1,
    enqueuedAt: new Date().toISOString(),
  } as never);
}

describe('media.mirror job', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('registers under its name and validates its payload', () => {
    harness({ fetchOutcome: () => Readable.from([]) });
    expect(registeredJobNames()).toContain(MEDIA_MIRROR_JOB);
    expect(() => parseMediaMirrorPayload({})).toThrow(/conversationId/);
    expect(() => parseMediaMirrorPayload({ ...PAYLOAD, media: [] })).toThrow(/media/);
    expect(() => parseMediaMirrorPayload({ ...PAYLOAD, attempt: 0 })).toThrow(/attempt/);
    expect(() =>
      parseMediaMirrorPayload({ ...PAYLOAD, attempt: MAX_MEDIA_MIRROR_ATTEMPTS + 1 }),
    ).toThrow(/attempt/);
    expect(parseMediaMirrorPayload(PAYLOAD)).toEqual(PAYLOAD);
  });

  it('the schedule is a LONG tail: 5s, 15s, 45s, 2min', () => {
    expect([1, 2, 3, 4].map(mediaMirrorBackoffMs)).toEqual([5_000, 15_000, 45_000, 120_000]);
    expect(MAX_MEDIA_MIRROR_ATTEMPTS).toBe(4);
  });

  it('mirrors the missing attachments and APPENDS them to what the webhook already stored', async () => {
    const h = harness({
      fetchOutcome: () => Readable.from([Buffer.from('b')]),
      existing: [{ s3Key: 'media/conv-1/MM1/9', contentType: 'image/gif' }],
    });
    await run({ ...PAYLOAD, media: [PAYLOAD.media[1]!] });
    expect(h.puts).toEqual(['media/conv-1/MM1/1']);
    expect(h.annotated).toEqual([
      {
        mediaAttachments: [
          { s3Key: 'media/conv-1/MM1/9', contentType: 'image/gif' },
          { s3Key: 'media/conv-1/MM1/1', contentType: 'image/png' },
        ],
      },
    ]);
    expect(h.enqueued).toEqual([]);
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('a redelivered job does not store the same attachment twice', async () => {
    const h = harness({
      fetchOutcome: () => Readable.from([Buffer.from('b')]),
      existing: [{ s3Key: 'media/conv-1/MM1/0', contentType: 'image/jpeg' }],
    });
    await run({ ...PAYLOAD, media: [PAYLOAD.media[0]!] });
    expect(h.annotated).toEqual([
      { mediaAttachments: [{ s3Key: 'media/conv-1/MM1/0', contentType: 'image/jpeg' }] },
    ]);
  });

  it('a STILL-transient failure re-enqueues ONLY the failed media on the next rung, at WARN', async () => {
    const h = harness({
      fetchOutcome: (url) => (url.endsWith('/0') ? new MediaFetchHttpError('404', 404) : Readable.from([Buffer.from('b')])),
    });
    await run(PAYLOAD);
    // Index 1 landed and was recorded...
    expect(h.annotated).toEqual([
      { mediaAttachments: [{ s3Key: 'media/conv-1/MM1/1', contentType: 'image/png' }] },
    ]);
    // ...index 0 goes to attempt 2, 15s out.
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.payload).toEqual({ ...PAYLOAD, media: [PAYLOAD.media[0]!], attempt: 2 });
    expect(h.enqueued[0]!.runAt?.toISOString()).toBe('2026-08-18T00:21:35.000Z');
    expect(h.log.warn).toHaveBeenCalled();
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('the LAST attempt that still fails is the ERROR - one, naming the message, no re-enqueue', async () => {
    const h = harness({ fetchOutcome: () => new MediaFetchHttpError('404', 404) });
    await run({ ...PAYLOAD, media: [PAYLOAD.media[0]!], attempt: MAX_MEDIA_MIRROR_ATTEMPTS });
    expect(h.enqueued).toEqual([]);
    expect(h.annotated).toEqual([]);
    expect(h.log.error).toHaveBeenCalledTimes(1);
    const [fields, line] = h.log.error.mock.calls[0]! as [Record<string, unknown>, string];
    expect(fields['providerSid']).toBe('MM1');
    expect(fields['event']).toBe('media_mirror_exhausted');
    expect(line).toMatch(/keeps the provider URL/);
  });

  it('a PERMANENT refusal is an ERROR now and is dropped from the retry set', async () => {
    const h = harness({
      fetchOutcome: (url) =>
        url.endsWith('/0') ? new MediaFetchRefusedError('too big', 'too_large') : new MediaFetchHttpError('503', 503),
    });
    await run(PAYLOAD);
    // Index 0 is permanent -> ERROR, not retried; index 1 is transient -> next rung.
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.payload.media).toEqual([PAYLOAD.media[1]!]);
  });
});
