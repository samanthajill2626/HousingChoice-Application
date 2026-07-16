import { describe, it, expect, vi } from 'vitest';
import { createPresignedPost as sdkCreatePresignedPost } from '@aws-sdk/s3-presigned-post';
import { S3MediaStore } from '../src/adapters/mediaStore.js';
import { OUTBOUND_MMS_MAX_FILE_BYTES, MMS_UPLOAD_SOURCE_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';

// createPresignedPost delegates to the module fn from @aws-sdk/s3-presigned-post;
// assert the content-length-range condition uses the requested max (default vs
// explicit) via the mock's recorded call params (the store returns url+fields
// only, so the policy is observable ONLY through the SDK call).
vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: vi.fn(async () => ({ url: 'u', fields: {} })),
}));

function lastConditions(): unknown[] {
  const call = vi.mocked(sdkCreatePresignedPost).mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call![1] as { Conditions?: unknown[] }).Conditions ?? [];
}

describe('createPresignedPost maxBytes', () => {
  it('defaults to the 5MB per-file cap when omitted', async () => {
    const store = new S3MediaStore('b', {} as never);
    await store.createPresignedPost('k', { contentType: 'image/jpeg' });
    expect(lastConditions()).toContainEqual(['content-length-range', 1, OUTBOUND_MMS_MAX_FILE_BYTES]);
  });
  it('honors an explicit larger maxBytes (MMS source cap)', async () => {
    const store = new S3MediaStore('b', {} as never);
    await store.createPresignedPost('k', { contentType: 'image/webp', maxBytes: MMS_UPLOAD_SOURCE_MAX_BYTES });
    expect(lastConditions()).toContainEqual(['content-length-range', 1, MMS_UPLOAD_SOURCE_MAX_BYTES]);
  });
});
