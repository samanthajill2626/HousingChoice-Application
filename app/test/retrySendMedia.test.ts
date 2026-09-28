// retry-send-adoption R1: the retry's media plan. The claim records
// `mediaCount` - the length of the media list the retry WILL SEND - before the
// presign runs, so the plan is decided synchronously from the retried row and
// whether a MediaStore exists. Deviation 9: the adoption reads the recorded
// answer back instead of re-running the plan.
//
// The four shapes are the job's media rule as built (retrySend.ts): durable
// attachments are re-presigned FRESH when a store exists and DROPPED (body
// only) when none does - a stored presigned URL is never replayed; a row with
// no attachments replays its raw mediaUrls (the internal/e2e seam); else no
// media.
import { describe, expect, it } from 'vitest';
import {
  MAX_SEND_RETRY_ATTEMPTS as JOB_MAX_SEND_RETRY_ATTEMPTS,
  planRetryMedia,
} from '../src/jobs/retrySend.js';
import { MAX_SEND_RETRY_ATTEMPTS } from '../src/lib/retrySendWindow.js';
import type { MediaAttachment, MessageItem } from '../src/repos/messagesRepo.js';

const TS = '2026-09-27T12:00:00.000Z';

function row(fields: Partial<MessageItem> = {}): MessageItem {
  return {
    conversationId: 'conv-media',
    tsMsgId: `${TS}#SMorig`,
    type: 'mms',
    direction: 'outbound',
    author: 'teammate',
    body: 'the flyer',
    provider_sid: 'SMorig',
    provider_ts: TS,
    delivery_status: 'undelivered',
    error_code: '30003',
    created_at: TS,
    ...fields,
  };
}

const ATTACHMENTS: MediaAttachment[] = [
  { s3Key: 'unit-media/a.jpg', contentType: 'image/jpeg' },
  { s3Key: 'unit-media/b.pdf', contentType: 'application/pdf', filename: 'lease.pdf' },
];
const STALE_URLS = ['https://bucket.example/a.jpg?X-Amz-Signature=stale', 'https://bucket.example/b.pdf?X-Amz-Signature=stale'];

describe('planRetryMedia (retry-send-adoption R1)', () => {
  it('attachments with a store: re-presign them - the count is the attachments', () => {
    expect(planRetryMedia(row({ media_attachments: ATTACHMENTS, mediaUrls: STALE_URLS }), true)).toStrictEqual({
      attachments: ATTACHMENTS,
      mediaCount: 2,
      droppedAttachments: false,
    });
  });

  it('attachments with NO store: body only - the stored presigned URLs are never replayed, the count is 0', () => {
    expect(planRetryMedia(row({ media_attachments: ATTACHMENTS, mediaUrls: STALE_URLS }), false)).toStrictEqual({
      mediaCount: 0,
      droppedAttachments: true,
    });
  });

  it('no attachments and raw mediaUrls: replay the raw list (the internal/e2e seam), whatever the store', () => {
    const urls = ['https://media.example/raw-1.jpg'];
    for (const hasStore of [true, false]) {
      expect(planRetryMedia(row({ mediaUrls: urls }), hasStore)).toStrictEqual({
        rawMediaUrls: urls,
        mediaCount: 1,
        droppedAttachments: false,
      });
    }
  });

  it('neither: no media, whatever the store', () => {
    for (const hasStore of [true, false]) {
      expect(planRetryMedia(row({ type: 'sms' }), hasStore)).toStrictEqual({ mediaCount: 0, droppedAttachments: false });
    }
  });

  it('reads attachments through mediaAttachmentsOf: legacy media_s3_keys count as attachments', () => {
    expect(planRetryMedia(row({ media_s3_keys: ['legacy/one.jpg'] }), true)).toStrictEqual({
      attachments: [{ s3Key: 'legacy/one.jpg', contentType: 'application/octet-stream' }],
      mediaCount: 1,
      droppedAttachments: false,
    });
  });

  it('an EMPTY raw list is carried as stored (the job replays it as is): count 0, nothing dropped', () => {
    expect(planRetryMedia(row({ mediaUrls: [] }), true)).toStrictEqual({
      rawMediaUrls: [],
      mediaCount: 0,
      droppedAttachments: false,
    });
  });
});

describe('MAX_SEND_RETRY_ATTEMPTS moved to the leaf (retry-send-adoption)', () => {
  it('jobs/retrySend.ts re-exports the SAME value the leaf owns', () => {
    expect(JOB_MAX_SEND_RETRY_ATTEMPTS).toBe(MAX_SEND_RETRY_ATTEMPTS);
    expect(JOB_MAX_SEND_RETRY_ATTEMPTS).toBe(3);
  });
});
