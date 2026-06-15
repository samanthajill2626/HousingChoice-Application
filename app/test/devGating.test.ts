import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { maybeLoadDevRouter } from '../src/lib/devRoutes.js';

const SECRET = 'test-origin-secret';

describe('dev gating — config', () => {
  it('fails fast when DEV_AUTH_ENABLED is truthy in production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
      expect(() =>
        loadConfig({ NODE_ENV: 'production', DEV_AUTH_ENABLED: v }),
      ).toThrow(/DEV_AUTH_ENABLED/);
    }
  });

  it('parses truthy DEV_AUTH_ENABLED values outside production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
      const cfg = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: v, CF_ORIGIN_SECRET: SECRET });
      expect(cfg.devAuthEnabled).toBe(true);
    }
  });

  it('defaults devAuthEnabled to false when unset or falsey', () => {
    expect(loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }).devAuthEnabled).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false', CF_ORIGIN_SECRET: SECRET }).devAuthEnabled,
    ).toBe(false);
  });
});

describe('dev gating — router', () => {
  const enabled = () => loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });
  const disabled = () => loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });

  it('maybeLoadDevRouter returns a router only when the flag is set', async () => {
    expect(await maybeLoadDevRouter(enabled())).toBeDefined();
    expect(await maybeLoadDevRouter(disabled())).toBeUndefined();
  });

  it('mounts /__dev/ping when the dev router is present', async () => {
    const config = enabled();
    const app = buildApp({ config, devRouter: await maybeLoadDevRouter(config) });
    const res = await request(app).get('/__dev/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dev: true });
  });

  it('does NOT expose /__dev/ping when the dev router is absent', async () => {
    const app = buildApp({ config: disabled() });
    const res = await request(app).get('/__dev/ping');
    expect(res.status).toBe(404);
  });
});

describe('dev gating — SPA fallback reservation', () => {
  it('reserves /__dev under a configured dist dir: non-dev SPA routes get index.html, /__dev/ping gets 404', async () => {
    // Create a temporary dist directory with an index.html so the SPA fallback activates.
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-dist-'));
    try {
      fs.writeFileSync(path.join(distDir, 'index.html'), '<html><body>SPA</body></html>');

      const config = loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: SECRET,
        DASHBOARD_DIST_DIR: distDir,
        // No DEV_AUTH_ENABLED — no devRouter
      });
      const app = buildApp({ config });

      // Control: a non-reserved GET should be served by the SPA fallback (200, index.html).
      const spaRes = await request(app)
        .get('/some-spa-route')
        .set('x-origin-verify', SECRET);
      expect(spaRes.status).toBe(200);
      expect(spaRes.text).toContain('SPA');

      // Assertion: /__dev/ping must NOT fall through to the SPA fallback — it is reserved.
      const devRes = await request(app)
        .get('/__dev/ping')
        .set('x-origin-verify', SECRET);
      expect(devRes.status).toBe(404);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });
});
