import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { maybeLoadDevRouter } from '../src/lib/devRoutes.js';

const SECRET = 'test-origin-secret';

describe('dev gating — config', () => {
  it('fails fast when DEV_AUTH_ENABLED is set in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DEV_AUTH_ENABLED: '1' }),
    ).toThrow(/DEV_AUTH_ENABLED/);
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
