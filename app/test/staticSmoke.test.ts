// M1.3 smoke: dashboard static serving (DASHBOARD_DIST_DIR) — index at /,
// SPA fallback for client routes, and the reserved /api,/auth,/webhooks
// namespaces never swallowed by the fallback.
//
// Self-skipping when dashboard/dist isn't built (it's a gitignored build
// artifact): `npm run build -w dashboard` to exercise this suite for real —
// the same pattern as the DynamoDB Local integration suites.
import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';
const distDir = path.resolve(import.meta.dirname, '../../dashboard/dist');
const built = existsSync(path.join(distDir, 'index.html'));

if (!built) {
  console.warn(
    `[staticSmoke] SKIPPED — no built dashboard at ${distDir}. ` +
      'Run `npm run build -w dashboard` to exercise this suite.',
  );
}

describe.skipIf(!built)('static dashboard serving (DASHBOARD_DIST_DIR)', () => {
  const app = buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: SECRET,
      DASHBOARD_DIST_DIR: distDir,
    } as NodeJS.ProcessEnv),
    logger: createLogger({ destination: createLogCapture().stream }),
  });

  it('serves index.html at /', async () => {
    const res = await request(app).get('/').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('HousingChoice');
  });

  it('SPA-falls back to index.html for unknown GET paths (client-side routes)', async () => {
    const res = await request(app).get('/some/client/route').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('never swallows the reserved namespaces — /api stays 401, /auth and /webhooks stay 404', async () => {
    const api = await request(app).get('/api/nope').set('x-origin-verify', SECRET);
    expect(api.status).toBe(401); // requireAuth answers, not index.html
    const auth = await request(app).get('/auth/nope').set('x-origin-verify', SECRET);
    expect(auth.status).toBe(404);
    const webhook = await request(app).get('/webhooks/nope').set('x-origin-verify', SECRET);
    expect(webhook.status).toBe(404);
  });

  it('serves the browser-hardening headers on the SPA fallback (and / and assets)', async () => {
    for (const path of ['/', '/some/client/route']) {
      const res = await request(app).get(path).set('x-origin-verify', SECRET);
      expect(res.status, path).toBe(200);
      expect(res.headers['x-frame-options'], path).toBe('DENY');
      expect(res.headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      const csp = res.headers['content-security-policy'];
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("script-src 'self'");
      // The ONE documented allowance: React inline style={} attributes.
      expect(csp, path).toContain("style-src 'self' 'unsafe-inline'");
      // blob: = local object URLs (URL.createObjectURL) for the MMS composer's
      // pre-send image preview chip (dashboard Timeline) — in-memory,
      // document-created content, no network fetch.
      expect(csp, path).toContain("img-src 'self' data: blob:");
      expect(csp, path).toContain("connect-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      // No media store configured -> no bucket origin leaks into the CSP.
      expect(csp, path).not.toContain('amazonaws.com');
    }
  });

  it('encoded path-traversal attempts never leak file contents (%2e%2e%2f and ..%5c variants)', async () => {
    // dashboard/dist/../../package.json IS the repo-root package.json — the
    // realistic exfiltration target on this exact tree (and ../package.json
    // is the dashboard workspace manifest). /etc/passwd-style absolutes are
    // covered by the same normalization.
    for (const probe of [
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/..%5c..%5cpackage.json', // backslash separators — meaningful on Windows hosts
      '/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const res = await request(app).get(probe).set('x-origin-verify', SECRET);
      // Acceptable outcomes: the SPA fallback's index.html or a 4xx — never
      // the target file. package.json bodies carry "version"/"private";
      // index.html carries neither.
      expect([200, 400, 403, 404], probe).toContain(res.status);
      expect(res.text, probe).not.toContain('"version"');
      expect(res.text, probe).not.toContain('"private"');
      expect(res.text, probe).not.toContain('root:'); // /etc/passwd shape
      if (res.status === 200) {
        expect(res.text, probe).toContain('<div id="root">'); // it IS the SPA shell
      }
    }
  });
});

// unit-photos deployed-CSP regression (2026-07-21): the browser talks to the
// media bucket DIRECTLY — presigned-POST upload + presigned-GET display — so
// when a media store is configured, its origin MUST be allowed by connect-src
// (fetch) and img-src (<img>). With connect-src 'self' alone, deployed-dev
// photo upload died in the browser ("Uploaded 0 of 3").
describe.skipIf(!built)('SPA CSP allows the configured media-bucket origin', () => {
  const buildWith = (extraEnv: Record<string, string>) =>
    buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: SECRET,
        DASHBOARD_DIST_DIR: distDir,
        ...extraEnv,
      } as NodeJS.ProcessEnv),
      logger: createLogger({ destination: createLogCapture().stream }),
    });

  it('real AWS shape: virtual-hosted bucket origin lands in connect-src AND img-src', async () => {
    const app = buildWith({ MEDIA_BUCKET: 'hc-test-media', AWS_REGION: 'us-east-1' });
    const res = await request(app).get('/').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    const origin = 'https://hc-test-media.s3.us-east-1.amazonaws.com';
    expect(csp).toContain(`connect-src 'self' ${origin}`);
    expect(csp).toContain(`img-src 'self' data: blob: ${origin}`);
    // The allowance is scoped: script/style/default stay 'self'.
    expect(csp).toContain("default-src 'self';");
    expect(csp).toContain("script-src 'self';");
  });

  it('local MinIO shape: the MEDIA_S3_ENDPOINT origin is allowed instead (path-style)', async () => {
    const app = buildWith({ MEDIA_BUCKET: 'hc-local-media', MEDIA_S3_ENDPOINT: 'http://localhost:9000' });
    const res = await request(app).get('/').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("connect-src 'self' http://localhost:9000");
    expect(csp).toContain("img-src 'self' data: blob: http://localhost:9000");
    expect(csp).not.toContain('amazonaws.com');
  });
});
