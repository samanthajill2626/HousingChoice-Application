// Unit tests for POST /api/media/uploads (outbound MMS upload endpoint). Drives
// the real router through buildApp with a fake MediaStore that consumes the
// streamed body (so the size/abort path is exercised for real). Behind the same
// origin-secret + session requireAuth gate as the rest of /api.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';
import { OUTBOUND_MMS_MAX_FILE_BYTES } from '../src/lib/outboundMediaLimits.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';

interface PutRecord {
  key: string;
  contentType?: string;
  bytes: number;
}

function makeApp() {
  const puts: PutRecord[] = [];
  const mediaStore: MediaStore = {
    async put(key, body, contentType) {
      // Consume the stream (bounded) - a stream destroyed on the size cap
      // throws here, so the put rejects and nothing is recorded (no orphan).
      let bytes = 0;
      for await (const chunk of body) {
        bytes += (chunk as Buffer).length;
      }
      puts.push({ key, ...(contentType !== undefined && { contentType }), bytes });
    },
    async getStream() {
      return undefined;
    },
    async presign() {
      return 'unused';
    },
    async head() {
      return undefined;
    },
    async createPresignedPost(key, opts) {
      return { url: 'unused', fields: { key, 'Content-Type': opts.contentType } };
    },
  };
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
    logger: createLogger({ destination: createLogCapture().stream }),
    auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
    api: { mediaStore },
  });
  return { app, puts };
}

function upload(app: ReturnType<typeof makeApp>['app']) {
  return request(app)
    .post('/api/media/uploads')
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

describe('POST /api/media/uploads', () => {
  it('stores an allowlisted image and returns { key, contentType, size }', async () => {
    const { app, puts } = makeApp();
    const bytes = Buffer.from('pretend-png-bytes');
    const res = await upload(app).attach('file', bytes, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^uploads\/[0-9a-f-]+$/);
    expect(res.body.contentType).toBe('image/png');
    expect(res.body.size).toBe(bytes.length);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(res.body.key);
  });

  it('rejects a disallowed content-type (400 unsupported_media_type) and stores nothing', async () => {
    const { app, puts } = makeApp();
    const res = await upload(app).attach('file', Buffer.from('hello'), {
      filename: 'a.txt',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_media_type');
    expect(puts).toHaveLength(0);
  });

  it('rejects an empty file (400 empty_file)', async () => {
    const { app } = makeApp();
    const res = await upload(app).attach('file', Buffer.alloc(0), {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_file');
  });

  it('aborts a file past the 5MB cap (413 file_too_large) and commits no object', async () => {
    const { app, puts } = makeApp();
    const tooBig = Buffer.alloc(OUTBOUND_MMS_MAX_FILE_BYTES + 1024, 0x61);
    const res = await upload(app).attach('file', tooBig, {
      filename: 'big.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('file_too_large');
    // The stream was destroyed on the cap, so the put rejected - no orphan.
    expect(puts).toHaveLength(0);
  });

  it('rejects a non-multipart request (400 expected_multipart)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/media/uploads')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ not: 'multipart' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('expected_multipart');
  });
});
