// app/test/configTwilioApiBaseUrl.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's' };

describe('TWILIO_API_BASE_URL config', () => {
  it('is read in non-production', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', TWILIO_API_BASE_URL: 'http://localhost:8889' });
    expect(cfg.twilioApiBaseUrl).toBe('http://localhost:8889');
  });

  it('defaults to undefined when unset', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(cfg.twilioApiBaseUrl).toBeUndefined();
  });

  it('is REJECTED (throws) when set in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', TWILIO_API_BASE_URL: 'http://evil', MESSAGING_DRIVER: 'console' }),
    ).toThrow(/TWILIO_API_BASE_URL/);
  });
});
