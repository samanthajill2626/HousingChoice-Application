// Unit tests for the media-attachment compat helper: prefers the cohesive
// media_attachments record, folds legacy media_s3_keys into it as octet-stream.
import { describe, expect, it } from 'vitest';
import { mediaAttachmentsOf } from '../src/repos/messagesRepo.js';

describe('mediaAttachmentsOf', () => {
  it('returns media_attachments when present', () => {
    expect(
      mediaAttachmentsOf({ media_attachments: [{ s3Key: 'k', contentType: 'image/png' }] }),
    ).toEqual([{ s3Key: 'k', contentType: 'image/png' }]);
  });

  it('prefers media_attachments even when legacy keys also exist', () => {
    expect(
      mediaAttachmentsOf({
        media_attachments: [{ s3Key: 'new', contentType: 'application/pdf' }],
        media_s3_keys: ['old'],
      }),
    ).toEqual([{ s3Key: 'new', contentType: 'application/pdf' }]);
  });

  it('falls back to legacy media_s3_keys as octet-stream', () => {
    expect(mediaAttachmentsOf({ media_s3_keys: ['k0', 'k1'] })).toEqual([
      { s3Key: 'k0', contentType: 'application/octet-stream' },
      { s3Key: 'k1', contentType: 'application/octet-stream' },
    ]);
  });

  it('returns [] when neither field is present', () => {
    expect(mediaAttachmentsOf({})).toEqual([]);
  });
});
