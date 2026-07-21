// Email attachment presign + confirm routes (email-channel v1, Task A5). The
// email pair is DISTINCT from mmsMedia: it stores the ORIGINAL VERBATIM (no
// planMmsMedia, no transcode) so a PDF/docx/xlsx survives intact for document
// exchange. These tests pin the presign type/size/key gates and that confirm
// only HEAD-verifies - it never downloads or rewrites the object.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEmailMediaRouter } from '../src/routes/emailMedia.js';
import { EMAIL_MAX_TOTAL_BYTES } from '../src/lib/mediaTypes.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';

function harness(store: Partial<MediaStore>) {
  const app = express();
  app.use(express.json());
  // The real mount sits behind /api requireAuth; the per-user limiter 401s
  // without a user. Stub the authed user the way requireAuth would.
  app.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId: 'u-test' };
    next();
  });
  app.use('/api/email-media', createEmailMediaRouter({ mediaStore: store as MediaStore }));
  return app;
}

const KEY = 'email-media/u-test/aaaaaaaa-0000-0000-0000-000000000000';

describe('POST /api/email-media/presign', () => {
  it('mints a grant for an allowlisted document type, key scoped to the user', async () => {
    const store = {
      createPresignedPost: vi
        .fn()
        .mockResolvedValue({ url: 'http://s3/local', fields: { key: 'email-media/x' } }),
    };
    const res = await request(harness(store))
      .post('/api/email-media/presign')
      .send({ contentType: 'application/pdf', sizeBytes: 2_000_000 });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^email-media\/u-test\/[0-9a-f-]+$/);
    expect(res.body.post.url).toBe('http://s3/local');
    // The presign cap is the 25 MB email total, NOT the MMS source ceiling.
    expect(store.createPresignedPost).toHaveBeenCalledWith(
      expect.stringMatching(/^email-media\/u-test\//),
      { contentType: 'application/pdf', maxBytes: EMAIL_MAX_TOTAL_BYTES },
    );
  });

  it('accepts the office (docx/xlsx) + text types email must carry', async () => {
    const store = {
      createPresignedPost: vi.fn().mockResolvedValue({ url: 'http://s3/local', fields: {} }),
    };
    for (const contentType of [
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      const res = await request(harness(store))
        .post('/api/email-media/presign')
        .send({ contentType, sizeBytes: 1000 });
      expect(res.status).toBe(200);
    }
  });

  it('rejects a non-allowlisted (script-capable) type', async () => {
    const res = await request(harness({}))
      .post('/api/email-media/presign')
      .send({ contentType: 'image/svg+xml', sizeBytes: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('rejects an over-cap declared size', async () => {
    const res = await request(harness({}))
      .post('/api/email-media/presign')
      .send({ contentType: 'application/pdf', sizeBytes: EMAIL_MAX_TOTAL_BYTES + 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_large');
  });

  it('rejects a missing/invalid size', async () => {
    for (const payload of [
      { contentType: 'application/pdf' },
      { contentType: 'application/pdf', sizeBytes: 0 },
      { contentType: 'application/pdf', sizeBytes: 'big' },
    ]) {
      const res = await request(harness({})).post('/api/email-media/presign').send(payload);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_size');
    }
  });
});

describe('POST /api/email-media/confirm', () => {
  it('HEAD-verifies and returns the ORIGINAL untouched (no download, no transcode)', async () => {
    const getBytes = vi.fn();
    const put = vi.fn();
    const store = {
      head: vi.fn().mockResolvedValue({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 4321,
      }),
      getBytes,
      put,
    };
    const res = await request(harness(store)).post('/api/email-media/confirm').send({ key: KEY });
    expect(res.status).toBe(200);
    // Returns the SAME key verbatim - a docx is never rasterized or re-encoded.
    expect(res.body).toEqual({
      s3Key: KEY,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 4321,
    });
    // The proof there is NO planMmsMedia/transcode path: the bytes are never
    // fetched and no derivative is ever put.
    expect(getBytes).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a foreign key (not our email-media/ prefix)', async () => {
    for (const key of ['uploads/aaaaaaaa-0000-0000-0000-000000000000', 'unit-media/u/x', '../etc']) {
      const res = await request(harness({})).post('/api/email-media/confirm').send({ key });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_attachment_key');
    }
  });

  it('400 unknown_attachment for an absent object', async () => {
    const store = { head: vi.fn().mockResolvedValue(undefined) };
    const res = await request(harness(store)).post('/api/email-media/confirm').send({ key: KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_attachment');
  });

  it('400 when the stored object type is not allowlisted', async () => {
    const store = { head: vi.fn().mockResolvedValue({ contentType: 'text/html', size: 10 }) };
    const res = await request(harness(store)).post('/api/email-media/confirm').send({ key: KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('400 too_large when the stored object exceeds the cap', async () => {
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'application/pdf', size: EMAIL_MAX_TOTAL_BYTES + 1 }),
    };
    const res = await request(harness(store)).post('/api/email-media/confirm').send({ key: KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_large');
  });
});
