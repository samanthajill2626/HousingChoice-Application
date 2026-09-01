// M1.3 smoke: dashboard static serving (DASHBOARD_DIST_DIR). Split by what each
// assertion actually proves (npm-test-soundness, 2026-09-01), because the old
// shape made the whole file's colour depend on a GITIGNORED artifact: it
// self-skipped where nobody had run `npm run build -w dashboard` and failed
// where the build was merely stale. Neither colour carried information.
//
// (a) APP-SERVING BEHAVIOUR - runs against a temp fixture dist this file
//     writes. NEVER skips; it needs SOME index.html, not the real one.
// (b) THE PWA IDENTITY CONTRACT - asserted against the TRACKED
//     dashboard/index.html. NEVER skips; that file is version-controlled and
//     identical in every worktree.
// (c) THE REAL BUILD - a diagnostic against dashboard/dist that can only PASS
//     or SKIP, never FAIL. The coverage that costs us (nothing asserts the
//     BUILT dashboard's identity tags) is filed, not hidden:
//     docs/issues/built-dashboard-identity-tags-unasserted.md.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';

// The five conditions that ARE the PWA identity contract (2210f671: runtime
// identity selectors, so one image serves production and non-production).
// (b) asserts them against tracked source; (c) compares them against the build.
const IDENTITY_PRESENT = [
  'href="/app-identity/manifest.webmanifest"',
  'rel="icon" href="/app-identity/icon-192.png"',
  'rel="apple-touch-icon" href="/app-identity/icon-192.png"',
];
const IDENTITY_ABSENT = ['href="/manifest.webmanifest"', 'href="/icons/icon-192.png"'];

const identityHolds = (html: string) =>
  IDENTITY_PRESENT.every((needle) => html.includes(needle)) &&
  IDENTITY_ABSENT.every((needle) => !html.includes(needle));

const TRACKED_INDEX = path.resolve(import.meta.dirname, '../../dashboard/index.html');
const BUILT_INDEX = path.resolve(import.meta.dirname, '../../dashboard/dist/index.html');

// A marker distinctive to THIS fixture. Asserting 'HousingChoice' here would
// only assert our own fixture string back at us; the real title is covered by
// (b)/(c) against the tracked source.
const FIXTURE_MARKER = 'static-smoke-fixture-marker';
// Positive control: a real asset served by express.static, asserted on its
// BODY. A status check alone is vacuous - an express.static MISS falls through
// to the 200 SPA shell (app/src/app.ts:284-296), which is exactly what a
// misconfigured distDir would also return.
const FIXTURE_ASSET_URL = '/assets/app-fixture.js';
const FIXTURE_ASSET_BODY = "export const marker = 'static-smoke-fixture-asset-body';\n";

// Fixture index.html, constrained in BOTH directions:
//   MUST contain '<div id="root">' - the SPA-fallback and traversal cases
//     assert the served body IS the shell;
//   MUST NOT contain '"version"', '"private"' or 'root:' - with no decoy files
//     the traversal probes assert against whatever the SPA fallback returns,
//     which IS this file, so any of those three would fail those assertions for
//     a reason with nothing to do with traversal.
const FIXTURE_INDEX_HTML =
  `<!doctype html><html lang="en"><head><title>${FIXTURE_MARKER}</title></head>` +
  '<body><div id="root"></div></body></html>';

let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(path.join(os.tmpdir(), 'hc-static-smoke-'));
  writeFileSync(path.join(distDir, 'index.html'), FIXTURE_INDEX_HTML);
  mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  writeFileSync(path.join(distDir, 'assets', 'app-fixture.js'), FIXTURE_ASSET_BODY);
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

/** Built per test, AFTER the fixture exists (the old shape built it in the
 *  describe body at collection time, which no fixture can precede). */
function fixtureApp(extraEnv: Record<string, string> = {}) {
  return buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      CF_ORIGIN_SECRET: SECRET,
      DASHBOARD_DIST_DIR: distDir,
      ...extraEnv,
    } as NodeJS.ProcessEnv),
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('static dashboard serving (DASHBOARD_DIST_DIR)', () => {
  it('serves index.html at /', async () => {
    const res = await request(fixtureApp()).get('/').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // The served bytes came from THIS fixture, not from some other dist.
    expect(res.text).toContain(FIXTURE_MARKER);
  });

  it('serves a real asset from the dist with its own body (not the SPA shell)', async () => {
    const res = await request(fixtureApp()).get(FIXTURE_ASSET_URL).set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.text).toContain('static-smoke-fixture-asset-body');
    // The SPA fallback would ALSO have answered 200 here; the body is what
    // tells a served asset apart from a fallthrough.
    expect(res.text).not.toContain(FIXTURE_MARKER);
  });

  it('serves runtime identity before static files and the SPA fallback', async () => {
    const app = fixtureApp();
    const config = await request(app)
      .get('/app-identity/config.json')
      .set('x-origin-verify', SECRET);
    expect(config.status).toBe(200);
    expect(config.headers['content-type']).toContain('application/json');
    expect(config.headers['cache-control']).toBe('no-store');
    expect(config.body).toEqual({ variant: 'non-production', themeColor: '#f4c542' });

    const manifest = await request(app)
      .get('/app-identity/manifest.webmanifest')
      .set('x-origin-verify', SECRET);
    expect(manifest.status).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    expect(manifest.body.theme_color).toBe('#f4c542');
    expect(manifest.body.icons.map((icon: { src: string }) => icon.src)).toEqual([
      '/app-identity/icon-192.png',
      '/app-identity/icon-512.png',
      '/app-identity/icon-maskable-512.png',
    ]);

    const icon = await request(app)
      .get('/app-identity/icon-192.png')
      .redirects(0)
      .set('x-origin-verify', SECRET);
    expect(icon.status).toBe(307);
    expect(icon.headers['cache-control']).toBe('no-store');
    expect(icon.headers.location).toBe('/icons/icon-nonprod-192.png');

    const unknown = await request(app)
      .get('/app-identity/not-a-real-asset')
      .set('x-origin-verify', SECRET);
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-type']).toContain('application/json');
    expect(unknown.text).not.toContain('<div id="root">');
  });

  it('redirects the legacy root manifest to the runtime manifest without caching', async () => {
    const app = fixtureApp();
    const res = await request(app)
      .get('/manifest.webmanifest')
      .query({ target: 'https://example.com/caller-controlled.webmanifest' })
      .redirects(0)
      .set('x-origin-verify', SECRET);

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('/app-identity/manifest.webmanifest');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.text).not.toContain('<div id="root">');

    const missingOriginSecret = await request(app).get('/manifest.webmanifest').redirects(0);
    expect(missingOriginSecret.status).toBe(403);
  });

  it('SPA-falls back to index.html for unknown GET paths (client-side routes)', async () => {
    const res = await request(fixtureApp())
      .get('/some/client/route')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('never swallows the reserved namespaces - /api stays 401, /auth and /webhooks stay 404', async () => {
    const app = fixtureApp();
    const api = await request(app).get('/api/nope').set('x-origin-verify', SECRET);
    expect(api.status).toBe(401); // requireAuth answers, not index.html
    const auth = await request(app).get('/auth/nope').set('x-origin-verify', SECRET);
    expect(auth.status).toBe(404);
    const webhook = await request(app).get('/webhooks/nope').set('x-origin-verify', SECRET);
    expect(webhook.status).toBe(404);
  });

  it('serves the browser-hardening headers on the SPA fallback (and / and assets)', async () => {
    const app = fixtureApp();
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
      // pre-send image preview chip (dashboard Timeline) - in-memory,
      // document-created content, no network fetch.
      expect(csp, path).toContain("img-src 'self' data: blob:");
      expect(csp, path).toContain("connect-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      // No media store configured -> no bucket origin leaks into the CSP.
      expect(csp, path).not.toContain('amazonaws.com');
    }
  });

  it('encoded path-traversal attempts never leak file contents (%2e%2e%2f and ..%5c variants)', async () => {
    // What these pin is OUR COMPOSITION, not the library's internals: given
    // this app's particular stack of static serving, SPA fallback and reserved
    // namespaces, no encoded '..' yields anything but the SPA shell or a 4xx.
    // A future static-serving change could lose that property, which is why
    // the probes are worth keeping even though nothing is reachable.
    //
    // There are deliberately NO decoy files, at any depth. send (installed
    // 1.2.1) decodes the request path and rejects any normalized '..' segment
    // with UP_PATH_REGEXP BEFORE it touches the filesystem, so no decoy could
    // ever be read - one would only make these probes look sharper than they
    // are. The body assertions instead check that the response is this
    // fixture's SPA shell: the fixture index.html deliberately carries none of
    // the three leak markers below.
    const app = fixtureApp();
    for (const probe of [
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/..%5c..%5cpackage.json', // backslash separators - meaningful on Windows hosts
      '/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const res = await request(app).get(probe).set('x-origin-verify', SECRET);
      // Acceptable outcomes: the SPA fallback's index.html or a 4xx - never
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

// unit-photos deployed-CSP (2026-07-21) + same-origin reads: the browser talks
// to the media bucket DIRECTLY only for the presigned-POST UPLOAD, so a
// configured store's origin MUST be allowed by connect-src (fetch). Photo READS
// are same-origin now (/unit-media via CloudFront or the app route), so the
// bucket origin is NO LONGER in img-src - img-src stays 'self' data: blob:. With
// connect-src 'self' alone, deployed-dev photo upload died ("Uploaded 0 of 3").
describe('SPA CSP allows the configured media-bucket origin', () => {
  it('real AWS shape: virtual-hosted bucket origin lands in connect-src ONLY (img-src stays self)', async () => {
    const app = fixtureApp({ MEDIA_BUCKET: 'hc-test-media', AWS_REGION: 'us-east-1' });
    const res = await request(app).get('/').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    const origin = 'https://hc-test-media.s3.us-east-1.amazonaws.com';
    expect(csp).toContain(`connect-src 'self' ${origin}`);
    // Same-origin reads (design 2026-07-21): the bucket origin is NOT in img-src.
    expect(csp).toContain("img-src 'self' data: blob:; connect-src");
    expect(csp).not.toContain(`img-src 'self' data: blob: ${origin}`);
    // The allowance is scoped to connect-src: img-src/script/style/default stay 'self'.
    expect(csp).toContain("default-src 'self';");
    expect(csp).toContain("script-src 'self';");
  });

  it('local MinIO shape: the MEDIA_S3_ENDPOINT origin is allowed in connect-src (path-style)', async () => {
    const app = fixtureApp({ MEDIA_BUCKET: 'hc-local-media', MEDIA_S3_ENDPOINT: 'http://localhost:9000' });
    const res = await request(app).get('/').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("connect-src 'self' http://localhost:9000");
    // Same-origin reads: the endpoint origin is NOT in img-src.
    expect(csp).toContain("img-src 'self' data: blob:; connect-src");
    expect(csp).not.toContain("img-src 'self' data: blob: http://localhost:9000");
    expect(csp).not.toContain('amazonaws.com');
  });
});

// (b) The identity contract, against TRACKED source. This is the assertion the
// old file made against a build artifact; the source is what a regression would
// actually change (2210f671 changed exactly this file), it is in git, and it is
// byte-identical in every worktree - so this case can never skip.
describe('PWA identity contract in the tracked dashboard/index.html', () => {
  it('carries the runtime-identity link tags and none of the legacy root paths', () => {
    const html = readFileSync(TRACKED_INDEX, 'utf8');
    for (const needle of IDENTITY_PRESENT) {
      expect(html, needle).toContain(needle);
    }
    for (const needle of IDENTITY_ABSENT) {
      expect(html, needle).not.toContain(needle);
    }
  });
});

// (c) The real build: a DIAGNOSTIC. dashboard/dist is a gitignored artifact
// that no gate builds, so a FAIL here would make a branch's colour track
// whether somebody happened to run a build in that worktree. It therefore only
// ever PASSES or SKIPS - and the skip note has to distinguish the two causes,
// or an operator who hits the second one rebuilds forever. No mtime
// tie-breaker: git does not preserve mtimes, so a fresh clone, a new worktree
// or a main sync would silently flip a genuine failure into a skip.
const STALE_OR_BROKEN_DIST_NOTE =
  'dashboard/dist disagrees with dashboard/index.html. Most likely the dist is ' +
  'stale - run `npm run build -w dashboard`. If a fresh build still reports ' +
  'this, the dashboard BUILD is dropping the identity tags, which is a real ' +
  'regression - see docs/issues/built-dashboard-identity-tags-unasserted.md';

describe('built dashboard identity tags (diagnostic: PASS or SKIP, never FAIL)', () => {
  it('the built dashboard/dist/index.html agrees with the tracked source', (ctx) => {
    if (!existsSync(BUILT_INDEX)) {
      ctx.skip('no built dashboard; run `npm run build -w dashboard`');
    }
    const html = readFileSync(BUILT_INDEX, 'utf8');
    // Compare ONLY the five conditions: a build also injects hashed asset tags
    // and, under e2e, an x-app-commit meta.
    if (!identityHolds(html)) {
      ctx.skip(STALE_OR_BROKEN_DIST_NOTE);
    }
    for (const needle of IDENTITY_PRESENT) {
      expect(html, needle).toContain(needle);
    }
    for (const needle of IDENTITY_ABSENT) {
      expect(html, needle).not.toContain(needle);
    }
  });
});
