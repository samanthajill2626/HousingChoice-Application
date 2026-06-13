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
});
