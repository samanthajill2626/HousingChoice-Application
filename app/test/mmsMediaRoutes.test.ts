// Outbound MMS media presign + confirm routes (spec 2026-07-16). NOTE: named
// mmsMediaRoutes to avoid colliding with test/mmsMedia.test.ts, which covers the
// INBOUND mirror + serving endpoint.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { createMmsMediaRouter } from '../src/routes/mmsMedia.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';

function harness(store: Partial<MediaStore>) {
  const app = express();
  app.use(express.json());
  // The real mount sits behind /api requireAuth; the presign limiter is
  // per-user and 401s without one. Stub the authed user the way requireAuth
  // would have.
  app.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId: 'u-test' };
    next();
  });
  app.use('/api/media', createMmsMediaRouter({ mediaStore: store as MediaStore }));
  return app;
}

describe('POST /api/media/presign', () => {
  it('mints a grant for an uploadable type', async () => {
    const store = { createPresignedPost: vi.fn().mockResolvedValue({ url: 'http://s3/local', fields: { key: 'uploads/x' } }) };
    const res = await request(harness(store)).post('/api/media/presign').send({ contentType: 'image/webp' });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^uploads\/[0-9a-f-]+$/);
    expect(res.body.post.url).toBe('http://s3/local');
  });
  it('rejects a non-uploadable type', async () => {
    const res = await request(harness({})).post('/api/media/presign').send({ contentType: 'image/svg+xml' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_media_type');
  });
});

describe('POST /api/media/confirm', () => {
  it('flows a small png through untouched (no download, no rewrite)', async () => {
    const put = vi.fn();
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'image/png', size: 5000 }),
      getBytes: vi.fn(),
      put,
    };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/aaaaaaaa-0000-0000-0000-000000000000' });
    expect(res.status).toBe(200);
    expect(res.body.attachment).toMatchObject({ s3Key: 'uploads/aaaaaaaa-0000-0000-0000-000000000000', contentType: 'image/png' });
    expect(res.body.attachment.originalKey).toBe('uploads/aaaaaaaa-0000-0000-0000-000000000000');
    expect(store.getBytes).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('transcodes a webp: downloads, puts a jpeg derivative, keeps the original', async () => {
    const webp = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 5, g: 5, b: 5 } } }).webp().toBuffer();
    const put = vi.fn().mockResolvedValue(undefined);
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'image/webp', size: webp.length }),
      getBytes: vi.fn().mockResolvedValue(webp),
      put,
    };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/bbbbbbbb-0000-0000-0000-000000000000' });
    expect(res.status).toBe(200);
    expect(res.body.attachment.contentType).toBe('image/jpeg');
    expect(res.body.attachment.originalKey).toBe('uploads/bbbbbbbb-0000-0000-0000-000000000000');
    expect(res.body.attachment.s3Key).toMatch(/^uploads\/[0-9a-f-]+$/);
    expect(res.body.attachment.s3Key).not.toBe('uploads/bbbbbbbb-0000-0000-0000-000000000000');
    expect(res.body.attachment.transcodedFrom).toBe('image/webp');
    expect(put).toHaveBeenCalledTimes(1); // derivative only; original already in S3
  });

  it('rejects a foreign key (not own uploads/ prefix)', async () => {
    const res = await request(harness({})).post('/api/media/confirm').send({ key: 'unit-media/u/x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_attachment_key');
  });

  it('404s an absent object', async () => {
    const store = { head: vi.fn().mockResolvedValue(undefined) };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/cccccccc-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_attachment');
  });

  it('400 transcode_failed with detail on a corrupt file', async () => {
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'image/webp', size: 12 }),
      getBytes: vi.fn().mockResolvedValue(Buffer.from('not an image')),
      put: vi.fn(),
    };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/dddddddd-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('transcode_failed');
    expect(typeof res.body.detail).toBe('string');
  });
});
