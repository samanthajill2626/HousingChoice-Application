// GET /unit-media/<unitId>/<object> streaming fallback route (unit-media-cloudfront
// design 2026-07-21, D3/D5). In deployed envs CloudFront serves this path from S3
// via OAC; everywhere else (local MinIO, hermetic e2e, live-mode local dev) this
// app route streams the object. Covered here: the 200 image stream + its headers,
// 404 absent object, 503 storeless, SHAPE rejections (the namespace-scoping guard
// that keeps media/ recordings/ uploads/ unreachable), the non-image octet-stream
// download hardening, and mid-flight stream-error teardown. The reserved-prefix
// full-app assertion proves the SPA fallback never leaks index.html for an
// unmatched /unit-media shape once '/unit-media' is reserved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { createUnitMediaServeRouter } from '../src/routes/unitMediaServe.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

// A server-minted-uuid-shaped object segment (the route validates SHAPE, not a
// strict uuid) - passes isSafeSegment.
const OBJ = '11111111-2222-3333-4444-555555555555';
const testLogger = createLogger({ destination: createLogCapture().stream });

/** Only getStream is exercised by the route; cast a partial the same way the
 *  mmsMediaRoutes tests do. */
function fakeStore(getStream: MediaStore['getStream']): MediaStore {
  return { getStream } as unknown as MediaStore;
}

/** A bare express app with just the router mounted at /unit-media (no origin
 *  secret, no SPA - the minimal surface the route needs). */
function routerApp(store?: MediaStore) {
  const app = express();
  app.use(
    '/unit-media',
    createUnitMediaServeRouter({
      ...(store !== undefined && { mediaStore: store }),
      logger: testLogger,
    }),
  );
  return app;
}

/** Buffer the raw response bytes (binary-safe) for body-fidelity assertions. */
function binaryParser(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('GET /unit-media/:unitId/:object', () => {
  it('streams an image object with nosniff + 7d cache headers and the exact bytes', async () => {
    const bytes = Buffer.from('unit-photo-bytes-\x00\x01\x02', 'binary');
    let seenKey: string | undefined;
    const store = fakeStore(async (key) => {
      seenKey = key;
      return { body: Readable.from([bytes]), contentType: 'image/jpeg', contentLength: bytes.length };
    });
    const res = await request(routerApp(store))
      .get(`/unit-media/u1/${OBJ}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    // The route composes the S3 key from the two path segments.
    expect(seenKey).toBe(`unit-media/u1/${OBJ}`);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=604800');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    // Image => served inline (no attachment disposition) so the <img> renders.
    expect(res.headers['content-disposition']).toBeUndefined();
    expect((res.body as Buffer).equals(bytes)).toBe(true);
  });

  it('404s when the object is absent (getStream undefined)', async () => {
    const store = fakeStore(async () => undefined);
    const res = await request(routerApp(store)).get(`/unit-media/u1/${OBJ}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('503s when no media store is configured (storeless env)', async () => {
    const res = await request(routerApp()).get(`/unit-media/u1/${OBJ}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('media_storage_unavailable');
  });

  it('serves a non-image stored Content-Type as an octet-stream attachment (never inline)', async () => {
    // Belt-and-suspenders: upload pins the type to the image allowlist, but a
    // planted text/html must never render same-origin (stored-XSS hardening,
    // docs/issues/media-serve-stored-xss.md).
    const store = fakeStore(async () => ({
      body: Readable.from([Buffer.from('<script>alert(1)</script>')]),
      contentType: 'text/html',
      contentLength: 25,
    }));
    const res = await request(routerApp(store)).get(`/unit-media/u1/${OBJ}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('destroys the response when the body stream errors mid-flight', async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error('mid-flight boom'));
      },
    });
    const store = fakeStore(async () => ({ body, contentType: 'image/jpeg', contentLength: 999 }));
    await expect(
      request(routerApp(store)).get(`/unit-media/u1/${OBJ}`).buffer(true).parse(binaryParser),
    ).rejects.toThrow();
  });
});

describe('GET /unit-media - shape rejection (namespace scoping is enforced by SHAPE)', () => {
  // A store that WOULD serve bytes if ever reached - proves the shape guard
  // short-circuits before any store access, so a foreign/PII namespace key can
  // never be addressed through this route.
  const servingStore = fakeStore(async () => ({
    body: Readable.from([Buffer.from('should-not-serve')]),
    contentType: 'image/jpeg',
    contentLength: 16,
  }));

  for (const badObject of [
    '..%2Fuploads', // decoded traversal -> '../uploads' (contains '/')
    'a%2Fb', // decoded embedded slash
    '%2e%2e', // bare '..'
    '%2e', // bare '.'
    'a%24b', // '$' -> outside the [A-Za-z0-9._-] charset
    'a%20b', // space -> outside the charset
  ]) {
    it(`404s (never serves) a malformed object segment: ${badObject}`, async () => {
      const res = await request(routerApp(servingStore)).get(`/unit-media/u1/${badObject}`);
      expect(res.status).toBe(404);
      expect(res.text ?? '').not.toContain('should-not-serve');
    });
  }

  it('404s a malformed unitId segment too', async () => {
    const res = await request(routerApp(servingStore)).get(`/unit-media/a%24b/${OBJ}`);
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toContain('should-not-serve');
  });

  it('returns the JSON not_found body for a cleanly-matched but unsafe segment', async () => {
    // 'a$b' matches /:unitId/:object then fails isSafeSegment -> our 404 JSON
    // (distinct from a no-route 404), and getStream is never called.
    const res = await request(routerApp(servingStore)).get('/unit-media/u1/a%24b');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

describe('/unit-media reserved prefix (full app: SPA fallback never leaks index.html)', () => {
  const SECRET = 'test-origin-secret';
  const MARKER = 'unit-media-spa-marker';
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(path.join(os.tmpdir(), 'unit-media-spa-'));
    writeFileSync(
      path.join(distDir, 'index.html'),
      `<!doctype html><html><body><div id="root">${MARKER}</div></body></html>`,
    );
  });
  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  function fullApp() {
    return buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: SECRET,
        DASHBOARD_DIST_DIR: distDir,
      } as NodeJS.ProcessEnv),
      logger: testLogger,
    });
  }

  it('serves the SPA shell for a genuine client route (control - fallback is active)', async () => {
    const res = await request(fullApp()).get('/some/client/route').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.text).toContain(MARKER);
  });

  it('intercepts a well-formed /unit-media path (503 storeless here), not the SPA shell', async () => {
    // MEDIA_BUCKET is unset in this config, so mediaServeStore is undefined and
    // the route answers 503 - proving it is mounted BEFORE the SPA fallback and
    // intercepts valid shapes rather than leaking index.html.
    const res = await request(fullApp()).get(`/unit-media/u1/${OBJ}`).set('x-origin-verify', SECRET);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('media_storage_unavailable');
    expect(res.text ?? '').not.toContain(MARKER);
  });

  it('404s an unmatched /unit-media shape instead of serving index.html', async () => {
    const res = await request(fullApp()).get('/unit-media/u1/a/b').set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toContain(MARKER);
  });
});
