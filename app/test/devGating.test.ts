import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

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
